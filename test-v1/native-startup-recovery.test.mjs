import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Executes actual production lifecycle methods with deterministic in-memory
// processes and timers. Never starts the product App/daemon or executes a user
// command or connector. Only the compiler and isolated check binary run.
test('owned native startup recovers with exact-child cleanup and a finite unattached episode',
 {skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-startup-recovery-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['home','tmp','cache'])fs.mkdirSync(path.join(root,name));
 const main=fs.readFileSync('native/main.swift','utf8');
 const section=(start,end)=>{const from=main.indexOf(start),to=main.indexOf(end,from);assert.ok(from>=0&&to>from,start);return main.slice(from,to);};
 const adapt=source=>source.replaceAll('private func ','func ').replaceAll('ProcessInfo.processInfo.systemUptime','Clock.now').replaceAll('DispatchQueue.main.asyncAfter','Scheduler.after');
 let source=fs.readFileSync('test-v1/native-startup-recovery-checks.swift','utf8').replace('final class App {','final class App {\n    var chromeWebStoreFlow=Cancelable()\n    func invalidateClientAppearance() {}')
  .replace('// ACTUAL_OWNED_EXIT',adapt(section('    private func ownedBackendExited(', '    private func scheduleBackendRecovery()')))
  .replace('// ACTUAL_SCHEDULE_RECOVERY',adapt(section('    private func scheduleBackendRecovery()', '    private let chromeDataAccessResume=')))
  .replace('// ACTUAL_STARTUP_OBSERVER',adapt(section('    private func observeBackendStartup(', '    private func stopStartupBackend(')))
  .replace('// ACTUAL_STARTUP_STOP',adapt(section('    private func stopStartupBackend(', '    func rawRuntime()')));
 const fixture=path.join(root,'Checks.swift'),binary=path.join(root,'checks');fs.writeFileSync(fixture,source);
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),CLANG_MODULE_CACHE_PATH:path.join(root,'cache')};
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/BackendRecovery.swift',fixture,'-o',binary],{env,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,build.stderr);
 for(const name of ['early-exit','late-ready','bounded-timeouts','bounded-early-exits','unconfirmed-stop','launch-errors','identity','races','runtime-reset']){
  const run=spawnSync(binary,[name],{env,encoding:'utf8',timeout:5000});assert.equal(run.status,0,name+'\n'+run.stderr);assert.match(run.stdout,new RegExp('PASS: '+name));console.log(run.stdout.trim());
 }
 const launch=section('    func startService() throws {','    private func observeBackendStartup(');
 assert.match(launch,/observeBackendStartup\(p, generation:generation, identity:try\? InstanceLifecycle\.identity\(p\.processIdentifier\)\)/);
 assert.match(launch,/terminationHandler.*ownedBackendExited/);
});
