import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {helperFingerprint,INSTALL_SOURCE_FILES} from '../app/v1/chrome-install-probe.mjs';
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');

test('1042 native installer runs only pure temporary-source and fake-adapter contracts',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1042-swift-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(root,'module-cache'),binary=path.join(root,'checks');fs.mkdirSync(cache,{recursive:true});
 const env={...process.env,CHATHAND_STATE_DIR:path.join(root,'state'),CLANG_MODULE_CACHE_PATH:cache};
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-DCHATHAND_INSTALL_PURE_TEST','-module-cache-path',cache,'native/LocalText.swift','native/ChromeHelperInstall.swift','native/tests/ChromeHelperInstallTests.swift','-o',binary],{encoding:'utf8',timeout:90000,env});
 assert.equal(compile.status,0,(compile.error?.code||'')+' '+compile.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000,env});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: \d+ isolated Chrome installer checks/);console.log(run.stdout.trim());
 const fixture=path.join(root,'runtime'),folder=path.join(fixture,'browser-extension');
 for(const name of INSTALL_SOURCE_FILES){const target=path.join(folder,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(new URL('../browser-extension/'+name,import.meta.url),target);}
 const cross=spawnSync(binary,['--fingerprint',fixture],{encoding:'utf8',timeout:10000,env});assert.equal(cross.status,0,cross.stderr);assert.equal(cross.stdout.trim(),helperFingerprint(folder),'native and backend hash the same actual 20-file temporary helper fixture');
 console.log('PASS: native/backend actual 20-file helper fingerprint equality');
});

test('1042 private native wiring preserves HID guard, fixed source, per-input lease check and manual fallback',()=>{
 const main=read('native/main.swift'),source=read('native/ChromeHelperInstall.swift'),pkg=read('native/Package.swift');
 const start=main.slice(main.indexOf('        case "extensionSetup":'),main.indexOf('        case "extensionSettings":'));
 assert.match(start,/confirmationInput\(via:"window"\).*human/);assert.match(start,/chromeHelperInstaller\.start/);assert.match(start,/case "extensionCancel"/);assert.match(start,/case "extensionManual"/);assert.doesNotMatch(start,/requestPermissions|CGRequestScreen|AXIsProcessTrustedWithOptions/);assert.match(start,/install\/profiles/);assert.match(start,/ChromeInstallLease\.validProfile/);
 assert.match(pkg,/"ChromeHelperInstall.swift"/);assert.match(source,/authorized\(stage: stage, input: true/);assert.match(source,/adapter\?\.check\(stage, input: input\)/);assert.match(source,/\.mouseMoved/);assert.match(source,/\.otherMouseDragged/);
 assert.doesNotMatch(source,/NSPasteboard|NSAppleScript|AXIsProcessTrustedWithOptions|CGRequestScreen|AXManualAccessibility|AXEnhancedUserInterface/);
 assert.match(source,/checkOwnedTab\(waiting: true\)/);assert.match(source,/case \.chooser, \.selectedFolder, \.goFolder, \.chooserClosing/);assert.match(source,/guard !input else/);
 assert.match(source,/native_verified/);assert.match(source,/source_fingerprint/);assert.match(source,/\/api\/browser\/extension\/install\/probe\//);
 assert.match(start,/chromeInstallPreparation == nil/);assert.match(start,/self\.chromeInstallPreparation == preparation/);assert.match(start,/profiles\.count <= 100/);
 for(const name of ['extensionCancel','extensionManual'])assert.match(start.slice(start.indexOf('case "'+name+'":')),/chromeInstallPreparation=nil/);
 assert.match(main.slice(main.indexOf('    @objc func quit()'),main.indexOf('    func showError(')),/chromeInstallPreparation=nil/);
 assert.match(source,/Profile \[0-9\]\{1,6\}/);assert.match(source,/configuration\.createsNewApplicationInstance = true/);assert.match(source,/existingSourceVerified/);assert.match(source,/baselineIDs\.union/);
 assert.match(source,/case managed = "CHROME_INSTALL_MANAGED_POLICY_BLOCKED"/);assert.match(source,/chrome:\/\/policy/);assert.match(source,/ExtensionDeveloperModeSettings/);assert.match(source,/ExtensionInstallAllowlist/);assert.match(source,/ExtensionSettings/);
 assert.match(source,/\.nonactivatingPanel/);assert.match(source,/\.ignoresMouseEvents = true/);assert.match(source,/LocalText\.text\("native\.chrome\.progress"/);assert.match(source,/presentation\.close\(\)/);
 assert.match(source,/adapter\?\.inputReady == false/);assert.match(source,/screensDidSleepNotification/);assert.match(source,/sessionDidResignActiveNotification/);
 assert.match(source,/CGPreflightScreenCaptureAccess\(\)/);assert.match(source,/SCContentFilter\(desktopIndependentWindow: captureWindow\)/);assert.match(source,/await SCScreenshotManager\.captureImage/);assert.doesNotMatch(source,/CGWindowListCreateImage|DispatchSemaphore/);assert.match(source,/CGImageDestinationAddImage\(destination, safe, \[:\] as CFDictionary\)/);assert.match(source,/LocalText\.text\("native\.chrome\.failureMasked"/);assert.match(source,/evidence\["lease_id"\] = id/);assert.match(source,/evidenceRun = nil/);
 const manual=start.slice(start.indexOf('case "extensionManual":'));assert.match(manual,/chromewebstore\.google\.com/);assert.match(manual,/withApplicationAt:chrome/);assert.doesNotMatch(manual,/NSWorkspace\.shared\.open\(url\)/);
});
