import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';
import {SetupFacts} from '../../app/v1/setup-facts.mjs';
import {InstallationPilot} from '../../app/v1/installation-pilot.mjs';
import {loadPublicInstallationId} from '../../app/v1/public-installation-id.mjs';
import {createDesktop} from '../../app/server.mjs';
import {run} from '../../skills/chathand-setup/scripts/setup.mjs';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'1069-public-id-')),installationId=crypto.randomUUID(),key=crypto.randomBytes(32);
 const options={stateDir:root,installationId,resultKey:()=>key},opened=[];
 const open=()=>{const local=new BSiteLocalStore(options);opened.push(local);return local;};
 t.after(()=>{for(const local of opened)local.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,installationId,options,open};
}
const unavailable=error=>error.code==='PUBLIC_INSTALLATION_ID_UNAVAILABLE'&&error.message===error.code&&!Object.hasOwn(error,'cause');

test('1069 public identity adds metadata to an old local schema and survives restart independently from the private identity',t=>{
 const f=fixture(t),local=f.open();
 assert.equal(local.db.prepare("SELECT name FROM sqlite_master WHERE name='public_installation_identity'").get(),undefined);
 const id=loadPublicInstallationId({local});assert.match(id,UUID);assert.notEqual(id,f.installationId);local.close();
 assert.equal(loadPublicInstallationId({local:f.open()}),id);
 assert.notEqual(loadPublicInstallationId({local:fixture(t).open()}),id);
});

test('1069 two real SQLite connections racing initial creation return the same committed public ID',{timeout:15000},async t=>{
 const f=fixture(t),local=f.open(),gate=new Int32Array(new SharedArrayBuffer(4));local.close();
 const source=`const {parentPort,workerData}=require('node:worker_threads');
 (async()=>{const {BSiteLocalStore}=await import(workerData.store),{loadPublicInstallationId}=await import(workerData.module);
 const local=new BSiteLocalStore(workerData.options);try{parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);parentPort.postMessage({id:loadPublicInstallationId({local})});}finally{local.close();}})().catch(()=>{parentPort.postMessage({failed:true});process.exitCode=1;});`;
 const workers=[0,1].map(()=>new Worker(source,{eval:true,workerData:{store:new URL('../../app/v1/b-site-store.mjs',import.meta.url).href,module:new URL('../../app/v1/public-installation-id.mjs',import.meta.url).href,options:{stateDir:f.root,installationId:f.installationId},gate:gate.buffer}}));
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.terminate()));});
 let ready=0;const ids=await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
  worker.on('error',reject);worker.on('message',message=>{if(message.failed)reject(Error('isolated identity worker failed'));if(message.ready&&++ready===2){Atomics.store(gate,0,1);Atomics.notify(gate,0,2);}if(message.id)resolve(message.id);});
 })));
 assert.equal(ids[0],ids[1]);assert.equal(loadPublicInstallationId({local:f.open()}),ids[0]);
 assert.equal(f.open().db.prepare('SELECT COUNT(*) n FROM public_installation_identity').get().n,1);
});

test('1069 corrupt public identity, private-ID reuse and read-only missing metadata fail without repair or fallback',t=>{
 for(const value of ['corrupt',null]){
  const f=fixture(t),local=f.open();loadPublicInstallationId({local});const bad=value??f.installationId;
  local.db.prepare('UPDATE public_installation_identity SET public_id=?').run(bad);
  assert.throws(()=>loadPublicInstallationId({local}),unavailable);
  assert.equal(local.db.prepare('SELECT public_id FROM public_installation_identity').get().public_id,bad);
 }
 const f=fixture(t),local=f.open();local.close();const db=new DatabaseSync(path.join(f.root,'site-b-1052.sqlite'),{readOnly:true});t.after(()=>db.close());
 const readonly={installationId:f.installationId,db,tx(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}}};
 assert.throws(()=>loadPublicInstallationId({local:readonly}),unavailable);
 assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='public_installation_identity'").get(),undefined);
});

test('1069 COMMIT failure returns no identity and rolls back metadata creation with a fixed redacted error',t=>{
 const f=fixture(t),local=f.open(),exec=local.db.exec.bind(local.db);let delivered=false;
 local.db.exec=sql=>{if(sql==='COMMIT')throw Error(f.installationId);return exec(sql);};
 try{assert.throws(()=>{loadPublicInstallationId({local});delivered=true;},unavailable);}finally{local.db.exec=exec;}
 assert.equal(delivered,false);assert.equal(local.db.prepare("SELECT name FROM sqlite_master WHERE name='public_installation_identity'").get(),undefined);
 assert.match(loadPublicInstallationId({local}),UUID);
});

