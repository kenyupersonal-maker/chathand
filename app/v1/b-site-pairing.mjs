/** 1052 Site B enrollment adapter.
 * Only a native-window authenticated route may hand in an opaque grant.
 * Production target trust comes from signed/packaged deployment metadata,
 * NOT the import body, an installation UUID, SIWC bearer or Site response. */
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fail} from '../../engine/src/core.mjs';
import {siteOrigin,pairingBytes,pairingBytesV2,pairingBytesV3,pairingDigest,receiptBytesV2,completeProofBytes,precreateHash,sha256,decodeUrl64,encodeUrl64,keyId,rawPublicFromKey,edSign,edVerify,verifyHealthAck} from './b-site-wire.mjs';
import {readPinnedSiteTemplate,matchPinnedSiteTemplate,siteTemplateDescriptor,pinnedSiteCapabilities} from './site-template-pin.mjs';
const bad=(code='B_PAIRING_INVALID')=>fail(code,'Site 配对认证未完成，原有 OpenAI 连接保持不变。');
const BASE64=/^[A-Za-z0-9_-]{32,4096}$/;
const pairBytes=(claim,options)=>claim?.protocol_version==='3'?pairingBytesV3(claim,options):pairingBytesV2(claim,options);
const supportsBinding=(pin,transport)=>pin?.verified_source===true&&pinnedSiteCapabilities(pin)?.binding_protocol===3&&transport?.bindingProtocolVersion===3;
const supportsOwnerRebind=pin=>pinnedSiteCapabilities(pin)?.owner_rebind===2;
const cleanName=value=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,80):'';
const mismatch=field=>{const error=Object.assign(Error('B_PAIRING_BINDING'),{code:'B_PAIRING_BINDING',mismatch:field});throw error;};
const SITE=/^[a-zA-Z0-9_-]{4,128}$/;
const isUUID=s=>typeof s==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s);
export class BSitePairing {
 #failure=null;
 constructor({installationId,credentials,localStore,resolveDeployment,transport=null,now=Date.now,templatePin=readPinnedSiteTemplate,deviceName=()=>null}={}){
  if(!isUUID(installationId)||!credentials||!localStore||typeof resolveDeployment!=='function')bad('B_PAIRING_CONFIG');
  this.deviceName=deviceName;this.installationId=installationId;this.credentials=credentials;this.localStore=localStore;this.resolveDeployment=resolveDeployment;this.transport=transport;this.now=now;this.templatePin=templatePin;this.pending=null;this.attemptGeneration=0;this.#failure=localStore.pairingFailure?.()||null;this.pairingInFlight=null;
 }
 get failure(){return this.#failure;}
 set failure(value){
  // Only a bounded category and timestamp cross the restart boundary. The
  // verified conflict itself remains volatile and must be acquired again.
  const safe=value===null?null:{...value,code:/^B_[A-Z0-9_]{1,60}$/.test(value?.code||'')?value.code:'B_PAIRING_FAILED',at:Number.isSafeInteger(value?.at)&&value.at>=0?value.at:this.now()};
  this.localStore.setPairingFailure?.(safe);
  this.#failure=safe;
 }
 startSitePairing(){
  const pin=this.templatePin();if(pin?.verified_source!==true)bad('B_TEMPLATE_UNVERIFIED');
  const intent=this.localStore.ensureIntent(this.credentials),descriptor=siteTemplateDescriptor(pin,intent.pairing_hash);
  if(!descriptor)bad('B_TEMPLATE_UNVERIFIED');
  this.close();this.failure=null;
  return descriptor;
 }
 abandonSitePairing(reason='B_PAIRING_ABANDONED'){
  if(typeof reason!=='string'||!/^B_[A-Z0-9_]{1,60}$/.test(reason))bad('B_PAIR_FAILURE_INVALID');
  // The server must first stop and persist its enrollment watch and clear its
  // select-on-pair flag. A verified conflict is retained only in this process
  // so the eventual owner authorization flow can use this exact attempt.
  const conflict=reason==='B_BINDING_CONFLICT'&&this.failure?.code===reason&&this.failure.conflict&&this.pending;
  if(!conflict){this.close();this.localStore.cancelPairRecovery(this.credentials);}
  this.failure={...(conflict?this.failure:{}),code:reason,at:this.now()};
  return {phase:'failed',error_code:reason};
 }
 rollbackStored(previous,stored){
  const rollback=this.credentials.readAll();
  if(!isDeepStrictEqual(rollback.site_b,stored))bad('B_PAIRING_PARTIAL_COMMIT');
  if(previous)rollback.site_b=previous;else delete rollback.site_b;
  this.credentials.writeAll(rollback);
 }
 assertContext(attempt){
  const site=this.localStore.route('site'),selected=this.localStore.selection();
  if(!attempt||this.attemptGeneration!==attempt.attemptGeneration||
     this.transport?.epoch!==attempt.transportEpoch||selected.revision!==attempt.selectionRevision||
     site.binding_id!==attempt.previousBinding||site.generation!==attempt.previousGeneration||
     (attempt.previousConfigured!==undefined&&site.configured!==attempt.previousConfigured))
    bad('B_PAIRING_ATTEMPT_EXPIRED');
 }
 assertCurrent(attempt){
  if(!attempt||this.pending!==attempt||this.now()>attempt.expires_at)bad('B_PAIRING_ATTEMPT_EXPIRED');
  this.assertContext(attempt);
 }
 snapshot(){const v=this.localStore.snapshot(),pin=this.templatePin();let template=null;
  if(pin?.verified_source===true)try{const intent=this.localStore.activeIntent(this.credentials);
   if(intent)template=siteTemplateDescriptor(pin,intent.pairing_hash);}
   catch{template=null;}
  const phase=this.failure?'failed':this.pending?'pairing':v.routes.site.configured?'configured':'unconfigured';
  return {phase,replace_supported:!this.pending?.upgradeFailure,...this.replacementContext(),...(this.failure?.mismatch?{mismatch:this.failure.mismatch}:{}),...(this.failure?.conflict?{conflict:this.failure.conflict}:{}),...(this.failure?.next_action?{next_action:this.failure.next_action}:{}),origin:this.pending?.origin||this.localStore.siteOrigin(this.credentials)||null,error_code:this.failure?.code||null,updated_at:this.failure?.at||this.pending?.started_at||null,
   template_ready:pin?.verified_source===true,verified_template_source:template,
   target_site:this.pending?.site_id||v.routes.site.site_id||null,pending_until:this.pending?.expires_at||null,configured:v.routes.site.configured,
   healthy:v.routes.site.health_fresh,selected:v.selected,generation:v.routes.site.generation,
   transport_adapter_configured:!!this.transport&&['begin','complete','health'].every(k=>typeof this.transport[k]==='function'),secret_visible:false};}
 async importGrant(body,{nativeUI=false}={}){
  if(['chathand-site-v2','chathand-site-v3'].includes(body?.format))return this.importV2(body,{nativeUI});
  if(nativeUI!==true||!body||typeof body!=='object'||Array.isArray(body)||
     Object.keys(body).some(k=>!['site_id','site_origin','enrollment_grant'].includes(k))||
     typeof body.site_id!=='string'||!SITE.test(body.site_id)||
     typeof body.enrollment_grant!=='string'||!BASE64.test(body.enrollment_grant))bad('B_PAIRING_INPUT');
  // A signed target alone is not a working Site device transport. Reject
  // before accepting volatile grant material when production has no adapter.
  if(!this.transport||['begin','complete','health'].some(k=>typeof this.transport[k]!=='function'))bad('B_SITE_TRANSPORT_UNAVAILABLE');
  const attemptGeneration=++this.attemptGeneration;
  this.pending=null;this.failure=null; // A fresh enrollment instantly invalidates every earlier attempt.
  const origin=siteOrigin(body.site_origin);
  const previous=this.localStore.route('site'),selected=this.localStore.selection();
  const context=Object.freeze({attemptGeneration,transportEpoch:this.transport.epoch,
    previousBinding:previous.binding_id,previousGeneration:previous.generation,
    selectionRevision:selected.revision});
  const target=await this.resolveDeployment(body.site_id);
  this.assertContext(context);
  if(!target||target.verified!==true||target.site_id!==body.site_id||siteOrigin(target.site_origin)!==origin||
     typeof target.owner_subject!=='string'||!target.owner_subject||typeof target.site_public_key!=='string')
    bad('B_SITE_TARGET_UNVERIFIED');
  const pub=decodeUrl64(target.site_public_key,32);
  const key=crypto.generateKeyPairSync('ed25519'),deviceRaw=rawPublicFromKey(key.publicKey);
  this.assertContext(context);
  this.pending={site_id:body.site_id,origin,owner_subject:target.owner_subject,sitePublic:pub,
    grant:body.enrollment_grant,devicePrivate:key.privateKey,publicRaw:deviceRaw,publicId:keyId(deviceRaw),
    client_nonce:encodeUrl64(crypto.randomBytes(32)),expires_at:this.now()+600000,
    ...context};
  return {accepted:true,phase:'awaiting_pairing',configured:false,connected:false,secret_visible:false};
 }
 validateV2Input(body,{nativeUI=false}={}){
  if(nativeUI!==true||!body||typeof body!=='object'||Array.isArray(body)||
     Object.keys(body).some(k=>!['format','service_credential','site_id','site_origin','replacement_grant'].includes(k))||
     !['chathand-site-v2','chathand-site-v3'].includes(body.format)||
     body.replacement_grant!==undefined&&(typeof body.replacement_grant!=='string'||!BASE64.test(body.replacement_grant))||
     typeof body.site_id!=='string'||!SITE.test(body.site_id)||typeof body.site_origin!=='string'||
     typeof body.service_credential!=='string'||body.service_credential.length<32||body.service_credential.length>4096||
     /\s/.test(body.service_credential))bad('B_PAIRING_INPUT');
  const origin=siteOrigin(body.site_origin);
  if(!new URL(origin).hostname.endsWith('.chatgpt.site'))bad('B_ORIGIN_INVALID');
  const catalogue=this.templatePin();if(catalogue?.verified_source!==true)bad('B_TEMPLATE_UNVERIFIED');
  if(!this.transport||typeof this.transport.beginV2!=='function'||typeof this.transport.completeRecoveredV2!=='function')bad('B_SITE_TRANSPORT_UNAVAILABLE');
  const current=this.credentials.get('site_b'),route=this.localStore.route('site');
  const replacing=current?.trust==='tofu-template-v1'&&current.installation_id===this.installationId&&
   current.site_id===body.site_id&&current.site_origin===origin&&route.configured===1&&
   route.site_id===current.site_id&&route.binding_id===current.binding_id&&route.generation===current.generation&&
   route.owner_subject===current.owner_subject;
  const pin=replacing?(matchPinnedSiteTemplate(catalogue,current)||catalogue):catalogue;
  if(replacing){
   if(current.template_version!==pin.template_version||current.manifest_sha256!==pin.manifest_sha256)
    bad('B_TEMPLATE_MISMATCH');
  }else{
   if(this.localStore.pairRecovery(this.credentials))bad('B_PAIR_RECOVERY_PENDING');
   if(!this.localStore.activeIntent(this.credentials))bad('B_PAIRING_INTENT_MISSING');
  }
  return {origin,pin,replacing,current};
 }
 restoreV2Recovery(){
  if(this.failure&&!['B_SITE_REQUEST_TIMEOUT','B_SITE_NETWORK_FAILED','B_REMOTE_TRANSIENT'].includes(this.failure.code))return false;
  const recovered=this.localStore.pairRecovery(this.credentials);
  if(!recovered)return false;
  const {row,material:m}=recovered,catalogue=this.templatePin(),pin=matchPinnedSiteTemplate(catalogue,m.claim)||catalogue,route=this.localStore.route('site'),selected=this.localStore.selection();
  if(!pin?.verified_source||m.claim?.template_version!==pin.template_version||
     m.claim?.manifest_sha256!==pin.manifest_sha256||
     m.site_id!==row.site_id||m.claim?.site_id!==m.site_id||m.claim?.site_origin!==m.origin||
     m.claim?.installation_id!==this.installationId||m.claim?.pairing_id!==row.pairing_id||
     m.complete_body?.pairing_id!==row.pairing_id||m.complete_body?.claim_digest!==row.claim_digest||
     m.previous_binding!==route.binding_id||m.previous_generation!==route.generation||
     m.previous_configured!==route.configured||
     m.selection_revision!==selected.revision||
     !this.localStore.intentByHash(m.claim?.pairing_hash,this.credentials))
   bad('B_PAIR_RECOVERY_UNCONFIRMED');
  const claimBytes=pairBytes(m.claim),pub=decodeUrl64(m.claim.site_public_key,32);
  if(sha256(claimBytes)!==row.claim_digest||!edVerify(pub,claimBytes,m.site_signature))
   bad('B_PAIR_RECOVERY_UNCONFIRMED');
  const devicePrivate=crypto.createPrivateKey({key:Buffer.from(m.private_pkcs8,'base64url'),format:'der',type:'pkcs8'});
  const publicRaw=rawPublicFromKey(devicePrivate),intent=this.localStore.intentByHash(m.claim.pairing_hash,this.credentials);
  if(Object.keys(m.complete_body).sort().join(',')!==['protocol_version','pairing_id','claim_digest','device_signature','device_public_key','installation_id','intent_id','precreate_secret'].sort().join(',')||
     !['2','3'].includes(m.complete_body.protocol_version)||m.complete_body.protocol_version!==m.claim.protocol_version||m.claim.device_public_key_id!==keyId(publicRaw)||
     precreateHash(this.installationId,intent.intent_id,intent.secret)!==m.claim.pairing_hash||
     encodeUrl64(publicRaw)!==m.complete_body.device_public_key||
     m.complete_body.installation_id!==this.installationId||m.complete_body.intent_id!==intent.intent_id||
     m.complete_body.precreate_secret!==intent.secret||
     !edVerify(publicRaw,completeProofBytes(row.claim_digest,this.installationId,intent.intent_id,intent.secret),m.complete_body.device_signature))
   bad('B_PAIR_RECOVERY_UNCONFIRMED');
  this.pending={protocol_version:m.claim.protocol_version,recovery:true,recovery_claim:m.claim,completeBody:m.complete_body,
   site_id:m.site_id,origin:m.origin,bearer:m.bearer,devicePrivate,publicRaw,publicId:keyId(publicRaw),
   expires_at:row.expires_at,started_at:this.now(),attemptGeneration:++this.attemptGeneration,
   transportEpoch:this.transport.epoch,previousBinding:m.previous_binding,previousGeneration:m.previous_generation,
   previousConfigured:m.previous_configured,selectionRevision:m.selection_revision,pin};
  return true;
 }
 async importV2(body,{nativeUI=false}={}){
  const {origin,pin,replacing,current}=this.validateV2Input(body,{nativeUI});
  if(body.replacement_grant)bad('B_REBIND_CONFLICT_REQUIRED');
  this.failure=null;
  let continuity=null;
  if(replacing){
   const generation=this.attemptGeneration;
   try{return await this.updateCredentialV2(body,current);}catch(error){
    if(this.attemptGeneration!==generation)throw error;
    if(!supportsBinding(pin,this.transport)){this.failure={code:'B_REBIND_UNSUPPORTED',at:this.now(),next_action:'update_site_template'};bad('B_REBIND_UNSUPPORTED');}
    if(error?.code==='B_BINDING_REPLACED'){this.failure={code:error.code,at:this.now(),next_action:'create_new_site'};throw error;}
    continuity=current;this.localStore.ensureIntent(this.credentials);
   }
  }
  if(body.replacement_grant&&!supportsBinding(pin,this.transport)){this.failure={code:'B_REBIND_UNSUPPORTED',at:this.now(),next_action:'update_site_template'};bad('B_REBIND_UNSUPPORTED');}

  const previous=this.localStore.route('site'),selected=this.localStore.selection(),attemptGeneration=++this.attemptGeneration;
  this.pending=null;this.failure=null;
  const key=crypto.generateKeyPairSync('ed25519'),publicRaw=rawPublicFromKey(key.publicKey);
  this.pending={protocol_version:supportsBinding(pin,this.transport)?'3':'2',continuity,replacement_grant:body.replacement_grant,site_id:body.site_id,origin,bearer:body.service_credential,
   devicePrivate:key.privateKey,publicRaw,publicId:keyId(publicRaw),client_nonce:encodeUrl64(crypto.randomBytes(32)),
   expires_at:this.now()+600000,started_at:this.now(),attemptGeneration,transportEpoch:this.transport.epoch,
   previousBinding:previous.binding_id,previousGeneration:previous.generation,previousConfigured:previous.configured,
   selectionRevision:selected.revision,pin};
  return {accepted:true,phase:'pairing',origin};
 }
 async updateCredentialV2(body,saved){
  if(this.localStore.siteCommit())bad('B_SITE_COMMIT_PENDING');
  const before=this.localStore.route('site'),epoch=this.transport.epoch,generation=this.attemptGeneration;
  const nonce=encodeUrl64(crypto.randomBytes(32));
  const requestBytes=Buffer.from(JSON.stringify(['chathand-site-health-v2',saved.site_id,saved.binding_id,
   String(saved.generation),this.installationId,nonce]));
  const response=await this.transport.healthWithBearer({protocol_version:'2',site_id:saved.site_id,
   binding_id:saved.binding_id,generation:saved.generation,installation_id:this.installationId,nonce,
   device_signature:edSign(crypto.createPrivateKey({key:Buffer.from(saved.private_pkcs8,'base64url'),type:'pkcs8',format:'der'}),requestBytes),
   device_credential:saved.device_credential},{site_id:saved.site_id,origin:saved.site_origin,bearer:body.service_credential});
  verifyHealthAck(saved,response,{nonce,installationId:this.installationId,templatePin:matchPinnedSiteTemplate(this.templatePin(),saved)||this.templatePin()});
  this.transport.noteAuthenticatedSuccess?.(epoch);
  const latest=this.credentials.get('site_b'),route=this.localStore.route('site');
  if(this.attemptGeneration!==generation||this.transport.epoch!==epoch||
     latest?.binding_id!==saved.binding_id||latest?.generation!==saved.generation||
     route.binding_id!==before.binding_id||route.generation!==before.generation||
     this.localStore.siteCommit())bad('B_HEALTH_LIFECYCLE_CHANGED');
  this.transport.stop();
  const all=this.credentials.readAll();
  if(all.site_b?.binding_id!==saved.binding_id||all.site_b?.generation!==saved.generation)
   bad('B_HEALTH_LIFECYCLE_CHANGED');
  all.site_b_machine={format:1,site_id:saved.site_id,site_origin:saved.site_origin,bearer:body.service_credential};
  this.credentials.writeAll(all);
  this.localStore.health('site',{state:'reconnecting',verified:true,generation:saved.generation});
  this.transport.start();
  return {accepted:true,phase:'credential_updated',origin:saved.site_origin};
 }
 replacementContext(){
  const p=this.pending;if(p?.recovery&&p.recovery_claim?.binding_mode==='owner_replace')return {replacement:{next_action:'resume_pairing',recovery_pending:true}};
  const c=this.failure?.conflict||p?.conflict;if(!p||!c||!p.question_id||this.now()>=p.question_expires_at)return {};
  const context={installation_id:this.installationId,pairing_hash:c.pairing_hash,expected_bindings:c.expected_bindings,public_key_id:p.publicId,client_nonce:p.client_nonce,question_id:p.question_id,question_expires_at:p.question_expires_at};
  return {question_id:p.question_id,question_expires_at:p.question_expires_at,replacement:{next_action:p.replacement_grant&&['B_SITE_REQUEST_TIMEOUT','B_SITE_NETWORK_FAILED','B_REMOTE_TRANSIENT'].includes(this.failure?.code)?'resume_pairing':p.upgradeFailure?'choose_connection':supportsOwnerRebind(p.pin)?'authorize_replacement':'update_site_template',...(p.upgradeFailure?{upgrade_failure:p.upgradeFailure}:{}),...(!p.upgradeFailure&&supportsOwnerRebind(p.pin)?{authorization_url:p.origin+'/owner/rebind#'+encodeURIComponent(JSON.stringify(context))}:{})}};
 }
 recordReplacementUpgradeFailure(body){
  const p=this.pending;if(!p||this.failure?.code!=='B_BINDING_CONFLICT')bad('B_REBIND_CONFLICT_REQUIRED');this.assertCurrent(p);
  if(!body||Object.keys(body).sort().join(',')!==['origin','question_id','phase','error_code','version_id','deployment_id'].sort().join(',')||body.origin!==p.origin||body.question_id!==p.question_id||this.now()>=p.question_expires_at||body.phase!=='failed'||!/^B_[A-Z0-9_]{1,60}$/.test(body.error_code||'')||!['version_id','deployment_id'].every(k=>typeof body[k]==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(body[k])))bad('B_REBIND_UPGRADE_RECEIPT_INVALID');
  p.upgradeFailure={...body};p.replacement_grant=undefined;p.question_id=crypto.randomUUID();p.question_expires_at=Math.min(p.expires_at,this.now()+600000);
  return this.snapshot();
 }
 async authorizeReplacement(body,{nativeUI=false}={}){
  if(nativeUI!==true||!body||Object.keys(body).join(',')!=='replacement_grant'||!BASE64.test(body.replacement_grant||''))bad('B_REBIND_INPUT');
  if(!this.pending)bad('B_REBIND_CONFLICT_REQUIRED');
  const p=this.stage();this.assertCurrent(p);
  if(p.upgradeFailure)bad('B_REBIND_CONFLICT_REQUIRED');
  if(!supportsOwnerRebind(p.pin))bad('B_REBIND_UNSUPPORTED');
  if(!p.question_id||this.now()>=p.question_expires_at)bad('B_GRANT_EXPIRED');
  if(p.protocol_version!=='3'||!(this.failure?.code==='B_BINDING_CONFLICT'||p.replacement_grant===body.replacement_grant&&['B_SITE_REQUEST_TIMEOUT','B_SITE_NETWORK_FAILED','B_REMOTE_TRANSIENT'].includes(this.failure?.code))||p.recovery||this.pairingInFlight)bad('B_REBIND_CONFLICT_REQUIRED');
  p.replacement_grant=body.replacement_grant;this.failure=null;
  return this.pairV2();
 }
 async pairV2(options={}){
  if(this.pairingInFlight&&this.pairingInFlightAttempt===this.pending)return this.pairingInFlight;
  const attempt=this.pending,task=this.pairV2Once(options);this.pairingInFlight=task;this.pairingInFlightAttempt=attempt;
  try{return await task;}finally{if(this.pairingInFlight===task){this.pairingInFlight=null;this.pairingInFlightAttempt=null;}}
 }
 async pairV2Once({transport=this.transport}={}){
  const p=this.stage();if(!['2','3'].includes(p.protocol_version))bad('B_PAIRING_INPUT');
  this.failure=null;
  this.assertCurrent(p);
  let receiptVerified=false;
  try{
   let claim,digest,completeBody;
   if(p.recovery){
    claim=p.recovery_claim;completeBody=p.completeBody;digest=completeBody.claim_digest;
   }else{
    const beginBody={protocol_version:p.protocol_version,site_id:p.site_id,site_origin:p.origin,
     installation_id:this.installationId,public_key:encodeUrl64(p.publicRaw),public_key_id:p.publicId,client_nonce:p.client_nonce};
    if(p.protocol_version==='3'){
     const intent=this.localStore.activeIntent(this.credentials);if(!intent)bad('B_PAIRING_INTENT_MISSING');
     beginBody.pairing_hash=intent.pairing_hash;beginBody.device_name=cleanName(this.deviceName());
     if(p.replacement_grant)Object.assign(beginBody,{replacement_grant:p.replacement_grant,question_id:p.question_id,question_expires_at:p.question_expires_at});
     if(p.continuity){const old=p.continuity,fields=['chathand-site-continuity-v3',p.site_id,p.origin,old.binding_id,String(old.generation),old.installation_id,this.installationId,p.publicId,intent.pairing_hash,p.client_nonce,beginBody.device_name];
      beginBody.continuity={binding_id:old.binding_id,generation:old.generation,installation_id:old.installation_id,device_credential:old.device_credential,
       device_signature:edSign(crypto.createPrivateKey({key:Buffer.from(old.private_pkcs8,'base64url'),type:'pkcs8',format:'der'}),Buffer.from(JSON.stringify(fields)))};
     }
    }
    const beginEpoch=transport.epoch;
    const begun=await transport.beginV2(beginBody,{site_id:p.site_id,origin:p.origin,bearer:p.bearer});
    this.assertCurrent(p);
    if(begun?.conflict){
     const c=begun.conflict,keys=['protocol_version','site_id','site_origin','owner_subject','installation_id','public_key_id','pairing_hash','client_nonce','expected_bindings','device_name','last_used','template_version','manifest_sha256','site_public_key'];
     if(p.protocol_version!=='3'||Object.keys(c).sort().join(',')!==keys.sort().join(',')||c.site_id!==p.site_id||c.site_origin!==p.origin||c.installation_id!==this.installationId||c.public_key_id!==p.publicId||c.pairing_hash!==beginBody.pairing_hash||c.client_nonce!==p.client_nonce||!matchPinnedSiteTemplate(this.templatePin(),c)||!(c.last_used===null||Number.isSafeInteger(c.last_used)&&c.last_used>0)||!(c.device_name===null||cleanName(c.device_name)===c.device_name)||typeof c.expected_bindings!=='string'||c.expected_bindings.length>4096||!edVerify(decodeUrl64(c.site_public_key,32),Buffer.from(JSON.stringify(['chathand-site-binding-conflict-v3',c])),begun.site_signature))bad('B_BINDING_CONFLICT_UNVERIFIED');
     p.pin=matchPinnedSiteTemplate(this.templatePin(),c);
     // A fresh conflict invalidates any grant from a previous question/attempt.
     p.replacement_grant=undefined;p.question_id=crypto.randomUUID();p.question_expires_at=Math.min(p.expires_at,this.now()+600000);p.upgradeFailure=null;
     const conflict={device_name:c.device_name||null,last_used:c.last_used,expected_bindings:c.expected_bindings,installation_id:this.installationId,pairing_hash:c.pairing_hash};p.conflict=conflict;
     throw Object.assign(Error('B_BINDING_CONFLICT'),{code:'B_BINDING_CONFLICT',conflict,next_action:'choose_connection'});
    }
    claim=begun?.claim;
    if(!claim)mismatch('claim');
    for(const [field,value]of Object.entries({protocol_version:p.protocol_version,site_id:p.site_id,site_origin:p.origin,installation_id:this.installationId,device_public_key_id:p.publicId,client_nonce:p.client_nonce,template_version:p.pin.template_version,manifest_sha256:p.pin.manifest_sha256}))if(claim[field]!==value)mismatch(field);
    if(!this.localStore.intentByHash(claim.pairing_hash,this.credentials))mismatch('pairing_intent');
    if(p.protocol_version==='3'&&claim.device_name!==beginBody.device_name)mismatch('device_name');
    const bytes=pairBytes(claim,{now:Math.floor(this.now()/1000)}),publicKey=decodeUrl64(claim.site_public_key,32);
    if(!edVerify(publicKey,bytes,begun.site_signature))bad('B_PAIRING_SIGNATURE');
    const intent=this.localStore.intentByHash(claim.pairing_hash,this.credentials);digest=sha256(bytes);
    if(!intent)bad('B_PAIRING_INTENT_MISSING');
    transport.noteAuthenticatedSuccess?.(beginEpoch);
    completeBody={protocol_version:p.protocol_version,pairing_id:claim.pairing_id,claim_digest:digest,
     device_signature:edSign(p.devicePrivate,completeProofBytes(digest,this.installationId,intent.intent_id,intent.secret)),
     device_public_key:encodeUrl64(p.publicRaw),installation_id:this.installationId,intent_id:intent.intent_id,
     precreate_secret:intent.secret};
    const recoveryUntil=Math.min(intent.expires_at,this.now()+82800000);
    this.localStore.stagePairRecovery({pairing_id:claim.pairing_id,intent_id:intent.intent_id,claim_digest:digest,
     site_id:p.site_id,expires_at:recoveryUntil},{pairing_id:claim.pairing_id,claim_digest:digest,
     claim,site_signature:begun.site_signature,complete_body:completeBody,site_id:p.site_id,origin:p.origin,bearer:p.bearer,
     private_pkcs8:p.devicePrivate.export({format:'der',type:'pkcs8'}).toString('base64url'),
     previous_binding:p.previousBinding,previous_generation:p.previousGeneration,
     previous_configured:p.previousConfigured,selection_revision:p.selectionRevision},this.credentials);
    p.recovery=true;p.recovery_claim=claim;p.completeBody=completeBody;p.expires_at=recoveryUntil;
   }
   const publicKey=decodeUrl64(claim.site_public_key,32);
   const intent=this.localStore.intentByHash(claim.pairing_hash,this.credentials);
   if(!intent)bad('B_PAIRING_INTENT_MISSING');
   let response,responseEpoch;
   for(let n=0;n<2;n++){
    responseEpoch=transport.epoch;
    try{response=await transport.completeRecoveredV2(completeBody,{site_id:p.site_id,origin:p.origin,bearer:p.bearer});break;}
    catch(error){if(n===1||!['B_SITE_REQUEST_TIMEOUT','B_SITE_NETWORK_FAILED','B_REMOTE_TRANSIENT'].includes(error?.code))throw error;
     this.assertCurrent(p);}
   }
   this.assertCurrent(p);
   if(!response||response.protocol_version!==p.protocol_version||response.site_id!==p.site_id||
      response.owner_subject!==claim.owner_subject||response.installation_id!==this.installationId||
      response.pairing_id!==claim.pairing_id||!isUUID(response.binding_id)||
      !Number.isSafeInteger(response.generation)||response.generation<1||
      response.template_version!==p.pin.template_version||response.manifest_sha256!==p.pin.manifest_sha256)bad('B_PAIRING_RECEIPT');
   const signed=receiptBytesV2({...response,claim_digest:digest});
   if(!edVerify(publicKey,signed,response.site_signature))bad('B_PAIRING_RECEIPT_SIGNATURE');
   receiptVerified=true;
   const prev=this.credentials.get('site_b');
   if(prev?.site_id===p.site_id&&prev.site_public_key===claim.site_public_key&&response.generation<=prev.generation)
    bad('B_PAIRING_GENERATION_ROLLBACK');
   transport.noteAuthenticatedSuccess?.(responseEpoch);
   const stored={format:2,trust:'tofu-template-v1',site_id:p.site_id,site_origin:p.origin,owner_subject:claim.owner_subject,
    installation_id:this.installationId,device_public_key:encodeUrl64(p.publicRaw),device_public_key_id:p.publicId,
    private_pkcs8:p.devicePrivate.export({format:'der',type:'pkcs8'}).toString('base64url'),
    device_credential:response.device_credential,binding_id:response.binding_id,generation:response.generation,
    result_key:encodeUrl64(crypto.randomBytes(32)),site_public_key:claim.site_public_key,
    receipt_digest:response.receipt_digest,template_version:claim.template_version,manifest_sha256:claim.manifest_sha256};
   this.assertCurrent(p);
   this.localStore.prepareSiteCommit({intent_id:intent.intent_id,site_id:p.site_id,owner_subject:claim.owner_subject,
    binding_id:response.binding_id,generation:response.generation,previous_binding:p.previousBinding,
    previous_generation:p.previousGeneration,previous_configured:p.previousConfigured,
    selection_revision:p.selectionRevision});
   try{
    const all=this.credentials.readAll();all.site_b_stage=stored;
    all.site_b_machine_stage={site_id:p.site_id,site_origin:p.origin,bearer:p.bearer,format:1};
    this.credentials.writeAll(all);
    this.localStore.decideSiteCommit({intent_id:intent.intent_id,site_id:p.site_id,site_origin:p.origin,owner_subject:claim.owner_subject,
     binding_id:response.binding_id,generation:response.generation,site_public_key:claim.site_public_key});
    this.localStore.recoverSiteCommit(this.credentials);
   }catch(error){try{this.localStore.recoverSiteCommit(this.credentials);}catch{}throw error;}
   this.localStore.clearPairRecovery(this.credentials,claim.pairing_id);
   this.pending=null;this.attemptGeneration++;
   return this.verifyHealth({transport});
  }catch(error){
   // A stopped request may still settle after a switch or a fresh attempt.
   // Its error must not resurrect Build Site or overwrite the new failure.
   if(this.pending!==p||this.attemptGeneration!==p.attemptGeneration)throw error;
   this.failure={code:String(error?.code||'B_PAIRING_FAILED').slice(0,80),at:this.now(),...(error?.mismatch?{mismatch:error.mismatch}:{}),...(error?.conflict?{conflict:error.conflict}:{}),...(error?.next_action?{next_action:error.next_action}:{}),...(error?.code==='B_REBIND_UNSUPPORTED'?{next_action:'update_site_template'}:error?.code==='B_REBIND_OWNER_REQUIRED'||error?.mismatch==='pairing_intent'?{next_action:'create_new_site'}:{})};
   const transient=['B_SITE_REQUEST_TIMEOUT','B_SITE_NETWORK_FAILED','B_REMOTE_TRANSIENT'].includes(error?.code);
   if(this.pending===p&&error?.code!=='B_BINDING_CONFLICT'&&!transient&&(!p.recovery||!receiptVerified)){
    if(p.recovery)try{this.localStore.cancelPairRecovery(this.credentials);}catch{}
    this.pending=null;this.attemptGeneration++;
   }
   throw error;
  }
 }
 stage(){if(!this.pending||this.now()>this.pending.expires_at){this.pending=null;this.attemptGeneration++;bad('B_GRANT_EXPIRED');}return this.pending;}
 async pair({transport=this.transport}={}){
  const p=this.stage();if(!transport||typeof transport.begin!=='function'||typeof transport.complete!=='function'||typeof transport.health!=='function')
    bad('B_SITE_TRANSPORT_UNAVAILABLE');
  this.assertCurrent(p);
  const begun=await transport.begin({site_id:p.site_id,site_origin:p.origin,installation_id:this.installationId,
    public_key:encodeUrl64(p.publicRaw),public_key_id:p.publicId,client_nonce:p.client_nonce,enrollment_grant:p.grant});
  this.assertCurrent(p);
  const claim=begun?.claim,signature=begun?.site_signature;
  if(!claim)mismatch('claim');
  for(const [field,value]of Object.entries({protocol_version:'1',site_id:p.site_id,site_origin:p.origin,owner_subject:p.owner_subject,installation_id:this.installationId,device_public_key_id:p.publicId,client_nonce:p.client_nonce}))if(claim[field]!==value)mismatch(field);
  const bytes=pairingBytes(claim,{now:Math.floor(this.now()/1000)});
  if(!edVerify(p.sitePublic,bytes,signature))bad('B_PAIRING_SIGNATURE');
  const digest=pairingDigest(claim);
  const response=await transport.complete({pairing_id:claim.pairing_id,claim_digest:digest,
    device_signature:edSign(p.devicePrivate,bytes),device_public_key:encodeUrl64(p.publicRaw)});
  this.assertCurrent(p);
  if(!response||response.site_id!==p.site_id||response.owner_subject!==p.owner_subject||
     response.installation_id!==this.installationId||response.pairing_id!==claim.pairing_id||
     !isUUID(response.binding_id)||!Number.isInteger(response.generation)||response.generation<1||
     typeof response.device_credential!=='string'||!BASE64.test(response.device_credential)||
     typeof response.receipt_digest!=='string'||!/^[a-f0-9]{64}$/.test(response.receipt_digest))bad('B_PAIRING_RECEIPT');
  const receiptBytes=Buffer.from(JSON.stringify(['chathand-site-pair-receipt-v1',digest,response.binding_id,
    String(response.generation),response.receipt_digest,response.owner_subject,response.site_id,this.installationId]),'utf8');
  if(!edVerify(p.sitePublic,receiptBytes,response.site_signature))bad('B_PAIRING_RECEIPT_SIGNATURE');
  if(p.previousBinding&&response.generation<=p.previousGeneration)bad('B_PAIRING_GENERATION_ROLLBACK');
  const stored={format:1,site_id:p.site_id,site_origin:p.origin,owner_subject:p.owner_subject,
    installation_id:this.installationId,device_public_key:encodeUrl64(p.publicRaw),device_public_key_id:p.publicId,
    private_pkcs8:p.devicePrivate.export({format:'der',type:'pkcs8'}).toString('base64url'),
    device_credential:response.device_credential,binding_id:response.binding_id,generation:response.generation,
    result_key:encodeUrl64(crypto.randomBytes(32)),site_public_key:encodeUrl64(p.sitePublic),receipt_digest:response.receipt_digest};
  // The local encrypted credential store and SQLite are both synchronous. Validate attempt and expected
  // binding immediately before the uninterrupted local commit. If the second
  // write fails, an inactive candidate must not become the startup binding.
  this.assertCurrent(p);
  const previous=this.credentials.get('site_b');
  try{
   this.credentials.set('site_b',stored);
   this.localStore.configureSite({site_id:p.site_id,owner_subject:p.owner_subject,
    binding_id:response.binding_id,generation:response.generation},{authenticated:true});
  }catch(error){
   const route=this.localStore.route('site'),latest=this.credentials.get('site_b');
   if((route.binding_id!==response.binding_id||route.generation!==response.generation)&&
      latest?.binding_id===response.binding_id&&latest.generation===response.generation){
    try{this.rollbackStored(previous,stored);}
    catch{bad('B_PAIRING_PARTIAL_COMMIT');}
   }
   throw error;
  }
  if(this.pending===p){this.pending=null;this.attemptGeneration++;}
  // Health may fail, but a partially paired route is not marked healthy.
  return this.verifyHealth({transport});
 }
 async verifyHealth({transport=this.transport,select=true}={}){
  if(!transport||typeof transport.health!=='function')bad('B_SITE_TRANSPORT_UNAVAILABLE');
  const saved=this.credentials.get('site_b');if(!saved||saved.installation_id!==this.installationId)bad('B_PAIRING_MISSING');
  const originalGeneration=this.attemptGeneration,originalEpoch=transport.epoch;
  const before=this.localStore.route('site');
  if(before.binding_id!==saved.binding_id||before.generation!==saved.generation)bad('B_PAIRING_BINDING_STALE');
  const v2=saved.trust==='tofu-template-v1',catalogue=v2?this.templatePin():null;
  let pin=v2?(matchPinnedSiteTemplate(catalogue,saved)||catalogue):null;
  if(v2&&!pin?.verified_source)bad('B_TEMPLATE_MISMATCH');
  let drift=v2&&(pin.template_version!==saved.template_version||pin.manifest_sha256!==saved.manifest_sha256);
  const initialDrift=drift;
  if(drift)this.localStore.health('site',{state:'failed',verified:true,generation:saved.generation,reason:'B_TEMPLATE_MISMATCH'});
  const nonce=encodeUrl64(crypto.randomBytes(32)),kind=v2?'chathand-site-health-v2':'chathand-site-health-v1';
  const requestBytes=Buffer.from(JSON.stringify([kind,saved.site_id,saved.binding_id,String(saved.generation),this.installationId,nonce]));
  const response=await transport.health({...(v2?{protocol_version:'2'}:{}),site_id:saved.site_id,binding_id:saved.binding_id,
    generation:saved.generation,installation_id:this.installationId,nonce,
    device_signature:edSign(crypto.createPrivateKey({key:Buffer.from(saved.private_pkcs8,'base64url'),type:'pkcs8',format:'der'}),requestBytes),
    device_credential:saved.device_credential});
  const current=this.credentials.get('site_b'),after=this.localStore.route('site');
  if(originalGeneration!==this.attemptGeneration||originalEpoch!==transport.epoch||
     !current||current.binding_id!==saved.binding_id||current.generation!==saved.generation||
     current.device_credential!==saved.device_credential||
     after.binding_id!==saved.binding_id||after.generation!==saved.generation)
    bad('B_HEALTH_LIFECYCLE_CHANGED');
  if(v2){pin=matchPinnedSiteTemplate(catalogue,response)||pin;
   drift=pin.template_version!==saved.template_version||pin.manifest_sha256!==saved.manifest_sha256;
   if(!matchPinnedSiteTemplate(this.templatePin(),pin))bad('B_TEMPLATE_MISMATCH');}
  try{verifyHealthAck(saved,response,{nonce,installationId:this.installationId,templatePin:pin,
   allowTemplatePromotion:v2});}
  catch(error){if(error?.code==='B_TEMPLATE_MISMATCH')this.localStore.health('site',{state:'failed',verified:true,
   generation:saved.generation,reason:'B_TEMPLATE_MISMATCH'});throw error;}
  if(drift){
   if(!initialDrift)this.localStore.health('site',{state:'failed',verified:true,generation:saved.generation,reason:'B_TEMPLATE_MISMATCH'});
   this.localStore.promoteSiteTemplate(this.credentials,saved,pin);
  }
  transport.noteAuthenticatedSuccess?.(originalEpoch);
  this.localStore.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:saved.generation});
  const switched=select?this.localStore.switchConfiguredSiteIfFailed():{changed:false};
  // Only after the signed Site health ACK can the transport begin bounded polling.
  if(transport===this.transport&&typeof transport?.start==='function')transport.start();
  return {paired:true,configured:true,health:'healthy',selected:this.localStore.selection().selected,
    ...(switched.changed?{switch_event_id:switched.event_id,switched:true}:{switched:false}),secret_visible:false};
 }
 forget({binding_id,generation}={}){
  this.localStore.beginSiteForget(this.credentials,{binding_id,generation,authenticatedNative:true});
  this.transport?.stop();this.close();this.localStore.recoverSiteForget(this.credentials);
  this.failure={code:'B_PAIRING_ABANDONED',at:this.now()};return {forgotten:true,selected:this.localStore.selection().selected};
 }
 cancelV2Recovery(){
  this.close();
  this.localStore.cancelPairRecovery(this.credentials);
 }
 close(){this.attemptGeneration++;this.pending=null;}
}
