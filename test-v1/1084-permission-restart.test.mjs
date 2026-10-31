import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const rootURL=new URL('../',import.meta.url);
const main=fs.readFileSync(new URL('native/main.swift',rootURL),'utf8');
const start='    private func confirmAndRestartAfterPermissions(';
const end='    func userNotificationCenter';
const extract=source=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const baseline=`    private func baselineRestartAfterPermissions(completion: @escaping ([String:Any]) -> Void) {
        let status = permissionAssistant.status()
        guard status["complete"] as? Bool == true else {
            completion(["restart":false,"reason":"permissions_incomplete","permissions":status])
            return
        }
        let launcher = Process()
        launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        launcher.arguments = ["-n", Bundle.main.bundleURL.path]
        do {
            try launcher.run()
            completion(["restart":true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { NSApp.terminate(nil) }
        } catch {
            completion(["restart":false,"reason":"launch_failed"])
        }
    }
`;

test('1084 permission restart uses the verified relaunch protocol and keeps existing task/permission guards',()=>{
 const method=extract(main);
 assert.match(method,/permissions_incomplete/);assert.match(method,/relaunchChatHand \{ result in/);
 assert.doesNotMatch(method,/Process\(\)|\/usr\/bin\/open|asyncAfter|NSApp\.terminate/);
 assert.match(main,/guard !self\.hasActiveTask\(\)/);
 const helper=fs.readFileSync(new URL('native/UpgradeControl.swift',rootURL),'utf8');
 const relaunch=helper.slice(helper.indexOf('if action=="relaunch"'),helper.indexOf('let apps=NSWorkspace.shared.runningApplications'));
 assert.match(relaunch,/InstanceLifecycle\.trusted\(target/);assert.match(relaunch,/InstanceLifecycle\.stop\(app\)/);
 assert.match(relaunch,/instances\(source:source,scope:scope\)\.isEmpty/);assert.match(relaunch,/shutdownOrphan/);
 assert.ok(relaunch.indexOf('RELAUNCH_PID_GONE')<relaunch.indexOf('openApplication(at:target'));
 assert.match(relaunch,/createsNewApplicationInstance=true/);
});

test('1084 extracted permission method and isolated instance lease demonstrate old failure/new restart',{skip:process.platform!=='darwin',timeout:120000},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1084-permission-restart-')));
 const app=path.join(root,'PermissionRestart1084.app'),contents=path.join(app,'Contents'),binary=path.join(contents,'MacOS','PermissionRestart1084');
 const receipt=path.join(root,'events.jsonl');
 const rows=()=>fs.existsSync(receipt)?fs.readFileSync(receipt,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const cleanProcesses=()=>{for(const pid of new Set(rows().map(r=>r.pid))){const r=spawnSync('/bin/ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'});if(r.stdout.trim()===binary){try{process.kill(pid,'SIGTERM')}catch{}}}};
 t.after(()=>{cleanProcesses();fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.dirname(binary),{recursive:true});
 fs.writeFileSync(path.join(contents,'Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.chathand.permissionrestart1084</string><key>CFBundleName</key><string>PermissionRestart1084</string><key>CFBundleExecutable</key><string>PermissionRestart1084</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 let source=fs.readFileSync(new URL('native/tests/1084PermissionRestartChecks.swift',rootURL),'utf8');
 // Adapt only the frozen baseline launch boundary to suppress OS error UI.
 const quietBaseline=baseline.replace('let launcher = Process()','let launcher = QuietBaselineOpen()');
 assert.notEqual(quietBaseline,baseline);
 source=source.replace('__PATCHED_METHOD__',extract(main)).replace('__BASELINE_METHOD__',quietBaseline);
 const swift=path.join(root,'PermissionRestartChecks.swift');fs.writeFileSync(swift,source);
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(root,'cache');fs.mkdirSync(cache,{recursive:true});
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,'-framework','Cocoa',new URL('native/InstanceLifecycle.swift',rootURL).pathname,swift,'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(compile.status,0,compile.stderr);
 const sign=spawnSync('/usr/bin/codesign',['--force','--sign','-',app],{encoding:'utf8'});assert.equal(sign.status,0,sign.stderr);
 const unit=spawnSync(binary,['unit'],{encoding:'utf8',timeout:5000});assert.equal(unit.status,0,unit.stderr);assert.match(unit.stdout,/PASS: extracted production permission restart method/);
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const waitFor=async condition=>{const until=Date.now()+8000;while(Date.now()<until){if(condition(rows()))return;await sleep(30);}assert.fail('permission restart fixture receipt timed out: '+JSON.stringify(rows()));};
 const evidence=[];
 for(const scenario of ['baseline','patched','patched']){
  cleanProcesses();await sleep(80);fs.rmSync(receipt,{force:true});fs.writeFileSync(path.join(root,'scenario.json'),JSON.stringify({scenario}));
  const launch=spawnSync(binary,['launch',app],{encoding:'utf8',timeout:10000});assert.equal(launch.status,0,launch.stderr);
  await waitFor(r=>r.some(x=>x.event==='owner_terminated'));
  if(scenario==='baseline'){
   await waitFor(r=>r.some(x=>x.event==='contender_forwarded_to_old_owner'));
   await sleep(300);assert.equal(rows().filter(x=>x.event==='fresh_owner').length,0,'opening before quit loses the new instance to the old owner lease');
  }else{
   await waitFor(r=>r.some(x=>x.event==='fresh_owner')&&r.some(x=>x.event==='helper_open_result'));
   const r=rows(),initial=r.find(x=>x.event==='initial_owner'),fresh=r.find(x=>x.event==='fresh_owner'),gone=r.find(x=>x.event==='old_pid_gone_lease_available'),opened=r.find(x=>x.event==='helper_open_result');
   assert.notEqual(fresh.pid,initial.pid);assert.equal(opened.success,true);assert.equal(opened.new_pid,fresh.pid);assert.equal(gone.old_pid,initial.pid);
   assert.ok(gone.time<=fresh.time);assert.equal(r.filter(x=>x.event==='contender_forwarded_to_old_owner').length,0);
   assert.equal(r.find(x=>x.event==='restart_response').response.restart,true);
  }
  evidence.push({scenario,events:rows()});
 }
 if(process.env.CHATHAND_PERMISSION_RESTART_EVIDENCE){fs.writeFileSync(process.env.CHATHAND_PERMISSION_RESTART_EVIDENCE,JSON.stringify({layer:'isolated AppKit/lease protocol; extracted production permission method; baseline open boundary uses prompts=false NSWorkspace equivalent; no real ChatHand/TCC',cases:evidence},null,2)+'\n');}
});
