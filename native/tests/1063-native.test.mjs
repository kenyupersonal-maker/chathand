import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('1063 compiled native behavior uses fake clipboard and disposable files only',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native1063-check-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const binary=path.join(tmp,'checks'),r=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-framework','Cocoa','-framework','WebKit','-framework','ImageIO','native/ClientFeatures.swift','native/WindowChrome.swift','native/BuildVersion.swift','native/NativeDiagnostics.swift','native/PluginIconExport.swift','native/tests/1063-native.swift','-o',binary],{encoding:'utf8',timeout:90000});assert.equal(r.status,0,r.stderr);
 const run=spawnSync(binary,[path.resolve('ui/assets/app/ChatHand-plugin-icon.png')],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS:/);t.diagnostic(run.stdout.trim());
});
