import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('restricted real settings preserve their bytes and report access denial through preflight to the production native alert',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-preflight-access-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['home','cache','state'])fs.mkdirSync(path.join(root,name),{mode:0o700});
 const file=path.join(root,'state/desktop.json'),original=Buffer.from('{"format":"chathand-desktop-v1","version":1}');fs.writeFileSync(file,original,{mode:0o600});fs.chmodSync(file,0);
 const before=fs.statSync(file),env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),CFFIXED_USER_HOME:path.join(root,'home'),TMPDIR:root,CLANG_MODULE_CACHE_PATH:path.join(root,'cache'),CHATHAND_STATE_DIR:path.join(root,'state')};
 const direct=spawnSync(process.execPath,['scripts/migrate-state.mjs'],{env,encoding:'utf8',timeout:5000});assert.equal(direct.status,75,direct.stderr);assert.equal(direct.stderr,'STARTUP_ACCESS_DENIED\n');assert.equal(direct.stdout,'');
 const binary=path.join(root,'checks');
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/InstanceLifecycle.swift','native/StartupMigration.swift','native/StartupFailureAlert.swift','native/tests/StartupAccessDeniedChecks.swift','-o',binary],{env,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[root,process.execPath,path.resolve('scripts/migrate-state.mjs'),path.resolve('locales')],{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: restricted settings -> preflight 75\/STARTUP_ACCESS_DENIED -> access dataFolder,log,quit/);
 const after=fs.statSync(file);for(const key of ['mode','ino','mtimeMs','size'])assert.equal(after[key],before[key],key);assert.deepEqual(fs.readdirSync(path.join(root,'state')),['desktop.json']);fs.chmodSync(file,0o600);assert.deepEqual(fs.readFileSync(file),original);
});
