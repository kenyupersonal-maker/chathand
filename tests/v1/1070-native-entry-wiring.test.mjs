import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const read=f=>fs.readFileSync(new URL("../../"+f,import.meta.url),'utf8');

test('1070 setup and repair retain the same click/owner/focus gates and wait before profile discovery',()=>{
 const main=read('native/main.swift'),start=main.slice(main.indexOf('        case "extensionSetup":'),main.indexOf('        case "openChromeDataAccessSettings":'));
 assert.match(main,/let repairExtension = action == "extensionRepair"/);
 assert.match(main,/switch repairExtension \? "extensionSetup" : action/);
 for(const guard of [/confirmationInput\(via:"window"\).*human/,/guard ownsService,interfaceKeyShared,!shuttingDown/,/frontmostApplication\?\.processIdentifier/,/ChromeInstallLease\.validProfile/])assert.match(start,guard);
 assert.match(start,/if waitForAccessibility && !AXIsProcessTrusted\(\)/);
 assert.ok(start.indexOf('"discovery_only":true')<start.lastIndexOf('waitForTrust()'));
 assert.match(start,/done\(\["started":true,"phase":"waiting_accessibility"\]\)/);
 assert.ok(start.indexOf('done(["started":true')<start.indexOf('requestAccessibilityOnly()'));
 assert.match(start,/resumedIntentDeadline=ProcessInfo\.processInfo\.systemUptime\+120/);
 assert.match(start,/start\(profileID:chosen,repair:repair,completion:deliver\)/);
 assert.match(start,/"native_event":"choose_profile","choose_profile":true/);
 assert.match(start,/func reportProgress/);assert.match(start,/guard !progressInFlight,!pendingProgress.isEmpty/);
 assert.match(start,/addGlobalMonitorForEvents/);assert.match(start,/stopPreparationInputMonitoring\(\)/);
 assert.match(start,/"repair":repair,"attempt_id":preparation\.uuidString/);
 assert.match(start,/"profiles":result\["profiles"\]/);
 assert.match(start,/"selected_profile":result\["selected_profile"\]/);
 assert.doesNotMatch(start,/lease_id|CGRequestScreen|AXIsProcessTrustedWithOptions/);
});

test('1070 waiting cancellation closes permission guidance and invalidates the preparation token',()=>{
 const main=read('native/main.swift'),cancel=main.slice(main.indexOf('private func cancelChromePreparation()'),main.indexOf('private func observeChromeProfiles'));
 assert.match(cancel,/chromeInstallPreparationCancel = nil/);
 assert.match(cancel,/chromeAccessibilityWait\.cancel\(\)/);
 assert.match(cancel,/finishAccessibilityOnly\(granted:false\)/);
 assert.match(cancel,/cancel\?\(\)/);
 for(const action of ['extensionCancel','extensionManual']){
  const block=main.slice(main.indexOf('case "'+action+'":'),main.indexOf('case "'+action+'":')+300);
  assert.match(block,/cancelChromePreparation\(\)/);assert.match(block,/chromeInstallPreparation=nil/);
 }
 assert.match(main,/guard let app,app\.chromeInstallPreparation == preparation else \{return\}\s*app\.chromeInstallPreparation=nil\s*rejectInstall\("CHROME_INSTALL_CANCELLED"\)/);
 const discovery=main.slice(main.indexOf('private func observeChromeProfiles('),main.indexOf('api("/api/browser/extension/install/profiles",["discovery_only":true])'));
 assert.ok(discovery.indexOf('guard self.chromeInstallPreparation == preparation')<discovery.indexOf('self.chromeProfileDiscovery.cancel()'));
 assert.match(main,/ChromeExtensionsPageOpener\.open\(applicationURL:chromeApplicationURL\(\),completion:done\)/);
});

test('1070 local setup draft preserves the exact prompt and remains an unsent dispatch',{skip:process.platform!=='darwin',timeout:90000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1070-setup-url-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bin=path.join(root,'checks'),cache=path.join(root,'cache');fs.mkdirSync(cache);
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,'native/SetupConversation.swift','native/tests/SetupConversationChecks.swift','-o',bin],{encoding:'utf8',timeout:75000});
 assert.equal(compile.status,0,compile.stderr);
 const result=spawnSync(bin,[],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/no URL opened/);
 const source=read('native/SetupConversation.swift');
 assert.match(source,/withApplicationAt: app/);assert.match(source,/"auto_sent": false/);
 assert.match(source,/URLQueryItem\(name: "mode", value: "codex"\)/);
 assert.doesNotMatch(source,/name: "path"|NSAppleScript|NSPasteboard/);
});
