import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {startDesktopFromNative} from '../../app/server.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const frame=JSON.stringify({v:2,ui_key:'a'.repeat(64),owner_key:'b'.repeat(64)})+'\n';
const cases=[
 ['NODE_VERSION',71,'STARTUP_NODE_VERSION'],['ALREADY_RUNNING',72,'STARTUP_ALREADY_RUNNING'],
 ['DATA_FORMAT_NEWER',73,'STARTUP_DATA_NEWER'],['DATA_FORMAT_UNSUPPORTED',74,'STARTUP_DATA_UNSUPPORTED'],
 ['EACCES',75,'STARTUP_ACCESS_DENIED'],['EPERM',75,'STARTUP_ACCESS_DENIED'],
 ['ENOSPC',76,'STARTUP_STORAGE_FULL'],['EADDRINUSE',77,'STARTUP_PORT_IN_USE'],
 ['NATIVE_OWNER_EXITED',78,'STARTUP_OWNER_EXITED'],['none',70,'STARTUP_FAILURE_UNKNOWN'],
 ['PRIVATE_SYNTHETIC_CODE',70,'STARTUP_FAILURE_UNKNOWN'],
 ['PILOT_IDENTITY_UNSAFE',79,'PILOT_IDENTITY_UNSAFE'],['PILOT_IDENTITY_CORRUPT',80,'PILOT_IDENTITY_CORRUPT'],
 ['PILOT_IDENTITY_INVALID',81,'PILOT_IDENTITY_INVALID'],['RELAY_STATE_VERSION',82,'RELAY_STATE_VERSION'],
 ['B_STORE_CONFIG',83,'B_STORE_CONFIG'],['B_STORE_UNSAFE',84,'B_STORE_UNSAFE'],
 ['MATTER_UNSAFE_PATH',85,'MATTER_UNSAFE_PATH'],['MATTER_UNSAFE_FILE',86,'MATTER_UNSAFE_FILE'],
 ['MATTER_SEQUENCE',87,'MATTER_SEQUENCE'],['MATTER_ID',88,'MATTER_ID'],
 ['MATTER_JOURNAL_CONFLICT',89,'MATTER_JOURNAL_CONFLICT'],['STATE_UNSAFE',90,'STATE_UNSAFE'],
 ['FAKE_CREDENTIAL_PRIVATE_SYNTHETIC_TOKEN',70,'STARTUP_FAILURE_UNKNOWN'],
];
function launch(t,{mode='error',code='PRIVATE_SYNTHETIC_CODE',entry='fixture',drain=true,prepare,reuse}={}){
 const temp=reuse||fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-cli-startup-')));
 const home=path.join(temp,'home'),state=path.join(temp,'state'),tmp=path.join(temp,'tmp');
 for(const directory of [home,state,tmp])fs.mkdirSync(directory,{mode:0o700,recursive:true});
 prepare?.(state);
 const args=entry==='fixture'?['tests/v1/desktop-cli-fixture.mjs',mode,code]:['app/server.mjs'];
 const child=spawn(process.execPath,args,{cwd:root,stdio:['pipe','pipe','pipe'],env:{
  PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:temp,
  CHATHAND_STATE_DIR:state,KEN_BRIDGE_STATE_DIR:state,CHATHAND_UI_KEY_STDIN:'1',CHATHAND_OWNER_PIPE:'stdin-v1',
  NODE_TEST_CONTEXT:'child-v8',
 }});
 let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',bytes=>{stdout+=bytes;});
 if(drain)child.stderr.on('data',bytes=>{stderr+=bytes;});
 child.stdin.on('error',()=>{});child.stdin.write(frame);
 let ended=false;
 const exit=new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(Error('synthetic child did not exit while parent kept stdin open'));},5000);
  child.once('error',error=>{clearTimeout(deadline);reject(error);});
  child.once(drain?'close':'exit',(status,signal)=>{ended=true;clearTimeout(deadline);resolve({status,signal});});
 });
 t.after(async()=>{
  if(!ended){child.kill('SIGKILL');await exit.catch(()=>{});}
  child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();fs.rmSync(temp,{recursive:true,force:true});
 });
 return {child,temp,state,exit,get stdout(){return stdout;},get stderr(){return stderr;}};
}
async function ready(f){
 const deadline=Date.now()+4000;
 while(!f.stdout.includes('本机执行服务已启动。')){
  assert.equal(f.child.exitCode,null,f.stderr);
  assert.ok(Date.now()<deadline,'isolated service did not become ready');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
}

for(const [code,status,category] of cases)test('CLI exits promptly with open native stdin and fixed category: '+code,async t=>{
 const f=launch(t,{code});
 assert.deepEqual(await f.exit,{status,signal:null});
 assert.equal(f.child.stdin.writableEnded,false,'parent must retain its writer throughout the failure');
 const rows=f.stderr.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
 assert.deepEqual(rows,[{code:category}]);
 assert.doesNotMatch(f.stdout+f.stderr,/PRIVATE_SYNTHETIC/);
});

test('real server entry opens newer synthetic data with a notice and preserves the original file',async t=>{
 const original='{"format":"chathand-desktop-v2","schema":99,"synthetic_marker":"PRIVATE_SYNTHETIC_DATA"}';
 const f=launch(t,{entry:'server',prepare:state=>fs.writeFileSync(path.join(state,'desktop.json'),original)});
 await ready(f);assert.equal(f.child.stdin.writableEnded,false);assert.doesNotMatch(f.stdout+f.stderr,/PRIVATE_SYNTHETIC/);
 const runtime=JSON.parse(fs.readFileSync(path.join(f.state,'runtime.json'),'utf8'));
 const response=await fetch(runtime.ui_origin+'/api/state',{headers:{Authorization:'Bearer '+runtime.admin_token}}),state=await response.json();assert.deepEqual(state.startup_notices,[{kind:'newer',format_version:'2',min_app_version:null}]);
 assert.equal(fs.readFileSync(path.join(f.state,'desktop.json'),'utf8'),original);f.child.stdin.end();assert.deepEqual(await f.exit,{status:0,signal:null});assert.equal(fs.readFileSync(path.join(f.state,'desktop.json'),'utf8'),original);
});

// 1095 (Ken 11/3): the installation identity never stops ChatHand from opening.
// A damaged identity file is kept aside byte-for-byte and a fresh one is used.
test('real desktop keeps a corrupt synthetic installation identity aside and still opens',async t=>{
 const original=Buffer.from('{"format":1,"installation_uuid":"PRIVATE_SYNTHETIC_CREDENTIAL",broken');
 const f=launch(t,{mode:'desktop',prepare:state=>fs.writeFileSync(path.join(state,'installation-1049.json'),original,{mode:0o600})});
 await ready(f);
 assert.doesNotMatch(f.stdout+f.stderr,/PRIVATE_SYNTHETIC/);
 const aside=fs.readdirSync(f.state).filter(name=>/^installation-1049\.unreadable-.*\.json$/.test(name));
 assert.equal(aside.length,1);assert.deepEqual(fs.readFileSync(path.join(f.state,aside[0])),original);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'installation-1049.json'),'utf8')).format,1);
 f.child.stdin.end();assert.deepEqual(await f.exit,{status:0,signal:null});
});

