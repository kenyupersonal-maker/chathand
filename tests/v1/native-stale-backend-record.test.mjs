import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native capture and manual clear use exact process identity and preserve stale records', {skip:process.platform!=='darwin',timeout:120000}, t=>{
 const repo=fileURLToPath(new URL('../..',import.meta.url));
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-native-stale-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'state'),cache=path.join(root,'cache'),home=path.join(root,'home'),binary=path.join(root,'checks');
 for(const dir of [state,cache,home])fs.mkdirSync(dir,{mode:0o700});
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:root,CLANG_MODULE_CACHE_PATH:cache};
 const source=fs.readFileSync(path.join(repo,'native/main.swift'),'utf8');
 const from=source.indexOf('    private func showStartupFailure('),to=source.indexOf('    func observeSitePrompt(',from);
 assert.ok(from>=0&&to>from);
 // Feed the real alert's button index into the production callbacks. The GUI
 // focus and new-service launch are fixture effects, with real file archival.
 const callbacks=source.slice(from,to).replaceAll('private func ','func ')
  .replaceAll('InstanceLifecycle.','ButtonLifecycle.').replaceAll('LocalText.','ButtonLocalText.')
  .replace('alert.runModal()','clickClearRetry(alert,actions:actions)');
 const fixture=path.join(root,'Checks.swift');
 fs.writeFileSync(fixture,fs.readFileSync(path.join(repo,'native/tests/StaleBackendRecordChecks.swift'),'utf8').replace('// ACTUAL_CLEAR_RETRY_CALLBACKS',callbacks));
 const built=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,'native/InstanceLifecycle.swift','native/StartupFailureAlert.swift','native/BackendRecovery.swift','native/BuildVersion.swift',fixture,'-o',binary],{cwd:repo,env,encoding:'utf8',timeout:90000});
 assert.equal(built.status,0,built.stderr);
 const ran=spawnSync(binary,[state],{env,encoding:'utf8',timeout:10000});
 assert.equal(ran.status,0,ran.stderr);
 assert.match(ran.stdout,/PASS: native capture/);
 assert.match(ran.stdout,/PASS: clear preserves live and unknown records/);
 assert.match(ran.stdout,/PASS: clear retry button callbacks/);
});
