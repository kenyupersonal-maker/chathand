import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';
import {BSitePairing} from '../../app/v1/b-site-pairing.mjs';
import {run} from '../../skills/chathand-setup/scripts/setup.mjs';

const pin={verified_source:true,source_kind:'bundled_local',template_file:'fixture.zip',template_sha256:'a'.repeat(64),template_version:'1069-site-b-v6',manifest_sha256:'b'.repeat(64)};
const body={format:'chathand-site-v3',site_id:'fixture1070',site_origin:'https://fixture1070.chatgpt.site',service_credential:'synthetic-only-'.repeat(4)};
function fixture(t,{beginV2=async()=>{throw Object.assign(Error('fixture'),{code:'B_REMOTE_TRANSIENT'});}}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'1070-site-lifecycle-')),installationId=crypto.randomUUID();
 let now=1792670400000,writes=0,local;
 const credentials={data:{},readAll(){return structuredClone(this.data);},get(key){return this.readAll()[key]??null;},writeAll(value){writes++;this.data=structuredClone(value);}};
 const transport={epoch:0,bindingProtocolVersion:3,beginV2,completeRecoveredV2:async()=>assert.fail('must not complete')};
 const open=()=>{
  local=new BSiteLocalStore({stateDir:root,installationId,existingA:true,now:()=>now});
  return new BSitePairing({installationId,credentials,localStore:local,transport,templatePin:()=>pin,resolveDeployment:async()=>null,now:()=>now});
 };
 const pairing=open();t.after(()=>local.close());
 return {root,credentials,transport,pairing,get local(){return local;},get writes(){return writes;},advance(){now++;},reopen(){local.close();return open();}};
}

test('1070 snapshot reads never create or prune an intent or write credentials/SQLite',t=>{
 const f=fixture(t),changes=()=>f.local.db.prepare('SELECT total_changes() AS n').get().n;
 const before=changes();
 for(let i=0;i<3;i++)assert.equal(f.pairing.snapshot().verified_template_source,null);
 assert.equal(f.local.activeIntent(f.credentials),null);assert.equal(f.writes,0);assert.equal(changes(),before);
 const descriptor=f.pairing.startSitePairing(),afterStart=changes(),writes=f.writes;
 assert.match(descriptor.pairing_hash,/^[a-f0-9]{64}$/);
 for(let i=0;i<3;i++)assert.deepEqual(f.pairing.snapshot().verified_template_source,descriptor);
 assert.equal(changes(),afterStart);assert.equal(f.writes,writes);
});

test('1070 abandon persists a bounded failure across restart and an explicit new Site attempt clears it',t=>{
 const f=fixture(t);f.pairing.startSitePairing();
 assert.deepEqual(f.pairing.abandonSitePairing('B_PAIRING_ABANDONED'),{phase:'failed',error_code:'B_PAIRING_ABANDONED'});
 assert.equal(f.local.selection().selected,'openai');
 let pairing=f.reopen();assert.equal(pairing.snapshot().phase,'failed');assert.equal(pairing.snapshot().error_code,'B_PAIRING_ABANDONED');
 assert.equal(pairing.restoreV2Recovery(),false);
 pairing.startSitePairing();assert.equal(pairing.snapshot().phase,'unconfigured');assert.equal(pairing.snapshot().error_code,null);
 pairing=f.reopen();assert.equal(pairing.snapshot().error_code,null);
});

test('1070 failure storage contains only code/time; invalid abandon reasons cannot overwrite it',t=>{
 const f=fixture(t);f.pairing.failure={code:'B_BINDING_CONFLICT',at:1000,conflict:{device_name:'volatile fixture'},replacement_grant:'synthetic-only-do-not-persist'};
 const row=f.local.db.prepare('SELECT * FROM b_pair_failure').get();
 assert.deepEqual({...row},{id:1,error_code:'B_BINDING_CONFLICT',updated_at:1000});
 assert.throws(()=>f.pairing.abandonSitePairing('arbitrary error message'),{code:'B_PAIR_FAILURE_INVALID'});
 const pairing=f.reopen();assert.deepEqual(pairing.failure,{code:'B_BINDING_CONFLICT',at:1000});
 assert.equal(pairing.snapshot().conflict,undefined);
});

test('1070 terminal pairing errors persist without needing a subsequent server failure assignment',async t=>{
 const f=fixture(t,{beginV2:async()=>{throw Object.assign(Error('fixture'),{code:'B_REBIND_UNSUPPORTED'});}});
 f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});
 await assert.rejects(f.pairing.pairV2(),{code:'B_REBIND_UNSUPPORTED'});
 const pairing=f.reopen();assert.equal(pairing.snapshot().phase,'failed');assert.equal(pairing.snapshot().error_code,'B_REBIND_UNSUPPORTED');
 assert.equal(pairing.restoreV2Recovery(),false);
 await pairing.importGrant(body,{nativeUI:true});assert.equal(pairing.snapshot().phase,'pairing');assert.equal(pairing.failure,null);
});

