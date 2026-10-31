/** ONE1052 ChatGPT Site B production HTTPS client.
 * Fixed deployment pin + distinct machine bearer + signed device identity.
 * Never opens a public Mac ingress or returns secret request/error text.
 * Runnable only after a root-authorized private Site deployment and hidden
 * machine credential import. No default credentials or fake healthy state.
 */
import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
import {siteOrigin,decodeUrl64,encodeUrl64,edSign,edVerify,verifiedSiteJob,canonicalArguments,sha256,verifyHealthAck,bindingReplacedBytes} from './b-site-wire.mjs';
import {bundledSiteTarget} from './b-site-trust.mjs';
import {readPinnedSiteTemplate,matchPinnedSiteTemplate} from './site-template-pin.mjs';
import {siteRequestErrorCode} from './site-request-errors.mjs';

const bad=(code='B_TRANSPORT_UNAVAILABLE')=>fail(code,'Site 设备通道尚未通过认证或本机配置。');
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const ENDPOINTS=Object.freeze({templateHealth:'/health',begin:'/pair/begin',complete:'/pair/complete',health:'/device/health',
 next:'/device/next',result:'/device/result',revoke:'/device/revoke'});
// An absent/unknown version is not proof of an old template. This observation
// affects error guidance only; signed claims still enforce the packaged pin.
const LEGACY_BINDING_TEMPLATES=new Set(['1052-site-b-v3','1061-site-b-v4','1068-site-b-v5']);
const MAX_RESPONSE=72*1024,MAX_REQUEST=72*1024;
const SITE_CREDENTIAL_SCOPE=Object.freeze(['site_b','site_b_machine']);
const sleep=(delay,fn)=>setTimeout(fn,delay);
function privateKey(saved){
 try{return crypto.createPrivateKey({key:decodeUrl64(saved.private_pkcs8),format:'der',type:'pkcs8'});}
 catch{bad('B_DEVICE_KEY_INVALID');}
}
function devicePayload(saved,kind,nonce,extra=[]){
 const fields=[kind,saved.site_id,saved.binding_id,String(saved.generation),saved.installation_id,nonce,...extra];
 return {site_id:saved.site_id,binding_id:saved.binding_id,generation:saved.generation,
  installation_id:saved.installation_id,nonce,
  device_credential:saved.device_credential,
  device_signature:edSign(privateKey(saved),Buffer.from(JSON.stringify(fields)))};
}
function matchesIdentity(saved,local){
 const site=local.route('site');
 return site.configured===1&&site.site_id===saved.site_id&&site.binding_id===saved.binding_id&&
  site.owner_subject===saved.owner_subject&&site.generation===saved.generation;
}
function publicKey(saved){return decodeUrl64(saved.site_public_key,32);}
function verifySigned(saved,array,sig,code){
 if(!edVerify(publicKey(saved),Buffer.from(JSON.stringify(array)),sig))bad(code);
}
export class BSiteHttpTransport{
 get bindingProtocolVersion(){return 3;}
 constructor({installationId,credentials,localStore,resolveDeployment=bundledSiteTarget,fetchImpl=globalThis.fetch,
  clock=Date.now,setTimeoutFn=sleep,clearTimeoutFn=clearTimeout,autoPoll=true,templatePin=readPinnedSiteTemplate,onBindingReplaced=()=>{},onNetworkChallenge=()=>{},onNetworkChallengeCleared=()=>{}}={}){
  if(!UUID.test(installationId)||!credentials||!localStore||typeof resolveDeployment!=='function'||typeof fetchImpl!=='function')bad('B_TRANSPORT_CONFIG');
  Object.assign(this,{installationId,credentials,localStore,resolveDeployment,fetchImpl,clock,setTimeoutFn,clearTimeoutFn,autoPoll,templatePin,onBindingReplaced,onNetworkChallenge,onNetworkChallengeCleared});
  this.replacementWriter=localStore.issueBindingReplacementWriter?.()||null;
  this.epoch=0;this.running=false;this.pending=new Set();this.timer=null;this.deliver=null;this.pendingPairSite=null;
  this.networkChallenge=null;this.failures=0;this.lastErrorCode=null;this.lastVerifiedAt=null;this.hostFlow=null;
 }
 acceptBindingReplacement(saved,response,nonce,epoch){
  if(!response?.binding_replaced)return false;
  const n=response.binding_replaced,bytes=bindingReplacedBytes(n);
  if(epoch!==this.epoch||n.site_id!==saved.site_id||n.owner_subject!==saved.owner_subject||n.installation_id!==this.installationId||n.binding_id!==saved.binding_id||n.generation!==saved.generation||n.nonce!==nonce||!edVerify(publicKey(saved),bytes,response.signature))bad('B_REPLACEMENT_UNVERIFIED');
  const latest=this.credentials.get('site_b');
  if(latest?.binding_id!==saved.binding_id||latest?.generation!==saved.generation||latest?.device_credential!==saved.device_credential||!matchesIdentity(saved,this.localStore)||!this.replacementWriter)bad('B_LIFECYCLE_CHANGED');
  this.replacementWriter(n);this.hostFlow?.invalidate();this.onBindingReplaced?.();
  bad('B_BINDING_REPLACED');
 }
 noteNetworkResponse(status,headers,epoch=this.epoch){
  if(epoch!==this.epoch)return false;
  const mitigated=typeof headers?.get==='function'?headers.get('cf-mitigated'):headers?.['cf-mitigated'];
  if(status!==403||mitigated!=='challenge')return false;
  this.networkChallenge={at:this.clock(),transport_epoch:epoch};
  try{this.onNetworkChallenge({...this.networkChallenge});}catch{}
  return true;
 }
 noteAuthenticatedSuccess(epoch=this.epoch){
  if(epoch!==this.epoch)return;
  this.networkChallenge=null;
  try{this.onNetworkChallengeCleared({at:this.clock(),transport_epoch:epoch});}catch{}
 }
 stageStatus(){return {...this.linkState(),transport_epoch:this.epoch,network_challenge:this.networkChallenge};}
 setHostFlow({metadataForResult,invalidate}={}){
  if(this.hostFlow||typeof metadataForResult!=='function'||typeof invalidate!=='function')
   bad('B_HOST_TRANSPORT_BINDING');
  // Not exposed through HTTP, credentials, statuses or general tool dispatch.
  this.hostFlow=Object.freeze({metadataForResult,invalidate});
 }
 setDelivery(fn){if(typeof fn!=='function'||this.deliver)bad('B_TRANSPORT_DELIVERY_INVALID');this.deliver=fn;}
 linkState(){return {phase:this.running?'running':'unconfigured_or_stopped',last_error_code:this.lastErrorCode};}
 status(){
  // The snapshot is intentionally nonsensitive and must never leak bearer.
  const machine=!!this.credentials.status?.().site_b_machine;
  return {factory:'bounded_https_v1',machine_configured:machine,running:this.running,
   authenticated:!!this.lastVerifiedAt,last_verified_at:this.lastVerifiedAt,
   ...this.linkState(),transport_epoch:this.epoch,network_challenge:this.networkChallenge};
 }
 machine(target){
  const session=this.sessionMaterial;
  const material=session&&this.credentialCurrent(session.saved)===true?session.machine:this.credentials.get('site_b_machine');
  if(!material||material.site_id!==target.site_id||material.site_origin!==target.site_origin||
    typeof material.bearer!=='string'||material.bearer.length<32||material.bearer.length>4096||
    /\s/.test(material.bearer))bad('B_MACHINE_CREDENTIAL_UNCONFIGURED');
  return material.bearer;
 }
 async target(id){
  if(typeof id!=='string')bad('B_TARGET_INVALID');
  const target=await this.resolveDeployment(id);
  if(!target||target.verified!==true||target.site_id!==id||typeof target.owner_subject!=='string'||
   typeof target.site_public_key!=='string'||siteOrigin(target.site_origin)!==target.site_origin)
   bad('B_SITE_TARGET_UNVERIFIED');
  decodeUrl64(target.site_public_key,32);
  return target;
 }
 abortPending(){
  for(const c of this.pending)try{c.abort();}catch{}
  this.pending.clear();
 }
 stop(){
  this.sessionMaterial=null;this.running=false;this.epoch++;this.networkChallenge=null;this.pendingPairSite=null;this.lastVerifiedAt=null;
  this.hostFlow?.invalidate();
  if(this.timer!==null){this.clearTimeoutFn(this.timer);this.timer=null;}
  this.abortPending();
 }
 current(saved,epoch,{healthOnly=false}={}){
  const proof=this.credentialCurrent(saved);
  if(proof===false||this.sessionMaterial?.saved===saved&&proof!==true){this.sessionMaterial=null;if(this.sessionController){this.sessionController.credentialChanged=true;this.sessionController.abort();}bad('B_LIFECYCLE_CHANGED');}
  if(!healthOnly)this.assertTemplate(saved);
  if(!this.running||epoch!==this.epoch||saved?.installation_id!==this.installationId||
   !matchesIdentity(saved,this.localStore))bad('B_LIFECYCLE_CHANGED');
  const session=this.sessionMaterial;
  if(session?.saved===saved&&session.revision&&proof===true)return;
  const newest=this.credentials.get('site_b');
  if(!newest||newest.binding_id!==saved.binding_id||newest.generation!==saved.generation||
    newest.device_credential!==saved.device_credential)bad('B_LIFECYCLE_CHANGED');
 }
 credentialCurrent(saved){
  if(typeof this.credentials.isCurrentScope==='function')return this.credentials.isCurrentScope(saved,SITE_CREDENTIAL_SCOPE);
  return this.credentials.isCurrent?.(saved);
 }
 assertTemplate(saved){
  if(saved?.trust!=='tofu-template-v1')return;
  const pin=matchPinnedSiteTemplate(this.templatePin(),saved);
  if(!pin)
   bad('B_TEMPLATE_MISMATCH');
 }
 async exchange(action,request,{site_id,epoch=null,timeout_ms=5000,max_bytes=MAX_RESPONSE,allowStopped=false,pending=null,revocation=null}={}){
  if(!Object.hasOwn(ENDPOINTS,action))bad('B_ENDPOINT_NOT_ALLOWED');
  // Even a stopped-mode pairing/health request is tied to the original epoch.
  // Check after target resolution, before creating the abortable request.
  if(epoch!==null&&(epoch!==this.epoch||!allowStopped&&!this.running))bad('B_LIFECYCLE_CHANGED');
  if(pending&&(!['templateHealth','begin','complete','health'].includes(action)||pending.site_id!==site_id||
    typeof pending.bearer!=='string'||pending.bearer.length<32||pending.bearer.length>4096||/\s/.test(pending.bearer)))bad('B_PENDING_TARGET_INVALID');
  if(revocation&&(action!=='revoke'||revocation.site_id!==site_id||revocation.trust!=='tofu-template-v1'||
   revocation.installation_id!==this.installationId||!this.localStore.revocationPending?.(revocation.binding_id,revocation.generation)))bad('B_REVOKE_SCOPE_INVALID');
  const target=pending?{site_id:pending.site_id,site_origin:siteOrigin(pending.origin)}:
   revocation?{site_id:revocation.site_id,site_origin:siteOrigin(revocation.site_origin)}:await this.target(site_id);
  if(!pending&&!revocation&&target.trust_origin==='paired_template'&&
     target.template_current===false&&action!=='health'&&action!=='revoke')bad('B_TEMPLATE_MISMATCH');
  if(pending&&!new URL(target.site_origin).hostname.endsWith('.chatgpt.site'))bad('B_PENDING_TARGET_INVALID');
  if(revocation&&!new URL(target.site_origin).hostname.endsWith('.chatgpt.site'))bad('B_REVOKE_SCOPE_INVALID');
  if(epoch!==null&&(epoch!==this.epoch||!allowStopped&&!this.running))bad('B_LIFECYCLE_CHANGED');
  const machine=pending?pending.bearer:this.machine(target),endpoint=ENDPOINTS[action],url=target.site_origin+endpoint;
  const body=action==='templateHealth'?undefined:JSON.stringify(request);
  if(body!==undefined&&Buffer.byteLength(body)>MAX_REQUEST)bad('B_REQUEST_TOO_LARGE');
  if(epoch!==null&&(epoch!==this.epoch||!allowStopped&&!this.running))bad('B_LIFECYCLE_CHANGED');
  const controller=new AbortController();this.pending.add(controller);
  const timer=this.setTimeoutFn(timeout_ms,()=>controller.abort());
  try{
   // redirect:error prevents forwarding a machine bearer to any other origin.
   const response=await this.fetchImpl(url,{method:action==='templateHealth'?'GET':'POST',headers:{
     'Content-Type':'application/json','Accept':'application/json','OAI-Sites-Authorization':'Bearer '+machine},
    body,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
   if(epoch!==null&&(epoch!==this.epoch||!allowStopped&&!this.running))bad('B_LIFECYCLE_CHANGED');
   if(response?.redirected||response?.url!==url||!Number.isInteger(response?.status))bad('B_UNTRUSTED_HTTP_RESPONSE');
   if(this.noteNetworkResponse(response.status,response.headers,epoch??this.epoch))bad('B_SITE_NETWORK_CHALLENGE');
   if(response.status!==200){
    // Structured actionable errors only; never surface arbitrary remote text.
    if([400,403,409].includes(response.status)&&response.headers.get('content-type')?.split(';')[0].trim()==='application/json'){
     const reader=response.body?.getReader();let total=0;const parts=[];
     if(reader)while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>4096){await reader.cancel().catch(()=>{});break;}parts.push(value);}
     if(epoch!==null&&epoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
     if(total<=4096){let error;try{error=JSON.parse(Buffer.concat(parts).toString('utf8')).error_code;}catch{}
      if(action==='begin'&&error==='B_FIELDS_INVALID')bad('B_FIELDS_INVALID');
      if(['B_GRANT_EXPIRED','B_REBIND_UNSUPPORTED','B_REBIND_OWNER_REQUIRED','B_REBIND_GRANT_INVALID','B_REBIND_CONTINUITY_INVALID','B_BINDING_CHANGED','B_BINDING_REPAIR_REQUIRED','B_BINDING_PROTOCOL_REQUIRED'].includes(error))bad(error);
     }
    }
    if(response.status===401||response.status===403)bad('B_REMOTE_AUTH_REQUIRED');
    if(response.status===429)bad('B_REMOTE_RATE_LIMITED');
    if(response.status===409)bad('B_REMOTE_CONFLICT');
    // The original completed result remains in the outbox; never retry work.
    if(action==='result'&&response.status===413)bad('B_REMOTE_RESULT_TOO_LARGE');
    bad(response.status>=500?'B_REMOTE_TRANSIENT':'B_REMOTE_HTTP_FAILED');
   }
   if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')bad('B_RESPONSE_CONTENT_TYPE');
   const reader=response.body?.getReader();if(!reader)bad('B_RESPONSE_EMPTY');
   const chunks=[];let total=0;
   while(true){
    const {done,value}=await reader.read();
    if(epoch!==null&&(epoch!==this.epoch||!allowStopped&&!this.running))bad('B_LIFECYCLE_CHANGED');
    if(done)break;
    total+=value.length;if(total>max_bytes){await reader.cancel().catch(()=>{});bad('B_RESPONSE_TOO_LARGE');}
    chunks.push(value);
   }
   if(epoch!==null&&(epoch!==this.epoch||!allowStopped&&!this.running))bad('B_LIFECYCLE_CHANGED');
   const buffer=Buffer.concat(chunks.map(v=>Buffer.from(v)));
   let json;try{json=JSON.parse(buffer.toString('utf8'));}catch{bad('B_RESPONSE_JSON_INVALID');}
   if(!json||typeof json!=='object'||Array.isArray(json))bad('B_RESPONSE_JSON_INVALID');
   return json;
  }catch(error){
   bad(siteRequestErrorCode(error,{aborted:controller.signal.aborted}));
  }finally{this.clearTimeoutFn(timer);this.pending.delete(controller);}
 }
 async begin(request){
  // Capture once, before either asynchronous target lookup.
  const originalEpoch=this.epoch,target=await this.target(request?.site_id);
  if(originalEpoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
  if(target.site_origin!==request.site_origin)bad('B_TARGET_ORIGIN_MISMATCH');
  const result=await this.exchange('begin',request,{site_id:target.site_id,epoch:originalEpoch,timeout_ms:6500,max_bytes:8192,allowStopped:true});
  if(originalEpoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
  this.pendingPairSite={site_id:target.site_id,origin:target.site_origin,at:this.clock(),epoch:originalEpoch};
  return result;
 }
 async beginV2(request,pending){
  const epoch=this.epoch;
  if(!pending||pending.site_id!==request?.site_id||pending.origin!==request?.site_origin)bad('B_PENDING_TARGET_INVALID');
  // Never cache a previous Site/version or infer it from our requested protocol.
  // A health without template_version remains unknown and can still pair.
  const health=await this.exchange('templateHealth',null,{site_id:pending.site_id,epoch,timeout_ms:5000,max_bytes:8192,allowStopped:true,pending});
  if(epoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
  let result;
  try{result=await this.exchange('begin',request,{site_id:pending.site_id,epoch,timeout_ms:6500,max_bytes:8192,allowStopped:true,pending});}
  catch(error){
   if(epoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
   if(error?.code==='B_FIELDS_INVALID'&&request?.protocol_version==='3'&&LEGACY_BINDING_TEMPLATES.has(health?.template_version))bad('B_REBIND_UNSUPPORTED');
   throw error;
  }
  if(epoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
  this.pendingPairSite={site_id:pending.site_id,origin:pending.origin,at:this.clock(),epoch,bearer:pending.bearer};
  return result;
 }
 async completeV2(request){
  const p=this.pendingPairSite;
  if(!p||p.epoch!==this.epoch||this.clock()-p.at>300000||!p.bearer)bad('B_PAIR_SESSION_EXPIRED');
  return this.exchange('complete',request,{site_id:p.site_id,epoch:p.epoch,timeout_ms:6500,max_bytes:8192,allowStopped:true,pending:p});
 }
 async completeRecoveredV2(request,pending){
  if(!['2','3'].includes(request?.protocol_version)||!pending||!UUID.test(request.pairing_id)||
     !SHA.test(request.claim_digest))bad('B_PAIR_RECOVERY_INVALID');
  const epoch=this.epoch;
  const result=await this.exchange('complete',request,{site_id:pending.site_id,epoch,
   timeout_ms:6500,max_bytes:8192,allowStopped:true,pending});
  if(epoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
  return result;
 }
 async complete(request){
  const p=this.pendingPairSite;if(!p||p.epoch!==this.epoch||this.clock()-p.at>300000)bad('B_PAIR_SESSION_EXPIRED');
  return this.exchange('complete',request,{site_id:p.site_id,epoch:p.epoch,timeout_ms:6500,max_bytes:8192,allowStopped:true});
 }
 async health(request){
  const originalEpoch=this.epoch;
  const saved=this.credentials.get('site_b');if(!saved||saved.installation_id!==this.installationId)bad('B_DEVICE_UNCONFIGURED');
  const response=await this.exchange('health',request,{site_id:saved.site_id,epoch:originalEpoch,timeout_ms:5000,max_bytes:8192,allowStopped:true});
  this.acceptBindingReplacement(saved,response,request.nonce,originalEpoch);return response;
 }
 async healthWithBearer(request,pending){
  const epoch=this.epoch;
  const saved=this.credentials.get('site_b');
  if(saved?.trust!=='tofu-template-v1'||saved.installation_id!==this.installationId||
     pending?.site_id!==saved.site_id||pending?.origin!==saved.site_origin)bad('B_DEVICE_UNCONFIGURED');
  const response=await this.exchange('health',request,{site_id:saved.site_id,epoch,
   timeout_ms:5000,max_bytes:8192,allowStopped:true,pending});
  if(epoch!==this.epoch)bad('B_LIFECYCLE_CHANGED');
  this.acceptBindingReplacement(saved,response,request.nonce,epoch);
  return response;
 }
 start(){
  if(this.running)return;
  this.running=true;this.epoch++;this.failures=0;
  this.hostFlow?.invalidate();
  if(this.autoPoll)this.schedule(0,this.epoch);
 }
 schedule(delay,epoch){
  if(!this.running||this.epoch!==epoch||!this.autoPoll)return;
  if(this.timer!==null)this.clearTimeoutFn(this.timer);
  this.timer=this.setTimeoutFn(delay,()=>{this.timer=null;void this.tick(epoch);});
 }
 async signedDevice(saved,action,kind,extra=[]){
  const nonce=encodeUrl64(crypto.randomBytes(32));
  return {...devicePayload(saved,kind,nonce,extra),nonce};
 }
 async healthNow(saved,epoch){
  const v2=saved.trust==='tofu-template-v1';
  this.current(saved,epoch,{healthOnly:true});
  const catalogue=v2?this.templatePin():null;
  let pin=v2?(matchPinnedSiteTemplate(catalogue,saved)||catalogue):null;
  if(v2&&(!pin?.verified_source||typeof pin.template_version!=='string'||typeof pin.manifest_sha256!=='string'))
   bad('B_TEMPLATE_MISMATCH');
  let drift=v2&&(saved.template_version!==pin.template_version||saved.manifest_sha256!==pin.manifest_sha256);
  const initialDrift=drift;
  if(drift){
   this.hostFlow?.invalidate();
   this.localStore.health('site',{state:'failed',verified:true,generation:saved.generation,reason:'B_TEMPLATE_MISMATCH'});
  }
  const request={...(await this.signedDevice(saved,'health',v2?'chathand-site-health-v2':'chathand-site-health-v1')),
   ...(v2?{protocol_version:'2'}:{})};
  const r=await this.exchange('health',request,{site_id:saved.site_id,epoch,timeout_ms:5000,max_bytes:8192});
  this.current(saved,epoch,{healthOnly:true});
  this.acceptBindingReplacement(saved,r,request.nonce,epoch);
  if(v2){pin=matchPinnedSiteTemplate(catalogue,r)||pin;
   drift=saved.template_version!==pin.template_version||saved.manifest_sha256!==pin.manifest_sha256;
   if(!matchPinnedSiteTemplate(this.templatePin(),pin))bad('B_TEMPLATE_MISMATCH');}
  verifyHealthAck(saved,r,{nonce:request.nonce,installationId:this.installationId,templatePin:pin,
   allowTemplatePromotion:v2});
  if(drift&&!initialDrift){this.hostFlow?.invalidate();
   this.localStore.health('site',{state:'failed',verified:true,generation:saved.generation,reason:'B_TEMPLATE_MISMATCH'});}
  const current=drift?this.localStore.promoteSiteTemplate(this.credentials,saved,pin):saved;
  this.current(current,epoch);
  const old=this.localStore.route('site');
  if(old.state==='healthy'&&!this.localStore.fresh(old))this.hostFlow?.invalidate();
  this.localStore.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:current.generation});
  this.noteAuthenticatedSuccess(epoch);
  this.lastVerifiedAt=this.clock();
  return current;
 }
 async fetchNext(saved,epoch){
  this.current(saved,epoch);
  const req=await this.signedDevice(saved,'next','chathand-site-device-next-v1');
  const r=await this.exchange('next',req,{site_id:saved.site_id,epoch,timeout_ms:6000,max_bytes:72*1024});
  this.current(saved,epoch);
  if(r.site_id!==saved.site_id||r.binding_id!==saved.binding_id||r.installation_id!==this.installationId||
   r.generation!==saved.generation||r.nonce!==req.nonce||!(r.job===null||r.job&&typeof r.job==='object'))
   bad('B_NEXT_BINDING');
  verifySigned(saved,['chathand-site-next-ack-v1',saved.site_id,saved.binding_id,String(saved.generation),this.installationId,req.nonce,
   r.job?.op_id||'',r.job?.request_digest||''],r.signature,'B_NEXT_SIGNATURE');
  this.noteAuthenticatedSuccess(epoch);
  if(!r.job)return false;
  // Reverify the Site job signature before any model tool admission.
  verifiedSiteJob(r.job,{trustedSitePublic:publicKey(saved),siteId:saved.site_id,
   installationId:this.installationId,ownerSubject:saved.owner_subject,bindingId:saved.binding_id,generation:saved.generation,now:this.clock()});
  if(!this.deliver)bad('B_DEVICE_DISPATCH_NOT_WIRED');
  this.current(saved,epoch);
  const channel={trusted_server:true,authenticated_device:true,site_id:saved.site_id,owner_subject:saved.owner_subject,
   binding_id:saved.binding_id,generation:saved.generation,
   authenticated_session:'site:'+saved.binding_id,transport_epoch:epoch};
  await this.deliver(r.job,channel);
  return true;
 }
 async deliverResults(saved,epoch){
  if(typeof this.localStore.pendingSiteResults!=='function')bad('B_RESULT_QUEUE_NOT_WIRED');
  // Fence stop/rebind before even reading/quarantining a previously saved box.
  this.current(saved,epoch);
  const pending=this.localStore.pendingSiteResults(saved.binding_id,saved.generation,5);
  for(const item of pending){
   this.current(saved,epoch);
   const data={op_id:item.op_id,request_digest:item.request_digest,result_digest:item.result_digest,result:item.result};
   const meta=this.hostFlow?.metadataForResult(item,saved,epoch)??null;
   let extension={},metaDigest=null;
   if(meta){
    const canonical=canonicalArguments(meta);
    if(canonical.byteLength>4096)bad('B_HOST_META_TOO_LARGE');
    metaDigest=sha256(canonical);
   }
   const req=await this.signedDevice(saved,'result','chathand-site-result-v1',[data.op_id,data.request_digest,data.result_digest]);
   if(metaDigest){
    const fields=['chathand-site-result-host-v1',saved.site_id,saved.binding_id,String(saved.generation),
     this.installationId,req.nonce,data.op_id,data.request_digest,data.result_digest,metaDigest];
    extension={host_flow_meta:meta,host_flow_digest:metaDigest,
     host_flow_signature:edSign(privateKey(saved),Buffer.from(JSON.stringify(fields)))};
   }
   const payload={...req,...data,...extension};
   // Only two precisely classified result-delivery failures may be locally
   // quarantined. Authentication, lifecycle, signature, ACK and ordinary HTTP
   // failures MUST still escape to the original transport error handling.
   let ack;
   try{
    if(Buffer.byteLength(JSON.stringify(payload),'utf8')>MAX_REQUEST)
     bad('B_RESULT_WIRE_BUDGET_EXCEEDED');
    ack=await this.exchange('result',payload,{site_id:saved.site_id,epoch,timeout_ms:6000,max_bytes:8192});
   }catch(error){
    if(error?.code!=='B_RESULT_WIRE_BUDGET_EXCEEDED'&&
       error?.code!=='B_REMOTE_RESULT_TOO_LARGE')throw error;
    // A late 413/oversize after stop, restart, revoke or rebind is NOT entitled
    // to quarantine a newer authority or result.
    this.current(saved,epoch);
    if(typeof this.localStore.quarantineSiteResult!=='function')
     bad('B_RESULT_QUARANTINE_UNCONFIRMED');
    const marked=this.localStore.quarantineSiteResult(item.op_id,item.work,{
     result_digest:item.result_digest,reason:error.code});
    if(marked?.quarantined!==true)bad('B_RESULT_QUARANTINE_UNCONFIRMED');
    // The same immutable original box/digest stays recorded, with no fake ACK.
    continue;
   }
   this.current(saved,epoch);
   if(ack.site_id!==saved.site_id||ack.installation_id!==this.installationId||ack.binding_id!==saved.binding_id||
    ack.generation!==saved.generation||ack.op_id!==item.op_id||ack.request_digest!==item.request_digest||
    ack.result_digest!==item.result_digest||!UUID.test(ack.ack_id))bad('B_RESULT_ACK_MISMATCH');
   verifySigned(saved,['chathand-site-result-ack-v1',saved.site_id,saved.binding_id,String(saved.generation),
    this.installationId,item.op_id,item.request_digest,item.result_digest,ack.ack_id],ack.signature,'B_RESULT_ACK_SIGNATURE');
   if(metaDigest){
    if(ack.host_flow_digest!==metaDigest||typeof ack.host_flow_ack_signature!=='string')
     bad('B_HOST_ACK_EXTENSION_MISSING');
    verifySigned(saved,['chathand-site-result-host-ack-v1',saved.site_id,saved.binding_id,
     String(saved.generation),this.installationId,item.op_id,item.request_digest,
     item.result_digest,ack.ack_id,metaDigest],ack.host_flow_ack_signature,'B_HOST_ACK_SIGNATURE');
   }
   this.noteAuthenticatedSuccess(epoch);
   this.localStore.ack(item.op_id,item.work,{ack_id:ack.ack_id,result_digest:ack.result_digest});
  }
 }
 async tick(epoch){
  if(!this.running||epoch!==this.epoch)return;
  let nextDelay=10000;
  try{
   let saved=this.credentials.get('site_b');
   if(!saved||saved.installation_id!==this.installationId||!matchesIdentity(saved,this.localStore))bad('B_DEVICE_UNCONFIGURED');
   saved=await this.healthNow(saved,epoch);
   await this.deliverResults(saved,epoch); // earlier terminal results go first after restart
   await this.fetchNext(saved,epoch);
   await this.deliverResults(saved,epoch); // new execution is persisted before network ACK
   this.failures=0;this.lastErrorCode=null;
  }catch(error){
   if(!this.running||epoch!==this.epoch)return;
   this.failures=Math.min(3,this.failures+1);this.lastErrorCode=String(error?.code||'B_SITE_NETWORK_FAILED').slice(0,80);
   const saved=this.credentials.get('site_b');
   if(saved&&matchesIdentity(saved,this.localStore)){
   const reason=this.lastErrorCode==='B_REMOTE_AUTH_REQUIRED'?'auth_required':
    this.lastErrorCode==='B_SITE_NETWORK_CHALLENGE'?'reconnecting':this.lastErrorCode==='B_TEMPLATE_MISMATCH'||this.failures>=3?'failed':'reconnecting';
    try{this.localStore.health('site',{state:reason,verified:true,generation:saved.generation,reason:this.lastErrorCode});}catch{}
   }
   nextDelay=this.lastErrorCode==='B_REMOTE_RATE_LIMITED'?30000:[2000,5000,12000][this.failures-1];
  }finally{this.schedule(nextDelay,epoch);}
 }
 async revokeCurrent(){
  const saved=this.credentials.get('site_b');if(!saved||saved.installation_id!==this.installationId)bad('B_DEVICE_UNCONFIGURED');
  this.stop(); // fence late health, next and result callbacks before changing selection
  this.localStore.revokeSite({binding_id:saved.binding_id,generation:saved.generation,authenticatedNative:true});
  const req=await this.signedDevice(saved,'revoke','chathand-site-revoke-v1');
  try{
   const ack=await this.exchange('revoke',req,{site_id:saved.site_id,timeout_ms:6000,max_bytes:8192,allowStopped:true,
    ...(saved.trust==='tofu-template-v1'?{revocation:saved}:{})});
   if(ack.revoked!==true||ack.site_id!==saved.site_id||ack.binding_id!==saved.binding_id||
    ack.generation!==saved.generation||ack.nonce!==req.nonce)bad('B_REVOKE_ACK_INVALID');
   verifySigned(saved,['chathand-site-revoke-ack-v1',saved.site_id,saved.binding_id,String(saved.generation),this.installationId,req.nonce],
    ack.signature,'B_REVOKE_ACK_SIGNATURE');
   this.localStore.recordRemoteRevocation(saved.binding_id,saved.generation,{confirmed:true});
   // An in-flight revoke may finish after a new pairing. Never delete that new binding.
   const latest=this.credentials.get('site_b');
   if(latest?.binding_id===saved.binding_id&&latest.generation===saved.generation){
    const all=this.credentials.readAll();delete all.site_b;delete all.site_b_machine;this.credentials.writeAll(all);
   }
   return {local_revoked:true,remote_revocation:'confirmed',secret_visible:false};
  }catch{
   this.localStore.recordRemoteRevocation(saved.binding_id,saved.generation,{confirmed:false});
   // Keep old protected credential for explicit future revocation attempt only.
   // Never start normal polling while the revoked local route remains disabled.
   return {local_revoked:true,remote_revocation:'unconfirmed',secret_visible:false};
  }
 }
 close(){this.stop();}
}
