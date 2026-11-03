import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('real native preflight retains missing/non-executable runtime cause and offers Download in the production alert',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-missing-runtime-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['home','cache'])fs.mkdirSync(path.join(root,name),{mode:0o700});
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),CFFIXED_USER_HOME:path.join(root,'home'),TMPDIR:root,CLANG_MODULE_CACHE_PATH:path.join(root,'cache')};
 const binary=path.join(root,'checks');
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/InstanceLifecycle.swift','native/StartupMigration.swift','native/StartupFailureAlert.swift','native/tests/StartupMissingRuntimeChecks.swift','-o',binary],{env,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[root,path.resolve('locales')],{env,encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stderr);
 for(const kind of ['missing','not-executable'])assert.match(run.stdout,new RegExp('PASS: '+kind+' preflight -> SERVICE_NODE_MISSING -> download,log,quit'));
});