test('1070 a response arriving after abandon cannot complete or replace the persisted failure',async t=>{
 let settle;const gate=new Promise(resolve=>{settle=resolve;});
 const f=fixture(t,{beginV2:async()=>{await gate;throw Object.assign(Error('fixture'),{code:'B_REMOTE_TRANSIENT'});}});
 f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});const pending=f.pairing.pairV2();
 f.pairing.abandonSitePairing('B_PAIRING_ABANDONED');settle();await assert.rejects(pending,{code:'B_REMOTE_TRANSIENT'});
 assert.equal(f.pairing.pending,null);assert.equal(f.pairing.failure.code,'B_PAIRING_ABANDONED');
 assert.equal(f.local.route('site').configured,0);assert.equal(f.local.selection().selected,'openai');
 assert.equal(f.reopen().snapshot().error_code,'B_PAIRING_ABANDONED');
});

test('1070 an old attempt error cannot overwrite a newer Site attempt',async t=>{
 let settle;const gate=new Promise(resolve=>{settle=resolve;});
 const f=fixture(t,{beginV2:async()=>{await gate;return {};}});
 f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});const old=f.pairing.pairV2();
 f.pairing.abandonSitePairing('B_PAIRING_ABANDONED');f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});
 const next=f.pairing.pending;settle();await assert.rejects(old,{code:'B_PAIRING_ATTEMPT_EXPIRED'});
 assert.equal(f.pairing.pending,next);assert.equal(f.pairing.failure,null);assert.equal(f.pairing.snapshot().phase,'pairing');
});

test('1070 a fresh pairing runs even while the abandoned request is settling',async t=>{
 let settle,calls=0;const gate=new Promise(resolve=>{settle=resolve;});
 const f=fixture(t,{beginV2:async()=>{
  calls++;if(calls===1)await gate;
  throw Object.assign(Error('fixture'),{code:calls===1?'B_REMOTE_TRANSIENT':'B_REBIND_UNSUPPORTED'});
 }});
 f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});const old=f.pairing.pairV2();
 f.pairing.abandonSitePairing('B_PAIRING_ABANDONED');f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});
 await assert.rejects(f.pairing.pairV2(),{code:'B_REBIND_UNSUPPORTED'});assert.equal(calls,2);
 settle();await assert.rejects(old);assert.equal(f.pairing.failure.code,'B_REBIND_UNSUPPORTED');
});

test('1070 a credential-refresh rejection after switching away cannot start a continuity rebind',async t=>{
 let settle;const gate=new Promise(resolve=>{settle=resolve;});
 const f=fixture(t),key=crypto.generateKeyPairSync('ed25519'),binding=crypto.randomUUID();
 f.credentials.data.site_b={trust:'tofu-template-v1',installation_id:f.local.installationId,site_id:body.site_id,site_origin:body.site_origin,
  owner_subject:'fixture-owner',binding_id:binding,generation:1,template_version:pin.template_version,manifest_sha256:pin.manifest_sha256,
  private_pkcs8:key.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),device_credential:'synthetic-only-'.repeat(4)};
 f.local.configureSite({site_id:body.site_id,owner_subject:'fixture-owner',binding_id:binding,generation:1},{authenticated:true});
 f.transport.healthWithBearer=async()=>{await gate;throw Object.assign(Error('fixture'),{code:'B_SITE_NETWORK_FAILED'});};
 const old=f.pairing.importGrant(body,{nativeUI:true});f.pairing.abandonSitePairing('B_PAIRING_ABANDONED');
 settle();await assert.rejects(old,{code:'B_SITE_NETWORK_FAILED'});
 assert.equal(f.pairing.pending,null);assert.equal(f.pairing.failure.code,'B_PAIRING_ABANDONED');
 assert.equal(f.local.route('site').configured,1,'abandoning setup preserves the existing binding');
});

test('1070 stopping a verified conflict preserves that volatile attempt; switching away invalidates it',async t=>{
 const f=fixture(t);f.pairing.startSitePairing();await f.pairing.importGrant(body,{nativeUI:true});
 const pending=f.pairing.pending;f.pairing.failure={code:'B_BINDING_CONFLICT',at:1000,conflict:{device_name:null,last_used:null}};
 f.pairing.abandonSitePairing('B_BINDING_CONFLICT');assert.equal(f.pairing.pending,pending);f.pairing.assertCurrent(pending);
 f.pairing.abandonSitePairing('B_PAIRING_ABANDONED');assert.equal(f.pairing.pending,null);
 assert.throws(()=>f.pairing.assertCurrent(pending),{code:'B_PAIRING_ATTEMPT_EXPIRED'});
});

test('1070 doctor only reads state even when setup activity exists',async()=>{
 const calls=[];await run(['doctor'],{locate:()=>({}),call:async(_runtime,route)=>{calls.push(route);return {setup_activity:{active:false},site_b:{selected:'openai'}};}});
 assert.deepEqual(calls,['/api/state']);
});

test('1070 verified template is ready before any pairing intent exists',t=>{
 const f=fixture(t);
 assert.equal(f.local.activeIntent(f.credentials),null);
 assert.equal(f.pairing.snapshot().template_ready,true);
});
