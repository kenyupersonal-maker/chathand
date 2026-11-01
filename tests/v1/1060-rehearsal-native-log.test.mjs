// Real temporary Swift probe under two identical fixed profiles. No ChatHand
// launch, production state, preferences, credential files or Keychain access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const native=fs.readFileSync(new URL('../../native/UpgradeControl.swift',import.meta.url),'utf8');
function fragment(start,end){const a=native.indexOf(start),b=native.indexOf(end,a);assert.ok(a>=0&&b>a,'source-bound native fragment exists');return native.slice(a,b);}
const creation=fragment('  let descriptor=Darwin.open(log.path,','  let child=Process();');
const profile=fragment(' static func quote(_ value:String)',' static func environment(_ root: URL)');
const services=native.match(/ static let services = \[[^\n]+\]/)?.[0];
assert.ok(services);
function exec(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(r.error,undefined,r.error?.message);return {exit:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr};}

test('native launch log uses exclusive no-follow POSIX descriptor and reports finite errno',()=>{
 assert.match(creation,/O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW\|O_CLOEXEC,mode_t\(0o600\)/);
 assert.match(creation,/REHEARSAL_LOG_CREATE_ERRNO_\\\(errno\)/);
 assert.match(creation,/FileHandle\(fileDescriptor:descriptor,closeOnDealloc:true\)/);
 assert.match(creation,/defer \{ try\? output.close\(\) \}/);
 assert.doesNotMatch(creation,/createFile|setAttributes/);
});

test('actual launch-log code creates 0600 exclusively inside two nested fixed sandboxes and refuses outside writes',{skip:process.platform!=='darwin',timeout:90000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-rehearsal-native-log-'))),outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-native-log-outside-')));
 fs.chmodSync(root,0o700);fs.chmodSync(outside,0o700);
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
 const main=path.join(root,'probe.swift'),binary=path.join(root,'native-log-probe');
 const source=`import Foundation
import Darwin
struct Invalid:Error {let code:String}
struct RehearsalIsolation {
${services}
${profile}
}
func createLog(_ log:URL) throws {
${creation}
 try output.write(contentsOf:Data("temporary-probe\\n".utf8))
}
if CommandLine.arguments[1]=="profile" {
 do {print(try RehearsalIsolation.profile(URL(fileURLWithPath:CommandLine.arguments[2])))}
 catch {print("profile-failed");exit(1)}
} else {
 do {try createLog(URL(fileURLWithPath:CommandLine.arguments[2]));print("{\\"created\\":true}")}
 catch let e as Invalid {print("{\\"error\\":\\""+e.code+"\\"}");exit(73)}
 catch {print("{\\"error\\":\\"PROBE_WRITE_FAILED\\"}");exit(74)}
}
`;
 fs.writeFileSync(main,source,{flag:'wx',mode:0o600});
 const compiled=exec('/usr/bin/xcrun',['swiftc','-swift-version','5',main,'-o',binary]);assert.equal(compiled.exit,0,compiled.stderr);
 const advertised=exec(binary,['profile',root]);assert.equal(advertised.exit,0,advertised.stderr);assert.match(advertised.stdout,/\(deny file-write\*\)/);
 assert.match(advertised.stdout,/\(deny network\*\)/);assert.ok(advertised.stdout.includes('(allow file-write* (subpath "'+root+'"))'));
 const outer=path.join(root,'outer.sb'),inner=path.join(root,'inner.sb');
 for(const file of [outer,inner])fs.writeFileSync(file,advertised.stdout,{flag:'wx',mode:0o600});
 const nested=target=>exec('/usr/bin/sandbox-exec',['-f',outer,'/usr/bin/sandbox-exec','-f',inner,binary,'create',target]);
 const log=path.join(root,'launch-probe.log'),created=nested(log);
 assert.equal(created.exit,0,JSON.stringify(created));assert.deepEqual(JSON.parse(created.stdout),{created:true});
 assert.equal(fs.statSync(log).mode&0o777,0o600);assert.equal(fs.statSync(log).nlink,1);assert.equal(fs.readFileSync(log,'utf8'),'temporary-probe\n');
 const duplicate=nested(log);assert.equal(duplicate.exit,73,JSON.stringify(duplicate));assert.deepEqual(JSON.parse(duplicate.stdout),{error:'REHEARSAL_LOG_CREATE_ERRNO_17'});assert.equal(fs.readFileSync(log,'utf8'),'temporary-probe\n');
 const forbidden=path.join(outside,'must-not-exist.log'),denied=nested(forbidden);assert.equal(denied.exit,73,JSON.stringify(denied));
 const deniedResult=JSON.parse(denied.stdout);assert.match(deniedResult.error,/^REHEARSAL_LOG_CREATE_ERRNO_(1|13)$/);assert.equal(fs.existsSync(forbidden),false);
 const link=path.join(root,'launch-link.log');fs.symlinkSync(log,link);const linked=nested(link);assert.equal(linked.exit,73,JSON.stringify(linked));assert.deepEqual(JSON.parse(linked.stdout),{error:'REHEARSAL_LOG_CREATE_ERRNO_17'});assert.equal(fs.readFileSync(log,'utf8'),'temporary-probe\n');
 t.diagnostic(JSON.stringify({fixed_profile_layers:2,mode:'0600',duplicate:JSON.parse(duplicate.stdout),outside:deniedResult,symlink:JSON.parse(linked.stdout),production_app_launched:false}));
});

