// The connection owns only bounded transport/context; durable job state stays in guarded storage callbacks.
const MAX_CHUNK=128*1024,MAX_MESSAGE=6*1024*1024,MAX_FRAME=192*1024;
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=128;
function relayPollDelay({hotUntil=0,warmUntil=0,active=false,hotMs=50,warmMs=100,coldMs=500},now=performance.now()){return active||now<hotUntil?hotMs:now<warmUntil?warmMs:coldMs;}
export function createRelaySession(socket,hooks,{maxJobs=2,hotMs=50,warmMs=100,coldMs=500,hotWindowMs=30000,warmWindowMs=300000,rotateMs=45000,maxOperations=200,drainMs=60000,peerTimeoutMs=20000,templateVersion="4.1.1",runtimeConfigured=true}={}){
 if(maxJobs!==2||![hotMs,warmMs,coldMs].every(n=>Number.isSafeInteger(n)&&n>=25&&n<=10000)||hotMs>warmMs||warmMs>coldMs)throw Error('WS_POLICY_INVALID');
 const active=new Map(),incoming=new Map(),metrics={db_operations:0,claims:0,accepted:0,replayed:0,cancellations:0,cleanup_errors:0,transport_errors:0,rotations:0,peak_jobs:0,peak_result_bytes:0};
 let closed=false,draining=false,activated=false,handoffReady=false,capacity=0,claimPending=0,hotUntil=0,warmUntil=0,lastHeartbeat=-Infinity,lastCleanup=performance.now(),started=performance.now(),pending=Promise.resolve(),rotationAt=0,lastPeer=started,peerConfirmed=false,sleeper=null;
 if(!Number.isSafeInteger(peerTimeoutMs)||peerTimeoutMs<100||peerTimeoutMs>20000)throw Error('WS_PEER_TIMEOUT_INVALID');
 const peerTimer=setInterval(()=>{if(performance.now()-lastPeer>=peerTimeoutMs)finish(1012);},Math.min(500,peerTimeoutMs/4));
 // Frames can resume this one sleeping loop; they never start storage work themselves.
 function wake(){const waiting=sleeper;if(!waiting)return;sleeper=null;clearTimeout(waiting.timer);waiting.resolve();}
 function pause(ms){if(closed)return Promise.resolve();return new Promise(resolve=>{const waiting={resolve,timer:null};sleeper=waiting;waiting.timer=setTimeout(()=>{if(sleeper!==waiting)return;sleeper=null;resolve();},ms);});}
 function send(value){if(closed)return false;const text=JSON.stringify(value);if(text.length>MAX_FRAME)throw Error('WS_FRAME_LIMIT');socket.send(text);return true;}
 function finish(code=1000){if(closed)return;clearInterval(peerTimer);hooks.onMetrics?.({...metrics,active_jobs:active.size,elapsed_ms:performance.now()-started,last_peer_age_ms:performance.now()-lastPeer,peer_confirmed:Number(peerConfirmed)});closed=true;wake();try{socket.close(code,'relay-close');}catch{}}
 function rotate(){if(draining||closed)return;draining=true;rotationAt=performance.now();metrics.rotations++;send({v:1,type:'rotate'});}
 async function operation(name,...args){metrics.db_operations++;const value=await hooks[name](...args);if((hooks.dbOperations?.()??metrics.db_operations)>=maxOperations)rotate();return value;}
 const identity=frame=>safeId(frame.job_id)&&safeId(frame.claim_id);
 function context(frame){const job=active.get(frame.job_id);return job&&job.claim_id===frame.claim_id?job:null;}
 async function handle(frame,receivedAt){
  if(frame?.v!==1||typeof frame.type!=='string')throw Error('WS_PROTOCOL_INVALID');
  lastPeer=performance.now();if(!peerConfirmed){peerConfirmed=true;lastHeartbeat=lastPeer;const beat=operation('heartbeat').catch(()=>finish(1011));hooks.waitUntil?.(beat);}
  if(frame.type==='heartbeat')return;
  if(frame.type==='ping'){if(!Number.isSafeInteger(frame.sequence)||frame.sequence<1||frame.sequence>100)throw Error('WS_PING_INVALID');send({v:1,type:'pong',sequence:frame.sequence,wall_start_ms:receivedAt,worker_reply_ms:hooks.now?.()??Date.now()});return;}
  if(frame.type==='activate'||frame.type==='capacity'){if(!Number.isSafeInteger(frame.capacity)||frame.capacity<0||frame.capacity>maxJobs)throw Error('WS_CAPACITY_INVALID');const firstActivate=frame.type==='activate'&&!activated,previousCapacity=capacity;capacity=frame.capacity;if(frame.type==='activate')activated=true;if(firstActivate||(activated&&previousCapacity===0&&capacity>0))wake();return;}
  if(frame.type==='handoff'){handoffReady=true;rotate();wake();return;}
  if(frame.type==='resume'){
   if(!Array.isArray(frame.results)||frame.results.length>maxJobs||active.size+claimPending+frame.results.filter(e=>!active.has(e.job_id)).length>maxJobs)throw Error('WS_RESUME_LIMIT');
   for(const entry of frame.results){if(!identity(entry)||!safeId(entry.sha256)||!Number.isSafeInteger(entry.total_bytes)||entry.total_bytes<1||entry.total_bytes>MAX_MESSAGE||!Number.isSafeInteger(entry.total_chunks)||entry.total_chunks<1||entry.total_chunks>48)throw Error('WS_RESUME_INVALID');
    const restored=await operation('restore',entry);
    if(restored?.replayed){metrics.replayed++;send({v:1,type:'ack',job_id:entry.job_id,claim_id:entry.claim_id,accepted:true,replayed:true});continue;}
    if(!restored?.job){send({v:1,type:'resume-status',job_id:entry.job_id,claim_id:entry.claim_id,status:'unknown'});continue;}
    if(active.has(entry.job_id)&&!context(entry))throw Error('WS_CLAIM_CONFLICT');active.set(entry.job_id,restored.job);send({v:1,type:'resume-status',job_id:entry.job_id,claim_id:entry.claim_id,status:'claimed'});
   }return;
  }
  if(frame.type==='drain'){rotate();return;}
  if(frame.type==='unknown'){
   if(!identity(frame))throw Error('WS_IDENTITY_INVALID');const job=context(frame);if(job){await operation('unknown',job);active.delete(frame.job_id);incoming.delete(frame.job_id);}return;
  }
  if(!identity(frame))throw Error('WS_IDENTITY_INVALID');const job=context(frame);if(!job)throw Error('WS_JOB_NOT_ACTIVE');
  if(frame.type==='start'){
   const authorized=await operation('authorizeStart',job);job.start_authorized=authorized===true;
   send({v:1,type:'start-ack',job_id:job.id,claim_id:job.claim_id,authorized:job.start_authorized,authorized_at_ms:hooks.now?.()??Date.now()});
   if(!job.start_authorized){await operation('unknown',job);active.delete(job.id);incoming.delete(job.id);}return;
  }
  if(frame.type==='result-start'){
   const policy=hooks.toolPolicy?.(job.method)||{known:false,readonly:false,destructive:true};
   const mode=frame.execution_mode||'confirmed';
   if(!['immediate','readonly','confirmed'].includes(mode))throw Error('WS_EXECUTION_MODE_INVALID');
   if(mode==='readonly'&&(!policy.known||!policy.readonly))throw Error('WS_READONLY_POLICY_REJECTED');
   if(mode==='immediate'&&(!policy.known||job.restored))throw Error('WS_IMMEDIATE_POLICY_REJECTED');
   if(mode==='confirmed'&&!job.start_authorized&&!job.restored)throw Error('WS_START_NOT_AUTHORIZED');
   if(incoming.has(frame.job_id)||!Number.isSafeInteger(frame.total_bytes)||frame.total_bytes<1||frame.total_bytes>MAX_MESSAGE||!Number.isSafeInteger(frame.total_chunks)||frame.total_chunks<1||frame.total_chunks>48||!safeId(frame.sha256))throw Error('WS_RESULT_LIMIT');
   incoming.set(frame.job_id,{...frame,parts:[],bytes:0});return;
  }
  if(frame.type==='result-chunk'){
   const assembly=incoming.get(frame.job_id);if(!assembly||frame.sequence!==assembly.parts.length||frame.sequence>=assembly.total_chunks||typeof frame.data!=='string'||frame.data.length>Math.ceil(MAX_CHUNK/3)*4||!safeId(frame.sha256))throw Error('WS_CHUNK_SEQUENCE');
   const bytes=hooks.unb64(frame.data);if(bytes.length>MAX_CHUNK||hooks.b64(bytes)!==frame.data||await hooks.sha256(bytes)!==frame.sha256)throw Error('WS_CHUNK_INTEGRITY');
   assembly.bytes+=bytes.length;if(assembly.bytes>assembly.total_bytes||assembly.bytes>MAX_MESSAGE)throw Error('WS_RESULT_LIMIT');assembly.parts.push({sequence:frame.sequence,chunk_hash:frame.sha256,data_b64:frame.data,bytes});
   metrics.peak_result_bytes=Math.max(metrics.peak_result_bytes,[...incoming.values()].reduce((sum,item)=>sum+item.bytes,0));send({v:1,type:'chunk-ack',job_id:job.id,claim_id:job.claim_id,sequence:frame.sequence});return;
  }
  if(frame.type==='result-end'){
   const assembly=incoming.get(frame.job_id);if(!assembly||assembly.parts.length!==assembly.total_chunks||assembly.bytes!==assembly.total_bytes)throw Error('WS_RESULT_INCOMPLETE');
   const bytes=new Uint8Array(assembly.bytes);let at=0;for(const part of assembly.parts){bytes.set(part.bytes,at);at+=part.bytes.length;}
   if(await hooks.sha256(bytes)!==assembly.sha256)throw Error('WS_RESULT_INTEGRITY');
   let rpc;try{rpc=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error('WS_RESULT_NOT_JSONRPC');}
   if(rpc?.jsonrpc!=='2.0'||!('result'in rpc||'error'in rpc)||JSON.stringify([typeof rpc.id,rpc.id])!==job.rpc_id_json)throw Error('WS_RPC_ID_MISMATCH');
   const processing=frame.transport_timing?.mac?.processing_ms??frame.transport_timing?.processing_ms;
   const cycle=Number.isFinite(job.sent_mono_ms)?performance.now()-job.sent_mono_ms:null;
   const transit=Number.isFinite(processing)&&processing>=0&&cycle!==null?cycle-processing:null;
   const accepted=await operation('accept',job,assembly,{rpc,result_received_ms:receivedAt,cancelled:job.cancel_requested===true,transport_timing:{...frame.transport_timing,ws_cycle_ms:cycle,mac_processing_ms:processing,ws_transit_ms:transit}});
   if(accepted?.server_timing){accepted.server_timing.ws_cycle_ms=cycle;accepted.server_timing.mac_processing_ms=processing;accepted.server_timing.ws_transit_ms=transit;}
   send({v:1,type:'ack',job_id:job.id,claim_id:job.claim_id,accepted:accepted?.accepted===true,...accepted?.replayed?{replayed:true}:{},...accepted?.error?{error:accepted.error}:{},...accepted?.server_timing?{server_timing:accepted.server_timing}:{}});
   if(accepted?.accepted){metrics.accepted++;hotUntil=performance.now()+hotWindowMs;warmUntil=performance.now()+warmWindowMs;}
   active.delete(job.id);incoming.delete(job.id);return;
  }
  throw Error('WS_FRAME_TYPE_INVALID');
 }
 socket.addEventListener('message',event=>{
  if(closed)return;if(typeof event.data!=='string'||event.data.length>MAX_FRAME){metrics.transport_errors++;finish(1009);return;}
  // No unbounded promise queue, even when storage is slow.
  if((metrics.pending_messages||0)>=64){metrics.transport_errors++;finish(1009);return;}metrics.pending_messages=(metrics.pending_messages||0)+1;
  const receivedAt=hooks.now?.()??Date.now();pending=pending.then(async()=>{if(!closed)await handle(JSON.parse(event.data),receivedAt);}).catch(()=>{metrics.transport_errors++;finish(1008);}).finally(()=>{metrics.pending_messages--;});
 });
 socket.addEventListener('close',()=>finish());socket.addEventListener('error',()=>{metrics.transport_errors++;finish(1011);});
 async function loop(){
  send({v:1,type:'ready',max_jobs:maxJobs,template_version:templateVersion,runtime_configured:runtimeConfigured});
  while(!closed){try{
   const now=performance.now();if(now-started>=rotateMs)rotate();
   if(peerConfirmed&&now-lastPeer<10000&&now-lastHeartbeat>=10000){await operation('heartbeat');lastHeartbeat=now;}
   if(active.size){const cancellations=await operation('cancellations',[...active.values()]);for(const entry of cancellations||[]){const job=active.get(entry.id);if(job&&job.claim_id===entry.claim_id&&!job.cancel_requested){job.cancel_requested=true;metrics.cancellations++;send({v:1,type:'cancel',job_id:job.id,claim_id:job.claim_id});}}}
   if(activated&&!draining&&active.size<capacity){let claimed;claimPending++;try{let probe;const busy=active.size>0||performance.now()<hotUntil||performance.now()<warmUntil;
    if(busy&&hooks.claimWarm){claimed=await operation('claimWarm');probe=claimed;}
    else {probe=hooks.poll?await operation('poll'):null;if(!hooks.poll||probe?.job_id)claimed=await operation('claim');}
    if(probe?.warm_remaining_ms>0)warmUntil=performance.now()+probe.warm_remaining_ms;
    if(probe?.settings){({hotMs,warmMs,coldMs,hotWindowMs,warmWindowMs,rotateMs,maxOperations}=probe.settings);}
}finally{claimPending--;}if(claimed?.job){const job=claimed.job;if(active.has(job.id)||active.size>=maxJobs)throw Error('WS_DUPLICATE_CLAIM');active.set(job.id,job);metrics.claims++;metrics.peak_jobs=Math.max(metrics.peak_jobs,active.size);hotUntil=performance.now()+hotWindowMs;warmUntil=performance.now()+warmWindowMs;job.sent_mono_ms=performance.now();
    send({v:1,type:'task',job_id:job.id,claim_id:job.claim_id,request_hash:job.request_hash,request_bytes:job.request_bytes,request_chunks:job.request_chunks,expires_at:job.expires_at,cancel_requested:Boolean(job.cancel_requested),server_timing:job.claim_timing,delivery_attempt:1,replayed:false});
    for(const chunk of claimed.chunks){send({v:1,type:'task-chunk',job_id:job.id,claim_id:job.claim_id,sequence:chunk.sequence,sha256:chunk.chunk_hash,data:chunk.data_b64});}
    send({v:1,type:'task-end',job_id:job.id,claim_id:job.claim_id});
   }}
   if(now-lastCleanup>=10000){lastCleanup=now;const maintenance=Promise.resolve().then(()=>hooks.cleanup()).catch(()=>{metrics.cleanup_errors++;});hooks.waitUntil?.(maintenance);}
   if(draining&&handoffReady&&!active.size){finish();break;}if(draining&&performance.now()-rotationAt>=drainMs){finish(1012);break;}
   await pause(relayPollDelay({hotUntil,warmUntil,active:active.size>0,hotMs,warmMs,coldMs}));
  }catch{metrics.transport_errors++;finish(1011);}}
 }
 const completion=loop();return {completion,close:finish,metrics,active,rotate};
}
