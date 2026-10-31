import {t as displayText} from '../i18n.mjs';
/** 1052 B local authority: installed-state-scoped selected/health/op ledger.
 * The SQLite commit (not desktop.json) is the only authority. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonicalize} from 'json-canonicalize';
import {fail} from '../../engine/src/core.mjs';
const ERROR=(code,text='B Site 状态、认证或事务未通过。')=>fail(code,text);
const ROUTES=new Set(['openai','site']);
const SETUP_PROBES=new Set(['connection_check','setup_write_probe']);
const STATES=new Set(['unconfigured','pairing','healthy','reconnecting','failed','auth_required']);
const OP=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const int=n=>Number.isSafeInteger(n)&&n>=0;
const SHA=/^[a-f0-9]{64}$/;
// Local canonical plaintext matches the Worker result budget, separately from base64 boxes.
const RESULT_PLAIN_MAX=65536, RESULT_IV_BYTES=12, RESULT_TAG_BYTES=16, RESULT_BOX_MAX_BYTES=88000;
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const validateFile=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>64*1024*1024)ERROR('B_STORE_UNSAFE');return st;};
const VALID_TERMINAL=new Set(['completed','failed','rejected','cancelled','uncertain']);
const RESULT_QUARANTINE_REASONS=new Set(['B_RESULT_UNAVAILABLE','B_RESULT_WIRE_BUDGET_EXCEEDED','B_REMOTE_RESULT_TOO_LARGE']);
function safeKey(key){if(!Buffer.isBuffer(key)||key.length!==32)ERROR('B_RESULT_KEY_REQUIRED');return key;}
function encryptResult(key,installation,op,serialized){
 const iv=crypto.randomBytes(12),enc=crypto.createCipheriv('aes-256-gcm',safeKey(key),iv);
 enc.setAAD(Buffer.from(JSON.stringify(['b-site-result-v1',installation,op])));
 const ciphertext=Buffer.concat([enc.update(serialized),enc.final()]);
 return JSON.stringify({iv:iv.toString('base64url'),tag:enc.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')});
}
function resultPart(value,maxBytes,exactBytes=null){
 if(typeof value!=='string'||!(/^[A-Za-z0-9_-]+$/.test(value))||value.length>4*Math.ceil(maxBytes/3))
  throw Error('invalid result box part');
 const raw=Buffer.from(value,'base64url');
 if(raw.length>maxBytes||exactBytes!==null&&raw.length!==exactBytes||raw.toString('base64url')!==value)
  throw Error('invalid result box length');
 return raw;
}
function decryptResult(key,installation,op,box){
 const secret=safeKey(key);
 try{
  if(typeof box!=='string'||Buffer.byteLength(box,'utf8')>RESULT_BOX_MAX_BYTES)
   throw Error('invalid stored result');
  const value=JSON.parse(box);
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).sort().join(',')!=='ciphertext,iv,tag')throw Error('invalid stored result');
  const iv=resultPart(value.iv,RESULT_IV_BYTES,RESULT_IV_BYTES);
  const tag=resultPart(value.tag,RESULT_TAG_BYTES,RESULT_TAG_BYTES);
  const ciphertext=resultPart(value.ciphertext,RESULT_PLAIN_MAX);
  const dec=crypto.createDecipheriv('aes-256-gcm',secret,iv);
  dec.setAAD(Buffer.from(JSON.stringify(['b-site-result-v1',installation,op])));
  dec.setAuthTag(tag);
  const plain=Buffer.concat([dec.update(ciphertext),dec.final()]);
  if(plain.length>RESULT_PLAIN_MAX)throw Error('invalid result plaintext length');
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('invalid result JSON');
  return result;
 }catch{
  // Preserve the terminal op/result box. Never expose ciphertext or retry work.
  ERROR('B_RESULT_UNAVAILABLE');
 }
}
export class BSiteLocalStore{
 #replacementWriterClaimed=false;
 #hostProofToken=Symbol('B_HOST_PROOF_PRIVATE_WRITER');
 #hostProofWriterClaimed=false;
 #hostProofValid=false; // In-process fence: a failed SQLite invalidation cannot revive F15.
 constructor({stateDir,installationId,existingA=false,now=Date.now,resultKey=()=>null,onAuthorityChanged=()=>{}}={}){
  if(typeof stateDir!=='string'||!path.isAbsolute(stateDir)||!OP.test(installationId)||typeof resultKey!=='function'||typeof onAuthorityChanged!=='function')
   ERROR('B_STORE_CONFIG');
  const st=fs.lstatSync(stateDir);if(!st.isDirectory()||st.isSymbolicLink())ERROR('B_STORE_UNSAFE');
  this.root=fs.realpathSync(stateDir);this.installationId=installationId;this.now=now;this.resultKey=resultKey;this.onAuthorityChanged=onAuthorityChanged;
  this.file=path.join(this.root,'site-b-1052.sqlite');this.closed=false;
  if(fs.existsSync(this.file))validateFile(this.file);
  this.db=new DatabaseSync(this.file,{timeout:5000});
  try{
   fs.chmodSync(this.file,0o600);validateFile(this.file);
   this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
   this.db.exec(`
    CREATE TABLE IF NOT EXISTS b_selection(
      id INTEGER PRIMARY KEY CHECK(id=1), installation TEXT NOT NULL,
      selected TEXT NOT NULL CHECK(selected IN ('openai','site')), revision INTEGER NOT NULL, instance TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS b_routes(
      route TEXT PRIMARY KEY CHECK(route IN ('openai','site')),configured INTEGER NOT NULL CHECK(configured IN (0,1)),
      state TEXT NOT NULL, generation INTEGER NOT NULL, binding_id TEXT,site_id TEXT,owner_subject TEXT,
      reconnect_epoch INTEGER NOT NULL,health_revision INTEGER NOT NULL,last_verified INTEGER NOT NULL,reason TEXT);
    CREATE TABLE IF NOT EXISTS b_switch_events(
      event_id TEXT PRIMARY KEY,from_route TEXT NOT NULL,to_route TEXT NOT NULL,
      revision INTEGER NOT NULL UNIQUE, reason TEXT NOT NULL, at INTEGER NOT NULL);
    -- Only an observed, authenticated auto-switch can create a notice. The event
    -- and its exact installation / Site binding are committed atomically.
    CREATE TABLE IF NOT EXISTS b_switch_notice_delivery(
      event_id TEXT PRIMARY KEY REFERENCES b_switch_events(event_id),
      installation_id TEXT NOT NULL,site_id TEXT NOT NULL,owner_subject TEXT NOT NULL,
      binding_id TEXT NOT NULL,generation INTEGER NOT NULL,selection_revision INTEGER NOT NULL,
      attached_op_id TEXT UNIQUE,base_digest TEXT,
      UNIQUE(installation_id,selection_revision),
      CHECK((attached_op_id IS NULL AND base_digest IS NULL) OR
            (attached_op_id IS NOT NULL AND base_digest IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS b_operations(
      op_id TEXT PRIMARY KEY, route TEXT NOT NULL, principal TEXT NOT NULL,binding_id TEXT,
      generation INTEGER NOT NULL,tool TEXT NOT NULL, request_digest TEXT NOT NULL,
      selection_revision INTEGER NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL,start_before INTEGER NOT NULL,executor TEXT,
      result_digest TEXT, result_box TEXT, ack_id TEXT, ack_digest TEXT, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS b_ops_route ON b_operations(route,state);
    -- Local delivery isolation is not a business result, ACK, or a retry.
    -- Keep the original encrypted box and signed result digest untouched.
    CREATE TABLE IF NOT EXISTS b_result_delivery_quarantine(
      op_id TEXT PRIMARY KEY REFERENCES b_operations(op_id),
      installation_id TEXT NOT NULL,
      route TEXT NOT NULL CHECK(route='site'),
      principal TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64),
      reason TEXT NOT NULL CHECK(reason IN
       ('B_RESULT_UNAVAILABLE','B_RESULT_WIRE_BUDGET_EXCEEDED','B_REMOTE_RESULT_TOO_LARGE')),
      quarantined_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS b_result_quarantine_scope
      ON b_result_delivery_quarantine(installation_id,binding_id,generation);
    CREATE TABLE IF NOT EXISTS b_revocations(
      binding_id TEXT NOT NULL,generation INTEGER NOT NULL,installation_id TEXT NOT NULL,
      local_revoked_at INTEGER NOT NULL,remote_state TEXT NOT NULL CHECK(remote_state IN ('pending','confirmed')),
      remote_ack_at INTEGER,PRIMARY KEY(binding_id,generation));
    CREATE TABLE IF NOT EXISTS b_pair_intents(
      intent_id TEXT PRIMARY KEY,pairing_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
    -- Setup failure survives service restart. Never persist conflict material,
    -- authorization grants, exception messages or user answers in this row.
    CREATE TABLE IF NOT EXISTS b_pair_failure(
      id INTEGER PRIMARY KEY CHECK(id=1),error_code TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS b_pair_recovery(
      id INTEGER PRIMARY KEY CHECK(id=1),pairing_id TEXT NOT NULL UNIQUE,
      intent_id TEXT NOT NULL,claim_digest TEXT NOT NULL CHECK(length(claim_digest)=64),
      site_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS b_site_commit(
      id INTEGER PRIMARY KEY CHECK(id=1),phase TEXT NOT NULL CHECK(phase IN ('PREPARED','COMMITTED')),
      intent_id TEXT NOT NULL,site_id TEXT NOT NULL,owner_subject TEXT NOT NULL,
      binding_id TEXT NOT NULL,generation INTEGER NOT NULL,created_at INTEGER NOT NULL,
      previous_binding TEXT,previous_generation INTEGER NOT NULL,previous_configured INTEGER NOT NULL,
      selection_revision INTEGER NOT NULL);
    -- A local forget decision outranks credential promotion after restart.
    -- Scope contains only binding/intent IDs and public identity metadata.
    CREATE TABLE IF NOT EXISTS b_site_forget(
      id INTEGER PRIMARY KEY CHECK(id=1),installation TEXT NOT NULL,
      binding_id TEXT,generation INTEGER NOT NULL,scope_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS b_binding_highwater(
      site_id TEXT NOT NULL,site_public_key TEXT NOT NULL,generation INTEGER NOT NULL,
      PRIMARY KEY(site_id,site_public_key));
    CREATE TABLE IF NOT EXISTS b_pair_notice(
      notice_id TEXT PRIMARY KEY,site_id TEXT NOT NULL,site_origin TEXT NOT NULL,
      binding_id TEXT NOT NULL,generation INTEGER NOT NULL,paired_at INTEGER NOT NULL,dismissed_at INTEGER);
    CREATE TABLE IF NOT EXISTS b_binding_replaced(
      id INTEGER PRIMARY KEY CHECK(id=1),site_id TEXT NOT NULL,binding_id TEXT NOT NULL,
      generation INTEGER NOT NULL,device_name TEXT,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS b_host_receipts(
      id INTEGER PRIMARY KEY CHECK(id=1),installation_id TEXT NOT NULL,site_id TEXT NOT NULL,
      owner_subject TEXT NOT NULL,binding_id TEXT NOT NULL,generation INTEGER NOT NULL,
      batch_id TEXT NOT NULL,session_tag TEXT NOT NULL,nonce_digest TEXT NOT NULL,
      selection_revision INTEGER NOT NULL,reconnect_epoch INTEGER NOT NULL,
      read_ok INTEGER NOT NULL,write_capability_ok INTEGER NOT NULL,app_flow_verified INTEGER NOT NULL,
      issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   `);
   this.instance=crypto.randomUUID();
   this.tx(()=>{
    const x=this.db.prepare('SELECT * FROM b_selection WHERE id=1').get();
    // C1-1: before any route is configured, A is the initial entry. Keep an
    // existing installation's explicit selection; choosing a route grants no health.
    if(!x)this.db.prepare('INSERT INTO b_selection(id,installation,selected,revision,instance) VALUES(1,?,?,0,?)').run(installationId,'openai',this.instance);
    else if(x.installation!==installationId)ERROR('B_INSTALLATION_CHANGED');
    else this.db.prepare('UPDATE b_selection SET instance=? WHERE id=1').run(this.instance);
    for(const route of ROUTES)this.db.prepare('INSERT OR IGNORE INTO b_routes(route,configured,state,generation,reconnect_epoch,health_revision,last_verified) VALUES(?,?,?,?,0,0,0)')
      .run(route,route==='openai'&&existingA?1:0,route==='openai'&&existingA?'reconnecting':'unconfigured',0);
    // A killed service can never infer whether its executing side effect happened.
    this.db.exec("UPDATE b_operations SET state='uncertain', executor=NULL WHERE state='executing'");
    // A restart destroys any prior ChatGPT-app session proof, even if credentials persist.
    this.db.exec('DELETE FROM b_host_receipts');
    // Startup drops stale health assertions; credential generation and selected persist.
    this.db.exec("UPDATE b_routes SET state='reconnecting',last_verified=0,health_revision=health_revision+1 WHERE state='healthy' AND configured=1");
   });
  }catch(e){this.close();throw e;}
 }
 tx(fn){
  if(this.closed)ERROR('B_STORE_CLOSED');this.db.exec('BEGIN IMMEDIATE');
  try{const result=fn();if(result&&typeof result.then==='function')ERROR('B_ASYNC_TRANSACTION');
   this.db.exec('COMMIT');return result;}catch(e){try{this.db.exec('ROLLBACK')}catch{}throw e;}
 }
 notifyAuthority(){
  try{this.onAuthorityChanged();}catch{ERROR('B_AUTHORITY_SYNC_UNCONFIRMED');}
 }
 authorityTx(fn){
  const result=this.tx(fn);
  if(result?.changed!==false&&result?.replayed!==true)this.notifyAuthority();
  return result;
 }
 selection(){return this.db.prepare('SELECT installation,selected,revision FROM b_selection WHERE id=1').get();}
 route(name){if(!ROUTES.has(name))ERROR('B_ROUTE_INVALID');return this.db.prepare('SELECT * FROM b_routes WHERE route=?').get(name);}
 snapshot(){
  const s=this.selection(),routes={};
  for(const r of ROUTES){const x=this.route(r);routes[r]={configured:x.configured===1,state:x.state,generation:x.generation,health_fresh:x.state==='healthy'&&this.now()-x.last_verified<30000,
   reconnect_epoch:x.reconnect_epoch,revision:x.health_revision,site_id:r==='site'?x.site_id:null,reason:x.reason||null};}
  const host=this.currentHostReceipt();
  return {selected:s.selected,revision:s.revision,routes,installation_bound:true,storage:'transactional',
   host_attestation:host?'verified_current_installation':'not_verified'};
 }
 bindingReplaced(){
  const row=this.db.prepare('SELECT * FROM b_binding_replaced WHERE id=1').get(),route=this.route('site');
  return row&&row.site_id===route.site_id&&row.binding_id===route.binding_id&&row.generation===route.generation?{device_name:row.device_name||null,at:row.at}:null;
 }
 issueBindingReplacementWriter(){
  if(this.#replacementWriterClaimed)ERROR('B_REPLACEMENT_WRITER_CLAIMED');this.#replacementWriterClaimed=true;
  return notice=>this.authorityTx(()=>{
   const route=this.route('site');
   if(notice?.site_id!==route.site_id||notice.owner_subject!==route.owner_subject||notice.installation_id!==this.installationId||notice.binding_id!==route.binding_id||notice.generation!==route.generation||!Number.isSafeInteger(notice.at)||notice.at<=0||!(notice.device_name===null||typeof notice.device_name==='string'&&notice.device_name.length<=80))ERROR('B_REPLACEMENT_SCOPE_CHANGED');
   this.db.prepare('INSERT INTO b_binding_replaced(id,site_id,binding_id,generation,device_name,at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET site_id=excluded.site_id,binding_id=excluded.binding_id,generation=excluded.generation,device_name=excluded.device_name,at=excluded.at').run(route.site_id,route.binding_id,route.generation,notice.device_name,notice.at);
   this.db.prepare("UPDATE b_routes SET state='auth_required',last_verified=0,health_revision=health_revision+1,reconnect_epoch=reconnect_epoch+1,reason='B_BINDING_REPLACED' WHERE route='site'").run();
   this.db.prepare('DELETE FROM b_host_receipts').run();
   return this.bindingReplaced();
  });
 }
 pairingFailure(){
  const row=this.db.prepare('SELECT error_code,updated_at FROM b_pair_failure WHERE id=1').get();
  return row?{code:row.error_code,at:row.updated_at}:null;
 }
 setPairingFailure(value){
  if(value!==null&&(!value||!/^B_[A-Z0-9_]{1,60}$/.test(value.code||'')||!int(value.at)))ERROR('B_PAIR_FAILURE_INVALID');
  this.tx(()=>{
   if(value===null)this.db.prepare('DELETE FROM b_pair_failure WHERE id=1').run();
   else this.db.prepare('INSERT INTO b_pair_failure(id,error_code,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET error_code=excluded.error_code,updated_at=excluded.updated_at').run(value.code,value.at);
  });
 }
 siteCommit(){return this.db.prepare('SELECT * FROM b_site_commit WHERE id=1').get()||null;}
 siteForget(){return this.db.prepare('SELECT * FROM b_site_forget WHERE id=1').get()||null;}
 assertNoSiteForget(){if(this.siteForget())ERROR('B_SITE_FORGET_PENDING');}
 forgetCredentialScope(all,route,commit,recovery){
  const same=(saved,b)=>saved?.installation_id===this.installationId&&saved.binding_id===b.binding_id&&saved.generation===b.generation&&
   (b.site_id===undefined||saved.site_id===b.site_id)&&(b.owner_subject===undefined||saved.owner_subject===b.owner_subject);
  const current={binding_id:route.binding_id,generation:route.generation,site_id:route.site_id,owner_subject:route.owner_subject};
  const target=commit?{binding_id:commit.binding_id,generation:commit.generation,site_id:commit.site_id,owner_subject:commit.owner_subject}:null;
  const previous=commit?.phase==='COMMITTED'&&commit.previous_binding?{binding_id:commit.previous_binding,generation:commit.previous_generation}:null;
  const active=[current,target,previous].filter(b=>b?.binding_id),stage=[target||current].filter(b=>b.binding_id);
  const identity=saved=>({installation_id:saved.installation_id,site_id:saved.site_id,owner_subject:saved.owner_subject,binding_id:saved.binding_id,generation:saved.generation,site_origin:saved.site_origin});
  for(const [key,allowed] of [['site_b',active],['site_b_stage',stage]])if(all[key]){
   let origin;try{origin=new URL(all[key].site_origin);}catch{ERROR('B_REVOKE_BINDING_CHANGED');}
   if(!allowed.some(b=>same(all[key],b))||origin.protocol!=='https:'||origin.origin!==all[key].site_origin||all[key].site_origin.length>512||
      !/^[a-zA-Z0-9_-]{4,128}$/.test(all[key].site_id||'')||typeof all[key].owner_subject!=='string'||!all[key].owner_subject||all[key].owner_subject.length>160)ERROR('B_REVOKE_BINDING_CHANGED');
  }
  const identities=[all.site_b,all.site_b_stage].filter(Boolean).map(identity);
  const machines=[];
  for(const [key,binding] of [['site_b_machine',all.site_b],['site_b_machine_stage',all.site_b_stage]])if(all[key]){
   if(!binding||all[key].site_id!==binding.site_id||all[key].site_origin!==binding.site_origin)ERROR('B_REVOKE_BINDING_CHANGED');
   machines.push({site_id:binding.site_id,site_origin:binding.site_origin});
  }
  if(recovery&&commit&&(recovery.intent_id!==commit.intent_id||recovery.site_id!==commit.site_id))ERROR('B_REVOKE_BINDING_CHANGED');
  const material=all.site_b_pair_recovery;
  if(material){
   if(!OP.test(material.pairing_id))ERROR('B_REVOKE_BINDING_CHANGED');
   if(recovery?material.pairing_id!==recovery.pairing_id:
      material.claim?.installation_id!==this.installationId||material.previous_binding!==(commit?.previous_binding??route.binding_id)||material.previous_generation!==(commit?.previous_generation??route.generation))ERROR('B_REVOKE_BINDING_CHANGED');
  }
  const saved=all.site_b_intents;
  if(saved!==undefined&&(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).some(k=>!OP.test(k))))ERROR('B_REVOKE_BINDING_CHANGED');
  return {identities,machines,pairing_id:recovery?.pairing_id||material?.pairing_id||null,
   intent_keys_hash:hash(JSON.stringify(Object.keys(saved||{}).sort()))};
 }
 beginSiteForget(credentials,{binding_id,generation,authenticatedNative=false}={}){
  if(authenticatedNative!==true)ERROR('B_NATIVE_REVOKE_REQUIRED');
  return this.authorityTx(()=>{
   const route=this.route('site'),pending=this.siteForget();
   if(pending){
    if(pending.installation!==this.installationId||route.binding_id!==null||route.generation!==0||route.configured!==0||
       !(binding_id===pending.binding_id&&generation===pending.generation||binding_id===null&&generation===0))ERROR('B_REVOKE_BINDING_CHANGED');
    return {prepared:true,replayed:true};
   }
   if(route.binding_id!==binding_id||route.generation!==generation)ERROR('B_REVOKE_BINDING_CHANGED');
   const commit=this.siteCommit(),recovery=this.db.prepare('SELECT * FROM b_pair_recovery WHERE id=1').get();
   if(commit&&(commit.phase==='COMMITTED'?
      commit.binding_id!==route.binding_id||commit.generation!==route.generation||commit.site_id!==route.site_id||commit.owner_subject!==route.owner_subject:
      commit.previous_binding!==route.binding_id||commit.previous_generation!==route.generation))ERROR('B_REVOKE_BINDING_CHANGED');
   const scope=this.forgetCredentialScope(credentials.readAll(),route,commit,recovery);
   this.db.prepare('INSERT INTO b_site_forget(id,installation,binding_id,generation,scope_json,created_at) VALUES(1,?,?,?,?,?)')
    .run(this.installationId,binding_id,generation,JSON.stringify(scope),this.now());
   if(commit)this.db.prepare('DELETE FROM b_site_commit WHERE id=1 AND phase=? AND binding_id=? AND generation=?').run(commit.phase,commit.binding_id,commit.generation);
   if(recovery)this.db.prepare('DELETE FROM b_pair_recovery WHERE id=1 AND pairing_id=?').run(recovery.pairing_id);
   this.db.prepare('UPDATE b_pair_intents SET used_at=? WHERE used_at IS NULL').run(this.now());
   this.forgetRouteInside('site');return {prepared:true};
  });
 }
 recoverSiteForget(credentials){
  const decision=this.siteForget();if(!decision)return {recovered:false};
  const route=this.route('site');
  if(decision.installation!==this.installationId||route.configured!==0||route.binding_id!==null||route.generation!==0)ERROR('B_REVOKE_BINDING_CHANGED');
  const scope=JSON.parse(decision.scope_json),all=credentials.readAll();
  const identity=saved=>scope.identities.some(b=>['installation_id','site_id','owner_subject','binding_id','generation','site_origin'].every(k=>saved?.[k]===b[k]));
  for(const key of ['site_b','site_b_stage'])if(all[key]&&!identity(all[key]))ERROR('B_REVOKE_BINDING_CHANGED');
  for(const key of ['site_b_machine','site_b_machine_stage'])if(all[key]&&!scope.machines.some(b=>all[key].site_id===b.site_id&&all[key].site_origin===b.site_origin))ERROR('B_REVOKE_BINDING_CHANGED');
  if(all.site_b_pair_recovery&&all.site_b_pair_recovery.pairing_id!==scope.pairing_id)ERROR('B_REVOKE_BINDING_CHANGED');
  if(all.site_b_intents&&(!all.site_b_intents||typeof all.site_b_intents!=='object'||Array.isArray(all.site_b_intents)||
     hash(JSON.stringify(Object.keys(all.site_b_intents).sort()))!==scope.intent_keys_hash))ERROR('B_REVOKE_BINDING_CHANGED');
  let changed=false;
  for(const key of ['site_b','site_b_machine','site_b_stage','site_b_machine_stage','site_b_intents','site_b_pair_recovery'])if(Object.hasOwn(all,key)){delete all[key];changed=true;}
  if(changed)credentials.writeAll(all);
  // Do not acknowledge forget before the credential replacement succeeded.
  this.tx(()=>{
   const current=this.siteForget();if(current?.scope_json!==decision.scope_json||current?.installation!==this.installationId)ERROR('B_SITE_FORGET_PENDING');
   this.db.prepare('DELETE FROM b_site_forget WHERE id=1').run();
  });
  return {recovered:true,phase:'forgotten'};
 }
 intentByHash(hash,credentials){
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))return null;
  const row=this.db.prepare('SELECT * FROM b_pair_intents WHERE pairing_hash=? AND used_at IS NULL AND expires_at>?').get(hash,this.now());
  const saved=credentials.readAll()?.site_b_intents;
  const secret=saved&&typeof saved==='object'&&!Array.isArray(saved)?saved[row?.intent_id]:null;
  return row&&typeof secret==='string'&&/^[A-Za-z0-9_-]{43}$/.test(secret)?{...row,secret}:null;
 }
 activeIntent(credentials){
  const saved=credentials.readAll()?.site_b_intents||{};
  for(const row of this.db.prepare('SELECT * FROM b_pair_intents WHERE used_at IS NULL AND expires_at>? ORDER BY created_at DESC').all(this.now())){
   const secret=saved[row.intent_id];
   if(typeof secret==='string'&&/^[A-Za-z0-9_-]{43}$/.test(secret))return {...row,secret};
  }
  return null;
 }
 stagePairRecovery(record,material,credentials){
  this.assertNoSiteForget();
  if(!record||!OP.test(record.pairing_id)||!OP.test(record.intent_id)||
     !SHA.test(record.claim_digest)||typeof record.site_id!=='string'||
     !Number.isSafeInteger(record.expires_at)||record.expires_at<=this.now()||
     !material||material.pairing_id!==record.pairing_id)ERROR('B_PAIR_RECOVERY_INVALID');
  const all=credentials.readAll();
  if(all.site_b_pair_recovery||this.db.prepare('SELECT id FROM b_pair_recovery WHERE id=1').get())
   ERROR('B_PAIR_RECOVERY_PENDING');
  all.site_b_pair_recovery=material;credentials.writeAll(all);
  try{this.tx(()=>this.db.prepare('INSERT INTO b_pair_recovery(id,pairing_id,intent_id,claim_digest,site_id,expires_at) VALUES(1,?,?,?,?,?)')
   .run(record.pairing_id,record.intent_id,record.claim_digest,record.site_id,record.expires_at));}
  catch(error){const undo=credentials.readAll();delete undo.site_b_pair_recovery;credentials.writeAll(undo);throw error;}
 }
 pairRecovery(credentials){
  if(this.siteForget()){this.recoverSiteForget(credentials);return null;}
  const row=this.db.prepare('SELECT * FROM b_pair_recovery WHERE id=1').get();
  if(!row){
   // With no transaction to recover, only remove orphaned material. Legacy
   // stores expose section access; recovery with a row still requires readAll.
   if(typeof credentials.get==='function'&&typeof credentials.remove==='function'){
    if(credentials.get('site_b_pair_recovery')!=null)credentials.remove('site_b_pair_recovery');
   }else{
    const all=credentials.readAll();
    if(Object.hasOwn(all,'site_b_pair_recovery')){delete all.site_b_pair_recovery;credentials.writeAll(all);}
   }
   return null;
  }
  const material=credentials.readAll()?.site_b_pair_recovery;
  if(!material||material.pairing_id!==row.pairing_id||material.claim_digest!==row.claim_digest)
   ERROR('B_PAIR_RECOVERY_UNCONFIRMED');
  if(row.expires_at<=this.now()){this.clearPairRecovery(credentials,row.pairing_id);ERROR('B_PAIRING_INTENT_EXPIRED');}
  const intent=this.db.prepare('SELECT used_at,expires_at FROM b_pair_intents WHERE intent_id=?').get(row.intent_id);
  if(!intent||intent.expires_at<=this.now()){
   this.clearPairRecovery(credentials,row.pairing_id);ERROR('B_PAIRING_INTENT_EXPIRED');
  }
  if(intent?.used_at!==null&&intent?.used_at!==undefined){this.clearPairRecovery(credentials,row.pairing_id);return null;}
  return {row,material};
 }
 clearPairRecovery(credentials,pairing_id){
  if(!OP.test(pairing_id))ERROR('B_PAIR_RECOVERY_INVALID');
  this.tx(()=>this.db.prepare('DELETE FROM b_pair_recovery WHERE id=1 AND pairing_id=?').run(pairing_id));
  const all=credentials.readAll();
  if(all.site_b_pair_recovery?.pairing_id===pairing_id){delete all.site_b_pair_recovery;credentials.writeAll(all);}
 }
 cancelPairRecovery(credentials){
  const row=this.db.prepare('SELECT pairing_id FROM b_pair_recovery WHERE id=1').get();
  if(row)this.clearPairRecovery(credentials,row.pairing_id);
  else this.pairRecovery(credentials);
 }
 ensureIntent(credentials){
  if(this.siteForget())this.recoverSiteForget(credentials);
  const all=credentials.readAll(),saved=all.site_b_intents||{};
  let pruned=false;
  for(const row of this.db.prepare('SELECT intent_id FROM b_pair_intents WHERE used_at IS NOT NULL OR expires_at<=?').all(this.now()))
   if(Object.hasOwn(saved,row.intent_id)){delete saved[row.intent_id];pruned=true;}
  if(pruned){all.site_b_intents=saved;credentials.writeAll(all);}
  const rows=this.db.prepare('SELECT * FROM b_pair_intents WHERE used_at IS NULL AND expires_at>? ORDER BY created_at DESC').all(this.now());
  for(const row of rows){const secret=saved[row.intent_id];if(typeof secret==='string'&&/^[A-Za-z0-9_-]{43}$/.test(secret))return {intent_id:row.intent_id,pairing_hash:row.pairing_hash,expires_at:row.expires_at};}
  const intent_id=crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
  const pairing_hash=crypto.createHash('sha256').update(JSON.stringify(['chathand-site-precreate-v1',this.installationId,intent_id,secret])).digest('hex');
  all.site_b_intents={...(all.site_b_intents||{}),[intent_id]:secret};
  credentials.writeAll(all);
  const at=this.now();
  this.tx(()=>this.db.prepare('INSERT INTO b_pair_intents(intent_id,pairing_hash,created_at,expires_at) VALUES(?,?,?,?)').run(intent_id,pairing_hash,at,at+86400000));
  return {intent_id,pairing_hash,expires_at:at+86400000};
 }
 seedHighwater(credentials){
  const saved=credentials.get('site_b'),route=this.route('site');
  if(!saved||saved.installation_id!==this.installationId||saved.site_id!==route.site_id||
     saved.binding_id!==route.binding_id||saved.generation!==route.generation||
     typeof saved.site_public_key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(saved.site_public_key))return;
  this.tx(()=>this.db.prepare('INSERT INTO b_binding_highwater(site_id,site_public_key,generation) VALUES(?,?,?) ON CONFLICT(site_id,site_public_key) DO UPDATE SET generation=MAX(generation,excluded.generation)')
   .run(saved.site_id,saved.site_public_key,saved.generation));
 }
 prepareSiteCommit({intent_id,site_id,owner_subject,binding_id,generation,previous_binding,previous_generation,previous_configured,selection_revision}){
  if(!OP.test(intent_id)||!OP.test(binding_id)||!int(generation)||generation<1)ERROR('B_SITE_COMMIT_INVALID');
  this.tx(()=>{
   this.assertNoSiteForget();
   if(this.siteCommit())ERROR('B_SITE_COMMIT_PENDING');
   const old=this.route('site'),selected=this.selection();
   if(old.binding_id!==previous_binding||old.generation!==previous_generation||
      old.configured!==previous_configured||selected.revision!==selection_revision)ERROR('B_SITE_COMMIT_CHANGED');
   const intent=this.db.prepare('SELECT * FROM b_pair_intents WHERE intent_id=? AND used_at IS NULL AND expires_at>?').get(intent_id,this.now());
   if(!intent)ERROR('B_PAIRING_INTENT_MISSING');
   this.db.prepare("INSERT INTO b_site_commit(id,phase,intent_id,site_id,owner_subject,binding_id,generation,created_at,previous_binding,previous_generation,previous_configured,selection_revision) VALUES(1,'PREPARED',?,?,?,?,?,?,?,?,?,?)")
    .run(intent_id,site_id,owner_subject,binding_id,generation,this.now(),previous_binding,previous_generation,previous_configured,selection_revision);
  });
 }
 decideSiteCommit({intent_id,site_id,site_origin,owner_subject,binding_id,generation,site_public_key}){
  return this.authorityTx(()=>{
   const commit=this.siteCommit(),old=this.route('site');
   if(!commit||commit.phase!=='PREPARED'||commit.intent_id!==intent_id||commit.binding_id!==binding_id||commit.generation!==generation)ERROR('B_SITE_COMMIT_CHANGED');
   if(old.binding_id!==commit.previous_binding||old.generation!==commit.previous_generation||
      old.configured!==commit.previous_configured||this.selection().revision!==commit.selection_revision)
    ERROR('B_SITE_COMMIT_CHANGED');
   if(typeof site_public_key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(site_public_key))ERROR('B_SITE_KEY_INVALID');
   const high=this.db.prepare('SELECT generation FROM b_binding_highwater WHERE site_id=? AND site_public_key=?').get(site_id,site_public_key);
   if(high&&generation<=high.generation)ERROR('B_BINDING_ROLLBACK');
   const changed=this.db.prepare('UPDATE b_pair_intents SET used_at=? WHERE intent_id=? AND used_at IS NULL AND expires_at>?').run(this.now(),intent_id,this.now());
   if(changed.changes!==1)ERROR('B_PAIRING_INTENT_MISSING');
   const routeWrite=this.db.prepare("UPDATE b_routes SET configured=1,state='reconnecting',generation=?,binding_id=?,site_id=?,owner_subject=?,last_verified=0,reconnect_epoch=reconnect_epoch+1,health_revision=health_revision+1,reason=NULL WHERE route='site' AND binding_id IS ? AND generation=? AND configured=?")
    .run(generation,binding_id,site_id,owner_subject,commit.previous_binding,commit.previous_generation,commit.previous_configured);
   if(routeWrite.changes!==1)ERROR('B_SITE_COMMIT_CHANGED');
   this.db.prepare('DELETE FROM b_host_receipts').run();
   this.db.prepare("UPDATE b_site_commit SET phase='COMMITTED' WHERE id=1 AND phase='PREPARED'").run();
   this.db.prepare('INSERT INTO b_binding_highwater(site_id,site_public_key,generation) VALUES(?,?,?) ON CONFLICT(site_id,site_public_key) DO UPDATE SET generation=excluded.generation')
    .run(site_id,site_public_key,generation);
   this.db.prepare('INSERT INTO b_pair_notice(notice_id,site_id,site_origin,binding_id,generation,paired_at) VALUES(?,?,?,?,?,?)')
    .run(crypto.randomUUID(),site_id,site_origin,binding_id,generation,this.now());
   return {configured:true,healthy:false,generation,selected:this.selection().selected};
  });
 }
 siteOrigin(credentials){
  const route=this.route('site'),saved=credentials.get('site_b');
  return route.configured===1&&saved?.installation_id===this.installationId&&
   route.site_id===saved.site_id&&route.binding_id===saved.binding_id&&route.generation===saved.generation&&
   route.owner_subject===saved.owner_subject? saved.site_origin:null;
 }
 pairedNotice(credentials){
  const route=this.route('site'),origin=this.siteOrigin(credentials);
  if(!origin||this.siteCommit())return null;
  const row=this.db.prepare('SELECT * FROM b_pair_notice WHERE site_id=? AND binding_id=? AND generation=? AND site_origin=? AND dismissed_at IS NULL ORDER BY paired_at DESC LIMIT 1')
   .get(route.site_id,route.binding_id,route.generation,origin);
  if(!row||row.paired_at>this.now()||this.now()-row.paired_at>=86400000)return null;
  return {notice_id:row.notice_id,origin:row.site_origin,paired_at:row.paired_at};
 }
 dismissPairedNotice(notice_id,credentials){
  if(!OP.test(notice_id))ERROR('B_NOTICE_INVALID');
  const current=this.pairedNotice(credentials);
  if(!current||current.notice_id!==notice_id)ERROR('B_NOTICE_STALE');
  const result=this.tx(()=>this.db.prepare('UPDATE b_pair_notice SET dismissed_at=? WHERE notice_id=? AND dismissed_at IS NULL').run(this.now(),notice_id));
  if(result.changes!==1)ERROR('B_NOTICE_STALE');
  return {dismissed:true,notice_id};
 }
 recoverSiteCommit(credentials){
  if(this.siteForget())return this.recoverSiteForget(credentials);
  const commit=this.siteCommit();if(!commit)return {recovered:false};
  const all=credentials.readAll(),staged=all.site_b_stage;
  if(commit.phase==='PREPARED'){
   if(staged?.binding_id===commit.binding_id)delete all.site_b_stage;
   if(all.site_b_machine_stage?.site_id===commit.site_id)delete all.site_b_machine_stage;
   credentials.writeAll(all);
   this.tx(()=>this.db.prepare('DELETE FROM b_site_commit WHERE id=1 AND phase=\'PREPARED\'').run());
   return {recovered:true,phase:'rolled_back'};
  }
  if(commit.phase!=='COMMITTED')ERROR('B_SITE_COMMIT_INVALID');
  const active=all.site_b;
  if(staged?.binding_id===commit.binding_id&&staged?.generation===commit.generation&&all.site_b_machine_stage?.site_id===commit.site_id){
   all.site_b=staged;all.site_b_machine=all.site_b_machine_stage;
   delete all.site_b_stage;delete all.site_b_machine_stage;
   credentials.writeAll(all);
  }else if(active?.binding_id!==commit.binding_id||active?.generation!==commit.generation||
    all.site_b_machine?.site_id!==commit.site_id||all.site_b_machine?.site_origin!==active?.site_origin||
    typeof all.site_b_machine?.bearer!=='string'||all.site_b_machine.bearer.length<32||
    all.site_b_machine.bearer.length>4096||/\s/.test(all.site_b_machine.bearer)){
   this.tx(()=>this.db.prepare("UPDATE b_routes SET state='failed',last_verified=0,reason='B_PAIRING_PARTIAL_COMMIT' WHERE route='site'").run());
   ERROR('B_PAIRING_PARTIAL_COMMIT');
  }
  this.tx(()=>this.db.prepare('DELETE FROM b_site_commit WHERE id=1 AND phase=\'COMMITTED\'').run());
  const clean=credentials.readAll(),intents=clean.site_b_intents||{};
  let changed=false;
  for(const row of this.db.prepare('SELECT intent_id FROM b_pair_intents WHERE used_at IS NOT NULL OR expires_at<=?').all(this.now()))
   if(Object.hasOwn(intents,row.intent_id)){delete intents[row.intent_id];changed=true;}
  if(changed){clean.site_b_intents=intents;credentials.writeAll(clean);}
  return {recovered:true,phase:'committed'};
 }
 // Called only by the existing authenticated A tunnel controller, never by remote tool/UI args.
 configureOpenAI({verified=false}={}){
  if(verified!==true)ERROR('B_A_AUTH_REQUIRED');
  return this.tx(()=>{this.db.prepare("UPDATE b_routes SET configured=1,state='reconnecting',health_revision=health_revision+1 WHERE route='openai'").run();
   return {configured:true,selected:this.selection().selected};});
 }
 // Call only after a signed pairing receipt / authenticated health check in the service adapter.
 configureSite({site_id,owner_subject,binding_id,generation}, {authenticated=false}={}){
  if(authenticated!==true||typeof site_id!=='string'||!/^[a-zA-Z0-9_-]{4,128}$/.test(site_id)||
   typeof owner_subject!=='string'||!owner_subject||owner_subject.length>160||
   typeof binding_id!=='string'||!OP.test(binding_id)||!int(generation)||generation<1)ERROR('B_PAIRING_UNVERIFIED');
  return this.authorityTx(()=>{
   this.assertNoSiteForget();
   const prev=this.route('site');
   if(prev.binding_id&&(generation<prev.generation||prev.binding_id!==binding_id&&generation<=prev.generation))
    ERROR('B_BINDING_ROLLBACK');
   if(prev.binding_id===binding_id&&generation===prev.generation){
    if(prev.configured!==1||prev.site_id!==site_id||prev.owner_subject!==owner_subject)ERROR('B_BINDING_REPLAY_REJECTED');
    return {configured:true,healthy:this.fresh(prev),generation,selected:this.selection().selected,replayed:true};
   }
   this.db.prepare("UPDATE b_routes SET configured=1,state='reconnecting',generation=?,binding_id=?,site_id=?,owner_subject=?,last_verified=0,reconnect_epoch=reconnect_epoch+1,health_revision=health_revision+1 WHERE route='site'")
    .run(generation,binding_id,site_id,owner_subject);
   this.db.prepare('DELETE FROM b_host_receipts').run();
   return {configured:true,healthy:false,generation,selected:this.selection().selected};
  });
 }
 // A health proof must come from internal tunnel/verified device roundtrip, never POST/UI/model fields.
 health(route,{state,verified=false,generation=0,nonceEcho=false,reason=null,reconnectEpoch=null}={}){
  if(!ROUTES.has(route)||!STATES.has(state)||verified!==true||state==='healthy'&&nonceEcho!==true||!int(generation))
   ERROR('B_HEALTH_UNVERIFIED');
  return this.authorityTx(()=>{
   const old=this.route(route);
   if(!old.configured&&route==='site'||old.configured&&generation!==old.generation&&route==='site')ERROR('B_GENERATION_MISMATCH');
   if(reconnectEpoch!==null&&(!int(reconnectEpoch)||reconnectEpoch!==old.reconnect_epoch))ERROR('B_RECONNECT_EPOCH');
   if(state==='healthy'&&!old.configured)ERROR('B_NOT_CONFIGURED');
   // A naturally stale healthy interval is a lifecycle break, even if the next
   // verified health immediately recovers. Previously issued host proof cannot revive.
   const invalidateSite=route==='site'&&(state!=='healthy'||old.state==='healthy'&&!this.fresh(old));
   this.db.prepare('UPDATE b_routes SET state=?,last_verified=?,health_revision=health_revision+1,reconnect_epoch=reconnect_epoch+?,reason=? WHERE route=?')
    .run(state,state==='healthy'?this.now():0,invalidateSite?1:0,state==='healthy'?null:typeof reason==='string'?reason.slice(0,80):null,route);
   if(invalidateSite)this.db.prepare('DELETE FROM b_host_receipts').run();
   return this.snapshot().routes[route];
  });
 }
 fresh(x){return !this.siteCommit()&&!!x&&x.configured===1&&x.state==='healthy'&&this.now()-x.last_verified>=0&&this.now()-x.last_verified<30000;}
 promoteSiteTemplate(credentials,saved,pin){
  if(saved?.trust!=='tofu-template-v1'||pin?.verified_source!==true||!SHA.test(pin.manifest_sha256)||
     typeof pin.template_version!=='string'||!pin.template_version||this.siteCommit())ERROR('B_TEMPLATE_MISMATCH');
  const route=this.route('site'),all=credentials.readAll(),current=all.site_b;
  if(route.configured!==1||route.site_id!==saved.site_id||route.binding_id!==saved.binding_id||
     route.generation!==saved.generation||route.owner_subject!==saved.owner_subject||
     current?.installation_id!==this.installationId||current?.binding_id!==saved.binding_id||
     current?.generation!==saved.generation||current?.device_credential!==saved.device_credential||
     current?.template_version!==saved.template_version||current?.manifest_sha256!==saved.manifest_sha256)
   ERROR('B_HEALTH_LIFECYCLE_CHANGED');
  if(current.template_version===pin.template_version&&current.manifest_sha256===pin.manifest_sha256)return current;
  // This synchronous protected-key update is fenced by the unchanged local
  // binding. Health stays failed until the signed proof has been rechecked.
  all.site_b={...current,template_version:pin.template_version,manifest_sha256:pin.manifest_sha256};
  credentials.writeAll(all);
  return all.site_b;
 }
 switchInside(from,to,reason){
  const selected=this.selection();
  if(selected.selected!==from)ERROR('B_SELECTION_CHANGED');
  const revision=selected.revision+1,event_id=crypto.randomUUID();
  this.db.prepare('UPDATE b_selection SET selected=?,revision=? WHERE id=1').run(to,revision);
  this.db.prepare('DELETE FROM b_host_receipts').run();
  this.db.prepare('INSERT INTO b_switch_events(event_id,from_route,to_route,revision,reason,at) VALUES(?,?,?,?,?,?)').run(event_id,from,to,revision,reason,this.now());
  return {event_id,from,to,revision,reason};
 }
 switchUser(to,{windowGesture=false}={}){
  if(windowGesture!==true||!ROUTES.has(to))ERROR('B_WINDOW_GESTURE_REQUIRED');
  return this.authorityTx(()=>{
   const selected=this.selection(),next=this.route(to);
   if(!next.configured||!this.fresh(next))ERROR('B_ROUTE_NOT_HEALTHY');
   if(selected.selected===to)return {changed:false,selected:to,revision:selected.revision};
   const event=this.switchInside(selected.selected,to,'user_selected');
   return {changed:true,selected:to,...event};
  });
 }
 // Called by authenticated local setup commands / verified internal setup observers only.
 switchSetup(to,{authenticatedSetup=false,expectedRevision=null}={}){
  if(authenticatedSetup!==true||!ROUTES.has(to))ERROR('B_SETUP_AUTH_REQUIRED');
  return this.authorityTx(()=>{
   const selected=this.selection(),next=this.route(to);
   if(expectedRevision!==null&&expectedRevision!==selected.revision)ERROR('B_SELECTION_CHANGED');
   if(!this.fresh(next))ERROR('B_ROUTE_NOT_HEALTHY');
   if(selected.selected===to)return {changed:false,selected:to,revision:selected.revision};
   return {changed:true,selected:to,...this.switchInside(selected.selected,to,'setup_verified')};
  });
 }
 switchConfiguredSiteIfFailed(){
  return this.authorityTx(()=>{
   const s=this.selection(),old=this.route(s.selected),next=this.route('site');
   if(s.selected==='site'||old.configured!==0&&!['failed','auth_required'].includes(old.state)||!this.fresh(next))
    return {changed:false,selected:s.selected};
   const event=this.switchInside(s.selected,'site',old.configured===0?'configuration_ready_unconfigured':'configuration_ready_after_failure');
   this.db.prepare('INSERT INTO b_switch_notice_delivery(event_id,installation_id,site_id,owner_subject,binding_id,generation,selection_revision) VALUES(?,?,?,?,?,?,?)')
    .run(event.event_id,this.installationId,next.site_id,next.owner_subject,next.binding_id,next.generation,event.revision);
   return {changed:true,selected:'site',...event};
  });
 }
 op(id){if(!OP.test(id))ERROR('B_OP_INVALID');return this.db.prepare('SELECT * FROM b_operations WHERE op_id=?').get(id);}
 identity(op,s){
  if(op.route!==s.route||op.principal!==s.principal||op.binding_id!==(s.binding_id||null)||
   op.generation!==s.generation||op.request_digest!==s.request_digest||op.tool!==s.tool_name)ERROR('B_OPERATION_CONFLICT');
 }
 // Incoming authenticated Site work is checked and signed BEFORE calling admit().
 admit(s,{authenticated=false}={}){
  if(authenticated!==true||!s||typeof s!=='object'||!OP.test(s.op_id)||!ROUTES.has(s.route)||
   typeof s.principal!=='string'||!s.principal||!SHA.test(s.request_digest)||typeof s.tool_name!=='string'||
   !int(s.created_at)||!int(s.start_before)||s.start_before<s.created_at||!int(s.generation))ERROR('B_WORK_UNVERIFIED');
  const receipt=this.tx(()=>{
   const existing=this.op(s.op_id);
   if(existing){this.identity(existing,s);return {replayed:true,op_id:s.op_id,state:existing.state,route:existing.route,result_digest:existing.result_digest,ack_id:existing.ack_id};}
   if(s.start_before<this.now())ERROR('B_JOB_EXPIRED');
   const sel=this.selection(),incoming=this.route(s.route),current=this.route(sel.selected);
   if(!incoming.configured||!this.fresh(incoming))ERROR('B_ROUTE_NOT_HEALTHY');
   if(s.route==='site'&&(s.binding_id!==incoming.binding_id||s.generation!==incoming.generation||s.principal!=='site:'+incoming.owner_subject))ERROR('B_BINDING_MISMATCH');
   let switch_event=null;
   if(sel.selected!==s.route&&!SETUP_PROBES.has(s.tool_name)){
    const firstSite=s.route==='site'&&sel.selected==='openai'&&current.configured===0;
    if(!firstSite&&!['failed','auth_required'].includes(current.state))ERROR('B_ROUTE_NOT_SELECTED',displayText(sel.selected==='site'?'route.refusal.site':'route.refusal.openai'));
    switch_event=this.switchInside(sel.selected,s.route,firstSite?'configuration_ready_unconfigured':'selected_route_failed');
   }
   const revision=this.selection().revision;
   this.db.prepare('INSERT INTO b_operations(op_id,route,principal,binding_id,generation,tool,request_digest,selection_revision,state,created_at,start_before,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(s.op_id,s.route,s.principal,s.binding_id||null,s.generation,s.tool_name,s.request_digest,revision,'admitted',s.created_at,s.start_before,this.now());
   // A real admit-origin OpenAI→Site switch must enter the same durable,
   // binding-scoped A10 notice queue, not a transient dispatch result field.
   if(switch_event&&switch_event.from==='openai'&&switch_event.to==='site'&&s.route==='site'){
    const linked=this.db.prepare('INSERT INTO b_switch_notice_delivery(event_id,installation_id,site_id,owner_subject,binding_id,generation,selection_revision) VALUES(?,?,?,?,?,?,?)')
     .run(switch_event.event_id,this.installationId,incoming.site_id,incoming.owner_subject,
      incoming.binding_id,incoming.generation,switch_event.revision);
    if(linked.changes!==1)ERROR('B_SWITCH_NOTICE_CONFLICT');
   }
   return {replayed:false,op_id:s.op_id,state:'admitted',route:s.route,selection_revision:revision,...(switch_event?{switch_event}:{})};
  });
  if(receipt.switch_event)this.notifyAuthority();
  return receipt;
 }
 start(op_id,s){
  return this.tx(()=>{
   const op=this.op(op_id);if(!op)ERROR('B_OP_MISSING');this.identity(op,s);
   if(op.state!=='admitted')return {execute:false,state:op.state};
   if(this.now()>op.start_before||this.selection().selected!==op.route&&!SETUP_PROBES.has(op.tool)||!this.fresh(this.route(op.route))){
    this.db.prepare("UPDATE b_operations SET state='cancelled',updated_at=? WHERE op_id=? AND state='admitted'").run(this.now(),op_id);
    return {execute:false,state:'cancelled'};
   }
   this.db.prepare("UPDATE b_operations SET state='executing',executor=?,updated_at=? WHERE op_id=? AND state='admitted'").run(this.instance,this.now(),op_id);
   return {execute:true,state:'executing'};
  });
 }
 complete(op_id,s,result,{failed=false,chatNoticeEligible=false}={}){
  if(!result||typeof result!=='object'||Array.isArray(result))ERROR('B_RESULT_INVALID');
  // Only a definite canonical UTF-8 byte overrun gets an unavailable envelope.
  // It is a delivery outcome, NEVER proof that the tool/business did not execute.
  const baseRaw=Buffer.from(canonicalize(result),'utf8');
  const baseDigest=hash(baseRaw),sourceResultUnavailable=baseRaw.length>RESULT_PLAIN_MAX;
  const durableResult=sourceResultUnavailable?{
   kind:'b_site_result_unavailable_v1',result_unavailable:true,
   business_outcome:'unknown',do_not_replay:true,
   error:{code:'B_RESULT_TOO_LARGE'},
   source_result:{sha256:baseDigest,bytes:baseRaw.length}
  }:result;
  const durableRaw=sourceResultUnavailable?Buffer.from(canonicalize(durableResult),'utf8'):baseRaw;
  if(durableRaw.length>RESULT_PLAIN_MAX)ERROR('B_RESULT_TOO_LARGE');
  return this.tx(()=>{
   const op=this.op(op_id);if(!op)ERROR('B_OP_MISSING');this.identity(op,s);
   if(op.state==='completed'||op.state==='failed'){
    // An original output may have been reduced to a bounded unknown envelope;
    // compare its separate source digest/length, never replace the saved box.
    const attached=this.db.prepare('SELECT 1 AS yes FROM b_switch_notice_delivery WHERE attached_op_id=? AND base_digest=?').get(op_id,baseDigest);
    if(op.result_digest!==baseDigest&&!attached){
     if(!sourceResultUnavailable||!op.result_box)ERROR('B_RESULT_CONFLICT');
     const previous=decryptResult(this.resultKey(),this.installationId,op_id,op.result_box);
     if(previous.kind!=='b_site_result_unavailable_v1'||previous.result_unavailable!==true||
        previous.business_outcome!=='unknown'||previous.do_not_replay!==true||
        previous.source_result?.sha256!==baseDigest||previous.source_result?.bytes!==baseRaw.length||
        hash(Buffer.from(canonicalize(previous),'utf8'))!==op.result_digest)
      ERROR('B_RESULT_CONFLICT');
    }
    return {replayed:true,state:op.state,result_digest:op.result_digest};
   }
   if(op.state!=='executing'||op.executor!==this.instance)ERROR('B_OP_NOT_EXECUTING');
   let raw=durableRaw,notice=null;
   if(chatNoticeEligible===true&&op.route==='site'&&!Object.hasOwn(durableResult,'switch_notice')){
    const site=this.route('site'),selected=this.selection();
    if(selected.selected==='site'&&selected.revision===op.selection_revision&&
       this.fresh(site)&&site.site_id&&site.owner_subject&&site.binding_id&&
       op.principal==='site:'+site.owner_subject&&op.binding_id===site.binding_id&&
       op.generation===site.generation){
     // Exact persisted event scope, never a global "latest switch" guess.
     const pending=this.db.prepare('SELECT n.event_id,e.reason FROM b_switch_notice_delivery n JOIN b_switch_events e ON e.event_id=n.event_id AND e.revision=n.selection_revision WHERE n.installation_id=? AND n.site_id=? AND n.owner_subject=? AND n.binding_id=? AND n.generation=? AND n.selection_revision=? AND n.attached_op_id IS NULL')
      .get(this.installationId,site.site_id,site.owner_subject,site.binding_id,site.generation,selected.revision);
     if(pending){
      const candidate={switch_event_id:pending.event_id,
       result_line:pending.reason==='configuration_ready_unconfigured'?displayText('card.route.siteReady'):displayText('card.route.siteFallback'),app_event_id:pending.event_id};
      const encoded=Buffer.from(canonicalize({...durableResult,switch_notice:candidate}),'utf8');
      // Never discard an already executed tool result due only to notice size.
      if(encoded.length<=RESULT_PLAIN_MAX){raw=encoded;notice=candidate;}
     }
    }
   }
   const result_digest=hash(raw),box=encryptResult(this.resultKey(),this.installationId,op_id,raw);
   // 'completed' here is only the durable delivery ledger state. For an
   // unavailable source output the business outcome remains explicitly unknown.
   const status=sourceResultUnavailable?'completed':failed?'failed':'completed';
   this.db.prepare("UPDATE b_operations SET state=?,result_digest=?,result_box=?,updated_at=? WHERE op_id=? AND state='executing'").run(status,result_digest,box,this.now(),op_id);
   if(notice){
    const linked=this.db.prepare('UPDATE b_switch_notice_delivery SET attached_op_id=?,base_digest=? WHERE event_id=? AND attached_op_id IS NULL')
     .run(op_id,baseDigest,notice.switch_event_id);
    if(linked.changes!==1)ERROR('B_SWITCH_NOTICE_CONFLICT');
   }
   // This flag comes from Store's measured source bytes, never from caller input.
   return {replayed:false,state:status,result_digest,source_result_unavailable:sourceResultUnavailable,...(notice?{switch_notice:notice}:{})};
  });
 }
 status(op_id,s,{includeResult=false}={}){
  const op=this.op(op_id);if(!op)ERROR('B_OP_MISSING');this.identity(op,s);
  const result={op_id,state:op.state,route:op.route,result_digest:op.result_digest||null,ack_id:op.ack_id||null,
   do_not_replay:['executing','uncertain','completed','failed'].includes(op.state)};
  if(includeResult&&op.result_box&&VALID_TERMINAL.has(op.state))result.result=decryptResult(this.resultKey(),this.installationId,op_id,op.result_box);
  return result;
 }
 ack(op_id,s,{result_digest,ack_id}={}){
  if(!SHA.test(result_digest)||!OP.test(ack_id))ERROR('B_ACK_INVALID');
  return this.tx(()=>{
   const op=this.op(op_id);if(!op)ERROR('B_OP_MISSING');this.identity(op,s);
   if(!['completed','failed'].includes(op.state)||op.result_digest!==result_digest)ERROR('B_ACK_CONFLICT');
   if(op.ack_id){if(op.ack_id!==ack_id||op.ack_digest!==result_digest)ERROR('B_ACK_CONFLICT');return {ack:true,replayed:true,ack_id};}
   this.db.prepare('UPDATE b_operations SET ack_id=?,ack_digest=?,updated_at=? WHERE op_id=?').run(ack_id,result_digest,this.now(),op_id);
   return {ack:true,replayed:false,ack_id};
  });
 }
 // Internal delivery-only fence: preserve the original op, encrypted result,
 // signed digest, ACK and attached notice. This is never a business retry.
 quarantineSiteResult(op_id,s,{result_digest,reason}={}){
  if(!OP.test(op_id)||!s||typeof s!=='object'||!SHA.test(result_digest)||
     !RESULT_QUARANTINE_REASONS.has(reason))ERROR('B_RESULT_QUARANTINE_INPUT');
  try{return this.tx(()=>{
   const op=this.op(op_id);if(!op)ERROR('B_OP_MISSING');this.identity(op,s);
   const site=this.route('site');
   if(this.selection().installation!==this.installationId||
      op.route!=='site'||site.configured!==1||!site.owner_subject||
      site.binding_id!==op.binding_id||site.generation!==op.generation||
      op.principal!=='site:'+site.owner_subject||
      !['completed','failed'].includes(op.state)||op.ack_id!==null||
      typeof op.result_box!=='string'||!op.result_box||op.result_digest!==result_digest)
    ERROR('B_RESULT_QUARANTINE_CONFLICT');
   const old=this.db.prepare('SELECT * FROM b_result_delivery_quarantine WHERE op_id=?').get(op_id);
   if(old){
    if(old.installation_id!==this.installationId||old.route!==op.route||
       old.principal!==op.principal||old.binding_id!==op.binding_id||
       old.generation!==op.generation||old.request_digest!==op.request_digest||
       old.result_digest!==op.result_digest||old.reason!==reason)
     ERROR('B_RESULT_QUARANTINE_CONFLICT');
    return {quarantined:true,replayed:true,op_id};
   }
   const saved=this.db.prepare('INSERT INTO b_result_delivery_quarantine(op_id,installation_id,route,principal,binding_id,generation,request_digest,result_digest,reason,quarantined_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(op.op_id,this.installationId,op.route,op.principal,op.binding_id,
     op.generation,op.request_digest,op.result_digest,reason,this.now());
   if(saved.changes!==1)ERROR('B_RESULT_QUARANTINE_UNCONFIRMED');
   return {quarantined:true,replayed:false,op_id};
  });}catch(error){
   // DB/commit errors are UNKNOWN, never a successful quarantine.
   // Keep explicit identity, result, lifecycle and store errors unchanged.
   if(typeof error?.code==='string'&&error.code.startsWith('B_'))throw error;
   ERROR('B_RESULT_QUARANTINE_UNCONFIRMED');
  }
 }
 pendingSiteResults(binding_id,generation,limit=5){
  if(!OP.test(binding_id)||!int(generation)||!int(limit)||limit<1||limit>10)ERROR('B_RESULT_QUEUE_INVALID');
  const site=this.route('site');
  if(this.selection().installation!==this.installationId||site.configured!==1||
     site.binding_id!==binding_id||site.generation!==generation||!site.owner_subject)
   ERROR('B_RESULT_QUEUE_SCOPE_CHANGED');
  // Filter durable quarantine BEFORE LIMIT so five bad boxes cannot starve the sixth.
  // The stable cursor also avoids delivering a valid row twice in one batch.
  const scan=this.db.prepare(
   "SELECT o.* FROM b_operations o WHERE o.route='site' AND o.principal=? AND o.binding_id=? AND o.generation=? "+
   "AND o.state IN ('completed','failed') AND o.ack_id IS NULL AND o.result_box IS NOT NULL "+
   "AND (o.updated_at>? OR (o.updated_at=? AND o.op_id>?)) "+
   "AND NOT EXISTS(SELECT 1 FROM b_result_delivery_quarantine q WHERE q.op_id=o.op_id "+
   "AND q.installation_id=? AND q.route=o.route AND q.principal=o.principal "+
   "AND q.binding_id=o.binding_id AND q.generation=o.generation "+
   "AND q.request_digest=o.request_digest AND q.result_digest=o.result_digest) "+
   "ORDER BY o.updated_at,o.op_id LIMIT ?");
  const ready=[];let scanned=0,cursorAt=-1,cursorId='';
  // A bounded scan isolates up to ten batches of bad results per tick. Next
  // tick starts with those rows excluded, so a longer corrupt run also drains.
  const maxScanned=limit*10;
  while(ready.length<limit&&scanned<maxScanned){
   const pending=scan.all('site:'+site.owner_subject,binding_id,generation,
    cursorAt,cursorAt,cursorId,this.installationId,Math.min(limit-ready.length,maxScanned-scanned));
   if(!pending.length)break;
   for(const op of pending){
    scanned++;cursorAt=op.updated_at;cursorId=op.op_id;
    const work={op_id:op.op_id,route:op.route,principal:op.principal,binding_id:op.binding_id,
     generation:op.generation,tool_name:op.tool,request_digest:op.request_digest,
     created_at:op.created_at,start_before:op.start_before};
    let result;
    try{result=decryptResult(this.resultKey(),this.installationId,op.op_id,op.result_box);}
    catch(error){
     if(error?.code!=='B_RESULT_UNAVAILABLE')throw error;
     // A failed quarantine commit is UNCONFIRMED and must stop this batch.
     this.quarantineSiteResult(op.op_id,work,{result_digest:op.result_digest,reason:'B_RESULT_UNAVAILABLE'});
     continue;
    }
    ready.push({op_id:op.op_id,request_digest:op.request_digest,
     result_digest:op.result_digest,result,work});
   }
  }
  return ready;
 }
 forgetRoute(route,{authenticatedNative=false}={}){
  if(authenticatedNative!==true||!ROUTES.has(route))ERROR('B_NATIVE_REVOKE_REQUIRED');
  return this.authorityTx(()=>this.forgetRouteInside(route));
 }
 forgetRouteInside(route){
   this.db.prepare("UPDATE b_routes SET configured=0,state='unconfigured',generation=0,binding_id=NULL,site_id=NULL,owner_subject=NULL,last_verified=0,health_revision=health_revision+1,reconnect_epoch=reconnect_epoch+1,reason='forgotten' WHERE route=?").run(route);
   this.db.prepare("UPDATE b_operations SET state='cancelled',updated_at=? WHERE route=? AND state='admitted'").run(this.now(),route);
   this.db.prepare('DELETE FROM b_host_receipts').run();
   if(this.selection().selected===route&&route!=='openai')this.switchInside(route,'openai','route_removed');
   return {forgotten:true,selected:this.selection().selected};
 }
 revokeSite({binding_id,generation,authenticatedNative=false}={}){
  if(authenticatedNative!==true||!OP.test(binding_id)||!int(generation))ERROR('B_NATIVE_REVOKE_REQUIRED');
  return this.authorityTx(()=>{
   const route=this.route('site');if(route.binding_id!==binding_id||route.generation!==generation)ERROR('B_REVOKE_BINDING_CHANGED');
   const old=this.db.prepare('SELECT remote_state FROM b_revocations WHERE binding_id=? AND generation=?').get(binding_id,generation);
   if(old)return {local_revoked:true,replayed:true,remote_revocation:old.remote_state};
   this.db.prepare("UPDATE b_routes SET configured=0,state='unconfigured',last_verified=0,health_revision=health_revision+1,reconnect_epoch=reconnect_epoch+1,reason='local_revoked' WHERE route='site' AND binding_id=? AND generation=?").run(binding_id,generation);
   this.db.prepare('DELETE FROM b_host_receipts').run();
   this.db.prepare("UPDATE b_operations SET state='cancelled',updated_at=? WHERE route='site' AND binding_id=? AND generation=? AND state='admitted'").run(this.now(),binding_id,generation);
   this.db.prepare("INSERT INTO b_revocations(binding_id,generation,installation_id,local_revoked_at,remote_state) VALUES(?,?,?,?,'pending')").run(binding_id,generation,this.installationId,this.now());
   return {local_revoked:true,replayed:false,remote_revocation:'pending'};
  });
 }
 revocationPending(binding_id,generation){
  const row=this.db.prepare('SELECT remote_state FROM b_revocations WHERE binding_id=? AND generation=? AND installation_id=?').get(binding_id,generation,this.installationId);
  return row?.remote_state==='pending';
 }
 recordRemoteRevocation(binding_id,generation,{confirmed=false}={}){
  if(!OP.test(binding_id)||!int(generation))ERROR('B_REVOKE_INVALID');
  return this.tx(()=>{
   const old=this.db.prepare('SELECT remote_state FROM b_revocations WHERE binding_id=? AND generation=? AND installation_id=?').get(binding_id,generation,this.installationId);
   if(!old)ERROR('B_LOCAL_REVOKE_REQUIRED');
   if(confirmed===true&&old.remote_state!=='confirmed')this.db.prepare("UPDATE b_revocations SET remote_state='confirmed',remote_ack_at=? WHERE binding_id=? AND generation=?").run(this.now(),binding_id,generation);
   return {local_revoked:true,remote_revocation:confirmed||old.remote_state==='confirmed'?'confirmed':'unconfirmed'};
  });
 }
 currentHostReceipt(){
  if(!this.#hostProofValid)return null;
  const selected=this.selection(),site=this.route('site');
  if(selected.selected!=='site'||!this.fresh(site))return null;
  const p=this.db.prepare('SELECT * FROM b_host_receipts WHERE id=1').get();
  if(!p||p.installation_id!==this.installationId||p.site_id!==site.site_id||
   p.owner_subject!==site.owner_subject||p.binding_id!==site.binding_id||p.generation!==site.generation||
   p.selection_revision!==selected.revision||p.reconnect_epoch!==site.reconnect_epoch||
   p.expires_at<=this.now()||p.issued_at>this.now()||p.read_ok!==1||p.write_capability_ok!==1||
   p.app_flow_verified!==1)return null;
  return {source:'trusted_host',verified:true,route:'site',site_id:p.site_id,generation:p.generation,
   installation_bound:true,binding_verified:true,current_session:true,
   batch_id:p.batch_id,capability_read:true,capability_write:true,issued_at:p.issued_at,expires_at:p.expires_at,
   proof_scope:'current_binding_app_flow_not_file_write_or_client_crypto'};
 }
 issueInternalHostReceiptWriter(){
  if(this.#hostProofWriterClaimed)ERROR('B_HOST_WRITER_ALREADY_BOUND');
  this.#hostProofWriterClaimed=true;
  const capability=this.#hostProofToken,rpcSources=new Map();
  const writer=item=>this.#recordHostReceipt(item,capability,rpcSources);
  // This closure is claimed once by server.mjs and stays inside HostProbes.
  // Record only authenticated, completed full-RPC outcomes; no model setter.
  writer.recordRpcResult=source=>{
   if(!source||!OP.test(source.op_id)||!SHA.test(source.result_digest)||!SHA.test(source.session_tag)||
    !['connection_check','setup_write_probe'].includes(source.tool))ERROR('B_HOST_SOURCE_RESULTS_UNVERIFIED');
   if(source.tool==='connection_check')rpcSources.clear();
   if(rpcSources.size>=2&&!rpcSources.has(source.op_id))ERROR('B_HOST_SOURCE_RESULTS_UNVERIFIED');
   rpcSources.set(source.op_id,Object.freeze({...source}));
  };
  return Object.freeze(writer);
 }
 #recordHostReceipt(item,capability,rpcSources=new Map()){
  if(capability!==this.#hostProofToken||!item||!OP.test(item.batch_id)||!SHA.test(item.nonce_digest)||
   !SHA.test(item.session_tag)||!int(item.selection_revision)||!int(item.reconnect_epoch)||
   !OP.test(item.read_op_id)||!OP.test(item.write_op_id)||
   !SHA.test(item.read_result_digest)||!SHA.test(item.write_result_digest)||
   !int(item.issued_at)||!int(item.expires_at)||
   item.issued_at>this.now()||item.expires_at<=this.now()||item.expires_at-item.issued_at>120000||
   item.read_ok!==true||item.write_capability_ok!==true||item.app_flow_verified!==true)
   ERROR('B_HOST_RECEIPT_UNVERIFIED');
  const committed=this.tx(()=>{
   const site=this.route('site'),sel=this.selection();
   if(sel.selected!=='site'||!this.fresh(site)||item.installation_id!==this.installationId||
    item.site_id!==site.site_id||item.binding_id!==site.binding_id||
    item.owner_subject!==site.owner_subject||item.generation!==site.generation||
    item.selection_revision!==sel.revision||item.reconnect_epoch!==site.reconnect_epoch)
    ERROR('B_HOST_BINDING_CHANGED');
   const r=rpcSources.get(item.read_op_id),w=rpcSources.get(item.write_op_id);
   const rpcOK=r&&w&&r.op_id!==w.op_id&&r.tool==='connection_check'&&w.tool==='setup_write_probe'&&
    r.result_digest===item.read_result_digest&&w.result_digest===item.write_result_digest&&r.completed_at<=w.completed_at&&
    [r,w].every(s=>s.installation_id===this.installationId&&s.site_id===site.site_id&&s.owner_subject===site.owner_subject&&
     s.binding_id===site.binding_id&&s.generation===site.generation&&s.session_tag===item.session_tag&&
     s.selection_revision===sel.revision&&s.reconnect_epoch===site.reconnect_epoch&&s.transport_epoch===item.transport_epoch);
   const read=this.op(item.read_op_id),write=this.op(item.write_op_id);
   if(!rpcOK&&(!read||!write||read.op_id===write.op_id||
    read.route!=='site'||write.route!=='site'||
    read.state!=='completed'||write.state!=='completed'||
    read.tool!=='connection_check'||write.tool!=='setup_write_probe'||
    read.principal!=='site:'+site.owner_subject||write.principal!==read.principal||
    read.binding_id!==site.binding_id||write.binding_id!==site.binding_id||
    read.generation!==site.generation||write.generation!==site.generation||
    read.selection_revision!==sel.revision||write.selection_revision!==sel.revision||
    read.result_digest!==item.read_result_digest||
    write.result_digest!==item.write_result_digest||
    !read.result_box||!write.result_box||read.created_at>write.created_at))
    ERROR('B_HOST_SOURCE_RESULTS_UNVERIFIED');
   this.db.prepare('INSERT OR REPLACE INTO b_host_receipts(id,installation_id,site_id,owner_subject,binding_id,generation,batch_id,session_tag,nonce_digest,selection_revision,reconnect_epoch,read_ok,write_capability_ok,app_flow_verified,issued_at,expires_at) VALUES(1,?,?,?,?,?,?,?,?,?,?,1,1,1,?,?)')
    .run(this.installationId,item.site_id,item.owner_subject,item.binding_id,item.generation,item.batch_id,item.session_tag,item.nonce_digest,item.selection_revision,item.reconnect_epoch,item.issued_at,item.expires_at);
   return {stored:true,expires_at:item.expires_at};
  });
  this.#hostProofValid=true;rpcSources.clear();
  return committed;
 }
 invalidateHostReceipt(){
  this.#hostProofValid=false;
  return this.tx(()=>{this.db.prepare('DELETE FROM b_host_receipts').run();return {invalidated:true};});
 }
 switchEvents(){return this.db.prepare('SELECT event_id,from_route,to_route,revision,reason,at FROM b_switch_events ORDER BY revision DESC LIMIT 20').all();}
 close(){if(this.closed)return;this.closed=true;try{this.db?.close();}catch{}}
}
