import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

test('setup progress return uses the desktop action and never opens the web fallback',async()=>{
 const source=fs.readFileSync(new URL('../../ui/h10/host.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function backToChatGPT(b){');
 const end=source.indexOf('\n}',start);
 assert.ok(start>=0&&end>start);
 const box=vm.createContext({});
 vm.runInContext(source.slice(start,end+2)+'\nglobalThis.run=backToChatGPT;',box);
 for(const response of [{opened:true},{opened:false},null]){
  const calls=[];
  const bridge={native:async(action,args)=>{calls.push([action,Object.keys(args)]);return response;},openChatGPT:()=>{throw Error('unexpected web fallback');}};
  assert.equal(await box.run(bridge),response?.opened===true);
  assert.deepEqual(calls,[['openSetupDesktop',[]]]);
 }
 assert.equal(await box.run({native:async()=>{throw Error('unavailable');}}),false);
});

test('native desktop return opens the app without a conversation URL',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-desktop-return-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'checks');
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-framework','Cocoa','native/SetupConversation.swift','native/tests/1084SetupReturnChecks.swift','-o',binary],{encoding:'utf8',timeout:90000});
 assert.equal(compile.status,0,compile.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr);
 assert.match(run.stdout,/desktop return without opening a URL/);
 const source=fs.readFileSync(new URL('../../native/SetupConversation.swift',import.meta.url),'utf8');
 const method=source.slice(source.indexOf('static func showDesktop('),source.indexOf('static func open(prompt:'));
 assert.match(method,/configuration\.activates = true/);
 assert.match(method,/configuration\.createsNewApplicationInstance = false/);
 assert.match(method,/openApplication\(at: url/);
 assert.doesNotMatch(method,/promptURL|open\(\[url\]/);
});
