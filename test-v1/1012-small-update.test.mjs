import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {Updater} from '../app/v1/update.mjs';
function fixture(t,{automatic=false,settings={},busy=false,sleep,lifecycleKey=null}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1012-update-')),stateDir=path.join(root,'state'),home=path.join(root,'upgrades'),downloads=path.join(root,'Downloads'),file=path.join(root,'latest.json');for(const p of [stateDir,downloads])fs.mkdirSync(p);
 const bytes=Buffer.from('simulated isolated download'),latest={format:'chathand-latest-v1',version:'9.0.0',build:9999,published_at:'2026-10-02T00:00:00Z',notes:'fixture',min_macos:'14.0',tool_schema_sha256:'a'.repeat(64),dmg:{name:'ChatHand-fixture.dmg',url:'https://example.invalid/ChatHand-fixture.dmg',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length},release_page:'https://example.invalid/releases'};fs.writeFileSync(file,JSON.stringify(latest));
 const f={root,stateDir,home,latest,bytes,busy,downloaded:false,verified:false,launched:false,states:[],beforeStates:[]};
 const exec=async(program,args)=>{
  if(program==='/usr/bin/sw_vers')return {stdout:'26.0'};
  if(program==='/usr/bin/hdiutil'){
   if(args[0]==='detach')return {stdout:''};const volume=path.join(args[args.indexOf('-mountrandom')+1],'volume'),app=path.join(volume,'ChatHand.app'),runtime=path.join(app,'Contents/Resources/runtime');fs.mkdirSync(path.join(runtime,'bin'),{recursive:true});fs.mkdirSync(path.join(runtime,'scripts'));fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({version:latest.version,kenBridge:{build_number:latest.build}}));fs.writeFileSync(path.join(runtime,'bin/node'),'fake');fs.writeFileSync(path.join(runtime,'scripts/upgrade.mjs'),'fake');fs.writeFileSync(path.join(app,'Contents/Info.plist'),'fake');return {stdout:`<key>mount-point</key><string>${volume}</string>`};
  }
  if(program==='/usr/bin/ditto'){fs.cpSync(args[0],args[1],{recursive:true});return {stdout:''};}
  if(program==='/usr/bin/codesign'){f.verified=true;return {stdout:'',stderr:'designated => identifier "com.kenyu.chathand"\n'};}
  if(program==='/usr/libexec/PlistBuddy')return {stdout:args[1].includes('Identifier')?'com.kenyu.chathand':latest.version};
  if(program==='/usr/bin/xattr')return {stdout:''};throw Error('UNEXPECTED_FIXTURE_COMMAND');
 };
 const spawn=(program,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.stdin.on('data',chunk=>{f.authority=String(chunk).trim();});child.unref=()=>{};child.kill=()=>queueMicrotask(()=>child.emit('close',null));queueMicrotask(()=>{child.emit('spawn');if(program==='/usr/bin/curl'){fs.writeFileSync(args[args.indexOf('--output')+1],bytes);f.downloaded=true;child.stdout.end('200');child.emit('close',0);}else{f.launched=true;assert.equal(options.env.CHATHAND_STATE_DIR,stateDir);assert.equal(args[args.indexOf('--destination')+1],path.join(root,'ChatHand.app'));if(lifecycleKey){assert.equal(JSON.stringify(args).includes(lifecycleKey),false);assert.equal(JSON.stringify(options.env).includes(lifecycleKey),false);assert.equal(options.stdio[0],'pipe');}}});return child;};
 f.updater=new Updater({stateDir,upgradeHome:home,downloadsDir:downloads,currentAppPath:path.join(root,'ChatHand.app'),version:'1.0.0',schemaSha:'b'.repeat(64),state:{data:settings},busy:()=>f.busy,sleep,exec,spawn,currentSystemProxy:()=>null,env:{CHATHAND_STATE_DIR:stateDir,CHATHAND_UPDATE_URL:pathToFileURL(file).href},allowAutomaticInstall:automatic,lifecycleKey});
 const set=f.updater._set.bind(f.updater);f.updater._set=(...args)=>{f.beforeStates.push(f.updater.snapshot());set(...args);f.states.push(f.updater.snapshot());};t.after(()=>{f.updater.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}
test('automatic installation is opt-in for the host and obeys settings defaults',async t=>{
 for(const [automatic,settings,expect] of [[false,{},false],[true,{auto_update:false},false],[true,{},true]]){const f=fixture(t,{automatic,settings});await f.updater.check();const run=f.updater.run;if(run)await run.promise;assert.equal(f.launched,expect);assert.equal(f.updater.snapshot().auto_update,settings.auto_update!==false);}
});
test('app updater passes lifecycle authority on stdin without writing it to pending state or logs',async t=>{
 const lifecycleKey='f'.repeat(64),f=fixture(t,{automatic:true,lifecycleKey});await f.updater.check();await f.updater.run.promise;assert.equal(f.launched,true);assert.equal(f.authority===lifecycleKey,true);for(const file of [path.join(f.stateDir,'update-pending.json'),path.join(f.home,'last-update.log')])assert.equal(fs.readFileSync(file,'utf8').includes(lifecycleKey),false);
});
test('automatic update downloads and verifies during tasks; installs only after they finish',async t=>{
 let release,waiting;const gate=new Promise(r=>release=r),atWait=new Promise(r=>waiting=r);const f=fixture(t,{automatic:true,busy:true,sleep:()=>{waiting();return gate;}});
 await f.updater.check();const run=f.updater.run;await atWait;assert.equal(f.downloaded,true);assert.equal(f.verified,true);assert.equal(f.launched,false);assert.equal(f.updater.snapshot().status,'waiting_tasks');f.busy=false;release();await run.promise;assert.equal(f.launched,true);assert.equal(f.updater.snapshot().status,'installing');assert.equal(f.states.some(s=>s.status==='verifying'),true);assert.equal(f.beforeStates.some(s=>s.status==='downloading'&&s.downloaded_bytes===f.bytes.length&&s.total_bytes===f.bytes.length&&s.progress===1),true);
});
test('automatic cancellation does not launch and does not retry the same version on each check',async t=>{
 let waiting;const atWait=new Promise(r=>waiting=r),f=fixture(t,{automatic:true,busy:true,sleep:()=>{waiting();return new Promise(()=>{});}});await f.updater.check();const run=f.updater.run;await atWait;f.updater.cancel();await run.promise;assert.equal(f.launched,false);await f.updater.check();assert.equal(f.updater.run,null);
});
test('turning off automatic updates while waiting cancels installation',async t=>{
 let waiting;const atWait=new Promise(r=>waiting=r),settings={},f=fixture(t,{automatic:true,settings,busy:true,sleep:()=>{waiting();return new Promise(()=>{});}});await f.updater.check();const run=f.updater.run;await atWait;settings.auto_update=false;f.updater.settingsChanged();await run.promise;assert.equal(f.launched,false);assert.equal(f.updater.snapshot().install.state,'idle');
});
test('state contract exposes download bytes, verification, rollback and refresh reminder',t=>{
 const f=fixture(t);for(const [state,status] of [['waiting_tasks','waiting_tasks'],['waiting_download','waiting_download'],['downloading','downloading'],['verifying','verifying'],['installing','installing'],['restarting','installing'],['failed','failed'],['idle','available']]){f.updater.value.status='available';f.updater.value.install={state,progress:.5,downloaded_bytes:10,total_bytes:20};const s=f.updater.snapshot();assert.equal(s.status,status);assert.equal(s.downloaded_bytes,10);assert.equal(s.total_bytes,20);}
 const result=path.join(f.stateDir,'update-result.json');for(const [status,rolledBack] of [['ROLLED_BACK',true],['ROLLBACK_FAILED',false],['FAILED',false]]){fs.writeFileSync(result,JSON.stringify({status}));f.updater._readResult();assert.equal(f.updater.snapshot().install.rolled_back,rolledBack);}
 fs.writeFileSync(result,JSON.stringify({status:'COMMITTED',from:'0.9.0',to:'1.0.0',schema_from:'a'.repeat(64)}));f.updater._readResult();assert.equal(f.updater.snapshot().status,'updated');assert.equal(f.updater.snapshot().refresh_tools,true);f.updater.ack();assert.equal(f.updater.snapshot().just_updated,null);
});
test('injected updater rejects a daily app path before any installer command',t=>{
 const f=fixture(t);assert.throws(()=>new Updater({stateDir:f.stateDir,upgradeHome:f.home,downloadsDir:path.join(f.root,'Downloads'),currentAppPath:'/Applications/ChatHand.app',exec:async()=>{throw Error('must not execute');}}),/ISOLATED_UPDATE_PATH_REQUIRED/);
});
