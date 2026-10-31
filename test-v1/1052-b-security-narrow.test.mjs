// ONE1052 B-only affected security regressions. Synthetic temp DBs/owners/keys.
// No production Keychain, runtime, A connection, deployed Site or real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop,needsInterface} from '../app/server.mjs';
import {CredentialStore} from '../app/credentials.mjs';
import {BSiteLocalStore} from '../app/v1/b-site-store.mjs';
import {BSitePairing} from '../app/v1/b-site-pairing.mjs';
import {BSiteDispatch} from '../app/v1/b-site-dispatch.mjs';
import {PAIR_DOMAIN,PAIR_FIELDS,encodeUrl64,decodeUrl64,siteOrigin,keyId,rawPublicFromKey,rawPublicFromKey as pubKey,sha256,
 pairingBytes,pairingDigest,edSign,edVerify,webEdVerify,webEdSign,canonicalArguments,strictCanonicalArguments,verifiedSiteJob} from '../app/v1/b-site-wire.mjs';
import {TOOLS} from '../app/tools.mjs';
import {manifest} from '../app/product.mjs';

const INS='11111111-1111-4111-8111-111111111111',PAIR='22222222-2222-4222-8222-222222222222',
 BIND='33333333-3333-4333-8333-333333333333',SITE='site_fixture_1052',OWNER='owner_fixture_1052';
const FIXTIME=1_800_000_100_000;
const id=()=>crypto.randomUUID();
const check=(error,code)=>error?.code===code;
const createSandbox=t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1052-b-isolated-'))),stateDir=path.join(root,'state');
 fs.mkdirSync(stateDir,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,stateDir};
};
function localFixture(t,{existingA=true,now=()=>FIXTIME}={}){
 const {root,stateDir}=createSandbox(t),key=crypto.randomBytes(32);
 const opts={stateDir,installationId:INS,existingA,now,resultKey:()=>key};
 const db=new BSiteLocalStore(opts);t.after(()=>db.close());
 return {db,opts,key,root,stateDir};
}
const sourceWork=(op=id(),extra={})=>({op_id:op,route:'site',principal:'site:'+OWNER,binding_id:BIND,generation:1,
 tool_name:'read_file',request_digest:'a'.repeat(64),created_at:FIXTIME-1000,start_before:FIXTIME+30000,...extra});
function bothHealthy(db){
 db.configureOpenAI({verified:true});
 db.health('openai',{state:'healthy',verified:true,nonceEcho:true,generation:0});
 db.configureSite({site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1},{authenticated:true});
 db.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
}
test('RFC 8032 public fixed signature and fixed-order claim bytes; WebCrypto and Node sign/verify match',async()=>{
 // Public RFC 8032 test vector only; no production or static secret key.
 const pub=Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a','hex');
 const sig='e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
 assert.equal(edVerify(pub,Buffer.alloc(0),encodeUrl64(Buffer.from(sig,'hex'))),true);
 assert.equal(await webEdVerify(pub,Buffer.alloc(0),encodeUrl64(Buffer.from(sig,'hex'))),true);
 assert.equal(edVerify(pub,Buffer.from('change'),encodeUrl64(Buffer.from(sig,'hex'))),false);
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519'),raw=pubKey(publicKey);
 const claim={protocol_version:'1',site_id:SITE,site_origin:'https://site-b.example',owner_subject:OWNER,installation_id:INS,
  device_public_key_id:keyId(raw),pairing_id:PAIR,client_nonce:encodeUrl64(Buffer.alloc(32,1)),
  server_nonce:encodeUrl64(Buffer.alloc(32,2)),issued_at:'1800000000',expires_at:'1800000300'};
 const bytes=pairingBytes(claim,{now:1800000100});
 assert.equal(bytes.toString(),JSON.stringify([PAIR_DOMAIN,...PAIR_FIELDS.map(k=>claim[k])]));
 assert.equal(pairingDigest(claim),sha256(bytes));
 const mac=edSign(privateKey,bytes),worker=await webEdSign(privateKey.export({format:'der',type:'pkcs8'}),bytes);
 assert.equal(mac,worker,'Ed25519 must be deterministic for the same key and claim');
 assert.equal(await webEdVerify(raw,bytes,mac),true);assert.equal(edVerify(raw,bytes,worker),true);
 assert.equal(edVerify(raw,Buffer.concat([bytes,Buffer.from('x')]),mac),false);
 assert.equal(decodeUrl64(encodeUrl64(raw),32).toString('hex'),raw.toString('hex'));
 for(const invalid of [mac+'=',mac.slice(1),mac+'*'])assert.throws(()=>decodeUrl64(invalid,64));
 assert.throws(()=>pairingBytes({...claim,site_origin:'http://site-b.example'}),{code:'B_ORIGIN_INVALID'});
 assert.throws(()=>pairingBytes({...claim,issued_at:'1800000000',expires_at:'1800000001'},{now:1800000090}),{code:'B_CHALLENGE_EXPIRED'});
 assert.throws(()=>pairingBytes({...claim,unexpected:'x'}),{code:'B_WIRE_INVALID'});
 assert.equal(strictCanonicalArguments(canonicalArguments({z:2,a:{x:1}}).toString()).digest,sha256(canonicalArguments({a:{x:1},z:2})));
 assert.throws(()=>strictCanonicalArguments('{"z":1,"z":2}'),{code:'B_ARGS_NOT_CANONICAL'});
});

