import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readPinnedSiteTemplate} from '../../app/v1/site-template-pin.mjs';
import {BSiteLocalStore} from '../../app/v1/b-site-store.mjs';
import {BSitePairing} from '../../app/v1/b-site-pairing.mjs';
import {BSiteHttpTransport} from '../../app/v1/b-site-http-transport.mjs';
import {pairedSiteTarget} from '../../app/v1/b-site-trust.mjs';
import {pairingBytesV2,receiptBytesV2,healthAckBytes,rawPublicFromKey,encodeUrl64,edSign,sha256} from '../../app/v1/b-site-wire.mjs';

const installationId='c7403891-fbb1-4833-820a-fca957b4f024';
const siteId='privateSiteA',origin='https://private-a.chatgpt.site',owner='owner-fixture';
const manifest='a'.repeat(64),pin=Object.freeze({verified_source:true,template_version:'fixture-v2',manifest_sha256:manifest});
class Credentials{
 constructor(){this.data={};}
 readAll(){return structuredClone(this.data);}
 writeAll(value){this.data=structuredClone(value);}
 get(key){return this.readAll()[key]??null;}
}
function fixture({lostResponses=0,corruptReceipt=false,localPin=pin,initialRemotePin=pin}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'b-site-recovery-'));
 const credentials=new Credentials(),key=crypto.generateKeyPairSync('ed25519');
 const sitePublic=encodeUrl64(rawPublicFromKey(key.publicKey));
 let activePin=localPin,remotePin=initialRemotePin;
 let claim=null,receipt=null,begins=0,completes=0,firstBody=null,revoked=false;
 const transport={epoch:0,start(){},stop(){this.epoch++},
  async beginV2(request){
   begins++;
   const intent=credentials.get('site_b_intents');
   const hash=crypto.createHash('sha256').update(JSON.stringify(['chathand-site-precreate-v1',installationId,
    Object.keys(intent)[0],Object.values(intent)[0]])).digest('hex');
   claim={protocol_version:'2',site_id:siteId,site_origin:origin,owner_subject:owner,
    installation_id:installationId,device_public_key_id:request.public_key_id,
    pairing_id:crypto.randomUUID(),client_nonce:request.client_nonce,server_nonce:encodeUrl64(crypto.randomBytes(32)),
    issued_at:String(Math.floor(Date.now()/1000)),expires_at:String(Math.floor(Date.now()/1000)+240),
    pairing_hash:hash,template_version:remotePin.template_version,manifest_sha256:remotePin.manifest_sha256,site_public_key:sitePublic};
   return {claim,site_signature:edSign(key.privateKey,pairingBytesV2(claim))};
  },
  async completeRecoveredV2(body){
   completes++;
   if(revoked)throw Object.assign(Error('remote binding revoked'),{code:'B_REMOTE_CONFLICT'});
   if(firstBody)assert.deepEqual(body,firstBody,'retry must use the identical proof');
   else firstBody=structuredClone(body);
   if(!receipt){
    const binding=crypto.randomUUID(),device=encodeUrl64(crypto.randomBytes(32));
    receipt={protocol_version:'2',site_id:siteId,owner_subject:owner,installation_id:installationId,
     pairing_id:claim.pairing_id,binding_id:binding,generation:1,device_credential:device,
     receipt_digest:sha256('synthetic-receipt'),template_version:remotePin.template_version,manifest_sha256:remotePin.manifest_sha256};
    receipt.site_signature=edSign(key.privateKey,receiptBytesV2({...receipt,claim_digest:body.claim_digest}));
   }
   if(completes<=lostResponses)throw Object.assign(Error('response lost after remote commit'),{code:'B_SITE_REQUEST_TIMEOUT'});
   return corruptReceipt?{...receipt,site_signature:'invalid'}:receipt;
  },
  async health(request){
   const saved=credentials.get('site_b');
   const result={protocol_version:'2',site_id:siteId,binding_id:saved.binding_id,
    generation:saved.generation,installation_id:installationId,nonce:request.nonce,
    template_version:remotePin.template_version,manifest_sha256:remotePin.manifest_sha256};
   result.signature=edSign(key.privateKey,healthAckBytes(saved,{...result,signature:'pending'},
    {nonce:request.nonce,installationId,templatePin:remotePin,allowTemplatePromotion:true}));
   return result;
  }};
 const store=()=>new BSiteLocalStore({stateDir:root,installationId,existingA:false,resultKey:()=>Buffer.alloc(32)});
 const pairing=local=>new BSitePairing({installationId,credentials,localStore:local,
  resolveDeployment:()=>null,transport,templatePin:()=>activePin});
 return {root,credentials,transport,store,pairing,templatePin:()=>activePin,
  upgradeLocal:next=>{activePin=next;},upgradeRemote:()=>{remotePin=activePin;},
  counts:()=>({begins,completes}),revokeRemote:()=>{revoked=true;}};
}
const body={format:'chathand-site-v2',site_origin:origin,site_id:siteId,service_credential:'s'.repeat(48)};

