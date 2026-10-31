import {siteRequestErrorCode} from './site-request-errors.mjs';

// A nonexistent host that was resolved and reached Cloudflare during the 1083
// release probe. It is only a network check; it carries no ChatHand identity.
export const SITE_NETWORK_PROBE_URL='https://chathand-netcheck-db87b0ddc4cdf7f9.chatgpt.site/health';

export function createSiteNetworkCheck({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=8000}={}){
 const entries=new Map();let nextId=0;
 function target(origin){
  if(origin===null)return SITE_NETWORK_PROBE_URL;
  try{
   const u=new URL(origin);
   if(u.protocol!=='https:'||u.username||u.password||u.origin!==origin||!u.hostname.endsWith('.chatgpt.site'))return null;
   return new URL('/health',u).href;
  }catch{return null;}
 }
 async function probe(url){
  const controller=new AbortController();let timer;
  try{
   if(!url)throw Error('invalid site origin');
   const request=Promise.resolve().then(()=>fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',signal:controller.signal}));
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();const e=Error('timeout');e.name='AbortError';reject(e);},timeoutMs);});
   const response=await Promise.race([request,timeout]);
   const challenged=response.status===403&&response.headers.get('cf-mitigated')?.trim().toLowerCase()==='challenge';
   const result={result:challenged?'challenged':'clear',checked_at:now(),http_status:response.status};
   try{if(response.body?.cancel)Promise.resolve(response.body.cancel()).catch(()=>{});}catch{}
   return result;
  }catch(error){
   const mapped=siteRequestErrorCode(error,{aborted:controller.signal.aborted});
   return {result:'unreachable',checked_at:now(),error_code:mapped==='B_SITE_REQUEST_TIMEOUT'?'B_SITE_REQUEST_TIMEOUT':'B_SITE_NETWORK_FAILED'};
  }finally{clearTimeout(timer);}
 }
 return async function check({origin=null,force=false}={}){
  const url=target(origin),key=url||'invalid-origin',existing=entries.get(key),at=now();
  if(!force&&existing?.value&&at>=existing.value.checked_at&&at-existing.value.checked_at<60000)return {...existing.value};
  if(!force&&existing?.pending){await existing.pending;return check({origin});}
  const id=++nextId,pending=probe(url);entries.set(key,{id,pending});
  try{
   const value=await pending;
   if(entries.get(key)?.id===id){entries.set(key,{id,value});return {...value};}
   return check({origin});
  }finally{if(entries.get(key)?.id===id&&entries.get(key)?.pending)entries.delete(key);}
 };
}
