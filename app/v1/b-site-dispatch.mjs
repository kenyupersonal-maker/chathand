/** ONE1052 Site B signed dispatch. No generic internal-tool executor is exported.
 * The original job-v1 digest/signature always covers canonical arguments. */
import {verifiedSiteJob,decodeUrl64} from './b-site-wire.mjs';
import {B_HOST_RECEIPT_INTERNAL_OP,B_HOST_PROBE_ENVELOPE,B_HOST_RECEIPT_ENVELOPE} from './b-site-host-probes.mjs';
import {cleanError,fail} from '../../engine/src/core.mjs';
const reject=(code='B_DEVICE_UNVERIFIED')=>fail(code,'设备工作项的身份或绑定未通过验证。');
const PROBES=new Set(['connection_check','setup_write_probe']);
const B_CALL_CONTEXT_KIND='b_site_call_context_v2';
const HEX=/^[a-f0-9]{64}$/;
const REQUEST_ID=/^[A-Za-z0-9_-]{12,96}$/;
export class BSiteDispatch {
 #transportAuthority=null;
 constructor({local,credentials,tools,installationId,now=Date.now,observeProbe=()=>{},hostProbes=null}={}){
  if(!local||!credentials||!tools||!installationId)reject('B_DISPATCH_UNAVAILABLE');
  Object.assign(this,{local,credentials,tools,installationId,now,observeProbe,hostProbes});
 }
 // Only server-side transport wiring receives this nonserializable capability.
 bindTransportAuthority(producer){
  if(!producer||typeof producer!=='object'||this.#transportAuthority!==null)reject('B_TRANSPORT_AUTHORITY_INVALID');
  const authority=Symbol('B_SITE_INTERNAL_DELIVERY');this.#transportAuthority=authority;
  return async(item,channel)=>this.receive(item,channel,authority);
 }
 invalidateTransportAuthority(){this.#transportAuthority=null;this.hostProbes?.invalidate();}
 async receive(item,channel={},capability=null){
  if(capability===null||capability!==this.#transportAuthority)reject('B_DEVICE_CHANNEL_UNTRUSTED');
  if(channel.trusted_server!==true||channel.authenticated_device!==true||channel.site_id===undefined||
   !channel.owner_subject||!channel.binding_id||!Number.isInteger(channel.generation))reject();
  const b=this.credentials.get('site_b');
  if(!b||b.installation_id!==this.installationId||channel.site_id!==b.site_id||
   channel.owner_subject!==b.owner_subject||channel.binding_id!==b.binding_id||channel.generation!==b.generation)
   reject('B_DEVICE_BINDING');
  const work=verifiedSiteJob(item,{trustedSitePublic:decodeUrl64(b.site_public_key,32),siteId:b.site_id,
   installationId:this.installationId,ownerSubject:b.owner_subject,bindingId:b.binding_id,generation:b.generation,now:this.now()});
  const receipt=this.local.admit(work,{authenticated:true});
  if(receipt.replayed)return {...this.local.status(work.op_id,work),replayed:true,do_not_execute:true};
  const start=this.local.start(work.op_id,work);
  if(!start.execute)return {...this.local.status(work.op_id,work),replayed:false,do_not_execute:true};
  let value,failed=false,chatNoticeEligible=false;
  try{
   if(work.tool_name===B_HOST_RECEIPT_INTERNAL_OP){
    // The only internal op is a fixed private controller consumer.
    if(!this.hostProbes)reject('B_HOST_BRIDGE_UNAVAILABLE');
    value=this.hostProbes.consume({work,channel});
   }else{
    const wrapped=work.args?.kind===B_HOST_PROBE_ENVELOPE;
    const general=work.args?.kind===B_CALL_CONTEXT_KIND;
    if(work.args?.kind===B_HOST_RECEIPT_ENVELOPE||
       wrapped&&!PROBES.has(work.tool_name))reject('B_INTERNAL_ENVELOPE_REJECTED');
    if(general&&(!work.args||work.args.version!==2||!REQUEST_ID.test(work.args.request_id)||
       (work.args.session_tag!==null&&!HEX.test(work.args.session_tag))||
       !work.args.tool_arguments||typeof work.args.tool_arguments!=='object'||
       Array.isArray(work.args.tool_arguments)||
       Object.keys(work.args).sort().join(',')!=='kind,request_id,session_tag,tool_arguments,version'))
      reject('B_WIRE_CONTEXT_INVALID');
    if(!general&&!wrapped)reject('B_WIRE_CONTEXT_MISSING');
    if(PROBES.has(work.tool_name)&&wrapped&&!this.hostProbes?.probeFor(work,channel))
      reject('B_HOST_PROBE_CONTEXT');
    // Only a validated ordinary non-probe Chat context may consume an A10
    // notice. Even a general envelope for a Host probe must not claim it.
    chatNoticeEligible=general&&!PROBES.has(work.tool_name);
    const probe=PROBES.has(work.tool_name)?this.hostProbes?.probeFor(work,channel):null;
    const args=work.args.tool_arguments;
    // Site work has a signed context; principal is derived from verified
    // owner/binding/generation, NEVER the caller's tool arguments.
    const connectionPrincipal='site-b:'+b.binding_id+':'+b.generation;
    const setupPrincipal='site-b:authenticated:'+b.owner_subject+':'+b.binding_id+':'+b.generation;
    if(PROBES.has(work.tool_name)){
     // Fixed Host probes keep their private nonserializable helper and never
     // touch tasks, so they stay on the direct invoke path.
     value=await this.tools.invoke(work.tool_name,args,'chatgpt',{
      transport:'site_b',transportSource:'site_b',mcpProtocolVersion:'2025-06-18',
      invocationClass:wrapped?'host_probe':'ordinary',
      connectionPrincipal,setupPrincipal,
      session:work.args.session_tag||undefined,hostProbe:probe
     });
    }else{
     // 1052 D1 / R05: an ordinary Site call goes through the same rpc entry as
     // A (task owner + session + principal, relay, Resume, confirmations,
     // trace) before any business read. Direct invoke would skip all of that.
     if(typeof this.tools.siteCall!=='function')reject('B_DISPATCH_UNAVAILABLE');
     const out=await this.tools.siteCall(work.tool_name,args,{
      sessionTag:work.args.session_tag,setupPrincipal,connectionPrincipal,requestId:work.args.request_id,
      identity:Object.freeze({kind:'site',namespace:this.installationId+':'+channel.site_id+':'+channel.binding_id+':'+channel.generation,id:work.op_id,requestDigest:work.request_digest})
     });
     failed=out.failed===true;value=out.value;
    }
   }
  }catch(e){
   failed=true;
   if(work.tool_name===B_HOST_RECEIPT_INTERNAL_OP||PROBES.has(work.tool_name))
    value={error:{code:typeof e?.code==='string'&&/^B_[A-Z0-9_]{2,80}$/.test(e.code)?e.code:'B_HOST_OPERATION_UNCONFIRMED'},executed:false};
   else value={error:cleanError(e),executed:false};
  }
  // Real admit-origin switches are queued by Store in its original admit
  // transaction. Never pre-expand an uncommitted notice into the tool result:
  // Store is the only source of a delivered, stable event_id.
  let terminal;
  try{terminal=this.local.complete(work.op_id,work,value,{failed,chatNoticeEligible});}
  catch(error){
   // A failed or uncertain commit must never trigger a side-effect replay.
   reject(error.code==='B_RESULT_TOO_LARGE'?'B_RESULT_TOO_LARGE':'B_RESULT_PERSIST_UNCONFIRMED');
  }
  // Read the committed result, not the original tool return; Store attaches
  // auto-switch notices in the same transaction that saves the result box.
  let persisted;
  try{
   persisted=this.local.status(work.op_id,work,{includeResult:true});
   if(!Object.hasOwn(persisted,'result')||persisted.result_digest!==terminal.result_digest||
      terminal.switch_notice&&(
       persisted.result?.switch_notice?.switch_event_id!==terminal.switch_notice.switch_event_id||
       persisted.result?.switch_notice?.app_event_id!==terminal.switch_notice.app_event_id))
    reject('B_RESULT_PERSIST_UNCONFIRMED');
  }catch{reject('B_RESULT_PERSIST_UNCONFIRMED');}
  // Only a real persisted, available result may advance Host read/write proof.
  // This unavailable flag is produced from measured bytes by Store, not args.
  if(PROBES.has(work.tool_name)&&terminal.source_result_unavailable!==true)try{
   this.observeProbe({work,outcome:value,failed,channel,terminal});
  }catch{/* Observation cannot retroactively alter the original result. */}
  // A notice is authoritative only after Store committed it with the result.
  const trustedNotice=terminal.switch_notice||null;
  return {op_id:work.op_id,route:'site',state:terminal.state,result_digest:terminal.result_digest,
   result:persisted.result,task_execution_authority:'unchanged',
   ...(trustedNotice?{switch_notice:trustedNotice}:{})};
 }
 status(op_id,work){return this.local.status(op_id,work,{includeResult:true});}
 ack(op_id,work,ack){return this.local.ack(op_id,work,ack);}
}
