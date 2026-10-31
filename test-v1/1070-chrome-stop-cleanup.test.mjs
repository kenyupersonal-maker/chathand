import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('actual stop and owned-backend-exit cleanup cancel AX waiting, close guidance and fence late grants',
 {skip:process.platform!=='darwin',timeout:150000},()=>{
 const main=fs.readFileSync('native/main.swift','utf8');
 const helper=main.slice(main.indexOf('    private func cancelChromePreparation()'),main.indexOf('    private func observeChromeProfiles('));
 function cleanup(start,end){
  const scope=main.slice(main.indexOf(start),main.indexOf(end,main.indexOf(start)));
  const from=scope.indexOf('cancelChromePreparation()'),to=scope.indexOf('chromeHelperInstaller.cancel()',from);
  assert.ok(from>=0&&to>from,'lifecycle enters the shared cancellation before installer cleanup');
  return scope.slice(from,to+'chromeHelperInstaller.cancel()'.length);
 }
 const code=`import Foundation
 final class Cancelable {var canceled=0;func cancel(){canceled += 1}}
 final class Permission {var visible=false,closed=0;func finishAccessibilityOnly(granted:Bool){if visible{visible=false;closed += 1}}}
 final class App {
 var trusted=false,now:TimeInterval=0,jobs:[()->Void]=[],grants=0,stops=0
 var chromeSettingsGeneration:UUID?
 var chromeDiscoveryProof:ChromeInstallDiscoveryProof?,chromePreflightProof:ChromeInstallDiscoveryProof?
 var chromeDiscoveryProofSlot:ChromeInstallDiscoveryProofSlot?
 var chromeInstallPreparation:UUID?,chromeInstallPreparationCancel:(()->Void)?,chromeInstallContinuation:(()->Void)?
 let permissionAssistant=Permission(),chromeProfileDiscovery=Cancelable(),chromeDataAccessResume=Cancelable(),chromeHelperInstaller=Cancelable()
 lazy var chromeAccessibilityWait=ChromeAccessibilityWait(now:{self.now},schedule:{_,work in self.jobs.append(work)},trusted:{self.trusted})
 ${helper}
 func cleanup(_ backend:Bool){if backend{${cleanup('private func ownedBackendExited(', 'private func scheduleBackendRecovery()')}}else{${cleanup('@objc func stopAutomation()', 'func currentComputerStatus()')}}}
 func check(_ backend:Bool){
  chromeInstallPreparation=UUID();chromeInstallContinuation={}
  chromeInstallPreparationCancel={self.chromeInstallPreparation=nil;self.stops += 1}
  chromeAccessibilityWait.start(onWaiting:{self.permissionAssistant.visible=true},onGranted:{self.grants += 1},completion:{_ in})
  precondition(chromeAccessibilityWait.active && permissionAssistant.visible)
  cleanup(backend);cleanup(backend)
  precondition(!chromeAccessibilityWait.active && !permissionAssistant.visible && permissionAssistant.closed == 1)
  precondition(chromeInstallPreparation == nil && chromeInstallContinuation == nil && stops == 1)
  precondition(chromeProfileDiscovery.canceled == 2 && chromeDataAccessResume.canceled == 2 && chromeHelperInstaller.canceled == 2)
  trusted=true;now=200;let late=jobs;jobs=[];late.forEach{$0()}
  precondition(grants == 0 && jobs.isEmpty)
 }
 }
 @main struct Checks {static func main(){App().check(false);App().check(true);print("PASS: stop cleanup")}}
 `;
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1070-stop-cleanup-')));
 for(const part of ['home','tmp','cache'])fs.mkdirSync(path.join(root,part));
 const source=path.join(root,'Checks.swift'),binary=path.join(root,'checks');fs.writeFileSync(source,code);
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),CLANG_MODULE_CACHE_PATH:path.join(root,'cache')};
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-DCHATHAND_INSTALL_PURE_TEST','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/LocalText.swift','native/ChromeHelperInstall.swift','native/ChromeAccessibilityWait.swift',source,'-o',binary],{env,encoding:'utf8',timeout:120000});
 assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: stop cleanup/);
 });
