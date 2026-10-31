import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('native uninstall filesystem and ownership checks use disposable paths only',{skip:process.platform!=='darwin'},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-uninstall-compile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const binary=path.join(dir,'ChatHandUninstallChecks');
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',path.join(dir,'cache'),'-parse-as-library',path.join(root,'native/ChatHandUninstall.swift'),path.join(root,'native/ProcessOwnership.swift'),path.join(root,'native/tests/ChatHandUninstallChecks.swift'),'-o',binary],{encoding:'utf8',timeout:120000});
 assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS:/);
});