test('1069 adding public metadata preserves an existing Site binding, facts and encrypted-result AAD',t=>{
 const f=fixture(t),local=f.open(),binding_id=crypto.randomUUID(),identity={installation_id:f.installationId,site_id:'synthetic-site',owner_subject:'synthetic-owner',binding_id,generation:1};
 local.configureSite(identity,{authenticated:true});local.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});local.switchUser('site',{windowGesture:true});
 const facts=new SetupFacts({local,installationId:f.installationId});facts.choose('site');facts.recordSite(identity);
 const work={op_id:crypto.randomUUID(),route:'site',principal:'site:synthetic-owner',binding_id,generation:1,tool_name:'read_file',request_digest:'a'.repeat(64),created_at:Date.now()-100,start_before:Date.now()+30000};
 local.admit(work,{authenticated:true});assert.equal(local.start(work.op_id,work).execute,true);local.complete(work.op_id,work,{ok:true,value:'synthetic result'});
 const tables=local.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
 const snapshot=()=>Object.fromEntries(tables.map(name=>[name,local.db.prepare('SELECT * FROM '+name).all()])),before=snapshot(),proof=facts.siteProof();
 const id=loadPublicInstallationId({local});assert.notEqual(id,f.installationId);assert.deepEqual(snapshot(),before);assert.deepEqual(facts.siteProof(),proof);
 assert.deepEqual(local.status(work.op_id,work,{includeResult:true}).result,{ok:true,value:'synthetic result'});
 local.close();const reopened=f.open();assert.equal(loadPublicInstallationId({local:reopened}),id);assert.equal(reopened.installationId,f.installationId);assert.equal(reopened.selection().revision,before.b_selection[0].revision);assert.equal(reopened.route('site').binding_id,binding_id);
 assert.deepEqual(reopened.status(work.op_id,work,{includeResult:true}).result,{ok:true,value:'synthetic result'});
});

test('1069 actual owner, native, SSE and doctor projections agree across restart without exposing private pilot identity',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'1069-public-http-')),stateDir=path.join(root,'state'),uiKey='ac'.repeat(32);let app;
 const create=()=>createDesktop({stateDir,defaultRoot:path.join(root,'work'),uiKey,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),credentials:{get:()=>null,status:()=>({}),publicStatus:()=>({}),set(){},remove(){}},tunnelFactory:()=>({stop(){},snapshot:async()=>({ready:false,healthy:false,process_running:false})}),bSiteTransport:{epoch:1,setRpcDelivery(){},setRuntimeFactory(){},setHostFlow(){},status:()=>({}),stop(){},close(){}},updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 t.after(async()=>{await app?.close();fs.rmSync(root,{recursive:true,force:true});});app=await create();
 const read=async(route,body)=>{const response=await fetch('http://127.0.0.1:'+app.apiPort+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+app.adminToken,'x-chathand-ui':uiKey,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status,200);return response.json();};
 const stream=async()=>{
  const abort=new AbortController(),response=await fetch('http://127.0.0.1:'+app.apiPort+'/api/events',{headers:{authorization:'Bearer '+app.adminToken,'x-chathand-ui':uiKey},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])}),reader=response.body.getReader();let text='';
  try{assert.equal(response.status,200);for(;;){const {value,done}=await reader.read();assert.equal(done,false);text+=new TextDecoder().decode(value);const match=/event: state\ndata: (.*)\n\n/.exec(text);if(match)return JSON.parse(match[1]);}}finally{abort.abort();await reader.cancel().catch(()=>{});}
 };
 const pilot=new InstallationPilot(stateDir),privateBefore=fs.readFileSync(pilot.file,'utf8'),values=[await read('/api/state'),await read('/api/native/state'),await stream(),await run(['doctor'],{locate:()=>({}),call:(_,route,body)=>read(route,body)})];
 const id=values[0].installation_id;assert.match(id,UUID);assert.notEqual(id,pilot.data.installation_uuid);
 for(const value of values){assert.equal(value.installation_id,id);assert.equal(JSON.stringify(value).includes(pilot.data.installation_uuid),false);assert.equal(JSON.stringify(value).includes(pilot.data.installation_scope),false);}
 assert.equal(app.tools.bSiteLocalStore.installationId,pilot.data.installation_uuid);assert.equal(fs.readFileSync(pilot.file,'utf8'),privateBefore);
 await app.close();app=await create();assert.equal((await read('/api/state')).installation_id,id);assert.equal((await read('/api/native/state')).installation_id,id);assert.equal(fs.readFileSync(pilot.file,'utf8'),privateBefore);
});