// The B_INSTALLATION_SCOPE regression: host name or data-folder inode changed
// on the same Mac. ChatHand opens and keeps the same identity.
test('real desktop opens when the saved installation scope no longer matches',async t=>{
 const uuid='3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
 const f=launch(t,{mode:'desktop',prepare:state=>fs.writeFileSync(path.join(state,'installation-1049.json'),JSON.stringify({format:1,installation_uuid:uuid,installation_scope:'scope-from-an-older-host-name',pilot_installation_uuid:uuid,pilot_default_applied:true})+'\n',{mode:0o600})});
 await ready(f);
 assert.doesNotMatch(f.stderr,/B_INSTALLATION_SCOPE|STARTUP_/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'installation-1049.json'),'utf8')).installation_uuid,uuid);
 f.child.stdin.end();assert.deepEqual(await f.exit,{status:0,signal:null});
});

// A Site record left by another identity (copied from another Mac, or an
// identity that had to start fresh) is kept aside; this Mac opens without it.
test('real desktop keeps a Site record from another installation aside and still opens',async t=>{
 const {BSiteLocalStore}=await import('../../app/v1/b-site-store.mjs');
 const f=launch(t,{mode:'desktop',prepare:state=>{const store=new BSiteLocalStore({stateDir:state,installationId:'0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'});store.close();}});
 await ready(f);
 assert.doesNotMatch(f.stderr,/B_INSTALLATION_CHANGED|STARTUP_/);
 assert.equal(fs.readdirSync(f.state).filter(name=>/^site-b-1052\.other-installation-.*\.sqlite$/.test(name)).length,1);
 assert.equal(fs.existsSync(path.join(f.state,'site-b-1052.sqlite')),true);
 f.child.stdin.end();assert.deepEqual(await f.exit,{status:0,signal:null});
});

