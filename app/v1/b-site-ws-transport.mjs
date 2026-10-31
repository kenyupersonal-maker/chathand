import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import {BSiteHttpTransport} from './b-site-http-transport.mjs';
import {runWsClient} from './relay-v412/ws-relay-client.mjs';
import {createReconnectBackoff} from './reconnect-backoff.mjs';
import {SITE_TRANSIENT_REASONS} from './site-link-health.mjs';
import {safeSiteErrorCode,siteRequestErrorCode} from './site-request-errors.mjs';
import {runtimeManifestMetrics} from './site-connection-stages.mjs';
import {SiteWebSocketObservation} from './site-websocket-observation.mjs';
const error=code=>Object.assign(Error(code),{code});
export const V412_SETTINGS=Object.freeze({hotMs:50,warmMs:100,coldMs:500,hotWindowMs:30000,warmWindowMs:300000,rotateMs:75000,maxOperations:1392});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export const siteCacheScope=s=>hash(JSON.stringify([s.installation_id,s.site_id,s.site_origin,s.owner_subject,s.binding_id,s.generation]));
/** The superclass supplies only the authenticated pairing/revocation control plane. Its HTTP poll loop never starts. */
export class BSiteWsTransport extends BSiteHttpTransport {
 constructor(options={}){super({...options,autoPoll:false});this.autoConnect=options.autoPoll!==false;this.connectImpl=options.connectImpl||null;this.runtimeFactory=null;this.rpcDelivery=null;this.sessionController=null;this.sessionLifecycle=null;this.sessionRun=null;this.ready=false;this.retryBackoff=createReconnectBackoff({now:this.clock,random:options.random||Math.random});this.websocketObservation=new SiteWebSocketObservation(this.clock);}
 writeHealth(value){try{this.localStore.health('site',value);this.healthErrorCode=null;}catch{this.healthErrorCode='B_SITE_HEALTH_WRITE_FAILED';}}
 async tick(){throw error('B_TRANSPORT_UPGRADE_REQUIRED');}
 async fetchNext(){throw error('B_TRANSPORT_UPGRADE_REQUIRED');}
 async deliverResults(){throw error('B_TRANSPORT_UPGRADE_REQUIRED');}
 setRpcDelivery(fn){if(this.rpcDelivery||typeof fn!=='function')throw error('B_TRANSPORT_DELIVERY_INVALID');this.rpcDelivery=fn;}
 setRuntimeFactory(fn){if(this.runtimeFactory||typeof fn!=='function')throw error('B_RUNTIME_FACTORY_INVALID');this.runtimeFactory=fn;}
 linkState(){return {phase:this.lastErrorCode==='B_REMOTE_AUTH_REQUIRED'?'auth_required':this.ready?'running':this.running?'reconnecting':'unconfigured_or_stopped',last_error_code:this.lastErrorCode};}
 stageStatus(){return {...this.linkState(),running:this.running,authenticated:this.ready,ready:this.ready,transport_epoch:this.epoch,heartbeat_at:this.heartbeatAt||null,runtime_manifest:this.runtimeManifest||null,last_successful_call:this.lastSuccessfulCall||null,websocket:this.websocketObservation.snapshot(),network_challenge:this.networkChallenge};}
 status(){return {...super.status(),factory:'authenticated_ws_v412',...this.stageStatus()};}
 stop(){this.sessionController?.abort();this.sessionController=null;this.ready=false;super.stop();this.websocketObservation.note('stopped',this.epoch);this.runtimeManifest={state:'unknown',reason_code:'TRANSPORT_STOPPED',transport_epoch:this.epoch,observed_at:this.clock()};this.heartbeatAt=null;}
 noteSuccessfulCall({epoch}={}){if(epoch!==this.epoch||!this.running||!this.ready)return;this.lastSuccessfulCall={succeeded_at:this.clock(),transport_epoch:epoch};}
 start(){if(this.running)return;this.running=true;this.epoch++;this.websocketObservation.note('connecting',this.epoch);this.hostFlow?.invalidate();if(this.autoConnect)this.sessionRun=this.run(this.epoch);}
 async refreshRuntime(){if(!this.running)return;const epoch=this.epoch;await this.sessionLifecycle?.drain?.();await this.sessionRun;if(epoch!==this.epoch||!this.running)return;this.sessionRun=this.run(epoch);}
 async signedRelay(saved,method,route,bodyHash=''){
  const expires_at=this.clock()+30000,target=await this.target(saved.site_id);
  const extra=[method,target.site_origin,route,bodyHash,String(expires_at)];
  return {...await this.signedDevice(saved,'relay','chathand-site-relay-v412',extra),expires_at,body_hash:bodyHash};
 }
 async relayPost(saved,epoch,route,value){
  this.current(saved,epoch);const target=await this.target(saved.site_id),payload=JSON.stringify(value),bodyHash=hash(Buffer.from(payload));
  const proof=await this.signedRelay(saved,'POST',route,bodyHash);this.current(saved,epoch);
  const controller=new AbortController();this.pending.add(controller);const timer=this.setTimeoutFn(6500,()=>controller.abort());
  try{
   const url=target.site_origin+route,response=await this.fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','OAI-Sites-Authorization':'Bearer '+this.machine(target),'X-ChatHand-Device':Buffer.from(JSON.stringify(proof)).toString('base64url')},body:payload,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'}).catch(e=>{throw error(siteRequestErrorCode(e,{aborted:controller.signal.aborted}));});
   this.current(saved,epoch);if(response.redirected||response.url!==url)throw error('B_UNTRUSTED_HTTP_RESPONSE');
   if(this.noteNetworkResponse(response.status,response.headers,epoch))throw error('B_SITE_NETWORK_CHALLENGE');
   if(response.status===401||response.status===403)throw error('B_REMOTE_AUTH_REQUIRED');if(response.status===429)throw error('B_REMOTE_RATE_LIMITED');if(response.status>=500)throw error('B_REMOTE_TRANSIENT');
   const bytes=Buffer.from(await response.arrayBuffer().catch(e=>{throw error(siteRequestErrorCode(e,{aborted:controller.signal.aborted}));}));if(bytes.length>8192)throw error('B_RESPONSE_TOO_LARGE');
   const result=JSON.parse(bytes.toString());if(response.status!==200||result.accepted!==true){const rejected=error(result.error||'B_RUNTIME_REGISTER_FAILED');for(const key of ['request_limit_bytes','row_limit_bytes','row_budget_bytes'])if(Number.isSafeInteger(result[key])&&result[key]>=0)rejected[key]=result[key];throw rejected;}this.noteAuthenticatedSuccess(epoch);return result;
  }finally{this.clearTimeoutFn(timer);this.pending.delete(controller);}
 }
 async upgrade(saved,epoch){
  this.current(saved,epoch);if(this.connectImpl)return this.connectImpl(saved,{epoch,signal:this.sessionController.signal});
  const target=await this.target(saved.site_id),route='/relay/ws',proof=await this.signedRelay(saved,'GET',route),key=crypto.randomBytes(16).toString('base64');this.current(saved,epoch);
  return new Promise((resolve,reject)=>{
   const req=https.request(target.site_origin+route,{method:'GET',headers:{'Connection':'Upgrade','Upgrade':'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key,'OAI-Sites-Authorization':'Bearer '+this.machine(target),'X-ChatHand-Device':Buffer.from(JSON.stringify(proof)).toString('base64url')},signal:this.sessionController.signal});
   req.setTimeout(6500,()=>req.destroy(error('WS_UPGRADE_TIMEOUT')));
   req.once('upgrade',(res,socket,head)=>{try{this.current(saved,epoch);const expected=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');if(res.statusCode!==101||res.headers['sec-websocket-accept']!==expected||res.headers.upgrade?.toLowerCase()!=='websocket')throw error('WS_UPGRADE_INVALID');resolve({socket,head});}catch(e){socket.destroy();reject(e);}});
   req.once('response',res=>{res.resume();try{this.current(saved,epoch);const challenge=this.noteNetworkResponse(res.statusCode,res.headers,epoch);reject(error(challenge?'B_SITE_NETWORK_CHALLENGE':'WS_UPGRADE_HTTP_'+res.statusCode));}catch(e){reject(e);}});req.once('error',()=>reject(error('WS_CONNECT_FAILED')));req.end();
  });
 }
 async run(epoch){
  const controller=new AbortController();this.sessionController=controller;
  try{
   this.runtimeManifest={state:'preparing',reason_code:'MANIFEST_PREPARING',transport_epoch:epoch,observed_at:this.clock()};
   let saved=this.credentials.get('site_b');this.current(saved,epoch,{healthOnly:true});if(!this.runtimeFactory||!this.rpcDelivery)throw error('B_RPC_NOT_WIRED');
   const manifest=await this.runtimeFactory();this.current(saved,epoch,{healthOnly:true});
   this.runtimeManifest={...this.runtimeManifest,...runtimeManifestMetrics(manifest,V412_SETTINGS)};
   saved=await this.healthNow(saved,epoch);
   const version=this.credentials.revisionOf?.(saved),machine=this.credentials.get('site_b_machine');
   if(version&&this.credentials.revisionOf?.(machine)===version&&this.credentials.isCurrent?.(saved)===true)this.sessionMaterial={saved,machine,revision:version,controller};
   this.ready=false;this.writeHealth({state:'reconnecting',verified:true,generation:saved.generation});
   const lifecycle={};this.sessionLifecycle=lifecycle;await runWsClient({signal:controller.signal,lifecycle,root:path.join(this.localStore.root,'site-relay-v412',siteCacheScope(saved)),origin:saved.site_origin,cacheKey:Buffer.from(saved.result_key,'base64url'),manifest,settings:V412_SETTINGS,toolManifest:manifest.tools.tools,
    prepareRuntime:async({manifest,settings})=>{
     this.runtimeManifest={...runtimeManifestMetrics(manifest,settings),state:'uploading',reason_code:'MANIFEST_UPLOADING',transport_epoch:epoch,observed_at:this.clock()};
     try{const accepted=await this.relayPost(saved,epoch,'/relay/runtime',{manifest,settings});this.current(saved,epoch);
      if(accepted?.accepted!==true)throw error('B_RUNTIME_REGISTER_FAILED');
      this.runtimeManifest={...this.runtimeManifest,state:'accepted',reason_code:'MANIFEST_ACCEPTED',accepted_at:this.clock(),observed_at:this.clock(),revision:/^[a-f0-9]{64}$/.test(accepted.revision||'')?accepted.revision:null,remote_limit_bytes:accepted.request_limit_bytes??null,row_budget_bytes:accepted.row_budget_bytes??null,row_limit_bytes:accepted.row_limit_bytes??null};return accepted;
     }catch(e){if(epoch===this.epoch&&!controller.signal.aborted)this.runtimeManifest={...this.runtimeManifest,state:'rejected',reason_code:safeSiteErrorCode(e?.code)||'B_RUNTIME_REGISTER_FAILED',observed_at:this.clock(),remote_limit_bytes:e?.request_limit_bytes??null,row_budget_bytes:e?.row_budget_bytes??null,row_limit_bytes:e?.row_limit_bytes??null};throw e;}
    },connect:()=>this.upgrade(saved,epoch),
    onHeartbeat:()=>{this.current(saved,epoch);this.noteAuthenticatedSuccess(epoch);this.websocketObservation.note('heartbeat',epoch);this.heartbeatAt=this.clock();this.writeHealth({state:'healthy',verified:true,nonceEcho:true,generation:saved.generation});},
    assertCurrent:()=>this.current(saved,epoch),onReady:()=>{this.current(saved,epoch);this.noteAuthenticatedSuccess(epoch);this.failures=0;this.retryBackoff.reset();this.lastErrorCode=null;this.ready=true;this.writeHealth({state:'healthy',verified:true,nonceEcho:true,generation:saved.generation});},
    log:event=>{if(event.event==='ws_connected'){this.websocketObservation.note('connected',epoch);this.lastErrorCode=null;this.ready=true;this.heartbeatAt=this.clock();this.writeHealth({state:'healthy',verified:true,nonceEcho:true,generation:saved.generation});}if(event.event==='ws_disconnected'&&event.connections===0){this.websocketObservation.note('disconnected',epoch);this.ready=false;}},
    execute:(rpc,execution)=>{this.current(saved,epoch);return this.rpcDelivery(rpc,Object.freeze({site_id:saved.site_id,owner_subject:saved.owner_subject,installation_id:saved.installation_id,binding_id:saved.binding_id,generation:saved.generation,transport_epoch:epoch}),execution);}
   });
  }catch(e){
   if(controller.signal.aborted||epoch!==this.epoch)return;
   this.websocketObservation.note('failed',epoch);
   this.lastErrorCode=safeSiteErrorCode(e?.code)||'B_WS_TRANSPORT_FAILED';this.ready=false;
   if(this.runtimeManifest?.state==='preparing')this.runtimeManifest={...this.runtimeManifest,state:'unknown',reason_code:this.lastErrorCode,observed_at:this.clock()};
   const auth=this.lastErrorCode==='B_REMOTE_AUTH_REQUIRED'||/^WS_UPGRADE_HTTP_(401|403)$/.test(this.lastErrorCode);
   const transient=SITE_TRANSIENT_REASONS.includes(this.lastErrorCode)||/^WS_UPGRADE_HTTP_(?:408|429|5[0-9]{2})$/.test(this.lastErrorCode);
   let generation;try{generation=this.localStore.route('site').generation;}catch{this.healthErrorCode='B_SITE_HEALTH_WRITE_FAILED';}
   this.writeHealth({state:auth?'auth_required':transient?'reconnecting':'failed',verified:true,generation,reason:this.lastErrorCode});
   if(transient&&this.running){this.failures++;const delay=this.retryBackoff.fail({rateLimited:['B_REMOTE_RATE_LIMITED','WS_UPGRADE_HTTP_429'].includes(this.lastErrorCode)});this.timer=this.setTimeoutFn(delay,()=>{this.timer=null;if(this.running&&epoch===this.epoch)this.sessionRun=this.run(epoch);});}
   else this.running=false;
  }finally{
   if(this.sessionMaterial?.controller===controller)this.sessionMaterial=null;
   if(controller.credentialChanged&&this.running&&epoch===this.epoch){this.ready=false;this.timer=this.setTimeoutFn(1000,()=>{this.timer=null;if(this.running&&epoch===this.epoch)this.sessionRun=this.run(epoch);});}
  }
 }
}