test('lost complete response retrieves the same signed receipt without a new begin',async()=>{
 const f=fixture({lostResponses:1}),local=f.store();
 try{
  local.ensureIntent(f.credentials);
  const pair=f.pairing(local);await pair.importGrant(body,{nativeUI:true});
  const result=await pair.pairV2();
  assert.equal(result.health,'healthy');
  assert.deepEqual(f.counts(),{begins:1,completes:2});
  assert.equal(local.pairRecovery(f.credentials),null);
  assert.equal(f.credentials.get('site_b_pair_recovery'),null);
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('restart resumes only the original complete proof after both responses are lost',async()=>{
 const f=fixture({lostResponses:2});let local=f.store();
 try{
  local.ensureIntent(f.credentials);
  const pair=f.pairing(local);await pair.importGrant(body,{nativeUI:true});
  await assert.rejects(pair.pairV2(),{code:'B_SITE_REQUEST_TIMEOUT'});
  assert.equal(local.pairRecovery(f.credentials)?.row?.pairing_id?.length,36);
  local.close();local=f.store();
  const resumed=f.pairing(local);
  assert.equal(resumed.restoreV2Recovery(),true);
  const result=await resumed.pairV2();
  assert.equal(result.health,'healthy');
  assert.deepEqual(f.counts(),{begins:1,completes:3});
  assert.equal(local.pairRecovery(f.credentials),null);
  assert.equal(f.credentials.get('site_b_pair_recovery'),null);
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('remote revoke after a lost receipt stops startup recovery and clears the staged proof',async()=>{
 const f=fixture({lostResponses:2});let local=f.store();
 try{
  local.ensureIntent(f.credentials);
  const pair=f.pairing(local);await pair.importGrant(body,{nativeUI:true});
  await assert.rejects(pair.pairV2(),{code:'B_SITE_REQUEST_TIMEOUT'});
  local.close();f.revokeRemote();local=f.store();
  const resumed=f.pairing(local);assert.equal(resumed.restoreV2Recovery(),true);
  await assert.rejects(resumed.pairV2(),{code:'B_REMOTE_CONFLICT'});
  assert.deepEqual(f.counts(),{begins:1,completes:3});
  assert.equal(local.pairRecovery(f.credentials),null);
  assert.equal(local.route('site').configured,0);
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('explicit local cancellation prevents a pending proof from resuming after restart',async()=>{
 const f=fixture({lostResponses:2});let local=f.store();
 try{
  local.ensureIntent(f.credentials);
  const pair=f.pairing(local);await pair.importGrant(body,{nativeUI:true});
  await assert.rejects(pair.pairV2(),{code:'B_SITE_REQUEST_TIMEOUT'});
  pair.cancelV2Recovery();local.close();local=f.store();
  assert.equal(f.pairing(local).restoreV2Recovery(),false);
  assert.deepEqual(f.counts(),{begins:1,completes:2});
  assert.equal(f.credentials.get('site_b_pair_recovery'),null);
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('bad signed receipt never commits and never auto-retries after restart',async()=>{
 const f=fixture({corruptReceipt:true});let local=f.store();
 try{
  local.ensureIntent(f.credentials);
  const pair=f.pairing(local);await pair.importGrant(body,{nativeUI:true});
  await assert.rejects(pair.pairV2(),{code:'B_PAIRING_RECEIPT_SIGNATURE'});
  local.close();local=f.store();
  assert.equal(f.pairing(local).restoreV2Recovery(),false);
  assert.equal(local.route('site').configured,0);
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('new App pin permits only health until the original Site is updated and signed health promotes metadata',async()=>{
 const f=fixture(),local=f.store();
 try{
  local.ensureIntent(f.credentials);
  const pairing=f.pairing(local);await pairing.importGrant(body,{nativeUI:true});
  await pairing.pairV2();
  const original=f.credentials.get('site_b'),binding=original.binding_id;
  const nextPin={verified_source:true,template_version:'fixture-v3',manifest_sha256:'b'.repeat(64)};
  f.upgradeLocal(nextPin);
  const target=()=>pairedSiteTarget(siteId,{credentials:f.credentials,localStore:local,
   installationId,templatePin:f.templatePin});
  assert.equal(target()?.template_current,false);
  const http=new BSiteHttpTransport({installationId,credentials:f.credentials,localStore:local,
   templatePin:f.templatePin,resolveDeployment:target,autoPoll:false,
   fetchImpl:async()=>{throw Error('stale business request reached network');}});
  await assert.rejects(http.exchange('next',{}, {site_id:siteId}),{code:'B_TEMPLATE_MISMATCH'});
  await assert.rejects(pairing.verifyHealth(),{code:'B_TEMPLATE_MISMATCH'});
  assert.equal(local.route('site').state,'failed');
  assert.equal(f.credentials.get('site_b').template_version,original.template_version);
  f.upgradeRemote();
  const result=await pairing.verifyHealth();
  assert.equal(result.health,'healthy');
  assert.equal(f.credentials.get('site_b').binding_id,binding);
  assert.equal(f.credentials.get('site_b').device_credential,original.device_credential);
  assert.equal(f.credentials.get('site_b').template_version,nextPin.template_version);
  assert.equal(f.credentials.get('site_b').manifest_sha256,nextPin.manifest_sha256);
  assert.equal(target()?.template_current,true);
  assert.equal(local.route('site').state,'healthy');
  assert.deepEqual(f.counts(),{begins:1,completes:1});
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('actual HTTP authorization denial stops recovery while a transient response retains the same proof',async t=>{
 for(const status of [401,403,503])await t.test('HTTP '+status,async()=>{
  const f=fixture(),local=f.store();let calls=0;
  const http=new BSiteHttpTransport({installationId,credentials:f.credentials,localStore:local,
   autoPoll:false,fetchImpl:async url=>{
    calls++;const r=new Response('{}',{status,headers:{'content-type':'application/json'}});
    Object.defineProperty(r,'url',{value:url});return r;
   }});
  f.transport.completeRecoveredV2=body=>http.completeRecoveredV2(body,
   {site_id:siteId,origin,bearer:'s'.repeat(48)});
  try{
   local.ensureIntent(f.credentials);const pair=f.pairing(local);
   await pair.importGrant(body,{nativeUI:true});
   await assert.rejects(pair.pairV2(),{code:status===503?'B_REMOTE_TRANSIENT':'B_REMOTE_AUTH_REQUIRED'});
   assert.equal(calls,status===503?2:1);
   assert.equal(Boolean(local.pairRecovery(f.credentials)),status===503);
   assert.equal(local.route('site').configured,0);
  }finally{http.close();local.close();fs.rmSync(f.root,{recursive:true,force:true});}
 });
});

test('a user selection change while complete is in flight prevents stale pairing from replacing it',async()=>{
 const f=fixture(),local=f.store(),complete=f.transport.completeRecoveredV2;
 // Model an existing pre-C1 installation's persisted Site choice. C1 only
 // changes fresh installations; the actual user switch below must change route.
 local.db.prepare("UPDATE b_selection SET selected='site' WHERE id=1").run();
 f.transport.completeRecoveredV2=async body=>{
  const receipt=await complete(body);
  local.configureOpenAI({verified:true});
  local.health('openai',{state:'healthy',verified:true,nonceEcho:true,generation:0});
  local.switchUser('openai',{windowGesture:true});
  return receipt;
 };
 try{
  local.ensureIntent(f.credentials);const pair=f.pairing(local);
  await pair.importGrant(body,{nativeUI:true});
  await assert.rejects(pair.pairV2(),{code:'B_PAIRING_ATTEMPT_EXPIRED'});
  assert.equal(local.selection().selected,'openai');
  assert.equal(local.route('site').configured,0);
  assert.equal(f.credentials.get('site_b'),null);
  assert.equal(local.pairRecovery(f.credentials),null);
  assert.deepEqual(f.counts(),{begins:1,completes:1});
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a cached receipt with a substituted binding or device credential cannot commit',async t=>{
 for(const field of ['binding_id','device_credential'])await t.test(field,async()=>{
  const f=fixture(),local=f.store(),complete=f.transport.completeRecoveredV2;
  f.transport.completeRecoveredV2=async body=>{
   const receipt=await complete(body);
   return {...receipt,[field]:field==='binding_id'?crypto.randomUUID():encodeUrl64(crypto.randomBytes(32))};
  };
  try{
   local.ensureIntent(f.credentials);const pair=f.pairing(local);
   await pair.importGrant(body,{nativeUI:true});
   await assert.rejects(pair.pairV2(),{code:'B_PAIRING_RECEIPT_SIGNATURE'});
   assert.equal(local.route('site').configured,0);
   assert.equal(f.credentials.get('site_b'),null);
   assert.equal(local.pairRecovery(f.credentials),null);
  }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
 });
});

// Actual package metadata, isolated signed-receipt peers only: no platform or installed App.
test('1060 real local source keeps old manifest health, credential renewal and polling compatible, then promotes only a trusted signed manifest',async()=>{
 const localPin=readPinnedSiteTemplate(),oldPin=localPin.trusted_templates[0];
 assert.equal(localPin.source_kind,'bundled_local');assert.notEqual(localPin.manifest_sha256,oldPin.manifest_sha256);
 const f=fixture({localPin:oldPin,initialRemotePin:oldPin}),local=f.store();
 try{
  local.ensureIntent(f.credentials);const pair=f.pairing(local);await pair.importGrant(body,{nativeUI:true});await pair.pairV2();
  const original=f.credentials.get('site_b');f.upgradeLocal(localPin);
  const epochBefore=local.route('site').reconnect_epoch;
  assert.equal((await pair.verifyHealth()).health,'healthy');
  assert.equal(local.route('site').reconnect_epoch,epochBefore);
  assert.equal(f.credentials.get('site_b').manifest_sha256,oldPin.manifest_sha256);
  const target=()=>pairedSiteTarget(siteId,{credentials:f.credentials,localStore:local,installationId,templatePin:f.templatePin});
  assert.equal(target().template_current,true);
  const http=new BSiteHttpTransport({installationId,credentials:f.credentials,localStore:local,templatePin:f.templatePin,resolveDeployment:target,autoPoll:false});
  assert.doesNotThrow(()=>http.assertTemplate(original));
  f.transport.healthWithBearer=f.transport.health;
  assert.equal((await pair.importGrant({...body,service_credential:'n'.repeat(48)},{nativeUI:true})).phase,'credential_updated');
  assert.equal(f.credentials.get('site_b').binding_id,original.binding_id);
  http.fetchImpl=async(url,init)=>{const response=new Response(JSON.stringify(await f.transport.health(JSON.parse(init.body))),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;};
  http.running=true;http.epoch++;
  assert.equal((await http.healthNow(f.credentials.get('site_b'),http.epoch)).manifest_sha256,oldPin.manifest_sha256);
  const compatibleEpoch=local.route('site').reconnect_epoch;
  f.upgradeRemote();assert.equal((await pair.verifyHealth()).health,'healthy');
  const upgraded=f.credentials.get('site_b');assert.equal(upgraded.manifest_sha256,localPin.manifest_sha256);
  assert.ok(local.route('site').reconnect_epoch>compatibleEpoch,'manifest promotion invalidates previous host proof');
  assert.equal((await http.healthNow(upgraded,http.epoch)).manifest_sha256,localPin.manifest_sha256);
  for(const key of ['site_id','site_origin','binding_id','generation','owner_subject','site_public_key','device_credential','private_pkcs8'])assert.equal(upgraded[key],original[key],key);
  assert.equal(target().template_current,true);assert.doesNotThrow(()=>http.assertTemplate(upgraded));
  assert.throws(()=>http.assertTemplate({...upgraded,manifest_sha256:'f'.repeat(64)}),{code:'B_TEMPLATE_MISMATCH'});
  f.upgradeLocal({...localPin,manifest_sha256:'f'.repeat(64),trusted_templates:[]});
  await assert.rejects(pair.verifyHealth(),{code:'B_TEMPLATE_MISMATCH'});
  assert.equal(f.credentials.get('site_b').manifest_sha256,localPin.manifest_sha256);assert.deepEqual(f.counts(),{begins:1,completes:1});
 }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('1060 new local manifest pairs exactly and old pending receipt survives App source addition',async()=>{
 const localPin=readPinnedSiteTemplate(),oldPin=localPin.trusted_templates[0];
 for(const initial of [localPin,oldPin]){
  const f=fixture({lostResponses:2,localPin:initial,initialRemotePin:initial});let local=f.store();
  try{
   local.ensureIntent(f.credentials);const first=f.pairing(local);await first.importGrant(body,{nativeUI:true});
   await assert.rejects(first.pairV2(),{code:'B_SITE_REQUEST_TIMEOUT'});local.close();
   f.upgradeLocal(localPin);local=f.store();const resumed=f.pairing(local);assert.equal(resumed.restoreV2Recovery(),true);
   assert.equal((await resumed.pairV2()).health,'healthy');assert.equal(f.credentials.get('site_b').manifest_sha256,initial.manifest_sha256);
   assert.deepEqual(f.counts(),{begins:1,completes:3});
  }finally{local.close();fs.rmSync(f.root,{recursive:true,force:true});}
 }
});
