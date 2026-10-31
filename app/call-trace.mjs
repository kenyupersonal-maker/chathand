/** Local metadata-only observations. No arguments, results, headers, arbitrary URLs or raw caller IDs.
 * A Node response-finish event proves a local response stream completed, NOT host receipt/UI rendering.
 */
import {installationSalt} from './diagnostic-events.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDir,fail} from '../engine/src/core.mjs';
const allowedMethods=new Set(['initialize','server/discover','ping','tools/list','tools/call','notifications/initialized','resources/list','resources/read']);
const DAY=86400000,DAILY=/^rpc-\d{4}-\d{2}-\d{2}\.jsonl$/;
const dailyName=name=>DAILY.test(name)&&Number.isFinite(Date.parse(name.slice(4,14)+'T00:00:00Z'))&&new Date(name.slice(4,14)+'T00:00:00Z').toISOString().slice(0,10)===name.slice(4,14);
const safeFile=st=>st.isFile()&&!st.isSymbolicLink()&&st.nlink===1;
// Only public widget routes are useful diagnostics. Never retain arbitrary URL
// paths, userinfo, queries, fragments or unknown resource identifiers.
export function safeResourceURI(uri){
 if(typeof uri!=='string')return null;
 const bare=uri.split(/[?#]/,1)[0];
 return /^(?:ui:\/\/chathand\/(?:task|image-batch)(?:-[a-f0-9]{10})?\.html|ui:\/\/ken-bridge\/task-v06\.html|ui:\/\/chathand\/image-batch-v1\.html)$/.test(bare)?bare:null;
}
// Readers can merge old rotated files with daily files without renaming or
// rewriting historical evidence. Paths are returned oldest first, contents never.
export function traceFiles(dir){
 let st;try{st=fs.lstatSync(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}
 if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe trace directory');
 const names=fs.readdirSync(dir);
 return [...['rpc.jsonl.3','rpc.jsonl.2','rpc.jsonl.1','rpc.jsonl'].filter(n=>names.includes(n)),...names.filter(dailyName).sort()].map(n=>path.join(dir,n));
}
const counts=()=>({http_received:0,http_rejected:0,rpc_received:0,tools_received:0,read_calls:0,mutating_calls:0,handler_ok:0,handler_error:0,http_finished:0,http_aborted:0});
const errCode=c=>typeof c==='string'&&/^[A-Z][A-Z0-9_]{0,60}$/.test(c)?c:'UNCLASSIFIED';
// Size is computed in memory on the actual RPC envelope; no bytes/content are retained.
export function measureResponseLength(value){
 if(value===null||value===undefined)return {chars:0,bytes:0};
 try{const raw=JSON.stringify(value);return typeof raw==='string'?{chars:raw.length,bytes:Buffer.byteLength(raw,'utf8')}:{chars:0,bytes:0};}
 catch{return {chars:null,bytes:null};}
}
export class CallTrace {
 constructor(stateDir,definitions,{maxBytes=200*1024*1024,retentionDays=30,capacity=500,now=Date.now}={}){
  this.dir=path.join(stateDir,'call-trace');privateDir(this.dir);this.now=now;
  this.defs=new Map(definitions.map(t=>[t.name,t]));this.instance_id=crypto.randomUUID();this.started_at=this.now();
  this.salt=installationSalt(stateDir);this.seq=0;this.receivedSeq=0;this.counters=counts();this.entries=[];this.inflight=new Map();this.marks=new Map();
  this.maxBytes=Number.isSafeInteger(maxBytes)&&maxBytes>0?maxBytes:200*1024*1024;this.retentionDays=Math.max(30,Number.isSafeInteger(retentionDays)?retentionDays:30);this.capacity=capacity;this.write_failures=0;this.rotations=0;this.dropped_from_memory=0;this.resourceCalls=new Map();this.pruned_days=0;this.capacity_pruned_days=0;
  this.record('trace_started',null,{});
 }
 hash(value){return crypto.createHmac('sha256',this.salt).update(String(value)).digest('hex').slice(0,24);}
 get file(){return path.join(this.dir,'rpc-'+new Date(this.now()).toISOString().slice(0,10)+'.jsonl');}
 pruneDaily(incomingBytes=0){
  const current=path.basename(this.file),cutoff=new Date(this.now()-this.retentionDays*DAY).toISOString().slice(0,10);
  const files=traceFiles(this.dir).map(file=>{const st=fs.lstatSync(file);if(!safeFile(st))throw Error('unsafe daily trace');return {file,name:path.basename(file),size:st.size};});
  let total=files.reduce((n,d)=>n+d.size,0);
  for(const d of files.filter(d=>dailyName(d.name))){
   const expired=d.name.slice(4,14)<cutoff,over=total+incomingBytes>this.maxBytes;
   if(d.name===current||!expired&&!over)continue;
   // Recheck immediately before removal; never follow symlinks/hardlinks.
   if(!safeFile(fs.lstatSync(d.file)))throw Error('unsafe daily trace');
   fs.unlinkSync(d.file);total-=d.size;this.pruned_days++;if(!expired)this.capacity_pruned_days++;
  }
  // Keep the current day's original evidence intact if it alone reaches the cap.
  // Dropped disk observations are disclosed through write_failures.
  if(total+incomingBytes>this.maxBytes)throw Error('daily trace capacity');
 }
 append(data){
  try{
   const line=JSON.stringify(data)+'\n';this.pruneDaily(Buffer.byteLength(line));
   let st;try{st=fs.lstatSync(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(st&&(!st.isFile()||st.isSymbolicLink()||st.nlink!==1))throw Error('unsafe trace file');
   const fd=fs.openSync(this.file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
   try{if(!safeFile(fs.fstatSync(fd)))throw Error('unsafe trace handle');fs.fchmodSync(fd,0o600);fs.writeSync(fd,line);}finally{fs.closeSync(fd);}
  }catch{this.write_failures++;} // Observability failure must not rerun or change a tool outcome.
 }
 record(event,id,fields){const entry={format:1,instance_id:this.instance_id,seq:++this.seq,at:new Date(this.now()).toISOString(),event,call_id:id,...fields};this.entries.push(entry);if(this.entries.length>this.capacity){this.entries.shift();this.dropped_from_memory++;}this.append(entry);return entry;}
 receiveHTTP(caller){const id=crypto.randomUUID();this.counters.http_received++;this.inflight.set(id,performance.now());this.record('http_received',id,{caller_hash:this.hash(caller),transport:'local_http'});return id;}
 rejectedHTTP(id,code){this.counters.http_rejected++;this.record('http_rejected',id,{code:errCode(code)});}
 receiveRPC(body,caller,{callId,transport='direct_rpc',traceMetadata={}}={}){
  const id=callId||crypto.randomUUID();if(!this.inflight.has(id))this.inflight.set(id,performance.now());
  const method=allowedMethods.has(body?.method)?body.method:'unknown';const definition=this.defs.get(body?.params?.name);const tool=method==='tools/call'?(definition?.name||'unknown'):null;
  this.counters.rpc_received++;this.receivedSeq++;
  if(method==='resources/read'||method==='resources/list'){
   const fields={method,uri:method==='resources/read'?safeResourceURI(body?.params?.uri):null};this.resourceCalls.set(id,fields);
   this.record('rpc_received',id,fields);return id;
  }
  if(method==='tools/call'){this.counters.tools_received++;this.counters[definition?.annotations?.readOnlyHint===true?'read_calls':'mutating_calls']++;}
  this.record('rpc_received',id,{receive_seq:this.receivedSeq,method,tool,caller_hash:this.hash(caller),request_hash:this.hash(JSON.stringify(body?.id??null)),task_hash:typeof traceMetadata.task_id==='string'?this.hash(traceMetadata.task_id):typeof body?.params?.arguments?.task_id==='string'?this.hash(body.params.arguments.task_id):null,card:traceMetadata.card===true||tool==='task_status'&&body?.params?.arguments?.from_card===true,...(tool==='command_result'?{wait_ms:Number.isSafeInteger(traceMetadata.wait_ms??body?.params?.arguments?.wait_ms)?(traceMetadata.wait_ms??body.params.arguments.wait_ms):null,brief:(traceMetadata.brief??body?.params?.arguments?.brief)===true}:{}),operation_hash:typeof body?.params?.arguments?.request_id==='string'?this.hash(body.params.arguments.request_id):null,transport:['local_http','relay','site_b','direct_rpc'].includes(transport)?transport:'direct_rpc'});
  return id;
 }
 handled(id,result,length=null){if(this.resourceCalls.has(id)){const failed=!!(result?.error||result?.result?.isError);const raw=result?.error?.code;this.finishResource(id,failed,failed?(Number.isInteger(raw)&&raw>=-32768&&raw<=-32000?raw:'UNCLASSIFIED'):'OK');return;}const error=result?.error||result?.result?.isError;this.counters[error?'handler_error':'handler_ok']++;const bytes=length||measureResponseLength(result);this.record(error?'handler_error':'handler_ok',id,{code:error?errCode(result?.result?.structuredContent?.code||result?.error?.code):null,replayed:result?.result?.structuredContent?.replayed===true,duration_ms:Math.max(0,Math.round(performance.now()-(this.inflight.get(id)||performance.now()))),response_chars:bytes.chars,response_bytes:bytes.bytes,ack_scope:'local_handler_only'});this.inflight.delete(id);}
 finishResource(id,error,code){this.counters[error?'handler_error':'handler_ok']++;this.record(error?'handler_error':'handler_ok',id,{...this.resourceCalls.get(id),code,duration_ms:Math.max(0,Math.round(performance.now()-(this.inflight.get(id)??performance.now())))});this.resourceCalls.delete(id);this.inflight.delete(id);}
 handlerException(id,error){if(this.resourceCalls.has(id)){this.finishResource(id,true,error?.code==='RESOURCE_MISSING'?'RESOURCE_MISSING':'UNCLASSIFIED');return;}this.counters.handler_error++;this.record('handler_error',id,{code:errCode(error?.code),response_chars:0,response_bytes:0,ack_scope:'local_handler_only'});this.inflight.delete(id);}
 httpDone(id,status,aborted=false){this.resourceCalls.delete(id);this.counters[aborted?'http_aborted':'http_finished']++;this.record(aborted?'http_aborted':'http_finished',id,{http_status:Number.isInteger(status)?status:0,ack_scope:'local_stream_only'});this.inflight.delete(id);}
 snapshot(){return {format:1,instance_id:this.instance_id,started_at:this.started_at,receive_seq:this.receivedSeq,event_seq:this.seq,counters:{...this.counters},write_failures:this.write_failures,rotations:this.rotations,dropped_from_memory:this.dropped_from_memory,last_rpc_at:[...this.entries].reverse().find(e=>e.event==='rpc_received')?.at||null,scope:'expected_host_mcp_ingress_and_handler_only',host_approval_state:'not_observable',host_received_response:'not_observable',logs_contain_payloads:false,storage:{layout:'daily_utc',retention_days:this.retentionDays,max_bytes:this.maxBytes,capacity_overrides_retention:true,pruned_days:this.pruned_days,capacity_pruned_days:this.capacity_pruned_days,legacy_files_untouched:true}};}
 startObservation(){if(this.marks.size>=20)this.marks.delete(this.marks.keys().next().value);const id=crypto.randomUUID(),mark={id,at:new Date(this.now()).toISOString(),baseline:this.snapshot()};this.marks.set(id,mark);return {id,at:mark.at,instance_id:this.instance_id,instructions:'在网页出现卡片时观察一次。不要为取证重复执行验收；回到本机结束观察。'};}
 endObservation(id){const mark=this.marks.get(id);if(!mark)fail('OBSERVATION_MISSING','观察起点不存在或服务已经重启。重新开始观察，不猜测历史。');const after=this.snapshot(),before=mark.baseline;const delta=Object.fromEntries(Object.keys(after.counters).map(k=>[k,after.counters[k]-before.counters[k]]));
  const incomplete=after.write_failures>before.write_failures;
  const conclusion=incomplete?'TRACE_INCOMPLETE':delta.http_rejected>0?'LOCAL_AUTH_REJECTIONS_OBSERVED':delta.tools_received===0?(delta.http_received||delta.rpc_received?'NO_TOOL_DISPATCH_OBSERVED':'NO_LOCAL_REQUEST_OBSERVED'):delta.mutating_calls===0?'READ_ONLY_CALLS_OBSERVED':'MUTATING_CALLS_OBSERVED_CHECK_EFFECTS';
  const rows=this.entries.filter(e=>e.seq>before.event_seq);const result={format:1,id,from:mark.at,to:new Date(this.now()).toISOString(),instance_id:this.instance_id,delta,conclusion,observed_locally:true,effects:'Compare command receipts and proof hashes; a call is not proof of execution.',platform_root_cause:'NOT_DETERMINED',trace_complete:!incomplete,rows_complete:rows.length===(after.event_seq-before.event_seq),host_ui_not_observed:true,events:rows};return result;
 }
}