test('actual Process start under the nested fixed profile rejects null-device stdin and exits with source-bound EOF Pipe',{skip:process.platform!=='darwin',timeout:90000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-rehearsal-native-stdin-')));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const main=path.join(root,'probe.swift'),binary=path.join(root,'native-stdin-probe');
 const startup=fragment('  let input=Pipe();','  let pid=child.processIdentifier,until=');
 assert.doesNotMatch(startup,/nullDevice/);assert.match(startup,/standardInput=input/);assert.match(startup,/fileHandleForWriting.close\(\)/);
 const source=`import Foundation
import Darwin
struct Invalid:Error {let code:String}
struct RehearsalIsolation {
${services}
${profile}
}
func launchProbe(_ rootURL:URL,_ mode:String) throws -> [String:Any] {
 let log=rootURL.appendingPathComponent(mode+".log")
${creation}
 let child=Process();child.executableURL=URL(fileURLWithPath:mode=="missing-executable" ? rootURL.appendingPathComponent("missing").path : "/usr/bin/true")
 let env=["HOME":rootURL.path,"CFFIXED_USER_HOME":rootURL.path,"TMPDIR":rootURL.path,"PATH":"/usr/bin:/bin"]
 if mode=="null-device" {
  child.environment=env;child.currentDirectoryURL=rootURL;child.standardInput=FileHandle.nullDevice;child.standardOutput=output;child.standardError=output
  do {try child.run()} catch {let saved=errno,detail=error as NSError;return ["launched":false,"domain":detail.domain,"code":detail.code,"errno":Int(saved)]}
 } else {
${startup}
 }
 child.waitUntilExit()
 return ["launched":true,"exit":Int(child.terminationStatus)]
}
let root=URL(fileURLWithPath:CommandLine.arguments[2])
if CommandLine.arguments[1]=="profile" {print(try RehearsalIsolation.profile(root))}
else {
 var value:[String:Any]
 do {value=try launchProbe(root,CommandLine.arguments[1])}
 catch let error as Invalid {value=["error":error.code]}
 catch {value=["error":"UNEXPECTED_PROBE_ERROR"]}
 let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
}
`;
 fs.writeFileSync(main,source,{flag:'wx',mode:0o600});
 const compiled=exec('/usr/bin/xcrun',['swiftc','-swift-version','5',main,'-o',binary]);assert.equal(compiled.exit,0,compiled.stderr);
 const advertised=exec(binary,['profile',root]);assert.equal(advertised.exit,0,advertised.stderr);
 const outer=path.join(root,'outer.sb'),inner=path.join(root,'inner.sb');for(const file of [outer,inner])fs.writeFileSync(file,advertised.stdout,{flag:'wx',mode:0o600});
 const run=mode=>{const result=exec('/usr/bin/sandbox-exec',['-f',outer,'/usr/bin/sandbox-exec','-f',inner,binary,mode,root]);assert.equal(result.exit,0,JSON.stringify(result));assert.equal(result.stderr,'');return JSON.parse(result.stdout);};
 const control=run('null-device');assert.equal(control.launched,false);assert.equal(control.domain,'NSPOSIXErrorDomain');assert.equal(control.code,9);assert.equal(typeof control.errno,'number');
 const actual=run('eof-pipe');assert.deepEqual(actual,{launched:true,exit:0});
 const failure=run('missing-executable');assert.match(failure.error,/^REHEARSAL_LAUNCH_FAILED_(POSIX|COCOA|OTHER)_-?\d+_POSIX_-?\d+_ERRNO_-?\d+$/);
 for(const mode of ['null-device','eof-pipe','missing-executable'])assert.equal(fs.statSync(path.join(root,mode+'.log')).size,0);
 t.diagnostic(JSON.stringify({fixed_profile_layers:2,null_device:control,eof_pipe:actual,missing_executable:failure,log_bytes:0,production_app_launched:false}));
});