test('Mac SQLite selected and admit are atomic; only confirmed A failure + authenticated healthy B switches once',async t=>{
 const {db}=localFixture(t);bothHealthy(db);
 const w=sourceWork();assert.equal(db.selection().selected,'openai');
 assert.throws(()=>db.admit(w,{authenticated:true}),e=>check(e,'B_ROUTE_NOT_SELECTED'));
 db.health('openai',{state:'reconnecting',verified:true,generation:0});
 assert.throws(()=>db.admit(w,{authenticated:true}),e=>check(e,'B_ROUTE_NOT_SELECTED'));
 db.health('openai',{state:'failed',verified:true,generation:0});
 assert.throws(()=>db.admit(w,{authenticated:false}),e=>check(e,'B_WORK_UNVERIFIED'));
 const first=db.admit(w,{authenticated:true});
 assert.equal(first.replayed,false);assert.equal(first.switch_event.event_id.length,36);
 assert.equal(db.selection().selected,'site');
 const second=db.admit(w,{authenticated:true});assert.equal(second.replayed,true);assert.equal(db.switchEvents().length,1);
 const w2=sourceWork();const w3=sourceWork();
 const attempts=[db.admit(w2,{authenticated:true}),db.admit(w3,{authenticated:true})];
 assert.equal(attempts.every(x=>x.state==='admitted'),true);
 assert.equal(db.switchEvents().length,1,'simultaneous backups yield only one switch');
 assert.throws(()=>db.admit({...w,request_digest:'b'.repeat(64)},{authenticated:true}),e=>check(e,'B_OPERATION_CONFLICT'));
 assert.throws(()=>db.admit({...w,principal:'site:other'},{authenticated:true}),e=>check(e,'B_OPERATION_CONFLICT'));
 db.health('openai',{state:'healthy',verified:true,nonceEcho:true,generation:0});
 assert.equal(db.selection().selected,'site','restored old route must not auto-switch back');
 assert.equal(db.start(w.op_id,w).execute,true);
});

test('Mac executing crash is uncertain, ACK and encrypted result never rerun after restart',async t=>{
 const {db,opts}=localFixture(t,{existingA:false});
 db.configureSite({site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1},{authenticated:true});
 db.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
 db.switchUser('site',{windowGesture:true}); // This case executes on an explicitly selected configured Site.
 const w=sourceWork();
 db.admit(w,{authenticated:true});assert.equal(db.start(w.op_id,w).execute,true);
 db.close();
 const reopened=new BSiteLocalStore(opts);t.after(()=>reopened.close());
 assert.equal(reopened.status(w.op_id,w).state,'uncertain');
 const reused=reopened.admit(w,{authenticated:true});assert.equal(reused.replayed,true);
 assert.equal(reopened.start(w.op_id,w).execute,false);
 reopened.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
 const next=sourceWork();reopened.admit(next,{authenticated:true});
 assert.equal(reopened.start(next.op_id,next).execute,true);
 const done=reopened.complete(next.op_id,next,{ok:true,raw:'synthetic-secret-not-plaintext'});
 assert.equal(done.state,'completed');
 assert.equal(reopened.status(next.op_id,next,{includeResult:true}).result.raw,'synthetic-secret-not-plaintext');
 assert.equal(reopened.db.prepare('SELECT result_box FROM b_operations WHERE op_id=?').get(next.op_id).result_box.includes('synthetic-secret-not-plaintext'),false);
 const ackId=id();assert.equal(reopened.ack(next.op_id,next,{ack_id:ackId,result_digest:done.result_digest}).replayed,false);
 assert.equal(reopened.ack(next.op_id,next,{ack_id:ackId,result_digest:done.result_digest}).replayed,true);
 assert.throws(()=>reopened.ack(next.op_id,next,{ack_id:id(),result_digest:done.result_digest}),e=>check(e,'B_ACK_CONFLICT'));
 assert.throws(()=>reopened.status(next.op_id,{...next,principal:'site:unknown'}),e=>check(e,'B_OPERATION_CONFLICT'));
});

