import {createLegacyChromeInstallSource} from '../support/legacy-chrome-install-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ChromeInstallProbe,INSTALL_SOURCE_FILES,INSTALL_NATIVE_CODES,installSource} from '../../app/v1/chrome-install-probe.mjs';
import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
import {DiagnosticEvents,chromeInstallFields} from '../../app/diagnostic-events.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function temporary(t,prefix){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t){
 const dir=temporary(t,'chathand-1061-probe-');
 createLegacyChromeInstallSource(t,{sourceRoot:root,targetRoot:dir});
 let clock=1000;const audit=[],diagnostics=[],extension={pending:new Map(),session:'baseline',status:()=>({connected:true})};
 const probe=new ChromeInstallProbe({root:dir,state:{data:{browser_enabled:true,desktop_enabled:true}},policy:{epoch:1,check(){}},extension,origin:()=> 'http://127.0.0.1:31415',now:()=>clock,audit:e=>audit.push(e),diagnostic:e=>diagnostics.push(e),distribution:legacyChromeDistribution()});
 return {dir,probe,extension,audit,diagnostics,at:x=>clock=x};
}
test('1061 native and backend fingerprint ordered contracts cover every shipped helper asset',()=>{
 const source=read('native/ChromeHelperInstall.swift');
 const files=source.match(/static let files = \[([\s\S]*?)\]/)[1].match(/"[^"]+"/g).map(JSON.parse);
 assert.deepEqual(files,INSTALL_SOURCE_FILES);assert.equal(files.length,20);
});
test('1061 installer diagnostics have finite categories, duration and only a default-target boolean',t=>{
 const f=fixture(t),lease=f.probe.begin('Profile 7');f.at(1120);f.probe.progress(lease.lease_id,'loading_directory');f.at(1250);f.probe.cancel(lease.lease_id,'CHROME_INSTALL_NOT_INSTALLED');
 assert.deepEqual(f.diagnostics.map(e=>[e.outcome,e.ms,e.target_is_default]),[['started',0,false],['running',120,false],['stopped',250,false]]);
 const writer=new DiagnosticEvents(f.dir,{salt:Buffer.alloc(32),now:()=>1300});
 for(const row of f.diagnostics){assert.deepEqual(Object.keys(row).sort(),['code','ms','outcome','stage','target_is_default']);assert.equal(writer.record('chrome.install',{...row,profile_id:'Profile 7',profile_name:'private-user',path:'/private/path',helper:{secret:'not allowed'}}),true);}
 for(const bad of [{...f.diagnostics[0],code:'private text'},{...f.diagnostics[0],stage:'private/path'},{...f.diagnostics[0],outcome:'private-user'},{...f.diagnostics[0],ms:-1},{...f.diagnostics[0],target_is_default:'false'}]){assert.equal(chromeInstallFields(bad),null);assert.equal(writer.record('chrome.install',bad),false);}
 const bytes=fs.readFileSync(path.join(f.dir,'diagnostics/events.jsonl'),'utf8');for(const privateText of ['Profile 7','private-user','/private/path','secret',lease.lease_id,lease.probe_url])assert.equal(bytes.includes(privateText),false);
});
test('1061 preflight diagnostics require only finite native metadata and cannot mutate a lease',t=>{
 const f=fixture(t),lease=f.probe.begin();
 assert.equal(f.probe.progress(undefined,'preparing',{native_event:'stopped',code:'CHROME_INSTALL_ACCESSIBILITY_REQUIRED',elapsed_ms:12,target_is_default:true,profile_name:'discard me'}).recorded,true);
 assert.equal(f.probe.publicStatus(lease.lease_id).active,true);
 assert.equal(f.probe.progress(undefined,'preparing',{native_event:'stopped',code:'CONFIRM_NOT_HUMAN',elapsed_ms:0,target_is_default:null}).recorded,true);
 assert.equal(f.diagnostics.at(-1).target_is_default,null);
 assert.throws(()=>f.probe.progress(undefined,'preparing',{native_event:'stopped',code:'PRIVATE_TEXT',elapsed_ms:12,target_is_default:true}),{code:'INSTALL_STOPPED'});
 assert.equal(JSON.stringify(f.audit).includes('discard me'),false);
});
test('1061 global connected cannot pass the selected-profile probe; only the fresh source-bound challenge can',t=>{
 const f=fixture(t),lease=f.probe.begin('Profile 2'),source=installSource(f.dir);
 assert.equal(f.probe.verify(lease.lease_id).helper_seen,false);
 assert.equal(f.probe.next('baseline',{version:source.version,build:source.build},source.host),null);
 assert.equal(f.probe.next('untrusted',{version:source.version,build:source.build},{...source.host,entry_sha256:'wrong'}),null);
 assert.equal(f.probe.publicStatus().helper_seen,false);
 f.extension.session='fresh';const request=f.probe.next('fresh',{version:source.version,build:source.build},source.host);
 assert.equal(f.probe.publicStatus().helper_seen,true);
 assert.throws(()=>f.probe.finish({...lease,native_verified:true}),{code:'INSTALL_NOT_VERIFIED'});
 const title=/<title>([^<]+)<\/title>/.exec(f.probe.page(new URL(lease.probe_url).pathname))[1];
 f.probe.complete('fresh',request.id,{title,tab_id:1,window_id:2});
 assert.equal(f.probe.finish({...lease,native_verified:true}).phase,'installed_verified');
});
test('1061 all four evidence-based failure categories survive the server cancellation boundary',t=>{
 for(const code of ['CHROME_INSTALL_NOT_INSTALLED','CHROME_INSTALL_OTHER_PROFILE','CHROME_INSTALL_NATIVE_HOST_NOT_CONNECTED','CHROME_INSTALL_TARGET_HANDSHAKE_TIMEOUT']){
  const f=fixture(t),lease=f.probe.begin();assert.equal(INSTALL_NATIVE_CODES.has(code),true);assert.equal(f.probe.cancel(lease.lease_id,code).code,code);assert.equal(f.diagnostics.at(-1).code,code);
 }
});
test('1061 public template export and verified artifacts add no human-input gate; authentication and credential paste remain',()=>{
 const main=read('native/main.swift');const start=main.indexOf('        case "revealSiteTemplate":'),branch=main.slice(start,main.indexOf('        case "openTaskFile"',start));
 assert.match(branch,/interfaceKeyShared && ownsService/);assert.match(branch,/guard data\.isEmpty/);assert.doesNotMatch(main,/consumeNativeSiteTemplateClick|pendingSiteTemplateClickAt|NATIVE_SITE_TEMPLATE_GESTURE_REQUIRED|confirmArtifactProgram|humanStart/);
 assert.match(main,/NativeCredentialPaste\.site\(authorized:interfaceKeyShared && ownsService/);assert.match(main,/NativeCredentialPaste\.runtime\(tunnelID:tunnelID,authorized:interfaceKeyShared && ownsService/);assert.match(main,/case "extensionSetup":[\s\S]*?confirmationInput\(via:"window"\).*human/);assert.match(main,/case "confirmAnswer":[\s\S]*?answerConfirmation/);
 const artifact=main.slice(main.indexOf('    func openArtifact('),main.indexOf('    func userContentController'));
 assert.match(artifact,/artifactOpenBinding\(live\) == binding/);assert.match(artifact,/artifactVerifyRequest\(fresh, proof: proof\)/);assert.doesNotMatch(artifact,/NSAlert|confirmationInput|USER_INPUT_REQUIRED/);
 const restart=main.slice(main.indexOf('    private func confirmAndRestartAfterPermissions('),main.indexOf('    func userNotificationCenter'));
 assert.doesNotMatch(restart,/NSAlert|runModal/);assert.match(restart,/permissions_incomplete/);assert.match(main,/guard !self\.hasActiveTask\(\)/);
});
test('1061 exported template actual method is exercised with temporary package/downloads and a fake Finder sink',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const dir=temporary(t,'chathand-1061-template-'),main=read('native/main.swift');
 const begin=main.indexOf('    func revealSiteTemplate('),end=main.indexOf('    func pasteSiteGrant(',begin);
 let method=main.slice(begin,end);
 const boundary='try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)';
 assert.equal(method.split(boundary).length,2);method=method.replace(boundary,'downloads');
 const fixture=String.raw`
import Foundation
import CryptoKit
final class NSWorkspace {
 static let shared = NSWorkspace()
 var revealed: [URL] = []
 func activateFileViewerSelecting(_ urls: [URL]) { revealed += urls }
}
final class TemplateFixture {
 let packageURL: URL
 let downloads: URL
 init(_ root: URL) { packageURL = root.appendingPathComponent("runtime"); downloads = root.appendingPathComponent("downloads") }
 __METHOD__
}
@main struct Checks {
 static func main() throws {
  let root = URL(fileURLWithPath:CommandLine.arguments[1]); let fm = FileManager.default; let f=TemplateFixture(root)
  try fm.createDirectory(at:f.packageURL.appendingPathComponent("site-template"),withIntermediateDirectories:true)
  try fm.createDirectory(at:f.packageURL.appendingPathComponent("connectors"),withIntermediateDirectories:true)
  try fm.createDirectory(at:f.downloads,withIntermediateDirectories:true)
  let name="chathand-site-template-1060-local.zip", bytes=Data("public bundled fixture".utf8)
  let hash=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()
  let pin:[String:Any] = ["format":"chathand-site-template-local-pin","version":1,"source_kind":"bundled_local","template_file":name,"template_version":"1060","template_sha256":hash,"manifest_sha256":String(repeating:"a",count:64)]
  let pinFile=f.packageURL.appendingPathComponent("site-template/local-template-pin.json"),source=f.packageURL.appendingPathComponent("site-template/"+name)
  try JSONSerialization.data(withJSONObject:pin).write(to:pinFile);try bytes.write(to:source)
  var checks=0
  func expect(_ condition:Bool,_ message:String){precondition(condition,message);checks += 1}
  func run()->[String:Any]{var result:[String:Any]=[:];f.revealSiteTemplate{result=$0};return result}
  let first=run();expect(first["revealed"] as? Bool == true,"normal export succeeds without a native gesture")
  expect(NSWorkspace.shared.revealed.last?.lastPathComponent == name,"Finder sink receives exact export")
  expect(try Data(contentsOf:source)==bytes,"source byte preservation")
  expect(run()["file_name"] as? String == name,"identical Downloads bytes reused")
  let destination=f.downloads.appendingPathComponent(name);try Data("existing other bytes".utf8).write(to:destination)
  expect(run()["file_name"] as? String == "chathand-site-template-1060-local-2.zip","conflicting name is never overwritten")
  expect(try Data(contentsOf:destination)==Data("existing other bytes".utf8),"conflict bytes preserved")
  for n in 2...99 {try Data("occupied".utf8).write(to:f.downloads.appendingPathComponent("chathand-site-template-1060-local-\(n).zip"))}
  expect(run()["error_code"] as? String == "B_TEMPLATE_FILE_COLLISION","bounded collision stops without overwriting")
  try Data("mismatched source".utf8).write(to:source)
  expect(run()["error_code"] as? String == "B_TEMPLATE_MISMATCH","source SHA required")
  try fm.removeItem(at:source);try fm.createSymbolicLink(at:source,withDestinationURL:destination)
  expect(run()["error_code"] as? String == "B_TEMPLATE_UNVERIFIED","source symlink rejected")
  try fm.removeItem(at:source);try bytes.write(to:source)
  try fm.removeItem(at:f.downloads);try fm.createDirectory(at:f.downloads,withIntermediateDirectories:true)
  try fm.createSymbolicLink(at:destination,withDestinationURL:source)
  expect(run()["file_name"] as? String == "chathand-site-template-1060-local-2.zip","destination link is not replaced")
  expect(try fm.destinationOfSymbolicLink(atPath:destination.path)==source.path,"destination link preserved")
  try fm.removeItem(at:pinFile)
  try bytes.write(to:f.packageURL.appendingPathComponent("site-template/chathand-site-template.zip"))
  let remotePin:[String:Any] = ["format":"chathand-site-template-pin","version":1,"template_version":"1060","template_sha256":hash,"manifest_sha256":String(repeating:"a",count:64)]
  try JSONSerialization.data(withJSONObject:remotePin).write(to:f.packageURL.appendingPathComponent("connectors/site-template-pin.json"))
  expect(run()["source_kind"] as? String == "remote","legacy bundled remote pin remains supported")
  expect(try Data(contentsOf:source)==bytes,"all exports preserve original bytes")
  print("PASS: \(checks) isolated template-export checks; fake Finder and temporary downloads only")
 }
}
`.replace('__METHOD__',method);
 const file=path.join(dir,'Fixture.swift'),binary=path.join(dir,'checks'),cache=path.join(dir,'cache');fs.writeFileSync(file,fixture);fs.mkdirSync(cache);
 const env={...process.env,CLANG_MODULE_CACHE_PATH:cache,CHATHAND_STATE_DIR:path.join(dir,'state')};
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,file,'-o',binary],{cwd:root,env,encoding:'utf8',timeout:90000});assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[dir],{cwd:dir,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: 13 isolated template-export checks/);console.log(run.stdout.trim());
});
