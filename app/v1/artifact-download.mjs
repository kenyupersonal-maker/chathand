import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import {fail} from '../../engine/src/core.mjs';

function beforeAbort(promise,signal){return new Promise((resolve,reject)=>{const stopped=()=>reject(Object.assign(Error('文件接收已停止。'),{code:'ARTIFACT_DOWNLOAD_STOPPED'}));if(signal.aborted){stopped();return;}signal.addEventListener('abort',stopped,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stopped));});}
const normalizedPeer=s=>{const a=String(s||'').toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/,'$1');if(net.isIP(a)!==6)return a;const [l,r]=a.split('::'),left=l?l.split(':'):[],right=r?r.split(':'):[];return (r===undefined?left:[...left,...Array(8-left.length-right.length).fill('0'),...right]).map(x=>parseInt(x,16).toString(16)).join(':');};
function safeURL(raw){let u;try{u=new URL(raw);}catch{fail('ARTIFACT_URL_INVALID','文件下载地址无效。');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||u.href.length>16384)fail('ARTIFACT_URL_INVALID','只接收无账号字段的 HTTP 或 HTTPS 文件地址。');return u;}
/** Pin each HTTP(S) connection to its DNS result. No ambient cookies or auth. */
export function openPinned({url,address,family,signal}){
 return new Promise((resolve,reject)=>{
  const request=(url.protocol==='https:'?https:http).request(url,{method:'GET',agent:false,signal,lookup:(_host,_options,cb)=>cb(null,address,family),headers:{accept:'application/octet-stream'}},response=>resolve({status:response.statusCode,headers:response.headers,peer:response.socket.remoteAddress,body:response,close:()=>response.destroy()}));
  request.once('error',()=>reject(Object.assign(Error('文件下载未完成。'),{code:'ARTIFACT_DOWNLOAD_FAILED'})));request.end();
 });
}
export async function downloadArtifact(raw,{guard=()=>{},signal,maxBytes=50*1024*1024,lookup=dns.lookup,transport=openPinned}={}){
 const timeout=AbortSignal.timeout(35000),abort=signal?AbortSignal.any([signal,timeout]):timeout;let url=safeURL(raw);
 try{for(let jump=0;jump<=3;jump++){
  guard();if(abort.aborted)fail('ARTIFACT_DOWNLOAD_STOPPED','文件接收已停止。');const host=url.hostname.replace(/^\[|\]$/g,'');let addresses;
  try{addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await beforeAbort(lookup(host,{all:true,verbatim:true}),abort);}catch(e){if(e.code==='ARTIFACT_DOWNLOAD_STOPPED')throw e;fail('ARTIFACT_DOWNLOAD_FAILED','文件地址解析失败。');}
  guard();if(!addresses?.length||addresses.some(x=>!net.isIP(x.address)||net.isIP(x.address)!==x.family))fail('ARTIFACT_DOWNLOAD_FAILED','文件地址解析失败。');
  const selected=addresses[0];let response;try{response=await transport({url,address:selected.address,family:selected.family,signal:abort});}catch{fail('ARTIFACT_DOWNLOAD_FAILED','文件下载未完成。');}
  try{
   guard();if(normalizedPeer(response.peer)!==normalizedPeer(selected.address))fail('ARTIFACT_PEER_MISMATCH','文件连接来源校验失败。');
   if([301,302,303,307,308].includes(response.status)){if(jump===3||typeof response.headers?.location!=='string')fail('ARTIFACT_REDIRECT_LIMIT','文件跳转没有完成。');url=safeURL(new URL(response.headers.location,url).href);continue;}
   if(response.status<200||response.status>=300)fail('ARTIFACT_DOWNLOAD_FAILED','文件下载没有返回完整文件。');
   const length=response.headers?.['content-length'];if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>maxBytes))fail('ARTIFACT_SIZE_LIMIT','文件超过接收上限。');
   const chunks=[];let bytes=0;for await(const value of response.body){guard();if(abort.aborted)fail('ARTIFACT_DOWNLOAD_STOPPED','文件接收已停止。');const chunk=Buffer.from(value);bytes+=chunk.length;if(bytes>maxBytes)fail('ARTIFACT_SIZE_LIMIT','文件超过接收上限。');chunks.push(chunk);}
   guard();if(length!==undefined&&bytes!==Number(length))fail('ARTIFACT_DOWNLOAD_INCOMPLETE','文件没有收完整。');return Buffer.concat(chunks,bytes);
  }finally{response.close?.();}
 }
 }catch(e){if(e?.code?.startsWith('ARTIFACT_')||['TASK_REVOKED','ROOT_CHANGED','ACCESS_DISABLED','PROJECT_CHANGED'].includes(e?.code))throw e;fail('ARTIFACT_DOWNLOAD_FAILED','文件下载未完成。');}
 fail('ARTIFACT_DOWNLOAD_FAILED','文件下载未完成。');
}
