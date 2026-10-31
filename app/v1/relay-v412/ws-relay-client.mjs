import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {safeSiteErrorCode,siteRequestErrorCode} from '../site-request-errors.mjs';
import {createReconnectBackoff} from '../reconnect-backoff.mjs';
const MAX_CHUNK=128*1024,MAX_MESSAGE=6*1024*1024,MAX_FRAME=192*1024;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const epoch=()=>performance.timeOrigin+performance.now();
const fixedError=code=>Object.assign(Error(code),{code});
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const encrypt=(bytes,key)=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};};
const decrypt=(entry,key)=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(entry.iv,'base64'));decipher.setAuthTag(Buffer.from(entry.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext,'base64')),decipher.final()]);};
const manifestEntry=(manifest,name)=>manifest instanceof Map?manifest.get(name):Array.isArray(manifest)?manifest.find(tool=>tool?.name===name):manifest?.[name];
function supportedTemplateVersion(value){
 if(value===undefined)return {version:'4.0.0',major:4,minor:0};
 if(typeof value!=='string')return null;
 const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(value);
 if(!match)return null;
 const major=Number(match[1]),minor=Number(match[2]),patch=Number(match[3]);
 return major===4&&(minor===0||minor===1)&&Number.isSafeInteger(patch)?{version:value,major,minor}:null;
}
export function resolveExecutionMode({rpc,toolManifest={},job={},queueWaitMs=0,connectionSwitched=false,templateVersion}){
 const name=rpc?.params?.name,declared=manifestEntry(toolManifest,name);
 if(!declared)return 'confirmed';
 const annotations=declared?.annotations||declared;
 const destructiveHint=annotations?.destructiveHint===true;
 const readOnly=annotations?.readOnly===true||annotations?.readonly===true||annotations?.readOnlyHint===true;
 if(readOnly&&!destructiveHint)return 'readonly';
 const retransmitted=job.replayed===true||job.redelivered===true||(Number.isSafeInteger(job.delivery_attempt)&&job.delivery_attempt>1);
 const legacyTemplate=supportedTemplateVersion(templateVersion)?.minor!==1;
 return (destructiveHint&&legacyTemplate)||retransmitted||connectionSwitched||queueWaitMs>100?'confirmed':'immediate';
}
export function encodeFrame(opcode,payload){const bytes=Buffer.isBuffer(payload)?payload:Buffer.from(payload);if(bytes.length>MAX_FRAME)throw fixedError('WS_FRAME_LIMIT');const n=bytes.length<126?2:bytes.length<=65535?4:10,header=Buffer.alloc(n);header[0]=128|opcode;header[1]=128|(n===2?bytes.length:n===4?126:127);if(n===4)header.writeUInt16BE(bytes.length,2);if(n===10)header.writeBigUInt64BE(BigInt(bytes.length),2);const mask=crypto.randomBytes(4),data=Buffer.from(bytes);for(let i=0;i<data.length;i++)data[i]^=mask[i%4];return Buffer.concat([header,mask,data]);}
export function decodeFrame(buffer){if(buffer.length<2)return null;if(buffer[0]&112||buffer[1]&128)throw fixedError('WS_FRAME_PROTOCOL');let length=buffer[1]&127,offset=2;if(length===126){if(buffer.length<4)return null;length=buffer.readUInt16BE(2);offset=4;}else if(length===127){if(buffer.length<10)return null;const big=buffer.readBigUInt64BE(2);if(big>BigInt(MAX_FRAME))throw fixedError('WS_FRAME_LIMIT');length=Number(big);offset=10;}if(length>MAX_FRAME)throw fixedError('WS_FRAME_LIMIT');const opcode=buffer[0]&15,fin=Boolean(buffer[0]&128);if(opcode>=8&&(!fin||length>125))throw fixedError('WS_CONTROL_PROTOCOL');if(buffer.length<offset+length)return null;return {opcode,fin,payload:buffer.subarray(offset,offset+length),consumed:offset+length};}
export function createWire(upgraded){
 const events=new EventEmitter(),socket=upgraded.socket;let buffer=Buffer.alloc(0),fragments=[],fragmentBytes=0,closed=false;
 const wire={events,closed:false,ready:false,draining:false,owned:new Set(),clock:upgraded,send(value){if(closed)throw fixedError('WS_CLOSED');socket.write(encodeFrame(1,JSON.stringify(value)));},close(){if(closed)return;try{socket.write(encodeFrame(8,Buffer.from([3,232])));}catch{}socket.destroy();end();},start(){if(upgraded.head?.length)consume(upgraded.head);}};
 function end(){if(closed)return;closed=true;wire.closed=true;events.emit('closed');}
 function text(bytes){if(bytes.length>MAX_FRAME)throw fixedError('WS_MESSAGE_LIMIT');const frame=JSON.parse(bytes.toString('utf8'));if(frame?.v!==1||typeof frame.type!=='string')throw fixedError('WS_PROTOCOL_INVALID');events.emit('message',frame);}
 function consume(chunk){if(closed)return;try{if(buffer.length+chunk.length>2*MAX_FRAME)throw fixedError('WS_BUFFER_LIMIT');buffer=Buffer.concat([buffer,chunk]);for(;;){const f=decodeFrame(buffer);if(!f)break;buffer=buffer.subarray(f.consumed);if(f.opcode===8){socket.destroy();end();return;}if(f.opcode===9){socket.write(encodeFrame(10,f.payload));continue;}if(f.opcode===10)continue;if(f.opcode===1){if(fragments.length)throw fixedError('WS_FRAGMENT_PROTOCOL');if(f.fin)text(f.payload);else{fragments=[f.payload];fragmentBytes=f.payload.length;}continue;}if(f.opcode===0&&fragments.length){fragmentBytes+=f.payload.length;if(fragmentBytes>MAX_FRAME)throw fixedError('WS_MESSAGE_LIMIT');fragments.push(f.payload);if(f.fin){text(Buffer.concat(fragments));fragments=[];fragmentBytes=0;}continue;}throw fixedError('WS_OPCODE_INVALID');}}catch{events.emit('protocol-error');wire.close();}}
 socket.on('data',consume);socket.once('error',()=>end());socket.once('close',end);socket.once('end',end);return wire;
}
export async function runWsClient({connect,execute,root,origin='offline-fixture',durationMs,signal,lifecycle:lifecycleHandle,assertCurrent=()=>{},onReady=()=>{},onHeartbeat=()=>{},log=()=>{},toolManifest={},cacheKey,resultTtlMs=60000,prepareRuntime,manifest,settings,retryClock=Date.now,random=Math.random,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(cacheKey!==undefined&&(!Buffer.isBuffer(cacheKey)||cacheKey.length!==32))throw fixedError('WS_CACHE_KEY_INVALID');
 if(!Number.isSafeInteger(resultTtlMs)||resultTtlMs<1)throw fixedError('WS_RESULT_TTL_INVALID');
 if(prepareRuntime!==undefined){
  if(typeof prepareRuntime!=='function')throw fixedError('WS_RUNTIME_PREPARE_FAILED');
  try{await prepareRuntime({manifest,settings});}catch(error){throw fixedError(safeSiteErrorCode(error?.code)||siteRequestErrorCode(error));}
 }
 const cacheFile=path.join(root,`evidence/current/ws-result-cache-${hash(Buffer.from(origin)).slice(0,16)}.json`),doneFile=path.join(root,'evidence/current/done-job-ids.json');
 const cache=new Map(),done=new Set(),connections=new Set(),running=new Map(),assembling=new Map(),pendingExecution=new Set(),sending=new Set(),pendingChunks=new Map(),pendingStarts=new Map(),cancelled=new Set();let primary,stopped=false,quiescing=false,opening=false,connectionGeneration=0,fatalError;
 const backoff=createReconnectBackoff({now:retryClock,random});
 fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
 try{for(const id of JSON.parse(fs.readFileSync(doneFile,'utf8')))done.add(id);}catch{}
 try{const saved=JSON.parse(fs.readFileSync(cacheFile,'utf8'));for(const entry of saved){if(identity(entry.job_id)&&identity(entry.claim_id)&&entry.tombstone_until>Date.now()){
   if(entry.state==='executing')entry.state='unknown';
   if(entry.state==='done'){
    if(!cacheKey||!entry.ciphertext){entry.state='unknown';delete entry.ciphertext;delete entry.iv;delete entry.tag;}
    else try{decrypt(entry,cacheKey);}catch{entry.state='unknown';delete entry.ciphertext;delete entry.iv;delete entry.tag;}
   }
   cache.set(entry.job_id,entry);
  }}}catch{}
 const save=()=>{const now=Date.now();for(const [id,entry] of cache){if(entry.result_expires_at&&entry.result_expires_at<=now&&entry.state==='done'){const tombstone={job_id:entry.job_id,claim_id:entry.claim_id,request_hash:entry.request_hash,state:'expired',tombstone_until:entry.tombstone_until};for(const key of Object.keys(entry))delete entry[key];Object.assign(entry,tombstone);}if(entry.tombstone_until<=now&&!running.has(id))cache.delete(id);}const raw=JSON.stringify([...cache.values()]);if(Buffer.byteLength(raw)>20*1024*1024)throw fixedError('WS_CACHE_LIMIT');const temp=cacheFile+'.tmp';fs.writeFileSync(temp,raw,{mode:0o600});fs.renameSync(temp,cacheFile);};
 const liveCount=()=>[...cache.values()].filter(e=>e.state==='executing'||e.state==='done').length+assembling.size+pendingExecution.size;
 const capacity=wire=>Math.min(2,wire.owned.size+Math.max(0,2-liveCount()));
 function lifecycle(wire,phase,reason,extra={}){log({event:'ws_lifecycle',phase,reason,at_ms:epoch(),client_connection_id:wire?.clientId,connection_id:wire?.connectionId,previous_connection_id:wire?.predecessor?.connectionId,connections:connections.size,...extra});}
 function broadcastCapacity(){for(const wire of connections)if(wire===primary&&wire.ready&&!wire.closed&&!wire.draining&&!wire.prepared)wire.send({v:1,type:'capacity',capacity:capacity(wire)});}
 function uncertain(id){const entry=cache.get(id);if(entry){entry.state='unknown';for(const key of ['data','ciphertext','iv','tag'])delete entry[key];save();}running.get(id)?.abort();assembling.delete(id);for(const wire of connections)wire.owned.delete(id);broadcastCapacity();}
 function release(id,accepted){const entry=cache.get(id);if(entry){entry.state=accepted?'acked':'unknown';for(const key of ['data','ciphertext','iv','tag'])delete entry[key];save();}for(const wire of connections)wire.owned.delete(id);sending.delete(id);broadcastCapacity();}
 function waitChunk(wire,id,claim,sequence){return new Promise((resolve,reject)=>{const key=id+':'+sequence;if(pendingChunks.has(key))return reject(fixedError('WS_CHUNK_WAIT_DUPLICATE'));const timer=setTimeout(()=>{pendingChunks.delete(key);reject(fixedError('WS_CHUNK_ACK_TIMEOUT'));},20000);pendingChunks.set(key,{wire,resolve:()=>{clearTimeout(timer);pendingChunks.delete(key);resolve();},reject:()=>{clearTimeout(timer);pendingChunks.delete(key);reject(fixedError('WS_CLOSED'));},claim});});}
 function authorize(wire,job){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingStarts.delete(job.job_id);reject(fixedError('WS_START_TIMEOUT'));},10000);pendingStarts.set(job.job_id,{wire,claim:job.claim_id,resolve:frame=>{clearTimeout(timer);pendingStarts.delete(job.job_id);resolve(frame);},reject:()=>{clearTimeout(timer);pendingStarts.delete(job.job_id);reject(fixedError('WS_CLOSED'));}});wire.send({v:1,type:'start',job_id:job.job_id,claim_id:job.claim_id});});}
 async function sendResult(entry,wire,executionMode=entry.execution_mode){
  if(sending.has(entry.job_id)||wire.closed||entry.state!=='done')return;sending.add(entry.job_id);wire.owned.add(entry.job_id);
  try{save();if(entry.state!=='done')throw fixedError('WS_RESULT_EXPIRED');const bytes=decrypt(entry,cacheKey);if(bytes.length!==entry.total_bytes||hash(bytes)!==entry.sha256)throw fixedError('WS_CACHE_INTEGRITY');entry.timing.mac_result_send_ms=epoch();entry.timing.prepare_result_ms=entry.timing.mac_result_send_ms-entry.timing.mac_execute_end_ms;entry.timing.ws_send_start_perf_ms=performance.now();wire.send({v:1,protocol:'chathand-relay-v4',type:'result-start',job_id:entry.job_id,claim_id:entry.claim_id,total_bytes:entry.total_bytes,total_chunks:entry.total_chunks,sha256:entry.sha256,execution_mode:executionMode});
   for(let first=0;first<entry.total_chunks;first+=4){const waits=[];for(let sequence=first;sequence<Math.min(first+4,entry.total_chunks);sequence++){const part=bytes.subarray(sequence*MAX_CHUNK,(sequence+1)*MAX_CHUNK);if(entry.total_chunks>1)waits.push(waitChunk(wire,entry.job_id,entry.claim_id,sequence));wire.send({v:1,type:'result-chunk',job_id:entry.job_id,claim_id:entry.claim_id,sequence,sha256:hash(part),data:part.toString('base64')});}if(waits.length)await Promise.all(waits);}
   wire.send({v:1,protocol:'chathand-relay-v4',type:'result-end',job_id:entry.job_id,claim_id:entry.claim_id,transport_timing:{version:'rc-timing-1',mac:entry.timing}});
  }catch{sending.delete(entry.job_id);if(!wire.closed)wire.close();}
 }
 function resume(entry,wire){wire.owned.add(entry.job_id);wire.send({v:1,type:'resume',results:[{job_id:entry.job_id,claim_id:entry.claim_id,request_hash:entry.request_hash,sha256:entry.sha256,total_bytes:entry.total_bytes,total_chunks:entry.total_chunks}]});}
 async function executeTask(job,wire,raw){
  // Replace the verified-but-not-dispatched capacity reservation synchronously.
  pendingExecution.delete(job.job_id);
  save();
  if(done.has(job.job_id)||cache.has(job.job_id)){const old=cache.get(job.job_id);if(old?.state==='done'&&old.claim_id===job.claim_id&&old.request_hash===job.request_hash)resume(old,wire);else wire.send({v:1,type:'unknown',job_id:job.job_id,claim_id:job.claim_id});return;}
  let rpc;try{rpc=JSON.parse(raw.toString('utf8'));}catch{wire.send({v:1,type:'unknown',job_id:job.job_id,claim_id:job.claim_id});return;}
  const entry={job_id:job.job_id,claim_id:job.claim_id,request_hash:job.request_hash,state:'executing',tombstone_until:Date.now()+8*3600000,timing:{mac_received_poll_ms:job.received_ms,mac_verified_ms:epoch()},server_timing:job.server_timing,calibration:job.calibration};cache.set(job.job_id,entry);save();broadcastCapacity();
  const controller=new AbortController();const expiry=setTimeout(()=>controller.abort(),Math.max(0,job.expires_at-(epoch()+(wire.calibration?.offset_high_ms??Infinity))));controller.signal.addEventListener('abort',()=>clearTimeout(expiry),{once:true});expiry.unref?.();running.set(job.job_id,controller);if(job.cancel_requested||cancelled.delete(job.job_id))controller.abort();
  const queueWaitMs=Math.max(0,performance.now()-job.task_verified_perf_ms),execution_mode=resolveExecutionMode({rpc,toolManifest,job,queueWaitMs,connectionSwitched:wire.closed||wire!==primary||wire.generation!==primary?.generation,templateVersion:wire.templateVersion});
  entry.execution_mode=execution_mode;
  if(!cacheKey){running.delete(job.job_id);uncertain(job.job_id);if(!wire.closed)wire.send({v:1,protocol:'chathand-relay-v4',type:'unknown',job_id:job.job_id,claim_id:job.claim_id});return;}
  if(controller.signal.aborted){running.delete(job.job_id);uncertain(job.job_id);if(!wire.closed)wire.send({v:1,protocol:'chathand-relay-v4',type:'unknown',job_id:job.job_id,claim_id:job.claim_id});return;}
  const assert=()=>{
   controller.signal.throwIfAborted();assertCurrent();
   const clock=wire.calibration,siteNowHigh=clock?epoch()+clock.offset_high_ms:Infinity;
   if(stopped||wire.closed||siteNowHigh>=job.expires_at)throw fixedError('WS_EXECUTION_EXPIRED');
  };
  let startInFlight=null,lastStartAt=-Infinity,lastStartPrimary=null,lastStartMode=null;
  const beforeStart=async()=>{
   assert();
   const mode=resolveExecutionMode({rpc,toolManifest,job,queueWaitMs:Math.max(0,performance.now()-job.task_verified_perf_ms),connectionSwitched:wire!==primary||wire.generation!==primary?.generation,templateVersion:wire.templateVersion});
   if(performance.now()-lastStartAt<=100&&lastStartPrimary===primary&&lastStartMode===mode){assert();return;}
   if(startInFlight){await startInFlight;assert();return beforeStart();}
   startInFlight=(async()=>{if(mode==='confirmed'){
    const startGuard=performance.now(),permission=await authorize(wire,job);
    entry.timing.start_authorization_ms=(entry.timing.start_authorization_ms||0)+performance.now()-startGuard;
    assert();const siteNowHigh=epoch()+wire.calibration.offset_high_ms;
    if(!permission.authorized||!Number.isFinite(permission.authorized_at_ms)||siteNowHigh-permission.authorized_at_ms>1000)throw fixedError('WS_START_REJECTED');
    entry.execution_mode='confirmed';
   }assert();lastStartAt=performance.now();lastStartPrimary=primary;lastStartMode=mode;})();
   try{await startInFlight;}finally{startInFlight=null;}
  };
  try{await beforeStart();}catch{running.delete(job.job_id);uncertain(job.job_id);if(!wire.closed)wire.send({v:1,type:'unknown',job_id:job.job_id,claim_id:job.claim_id});return;}
  const started=performance.now();entry.timing.mac_execute_start_ms=epoch();let response,localElapsed;
  log({event:'execution_started',job:job.job_id,claim_id:job.claim_id,transport:'ws'});
  try{const out=await execute(rpc,{signal:controller.signal,beforeStart,assert,delivery:Object.freeze({job_id:job.job_id,request_hash:job.request_hash})});response=out.response;localElapsed=out.elapsed_ms;}catch(error){response={jsonrpc:'2.0',id:rpc.id,error:{code:-32000,message:error.name==='AbortError'?'REQUEST_CANCELLED':error.message}};}
  finally{clearTimeout(expiry);running.delete(job.job_id);entry.timing.mac_execute_end_ms=epoch();entry.timing.execute_ms=performance.now()-started;}
  const bytes=Buffer.from(JSON.stringify(response));if(bytes.length>MAX_MESSAGE){uncertain(job.job_id);return;}
  if(Number.isFinite(localElapsed))entry.timing.local_elapsed_ms=localElapsed;entry.state='done';Object.assign(entry,encrypt(bytes,cacheKey));entry.sha256=hash(bytes);entry.total_bytes=bytes.length;entry.total_chunks=Math.ceil(bytes.length/MAX_CHUNK);entry.result_expires_at=Date.now()+resultTtlMs;entry.local_elapsed_ms=localElapsed;entry.method=rpc.method;entry.tool=rpc.params?.name;entry.timing.processing_ms=Math.max(0,performance.now()-job.task_ended_perf_ms-queueWaitMs-(entry.timing.start_authorization_ms||0));done.add(job.job_id);fs.writeFileSync(doneFile,JSON.stringify([...done]));save();
  if(!wire.closed)await sendResult(entry,wire);else if(primary?.ready&&!primary.closed)resume(entry,primary);
 }
 function switchPrimary(wire,old){
  if(stopped||wire.closed||!wire.ready||primary===wire)return;if(wire.draining){wire.close();return;}
  wire.prepared=false;wire.generation=++connectionGeneration;primary=wire;backoff.reset();onReady({templateVersion:wire.templateVersion});
  const resumes=[...cache.values()].filter(e=>e.state==='done'&&![...connections].some(c=>c!==wire&&!c.closed&&c.owned.has(e.job_id)));if(resumes.length>2)throw fixedError('WS_RESUME_LIMIT');
  for(const entry of resumes)resume(entry,wire);wire.send({v:1,type:'activate',capacity:capacity(wire),...(wire.prepareProtocol?{rotation_protocol:'prepare-v1'}:{})});
  lifecycle(wire,'switch',old?'replacement':'startup');
  if(old&&old!==wire&&!old.closed){old.draining=true;old.send(wire.prepareProtocol&&old.prepareProtocol?{v:1,type:'handoff-complete',successor_id:wire.connectionId}:{v:1,type:'handoff'});lifecycle(old,'drain','handoff');}
  broadcastCapacity();log({event:'ws_connected',connections:connections.size,clock:wire.calibration});
 }
 async function activate(wire){
  lifecycle(wire,'calibration_start',wire.predecessor?'replacement':'startup');
  const observations=[];
  for(let sequence=1;sequence<=2;sequence++){
   const t1=epoch(),started=performance.now();const pong=await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);wire.events.removeListener('pong',receive);wire.events.removeListener('closed',gone);};const timer=setTimeout(()=>{cleanup();reject(fixedError('WS_CLOCK_TIMEOUT'));},3000);function gone(){cleanup();reject(fixedError('WS_CLOSED'));}function receive(frame){if(frame.sequence!==sequence)return;cleanup();resolve(frame);}wire.events.on('pong',receive);wire.events.once('closed',gone);wire.send({v:1,type:'ping',sequence});});
   const t4=epoch(),t2=pong.wall_start_ms,t3=pong.worker_reply_ms,low=t3-t4,high=t2-t1;
   if(!Number.isFinite(t2)||!Number.isFinite(t3)||t3<t2||high<low)throw fixedError('WS_CLOCK_INVALID');
   observations.push({offset_low_ms:low,offset_high_ms:high,offset_mid_ms:(low+high)/2,offset_error_ms:(high-low)/2,elapsed_ms:performance.now()-started,network_residual_ms:(t4-t1)-(t3-t2)});lifecycle(wire,`calibration_probe${sequence}`,'replacement',{elapsed_ms:performance.now()-started});
  }
  if(stopped||wire.closed)return;wire.calibration=observations.sort((a,b)=>a.offset_error_ms-b.offset_error_ms)[0];wire.ready=true;lifecycle(wire,'calibration_ready',wire.predecessor?'replacement':'startup');
  const old=wire.predecessor;
  if(old&&!old.closed&&primary===old&&old.prepareProtocol&&wire.prepareProtocol){wire.prepared=true;old.successor=wire;wire.send({v:1,type:'activate',capacity:0,rotation_protocol:'prepare-v1'});old.send({v:1,type:'handoff',wait_for_switch:true,successor_id:wire.connectionId});}
  else switchPrimary(wire,old&&!old.closed?old:undefined);
 }
 function onMessage(wire,frame){
  try{
   if(frame.type==='heartbeat-ack'){if(wire===primary&&wire.ready)onHeartbeat();return;}
   if(frame.type==='lifecycle'){const fields={};for(const key of ['phase','reason','connection_id'])if(identity(frame[key]))fields[key]=frame[key];for(const key of ['at_ms','elapsed_ms','sql_operations','max_operations','rotate_ms'])if(Number.isFinite(frame[key]))fields[key]=frame[key];log({event:'ws_lifecycle',client_connection_id:wire.clientId,connections:connections.size,...fields});return;}
   if(frame.type==='pong'){wire.events.emit('pong',frame);return;}
   if(frame.type==='start-ack'){const waiter=pendingStarts.get(frame.job_id);if(waiter?.wire===wire&&waiter.claim===frame.claim_id)waiter.resolve(frame);return;}
   if(frame.type==='metrics'){log({event:'ws_metrics',metrics:frame.metrics,db_connection:frame.db_connection});return;}
   if(frame.type==='ready'){
    if(wire.ready||wire.initializing)return;wire.initializing=true;
    const template=supportedTemplateVersion(frame.template_version);
    if(!template){fatalError=fixedError('WS_TEMPLATE_VERSION_UNSUPPORTED');fatalError.template_version=frame.template_version;log({event:'template_rejected',code:fatalError.code,template_version:frame.template_version,supported:['4.0.x','4.1.x']});stop();return;}
    wire.templateVersion=template.version;wire.templateMajor=template.major;wire.templateMinor=template.minor;wire.prepareProtocol=frame.rotation_protocol==='prepare-v1';wire.connectionId=identity(frame.connection_id)?frame.connection_id:wire.clientId;lifecycle(wire,'site_ready',wire.predecessor?'replacement':'startup');
    void activate(wire).catch(error=>{lifecycle(wire,'prepare_failed','error',{code:/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:'WS_CLOCK_FAILED'});wire.close();});return;
   }
   if(frame.type==='prepare'){if(wire!==primary)return;wire.wantsReplacement=true;lifecycle(wire,'prepare',frame.reason==='time'?'time':'sql',{sql_operations:frame.sql_operations,max_operations:frame.max_operations,rotate_ms:frame.rotate_ms});void openConnection();return;}
   if(frame.type==='rotate'){wire.draining=true;wire.wantsReplacement=true;if(wire!==primary){wire.close();return;}void openConnection();return;}
   if(frame.type==='handoff-ack'){const replacement=wire.successor;if(replacement?.ready&&!replacement.closed&&replacement.prepared&&frame.successor_id===replacement.connectionId&&primary===wire)switchPrimary(replacement,wire);return;}
   if(frame.type==='chunk-ack'){const waiter=pendingChunks.get(frame.job_id+':'+frame.sequence);if(waiter?.wire===wire&&waiter.claim===frame.claim_id)waiter.resolve();return;}
   if(frame.type==='resume-status'){save();const entry=cache.get(frame.job_id);if(entry?.claim_id!==frame.claim_id)return;if(frame.status==='claimed')void sendResult(entry,wire,'confirmed');else uncertain(frame.job_id);return;}
   if(frame.type==='ack'){
    const entry=cache.get(frame.job_id);if(entry?.claim_id!==frame.claim_id)return;const clock=wire.calibration||{},wsSendToAckMs=Number.isFinite(entry.timing?.ws_send_start_perf_ms)?Math.max(0,performance.now()-entry.timing.ws_send_start_perf_ms):null;log({event:'executed',job:entry.job_id,method:entry.method,tool:entry.tool,execution_mode:entry.execution_mode,local_elapsed_ms:entry.local_elapsed_ms,result_bytes:entry.total_bytes,accepted:frame.accepted===true,replayed:frame.replayed===true,transport:'ws',ws_send_to_ack_ms:wsSendToAckMs,timing:{version:'rc-timing-1',mac:entry.timing,poll:{...entry.calibration,clock_source:'ws-ping',server:entry.server_timing},result:{...clock,clock_source:'ws-ping',mac_received_ms:epoch(),server:frame.server_timing}}});release(frame.job_id,frame.accepted===true);return;
   }
   if(frame.type==='cancel'){if(!identity(frame.job_id)||!identity(frame.claim_id))throw fixedError('WS_JOB_ID_INVALID');const entry=cache.get(frame.job_id);if(entry?.claim_id===frame.claim_id){running.get(frame.job_id)?.abort();const waiter=pendingStarts.get(frame.job_id);if(waiter?.wire===wire&&waiter.claim===frame.claim_id)waiter.reject();log({event:'cancel_received',job:frame.job_id,transport:'ws'});}const pending=assembling.get(frame.job_id);if(pending?.claim_id===frame.claim_id)pending.cancel_requested=true;else if(!entry)cancelled.add(frame.job_id);return;}
   if(!identity(frame.job_id)||!identity(frame.claim_id))throw fixedError('WS_JOB_ID_INVALID');
   if(frame.type==='task'){
    if(wire.prepared||!wire.ready)throw fixedError('WS_PREPARED_TASK_REJECTED');
    if(assembling.has(frame.job_id)||liveCount()>=2||!Number.isSafeInteger(frame.request_bytes)||frame.request_bytes<1||frame.request_bytes>MAX_MESSAGE||!Number.isSafeInteger(frame.request_chunks)||frame.request_chunks<1||frame.request_chunks>48||!/^[0-9a-f]{64}$/.test(frame.request_hash||''))throw fixedError('WS_TASK_LIMIT');
    wire.owned.add(frame.job_id);assembling.set(frame.job_id,{...frame,received_ms:epoch(),calibration:wire.calibration,parts:[],bytes:0,wire});return;
   }
   const job=assembling.get(frame.job_id);if(!job||job.claim_id!==frame.claim_id||job.wire!==wire)throw fixedError('WS_TASK_UNKNOWN');
   if(frame.type==='task-chunk'){
    if(frame.sequence!==job.parts.length||frame.sequence>=job.request_chunks||typeof frame.data!=='string'||frame.data.length>Math.ceil(MAX_CHUNK/3)*4)throw fixedError('WS_TASK_CHUNK_SEQUENCE');const bytes=Buffer.from(frame.data,'base64');if(bytes.length>MAX_CHUNK||bytes.toString('base64')!==frame.data||hash(bytes)!==frame.sha256)throw fixedError('WS_TASK_CHUNK_HASH');job.bytes+=bytes.length;if(job.bytes>job.request_bytes)throw fixedError('WS_TASK_BYTES');job.parts.push(bytes);return;
   }
   if(frame.type==='task-end'){
    if(job.parts.length!==job.request_chunks||job.bytes!==job.request_bytes)throw fixedError('WS_TASK_INCOMPLETE');job.task_ended_perf_ms=performance.now();const raw=Buffer.concat(job.parts);if(hash(raw)!==job.request_hash)throw fixedError('WS_TASK_HASH');job.task_verified_perf_ms=performance.now();pendingExecution.add(job.job_id);assembling.delete(job.job_id);job.parts=[];setImmediate(()=>void executeTask(job,wire,raw).catch(()=>{uncertain(job.job_id);wire.close();}));return;
   }
   throw fixedError('WS_FRAME_TYPE_INVALID');
  }catch{log({event:'transport_error',code:'WS_PROTOCOL_REJECTED',transport:'ws'});wire.close();}
 }
 const needsConnection=()=>!quiescing&&(!primary||primary.closed||primary.draining||primary.wantsReplacement);
 async function openConnection(){
  // Recheck delayed retries: closing a handed-off old wire must not replace a healthy primary.
  if(stopped||quiescing||opening||!backoff.due()||connections.size>=2||[...connections].some(c=>!c.ready&&!c.closed)||!needsConnection())return;opening=true;
  const predecessor=primary&&!primary.closed?primary:undefined,clientId=crypto.randomUUID(),started=performance.now();lifecycle({clientId,predecessor},'connect_start',predecessor?'replacement':'startup');
  try{const upgraded=await connect();if(stopped){upgraded.socket.destroy();return;}const wire=createWire(upgraded);Object.assign(wire,{clientId,predecessor});connections.add(wire);if(predecessor)predecessor.successor=wire;lifecycle(wire,'upgrade_ready',predecessor?'replacement':'startup',{elapsed_ms:performance.now()-started});wire.events.on('message',frame=>onMessage(wire,frame));wire.events.on('closed',()=>{connections.delete(wire);if(wire.predecessor?.successor===wire)wire.predecessor.successor=undefined;if(primary===wire){primary=undefined;if(!stopped&&wire.successor?.ready&&!wire.successor.closed)switchPrimary(wire.successor);}for(const waiter of pendingChunks.values())if(waiter.wire===wire)waiter.reject();for(const waiter of pendingStarts.values())if(waiter.wire===wire)waiter.reject();for(const id of wire.owned){running.get(id)?.abort();sending.delete(id);}for(const [id,job] of assembling)if(job.wire===wire)assembling.delete(id);lifecycle(wire,'close',stopped?'stop':'handoff');log({event:'ws_disconnected',connections:connections.size});if(!stopped&&primary?.ready&&!primary.closed&&!primary.draining){for(const id of wire.owned){const entry=cache.get(id);if(entry?.state==='done'&&![...connections].some(c=>!c.closed&&c.owned.has(id)))resume(entry,primary);}}if(!stopped&&needsConnection())backoff.fail();});wire.start();
  }catch(error){const code=/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:'WS_CONNECT_FAILED';lifecycle({clientId,predecessor},'prepare_failed','error',{code,elapsed_ms:performance.now()-started});log({event:'transport_error',code,transport:'ws'});if(/(?:401|403)$/.test(code)||code==='B_REMOTE_AUTH_REQUIRED'||/^WS_UPGRADE_HTTP_(?:429|5[0-9]{2})$/.test(code)){fatalError=fixedError(code);stop();}else if(!stopped)backoff.fail();}
  finally{opening=false;}
 }
 const peerTimer=setInterval(()=>{for(const wire of connections)if(wire.ready&&!wire.closed)wire.send({v:1,type:'heartbeat'});},5000);
 const expiryTimer=setInterval(()=>{const now=Date.now();if([...cache.values()].some(entry=>(entry.result_expires_at&&entry.result_expires_at<=now)||entry.tombstone_until<=now))save();},Math.min(1000,Math.max(50,resultTtlMs/2)));
 const stop=()=>{if(stopped)return;stopped=true;clearInterval(peerTimer);for(const controller of running.values())controller.abort();for(const wire of connections)wire.close();};if(lifecycleHandle){lifecycleHandle.close=stop;lifecycleHandle.drain=async()=>{quiescing=true;for(const wire of connections)if(wire.ready&&!wire.closed)wire.send({v:1,type:'capacity',capacity:0});while(!stopped&&liveCount()>0)await new Promise(resolve=>setTimeout(resolve,20));stop();};}signal?.addEventListener('abort',stop,{once:true});const timer=Number.isFinite(durationMs)?setTimeout(stop,durationMs):null;if(signal?.aborted)stop();save();await openConnection();
 while(!stopped){if(needsConnection()&&!opening)await openConnection();await sleep(backoff.remaining()>0?Math.min(1000,backoff.remaining()):200);}
 clearTimeout(timer);clearInterval(expiryTimer);signal?.removeEventListener('abort',stop);save();if(fatalError)throw fatalError;return {cache_entries:cache.size,done:done.size};
}