test('Site B private credential section and signed pairing claim preserve synthetic A section; import requires trusted release target',async t=>{
 const {stateDir}=createSandbox(t);let adapterCalls=0;
 const adapter={get(){adapterCalls++;},set(){adapterCalls++;},remove(){adapterCalls++;}};
 assert.throws(()=>new CredentialStore(stateDir,{adapter}),e=>check(e,'CREDENTIAL_BACKEND_UNSUPPORTED'));
 assert.equal(adapterCalls,0,'retired credential adapters are never invoked');
 const credentials=new CredentialStore(stateDir,{adapter:null}),{publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 credentials.set('tunnel',{synthetic_marker:'A-unchanged'});
 credentials.set('relay',{synthetic_marker:'R-unchanged'});
 const raw=rawPublicFromKey(publicKey),local=new BSiteLocalStore({stateDir,installationId:INS,existingA:true,now:()=>FIXTIME,resultKey:()=>crypto.randomBytes(32)});
 t.after(()=>local.close());let grantCount=0;
 const transport={
  async begin(req){assert.ok(req.enrollment_grant.length>35);grantCount++;
   const claim={protocol_version:'1',site_id:SITE,site_origin:'https://site-b.example',owner_subject:OWNER,installation_id:INS,
    device_public_key_id:req.public_key_id,pairing_id:PAIR,client_nonce:req.client_nonce,
    server_nonce:encodeUrl64(Buffer.alloc(32,9)),issued_at:String(Math.floor(FIXTIME/1000)-10),expires_at:String(Math.floor(FIXTIME/1000)+200)};
   this.claim=claim;this.public=decodeUrl64(req.public_key,32);
   return {claim,site_signature:edSign(privateKey,pairingBytes(claim))};
  },
  async complete(req){
   assert.equal(req.claim_digest,pairingDigest(this.claim));
   assert.equal(edVerify(this.public,pairingBytes(this.claim),req.device_signature),true);
   const receipt_digest='a'.repeat(64),generation=1;
   const signed=Buffer.from(JSON.stringify(['chathand-site-pair-receipt-v1',req.claim_digest,BIND,String(generation),receipt_digest,OWNER,SITE,INS]));
   return {site_id:SITE,owner_subject:OWNER,installation_id:INS,pairing_id:PAIR,binding_id:BIND,generation,
    device_credential:encodeUrl64(crypto.randomBytes(48)),receipt_digest,site_signature:edSign(privateKey,signed)};
  },
  async health(req){const signed=Buffer.from(JSON.stringify(['chathand-site-health-ack-v1',SITE,BIND,'1',INS,req.nonce]));
   return {site_id:SITE,binding_id:BIND,installation_id:INS,generation:1,nonce:req.nonce,signature:edSign(privateKey,signed)};
  }
 };
 const resolveDeployment=async site_id=>({verified:true,site_id,site_origin:'https://site-b.example',owner_subject:OWNER,site_public_key:encodeUrl64(raw)});
 const pairing=new BSitePairing({installationId:INS,credentials,localStore:local,resolveDeployment,transport,now:()=>FIXTIME});
 await assert.rejects(pairing.importGrant({site_id:SITE,site_origin:'https://site-b.example',enrollment_grant:encodeUrl64(crypto.randomBytes(48))},{}),e=>check(e,'B_PAIRING_INPUT'));
 const granted=await pairing.importGrant({site_id:SITE,site_origin:'https://site-b.example',enrollment_grant:encodeUrl64(crypto.randomBytes(48))},{nativeUI:true});
 assert.equal(granted.connected,false);assert.equal(granted.phase,'awaiting_pairing');
 assert.equal(pairing.snapshot().phase,'pairing');
 assert.equal(credentials.get('site_b'),null,'unconsumed grant remains volatile');
 const p=await pairing.pair();assert.equal(p.paired,true);assert.equal(p.health,'healthy');
 assert.equal(grantCount,1);assert.equal(pairing.pending,null);
 assert.deepEqual(credentials.get('tunnel'),{synthetic_marker:'A-unchanged'});
 assert.deepEqual(credentials.get('relay'),{synthetic_marker:'R-unchanged'});
 assert.equal(credentials.status().site_b,true);assert.equal(local.snapshot().selected,'openai');
 assert.equal(local.snapshot().routes.site.health_fresh,true);
 assert.equal(Object.hasOwn(credentials.get('site_b'),'enrollment_grant'),false);
 assert.equal(JSON.stringify(pairing.snapshot()).includes('private_pkcs8'),false);
});

test('isolated native owner+UI-key gates B import/select and untrusted origin; no host/Site success is claimed',async t=>{
 const {root,stateDir}=createSandbox(t),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey:'cd'.repeat(32),nativeOwnerKey:'ef'.repeat(32),clientDeps:{
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic B',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1050,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>app.close());
 const rootUrl='http://127.0.0.1:'+app.apiPort,auth={authorization:'Bearer '+app.adminToken,'content-type':'application/json'};
 const post=async(route,body={},ui=false,owner=true,origin=`http://127.0.0.1:${app.apiPort}`)=>{
  const headers={...auth,...(ui?{'x-chathand-ui':'cd'.repeat(32)}:{}),...(origin?{origin}:{})};if(!owner)delete headers.authorization;
  const response=await fetch(rootUrl+route,{method:'POST',headers,body:JSON.stringify(body)});
  return {status:response.status,json:await response.json()};
 };
 for(const route of ['/api/site-b/enrollment/import','/api/site-b/pair','/api/site-b/verify','/api/site-b/select']){
  assert.equal(needsInterface(route,{}),false,route+' uses the loopback owner gate');
  assert.equal((await post(route,{},true,false)).status,401,'a UI key alone is not owner authorization');
  assert.equal((await post(route,{},false,true,'https://evil.example')).status,403,'cross-origin owner requests remain rejected');
 }
 const dismiss='/api/site-b/paired-notice/dismiss';assert.equal(needsInterface(dismiss,{}),true);
 assert.equal((await post(dismiss,{notice_id:'fixture'},false,true)).status,403,'true UI-only operations still require native window proof');
 assert.equal((await post(dismiss,{notice_id:'fixture'},true,false)).status,401,'UI-only operations also require the loopback owner');
 const stage=await post('/api/site-b/enrollment/import',{site_id:SITE,site_origin:'https://site-b.example',enrollment_grant:encodeUrl64(crypto.randomBytes(48))},true);
 assert.notEqual(stage.status,200);assert.equal(stage.json.error.code,'B_SITE_TARGET_UNVERIFIED');
 const select=await post('/api/site-b/select',{route:'openai'},true);assert.notEqual(select.status,200);
 const q=app.tools.bSiteLocalStore.snapshot();assert.equal(q.selected,'openai');assert.equal(q.routes.site.configured,false);
 assert.equal(app.tools.bSitePairing.pending,null);
 assert.equal(app.tools.bSiteLocalStore.switchEvents().length,0);
 app.tools.bSiteLocalStore.configureSite({site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1},{authenticated:true});
 app.tools.bSiteLocalStore.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
 app.tools.bSiteLocalStore.switchUser('site',{windowGesture:true});
 const rpcRefusal=await app.tools.rpc({jsonrpc:'2.0',id:'route-test',method:'tools/call',params:{name:'bridge_info',arguments:{}}},'chatgpt',{transport:'local_http',setupPrincipal:'tunnel:chatgpt'});
 const refusal=rpcRefusal.result.structuredContent;
 assert.equal(refusal.executed,false);assert.equal(refusal.error_code,'ROUTE_NOT_SELECTED');
 assert.equal(refusal.can_execute,false);assert.equal(JSON.stringify(refusal).includes(work),false);
 assert.equal(TOOLS.some(tool=>tool.name==='matter_write'),true);
 const current=manifest(TOOLS);assert.equal(current.tool_count,TOOLS.length);assert.equal(current.connector_api,31);
 const source=fs.readFileSync(new URL('../app/server.mjs',import.meta.url),'utf8');
 assert.match(source,/host_binding:null/);
 assert.doesNotMatch(fs.readFileSync(new URL('../app/v1/tools-refresh.mjs',import.meta.url),'utf8'),/expected\?\.tool_count===78/);
 assert.equal(app.tools.bSiteDispatch!==null,true); // Internal only; no unverified public HTTP ingress.
});
