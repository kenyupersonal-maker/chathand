/** ONE1052 B-only host application-flow controller.
 * No Site/MCP argument, model status or UI flag is a proof by itself.
 * The one private writer is claimed by app/server and never exposed to tools.
 */
import crypto from 'node:crypto';
import {canonicalArguments,sha256} from './b-site-wire.mjs';
import {fail} from '../../engine/src/core.mjs';

const bad=(code='B_HOST_PROBE_UNVERIFIED')=>fail(code,'当前绑定的应用内连接回执尚未通过验证。');
const TTL=120000;
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nonceShape=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(x);
const keysEqual=(item,fields)=>item&&typeof item==='object'&&!Array.isArray(item)&&
 Object.keys(item).length===fields.length&&fields.every(k=>Object.hasOwn(item,k));
const PROBES=new Set(['connection_check','setup_write_probe']);
export const B_HOST_RECEIPT_INTERNAL_OP='b_host_receipt_commit';
export const B_HOST_PROBE_ENVELOPE='b_host_probe_v1';
export const B_HOST_RECEIPT_ENVELOPE='b_host_receipt_v1';

export class BSiteHostProbes {
 #secret=crypto.randomBytes(32);
 #batch=null;
 #outbox=new Map();
 #lifecycle=0;
 constructor({local,installationId,now=Date.now,receiptWriter=null,
  permissionEnabled=()=>true,transportEpoch=()=>null,onReadWrite=()=>{}}={}){
  if(!local||!UUID.test(installationId)||typeof local.selection!=='function'||
   typeof local.route!=='function'||typeof permissionEnabled!=='function'||
   typeof transportEpoch!=='function'||receiptWriter!==null&&typeof receiptWriter!=='function')
   bad('B_HOST_PROBE_CONFIG');
  Object.assign(this,{local,installationId,now,receiptWriter,permissionEnabled,transportEpoch,onReadWrite});
 }
 #digest(parts){return crypto.createHmac('sha256',this.#secret).update(JSON.stringify(parts)).digest('hex');}
 #current(){
  const selection=this.local.selection(),route=this.local.route('site'),epoch=this.transportEpoch();
  if(!this.local.fresh(route)||this.permissionEnabled()!==true||
   !Number.isSafeInteger(epoch)||epoch<0)return null;
  return {...route,selection_revision:selection.revision,transport_epoch:epoch};
 }
 #same(batch,route){
  return !!batch&&!!route&&batch.controller_epoch===this.#lifecycle&&
   batch.expires_at>this.now()&&batch.installation_id===this.installationId&&
   batch.site_id===route.site_id&&batch.owner_subject===route.owner_subject&&
   batch.binding_id===route.binding_id&&batch.generation===route.generation&&
   batch.selection_revision===route.selection_revision&&batch.reconnect_epoch===route.reconnect_epoch&&
   batch.transport_epoch===route.transport_epoch;
 }
 #envelope(work,channel){
  const route=this.#current(),args=work?.args;
  if(!route||!work||work.route!=='site'||!PROBES.has(work.tool_name)||
   work.binding_id!==route.binding_id||work.generation!==route.generation||
   work.principal!=='site:'+route.owner_subject||!channel||
   channel.trusted_server!==true||channel.authenticated_device!==true||
   channel.site_id!==route.site_id||channel.owner_subject!==route.owner_subject||
   channel.binding_id!==route.binding_id||channel.generation!==route.generation||
   channel.transport_epoch!==route.transport_epoch||
   channel.authenticated_session!=='site:'+route.binding_id||
   !keysEqual(args,['kind','session_tag','tool_arguments'])||
   args.kind!==B_HOST_PROBE_ENVELOPE||!SHA.test(args.session_tag)||
   !keysEqual(args.tool_arguments,['nonce'])||!nonceShape(args.tool_arguments.nonce))
   return null;
  return {route,args,nonce:args.tool_arguments.nonce,session_tag:args.session_tag};
 }
 // A nonserializable helper exists only inside an admitted, signed B dispatch.
 // The B read leaves original connection_check unchanged. The write returns the
 // normal probe contract only after the already-persisted B read is observed.
 probeFor(work,channel){
  const c=this.#envelope(work,channel);
  if(!c)return null;
  return Object.freeze({
   read:(nonce,info)=>{
    if(work.tool_name!=='connection_check'||nonce!==c.nonce||!this.#current())
     bad('B_HOST_READ_CONTEXT');
    return info;
   },
   write:nonce=>{
    const b=this.#batch,r=this.#current();
    if(work.tool_name!=='setup_write_probe'||nonce!==c.nonce||!this.#same(b,r)||
     !b.read_ok||b.write_ok||b.nonce_digest!==this.#digest([nonce,r.binding_id])||
     b.session_tag!==c.session_tag)bad('B_HOST_READ_REQUIRED');
    return {nonce,recorded:true,read:true,write:true};
   }
  });
 }
 // Adapt the unchanged RPC to the existing private probe controller. This wrapper
 // is created only by server.siteRpc after transport and binding authentication.
 rpcContext(rpc,authenticated){
  const name=rpc?.params?.name,nonce=rpc?.params?.arguments?.nonce,session=rpc?.params?._meta?.['openai/session'];
  if(typeof session!=='string'||!session)return null;
  const session_tag=sha256(Buffer.from(JSON.stringify(['b-host-session-v1',authenticated.site_id,authenticated.owner_subject,session])));
  const channel={...authenticated,trusted_server:true,authenticated_device:true,authenticated_session:'site:'+authenticated.binding_id};
  if(name==='chathand_host_flow_commit'){
   const material=capability=>{
    const b=this.#batch;
    if(this.local.selection().selected!=='site'||typeof capability!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(capability)||
     !this.#same(b,this.#current())||b.status!=='issued'||b.session_tag!==session_tag||
     b.cap_hash!==sha256(Buffer.from(capability))||authenticated.installation_id!==b.installation_id||
     authenticated.site_id!==b.site_id||authenticated.owner_subject!==b.owner_subject||
     authenticated.binding_id!==b.binding_id||authenticated.generation!==b.generation||
     authenticated.transport_epoch!==b.transport_epoch)return null;
    return {channel,work:{route:'site',principal:'site:'+b.owner_subject,
     binding_id:b.binding_id,generation:b.generation,tool_name:B_HOST_RECEIPT_INTERNAL_OP,
     args:{kind:B_HOST_RECEIPT_ENVELOPE,cap_hash:b.cap_hash,batch_id:b.batch_id,
      source_op_id:b.write_op_id,session_tag:b.session_tag,meta_digest:b.meta_digest}}};
   };
   return {hostReceipt:Object.freeze({prove:cap=>material(cap)!==null,
    consume:cap=>{const m=material(cap);if(!m)bad('B_HOST_CAP_UNVERIFIED');return this.consume(m);}})};
  }
  if(!PROBES.has(name)||!nonceShape(nonce))return null;
  const work={route:'site',binding_id:authenticated.binding_id,generation:authenticated.generation,
   principal:'site:'+authenticated.owner_subject,op_id:crypto.randomUUID(),tool_name:name,
   args:{kind:B_HOST_PROBE_ENVELOPE,session_tag,tool_arguments:{nonce}}};
  const probe=this.probeFor(work,channel);if(!probe)return null;
  return {probe,observe:response=>{
   const outcome=response?.result?.structuredContent;
   const observed=this.observe({work,channel,outcome,failed:!!response?.error||response?.result?.isError===true,
    terminal:{state:'completed',result_digest:sha256(Buffer.from(JSON.stringify(response)))}});
   const b=this.#batch;
   if(observed.observed&&b&&typeof this.receiptWriter?.recordRpcResult==='function')
    this.receiptWriter.recordRpcResult({op_id:work.op_id,tool:name,result_digest:name==='connection_check'?b.read_result_digest:b.write_result_digest,
     session_tag,installation_id:b.installation_id,site_id:b.site_id,owner_subject:b.owner_subject,binding_id:b.binding_id,generation:b.generation,
     selection_revision:b.selection_revision,reconnect_epoch:b.reconnect_epoch,transport_epoch:b.transport_epoch,completed_at:this.now()});
   // Hash the original RPC result above, then expose only the component's
   // short-lived random capability. No internal identities enter the result.
   if(observed.write_capability&&this.#same(b,this.#current())&&b.write_op_id===work.op_id&&
    b.session_tag===session_tag&&b.status==='issued')return {version:1,capability:b.capability,expires_at:b.expires_at};
   return null;
  }};
 }
 invalidate(){
  this.#lifecycle++;
  this.#batch=null;
  this.#outbox.clear();
  try{this.local.invalidateHostReceipt();}catch{/* Closed stores cannot resurrect old proof. */}
  return {invalidated:true};
 }
 snapshot(){
  const b=this.#batch,r=this.#current(),receipt=this.local.currentHostReceipt();
  if(b&&!this.#same(b,r)){this.invalidate();return {state:'unverified',verified:false,host_app_bridge:'not_confirmed'};}
  return {state:receipt?'verified_current_installation':b?.status==='issued'?'awaiting_app_only_commit':
   b?.read_ok?'read_observed':'unverified',read_observed:!!b?.read_ok,
   write_capability_observed:!!b?.write_ok,host_app_bridge:'app_only_source_wired',
   expires_at:b?.expires_at??null,verified:!!receipt};
 }
 observe({work,outcome,failed=false,channel,terminal}={}){
  const c=this.#envelope(work,channel),r=c?.route;
  if(!c||failed||terminal?.state!=='completed'||!SHA.test(terminal?.result_digest)||
   !outcome||typeof outcome!=='object'||Array.isArray(outcome))
   return {observed:false,verified:false};
  const at=this.now(),nonce=c.nonce,nonceDigest=this.#digest([nonce,r.binding_id]);
  if(work.tool_name==='connection_check'){
   if(outcome.nonce!==nonce||outcome.caller!=='chatgpt'||outcome.access_enabled!==true||
    !Number.isInteger(outcome.tool_count)||outcome.tool_count<1||typeof outcome.instance_id!=='string')
    return {observed:false,verified:false};
   this.invalidate(); // A newly admitted B read fences any earlier host batch.
   const fresh=this.#current();
   if(!fresh||fresh.binding_id!==r.binding_id||fresh.selection_revision!==r.selection_revision||
    fresh.transport_epoch!==r.transport_epoch)return {observed:false,verified:false};
   this.#batch={batch_id:crypto.randomUUID(),site_id:r.site_id,owner_subject:r.owner_subject,
    binding_id:r.binding_id,generation:r.generation,installation_id:this.installationId,
    selection_revision:r.selection_revision,reconnect_epoch:r.reconnect_epoch,
    transport_epoch:r.transport_epoch,controller_epoch:this.#lifecycle,
    nonce_digest:nonceDigest,session_tag:c.session_tag,read_ok:true,write_ok:false,
    read_op_id:work.op_id,read_result_digest:terminal.result_digest,
    started_at:at,expires_at:at+TTL,status:'read'};
   return {observed:true,read:true,write_capability:false,verified:false};
  }
  const b=this.#batch;
  if(!this.#same(b,this.#current())||!b.read_ok||b.write_ok||
   b.session_tag!==c.session_tag||b.nonce_digest!==nonceDigest||
   outcome.nonce!==nonce||outcome.recorded!==true||
   outcome.read!==true||outcome.write!==true||!this.receiptWriter)
   return {observed:false,verified:false};
  // Commit the durable setup fact before publishing a successful write. It is
  // observation only and never extends the short-lived private capability.
  this.onReadWrite({installation_id:b.installation_id,site_id:b.site_id,owner_subject:b.owner_subject,binding_id:b.binding_id,generation:b.generation});
  // A standby setup may select Site in onReadWrite. Never rebase an already
  // observed batch onto that new authority revision or issue an old capability.
  if(this.#batch!==b||!this.#same(b,this.#current())||this.local.selection().selected!=='site'){
   this.invalidate();
   return {observed:true,read:true,write_capability:true,app_flow:'setup_only',verified:false};
  }
  b.write_ok=true;b.write_op_id=work.op_id;b.write_result_digest=terminal.result_digest;
  b.issued_at=at;b.status='issued';
  b.capability=crypto.randomBytes(32).toString('base64url');
  b.cap_hash=sha256(Buffer.from(b.capability,'utf8'));
  b.expires_at=Math.min(b.started_at+TTL,at+TTL);
  const meta={version:1,capability:b.capability,cap_hash:b.cap_hash,
   batch_id:b.batch_id,source_op_id:b.write_op_id,read_op_id:b.read_op_id,
   read_result_digest:b.read_result_digest,write_result_digest:b.write_result_digest,
   installation_id:b.installation_id,site_id:b.site_id,owner_subject:b.owner_subject,
   binding_id:b.binding_id,generation:b.generation,session_tag:b.session_tag,
   nonce_digest:b.nonce_digest,selection_revision:b.selection_revision,
   reconnect_epoch:b.reconnect_epoch,transport_epoch:b.transport_epoch,
   controller_epoch:b.controller_epoch,issued_at:b.issued_at,expires_at:b.expires_at};
  b.meta_digest=sha256(canonicalArguments(meta));
  this.#outbox.set(work.op_id,{result_digest:terminal.result_digest,meta});
  return {observed:true,read:true,write_capability:true,app_flow:'awaiting_app_only_commit',verified:false};
 }
 // Only the HTTPS transport gets this raw-cap outbox: normal ledger/status/tools never do.
 metadataForResult(item,saved,epoch){
  if(this.local.selection().selected!=='site')return null;
  const b=this.#batch,r=this.#current(),privateItem=this.#outbox.get(item?.op_id);
  if(!this.#same(b,r)||b.status!=='issued'||!privateItem||
   epoch!==r.transport_epoch||item.result_digest!==privateItem.result_digest||
   item.op_id!==b.write_op_id||item.work?.tool_name!=='setup_write_probe'||
   item.work?.request_digest!==item.request_digest||
   saved?.installation_id!==this.installationId||saved.site_id!==b.site_id||
   saved.binding_id!==b.binding_id||saved.owner_subject!==b.owner_subject||
   saved.generation!==b.generation)return null;
  return privateItem.meta;
 }
 // Fixed internal op: consumes before the protected synchronous SQLite writer.
 // Even a failed/uncertain write cannot restore or replay this capability.
 consume({work,channel}={}){
  if(this.local.selection().selected!=='site')bad('B_HOST_CAP_UNVERIFIED');
  const b=this.#batch,r=this.#current(),a=work?.args;
  if(work?.tool_name!==B_HOST_RECEIPT_INTERNAL_OP||
   !keysEqual(a,['kind','cap_hash','batch_id','source_op_id','session_tag','meta_digest'])||
   a.kind!==B_HOST_RECEIPT_ENVELOPE||!SHA.test(a.cap_hash)||!SHA.test(a.meta_digest)||
   !UUID.test(a.batch_id)||!UUID.test(a.source_op_id)||!SHA.test(a.session_tag)||
   !this.#same(b,r)||b.status!=='issued'||!b.capability||
   a.cap_hash!==b.cap_hash||a.batch_id!==b.batch_id||a.source_op_id!==b.write_op_id||
   a.session_tag!==b.session_tag||a.meta_digest!==b.meta_digest||
   work?.binding_id!==b.binding_id||work.generation!==b.generation||
   work.principal!=='site:'+b.owner_subject||channel?.trusted_server!==true||
   channel.authenticated_device!==true||channel.site_id!==b.site_id||
   channel.owner_subject!==b.owner_subject||channel.binding_id!==b.binding_id||
   channel.generation!==b.generation||channel.transport_epoch!==b.transport_epoch)
   bad('B_HOST_CAP_UNVERIFIED');
  b.status='consumed';b.capability=null;this.#outbox.clear();
  try{
   const receipt=this.receiptWriter({installation_id:b.installation_id,
    site_id:b.site_id,owner_subject:b.owner_subject,binding_id:b.binding_id,generation:b.generation,
    batch_id:b.batch_id,session_tag:b.session_tag,nonce_digest:b.nonce_digest,
    selection_revision:b.selection_revision,reconnect_epoch:b.reconnect_epoch,
    transport_epoch:b.transport_epoch,controller_epoch:b.controller_epoch,
    read_op_id:b.read_op_id,write_op_id:b.write_op_id,
    read_result_digest:b.read_result_digest,write_result_digest:b.write_result_digest,
    read_ok:true,write_capability_ok:true,app_flow_verified:true,
    issued_at:b.issued_at,expires_at:b.expires_at});
   if(!receipt||receipt.stored!==true)bad('B_HOST_RECEIPT_PERSIST_UNCONFIRMED');
  }catch{b.status='consumed_unconfirmed';bad('B_HOST_RECEIPT_PERSIST_UNCONFIRMED');}
  return {state:'receipt_stored',app_flow_verified:true,executed:true};
 }
}
