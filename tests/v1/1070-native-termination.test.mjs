import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('1070 delayed system quit replies once and releases an isolated AppKit instance lease',{skip:process.platform!=='darwin',timeout:120000},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1070-termination-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=path.join(root,'TerminationFixture.app'),contents=path.join(app,'Contents'),binary=path.join(contents,'MacOS','TerminationFixture');
 fs.mkdirSync(path.dirname(binary),{recursive:true});
 fs.writeFileSync(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.chathand.termination1070</string><key>CFBundleExecutable</key><string>TerminationFixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(root,'cache');fs.mkdirSync(cache,{recursive:true});
 const built=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,'-framework','Cocoa','native/NativeTermination.swift','native/InstanceLifecycle.swift','native/tests/1070TerminationChecks.swift','-o',binary],{encoding:'utf8',timeout:90000});
 assert.equal(built.status,0,built.stderr);
 const pure=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(pure.status,0,pure.stderr);assert.match(pure.stdout,/PASS: termination coordinator/);
 const waitFor=async(file)=>{const deadline=Date.now()+7000;while(!fs.existsSync(file)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));assert.ok(fs.existsSync(file),`isolated AppKit receipt missing: ${path.basename(file)}`);return JSON.parse(fs.readFileSync(file));};
 for(const mode of ['normal','migration']){
  const receipt=path.join(root,mode+'.json');
  const opened=spawnSync('/usr/bin/open',['-n','-g','-a',app,'--args',mode,path.join(root,mode),receipt],{encoding:'utf8',timeout:10000});
  assert.equal(opened.status,0,opened.stderr);
  const ready=await waitFor(receipt+'.ready');assert.ok(Number.isSafeInteger(ready.pid)&&ready.pid>1);
  const requested=spawnSync(binary,['request',String(ready.pid),app],{encoding:'utf8',timeout:5000});
  assert.equal(requested.status,0,requested.stderr);assert.match(requested.stdout,/REQUESTED/);
  const result=await waitFor(receipt);
  assert.deepEqual(result,{completed:true,cleanup_count:1,reply_count:1,terminate_count:0,lease_released:true});
 }
});

test('1070 production shell defers system exit and keeps the instance leases through willTerminate',()=>{
 const main=fs.readFileSync(new URL('../../native/main.swift',import.meta.url),'utf8');
 const request=main.slice(main.indexOf('func applicationShouldTerminate(_'),main.indexOf('@objc func toggleConnection'));
 assert.match(request,/requestSystemTermination\(uninstalling:uninstallInProgress\)/);
 assert.match(request,/return \.terminateLater/);
 const finish=main.slice(main.indexOf('private func finishQuit()'),main.indexOf('private func closeOwnerPipe()'));
 assert.match(finish,/guard !quitCompletionScheduled/);
 assert.match(finish,/case \.reply:NSApp\.reply\(toApplicationShouldTerminate:true\)/);
 assert.match(finish,/case \.terminate:NSApp\.terminate\(nil\)/);
 assert.doesNotMatch(finish,/instanceLease\s*=\s*nil/);
 const will=main.slice(main.indexOf('func applicationWillTerminate('),main.indexOf('func applicationShouldTerminateAfterLastWindowClosed'));
 assert.match(will,/instanceLease=nil;startupLease=nil/);
 assert.match(main,/migrationQuitPending=false;finishQuit\(\)/);
 assert.match(main,/case \.existing:\s+self\.shuttingDown=true;self\.migrationQuitPending=false;self\.finishQuit\(\)/);
});
