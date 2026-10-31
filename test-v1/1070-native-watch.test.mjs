import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('1070 same Site watch renews from server expiry and authoritative stop invalidates clipboard callbacks',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1070-native-watch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'checks'),cache=path.join(root,'cache');fs.mkdirSync(cache);
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',cache,'-framework','AppKit','native/ClientFeatures.swift','native/WindowChrome.swift','native/SetupConversation.swift','native/tests/1070NativeWatchChecks.swift','-o',binary],{encoding:'utf8',timeout:90000});
 assert.equal(compile.status,0,compile.stderr);
 const result=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/no real clipboard/);
});
