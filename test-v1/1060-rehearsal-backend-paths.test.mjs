import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {initialize,privateUpgradeHome} from '../scripts/rehearse-1060-isolated.mjs';
import {rehearsalUpgradeHome} from '../app/v1/rehearsal-upgrade-paths.mjs';
import {reconcileStartupUpgrade} from '../app/v1/upgrade-startup.mjs';
import {createDesktop} from '../app/server.mjs';
import crypto from 'node:crypto';
function fixture(t){
 const root=path.join(fs.realpathSync('/tmp'),'chathand-1060-rehearsal-backend-'+crypto.randomUUID()),config=initialize(root),s=config.scenarios.success;
 for(const p of [s.home,s.state,s.target,s.backup])fs.mkdirSync(p,{recursive:true,mode:0o700});
 const env={HOME:s.home,CFFIXED_USER_HOME:s.home,TMPDIR:s.home,CHATHAND_STATE_DIR:s.state,CHATHAND_REHEARSAL_ROOT:root,CHATHAND_REHEARSAL_HOME:s.home};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,s,env};
}
const resolve=(f,env=f.env,stateDir=f.s.state,appPath=f.s.target)=>rehearsalUpgradeHome({env,stateDir,appPath});
test('ordinary startup has no rehearsal override; valid private native binding chooses sibling default upgrades without PAGE_DIR',t=>{
 assert.equal(rehearsalUpgradeHome({env:{}}),null);const f=fixture(t);
 assert.equal(resolve(f),privateUpgradeHome(f.s.home));assert.equal(Object.hasOwn(f.env,'CHATHAND_REHEARSAL_PAGE_DIR'),false);
 assert.equal(resolve(f).startsWith(f.s.state+path.sep),false);
});
test('rehearsal path seam rejects partial, public, mismatched, outside and aliased inputs before normal startup',t=>{
 const f=fixture(t);const invalid=fn=>assert.throws(fn,e=>e.code==='REHEARSAL_UPGRADE_PATH_INVALID');
 for(const env of [{CHATHAND_REHEARSAL_ROOT:f.root},{...f.env,HOME:'/formal-home-must-not-be-read'},{...f.env,CFFIXED_USER_HOME:'/formal-home-must-not-be-read'},{...f.env,CHATHAND_STATE_DIR:f.s.home},{...f.env,CHATHAND_REHEARSAL_HOME:'/formal-home-must-not-be-read'}])invalid(()=>resolve(f,env));
 invalid(()=>resolve(f,f.env,'/formal-state-must-not-be-read'));invalid(()=>resolve(f,f.env,f.s.state,'/Applications/ChatHand.app'));
 fs.chmodSync(f.root,0o755);invalid(()=>resolve(f));fs.chmodSync(f.root,0o700);
 const marker=path.join(f.root,'.rehearsal-root.json'),bytes=fs.readFileSync(marker);fs.writeFileSync(marker,'{}');invalid(()=>resolve(f));fs.writeFileSync(marker,bytes);
 const alias=path.join(f.root,'home-alias');fs.symlinkSync(f.s.home,alias);invalid(()=>resolve(f,{...f.env,HOME:alias,CFFIXED_USER_HOME:alias,CHATHAND_REHEARSAL_HOME:alias}));
 const upgrades=f.s.backup;fs.rmdirSync(upgrades);fs.symlinkSync(f.s.state,upgrades);invalid(()=>resolve(f));fs.unlinkSync(upgrades);
});
test('same real temporary installer lock blocks startup before any process-command lookup',async t=>{
 const f=fixture(t),home=resolve(f),lock=path.join(home,'install.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}));let lookups=0;
 await assert.rejects(()=>reconcileStartupUpgrade({guard:{inspect:()=>({phase:'verifying',active:true})},stateDir:f.s.state,home,app:f.s.target,version:'1.0.0-beta.10',build:1060,installerActive:async()=>{lookups++;throw Error('PROCESS_LOOKUP_MUST_NOT_RUN');}}),e=>e.code==='UPGRADE_STILL_RUNNING');assert.equal(lookups,0);
});
test('real server wiring uses only the validated private default upgradeHome',async t=>{
 const f=fixture(t),previous=new Map(Object.keys(f.env).map(k=>[k,process.env[k]]));for(const [k,v] of Object.entries(f.env))process.env[k]=v;
 let app,observed;
 try{app=await createDesktop({stateDir:f.s.state,defaultRoot:path.join(f.root,'work'),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:f.s.target,computerName:()=> 'Synthetic rehearsal',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:deps=>{observed=deps;return {home:deps.upgradeHome,currentBuild:1060,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown'}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})};}}});assert.equal(observed.upgradeHome,f.s.backup);assert.equal(Object.hasOwn(observed,'installerActive'),false);}
 finally{await app?.close();for(const [k,v] of previous){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('actual native path resolver overrides a formal-looking HOME only after private binding; no PAGE_DIR needed',{skip:process.platform!=='darwin',timeout:60000},t=>{
 const f=fixture(t),source=new URL('../native/RehearsalBackendPaths.swift',import.meta.url).pathname,main=path.join(f.root,'main.swift'),binary=path.join(f.root,'native-path-probe'),cache=path.join(f.root,'module-cache');fs.mkdirSync(cache);
 fs.writeFileSync(main,`import Foundation\nlet d=try! JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:Any]\ndo {let value=try RehearsalBackendPaths.environment(source:d["env"] as! [String:String],statePath:URL(fileURLWithPath:d["state"] as! String).path,appPath:URL(fileURLWithPath:d["app"] as! String).path);let bytes=try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);print(String(data:bytes,encoding:.utf8)!)}catch{print("REJECTED");exit(2)}\n`);
 const env={HOME:f.s.home,CFFIXED_USER_HOME:f.s.home,TMPDIR:f.s.home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'};
 execFileSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',cache,source,main,'-o',binary],{env,timeout:45000});
 const call=(e,state=f.s.state,app=f.s.target)=>execFileSync(binary,[],{env,input:JSON.stringify({env:e,state,app}),encoding:'utf8',timeout:5000});
 assert.deepEqual(JSON.parse(call({})),{});
 const actual=JSON.parse(call({...f.env,HOME:'/formal-home-must-not-be-read'}));assert.equal(actual.HOME,f.s.home);assert.equal(actual.CFFIXED_USER_HOME,f.s.home);assert.equal(actual.TMPDIR,f.s.home);assert.deepEqual(Object.keys(actual).sort(),['CFFIXED_USER_HOME','CHATHAND_REHEARSAL_HOME','CHATHAND_REHEARSAL_ROOT','HOME','TMPDIR']);
 assert.throws(()=>call({CHATHAND_REHEARSAL_ROOT:f.root}));assert.throws(()=>call(f.env,'/formal-state-must-not-be-read'));assert.throws(()=>call(f.env,f.s.state,'/Applications/ChatHand.app'));
});
