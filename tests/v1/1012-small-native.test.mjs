import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('native module compiles and passes isolated injected-action checks',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-swift-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const binary=path.join(root,'checks'),cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(root,'module-cache');fs.mkdirSync(cache,{recursive:true});
 const env={...process.env,CHATHAND_STATE_DIR:path.join(root,'state'),CLANG_MODULE_CACHE_PATH:cache};
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',cache,'-framework','AppKit','native/ClientFeatures.swift','native/WindowChrome.swift','tests/v1/1012-small-native.swift','-o',binary],{encoding:'utf8',timeout:90000,env});assert.equal(compile.status,0,(compile.error?.code||'')+' '+compile.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:5000,env});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: \d+ isolated native checks/);console.log(run.stdout.trim());
});
