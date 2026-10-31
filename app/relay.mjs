import os from 'node:os';import crypto from 'node:crypto';import {Fault,secureURL,fetchJSON,hash} from '../cloud/security.mjs';
const sleep=(ms,signal)=>new Promise(resolve=>{const end=()=>{clearTimeout(t);signal?.removeEventListener('abort',end);resolve();};const t=setTimeout(end,ms);signal?.addEventListener('abort',end,{once:true});if(signal?.aborted)end();});
/** Login is delegated to a configured identity provider; no password collection, no OpenAI API key. */
export class RelayClient {
 constructor({rpc,onChange=()=>{},development=false,name=os.hostname()}={}){this.rpc=rpc;this.onChange=onChange;this.development=development;this.name=name;this.state='off';this.config=null;this.session=null;this.flow=null;this.abort=null;this.worker=null;this.cache=new Map();this.pending=new Set();this.credentialGeneration=0;this.refreshing=null;this.lastHeartbeat=0;this.lastError=null;this.id=crypto.randomUUID().replaceAll('-','');}
 snapshot(){return {status:this.state,base_url:this.config?.base||null,issuer:this.config?.issuer||null,connector_url:this.config?.connector||null,device_id:this.session?this.id:null,device_name:this.name,online:this.state==='online'&&Date.now()-this.lastHeartbeat<30000,last_heartbeat:this.lastHeartbeat||null,error:this.lastError,credential_generation:this.credentialGeneration,pairing:this.flow?{user_code:this.flow.user_code,verification_uri:this.flow.verification_uri_complete||this.flow.verification_uri,expires_at:this.flow.expiresAt}:null};}
 change(s,error=null){this.state=s;this.lastError=error;this.onChange(this.snapshot());}
 async post(url,data,token,signal){return fetchJSON(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(22000)]):AbortSignal.timeout(15000)});}
 async oauth(data,signal){return fetchJSON(this.config.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}
 async pair(raw){
  if(this.worker||this.flow)throw new Fault('CONNECTION_BUSY','请先停止当前连接或配对。');
  const base=secureURL(raw,{development:this.development,originOnly:true}).origin;this.change('checking');
  const r=await fetchJSON(base+'/.well-known/ken-bridge');if(!r.ok||r.data.schema!==1)throw new Fault('RELAY_UNSUPPORTED');const x=r.data;
  const issuer=secureURL(x.issuer,{development:this.development}).href;
  if(x.audience!==base+'/mcp'||x.mcp_url!==base+'/mcp'||typeof x.native_client_id!=='string'||!x.native_client_id)throw new Fault('RELAY_CONFIG_INVALID');
  const token=secureURL(x.token_endpoint,{development:this.development}).href,device=secureURL(x.device_authorization_endpoint,{development:this.development}).href;
  if(new URL(token).origin!==new URL(issuer).origin||new URL(device).origin!==new URL(issuer).origin)throw new Fault('ISSUER_ENDPOINT_MISMATCH');
  let connector=null;if(x.published_connector_url){const u=secureURL(x.published_connector_url,{development:this.development});if(u.hostname!=='chatgpt.com')throw new Fault('CONNECTOR_URL_INVALID');connector=u.href;}this.config={base,issuer,audience:x.audience,client:x.native_client_id,token,device,connector};this.session=null;this.id=crypto.randomUUID().replaceAll('-','');
  const auth=await fetchJSON(device,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.client,audience:this.config.audience,scope:'openid offline_access device:connect'})});
  if(!auth.ok||!auth.data.device_code||!auth.data.user_code)throw new Fault('PAIRING_START_FAILED');
  const uri=secureURL((auth.data.verification_uri||'').split('?')[0],{development:this.development});let complete;try{complete=new URL(auth.data.verification_uri_complete||auth.data.verification_uri);}catch{throw new Fault('VERIFY_URL_INVALID');}
  if(uri.origin!==new URL(issuer).origin||complete.origin!==uri.origin||complete.username||complete.password)throw new Fault('VERIFY_URL_INVALID');
  const life=Number(auth.data.expires_in);if(!Number.isFinite(life)||life<=0||life>1800)throw new Fault('PAIRING_EXPIRY_INVALID');
  this.flow={...auth.data,expiresAt:Date.now()+life*1000,interval:Math.max(1,Math.min(Number(auth.data.interval)||5,30))*1000};
  this.change('awaiting_login');this.abort=new AbortController();this.worker=this.pollAuthorization(this.abort.signal).finally(()=>{this.worker=null;});return this.snapshot();
 }
 async pollAuthorization(signal){let failures=0;while(!signal.aborted&&this.flow){
  if(Date.now()>=this.flow.expiresAt){this.flow=null;this.change('login_expired');return;}
  await sleep(this.flow.interval,signal);if(signal.aborted)return;
  try{const r=await this.oauth({grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:this.flow.device_code,client_id:this.config.client},signal);
   if(r.ok&&r.data.access_token){this.accept(r.data,{preserveRefresh:false});this.flow=null;await this.connectLoop(signal);return;}
   if(r.data.error==='authorization_pending')continue;
   if(r.data.error==='slow_down'){this.flow.interval=Math.min(60000,this.flow.interval+5000);continue;}
   this.flow=null;this.change(r.data.error==='access_denied'?'login_denied':'login_failed',r.data.error||'AUTH_FAILED');return;
  }catch(e){if(signal.aborted)return;if(++failures>=3){this.flow=null;this.change('login_failed',e.code||'NETWORK_FAILED');return;}}
 }}
 accept(data,{preserveRefresh=true}={}){if(typeof data.access_token!=='string'||!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<=0)throw new Fault('TOKEN_RESPONSE_INVALID');this.session={access_token:data.access_token,refresh_token:data.refresh_token||(preserveRefresh?this.session?.refresh_token:null)||null,expires_at:Date.now()+Number(data.expires_in)*1000};this.credentialGeneration++;this.onChange(this.snapshot());}
 async currentToken(signal){if(!this.session)throw new Fault('LOGIN_REQUIRED');if(this.session.expires_at-Date.now()>45000)return this.session.access_token;if(!this.session.refresh_token)throw new Fault('LOGIN_EXPIRED');
  if(!this.refreshing)this.refreshing=(async()=>{const r=await this.oauth({grant_type:'refresh_token',refresh_token:this.session.refresh_token,client_id:this.config.client},signal);if(!r.ok)throw new Fault(r.data.error==='invalid_grant'?'LOGIN_REVOKED':'TOKEN_REFRESH_FAILED');this.accept(r.data);return this.session.access_token;})().finally(()=>this.refreshing=null);
  return this.refreshing;
 }
 async connectLoop(signal){let delay=500,registered=false;while(!signal.aborted){try{
  const token=await this.currentToken(signal);
  if(!registered){const r=await this.post(this.config.base+'/device/register',{id:this.id,name:this.name},token,signal);if(!r.ok)throw new Fault(r.data.error||'REGISTER_FAILED',undefined,r.status);registered=true;}
  this.lastHeartbeat=Date.now();this.change('online');
  if(this.pending.size>=4){await Promise.race([...this.pending,sleep(100,signal)]);continue;}
  const r=await this.post(this.config.base+'/device/next',{id:this.id},token,signal);if(!r.ok)throw new Fault(r.data.error||'POLL_FAILED',undefined,r.status);this.lastHeartbeat=Date.now();delay=500;
  if(r.data.id){const promise=this.execute(r.data,signal).catch(e=>{if(!signal.aborted)this.lastError=e.code||'RESULT_DELIVERY_FAILED';}).finally(()=>this.pending.delete(promise));this.pending.add(promise);}
 }catch(e){if(signal.aborted)break;if(['LOGIN_REVOKED','LOGIN_EXPIRED','DEVICE_NOT_FOUND','DEVICE_NOT_AVAILABLE','TOKEN_CLAIMS','CLIENT_DENIED','SCOPE_DENIED'].includes(e.code)||e.status===401||e.status===403){this.change('login_required',e.code);return;}this.change('reconnecting',e.code||'NETWORK_FAILED');registered=false;await sleep(delay,signal);delay=Math.min(30000,delay*2);}}
 }
 async execute(work,signal){if(typeof work.caller!=='string'||!work.caller.startsWith('relay:')||typeof work.id!=='string'||!work.request)throw new Fault('WORK_INVALID');
  const fingerprint=hash(JSON.stringify([work.caller,work.request]));let saved=this.cache.get(work.id);
  if(saved&&saved.fingerprint!==fingerprint)throw new Fault('REQUEST_CONFLICT');
  if(!saved){if(this.cache.size>=300){for(const [id,r] of this.cache)if(r.complete){this.cache.delete(id);if(this.cache.size<200)break;}if(this.cache.size>=300)throw new Fault('CACHE_FULL');}
   saved={fingerprint,complete:false,promise:Promise.resolve().then(()=>this.rpc(work.request,work.caller,{setupPrincipal:JSON.stringify([this.config.base,work.caller])}))};this.cache.set(work.id,saved);
  }
  const response=await saved.promise;saved.complete=true;if(signal.aborted)return;
  // Retry response delivery only; never execute an uncertain work item again.
  for(let i=0;i<3&&!signal.aborted;i++){try{const token=await this.currentToken(signal),r=await this.post(this.config.base+'/device/result',{id:this.id,request_id:work.id,response},token,signal);if(r.ok||r.status===409)return;throw new Fault('RESULT_POST_FAILED');}catch(e){if(i===2)throw e;await sleep(250*(i+1),signal);}}
 }
 credentials(){return this.session?{version:1,config:this.config,session:this.session,id:this.id,name:this.name}:null;}
 async restore(saved){if(this.worker)throw new Fault('CONNECTION_BUSY');if(saved?.version!==1||!saved.session||typeof saved.id!=='string'||! /^[a-zA-Z0-9_-]{16,96}$/.test(saved.id))throw new Fault('SAVED_LOGIN_INVALID');const c=saved.config;
  const base=secureURL(c.base,{development:this.development,originOnly:true}).origin,issuer=secureURL(c.issuer,{development:this.development}).href;for(const k of['token','device'])if(secureURL(c[k],{development:this.development}).origin!==new URL(issuer).origin)throw new Fault('SAVED_ENDPOINT_INVALID');
  if(c.audience!==base+'/mcp')throw new Fault('SAVED_AUDIENCE_INVALID');if(typeof c.client!=='string'||!c.client||typeof saved.session.access_token!=='string'||!Number.isFinite(saved.session.expires_at))throw new Fault('SAVED_LOGIN_INVALID');this.config={...c,base,issuer};this.session={...saved.session};this.id=saved.id;this.name=saved.name||this.name;this.abort=new AbortController();this.change('connecting');this.worker=this.connectLoop(this.abort.signal).finally(()=>this.worker=null);return this.snapshot();
 }
 async stop({forget=false}={}){
  this.abort?.abort();this.flow=null;const p=this.worker;await p?.catch(()=>{});let revoked=false;
  if(this.config&&this.session)try{const r=await this.post(this.config.base+(forget?'/device/revoke':'/device/offline'),{id:this.id},forget?await this.currentToken():this.session.access_token);revoked=r.ok;}catch{}
  this.change('off');if(forget){
   if(!revoked){this.change('off','REVOCATION_UNCONFIRMED');throw new Fault('REVOCATION_UNCONFIRMED','本机已停止；服务端撤销未确认，登录记录保留以便重试。');}
   let refreshRevoked=!this.session.refresh_token;
   if(this.session.refresh_token)try{const r=await fetch(this.config.issuer+'oauth/revoke',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.client,token:this.session.refresh_token}),signal:AbortSignal.timeout(15000)});refreshRevoked=r.ok;}catch{}
   this.session=null;this.config=null;this.id=crypto.randomUUID().replaceAll('-','');this.credentialGeneration++;
   return {...this.snapshot(),device_revoked:true,refresh_token_revoked:refreshRevoked};
  }return this.snapshot();
 }
}
