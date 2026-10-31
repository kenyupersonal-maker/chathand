/** Public resource delivery facts only. Never retain body text, private metadata,
 * arbitrary URIs, request headers, or any session identifier. */
import crypto from 'node:crypto';
const methods=new Set(['resources/read','resources/list']),families=new Set(['task','image_batch','unknown']),codes=new Set(['OK','RESOURCE_MISSING','INVALID_REQUEST','TRANSPORT_REJECTED','HANDLER_FAILED']);
function family(uri){if(typeof uri!=='string')return 'unknown';if(/^ui:\/\/(?:chathand\/task(?:-[a-f0-9]{10})?\.html|ken-bridge\/task-v06\.html)$/.test(uri))return 'task';if(/^ui:\/\/chathand\/image-batch(?:(?:-[a-f0-9]{10})|-v1)?\.html$/.test(uri))return 'image_batch';return 'unknown';}
export function resourceDiagnostic(body,response,httpStatus){
 if(!methods.has(body?.method))return null;
 const error=response?.error,kind=body.method==='resources/read'?family(body.params?.uri):'unknown';let code='OK';
 if(error||httpStatus!==200)code=error?.data?.code==='RESOURCE_MISSING'||error?.code==='RESOURCE_MISSING'?'RESOURCE_MISSING':[-32600,-32601,-32602].includes(error?.code)?'INVALID_REQUEST':[-32020,-32022].includes(error?.code)?'TRANSPORT_REJECTED':'HANDLER_FAILED';
 const item=code==='OK'&&kind!=='unknown'&&response?.result?.contents?.length===1?response.result.contents[0]:null;
 const text=item?.uri===body.params?.uri&&typeof item?.text==='string'?item.text:null;
 return resourceDiagnosticFields({method:body.method,http_status:httpStatus,code,family:kind,resource_bytes:text===null?0:Buffer.byteLength(text,'utf8'),resource_sha256:text===null?null:crypto.createHash('sha256').update(text).digest('hex'),session_present:typeof body.params?._meta?.['openai/session']==='string'&&body.params._meta['openai/session'].length>0,scope:'local_handler_only',host_ui_not_observed:true});
}
export function resourceDiagnosticFields(value){
 if(!value||!methods.has(value.method)||!families.has(value.family)||!codes.has(value.code)||!Number.isSafeInteger(value.http_status)||value.http_status<100||value.http_status>599||!Number.isSafeInteger(value.resource_bytes)||value.resource_bytes<0||value.resource_bytes>10485760||value.resource_sha256!==null&&!/^[a-f0-9]{64}$/.test(value.resource_sha256||'')||typeof value.session_present!=='boolean'||value.scope!=='local_handler_only'||value.host_ui_not_observed!==true)return null;
 return {method:value.method,http_status:value.http_status,code:value.code,family:value.family,resource_bytes:value.resource_bytes,resource_sha256:value.resource_sha256,session_present:value.session_present,scope:'local_handler_only',host_ui_not_observed:true};
}