test('blocked stderr cannot keep a startup failure alive',async t=>{
 const f=launch(t,{mode:'blocked-stderr',drain:false});
 assert.deepEqual(await f.exit,{status:70,signal:null});
 assert.equal(f.child.stdin.writableEnded,false);
});

for(const stop of ['owner-eof','SIGTERM'])test('isolated desktop starts with open owner stdin and closes normally: '+stop,async t=>{
 const f=launch(t,{mode:'desktop'});await ready(f);
 const runtime=JSON.parse(fs.readFileSync(path.join(f.state,'runtime.json'),'utf8'));
 assert.equal(runtime.pid,f.child.pid);assert.equal(f.child.exitCode,null);
 if(stop==='owner-eof')f.child.stdin.end();else f.child.kill('SIGTERM');
 assert.deepEqual(await f.exit,{status:0,signal:null});
 assert.doesNotMatch(f.stderr,/STARTUP_/);
 assert.equal(fs.existsSync(path.join(f.state,'runtime.json')),false);
 assert.equal(fs.existsSync(path.join(f.state,'app.lock')),false);
});

test('failed startup leaves a stale lock that a later isolated CLI replaces and closes normally',async t=>{
 const failed=launch(t,{mode:'desktop-failure'});
 assert.deepEqual(await failed.exit,{status:70,signal:null});
 assert.equal(failed.child.stdin.writableEnded,false);
 const lock=path.join(failed.state,'app.lock');
 assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,failed.child.pid);
 assert.doesNotMatch(failed.stdout+failed.stderr,/PRIVATE_SYNTHETIC/);
 const restarted=launch(t,{mode:'desktop',reuse:failed.temp});await ready(restarted);
 assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,restarted.child.pid);
 assert.equal(JSON.parse(fs.readFileSync(path.join(restarted.state,'runtime.json'),'utf8')).pid,restarted.child.pid);
 restarted.child.stdin.end();assert.deepEqual(await restarted.exit,{status:0,signal:null});
 assert.equal(fs.existsSync(lock),false);assert.equal(fs.existsSync(path.join(restarted.state,'runtime.json')),false);
});

test('embedded startDesktopFromNative rejects without terminating its host',async()=>{
 const input=new PassThrough(),error=Object.assign(Error('synthetic embedded failure'),{code:'SYNTHETIC_EMBEDDED_FAILURE'});
 const starting=startDesktopFromNative({input,env:{CHATHAND_UI_KEY_STDIN:'1',CHATHAND_OWNER_PIPE:'stdin-v1'},create:async()=>{throw error;}});
 input.write(frame);await assert.rejects(starting,actual=>actual===error);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(input.destroyed,false);assert.equal(input.listenerCount('end'),0);input.destroy();
});
