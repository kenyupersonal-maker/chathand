import {createLegacyChromeInstallSource} from '../support/legacy-chrome-install-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import readline from 'node:readline';
import vm from 'node:vm';
import {ChromeInstallProbe} from '../../app/v1/chrome-install-probe.mjs';
import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';

test('actual native setup/repair entry orders accepted attempts, polls asynchronously and fences cancellation with fake desktop/API',
  {skip: process.platform !== 'darwin', timeout: 150000}, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1070-attempt-')));
    for (const name of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(root, name));
    const main = fs.readFileSync('native/main.swift', 'utf8');
    const install = fs.readFileSync('native/ChromeHelperInstall.swift', 'utf8');
    const diagnosticTypes = install.slice(install.indexOf('enum ChromeInstallDetailCode:'), install.indexOf('/// Chrome exposes version fields'));
    const entry = main.slice(main.indexOf('        case "extensionSetup":'), main.indexOf('        case "openChromeDataAccessSettings":'));
    assert.ok(entry.includes('func beginAttempt(') && entry.includes('beginAttempt(app:self'));
    const cancel = main.slice(main.indexOf('    private func cancelChromePreparation('), main.indexOf('    private func observeChromeProfiles('));
    function cleanup(from, to) {
      const scope = main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
      const start = scope.indexOf('cancelChromePreparation()'), end = scope.indexOf('chromeHelperInstaller.cancel()', start);
      assert.ok(start >= 0 && end > start, from+' ends the shared wait and installer');
      return scope.slice(start, end+'chromeHelperInstaller.cancel()'.length);
    }
    const recovered = main.slice(main.indexOf('        case "openChromeDataAccessSettings":'), main.indexOf('        case "extensionCancel":'));
    assert.ok(recovered.indexOf('chromeSettingsGeneration=recovery') < recovered.indexOf('api("/api/browser/extension/install/status"'));
    assert.match(recovered, /guard self\.chromeSettingsGeneration == recovery/);
    const fixture = fs.readFileSync('tests/v1/1070-native-attempt-checks.swift', 'utf8')
      .replace('// ACTUAL_DIAGNOSTIC_TYPES', diagnosticTypes)
      .replace('// ACTUAL_NATIVE_ENTRY', entry.replaceAll('ProcessInfo', 'TestProcessInfo').replaceAll('DispatchQueue', 'TestQueue'))
      .replace('// ACTUAL_PREPARATION_CANCEL', cancel)
      .replace('// ACTUAL_STOP_CLEANUP', cleanup('@objc func stopAutomation()', 'func currentComputerStatus()'))
      .replace('// ACTUAL_BACKEND_CLEANUP', cleanup('private func ownedBackendExited(', 'private func scheduleBackendRecovery()'))
      .replace('// ACTUAL_RECOVERY_ERROR_CLEANUP', cleanup('if result["error"] != nil || result["error_code"] != nil {self.cancelChromePreparation()', 'done(result)'));
    const source = path.join(root, 'Checks.swift'), binary = path.join(root, 'checks');
    fs.writeFileSync(source, fixture);
    const env = {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), CLANG_MODULE_CACHE_PATH: path.join(root, 'cache')};
    const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-DCHATHAND_INSTALL_PURE_TEST', '-parse-as-library',
      '-module-cache-path', path.join(root, 'cache'), 'native/ChromeAccessibilityWait.swift', source, '-o', binary], {env, encoding: 'utf8', timeout: 120000});
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], {env, encoding: 'utf8', timeout: 15000});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /PASS: native attempt entry/);
    console.log(run.stdout.trim());
    // The actual Swift entry consumes replies from the real backend module.
    // Desktop/profile discovery and HTTP transport remain synthetic boundaries.
    let clock=0;
    const probe=new ChromeInstallProbe({root:createLegacyChromeInstallSource(t),state:{data:{browser_enabled:true,desktop_enabled:true}},
      policy:{epoch:1,permissionRevision:1,check(){}},extension:{session:'old',pending:new Map(),status:()=>({connected:true})},
      origin:()=> 'http://127.0.0.1:12345',now:()=>clock,registrationOnlyAfterOptIn:true,browserOptIn:()=>true,distribution:legacyChromeDistribution()});
    let receipt,uiCases,stderr='';
    const child=spawn(binary,['--backend-integration'],{env,stdio:['pipe','pipe','pipe']});
    const lines=readline.createInterface({input:child.stdout});
    child.stderr.on('data',bytes=>{stderr+=bytes;});
    lines.on('line',line=>{
      const message=JSON.parse(line);
      if(message.receipt){receipt=message.receipt;uiCases=message.ui_cases;return;}
      clock=message.clock_ms;const body=message.body;let response;
      try {
        switch(message.route){
          case '/api/browser/extension/install/progress':response=probe.progress(body.lease_id,body.stage,body);break;
          case '/api/browser/extension/install/profiles':
            if(body.discovery_only){probe.allowed();response={observe_allowed:true};}
            else response=probe.observeProfiles(body.observed_profile_ids);break;
          case 'start':response=probe.begin(probe.chooseObservedProfile(body.profile_id));break;
          case 'cancel':response=probe.cancel(body.lease_id);break;
          case 'status':response=probe.publicStatus();break;
          default:throw new Error('unexpected test route');
        }
      }catch(error){response={error:{code:error.code||'FIXTURE_ROUTE_FAILED'}};}
      child.stdin.write(JSON.stringify(response??{})+'\n');
    });
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    assert.equal(exit,0,stderr);
    assert.deepEqual(receipt,{multiProfile:true,repair:true,freshID:true,canceled:true,waiting:true,stopped:true,retry:true},
      'requires the attempt-aware Chrome backend; current main alone cannot project asynchronous profile choice');
    const ui=fs.readFileSync('ui/app.js','utf8');
    for(const scenario of uiCases){
      const timers=new Map(),calls=[],asked=[],views=[];let serial=0,reply=scenario.bridge;
      const context=vm.createContext({T:x=>x,TH:x=>x,E:String,S:{},capOn:()=>true,scheduleRender(){},
        btn:(_text,action,id)=>`[${action}|${id}]`,modal:html=>views.push(html),
        native:async(action,body)=>{calls.push({action,body});return reply;},
        api:async(_route,body)=>{asked.push(body);return scenario.status;},refresh:async()=>{},
        setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
      vm.runInContext(ui.slice(ui.indexOf('let chromeInstallView='),ui.indexOf('function desktopSheet()')),context);
      const kind=scenario.repair?'repair':'install';
      vm.runInContext('chromeInstallWaitAX='+scenario.wait,context);
      await context.startExtensionSetup('',kind);
      const [id,poll]=[...timers][0];timers.delete(id);await poll();
      assert.equal(timers.size,0,'actual UI consumes the actual backend choice once');
      assert.ok(views.at(-1).includes('['+(scenario.repair?'extensionRepair':'extensionSetup')+'|Profile 1]'));
      const bound=scenario.bridge.attempt_id?.toLowerCase();
      assert.equal(JSON.stringify(asked),JSON.stringify([bound?{attempt_id:bound}:{}]));
      if(scenario.wait)assert.equal(bound,undefined,'actual AX waiting acknowledgement uses the supported no-ID fallback');
      reply=scenario.followup;await context.startExtensionSetup('Profile 1',kind);
      assert.equal(calls.at(-1).action,scenario.repair?'extensionRepair':'extensionSetup');
      assert.equal(calls.at(-1).body.profile_id,'Profile 1');
      assert.equal(calls.at(-1).body.wait_for_accessibility===true,scenario.wait);
      assert.equal(Object.hasOwn(calls.at(-1).body,'attempt_id'),false,'profile click never reuses the old attempt');
      assert.notEqual(reply.attempt_id?.toLowerCase(),scenario.status.attempt_id?.toLowerCase());
    }
  });