test('each confined helper start provisions only a safe service log, including after full state restoration',{skip:process.platform!=='darwin',timeout:90000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-rehearsal-service-log-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const provision=fragment('  // Each isolated start may follow a state restore','  let id=UUID().uuidString');
 assert.ok(native.indexOf('let env=try environment(rootURL)')<native.indexOf(provision),'state/root environment validation precedes this fixture');
 assert.doesNotMatch(provision,/O_TRUNC|setAttributes|createDirectory/);
 const old=fs.readFileSync(new URL('../../native/main.swift',import.meta.url),'utf8'),a=old.indexOf('        try FileManager.default.createDirectory(at:stateURL,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])'),z=old.indexOf('        let p=Process();',a);assert.ok(a>=0&&z>a);
 const source=`import Foundation
import Darwin
struct Invalid:Error {let code:String}
struct RehearsalIsolation {
${services}
${profile}
}
func provisionLog(_ state:URL) throws {
 let env=["CHATHAND_STATE_DIR":state.path]
${provision}
}
func launchOld(_ stateURL:URL) throws -> [String:Any] {
 try provisionLog(stateURL)
${old.slice(a,z)}
 defer {try? log.close()}
 let child=Process(),input=Pipe();child.executableURL=URL(fileURLWithPath:"/usr/bin/true")
 child.standardInput=input;child.standardOutput=log;child.standardError=log
 try input.fileHandleForWriting.close();try child.run();child.waitUntilExit()
 return ["launched":true,"exit":Int(child.terminationStatus)]
}
let root=URL(fileURLWithPath:CommandLine.arguments[2])
if CommandLine.arguments[1]=="profile" {print(try RehearsalIsolation.profile(root))}
else {
 var value:[String:Any]
 do {value=try launchOld(root.appendingPathComponent(CommandLine.arguments[1]))}
 catch let error as Invalid {value=["error":error.code]}
 catch {let detail=error as NSError;value=["error":"PROBE_PROCESS_FAILED","domain":detail.domain,"code":detail.code]}
 let data=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
}
`;
 const main=path.join(root,'probe.swift'),binary=path.join(root,'service-log-probe');fs.writeFileSync(main,source,{flag:'wx',mode:0o600});
 const compiled=exec('/usr/bin/xcrun',['swiftc','-swift-version','5',main,'-o',binary]);assert.equal(compiled.exit,0,compiled.stderr);
 const policy=exec(binary,['profile',root]);assert.equal(policy.exit,0,policy.stderr);const outer=path.join(root,'outer.sb'),inner=path.join(root,'inner.sb');for(const file of [outer,inner])fs.writeFileSync(file,policy.stdout,{flag:'wx',mode:0o600});
 const run=mode=>{const result=exec('/usr/bin/sandbox-exec',['-f',outer,'/usr/bin/sandbox-exec','-f',inner,binary,mode,root]);assert.equal(result.exit,0,JSON.stringify(result));return JSON.parse(result.stdout);};
 const state=path.join(root,'state');fs.mkdirSync(state,{mode:0o700});
 const first=run('state');assert.deepEqual(first,{launched:true,exit:0});const log=path.join(state,'launcher.log');assert.equal(fs.statSync(log).mode&0o777,0o600);
 fs.writeFileSync(log,'preserved prior log\n');const retained=run('state');assert.deepEqual(retained,{launched:true,exit:0});assert.equal(fs.readFileSync(log,'utf8'),'preserved prior log\n');
 // Same operation the pinned transaction performs: old state moves aside and
 // a fresh restored state exists without excluded runtime/launcher.log files.
 fs.renameSync(state,path.join(root,'failed-state'));fs.mkdirSync(state,{mode:0o700});const restored=run('state');assert.deepEqual(restored,{launched:true,exit:0});assert.equal(fs.statSync(log).size,0);assert.equal(fs.readFileSync(path.join(root,'failed-state/launcher.log'),'utf8'),'preserved prior log\n');
 const errors={};
 for(const kind of ['symlink','hardlink','wide-mode','directory','fifo']){
  const dir=path.join(root,kind);fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'launcher.log');
  if(kind==='symlink')fs.symlinkSync(log,file);
  else if(kind==='hardlink')fs.linkSync(log,file);
  else if(kind==='wide-mode')fs.writeFileSync(file,'unsafe bytes',{mode:0o644,flag:'wx'});
  else if(kind==='directory')fs.mkdirSync(file,{mode:0o700});
  else {const made=exec('/usr/bin/mkfifo',[file]);assert.equal(made.exit,0,made.stderr);}
  errors[kind]=run(kind);assert.match(errors[kind].error,/^REHEARSAL_SERVICE_LOG_(UNSAFE|OPEN_ERRNO_\d+|CREATE_ERRNO_\d+)$/);
  if(kind==='hardlink')fs.unlinkSync(file);
  if(kind==='wide-mode')assert.equal(fs.readFileSync(file,'utf8'),'unsafe bytes');
 }
 assert.equal(fs.statSync(log).size,0);assert.equal(fs.existsSync(path.join(state,'runtime.json')),false,'no ready metadata is manufactured');
 t.diagnostic(JSON.stringify({fixed_profile_layers:2,first,retained,restored,unsafe:errors,old_native_log_code_unchanged:true,full_owner_acceptance:false,production_app_launched:false}));
});
