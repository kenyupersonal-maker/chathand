const {createRelayWorker}=(()=>{
const {createRelaySession}=(()=>{
// The connection owns only bounded transport/context; durable job state stays in guarded storage callbacks.
const MAX_CHUNK=128*1024,MAX_MESSAGE=6*1024*1024,MAX_FRAME=192*1024;
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=128;
function relayPollDelay({hotUntil=0,warmUntil=0,active=false,hotMs=50,warmMs=100,coldMs=500},now=performance.now()){return active||now<hotUntil?hotMs:now<warmUntil?warmMs:coldMs;}
function createRelaySession(socket,hooks,{maxJobs=2,hotMs=50,warmMs=100,coldMs=500,hotWindowMs=30000,warmWindowMs=300000,rotateMs=75000,maxOperations=1392,drainMs=60000,peerTimeoutMs=20000,templateVersion="4.1.2",runtimeConfigured=true}={}){
 if(maxJobs!==2||![hotMs,warmMs,coldMs].every(n=>Number.isSafeInteger(n)&&n>=25&&n<=10000)||hotMs>warmMs||warmMs>coldMs)throw Error('WS_POLICY_INVALID');
 const active=new Map(),incoming=new Map(),metrics={db_operations:0,claims:0,accepted:0,replayed:0,cancellations:0,cleanup_errors:0,transport_errors:0,rotations:0,peak_jobs:0,peak_result_bytes:0};
 const connectionId=crypto.randomUUID();
 let closed=false,logged1011=false,draining=false,activated=false,supportsPreparation=false,handoffReady=false,handoffRequested=false,handoffAcknowledged=false,successorId,preparing=false,capacity=0,claimPending=0,hotUntil=0,warmUntil=0,lastHeartbeat=-Infinity,lastCleanup=performance.now(),started=performance.now(),pending=Promise.resolve(),rotationAt=0,lastPeer=started,peerConfirmed=false,sleeper=null;
 const errorTypes=new Map([[Error.prototype,'Error'],[TypeError.prototype,'TypeError'],[RangeError.prototype,'RangeError'],[ReferenceError.prototype,'ReferenceError'],[SyntaxError.prototype,'SyntaxError'],[URIError.prototype,'URIError'],[EvalError.prototype,'EvalError'],[typeof DOMException==='undefined'?null:DOMException.prototype,'DOMException']].filter(([prototype])=>prototype));
 const safeErrorCodes=new Set(['D1_ERROR','D1_EXEC_ERROR','D1_TYPE_ERROR','D1_COLUMN_NOTFOUND','D1_TRANSACTION_ERROR','SQLITE_BUSY','SQLITE_CONSTRAINT','SQLITE_ERROR','SQLITE_MISUSE','SQLITE_READONLY','SQLITE_FULL','SQLITE_CANTOPEN','SQLITE_CORRUPT','SQLITE_IOERR','SQLITE_NOTADB','SQLITE_SCHEMA','SQLITE_TOOBIG','SQLITE_RANGE','SQLITE_MISMATCH']);
 function safeFailure(error){let type='unknown',code=null;try{if(error&&typeof error==='object'){let prototype=Object.getPrototypeOf(error);for(let depth=0;prototype&&depth<16;depth++){if(errorTypes.has(prototype)){type=errorTypes.get(prototype);break;}prototype=Object.getPrototypeOf(prototype);}const descriptor=Object.getOwnPropertyDescriptor(error,'code');const value=descriptor&&'value'in descriptor?descriptor.value:null;if(Number.isSafeInteger(value)&&value>=0&&value<=65535)code=value;else if(typeof value==='string'&&safeErrorCodes.has(value))code=value;}}catch{}return {error_type:type,error_code:code};}
 function log1011(path,error){try{const fields=safeFailure(error);console.log(JSON.stringify({event:'ws_relay_1011',path,...fields}));}catch{}}
 if(!Number.isSafeInteger(peerTimeoutMs)||peerTimeoutMs<100||peerTimeoutMs>20000)throw Error('WS_PEER_TIMEOUT_INVALID');
 const peerTimer=setInterval(()=>{if(performance.now()-lastPeer>=peerTimeoutMs)finish(1012);},Math.min(500,peerTimeoutMs/4));
 // Frames can resume this one sleeping loop; they never start storage work themselves.
 function wake(){const waiting=sleeper;if(!waiting)return;sleeper=null;clearTimeout(waiting.timer);waiting.resolve();}
 function pause(ms){if(closed)return Promise.resolve();return new Promise(resolve=>{const waiting={resolve,timer:null};sleeper=waiting;waiting.timer=setTimeout(()=>{if(sleeper!==waiting)return;sleeper=null;resolve();},ms);});}
 function send(value){if(closed)return false;const text=JSON.stringify(value);if(text.length>MAX_FRAME)throw Error('WS_FRAME_LIMIT');socket.send(text);return true;}
 const budget=()=>({connection_id:connectionId,at_ms:hooks.now?.()??Date.now(),elapsed_ms:performance.now()-started,sql_operations:hooks.dbOperations?.()??metrics.db_operations,max_operations:maxOperations,rotate_ms:rotateMs});
 function lifecycle(phase,reason){if(supportsPreparation)send({v:1,type:'lifecycle',phase,reason,...budget()});}
 function finish(code=1000,failure=null){if(closed)return;if(code===1011&&failure&&!logged1011){logged1011=true;log1011(failure.path,failure.error);}try{lifecycle('close',draining?'handoff':'error');}catch{}clearInterval(peerTimer);try{hooks.onMetrics?.({...metrics,active_jobs:active.size,elapsed_ms:performance.now()-started,last_peer_age_ms:performance.now()-lastPeer,peer_confirmed:Number(peerConfirmed)});}catch{}closed=true;wake();try{socket.close(code,'relay-close');}catch{}}
 function rotate(reason='budget'){if(draining||closed)return;draining=true;rotationAt=performance.now();metrics.rotations++;lifecycle('budget_exhausted',reason);send({v:1,type:'rotate',reason,...budget()});}
 function checkpoint(){if(closed)return;const used=hooks.dbOperations?.()??metrics.db_operations,elapsed=performance.now()-started;
  if(used>=maxOperations){rotate('sql');return;}if(elapsed>=rotateMs){rotate('time');return;}
  if(supportsPreparation&&activated&&capacity>0&&!draining&&!preparing&&(used>=maxOperations*0.75||elapsed>=rotateMs*0.75)){preparing=true;const reason=used>=maxOperations*0.75?'sql':'time';lifecycle('prepare',reason);send({v:1,type:'prepare',reason,...budget()});}
 }
 async function operation(name,...args){metrics.db_operations++;const value=await hooks[name](...args);checkpoint();return value;}
 const identity=frame=>safeId(frame.job_id)&&safeId(frame.claim_id);
 function context(frame){const job=active.get(frame.job_id);return job&&job.claim_id===frame.claim_id?job:null;}
 async function handle(frame,receivedAt){
  if(frame?.v!==1||typeof frame.type!=='string')throw Error('WS_PROTOCOL_INVALID');
  lastPeer=performance.now();if(!peerConfirmed){peerConfirmed=true;lastHeartbeat=lastPeer;const beat=operation('heartbeat').catch(error=>finish(1011,{path:'heartbeat',error}));hooks.waitUntil?.(beat);}
  if(frame.type==='heartbeat'){send({v:1,type:'heartbeat-ack'});return;}
  if(frame.type==='ping'){if(!Number.isSafeInteger(frame.sequence)||frame.sequence<1||frame.sequence>100)throw Error('WS_PING_INVALID');send({v:1,type:'pong',sequence:frame.sequence,wall_start_ms:receivedAt,worker_reply_ms:hooks.now?.()??Date.now()});return;}
  if(frame.type==='activate'||frame.type==='capacity'){if(!Number.isSafeInteger(frame.capacity)||frame.capacity<0||frame.capacity>maxJobs)throw Error('WS_CAPACITY_INVALID');const firstActivate=frame.type==='activate'&&!activated,previousCapacity=capacity;capacity=frame.capacity;if(frame.type==='activate'){activated=true;supportsPreparation=frame.rotation_protocol==='prepare-v1';}if(firstActivate||(activated&&previousCapacity===0&&capacity>0))wake();return;}
  if(frame.type==='handoff'){if(frame.wait_for_switch===true&&(!supportsPreparation||!safeId(frame.successor_id)))throw Error('WS_HANDOFF_INVALID');successorId=frame.successor_id;handoffRequested=frame.wait_for_switch===true;handoffReady=frame.wait_for_switch!==true;if(!draining){draining=true;rotationAt=performance.now();metrics.rotations++;lifecycle('drain','handoff');}wake();return;}
  if(frame.type==='handoff-complete'){if(!handoffRequested||!handoffAcknowledged||frame.successor_id!==successorId)throw Error('WS_HANDOFF_INVALID');handoffReady=true;wake();return;}
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
 socket.addEventListener('close',()=>finish());socket.addEventListener('error',event=>{metrics.transport_errors++;let error;try{error=event?.error;}catch{}finish(1011,{path:'socket_error',error});});
 async function loop(){
  send({v:1,type:'ready',max_jobs:maxJobs,template_version:templateVersion,runtime_configured:runtimeConfigured,rotation_protocol:'prepare-v1',...budget()});
  while(!closed){try{
   const now=performance.now();checkpoint();
   if(peerConfirmed&&now-lastPeer<10000&&now-lastHeartbeat>=10000){await operation('heartbeat');lastHeartbeat=now;}
   if(active.size){const cancellations=await operation('cancellations',[...active.values()]);for(const entry of cancellations||[]){const job=active.get(entry.id);if(job&&job.claim_id===entry.claim_id&&!job.cancel_requested){job.cancel_requested=true;metrics.cancellations++;send({v:1,type:'cancel',job_id:job.id,claim_id:job.claim_id});}}}
   if(activated&&!draining&&active.size<capacity){let claimed;claimPending++;try{let probe;const busy=active.size>0||performance.now()<hotUntil||performance.now()<warmUntil;
    if(busy&&hooks.claimWarm){claimed=await operation('claimWarm');probe=claimed;}
    else {probe=hooks.poll?await operation('poll'):null;if(!draining&&(!hooks.poll||probe?.job_id))claimed=await operation('claim');}
    if(probe?.warm_remaining_ms>0)warmUntil=performance.now()+probe.warm_remaining_ms;
    if(probe?.settings){({hotMs,warmMs,coldMs,hotWindowMs,warmWindowMs,rotateMs,maxOperations}=probe.settings);}
}finally{claimPending--;}if(claimed?.job){const job=claimed.job;if(active.has(job.id)||active.size>=maxJobs)throw Error('WS_DUPLICATE_CLAIM');active.set(job.id,job);metrics.claims++;metrics.peak_jobs=Math.max(metrics.peak_jobs,active.size);hotUntil=performance.now()+hotWindowMs;warmUntil=performance.now()+warmWindowMs;job.sent_mono_ms=performance.now();
    send({v:1,type:'task',job_id:job.id,claim_id:job.claim_id,request_hash:job.request_hash,request_bytes:job.request_bytes,request_chunks:job.request_chunks,expires_at:job.expires_at,cancel_requested:Boolean(job.cancel_requested),server_timing:job.claim_timing,delivery_attempt:1,replayed:false});
    for(const chunk of claimed.chunks){send({v:1,type:'task-chunk',job_id:job.id,claim_id:job.claim_id,sequence:chunk.sequence,sha256:chunk.chunk_hash,data:chunk.data_b64});}
    send({v:1,type:'task-end',job_id:job.id,claim_id:job.claim_id});
   }}
   if(supportsPreparation&&handoffRequested&&!handoffAcknowledged&&!claimPending){handoffAcknowledged=true;send({v:1,type:'handoff-ack',successor_id:successorId,...budget()});}
   if(activated&&capacity>0&&now-lastCleanup>=10000){lastCleanup=now;const maintenance=Promise.resolve().then(()=>hooks.cleanup()).catch(()=>{metrics.cleanup_errors++;});hooks.waitUntil?.(maintenance);}
   if(draining&&handoffReady&&!active.size){finish();break;}if(draining&&performance.now()-rotationAt>=drainMs){finish(1012);break;}
   await pause(relayPollDelay({hotUntil,warmUntil,active:active.size>0,hotMs,warmMs,coldMs}));
  }catch(error){metrics.transport_errors++;finish(1011,{path:'main_loop',error});}}
 }
 const completion=loop();return {completion,close:finish,metrics,active,rotate,connectionId};
}

return {createRelaySession};
})();

const MAX_CHUNK = 128 * 1024;
const MAX_MESSAGE = 6 * 1024 * 1024;
const JOB_TTL = 60_000;
const RPC_WAIT = 55_000;
const POLL_WAIT = 15_000;
const ONLINE_WINDOW = 25_000;
const CONTENT_RETENTION = 60_000;
const TOMBSTONE_RETENTION = 8 * 60 * 60_000;
const VERSION = 'route-compare-20261003';
const PRODUCT_VERSION = 'chathand-relay-v4.1';
const TEMPLATE_VERSION='4.1.2';
const DEFAULT_SETTINGS={hotMs:50,warmMs:100,coldMs:500,hotWindowMs:30000,warmWindowMs:300000,rotateMs:75000,maxOperations:1392};
// Decimal bytes: D1 caps an entire string/BLOB/row at 2,000,000 bytes.
// Request admission and stored-row admission are deliberately independent.
const RUNTIME_REQUEST_LIMIT_BYTES=1900000;
const RUNTIME_ROW_LIMIT_BYTES=1800000;
const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const HOT_WINDOW_MAX = 30_000;
const ACTIVE_RESULT_POLL_MS = 50;
function hotPollDeadline(body, started = performance.now()) {
  const remaining = body?.hot_window_ms;
  return Number.isSafeInteger(remaining) && remaining > 0 ? started + Math.min(remaining, HOT_WINDOW_MAX) : 0;
}
function pollingSleep(hotUntil, now = performance.now()) { return hotUntil > now ? 100 : 500; }

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store' },
});
const rpcReply = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const utf8 = value => enc.encode(value);
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
function sessionFor(request) {
  const value = request.headers.get('mcp-session-id') ?? request.headers.get('x-mcp-session-id');
  return value === null ? { type: 'absent' } : { type: 'string', value };
}
const TIMING_VERSION = 'rc-timing-1';
const MAX_TIMING_HEADER = 8 * 1024;
const MAX_DB_SPANS = 16;
const MAX_DB_META = 8;
function accumulateDB(trace, entry) {
  const summary = trace.db_summary ||= { await_count: 0, await_ms: 0, sql_ms: 0, meta_count: 0, failed_count: 0, primary_count: 0, replica_count: 0, attempts: 0 };
  summary.await_count++; summary.await_ms += entry.await_ms; summary.failed_count += entry.failed ? 1 : 0;summary.sql_statement_count=(summary.sql_statement_count||0)+(entry.statement_count||1);
  for (const meta of entry.metadata || []) {
    summary.meta_count++; summary.sql_ms += meta.sql_ms || 0; summary.attempts += meta.attempts || 0;
    if (meta.primary === true) summary.primary_count++;
    if (meta.primary === false) summary.replica_count++;
    const region = ['WNAM','ENAM','WEUR','EEUR','APAC','OC'].indexOf(meta.region);
    if (region >= 0) { const key = `region_${region}`; summary[key] = (summary[key] || 0) + 1; }
  }
  if (trace.db.length < MAX_DB_SPANS) trace.db.push({ ...entry, metadata: (entry.metadata || []).slice(0, MAX_DB_META), ...((entry.metadata || []).length > MAX_DB_META ? { truncated: 1 } : {}) });
  else summary.truncated = 1;
  if ((entry.metadata || []).length > MAX_DB_META) summary.truncated = 1;
  summary.details_kept = trace.db.length;
}
function compactTiming(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return [];
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'db' || key === 'metadata') { result[key] = []; result.truncated = 1; }
    else result[key] = item && typeof item === 'object' ? compactTiming(item) : item;
  }
  return result;
}
function encodeTimingHeader(trace) {
  const { mono_start_ms, ...publicTrace } = trace;
  let payload = publicTrace, encoded = b64(utf8(JSON.stringify(payload)));
  if (encoded.length > MAX_TIMING_HEADER) { payload = compactTiming(publicTrace); payload.truncated = 1; encoded = b64(utf8(JSON.stringify(payload))); }
  if (encoded.length > MAX_TIMING_HEADER) {
    // Bounded generated core fields are always small; defensive final fallback avoids breaking RPCs.
    payload = { version: TIMING_VERSION, truncated: 1 };
    for (const key of ['wall_start_ms','worker_reply_ms','worker_elapsed_ms','enqueue_started_ms','enqueue_committed_ms','claim_confirmed_ms','result_accepted_ms','waiter_observed_done_ms','waiter_result_verified_ms']) if (Number.isFinite(publicTrace[key])) payload[key] = publicTrace[key];
    if (typeof publicTrace.job_id === 'string' && /^[0-9a-f]{64}$/.test(publicTrace.job_id)) payload.job_id = publicTrace.job_id;
    if (publicTrace.db_summary) payload.db_summary = numericTransport(publicTrace.db_summary, 1);
    encoded = b64(utf8(JSON.stringify(payload)));
  }
  return encoded.length <= MAX_TIMING_HEADER ? encoded : b64(utf8(JSON.stringify({ version: TIMING_VERSION, truncated: 1 })));
}
const timingPoint = trace => trace.wall_start_ms + (performance.now() - trace.mono_start_ms);
function timingMark(env, name) {
  if (env.__rcTiming) env.__rcTiming[name] = timingPoint(env.__rcTiming);
}
function db(env) {
  if (!env.DB || !/^[a-f0-9]{64}$/.test(env.__scopeKey||'')) throw new Error('B_SCOPE_REQUIRED');
  const rawDB=env.DB;const scopedDB={prepare:sql=>{if(typeof sql!=='string'||!sql.includes('__SCOPE__'))throw Error('B_UNSCOPED_QUERY');return rawDB.prepare(sql.replaceAll('__SCOPE__',env.__scopeKey));},batch:statements=>rawDB.batch(statements)};
  if (!env.__rcTiming) return scopedDB;
  if (env.__rcTimedDB) return env.__rcTimedDB;
  const trace = env.__rcTiming, raw = scopedDB;
  const record = async (method, perform, statementCount = 1) => {
    const started = performance.now();
    try {
      const value = await perform();
      const metas = method === 'batch' ? value.map(v => v?.meta).filter(Boolean) : value?.meta ? [value.meta] : [];
      accumulateDB(trace, { operation: method, statement_count:statementCount, await_ms: performance.now() - started,
        metadata: metas.map(m => ({
          ...(Number.isFinite(m.timings?.sql_duration_ms ?? m.duration) ? { sql_ms: m.timings?.sql_duration_ms ?? m.duration } : {}),
          ...(['WNAM','ENAM','WEUR','EEUR','APAC','OC'].includes(m.served_by_region) ? { region: m.served_by_region } : {}),
          ...(typeof m.served_by_primary === 'boolean' ? { primary: m.served_by_primary } : {}),
          ...(Number.isFinite(m.total_attempts) ? { attempts: m.total_attempts } : {}),
        })) });
      return value;
    } catch (error) { accumulateDB(trace, { operation: method, statement_count:statementCount, await_ms: performance.now() - started, failed: 1 }); throw error; }
  };
  const wrap = statement => ({
    __rcStatement: statement,
    bind(...values) { return wrap(statement.bind(...values)); },
    first(...args) { return record('first', () => statement.first(...args)); },
    all(...args) { return record('all', () => statement.all(...args)); },
    run(...args) { return record('run', () => statement.run(...args)); },
  });
  return env.__rcTimedDB = {
    prepare(sql) { return wrap(raw.prepare(sql)); },
    batch(statements) { return record('batch', () => raw.batch(statements.map(s => s.__rcStatement ?? s)), statements.length); },
  };
}
function timingHeader(response, trace) {
  trace.worker_reply_ms = timingPoint(trace);
  trace.worker_elapsed_ms = performance.now() - trace.mono_start_ms;
  const { mono_start_ms, ...publicTrace } = trace;
  // Only transport numbers, fixed version/operation/region labels and hashed job ids.
  response.headers.set('X-RC-Timing', encodeTimingHeader(trace));
  response.headers.set('Server-Timing', `rc-worker;dur=${trace.worker_elapsed_ms.toFixed(3)}, rc-db;dur=${(trace.db_summary?.await_ms || 0).toFixed(3)}`);
  return response;
}

const TIMING_KEYS = new Set([
  'wall_start_ms','worker_reply_ms','worker_elapsed_ms','claim_confirmed_ms',
  'mac_send_ms','mac_received_ms','elapsed_ms','offset_low_ms','offset_high_ms',
  'offset_mid_ms','offset_error_ms','network_residual_ms',
  'mac_received_poll_ms','mac_verified_ms','mac_execute_start_ms','mac_execute_end_ms',
  'ws_cycle_ms','ws_transit_ms','mac_processing_ms','processing_ms','ws_send_to_ack_ms','db_enqueue_ms','db_claim_ms','db_commit_ms','db_read_ms','db_consume_ms','mac_result_send_ms','local_elapsed_ms','poll_to_verify_ms','execute_ms','prepare_result_ms','start_authorization_ms',
  'result_received_ms','accept_write_started_ms','result_accepted_ms','accepted_exact',
  'await_ms','sql_ms','primary','attempts','op','region','failed','instrumentation_cpu_ms',
  'await_count','sql_statement_count','statement_count','meta_count','failed_count','primary_count','replica_count','details_kept','truncated','background_cleanup_errors',
  'region_0','region_1','region_2','region_3','region_4','region_5','timing_row_sql_ms','poll_sleep_ms','hot_window_ms','waiter_sleep_ms',
]);
const TIMING_GROUPS = new Set(['mac','poll','result','db','metadata','server','db_summary']);
function numericTransport(value, depth = 0, budget = { remaining: 256, truncated: false }, group = '') {
  if (!value || typeof value !== 'object' || depth > 7 || budget.remaining-- <= 0) { budget.truncated = true; return {}; }
  if (Array.isArray(value)) {
    const limit = group === 'metadata' ? MAX_DB_META : MAX_DB_SPANS;
    if (value.length > limit) budget.truncated = true;
    return value.slice(0, limit).map(item => numericTransport(item, depth + 1, budget, group));
  }
  const result = {};
  // Iterate the fixed allowlist rather than every untrusted property.
  for (const key of TIMING_KEYS) if (Object.hasOwn(value, key) && Number.isFinite(value[key])) result[key] = value[key];
  for (const key of TIMING_GROUPS) if (Object.hasOwn(value, key) && value[key] && typeof value[key] === 'object') result[key] = numericTransport(value[key], depth + 1, budget, key);
  if (depth === 0) {
    result.version = TIMING_VERSION;
    if (typeof value.job_id === 'string' && /^[0-9a-f]{64}$/.test(value.job_id)) result.job_id = value.job_id;
    if (budget.truncated) result.truncated = 1;
  }
  return result;
}

function numericDb(entries) {
  const operations = ['first','all','run','batch'];
  const regions = ['WNAM','ENAM','WEUR','EEUR','APAC','OC'];
  return entries.slice(0, MAX_DB_SPANS).map(entry => ({ op: operations.indexOf(entry.operation), await_ms: entry.await_ms,
    ...(entry.failed ? { failed: 1 } : {}), metadata: (entry.metadata || []).slice(0, MAX_DB_META).map(meta => ({
      ...(Number.isFinite(meta.sql_ms) ? { sql_ms: meta.sql_ms } : {}),
      ...(regions.includes(meta.region) ? { region: regions.indexOf(meta.region) } : {}),
      ...(typeof meta.primary === 'boolean' ? { primary: Number(meta.primary) } : {}),
      ...(Number.isFinite(meta.attempts) ? { attempts: meta.attempts } : {}),
    })) }));
}
async function timingStatement(env, jobId, transport) {
  const started = performance.now();
  let value = numericTransport({ ...transport, job_id: jobId });
  let bytes = utf8(JSON.stringify(value));
  if (bytes.byteLength > 12 * 1024) { value = compactTiming(value); value.truncated = 1; bytes = utf8(JSON.stringify(value)); }
  if (bytes.byteLength > 12 * 1024) { value = { version: TIMING_VERSION, job_id: jobId, truncated: 1 }; bytes = utf8(JSON.stringify(value)); }
  const statement = db(env).prepare(`INSERT INTO rc_chunks(scope_key,job_id,direction,sequence,chunk_hash,data_b64) SELECT '__SCOPE__',?,'timing',0,?,? WHERE EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))  ON CONFLICT(job_id,direction,sequence) DO UPDATE SET chunk_hash=excluded.chunk_hash,data_b64=excluded.data_b64 WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))`)
    .bind(jobId, await sha256(bytes), b64(bytes));
  if (env.__rcTiming) env.__rcTiming.instrumentation_cpu_ms += performance.now() - started;
  return statement;
}

async function readBody(request, maxBytes = MAX_MESSAGE) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new RangeError('BODY_TOO_LARGE');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new RangeError('BODY_TOO_LARGE'); }
    parts.push(value);
  }
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { result.set(part, at); at += part.byteLength; }
  return result;
}
function split(bytes) {
  const chunks = [];
  for (let at = 0; at < bytes.length; at += MAX_CHUNK) chunks.push(bytes.subarray(at, Math.min(at + MAX_CHUNK, bytes.length)));
  return chunks.length ? chunks : [new Uint8Array()];
}
async function clean(env, now = Date.now(), tail = []) {
  const d = db(env);
  // Same maintenance order, one D1 transaction/round trip.
  await d.batch([
    d.prepare(`UPDATE rc_jobs SET status='expired',completed_at=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND status='queued' AND expires_at<=?`).bind(now, now),
    d.prepare(`UPDATE rc_jobs SET status='unknown',completed_at=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND status='claimed' AND expires_at<=? AND (http_wait_until IS NULL OR http_wait_until<=?)`).bind(now, now, now),
    d.prepare(`DELETE FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND job_id IN (SELECT id FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE status IN ('done','cancelled','unknown','expired','not_executed_offline','not_executed_timeout') AND completed_at IS NOT NULL AND completed_at<=?)`).bind(now - CONTENT_RETENTION),
    d.prepare(`DELETE FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND tombstone_until<=?`).bind(now),
    ...tail,
  ]);
}

async function markDisconnected(env, id) {
  try { await db(env).prepare(`UPDATE rc_jobs SET status='unknown',completed_at=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND status IN ('queued','claimed')`).bind(Date.now(), id).run(); } catch {}
}
async function markUnknownOnAbort(request, env, id) {
  if (request.signal.aborted) await markDisconnected(env, id);
  else request.signal.addEventListener('abort', () => { void markDisconnected(env, id); }, { once: true });
}
async function insertJob(env, caller, session, rpc, bodyBytes, now) {
  timingMark(env, 'enqueue_started_ms');
  const requestHash = await sha256(bodyBytes), callerHash = await sha256(utf8(env.__scopeKey+':'+caller));
  const sessionHash = await sha256(utf8(JSON.stringify(session))), rpcId = JSON.stringify([typeof rpc.id, rpc.id]);
  const dedupeKey = await sha256(utf8(JSON.stringify([callerHash, rpcId, sessionHash, requestHash])));
  const id = await sha256(utf8(JSON.stringify([dedupeKey, requestHash]))), chunks = split(bodyBytes), d=db(env);
  const statements=[d.prepare(`INSERT INTO rc_jobs
    (scope_key,id,dedupe_key,caller_hash,rpc_id_json,session_hash,request_hash,method,request_bytes,request_chunks,created_at,expires_at,tombstone_until,http_wait_until,status)
    SELECT '__SCOPE__', ?,?,?,?,?,?,?,?,?,${DB_NOW},${DB_NOW}+?,${DB_NOW}+?,${DB_NOW}+15000,'queued'
    WHERE EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND EXISTS(SELECT 1 FROM (SELECT * FROM rc_devices WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_devices WHERE id='__SCOPE__' AND last_seen>${DB_NOW}-?)
    ON CONFLICT DO NOTHING`).bind(id,dedupeKey,callerHash,rpcId,sessionHash,requestHash,rpc.params?.name||rpc.method,bodyBytes.byteLength,chunks.length,JOB_TTL,TOMBSTONE_RETENTION,ONLINE_WINDOW)];
  for(let i=0;i<chunks.length;i++)statements.push(d.prepare(`INSERT INTO rc_chunks(scope_key,job_id,direction,sequence,chunk_hash,data_b64) SELECT '__SCOPE__', id,'request',?,?,? FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND request_hash=? AND status='queued' ON CONFLICT(job_id,direction,sequence) DO NOTHING`).bind(i,await sha256(chunks[i]),b64(chunks[i]),id,requestHash));
  statements.push(d.prepare(`UPDATE rc_jobs SET waiters=waiters+1 WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND consumed_at IS NULL AND status IN ('queued','claimed','done')`).bind(id));
  statements.push(d.prepare(`UPDATE rc_devices SET warm_until=${DB_NOW}+COALESCE((SELECT json_extract(settings_json,'$.warmWindowMs') FROM (SELECT * FROM rc_runtime WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_runtime WHERE id='__SCOPE__'),300000) WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id='__SCOPE__'`));
  statements.push(d.prepare(`SELECT *,${DB_NOW} AS db_now_ms FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE id=?`).bind(id));
  const inserted=await d.batch(statements),job=inserted.at(-1).results[0];
  timingMark(env,'enqueue_committed_ms');
  if(!job)return {offline:true};
  if(job.request_hash!==requestHash||job.dedupe_key!==dedupeKey)return {conflict:true};
  if(env.__rcTiming)env.__rcTiming.db_enqueue_ms=job.created_at;
  return {job,cached:job.status==='done',consumed:job.consumed_at!==null};
}
async function releaseResult(env,jobId){
 const d=db(env);const out=await d.batch([
  d.prepare(`UPDATE rc_jobs SET waiters=MAX(0,waiters-1),consumed_at=CASE WHEN waiters<=1 AND status='done' THEN ${DB_NOW} ELSE consumed_at END WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND consumed_at IS NULL RETURNING consumed_at`).bind(jobId),
  d.prepare(`DELETE FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND job_id=? AND EXISTS(SELECT 1 FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE id=? AND (consumed_at IS NOT NULL OR status IN ('cancelled','unknown','expired','not_executed_offline','not_executed_timeout')))`).bind(jobId,jobId)
 ]);if(env.__rcTiming)env.__rcTiming.db_consume_ms=out[0].results?.[0]?.consumed_at;
}

async function requestChunks(env, job) {
  return (await db(env).prepare(`SELECT sequence,chunk_hash,data_b64 FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=? AND direction='request' ORDER BY sequence`).bind(job.id).all()).results || [];
}
async function responseBytes(env, job, prefetched) {
  const stored = prefetched ?? ((await db(env).prepare(`SELECT direction,sequence,chunk_hash,data_b64 FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=? AND direction IN ('result','timing') ORDER BY direction,sequence`).bind(job.id).all()).results || []);
  const rows = stored.filter(row => row.direction === 'result');
  if (env.__rcTiming) {
    const transport = stored.find(row => row.direction === 'timing' && row.sequence === 0);
    if (transport) {
      try {
        const bytes = unb64(transport.data_b64);
        if (bytes.byteLength <= 32 * 1024 && await sha256(bytes) === transport.chunk_hash) {
          const data = JSON.parse(dec.decode(bytes));
          if (data.version === TIMING_VERSION && data.job_id === job.id) env.__rcTiming.transport = numericTransport(data);
        }
      } catch { /* Diagnostic metadata never changes business-result acceptance. */ }
    }
  }
  if (rows.length !== job.response_chunks || rows.some((r, i) => r.sequence !== i)) throw new Error('RESULT_CHUNKS_INCOMPLETE');
  const parts = [];
  let size = 0;
  for (const row of rows) {
    const bytes = unb64(row.data_b64);
    if (bytes.byteLength > MAX_CHUNK || await sha256(bytes) !== row.chunk_hash) throw new Error('RESULT_CHUNK_INVALID');
    parts.push(bytes); size += bytes.byteLength;
  }
  if (size !== job.response_bytes || size > MAX_MESSAGE) throw new Error('RESULT_SIZE_INVALID');
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { all.set(part, at); at += part.length; }
  if (await sha256(all) !== job.response_hash) throw new Error('RESULT_HASH_INVALID');
  return all;
}
async function readWaiterState(env, jobId) {
  const d = db(env);
  const [state, contents] = await d.batch([
    d.prepare(`SELECT j.*,dev.last_seen AS device_last_seen,CAST(unixepoch('subsec')*1000 AS INTEGER) AS db_read_ms FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS j LEFT JOIN (SELECT * FROM rc_devices WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS dev ON dev.id='__SCOPE__' WHERE j.id=?`).bind(jobId),
    d.prepare(`SELECT direction,sequence,chunk_hash,data_b64 FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=? AND direction IN ('result','timing') AND EXISTS(SELECT 1 FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE id=? AND status='done') ORDER BY direction,sequence`).bind(jobId, jobId),
  ]);
  const job = state.results[0];
  if (!job) return { kind: 'unknown' };
  if (job.status === 'done') {
    if(job.consumed_at!==null)return {kind:'consumed'};
    if(env.__rcTiming){env.__rcTiming.db_read_ms=job.db_read_ms;env.__rcTiming.db_claim_ms=job.claimed_at;env.__rcTiming.db_commit_ms=job.completed_at;}
    timingMark(env, 'waiter_observed_done_ms');
    const bytes = await responseBytes(env, job, contents.results || []);
    timingMark(env, 'waiter_result_verified_ms');
    return { kind: 'done', bytes };
  }
  if (job.status === 'not_executed_offline' || job.status === 'not_executed_timeout') return {kind:'not_executed',reason:job.status === 'not_executed_offline'?'QUEUED_DEVICE_OFFLINE':'QUEUED_WAIT_TIMEOUT'};
  if (['cancelled','unknown','expired'].includes(job.status)) return { kind: job.status };
  return { kind: 'active', job };
}
async function stopQueuedJob(env, jobId, reason) {
  const updated = await db(env).prepare(`UPDATE rc_jobs SET status=?,completed_at=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND status='queued'`).bind(reason === 'QUEUED_DEVICE_OFFLINE'?'not_executed_offline':'not_executed_timeout', Date.now(), jobId).run();
  // Only the real D1 mutation count proves this request was never claimed.
  return updated?.meta?.changes === 1;
}
async function waitForResult(request, env, jobId) {
  if (env.__rcTiming) env.__rcTiming.waiter_sleep_ms = ACTIVE_RESULT_POLL_MS;
  const until = Date.now() + RPC_WAIT;
  let waiterLeaseRefreshAt = Date.now() + 5_000;
  await markUnknownOnAbort(request, env, jobId);
  while (!request.signal.aborted && Date.now() < until) {
    const observed = await readWaiterState(env, jobId);
    if (observed.kind !== 'active') return observed;
    const { job } = observed;
    if (job.status === 'queued') {
      if (job.device_last_seen === null || Date.now() - job.device_last_seen > ONLINE_WINDOW) {
        if (await stopQueuedJob(env, jobId, 'QUEUED_DEVICE_OFFLINE')) return { kind: 'not_executed', reason: 'QUEUED_DEVICE_OFFLINE' };
        // A claim, result, cancellation or binding change may have won. The next
        // paced snapshot handles its actual state; zero changes proves none of them.
      }
    }
    if (Date.now() >= waiterLeaseRefreshAt) {
      const leaseNow = Date.now();
      await db(env).prepare(`UPDATE rc_jobs SET http_wait_until=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND status IN ('queued','claimed')`).bind(leaseNow + 15_000, jobId).run();
      waiterLeaseRefreshAt = leaseNow + 5_000;
    }
    const sleepMs = Math.min(ACTIVE_RESULT_POLL_MS, Math.max(0, until - Date.now()));
    if (sleepMs > 0) await new Promise(resolve => setTimeout(resolve, sleepMs));
  }
  if (request.signal.aborted) { await markDisconnected(env, jobId); return { kind: 'unknown' }; }
  if (await stopQueuedJob(env, jobId, 'QUEUED_WAIT_TIMEOUT')) return { kind: 'not_executed', reason: 'QUEUED_WAIT_TIMEOUT' };
  await db(env).prepare(`UPDATE rc_jobs SET status='unknown',completed_at=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND status='claimed'`).bind(Date.now(), jobId).run();
  // No more sleeps/retries beyond the 55s deadline. A result/cancellation that
  // beat either conditional fence still wins this final bounded snapshot.
  const finalState = await readWaiterState(env, jobId);
  return finalState.kind === 'active' ? { kind: 'unknown' } : finalState;
}
function toolErr(code, reason) {
  let details = {};
  if (code === 'MAC_OFFLINE') details = { message: '这台 Mac 现在不在线，打开 ChatHand 后再试' };
  if (code === 'MAC_OFFLINE' && reason === 'QUEUED_DEVICE_OFFLINE') details = {
    reason, status: 'not_executed', executed: false, unknown: false,
    message: '这台 Mac 刚断开，这一步没有执行，之后也不会执行；打开 ChatHand 后再试',
  };
  if (code === 'QUEUED_WAIT_TIMEOUT') details = {
    reason: 'QUEUED_WAIT_TIMEOUT', status: 'not_executed', executed: false, retryable: true,
    message: 'Mac 还连着，但这一步等了将近一分钟没被接手，没有执行，之后也不会执行。可以重试一次；还是这样，请用户看看 ChatHand 是不是卡住了，必要时退出重开。',
  };
  if (code === 'RESULT_UNKNOWN') details = {
    status: 'unknown', unknown: true, do_not_replay: true,
    message: '这一步可能已经执行了，只是结果没拿到；先用查看类工具看看现状，再决定要不要重做，不要直接重发',
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, ...details }) }], structuredContent: { code, ...details } };
}
function metadata(manifest) {
  if (!manifest?.initialize || !manifest?.serverDiscover || !manifest?.tools || !manifest?.resources || !manifest?.resourceContents) throw new TypeError('manifest must contain initialize, serverDiscover, tools, resources, resourceContents');
  return manifest;
}

function validateSettings(input={}) {
 const result={...DEFAULT_SETTINGS};
 const ranges={hotMs:[25,1000],warmMs:[25,2000],coldMs:[100,10000],hotWindowMs:[1000,300000],warmWindowMs:[1000,3600000],rotateMs:[1000,120000],maxOperations:[20,1392]};
 for(const [key,value] of Object.entries(input)){if(!ranges[key]||!Number.isSafeInteger(value)||value<ranges[key][0]||value>ranges[key][1])throw Error('RUNTIME_SETTINGS_INVALID');result[key]=value;}
 if(result.hotMs>result.warmMs||result.warmMs>result.coldMs||result.hotWindowMs>result.warmWindowMs)throw Error('RUNTIME_SETTINGS_INVALID');
 return result;
}
async function loadRuntime(env,bootstrap){
 const row=await db(env).prepare(`SELECT manifest_json,settings_json,revision FROM (SELECT * FROM rc_runtime WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_runtime WHERE id='__SCOPE__'`).first();
 if(!row)return {manifest:bootstrap,settings:{...DEFAULT_SETTINGS},configured:false,revision:null};
 return {manifest:metadata(JSON.parse(row.manifest_json)),settings:validateSettings(JSON.parse(row.settings_json)),configured:true,revision:row.revision};
}
async function registerRuntime(request,env){
 if(!env.__authenticatedDevice)return json({error:'B_DEVICE_UNVERIFIED'},401);
 if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 let body,requestBytes;try{const bytes=await readBody(request,RUNTIME_REQUEST_LIMIT_BYTES);requestBytes=bytes.length;body=JSON.parse(dec.decode(bytes));}catch(error){return error instanceof RangeError?json({error:'MANIFEST_TOO_LARGE',request_limit_bytes:RUNTIME_REQUEST_LIMIT_BYTES},413):json({error:'INVALID_JSON'},400);}
 let manifest,settings;try{manifest=metadata(body.manifest);settings=validateSettings(body.settings);const tools=manifest.tools.tools,resources=manifest.resources.resources;
 if(!Array.isArray(tools)||tools.length>500||!Array.isArray(resources)||resources.length>100||new Set(tools.map(t=>t.name)).size!==tools.length||tools.some(t=>typeof t.name!=='string'||!t.inputSchema||t.inputSchema.type!=='object'))throw Error('RUNTIME_MANIFEST_INVALID');
 }catch{return json({error:'RUNTIME_CONFIGURATION_INVALID'},400);}
 const serialized=JSON.stringify(manifest),configuration=JSON.stringify(settings),revision=await sha256(utf8(serialized+'\n'+configuration));
 const rowBudgetBytes=runtimeRowBudgetBytes({scopeKey:env.__scopeKey,serialized,configuration,revision});
 if(rowBudgetBytes>RUNTIME_ROW_LIMIT_BYTES)return json({error:'MANIFEST_STORAGE_TOO_LARGE',request_bytes:requestBytes,manifest_bytes:utf8(serialized).length,row_budget_bytes:rowBudgetBytes,row_limit_bytes:RUNTIME_ROW_LIMIT_BYTES},413);
 await db(env).prepare(`INSERT INTO rc_runtime(scope_key,id,manifest_json,settings_json,revision,updated_at) SELECT '__SCOPE__','__SCOPE__',?,?,?,${DB_NOW} WHERE EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))  ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json,settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))`).bind(serialized,configuration,revision).run();
 return json({accepted:true,template_version:TEMPLATE_VERSION,revision,tool_count:manifest.tools.tools.length,resource_count:manifest.resources.resources.length,request_bytes:requestBytes,manifest_bytes:utf8(serialized).length,row_budget_bytes:rowBudgetBytes,request_limit_bytes:RUNTIME_REQUEST_LIMIT_BYTES,row_limit_bytes:RUNTIME_ROW_LIMIT_BYTES,settings});
}
/** Budget every rc_runtime column: scope_key, id, manifest_json, settings_json,
 * revision, updated_at. Both scope/id store the same 64-byte scope. Eight bytes
 * cover INTEGER updated_at; 256 more cover SQLite record headers/varints/rowid
 * (well above the six-column maximum), independent of page packing. */
function runtimeRowBudgetBytes({scopeKey,serialized,configuration,revision}){
 if(!/^[a-f0-9]{64}$/.test(scopeKey||'')||!/^[a-f0-9]{64}$/.test(revision||'')||typeof serialized!=='string'||typeof configuration!=='string')throw Error('RUNTIME_ROW_BUDGET_INVALID');
 return utf8(scopeKey).length*2+utf8(serialized).length+utf8(configuration).length+utf8(revision).length+8+256;
}
function deferRelease(env,ctx,id){
 const work=Promise.resolve().then(()=>releaseResult(env,id)).catch(()=>{console.log(JSON.stringify({event:'result_cleanup_failed',at_ms:Date.now()}));});
 if(ctx?.waitUntil){ctx.waitUntil(work);return Promise.resolve();}return work;
}

function staticResult(manifest, method, params = {}) {
  if (method === 'ping') return {};
  if (method === 'initialize') {
    const original = manifest.initialize;
    const requested = params.protocolVersion;
    if(manifest.initializeByProtocol&&Object.hasOwn(manifest.initializeByProtocol,requested))return manifest.initializeByProtocol[requested];
    const supported = original.capabilities?.protocolVersions || [original.protocolVersion];
    if (requested && requested !== original.protocolVersion && !supported.includes(requested)) return original;
    if (requested && supported.includes(requested)) return { ...original, protocolVersion: requested };
    return original;
  }
  if (method === 'server/discover') return manifest.serverDiscover;
  if (method === 'tools/list') return manifest.tools;
  if (method === 'resources/list') return manifest.resources;
  if (method === 'resources/read') {
    const uri = params.uri;
    const result = manifest.resourceContents[uri];
    if(result===undefined)throw Object.assign(Error('Resource missing'),{code:'RESOURCE_MISSING'});
    return result;
  }
  return undefined;
}
function modernEnvelope(rpc, result, manifest) {
  if (rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') return result;
  return {
    ...result,
    resultType: 'complete',
    _meta: { ...(result?._meta||{}), 'io.modelcontextprotocol/serverInfo': manifest.initialize.serverInfo },
  };
}
function backgroundClean(env, ctx) {
  if (!ctx?.waitUntil) return clean(env);
  const work = Promise.resolve().then(() => clean(env)).catch(() => { if (env.__rcTiming) env.__rcTiming.background_cleanup_errors = (env.__rcTiming.background_cleanup_errors || 0) + 1; });
  ctx.waitUntil(work);
  return Promise.resolve();
}
async function mcp(request, env, manifest, verifiedCaller, ctx) {
  const caller = verifiedCaller;
  if (!caller) return json({ error: 'OWNER_AUTHENTICATION_REQUIRED' }, 401);
  let bytes;
  try { bytes = await readBody(request); }
  catch (e) { return json({ error: e.message === 'BODY_TOO_LARGE' ? 'MESSAGE_TOO_LARGE' : 'INVALID_BODY' }, e.message === 'BODY_TOO_LARGE' ? 413 : 400); }
  let rpc;
  try { rpc = JSON.parse(dec.decode(bytes)); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return json({ error: 'INVALID_JSONRPC' }, 400);
  console.log(JSON.stringify({event:'mcp_received',method:rpc.method.slice(0,80),at_ms:Date.now(),version:PRODUCT_VERSION}));
  if(['initialize','tools/list','resources/list','ping'].includes(rpc.method)) await db(env).prepare(`UPDATE rc_devices SET warm_until=${DB_NOW}+COALESCE((SELECT json_extract(settings_json,'$.warmWindowMs') FROM (SELECT * FROM rc_runtime WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_runtime WHERE id='__SCOPE__'),300000) WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id='__SCOPE__'`).run();
  if (rpc.method === 'notifications/cancelled') {
    const id = rpc.params?.requestId;
    if (id === undefined) return new Response(null, { status: 202 });
    const session = await sha256(utf8(JSON.stringify(sessionFor(request))));
    const callerHash = await sha256(utf8(env.__scopeKey+':'+caller));
    const rpcId = JSON.stringify([typeof id, id]);
    await db(env).prepare(`UPDATE rc_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,cancel_requested=CASE WHEN status='claimed' THEN 1 ELSE cancel_requested END,completed_at=CASE WHEN status='queued' THEN ? ELSE completed_at END WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=(SELECT id FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE caller_hash=? AND rpc_id_json=? AND session_hash=? AND status IN ('queued','claimed') ORDER BY created_at LIMIT 1)`).bind(Date.now(), callerHash, rpcId, session).run();
    return new Response(null, { status: 202 });
  }
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  const id = rpc.id;
  if (rpc.method === 'tools/call') {
    const bodyBytes = utf8(JSON.stringify(rpc));
    const created = await insertJob(env, caller, sessionFor(request), rpc, bodyBytes, Date.now());
    if(created.offline)return json(rpcReply(id,toolErr('MAC_OFFLINE')));
    if(created.consumed)return json(rpcReply(id,toolErr('RESULT_ALREADY_DELIVERED')));
    if (created.conflict) return json(rpcError(id, -32009, 'Request identity conflict'));
    try {
    if (created.cached) {
      try { const bytes=await responseBytes(env,created.job);return new Response(bytes,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
      catch { return json(rpcError(id, -32003, 'Cached result integrity check failed')); }
    }
    if (env.__rcTiming) env.__rcTiming.job_id = created.job.id;
    const state = await waitForResult(request, env, created.job.id);
    if (state.kind === 'done') return new Response(state.bytes, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    return json(rpcReply(id, toolErr(state.kind === 'not_executed' ? (state.reason === 'QUEUED_WAIT_TIMEOUT' ? 'QUEUED_WAIT_TIMEOUT' : 'MAC_OFFLINE') : state.kind === 'cancelled' ? 'CANCELLED' : state.kind==='consumed'?'RESULT_ALREADY_DELIVERED':'RESULT_UNKNOWN', state.reason)));
    } finally { await deferRelease(env,ctx,created.job.id); }
  }
  const runtime=await loadRuntime(env,manifest);
  if(!runtime.configured&&['initialize','server/discover','tools/list','resources/list','resources/read'].includes(rpc.method))return json(rpcError(id,-32004,'MAC_DIRECTORY_NOT_READY',{code:'MAC_DIRECTORY_NOT_READY',message:'这台 Mac 的工具目录尚未就绪，连接 ChatHand 后会自动同步。'}));
  let result;try{result = staticResult(runtime.manifest, rpc.method, rpc.params || {});}catch(e){if(e.code==='RESOURCE_MISSING')return json(rpcError(id,-32002,'Resource missing',{code:'RESOURCE_MISSING'}));throw e;}
  if (result !== undefined) return json(rpcReply(id, modernEnvelope(rpc, result, runtime.manifest)));
  return json(rpcError(id, -32601, 'Method not found'));
}

async function claimJob(local,d,trace){
      const stamp = Date.now(), claimId = crypto.randomUUID(), started = performance.now();
      const claimed = await d.prepare(`UPDATE rc_jobs SET status='claimed',claim_id=?,claimed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=(SELECT id FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE status='queued' AND cancel_requested=0 AND expires_at>? ORDER BY created_at LIMIT 1) AND status='queued' AND cancel_requested=0 AND expires_at>? RETURNING *, (SELECT data_b64 FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=rc_jobs.id AND direction='request' AND sequence=0 AND rc_jobs.request_chunks=1) AS inline_data, (SELECT chunk_hash FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=rc_jobs.id AND direction='request' AND sequence=0 AND rc_jobs.request_chunks=1) AS inline_hash`).bind(claimId, stamp, stamp).all();
      const job = claimed.results?.[0];
      if (!job) return null; trace.claim_confirmed_ms=timingPoint(trace);trace.db_claim_ms=job.claimed_at;
      const rows = job.request_chunks === 1 && typeof job.inline_data === 'string'
        ? [{sequence:0,chunk_hash:job.inline_hash,data_b64:job.inline_data}] : await requestChunks(local, job);
      if (rows.length !== job.request_chunks || rows.some((row,i) => row.sequence !== i)) throw Error('REQUEST_CHUNKS_INCOMPLETE');
      let size = 0; const parts = [];
      for (const row of rows) { const bytes = unb64(row.data_b64); size += bytes.length; if (bytes.length > MAX_CHUNK || await sha256(bytes) !== row.chunk_hash) throw Error('REQUEST_CHUNK_INVALID'); parts.push(bytes); }
      if (size !== job.request_bytes || size > MAX_MESSAGE) throw Error('REQUEST_SIZE_INVALID');
      const bytes = new Uint8Array(size); let at=0; for(const part of parts){bytes.set(part,at);at+=part.length;}
      if(await sha256(bytes)!==job.request_hash)throw Error('REQUEST_HASH_INVALID');
      // Payload chunks are transient; the retained context has no request payload.
      delete job.inline_data; delete job.inline_hash; job.cancel_requested=Boolean(job.cancel_requested);

      return {job,chunks:rows};

}
function createWsHooks(env, ctx) {
  const connection = { await_count:0,sql_statement_count:0,await_ms:0,sql_ms:0,meta_count:0,idle_await_count:0,idle_sql_statement_count:0,idle_await_ms:0,cleanup_errors:0 };
  const clockWall=Date.now(),clockMono=performance.now();
  const nowPoint = () => env.__rcTiming ? timingPoint(env.__rcTiming) : clockWall+performance.now()-clockMono;
  async function step(kind, run) {
    const trace={version:TIMING_VERSION,wall_start_ms:nowPoint(),mono_start_ms:performance.now(),instrumentation_cpu_ms:0,db:[]};
    const local={...env,__rcTiming:trace,__rcTimedDB:undefined};let result;
    try { result=await run(local,db(local),trace);return result; }
    finally {
      trace.worker_reply_ms=timingPoint(trace);trace.worker_elapsed_ms=performance.now()-trace.mono_start_ms;
      const summary=trace.db_summary||{};for(const key of ['await_count','sql_statement_count','await_ms','sql_ms','meta_count'])connection[key]+=summary[key]||0;
      if((kind==='claim'&&!result?.job)||(kind==='poll'&&!result?.job_id)||(kind==='claimWarm'&&!result?.job)){connection.idle_await_count+=summary.await_count||0;connection.idle_sql_statement_count+=summary.sql_statement_count||0;connection.idle_await_ms+=summary.await_ms||0;}
      const {mono_start_ms,...publicTrace}=trace;
      if((kind==='claim'||kind==='claimWarm')&&result?.job)result.job.claim_timing=publicTrace;
      if(kind==='accept'&&result?.accepted)result.server_timing=publicTrace;
    }
  }
  return {
    sha256, b64, unb64, now:nowPoint, connectionMetrics:()=>({...connection}),
    waitUntil: promise => ctx?.waitUntil?.(promise),
    dbOperations: () => Math.max(connection.await_count,connection.sql_statement_count),
    heartbeat: () => step('heartbeat', async (local,d) => { await d.prepare(`INSERT INTO rc_devices(scope_key,id,last_seen,generation) SELECT '__SCOPE__','__SCOPE__',CAST(unixepoch('subsec')*1000 AS INTEGER),'generic-rpc-v4' WHERE EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))  ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,generation=excluded.generation WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))`).run(); }),
    cleanup: () => step('cleanup', local=>clean(local)).catch(error=>{connection.cleanup_errors++;throw error;}),
    preheat:()=>step('preheat',async(local,d)=>d.prepare(`UPDATE rc_devices SET warm_until=${DB_NOW}+COALESCE((SELECT json_extract(settings_json,'$.warmWindowMs') FROM (SELECT * FROM rc_runtime WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_runtime WHERE id='__SCOPE__'),300000) WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id='__SCOPE__'`).run()),
    poll:()=>step('poll',async(local,d)=>{const result=(await d.prepare(`SELECT warm_until,MAX(0,warm_until-${DB_NOW}) AS warm_remaining_ms,(SELECT id FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE status='queued' AND cancel_requested=0 AND expires_at>${DB_NOW} ORDER BY created_at LIMIT 1) AS job_id,(SELECT settings_json FROM (SELECT * FROM rc_runtime WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_runtime WHERE id='__SCOPE__') AS settings_json FROM (SELECT * FROM rc_devices WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_devices WHERE id='__SCOPE__'`).first())||{warm_remaining_ms:0,job_id:null};if(result.settings_json)result.settings=validateSettings(JSON.parse(result.settings_json));return result;}),
    claim: () => step('claim',claimJob),
    claimWarm: () => step('claimWarm',async(local,d,trace)=>{
      const config=d.prepare(`SELECT warm_until,MAX(0,warm_until-${DB_NOW}) AS warm_remaining_ms,(SELECT settings_json FROM (SELECT * FROM rc_runtime WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_runtime WHERE id='__SCOPE__') AS settings_json FROM (SELECT * FROM rc_devices WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_devices WHERE id='__SCOPE__'`);
      let prefetched;
      // D1 bind returns a new statement; retain it for the atomic warm batch.
      const proxy={...d,prepare:sql=>{let q=d.prepare(sql);if(!sql.startsWith('UPDATE rc_jobs SET status=\'claimed\''))return q;return {bind(...args){q=q.bind(...args);return this;},async all(){const rows=await d.batch([q,config]);prefetched=rows[1].results?.[0];return rows[0];}};}};
      const result=await claimJob(local,proxy,trace);
      return {...result,warm_remaining_ms:prefetched?.warm_remaining_ms??0,settings:prefetched?.settings_json?validateSettings(JSON.parse(prefetched.settings_json)):undefined};
    }),
    cancellations: jobs => step('cancellations', async (local,d) => {
      if(!jobs.length)return [];
      return (await d.prepare(`SELECT id,claim_id FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE status='claimed' AND cancel_requested=1 AND id IN (${jobs.map(()=>'?').join(',')})`).bind(...jobs.map(job=>job.id)).all()).results || [];
    }),
    authorizeStart: job => step('start', async (local,d) => {
      const result=await d.prepare(`UPDATE rc_jobs SET claim_id=claim_id WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND claim_id=? AND request_hash=? AND rpc_id_json=? AND status='claimed' AND cancel_requested=0 AND expires_at>? RETURNING id`).bind(job.id,job.claim_id,job.request_hash,job.rpc_id_json,Date.now()).all();
      return result.results?.length===1;
    }),
    unknown: job => step('unknown', async (local,d) => { await d.prepare(`UPDATE rc_jobs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'unknown' END,completed_at=? WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND claim_id=? AND status='claimed'`).bind(Date.now(),job.id,job.claim_id).run(); }),
    restore: entry => step('restore', async (local,d) => {
      const job=await d.prepare(`SELECT id,rpc_id_json,claim_id,status,request_hash,request_bytes,request_chunks,expires_at,cancel_requested,response_hash,response_bytes,response_chunks FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE id=? AND claim_id=?`).bind(entry.job_id,entry.claim_id).first();
      if(!job||job.request_hash!==entry.request_hash)return null;
      if(job.status==='done')return {replayed:job.response_hash===entry.sha256&&job.response_bytes===entry.total_bytes&&job.response_chunks===entry.total_chunks};
      if(job.status!=='claimed'||job.expires_at<=Date.now()||job.request_hash!==entry.request_hash)return null;
      job.cancel_requested=Boolean(job.cancel_requested);job.restored=true;return {job};
    }),
    accept: (job, assembly, diagnostic) => step('accept', async (local,d,trace) => {
      const now=Date.now(), resultClock={result_received_ms:diagnostic.result_received_ms??nowPoint(),accept_write_started_ms:timingPoint(trace),accepted_exact:0};trace.result_received_ms=resultClock.result_received_ms;trace.accept_write_started_ms=resultClock.accept_write_started_ms;
      const rpc=diagnostic.rpc;
      const cancelledReply=rpc.error?.message==='REQUEST_CANCELLED';
      // A successful response can commit only while uncancelled; an abort reply only after persisted cancellation.
      const cancellationValue=cancelledReply?1:0;
      const statements=assembly.parts.map(part=>d.prepare(`INSERT INTO rc_chunks(scope_key,job_id,direction,sequence,chunk_hash,data_b64) SELECT '__SCOPE__', id,'result',?,?,? FROM (SELECT * FROM rc_jobs WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_jobs WHERE EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND claim_id=? AND status='claimed' AND expires_at>? AND cancel_requested=? ON CONFLICT(job_id,direction,sequence) DO NOTHING`).bind(part.sequence,part.chunk_hash,part.data_b64,job.id,job.claim_id,now,cancellationValue));
      if(assembly.parts.some((part,i)=>part.sequence!==i||!/^[0-9a-f]{64}$/.test(part.chunk_hash)))throw Error('RESULT_CHUNK_INVALID');
      // Literal sequence/hash come only from verified integers/SHA256; bound data stays below D1's 100-parameter limit even at 48 chunks.
      const mismatch=assembly.parts.map(part=>`(sequence=${part.sequence} AND (chunk_hash<>'${part.chunk_hash}' OR data_b64<>?))`).join(' OR ');
      const mismatchArgs=assembly.parts.map(part=>part.data_b64);
      const updateIndex=statements.length;
      statements.push(d.prepare(`UPDATE rc_jobs SET status='done',response_hash=?,response_bytes=?,response_chunks=?,completed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id=? AND claim_id=? AND request_hash=? AND rpc_id_json=? AND status='claimed' AND expires_at>? AND cancel_requested=? AND (SELECT COUNT(*) FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=? AND direction='result')=? AND NOT EXISTS(SELECT 1 FROM (SELECT * FROM rc_chunks WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL))) AS rc_chunks WHERE job_id=? AND direction='result' AND (${mismatch}))`).bind(assembly.sha256,assembly.total_bytes,assembly.total_chunks,job.id,job.claim_id,job.request_hash,job.rpc_id_json,now,cancellationValue,job.id,assembly.total_chunks,job.id,...mismatchArgs));
      const transport=numericTransport(diagnostic.transport_timing || {});transport.poll={server:job.claim_timing || {}};transport.result=resultClock;
      statements.push(await timingStatement(local,job.id,transport));
      const committed=await d.batch(statements),updated=committed[updateIndex];
      if(!updated.meta?.changes&&updated.changes!==1)return {accepted:false,error:'RESULT_GUARD_REJECTED'};
      trace.result_accepted_ms=timingPoint(trace);trace.accepted_exact=1;return {accepted:true};
    }),
  };
}
async function websocketRelay(request,env,ctx){
  if(!env.__authenticatedDevice)return json({error:'B_DEVICE_UNVERIFIED'},401);
  if(request.method!=='GET')return json({error:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return json({error:'WEBSOCKET_UPGRADE_REQUIRED'},426);
  if(typeof WebSocketPair!=='function')return json({error:'WEBSOCKET_RUNTIME_UNAVAILABLE'},501);
  const [client,server]=Object.values(new WebSocketPair());server.accept();
  const runtime=await loadRuntime(env,env.__manifest);
  const hooks=createWsHooks(env,ctx);hooks.toolPolicy=name=>{const t=runtime.manifest.tools.tools.find(t=>t.name===name);return {known:!!t,readonly:t?.annotations?.readOnlyHint===true,destructive:t?.annotations?.destructiveHint===true};};hooks.onMetrics=metrics=>{try{server.send(JSON.stringify({v:1,type:'metrics',metrics,db_connection:hooks.connectionMetrics()}));}catch{}};
  const session=createRelaySession(server,hooks,{...runtime.settings,templateVersion:TEMPLATE_VERSION,runtimeConfigured:runtime.configured});
  ctx?.waitUntil?.(session.completion);
  return new Response(null,{status:101,webSocket:client});
}
function createRelayWorker(inputManifest) {
  const manifest = metadata(inputManifest);
  return { async fetch(request, originalEnv, ctx) {
    const trace = { version: TIMING_VERSION, wall_start_ms: Date.now(), mono_start_ms: performance.now(), instrumentation_cpu_ms: 0, db: [] };
    const env = { ...originalEnv, __rcTiming: trace, __manifest:manifest };
    const dispatch = async () => {
    const url = new URL(request.url);
    try {
      if (['/relay/ok','/relay/d1-probe','/relay/do-probe','/relay/ws-probe','/relay/diagnostic-rpc'].includes(url.pathname)) return json({ error: 'NOT_FOUND' }, 404);
      if (url.pathname === '/relay/runtime') return registerRuntime(request,env);
      if (url.pathname === '/relay/ws') return websocketRelay(request, env, ctx);
      if (url.pathname === '/relay/disconnect') {await db(env).prepare(`UPDATE rc_devices SET last_seen=0 WHERE scope_key='__SCOPE__' AND EXISTS(SELECT 1 FROM rc_scopes s JOIN device_bindings b ON b.binding_id=s.binding_id AND b.generation=s.generation AND b.site_id=s.site_id AND b.owner_subject=s.owner_subject AND b.installation_id=s.installation_id AND b.revoked_at IS NULL WHERE s.scope_key='__SCOPE__' AND NOT EXISTS(SELECT 1 FROM device_bindings newer WHERE newer.site_id=b.site_id AND newer.owner_subject=b.owner_subject AND newer.installation_id=b.installation_id AND newer.generation>b.generation AND newer.revoked_at IS NULL)) AND id='__SCOPE__'`).run();return json({disconnected:true});}
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
        return await mcp(request, env, manifest, env.__verifiedCaller, ctx);
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch {
      return json({ error: 'RELAY_STORAGE_UNAVAILABLE' }, 503);
    }
    };
    const response=await dispatch();return response.status===101?response:timingHeader(response,trace);
  } };
}


return {createRelayWorker};
})();
const {prefersBootstrapHTML,bootstrapIdentityPresentation,bootstrapIdentityErrorPage}=(()=>{
/** Browser presentation only. The authenticated bootstrap JSON contract is unchanged. */
const BOOTSTRAP_PAGE_TEXT = Object.freeze({
 zh: {
  title:'Site 身份资料已准备',
  instructions:'复制身份资料，发回创建这个 Site 的 Work 对话，继续配置。',
  scope:'这一步只取得当前登录账号的身份。Site 还没配好，也还没连到这台 Mac。',
  copy:'复制身份资料',
  copied:'已复制。回到原来的 Work 对话粘贴发送。',
  copyFailed:'未能复制，请重试。',
  errorTitle:'未能取得 Site 身份资料',
  errorBody:'当前登录身份未通过检查。请回到原来的 Work 对话，提供下面的错误码。',
  disabled:'这个 Site 当前不需要这一步。请回到原来的 Work 对话继续。',
  invalidRequest:'身份请求不完整或已失效。请回到原来的 Work 对话重新打开链接。',
  parseTitle:'身份资料格式不正确',
  parseBody:'页面已打开，但返回的身份资料无法识别。请把错误码发回原来的 Work 对话。',
  code:'错误码',
  language:'语言',
  chinese:'中文',
  english:'English',
 },
 en: {
  title:'Site identity is ready',
  instructions:'Copy the identity details and send them in the Work chat that created this Site to continue setup.',
  scope:'This step only identifies the signed-in account. Site setup and the connection to this Mac are not complete yet.',
  copy:'Copy Identity Details',
  copied:'Copied. Paste and send in the original Work chat.',
  copyFailed:'Couldn’t copy. Try again.',
  errorTitle:'Couldn’t get the Site identity',
  errorBody:'The signed-in identity couldn’t be verified. Return to the original Work chat with the error code below.',
  disabled:'This Site doesn’t need this step now. Continue in the original Work chat.',
  invalidRequest:'The identity request is incomplete or no longer valid. Reopen the link from the original Work chat.',
  parseTitle:'Identity details couldn’t be read',
  parseBody:'The page opened, but the identity details have an unexpected format. Send the error code in the original Work chat.',
  code:'Error code',
  language:'Language',
  chinese:'中文',
  english:'English',
 },
});

const BOOTSTRAP_PRESENTATION_ERROR='B_BOOTSTRAP_PRESENTATION_INVALID';
const bootstrapEscape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bootstrapScriptJSON=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');

function prefersBootstrapHTML(request){
 const raw=request.headers.get('accept')||'';
 if(raw.length>4096)return false;
 const quality=type=>Math.max(0,...raw.split(',').map(part=>{
  const [media,...parameters]=part.trim().toLowerCase().split(';').map(s=>s.trim());
  if(media!==type)return 0;
  const q=parameters.find(s=>s.startsWith('q='));
  if(!q)return 1;
  return /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)?Number(q.slice(2)):0;
 }));
 const html=Math.max(quality('text/html'),quality('application/xhtml+xml'));
 return html>0&&html>=quality('application/json');
}

function bootstrapPageLocale(request){
 for(const item of (request.headers.get('accept-language')||'').split(',')){
  const [tag,...params]=item.trim().toLowerCase().split(';');
  if(params.some(p=>/^\s*q=0(?:\.0*)?\s*$/.test(p)))continue;
  if(/^en(?:-|$)/.test(tag))return 'en';
  if(/^zh(?:-|$)/.test(tag))return 'zh';
 }
 return 'zh';
}

function validBootstrapPresentation(payload,request){
 const fields=['schema','protocol_version','site_id','site_origin','source_revision','nonce','server_time_ms','owner_subject'].sort();
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(Object.keys(payload).sort())!==JSON.stringify(fields))return false;
 const url=new URL(request.url);
 return payload.schema===1&&payload.protocol_version==='1'&&
  typeof payload.site_id==='string'&&/^[A-Za-z0-9_-]{4,128}$/.test(payload.site_id)&&
  payload.site_origin===url.origin&&typeof payload.source_revision==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.source_revision)&&
  typeof payload.nonce==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)&&payload.nonce===url.searchParams.get('nonce')&&
  Number.isSafeInteger(payload.server_time_ms)&&payload.server_time_ms>0&&
  typeof payload.owner_subject==='string'&&payload.owner_subject.length>0&&payload.owner_subject.length<=160&&
  ![...payload.owner_subject].some(ch=>ch.codePointAt(0)<=32||ch.codePointAt(0)===127);
}

function bootstrapPage(request,{payload=null,errorCode=null,status=200}={}){
 const locale=bootstrapPageLocale(request),text=BOOTSTRAP_PAGE_TEXT[locale];
 const parseError=errorCode===BOOTSTRAP_PRESENTATION_ERROR;
 const title=errorCode?(parseError?text.parseTitle:text.errorTitle):text.title;
 const body=errorCode?(parseError?text.parseBody:errorCode==='B_BOOTSTRAP_DISABLED'?text.disabled:/B_BOOTSTRAP_(?:PARAMS|NONCE|METHOD)_INVALID/.test(errorCode)?text.invalidRequest:text.errorBody):text.instructions;
 const safeCode=typeof errorCode==='string'&&/^B_[A-Z0-9_]{1,79}$/.test(errorCode)?errorCode:'B_BOOTSTRAP_UNCONFIRMED';
 const script=`(()=>{const tables=${bootstrapScriptJSON(BOOTSTRAP_PAGE_TEXT)};const identity=${bootstrapScriptJSON(payload)};const errorCode=${bootstrapScriptJSON(errorCode?safeCode:null)};let language=${bootstrapScriptJSON(locale)};
 const title=document.getElementById('title'),body=document.getElementById('instructions'),scope=document.getElementById('scope'),copy=document.getElementById('copy'),status=document.getElementById('status'),codeLabel=document.getElementById('code-label');
 function paint(){const t=tables[language];document.documentElement.lang=language==='en'?'en':'zh-CN';document.title=errorCode?(errorCode==='${BOOTSTRAP_PRESENTATION_ERROR}'?t.parseTitle:t.errorTitle):t.title;title.textContent=document.title;body.textContent=errorCode?(errorCode==='${BOOTSTRAP_PRESENTATION_ERROR}'?t.parseBody:errorCode==='B_BOOTSTRAP_DISABLED'?t.disabled:/B_BOOTSTRAP_(?:PARAMS|NONCE|METHOD)_INVALID/.test(errorCode)?t.invalidRequest:t.errorBody):t.instructions;if(scope)scope.textContent=t.scope;if(copy)copy.textContent=t.copy;if(codeLabel)codeLabel.textContent=t.code;status.textContent='';}
 for(const button of document.querySelectorAll('[data-language]'))button.addEventListener('click',()=>{language=button.getAttribute('data-language')==='en'?'en':'zh';document.querySelector('nav').setAttribute('aria-label',tables[language].language);paint();});
 if(copy)copy.addEventListener('click',async()=>{copy.disabled=true;try{if(!identity)throw Error('unavailable');await navigator.clipboard.writeText(JSON.stringify(identity));status.textContent=tables[language].copied;}catch{status.textContent=tables[language].copyFailed;}finally{copy.disabled=false;}});
 })();`;
 const html='<!doctype html><html lang="'+(locale==='en'?'en':'zh-CN')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>'+bootstrapEscape(title)+'</title>'+
 '<style>:root{color-scheme:light dark;--bg:#f5f7f5;--card:#fff;--ink:#171a18;--muted:#647067;--line:#dde3df;--button:#171a18;--button-ink:#fff}@media(prefers-color-scheme:dark){:root{--bg:#161a18;--card:#202622;--ink:#edf1ed;--muted:#a6b2a9;--line:#3b463f;--button:#edf1ed;--button-ink:#171a18}}*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(100%,560px);padding:32px;background:var(--card);border:1px solid var(--line);border-radius:20px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{font-size:22px;line-height:1.4;margin:28px 0 12px;font-weight:600}p{margin:0 0 16px}small{color:var(--muted)}nav{display:flex;gap:12px}button{font:inherit;cursor:pointer}nav button{border:0;background:none;color:var(--muted);padding:4px}#copy{display:block;max-width:100%;border:0;border-radius:999px;padding:11px 20px;background:var(--button);color:var(--button-ink);margin-top:24px}button:focus-visible{outline:2px solid currentColor;outline-offset:4px}button:disabled{opacity:.6;cursor:default}#status{min-height:1.6em;color:var(--muted);font-size:13px;margin:12px 0 0}.code{overflow-wrap:anywhere;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:13px}#scope{font-size:13px;color:var(--muted)}</style></head><body><main><header><strong>ChatHand</strong><nav aria-label="'+bootstrapEscape(text.language)+'"><button type="button" data-language="zh">'+bootstrapEscape(text.chinese)+'</button><button type="button" data-language="en">'+bootstrapEscape(text.english)+'</button></nav></header><h1 id="title">'+bootstrapEscape(title)+'</h1><p id="instructions">'+bootstrapEscape(body)+'</p>'+
 (errorCode?'<p class="code"><span id="code-label">'+bootstrapEscape(text.code)+'</span>: <code>'+safeCode+'</code></p>':'<p id="scope">'+bootstrapEscape(text.scope)+'</p><button type="button" id="copy">'+bootstrapEscape(text.copy)+'</button>')+
 '<p id="status" role="status" aria-live="polite"></p></main><script>'+script+'</script></body></html>';
 return new Response(html,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','vary':'Accept, Accept-Language','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}

async function bootstrapIdentityPresentation(request,response){
 let payload;
 try{payload=await response.json();}catch{return bootstrapPage(request,{errorCode:BOOTSTRAP_PRESENTATION_ERROR,status:502});}
 if(!validBootstrapPresentation(payload,request))return bootstrapPage(request,{errorCode:BOOTSTRAP_PRESENTATION_ERROR,status:502});
 return bootstrapPage(request,{payload});
}

function bootstrapIdentityErrorPage(request,code,status=400){
 return bootstrapPage(request,{errorCode:typeof code==='string'&&/^B_BOOTSTRAP_[A-Z0-9_]{1,60}$/.test(code)?code:'B_BOOTSTRAP_UNCONFIRMED',status});
}

return {prefersBootstrapHTML,bootstrapIdentityPresentation,bootstrapIdentityErrorPage};
})();
/* ONE1052 Site B owner-private Worker (ESM, one deployable entry).
 * Source only. No Site identity, owner, credential or health is assumed.
 * Platform: Sites private managed Worker + D1 primary + Web Crypto Ed25519.
 * No runtime schema DDL, no external imports, no secret error/body logging.
 * The JCS serializer below is vendored from pinned json-canonicalize@1.2.0 MIT.
 */
const encoder=new TextEncoder(),decoder=new TextDecoder();
const PAIR_DOMAIN='chathand-site-pair-v1',JOB_DOMAIN='chathand-site-job-v1';
const PAIR_FIELDS=['protocol_version','site_id','site_origin','owner_subject','installation_id','device_public_key_id','pairing_id','client_nonce','server_nonce','issued_at','expires_at'];
const PAIR_FIELDS_V2=[...PAIR_FIELDS,'pairing_hash','template_version','manifest_sha256','site_public_key'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64=/^[A-Za-z0-9_-]+$/;
const SHA=/^[a-f0-9]{64}$/;
const TOOL=/^[a-z][a-z0-9_]{1,80}$/;
const now=()=>Date.now(),sec=()=>Math.floor(now()/1000);
class Rejected extends Error{constructor(code,status=403){super(code);this.code=code;this.status=status;}}
const reject=(code='B_REJECTED',status=403)=>{throw new Rejected(code,status)};
const fixedJSON=(x,status=200,extra={})=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',...extra}});
const errResponse=e=>fixedJSON({ok:false,error_code:e instanceof Rejected?e.code:'B_INTERNAL_UNCONFIRMED'},e instanceof Rejected?e.status:500);
const bytes=x=>x instanceof Uint8Array?x:encoder.encode(x);
// The result ciphertext can exceed one engine's safe spread-argument limit.
// Chunk binary conversion without changing canonical base64url for small keys.
const b64u=x=>{const data=bytes(x);let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');};
// Align persisted Mac result plaintext with the Worker AES-GCM plaintext budget.
const RESULT_PLAIN_LIMIT=65536, RESULT_GCM_TAG_BYTES=16, RESULT_CIPHER_MAX=RESULT_PLAIN_LIMIT+RESULT_GCM_TAG_BYTES;
function decodeCanonicalB64(x,size,maxChars,maxBytes){
 if(typeof x!=='string'||!B64.test(x)||x.length>maxChars)reject('B_ENCODING_INVALID',400);
 let decoded;try{decoded=Uint8Array.from(atob(x.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-x.length%4)%4)),c=>c.charCodeAt(0));}catch{reject('B_ENCODING_INVALID',400);}
 if(decoded.length>maxBytes||b64u(decoded)!==x||(size!==undefined&&decoded.length!==size))reject('B_ENCODING_INVALID',400);return decoded;
}
const dec64=(x,size)=>decodeCanonicalB64(x,size,4096,3072);
const dec64ResultCipher=x=>decodeCanonicalB64(x,undefined,4*Math.ceil(RESULT_CIPHER_MAX/3),RESULT_CIPHER_MAX);
async function digest(x){return b64hex(await crypto.subtle.digest('SHA-256',bytes(x)));}
function b64hex(raw){return Array.from(new Uint8Array(raw),n=>n.toString(16).padStart(2,'0')).join('');}
const rnd=n=>{const a=new Uint8Array(n);crypto.getRandomValues(a);return b64u(a)};
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&a===b; // only DB hashes and public IDs
function origin(value){if(typeof value!=='string'||!value.startsWith('https://'))reject('B_ORIGIN_INVALID',400);
 let u;try{u=new URL(value);}catch{reject('B_ORIGIN_INVALID',400)}
 if(u.origin!==value.replace(/\/$/,'')||u.username||u.password||u.pathname!=='/'||u.search||u.hash)reject('B_ORIGIN_INVALID',400);
 return u.origin;}
// Sites-managed sole-owner bootstrap only. The managed/private status is an
// external platform contract, not something this env flag can create.
// source_revision is the actual root-verified deployed source revision.
const SOURCE_REVISION=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SUBJECT_SAFE=value=>typeof value==='string'&&value.length>0&&value.length<=160&&
 ![...value].some(ch=>ch.codePointAt(0)<=32||ch.codePointAt(0)===127);
const BOOT_NONCE=/^[A-Za-z0-9_-]{16,128}$/;
function managedIdentityContext(request,env){
 if(env?.SITES_MANAGED_PRIVATE!=='true'||!env||typeof env.SITE_ID!=='string'||
  !/^[A-Za-z0-9_-]{4,128}$/.test(env.SITE_ID)||
  !SOURCE_REVISION.test(env.SITE_SOURCE_REVISION||''))return null;
 let site_origin;
 try{site_origin=origin(env.SITE_ORIGIN);}catch{return null;}
 if(site_origin!==env.SITE_ORIGIN)return null;
 let requestOrigin;
 try{requestOrigin=new URL(request.url).origin;}catch{return null;}
 const suppliedOrigin=request.headers.get('origin');
 if(requestOrigin!==site_origin||(suppliedOrigin!==null&&suppliedOrigin!==site_origin))return null;
 return {site_id:env.SITE_ID,site_origin,source_revision:env.SITE_SOURCE_REVISION};
}
function observedManagedSubject(request){
 const id=request.headers.get('oai-authenticated-user-id');
 return SUBJECT_SAFE(id)?id:null;
}
function config(env){const site_id=env.SITE_ID,site_origin=env.SITE_ORIGIN,owner=env.OWNER_SUBJECT_PIN;
 if(typeof site_id!=='string'||!/^[A-Za-z0-9_-]{4,128}$/.test(site_id)||typeof owner!=='string'||!owner||owner.length>160||!env.DB)return null;
 try{origin(site_origin);dec64(env.SITE_SIGNING_PUBLIC_KEY,32);dec64(env.SITE_SIGNING_PRIVATE_PKCS8);dec64(env.DEVICE_ISSUE_SECRET,32);dec64(env.SITE_RESULT_KEY,32);}
 catch{return null;}
 return {site_id,site_origin,owner};}
async function siteKey(env){return crypto.subtle.importKey('pkcs8',dec64(env.SITE_SIGNING_PRIVATE_PKCS8),{name:'Ed25519'},false,['sign']);}
async function signature(env,data){return b64u(new Uint8Array(await crypto.subtle.sign({name:'Ed25519'},await siteKey(env),bytes(data))));}
async function verify(raw,data,sig){try{const publicKey=await crypto.subtle.importKey('raw',dec64(raw,32),{name:'Ed25519'},false,['verify']);
 return crypto.subtle.verify({name:'Ed25519'},publicKey,dec64(sig,64),bytes(data));}catch{return false;}}
async function derivedCredential(env,binding,generation,owner){const key=await crypto.subtle.importKey('raw',dec64(env.DEVICE_ISSUE_SECRET,32),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return b64u(new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes(JSON.stringify(['chathand-site-device-credential-v1',owner,binding,String(generation)])))));}
async function encryptResult(env,value){const plain=encoder.encode(JSON.stringify(value)),iv=new Uint8Array(12);crypto.getRandomValues(iv);
 if(plain.length>RESULT_PLAIN_LIMIT)reject('B_RESULT_TOO_LARGE',413);
 const key=await crypto.subtle.importKey('raw',dec64(env.SITE_RESULT_KEY,32),'AES-GCM',false,['encrypt']);
 const boxed=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);return b64u(iv)+'.'+b64u(new Uint8Array(boxed));}
async function decryptResult(env,boxed){
 try{
  if(typeof boxed!=='string'||boxed.split('.').length!==2)reject('B_RESULT_UNAVAILABLE',409);
  const [i,v]=boxed.split('.');const key=await crypto.subtle.importKey('raw',dec64(env.SITE_RESULT_KEY,32),'AES-GCM',false,['decrypt']);
  const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:dec64(i,12)},key,dec64ResultCipher(v));
  if(data.byteLength>RESULT_PLAIN_LIMIT)reject('B_RESULT_UNAVAILABLE',409);
  // Authenticated ciphertext must still contain strict UTF-8 JSON, not replacement characters.
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
 }catch{reject('B_RESULT_UNAVAILABLE',409);}
}
function plainPair(claim){
 if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).length!==PAIR_FIELDS.length||
  PAIR_FIELDS.some(k=>typeof claim[k]!=='string')||Object.keys(claim).some(k=>!PAIR_FIELDS.includes(k)))reject('B_PAIR_INVALID',400);
 return encoder.encode(JSON.stringify([PAIR_DOMAIN,...PAIR_FIELDS.map(k=>claim[k])]));
}
function plainPairV2(claim){
 if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).length!==PAIR_FIELDS_V2.length||
  PAIR_FIELDS_V2.some(k=>typeof claim[k]!=='string')||Object.keys(claim).some(k=>!PAIR_FIELDS_V2.includes(k)))reject('B_PAIR_INVALID',400);
 return encoder.encode(JSON.stringify(['chathand-site-pair-v2',...PAIR_FIELDS_V2.map(k=>claim[k])]));
}
const precreateDigest=(installation,intent,secret)=>digest(JSON.stringify(['chathand-site-precreate-v1',installation,intent,secret]));
const completeProofV2=(claimHash,installation,intent,secret)=>JSON.stringify(['chathand-site-complete-v2',claimHash,installation,intent,secret]);
function v2Config(env){
 const c=config(env);
 if(!c||!SHA.test(env.PAIRING_HASH||'')||!SHA.test(env.MANIFEST_SHA256||'')||
  typeof env.TEMPLATE_VERSION!=='string'||!/^[a-zA-Z0-9._-]{1,80}$/.test(env.TEMPLATE_VERSION))reject('B_TEMPLATE_UNVERIFIED',503);
 return c;
}
const changes=r=>r?.meta?.changes??-1;
const prepared=(db,sql,...args)=>db.prepare(sql).bind(...args);
async function atomic(db,statements,expected){
 const res=await db.batch(statements);
 if(!Array.isArray(res)||res.length!==expected.length)reject('B_D1_BATCH_UNCONFIRMED',500);
 const observed=res.map(changes);
 if(!observed.every((n,i)=>n===expected[i]))reject('B_D1_BATCH_INCONSISTENT',409);
 return res;
}
async function bodyJSON(request,{max=65536,allowArray=false,allowPrimitive=false}={}){
 const length=Number(request.headers.get('content-length')||0);
 if(length>max)reject('B_BODY_TOO_LARGE',413);
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')reject('B_CONTENT_TYPE',415);
 const reader=request.body?.getReader();if(!reader)reject('B_BODY_EMPTY',400);
 const parts=[];let total=0;
 while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){reader.cancel().catch(()=>{});reject('B_BODY_TOO_LARGE',413);}parts.push(value);}
 const merged=new Uint8Array(total);let at=0;for(const item of parts){merged.set(item,at);at+=item.length;}
 let parsed;try{parsed=JSON.parse(decoder.decode(merged));}catch{reject('B_JSON_INVALID',400)}
 if(!allowPrimitive&&(parsed===null||typeof parsed!=='object')||Array.isArray(parsed)&&!allowArray)reject('B_JSON_INVALID',400);
 return parsed;
}
const noExtra=(o,fields)=>{if(Object.keys(o).some(x=>!fields.includes(x)))reject('B_FIELDS_INVALID',400)};
const trustedOwner=(request,env,{mcp=false}={})=>{
 // A managed private Site / provider-injected request identity is prerequisite.
 // Never obtain principal from RPC/body/query or a direct unprotected origin.
 const c=config(env);if(!c||env.SITES_MANAGED_PRIVATE!=='true')return null;
 if(mcp&&!managedIdentityContext(request,env))return null;
 if(new URL(request.url).origin!==c.site_origin)return null;
 const id=request.headers.get('oai-authenticated-user-id');
 return id&&id===c.owner?c.owner:null;
};
async function recordMcpOwnerObservation(request,env,owner){
 const c=managedIdentityContext(request,env);if(!c||owner!==config(env)?.owner||observedManagedSubject(request)!==owner)reject('B_OWNER_MAPPING_UNVERIFIED',403);
 try{
  const read=()=>prepared(env.DB,'SELECT first_seen_ms,basis FROM mcp_owner_observations WHERE site_id=? AND owner_subject=? AND source_revision=?',c.site_id,owner,c.source_revision).first();
  let row=await read();if(row){if(row.basis!=='sites_dispatch_request_identity')reject('B_D1_WRITE_UNCONFIRMED',500);return;}
  await prepared(env.DB,"INSERT OR IGNORE INTO mcp_owner_observations(site_id,owner_subject,source_revision,first_seen_ms,basis) VALUES(?,?,?,?,'sites_dispatch_request_identity')",c.site_id,owner,c.source_revision,now()).run();
  row=await read();if(!row||row.basis!=='sites_dispatch_request_identity'||!Number.isSafeInteger(row.first_seen_ms))reject('B_D1_WRITE_UNCONFIRMED',500);
 }catch{reject('B_D1_WRITE_UNCONFIRMED',500);}
}
/** Bootstrap returns Site-scoped provider identity only to an authenticated
 * sole-owner private Site visitor, before D1/pin/signing secrets exist.
 * Root consumes this through a controlled, non-displaying browser→env action.
 * The nonce is a response correlation value, never a login credential.
 */
function bootstrapIdentity(request,env){
 if(env?.OWNER_BOOTSTRAP_ENABLED!=='true'||env.OWNER_SUBJECT_PIN!=null&&env.OWNER_SUBJECT_PIN!=='')
  reject('B_BOOTSTRAP_DISABLED',404);
 const c=managedIdentityContext(request,env);
 if(!c)reject('B_BOOTSTRAP_CONTEXT_UNVERIFIED',403);
 const u=new URL(request.url),keys=[...u.searchParams.keys()];
 if(keys.length!==1||keys[0]!=='nonce')reject('B_BOOTSTRAP_PARAMS_INVALID',400);
 const nonce=u.searchParams.get('nonce');
 if(!BOOT_NONCE.test(nonce||''))reject('B_BOOTSTRAP_NONCE_INVALID',400);
 const subject=observedManagedSubject(request);
 if(!subject)reject('B_BOOTSTRAP_IDENTITY_MISSING',403);
 return fixedJSON({schema:1,protocol_version:'1',site_id:c.site_id,
  site_origin:c.site_origin,source_revision:c.source_revision,
  nonce,server_time_ms:now(),owner_subject:subject});
}
function readOnlyMcpIdentity(request,env,args){
 if(!args||typeof args!=='object'||Array.isArray(args))reject('B_IDENTITY_ARGUMENTS_INVALID',400);
 const keys=Object.keys(args).sort();
 if(keys.join(',')!=='nonce,protocol_version'||args.protocol_version!=='1'||
  !BOOT_NONCE.test(args.nonce||''))reject('B_IDENTITY_ARGUMENTS_INVALID',400);
 const c=managedIdentityContext(request,env),pin=env?.OWNER_SUBJECT_PIN;
 const subject=c?observedManagedSubject(request):null;
 const pinned=c&&SUBJECT_SAFE(pin),owner_match=Boolean(pinned&&subject&&subject===pin);
 const mapping_flag=env?.SITES_MCP_OWNER_MAPPING_VERIFIED==='true';
 return {schema:1,protocol_version:'1',site_id:c?.site_id??null,
  site_origin:c?.site_origin??null,source_revision:c?.source_revision??null,
  nonce:args.nonce,server_time_ms:now(),identity_present:Boolean(subject),owner_match,
  private_owner_context_matched:owner_match,
  available:owner_match&&mapping_flag,mapping_flag,
  reason:!c?'B_CONTEXT_UNVERIFIED':!pinned?'B_OWNER_PIN_MISSING':
   !subject?'B_IDENTITY_MISSING':!owner_match?'B_OWNER_MISMATCH':
   mapping_flag?'B_OWNER_MATCH':'B_OWNER_MATCH_READ_ONLY'};
}
const requireOwner=(request,env,options={})=>{const owner=trustedOwner(request,env,options);if(!owner)reject('B_OWNER_UNVERIFIED',403);return owner;};
function csrfCookie(request){const m=/\bch_b_csrf=([A-Za-z0-9_-]{32,128})\b/.exec(request.headers.get('cookie')||'');return m?.[1]||null;}
const checkOwnerWrite=(request,env)=>{const owner=requireOwner(request,env);const value=request.headers.get('x-chathand-csrf');
 if(!value||value!==csrfCookie(request)||request.headers.get('origin')!==env.SITE_ORIGIN)reject('B_OWNER_GESTURE_REQUIRED',403);
 return owner;};
function configured(env){return Boolean(config(env));}
const publicInfo=async env=>{const c=config(env);if(!c)return {configured:false,site_id:null,public_key:null,credential_ready:false,hosting:'not_configured'};
 return {configured:true,site_id:c.site_id,site_origin:c.site_origin,site_public_key:env.SITE_SIGNING_PUBLIC_KEY,hosting:'private_worker',credential_ready:true,...(bindingProtocol(env)?{binding_protocol:'3'}:{})};};
function ownerPage(c,csrf){
 // The one-time grant is kept only in JavaScript closure memory, copied on click.
 // No input value, DOM text, URL or console receives it.
 const client=`(()=>{let pending=null;const button=document.getElementById("create");
 const copy=document.getElementById("copy");const status=document.getElementById("status");
 button.onclick=async()=>{button.disabled=true;pending=null;try{
 const r=await fetch("/owner/grant",{method:"POST",headers:{"content-type":"application/json","x-chathand-csrf":${JSON.stringify(csrf)}},body:"{}"});
 if(!r.ok)throw Error("rejected");const item=await r.json();
 if(!item||!item.enrollment_grant)throw Error("missing");
 pending=JSON.stringify(item);copy.disabled=false;status.textContent="一次性配对资料已准备。由本人点击复制。";
 }catch{status.textContent="未生成配对资料，请检查站点配置。";copy.disabled=true;}finally{button.disabled=false}};
 copy.onclick=async()=>{if(!pending)return;try{await navigator.clipboard.writeText(pending);status.textContent="已复制。请回到 Mac 的 ChatHand 按 ⌘V。";}catch{status.textContent="复制失败。请在受信任的浏览器重试。"}};
 })();`;
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<meta name="referrer" content="no-referrer"><title>ChatHand Site B</title>'+
 '<style>body{font:16px/1.55 -apple-system,sans-serif;color:#171A18;margin:0;display:grid;min-height:100vh;place-items:center;background:#F5F7F5}main{background:white;border-radius:18px;padding:32px;max-width:500px}button{font:inherit;padding:12px;border-radius:10px;margin:10px 12px 0 0}small{color:#647067}</style>'+
 '<main><h1>ChatHand · 私有连接站点</h1><p>站点仅为当前已授权拥有者签发一次性设备配对资料。Mac 尚未配对不会自动连接。</p><small>Site: '+c.site_id+'</small>'+
 '<p><button id="create">生成一次性配对资料</button><button id="copy" disabled>复制到剪贴板</button></p><p id="status" role="status">由本人点击生成。</p></main>'+
 '<script>'+client+'</script></html>';
}
async function ownerHome(request,env){
 const c=config(env);if(!c||env.SITES_MANAGED_PRIVATE!=='true')return fixedJSON({configured:false,reason:'B_PRIVATE_SITE_UNCONFIGURED'},503);
 requireOwner(request,env);
 const csrf=rnd(32);return new Response(ownerPage(c,csrf),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'set-cookie':'ch_b_csrf='+csrf+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900'}});
}
async function ownerGrant(request,env){
 const owner=checkOwnerWrite(request,env);await bodyJSON(request,{max:128});
 const c=config(env),grant_id=crypto.randomUUID(),grant=rnd(48),at=sec();
 const hash=await digest(dec64(grant));
 const ownerWrites=await env.DB.batch([
  prepared(env.DB,'INSERT OR IGNORE INTO owner_registry(owner_subject,created_at) VALUES(?,?)',owner,at),
  prepared(env.DB,'INSERT INTO owner_grants(grant_id,grant_hash,site_id,owner_subject,expires_at) VALUES(?,?,?,?,?)',grant_id,hash,c.site_id,owner,at+300)
 ]);
 if(ownerWrites.length!==2||changes(ownerWrites[1])!==1)reject('B_D1_WRITE_UNCONFIRMED',500);
 return fixedJSON({site_id:c.site_id,site_origin:c.site_origin,enrollment_grant:grant,expires_at:at+300});
}
// Explicit protocol 3. The legacy V2 precreate secret is never reinterpreted as
// owner replacement consent. All replacement grants bind the exact active set.
const PAIR_FIELDS_V3=[...PAIR_FIELDS_V2,'device_name','binding_mode','expected_bindings'];
const bindingProtocol=env=>env.TEMPLATE_VERSION==='1069-site-b-v6';
const cleanDeviceName=value=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,80):'';
function plainPairV3(c){
 if(!c||Object.keys(c).length!==PAIR_FIELDS_V3.length||PAIR_FIELDS_V3.some(k=>typeof c[k]!=='string'))reject('B_PAIR_INVALID',400);
 return JSON.stringify(['chathand-site-pair-v3',...PAIR_FIELDS_V3.map(k=>c[k])]);
}
async function activeBindings(env){const c=config(env);return (await prepared(env.DB,'SELECT binding_id,generation,installation_id,device_name,last_used FROM device_bindings WHERE site_id=? AND owner_subject=? AND revoked_at IS NULL ORDER BY binding_id',c.site_id,c.owner).all()).results||[];}
const activeSet=rows=>JSON.stringify(rows.map(({binding_id,generation})=>({binding_id,generation})));
async function ownerRebind(request,env){
 const owner=checkOwnerWrite(request,env),c=v2Config(env);if(!bindingProtocol(env))reject('B_REBIND_UNSUPPORTED',409);
 const b=await bodyJSON(request,{max:8192});noExtra(b,['installation_id','pairing_hash','expected_bindings']);
 if(!UUID.test(b.installation_id)||!SHA.test(b.pairing_hash)||typeof b.expected_bindings!=='string')reject('B_REBIND_INPUT',400);
 const rows=await activeBindings(env);if(rows.length>16||activeSet(rows)!==b.expected_bindings)reject('B_BINDING_CHANGED',409);
 const grant=rnd(48),expires_at=sec()+300;
 await prepared(env.DB,'INSERT INTO b_rebind_grants(grant_hash,site_id,owner_subject,installation_id,pairing_hash,expected_bindings,expires_at) VALUES(?,?,?,?,?,?,?)',await digest(dec64(grant)),c.site_id,owner,b.installation_id,b.pairing_hash,b.expected_bindings,expires_at).run();
 return fixedJSON({replacement_grant:grant,expires_at});
}
async function pairBeginV3(b,env){
 const c=v2Config(env);if(!bindingProtocol(env))reject('B_REBIND_UNSUPPORTED',409);
 noExtra(b,['protocol_version','site_id','site_origin','installation_id','public_key','public_key_id','client_nonce','pairing_hash','device_name','replacement_grant','continuity']);
 if(b.site_id!==c.site_id||origin(b.site_origin)!==c.site_origin||!UUID.test(b.installation_id)||!SHA.test(b.pairing_hash))reject('B_PAIR_INPUT',400);
 const pub=dec64(b.public_key,32),pubid=b64u(new Uint8Array(await crypto.subtle.digest('SHA-256',pub)));
 if(pubid!==b.public_key_id)reject('B_PAIR_PUBLIC_KEY',400);dec64(b.client_nonce,32);
 const rows=await activeBindings(env);if(rows.length>16)reject('B_BINDING_REPAIR_REQUIRED',409);
 const expected=activeSet(rows);let mode='initial',replacementHash=null;
 if(b.replacement_grant){
  replacementHash=await digest(dec64(b.replacement_grant));
  const g=await prepared(env.DB,'SELECT * FROM b_rebind_grants WHERE grant_hash=? AND site_id=? AND owner_subject=? AND expires_at>=?',replacementHash,c.site_id,c.owner,sec()).first();
  if(!g||g.installation_id!==b.installation_id||g.pairing_hash!==b.pairing_hash)reject('B_REBIND_GRANT_INVALID',403);
  if(g.used_at!==null){
   const prior=await prepared(env.DB,'SELECT claim_json FROM pairing_grants WHERE pairing_id=?',g.consume_claim).first();
   const claim=prior?JSON.parse(prior.claim_json):null;
   if(!claim||claim.client_nonce!==b.client_nonce||claim.device_public_key_id!==pubid||claim.device_name!==cleanDeviceName(b.device_name))reject('B_REBIND_GRANT_INVALID',403);
   return fixedJSON({claim,site_signature:await signature(env,plainPairV3(claim))});
  }
  if(g.expected_bindings!==expected)reject('B_BINDING_CHANGED',409);
  mode='owner_replace';
 }else if(b.continuity){
  const old=b.continuity;
  const proof=['chathand-site-continuity-v3',c.site_id,c.site_origin,old.binding_id,String(old.generation),old.installation_id,b.installation_id,b.public_key_id,b.pairing_hash,b.client_nonce,cleanDeviceName(b.device_name)];
  const row=await bindingByCredential({...old,site_id:c.site_id},env,null);
  if(rows.length!==1||row.binding_id!==rows[0].binding_id||!await verify(row.device_public_key_raw,JSON.stringify(proof),old.device_signature))reject('B_REBIND_CONTINUITY_INVALID',403);
  mode='continuity';
 }else if(rows.length){
  const conflict={protocol_version:'3',site_id:c.site_id,site_origin:c.site_origin,owner_subject:c.owner,
   installation_id:b.installation_id,public_key_id:pubid,pairing_hash:b.pairing_hash,client_nonce:b.client_nonce,
   expected_bindings:expected,device_name:rows[0].device_name||null,last_used:rows[0].last_used||null,
   template_version:env.TEMPLATE_VERSION,manifest_sha256:env.MANIFEST_SHA256,site_public_key:env.SITE_SIGNING_PUBLIC_KEY};
  return fixedJSON({conflict,site_signature:await signature(env,JSON.stringify(['chathand-site-binding-conflict-v3',conflict]))});
 }else if(b.pairing_hash!==env.PAIRING_HASH)reject('B_REBIND_OWNER_REQUIRED',409);
 const pairing_id=crypto.randomUUID(),grant_id=crypto.randomUUID(),issued=sec();
 const claim={protocol_version:'3',site_id:c.site_id,site_origin:c.site_origin,owner_subject:c.owner,
  installation_id:b.installation_id,device_public_key_id:pubid,pairing_id,client_nonce:b.client_nonce,
  server_nonce:rnd(32),issued_at:String(issued),expires_at:String(issued+240),pairing_hash:b.pairing_hash,
  template_version:env.TEMPLATE_VERSION,manifest_sha256:env.MANIFEST_SHA256,site_public_key:env.SITE_SIGNING_PUBLIC_KEY,
  device_name:cleanDeviceName(b.device_name),binding_mode:mode,expected_bindings:expected};
 const data=plainPairV3(claim),claimHash=await digest(data);
 const replacementClaim=pairing_id;
 const statements=[prepared(env.DB,'INSERT OR IGNORE INTO owner_registry(owner_subject,created_at) VALUES(?,?)',c.owner,issued)];
 if(replacementHash){
  // INSERT depends on the conditional consume; a race cannot mint a second grant.
  statements.push(prepared(env.DB,'UPDATE b_rebind_grants SET used_at=?,consume_claim=? WHERE grant_hash=? AND used_at IS NULL AND expires_at>=?',issued,replacementClaim,replacementHash,issued));
  statements.push(prepared(env.DB,'INSERT INTO owner_grants(grant_id,grant_hash,site_id,owner_subject,expires_at) SELECT ?,?,site_id,owner_subject,? FROM b_rebind_grants WHERE grant_hash=? AND consume_claim=?',grant_id,await digest(rnd(48)),issued+240,replacementHash,replacementClaim));
 }else statements.push(prepared(env.DB,'INSERT INTO owner_grants(grant_id,grant_hash,site_id,owner_subject,expires_at) VALUES(?,?,?,?,?)',grant_id,await digest(rnd(48)),c.site_id,c.owner,issued+240));
 statements.push(prepared(env.DB,'INSERT INTO pairing_grants(grant_id,site_id,owner_subject,installation_id,public_key_id,public_key_raw,pairing_id,claim_digest,claim_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',grant_id,c.site_id,c.owner,b.installation_id,pubid,b.public_key,pairing_id,claimHash,JSON.stringify(claim),issued+240));
 await env.DB.batch(statements);
 return fixedJSON({claim,site_signature:await signature(env,data)});
}
async function pairCompleteV3(b,env){
 const c=v2Config(env);if(!bindingProtocol(env))reject('B_REBIND_UNSUPPORTED',409);
 noExtra(b,['protocol_version','pairing_id','claim_digest','device_signature','device_public_key','installation_id','intent_id','precreate_secret']);
 if(!UUID.test(b.pairing_id)||!SHA.test(b.claim_digest)||!UUID.test(b.installation_id)||!UUID.test(b.intent_id))reject('B_PAIR_INVALID',400);
 const grant=await prepared(env.DB,'SELECT * FROM pairing_grants WHERE pairing_id=? AND site_id=?',b.pairing_id,c.site_id).first();
 if(!grant||grant.claim_digest!==b.claim_digest||grant.public_key_raw!==b.device_public_key||grant.installation_id!==b.installation_id)reject('B_PAIR_CHALLENGE',403);
 const claim=JSON.parse(grant.claim_json);
 if(claim.protocol_version!=='3'||await digest(plainPairV3(claim))!==b.claim_digest||claim.owner_subject!==c.owner||claim.template_version!==env.TEMPLATE_VERSION||claim.manifest_sha256!==env.MANIFEST_SHA256||claim.site_public_key!==env.SITE_SIGNING_PUBLIC_KEY)reject('B_PAIR_BINDING',403);
 if(await precreateDigest(b.installation_id,b.intent_id,b.precreate_secret)!==claim.pairing_hash)reject('B_PAIR_CHALLENGE',403);
 const proof=completeProofV2(b.claim_digest,b.installation_id,b.intent_id,b.precreate_secret);
 if(!await verify(b.device_public_key,proof,b.device_signature))reject('B_PAIR_SIGNATURE',403);
 const proofHash=await digest(proof),prior=await prepared(env.DB,'SELECT * FROM b_v3_intents WHERE pairing_id=?',b.pairing_id).first();
 if(prior){
  if(prior.intent_id!==b.intent_id||prior.proof_digest!==proofHash||prior.retention_until<sec())reject('B_PAIR_REPLAY',409);
  const binding=await prepared(env.DB,'SELECT * FROM device_bindings WHERE grant_id=? AND revoked_at IS NULL',grant.grant_id).first();
  const receipt=binding?await prepared(env.DB,'SELECT * FROM pairing_receipts WHERE pairing_id=? AND binding_id=?',b.pairing_id,binding.binding_id).first():null;
  if(!binding||!receipt)reject('B_PAIR_RECEIPT_UNCONFIRMED',409);
  return fixedJSON({...await signedReceiptV2(env,grant,binding,receipt),protocol_version:'3'});
 }
 if(grant.expires_at<sec()||grant.consumed_at!==null)reject('B_PAIR_CHALLENGE',403);
 const at=sec(),bindingId=crypto.randomUUID(),consumeClaim=crypto.randomUUID();
 const last=await prepared(env.DB,'SELECT MAX(generation) AS max_generation FROM device_bindings WHERE site_id=? AND owner_subject=?',c.site_id,c.owner).first();
 const generation=Number(last?.max_generation||0)+1;
 const credential=await derivedCredential(env,bindingId,generation,c.owner),credentialHash=await digest(dec64(credential));
 const receiptDigest=await digest(JSON.stringify(['chathand-site-pair-receipt-v2',b.claim_digest,bindingId,String(generation),c.owner,credentialHash]));
 try{await env.DB.batch([
  prepared(env.DB,'INSERT INTO b_v3_intents(pairing_id,intent_id,proof_digest,consumed_at,retention_until) VALUES(?,?,?,?,?)',b.pairing_id,b.intent_id,proofHash,at,at+86400),
  prepared(env.DB,'UPDATE pairing_grants SET consumed_at=?,consume_claim=? WHERE grant_id=? AND consumed_at IS NULL AND expires_at>=?',at,consumeClaim,grant.grant_id,at),
  prepared(env.DB,'UPDATE owner_grants SET used_at=? WHERE grant_id=? AND used_at IS NULL AND expires_at>=?',at,grant.grant_id,at),
  prepared(env.DB,'UPDATE device_bindings SET revoked_at=?,replaced_at=?,replaced_by_binding_id=? WHERE site_id=? AND owner_subject=? AND revoked_at IS NULL',at,now(),bindingId,c.site_id,c.owner),
  prepared(env.DB,'INSERT INTO device_bindings(binding_id,grant_id,site_id,owner_subject,installation_id,public_key_id,device_public_key_raw,generation,create_claim,device_credential_hash,device_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',bindingId,grant.grant_id,c.site_id,c.owner,b.installation_id,grant.public_key_id,b.device_public_key,generation,consumeClaim,credentialHash,claim.device_name||null,at),
  prepared(env.DB,'INSERT INTO pairing_receipts(pairing_id,grant_id,binding_id,receipt_digest,create_claim) VALUES(?,?,?,?,?)',b.pairing_id,grant.grant_id,bindingId,receiptDigest,consumeClaim)
 ]);}catch(error){if(/B_BINDING_CHANGED|B_SITE_ALREADY_BOUND/.test(String(error?.message)))reject('B_BINDING_CHANGED',409);throw error;}
 const binding=await prepared(env.DB,'SELECT * FROM device_bindings WHERE binding_id=?',bindingId).first();
 const receipt=await prepared(env.DB,'SELECT * FROM pairing_receipts WHERE pairing_id=?',b.pairing_id).first();
 return fixedJSON({...await signedReceiptV2(env,grant,binding,receipt),protocol_version:'3'});
}
async function replacementHealth(b,env){
 const c=config(env);
 const old=await prepared(env.DB,'SELECT * FROM device_bindings WHERE site_id=? AND binding_id=? AND generation=? AND installation_id=? AND revoked_at IS NOT NULL',c.site_id,b.binding_id,b.generation,b.installation_id).first();
 if(!old||!old.replaced_by_binding_id)return null;
 if(old.owner_subject!==c.owner||!eq(old.device_credential_hash,await digest(dec64(b.device_credential))))reject('B_DEVICE_AUTH',403);
 const fields=['chathand-site-health-v2',old.site_id,old.binding_id,String(old.generation),old.installation_id,b.nonce];dec64(b.nonce,32);
 if(!await verify(old.device_public_key_raw,JSON.stringify(fields),b.device_signature))reject('B_DEVICE_SIGNATURE',403);
 await prepared(env.DB,'INSERT INTO device_nonces(binding_id,kind,nonce,seen_at) VALUES(?,?,?,?)',old.binding_id,'binding-replaced',b.nonce,sec()).run();
 const next=await prepared(env.DB,'SELECT device_name FROM device_bindings WHERE binding_id=?',old.replaced_by_binding_id).first();
 const notice={kind:'chathand-site-binding-replaced-v1',site_id:old.site_id,owner_subject:old.owner_subject,
  installation_id:old.installation_id,binding_id:old.binding_id,generation:old.generation,nonce:b.nonce,
  device_name:next?.device_name||null,at:old.replaced_at};
 return fixedJSON({binding_replaced:notice,signature:await signature(env,JSON.stringify(['chathand-site-binding-replaced-v1',notice]))});
}

async function pairBegin(request,env){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const b=await bodyJSON(request,{max:8192});
 if(b.protocol_version==='3')return pairBeginV3(b,env);
 if(bindingProtocol(env))reject('B_BINDING_PROTOCOL_REQUIRED',409);
 if(b.protocol_version==='2')return pairBeginV2(b,env);
 noExtra(b,['site_id','site_origin','installation_id','public_key','public_key_id','client_nonce','enrollment_grant']);
 if(b.site_id!==c.site_id||origin(b.site_origin)!==c.site_origin||!UUID.test(b.installation_id))reject('B_PAIR_INPUT',400);
 const pub=dec64(b.public_key,32),pubid=b64u(new Uint8Array(await crypto.subtle.digest('SHA-256',pub)));
 if(b.public_key_id!==pubid)reject('B_PAIR_PUBLIC_KEY',400);
 dec64(b.client_nonce,32);
 const hash=await digest(dec64(b.enrollment_grant));const grant=await prepared(env.DB,
  'SELECT * FROM owner_grants WHERE grant_hash=? AND site_id=? AND expires_at>? AND used_at IS NULL',hash,c.site_id,sec()).first();
 if(!grant||grant.owner_subject!==c.owner)reject('B_GRANT_UNAVAILABLE',403);
 const pairing_id=crypto.randomUUID(),issued=sec(),claim={protocol_version:'1',site_id:c.site_id,site_origin:c.site_origin,owner_subject:grant.owner_subject,
  installation_id:b.installation_id,device_public_key_id:pubid,pairing_id,client_nonce:b.client_nonce,server_nonce:rnd(32),
  issued_at:String(issued),expires_at:String(issued+240)};
 const claimBytes=plainPair(claim),claimHash=await digest(claimBytes);
 const sql='INSERT INTO pairing_grants(grant_id,site_id,owner_subject,installation_id,public_key_id,public_key_raw,pairing_id,claim_digest,claim_json,expires_at) SELECT grant_id,site_id,owner_subject,?,?,?,?,?,?,? FROM owner_grants WHERE grant_id=? AND grant_hash=? AND used_at IS NULL AND expires_at>?';
 const row=await prepared(env.DB,sql,b.installation_id,pubid,b.public_key,pairing_id,claimHash,JSON.stringify(claim),issued+240,grant.grant_id,hash,issued).run();
 if(changes(row)!==1)reject('B_GRANT_CONCURRENT_OR_EXPIRED',409);
 return fixedJSON({claim,site_signature:await signature(env,claimBytes)});
}
async function pairBeginV2(b,env){
 const c=v2Config(env);
 noExtra(b,['protocol_version','site_id','site_origin','installation_id','public_key','public_key_id','client_nonce']);
 if(b.site_id!==c.site_id||origin(b.site_origin)!==c.site_origin||!UUID.test(b.installation_id))reject('B_PAIR_INPUT',400);
 const pub=dec64(b.public_key,32),pubid=b64u(new Uint8Array(await crypto.subtle.digest('SHA-256',pub)));
 if(b.public_key_id!==pubid)reject('B_PAIR_PUBLIC_KEY',400);dec64(b.client_nonce,32);
 const pairing_id=crypto.randomUUID(),grant_id=crypto.randomUUID(),issued=sec();
 const claim={protocol_version:'2',site_id:c.site_id,site_origin:c.site_origin,owner_subject:c.owner,
  installation_id:b.installation_id,device_public_key_id:pubid,pairing_id,client_nonce:b.client_nonce,
  server_nonce:rnd(32),issued_at:String(issued),expires_at:String(issued+240),
  pairing_hash:env.PAIRING_HASH,template_version:env.TEMPLATE_VERSION,
  manifest_sha256:env.MANIFEST_SHA256,site_public_key:env.SITE_SIGNING_PUBLIC_KEY};
 const claimBytes=plainPairV2(claim),claimHash=await digest(claimBytes);
 const written=await env.DB.batch([
  prepared(env.DB,'INSERT OR IGNORE INTO owner_registry(owner_subject,created_at) VALUES(?,?)',c.owner,issued),
  prepared(env.DB,'INSERT INTO owner_grants(grant_id,grant_hash,site_id,owner_subject,expires_at) VALUES(?,?,?,?,?)',grant_id,await digest(rnd(48)),c.site_id,c.owner,issued+240),
  prepared(env.DB,'INSERT INTO pairing_grants(grant_id,site_id,owner_subject,installation_id,public_key_id,public_key_raw,pairing_id,claim_digest,claim_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
   grant_id,c.site_id,c.owner,b.installation_id,pubid,b.public_key,pairing_id,claimHash,JSON.stringify(claim),issued+240)
 ]);
 if(!Array.isArray(written)||written.length!==3||changes(written[1])!==1||changes(written[2])!==1)reject('B_D1_WRITE_UNCONFIRMED',500);
 return fixedJSON({claim,site_signature:await signature(env,claimBytes)});
}
async function bindingByCredential(body,env,action){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 if(!body||!UUID.test(body.installation_id)||!UUID.test(body.binding_id)||!Number.isSafeInteger(body.generation)||body.generation<1||
    body.site_id!==c.site_id||!B64.test(body.device_credential||''))reject('B_DEVICE_INPUT',400);
 const row=await prepared(env.DB,
  'SELECT * FROM device_bindings WHERE site_id=? AND installation_id=? AND binding_id=? AND generation=? AND (?=1 OR revoked_at IS NULL)',
  c.site_id,body.installation_id,body.binding_id,body.generation,action==='chathand-site-revoke-v1'?1:0).first();
 if(!row||row.owner_subject!==c.owner)reject('B_DEVICE_BINDING',403);
 if(!eq(row.device_credential_hash,await digest(dec64(body.device_credential))))reject('B_DEVICE_AUTH',403);
 if(action&&(!B64.test(body.nonce||'')||dec64(body.nonce,32).length!==32))reject('B_NONCE',400);
 return row;
}
async function checkedDeviceRequest(db,body,env,kind,signedFields){
 const b=await bindingByCredential(body,env,kind);
 const msg=encoder.encode(JSON.stringify([kind,...signedFields(b,body)]));
 if(!await verify(b.device_public_key_raw,msg,body.device_signature))reject('B_DEVICE_SIGNATURE',403);
 const r=await prepared(db,'INSERT INTO device_nonces(binding_id,kind,nonce,seen_at) VALUES(?,?,?,?)',b.binding_id,kind,body.nonce,sec()).run();
 if(changes(r)!==1)reject('B_NONCE_UNCONFIRMED',409);
 if(bindingProtocol(env))await prepared(db,'UPDATE device_bindings SET last_used=? WHERE binding_id=? AND revoked_at IS NULL',now(),b.binding_id).run();
 return b;
}
async function signedReceipt(env,claim,matching){
 const binding=matching.binding,receipt=matching.receipt;
 const credential=await derivedCredential(env,binding.binding_id,binding.generation,binding.owner_subject);
 const fields=['chathand-site-pair-receipt-v1',claim.claim_digest,binding.binding_id,String(binding.generation),
  receipt.receipt_digest,binding.owner_subject,binding.site_id,binding.installation_id];
 return {site_id:binding.site_id,owner_subject:binding.owner_subject,installation_id:binding.installation_id,pairing_id:claim.pairing_id,
  binding_id:binding.binding_id,generation:binding.generation,device_credential:credential,receipt_digest:receipt.receipt_digest,
  site_signature:await signature(env,encoder.encode(JSON.stringify(fields)))};
}
async function signedReceiptV2(env,grant,binding,receipt){
 const claim=JSON.parse(grant.claim_json),credential=await derivedCredential(env,binding.binding_id,binding.generation,binding.owner_subject);
 if(await digest(dec64(credential))!==binding.device_credential_hash)reject('B_CREDENTIAL_SOURCE_CHANGED',409);
 const fields=['chathand-site-pair-receipt-v2',grant.claim_digest,binding.binding_id,String(binding.generation),
  receipt.receipt_digest,binding.owner_subject,binding.site_id,binding.installation_id,credential];
 return {site_id:binding.site_id,owner_subject:binding.owner_subject,installation_id:binding.installation_id,
  pairing_id:grant.pairing_id,binding_id:binding.binding_id,generation:binding.generation,
  device_credential:credential,receipt_digest:receipt.receipt_digest,
  site_signature:await signature(env,JSON.stringify(fields)),protocol_version:'2',template_version:claim.template_version,
  manifest_sha256:claim.manifest_sha256};
}
async function pairCompleteV2(b,env){
 const c=v2Config(env);
 noExtra(b,['protocol_version','pairing_id','claim_digest','device_signature','device_public_key','installation_id','intent_id','precreate_secret']);
 if(!UUID.test(b.pairing_id)||!SHA.test(b.claim_digest)||!UUID.test(b.installation_id)||!UUID.test(b.intent_id))reject('B_PAIR_INVALID',400);
 dec64(b.precreate_secret,32);dec64(b.device_public_key,32);
 const grant=await prepared(env.DB,'SELECT * FROM pairing_grants WHERE pairing_id=? AND site_id=?',b.pairing_id,c.site_id).first();
 if(!grant||grant.claim_digest!==b.claim_digest||grant.public_key_raw!==b.device_public_key||grant.installation_id!==b.installation_id)reject('B_PAIR_CHALLENGE',403);
 const claim=JSON.parse(grant.claim_json);
 if(claim.protocol_version!=='2'||await digest(plainPairV2(claim))!==b.claim_digest||claim.owner_subject!==c.owner||
  claim.pairing_hash!==env.PAIRING_HASH||claim.template_version!==env.TEMPLATE_VERSION||
  claim.manifest_sha256!==env.MANIFEST_SHA256||claim.site_public_key!==env.SITE_SIGNING_PUBLIC_KEY)reject('B_PAIR_BINDING',403);
 const proof=completeProofV2(b.claim_digest,b.installation_id,b.intent_id,b.precreate_secret);
 if(!await verify(b.device_public_key,proof,b.device_signature))reject('B_PAIR_SIGNATURE',403);
 const proofHash=await digest(proof);
 const prior=await prepared(env.DB,'SELECT * FROM b_v2_intents WHERE pairing_id=?',b.pairing_id).first();
 if(prior){
  if(prior.intent_id!==b.intent_id||prior.proof_digest!==proofHash||prior.retention_until<sec())reject('B_PAIR_REPLAY',409);
  const binding=await prepared(env.DB,'SELECT * FROM device_bindings WHERE grant_id=? AND revoked_at IS NULL',grant.grant_id).first();
  const receipt=binding?await prepared(env.DB,'SELECT * FROM pairing_receipts WHERE pairing_id=? AND binding_id=?',grant.pairing_id,binding.binding_id).first():null;
  if(!binding||!receipt)reject('B_PAIR_RECEIPT_UNCONFIRMED',500);
  return fixedJSON(await signedReceiptV2(env,grant,binding,receipt));
 }
 if(grant.expires_at<sec()||grant.consumed_at!==null||
  await precreateDigest(b.installation_id,b.intent_id,b.precreate_secret)!==claim.pairing_hash)reject('B_PAIR_CHALLENGE',403);
 const at=sec(),bindingId=crypto.randomUUID(),consumeClaim=crypto.randomUUID();
 const last=await prepared(env.DB,'SELECT MAX(generation) AS max_generation FROM device_bindings WHERE site_id=? AND owner_subject=? AND installation_id=?',c.site_id,c.owner,b.installation_id).first();
 const generation=Number(last?.max_generation||0)+1;
 const credential=await derivedCredential(env,bindingId,generation,c.owner),credentialHash=await digest(dec64(credential));
 const receiptDigest=await digest(JSON.stringify(['chathand-site-pair-receipt-v2',b.claim_digest,bindingId,String(generation),c.owner,credentialHash]));
 const written=await env.DB.batch([
  prepared(env.DB,'INSERT INTO b_v2_intents(pairing_hash,intent_id,pairing_id,proof_digest,consumed_at,retention_until) VALUES(?,?,?,?,?,?)',claim.pairing_hash,b.intent_id,b.pairing_id,proofHash,at,at+86400),
  prepared(env.DB,'UPDATE pairing_grants SET consumed_at=?,consume_claim=? WHERE grant_id=? AND claim_digest=? AND consumed_at IS NULL AND expires_at>=?',at,consumeClaim,grant.grant_id,b.claim_digest,at),
  prepared(env.DB,'UPDATE owner_grants SET used_at=? WHERE grant_id=? AND used_at IS NULL AND expires_at>=?',at,grant.grant_id,at),
  prepared(env.DB,'INSERT INTO device_bindings(binding_id,grant_id,site_id,owner_subject,installation_id,public_key_id,device_public_key_raw,generation,create_claim,device_credential_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',
   bindingId,grant.grant_id,c.site_id,c.owner,b.installation_id,grant.public_key_id,b.device_public_key,generation,consumeClaim,credentialHash),
  prepared(env.DB,'INSERT INTO pairing_receipts(pairing_id,grant_id,binding_id,receipt_digest,create_claim) VALUES(?,?,?,?,?)',b.pairing_id,grant.grant_id,bindingId,receiptDigest,consumeClaim)
 ]);
 if(!Array.isArray(written)||written.length!==5||written.map(changes).join(',')!=='1,1,1,1,1')reject('B_D1_BATCH_UNCONFIRMED',500);
 const binding=await prepared(env.DB,'SELECT * FROM device_bindings WHERE binding_id=?',bindingId).first();
 const receipt=await prepared(env.DB,'SELECT * FROM pairing_receipts WHERE pairing_id=?',b.pairing_id).first();
 if(!binding||!receipt)reject('B_PAIR_RECEIPT_UNCONFIRMED',500);
 return fixedJSON(await signedReceiptV2(env,grant,binding,receipt));
}
async function pairComplete(request,env){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const b=await bodyJSON(request,{max:8192});
 if(b.protocol_version==='3')return pairCompleteV3(b,env);
 if(bindingProtocol(env))reject('B_BINDING_PROTOCOL_REQUIRED',409);
 if(b.protocol_version==='2')return pairCompleteV2(b,env);
 noExtra(b,['pairing_id','claim_digest','device_signature','device_public_key']);
 if(!UUID.test(b.pairing_id)||!SHA.test(b.claim_digest))reject('B_PAIR_INVALID',400);
 const g=await prepared(env.DB,'SELECT * FROM pairing_grants WHERE pairing_id=? AND site_id=?',b.pairing_id,c.site_id).first();
 if(!g||g.claim_digest!==b.claim_digest||g.expires_at<sec()||g.public_key_raw!==b.device_public_key)reject('B_PAIR_CHALLENGE',403);
 const claim=JSON.parse(g.claim_json),bytes=plainPair(claim);
 if(await digest(bytes)!==b.claim_digest||!await verify(b.device_public_key,bytes,b.device_signature))reject('B_PAIR_SIGNATURE',403);
 let binding=await prepared(env.DB,'SELECT b.* FROM device_bindings b JOIN pairing_receipts r ON r.binding_id=b.binding_id WHERE r.pairing_id=? AND b.owner_subject=? AND b.revoked_at IS NULL',g.pairing_id,g.owner_subject).first();
 if(!binding){
  const last=await prepared(env.DB,'SELECT MAX(generation) AS max_generation FROM device_bindings WHERE site_id=? AND owner_subject=? AND installation_id=?',c.site_id,g.owner_subject,g.installation_id).first();
  const generation=Number(last?.max_generation||0)+1,bindingId=crypto.randomUUID(),consume_claim=crypto.randomUUID(),at=sec();
  const credential=await derivedCredential(env,bindingId,generation,g.owner_subject),credDigest=await digest(dec64(credential));
  const receiptDigest=await digest(JSON.stringify(['chathand-site-pair-receipt-v1',b.claim_digest,bindingId,String(generation),g.owner_subject]));
  const sql=[
   prepared(env.DB,'UPDATE pairing_grants SET consumed_at=?,consume_claim=? WHERE grant_id=? AND site_id=? AND owner_subject=? AND installation_id=? AND public_key_id=? AND claim_digest=? AND consumed_at IS NULL AND expires_at>?',at,consume_claim,g.grant_id,c.site_id,g.owner_subject,g.installation_id,g.public_key_id,b.claim_digest,at),
   prepared(env.DB,'INSERT INTO device_bindings(binding_id,grant_id,site_id,owner_subject,installation_id,public_key_id,device_public_key_raw,generation,create_claim,device_credential_hash) SELECT ?,g.grant_id,g.site_id,g.owner_subject,g.installation_id,g.public_key_id,?,?,g.consume_claim,? FROM pairing_grants g WHERE g.grant_id=? AND g.consume_claim=?',
    bindingId,g.public_key_raw,generation,credDigest,g.grant_id,consume_claim),
   prepared(env.DB,'INSERT INTO pairing_receipts(pairing_id,grant_id,binding_id,receipt_digest,create_claim) SELECT ?,g.grant_id,x.binding_id,?,g.consume_claim FROM pairing_grants g JOIN device_bindings x ON x.grant_id=g.grant_id AND x.create_claim=g.consume_claim WHERE g.grant_id=? AND g.consume_claim=?',
    g.pairing_id,receiptDigest,g.grant_id,consume_claim)
  ];
  const results=await env.DB.batch(sql),observed=results.map(changes);
  if(observed.every(v=>v===0))reject('B_GRANT_CONSUMED',409);
  if(observed.join(',')!=='1,1,1')reject('B_D1_BATCH_INCONSISTENT',500);
  await prepared(env.DB,'UPDATE owner_grants SET used_at=? WHERE grant_id=? AND used_at IS NULL',at,g.grant_id).run();
  binding=await prepared(env.DB,'SELECT * FROM device_bindings WHERE binding_id=?',bindingId).first();
 }
 const receipt=await prepared(env.DB,'SELECT * FROM pairing_receipts WHERE pairing_id=? AND binding_id=?',g.pairing_id,binding.binding_id).first();
 if(!receipt)reject('B_PAIR_RECEIPT_UNCONFIRMED',500);
 return fixedJSON(await signedReceipt(env,g,{binding,receipt}));
}
async function health(request,env){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const b=await bodyJSON(request,{max:8192});
 if(b.protocol_version==='2'){
  v2Config(env);
  noExtra(b,['protocol_version','site_id','binding_id','generation','installation_id','nonce','device_signature','device_credential']);
  if(bindingProtocol(env)){const replaced=await replacementHealth(b,env);if(replaced)return replaced;}
  const binding=await checkedDeviceRequest(env.DB,b,env,'chathand-site-health-v2',
   (row,v)=>[row.site_id,row.binding_id,String(row.generation),row.installation_id,v.nonce]);
  const grant=await prepared(env.DB,'SELECT claim_json FROM pairing_grants WHERE grant_id=?',binding.grant_id).first();
  if(!grant||!['2','3'].includes(JSON.parse(grant.claim_json).protocol_version))reject('B_DEVICE_BINDING',403);
  const sign=['chathand-site-health-ack-v2',binding.site_id,binding.binding_id,String(binding.generation),binding.installation_id,b.nonce,
   env.TEMPLATE_VERSION,env.MANIFEST_SHA256];
  return fixedJSON({protocol_version:'2',site_id:binding.site_id,binding_id:binding.binding_id,
   installation_id:binding.installation_id,generation:binding.generation,nonce:b.nonce,
   template_version:env.TEMPLATE_VERSION,manifest_sha256:env.MANIFEST_SHA256,
   signature:await signature(env,JSON.stringify(sign))});
 }
 noExtra(b,['site_id','binding_id','generation','installation_id','nonce','device_signature','device_credential']);
 const binding=await checkedDeviceRequest(env.DB,b,env,'chathand-site-health-v1',
   (row,v)=>[row.site_id,row.binding_id,String(row.generation),row.installation_id,v.nonce]);
 const sign=['chathand-site-health-ack-v1',binding.site_id,binding.binding_id,String(binding.generation),binding.installation_id,b.nonce];
 return fixedJSON({site_id:binding.site_id,binding_id:binding.binding_id,installation_id:binding.installation_id,
  generation:binding.generation,nonce:b.nonce,signature:await signature(env,JSON.stringify(sign))});
}
async function next(request,env){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const b=await bodyJSON(request,{max:8192});
 noExtra(b,['site_id','binding_id','generation','installation_id','nonce','device_signature','device_credential']);
 const binding=await checkedDeviceRequest(env.DB,b,env,'chathand-site-device-next-v1',
   (row,v)=>[row.site_id,row.binding_id,String(row.generation),row.installation_id,v.nonce]);
 const at=now(),claim_id=crypto.randomUUID();
 const queued=await prepared(env.DB,"SELECT * FROM b_operations WHERE binding_id=? AND generation=? AND (status='queued' OR (status='leased' AND leased_until<?)) AND start_before>? ORDER BY created_at LIMIT 1",
  binding.binding_id,binding.generation,at,at).first();
 let job=null;
 if(queued){
  const update=await prepared(env.DB,"UPDATE b_operations SET status='leased',lease_claim=?,leased_until=? WHERE owner_subject=? AND installation_id=? AND op_id=? AND binding_id=? AND generation=? AND (status='queued' OR (status='leased' AND leased_until<?))",
   claim_id,at+15000,queued.owner_subject,queued.installation_id,queued.op_id,binding.binding_id,binding.generation,at).run();
  if(changes(update)===1){
   const attempt_id=crypto.randomUUID();
   const signed=[JOB_DOMAIN,'1',queued.site_id,queued.binding_id,String(queued.generation),queued.installation_id,queued.owner_subject,
    queued.op_id,queued.tool_name,queued.request_digest,String(queued.created_at),String(queued.start_before),attempt_id];
   job={version:'1',site_id:queued.site_id,binding_id:queued.binding_id,credential_generation:queued.generation,
    installation_id:queued.installation_id,owner_subject:queued.owner_subject,op_id:queued.op_id,tool_name:queued.tool_name,
    arguments:queued.arguments,request_digest:queued.request_digest,created_at:queued.created_at,start_before:queued.start_before,
    attempt_id,site_signature:await signature(env,JSON.stringify(signed))};
  }
 }
 const proof=['chathand-site-next-ack-v1',binding.site_id,binding.binding_id,String(binding.generation),binding.installation_id,b.nonce,
  job?.op_id||'',job?.request_digest||''];
 return fixedJSON({site_id:binding.site_id,binding_id:binding.binding_id,generation:binding.generation,installation_id:binding.installation_id,
  nonce:b.nonce,job,signature:await signature(env,JSON.stringify(proof))});
}
// The optional host-flow sidecar is never serialized with normal tool results.
async function checkedHostFlowMeta(env,payload,binding){
 const any=['host_flow_meta','host_flow_digest','host_flow_signature']
  .some(k=>Object.hasOwn(payload,k));
 if(!any)return null;
 if(!['host_flow_meta','host_flow_digest','host_flow_signature']
  .every(k=>Object.hasOwn(payload,k)))reject('B_HOST_META_FIELDS',400);
 const m=payload.host_flow_meta;
 if(!exactFields(m,HOST_META_FIELDS)||m.version!==1||!UUID.test(m.batch_id)||
  !UUID.test(m.source_op_id)||!UUID.test(m.read_op_id)||
  !SHA.test(m.cap_hash)||!SHA.test(m.session_tag)||!SHA.test(m.nonce_digest)||
  !SHA.test(m.read_result_digest)||!SHA.test(m.write_result_digest)||
  !SHA.test(payload.host_flow_digest)||typeof payload.host_flow_signature!=='string'||
  !nonnegative(m.selection_revision)||!nonnegative(m.reconnect_epoch)||
  !nonnegative(m.transport_epoch)||!nonnegative(m.controller_epoch)||
  !Number.isSafeInteger(m.generation)||m.generation<1||
  !Number.isSafeInteger(m.issued_at)||!Number.isSafeInteger(m.expires_at)||
  m.expires_at<=m.issued_at||m.expires_at-m.issued_at>HOST_TTL_MS||
  m.expires_at<=now()||m.expires_at>now()+HOST_TTL_MS+10000||
  m.issued_at>now()+10000||m.issued_at<now()-HOST_TTL_MS-10000||
  m.site_id!==binding.site_id||m.owner_subject!==binding.owner_subject||
  m.installation_id!==binding.installation_id||m.binding_id!==binding.binding_id||
  m.generation!==binding.generation||m.source_op_id!==payload.op_id||
  m.write_result_digest!==payload.result_digest)
  reject('B_HOST_META_INVALID',403);
 dec64(m.capability,32);
 if(await digest(m.capability)!==m.cap_hash)reject('B_HOST_CAP_INVALID',403);
 let canonical;try{canonical=canonicalize(m);}catch{reject('B_HOST_META_INVALID',400)}
 if(typeof canonical!=='string'||encoder.encode(canonical).length>4096||
    await digest(canonical)!==payload.host_flow_digest)
  reject('B_HOST_META_DIGEST',403);
 const signed=['chathand-site-result-host-v1',binding.site_id,binding.binding_id,String(binding.generation),
  binding.installation_id,payload.nonce,payload.op_id,payload.request_digest,payload.result_digest,
  payload.host_flow_digest];
 if(!await verify(binding.device_public_key_raw,JSON.stringify(signed),payload.host_flow_signature))
  reject('B_HOST_META_SIGNATURE',403);
 const write=await prepared(env.DB,'SELECT * FROM b_operations WHERE owner_subject=? AND installation_id=? AND op_id=? AND site_id=? AND binding_id=? AND generation=?',
  binding.owner_subject,binding.installation_id,payload.op_id,binding.site_id,binding.binding_id,binding.generation).first();
 const read=await prepared(env.DB,'SELECT o.*,r.result_digest AS stored_read_digest FROM b_operations o JOIN b_results r ON r.owner_subject=o.owner_subject AND r.installation_id=o.installation_id AND r.op_id=o.op_id WHERE o.owner_subject=? AND o.installation_id=? AND o.op_id=? AND o.site_id=? AND o.binding_id=? AND o.generation=?',
  binding.owner_subject,binding.installation_id,m.read_op_id,binding.site_id,binding.binding_id,binding.generation).first();
 let writeArgs,readArgs;
 try{writeArgs=JSON.parse(write?.arguments||'null');readArgs=JSON.parse(read?.arguments||'null');}
 catch{reject('B_HOST_PROBE_CONTEXT',403)}
 if(!write||!read||write.tool_name!=='setup_write_probe'||read.tool_name!=='connection_check'||
    write.request_digest!==payload.request_digest||read.status!=='completed'||
    read.stored_read_digest!==m.read_result_digest||
    !exactFields(writeArgs,['kind','session_tag','tool_arguments'])||
    !exactFields(readArgs,['kind','session_tag','tool_arguments'])||
    writeArgs.kind!==HOST_PROBE_KIND||readArgs.kind!==HOST_PROBE_KIND||
    writeArgs.session_tag!==m.session_tag||readArgs.session_tag!==m.session_tag||
    !exactFields(writeArgs.tool_arguments,['nonce'])||
    !exactFields(readArgs.tool_arguments,['nonce'])||
    !hostNonce(writeArgs.tool_arguments.nonce)||
    writeArgs.tool_arguments.nonce!==readArgs.tool_arguments.nonce)
  reject('B_HOST_PROBE_CONTEXT',403);
 return {meta:m,digest:payload.host_flow_digest,box:await encryptResult(env,m)};
}
async function hostFlowForResult(env,owner,op,sessionTag){
 if(!sessionTag)return null;
 await expireHostFlows(env);
 const row=await prepared(env.DB,
  "SELECT h.cap_box,h.cap_hash,h.meta_digest,h.expires_at FROM b_host_flow_caps h JOIN device_bindings d ON d.binding_id=h.binding_id AND d.generation=h.generation AND d.revoked_at IS NULL JOIN b_operations o ON o.owner_subject=h.owner_subject AND o.installation_id=h.installation_id AND o.op_id=h.source_op_id AND o.binding_id=h.binding_id AND o.generation=h.generation WHERE h.owner_subject=? AND h.site_id=? AND h.source_op_id=? AND h.session_tag=? AND h.claim_state='pending' AND h.expires_at>? AND h.cap_box IS NOT NULL AND o.status='completed' AND o.tool_name='setup_write_probe'",
  owner,config(env).site_id,op,sessionTag,now()).first();
 if(!row)return null;
 let m;try{m=await decryptResult(env,row.cap_box);}catch{return null;}
 if(m?.cap_hash!==row.cap_hash||await digest(m.capability)!==row.cap_hash||
  await digest(canonicalize(m))!==row.meta_digest||m.expires_at!==row.expires_at)
  return null;
 // Only the MCP tool RESULT object, not its content or the RPC top level.
 return {chathand_host_flow:m};
}
async function commitHostFlow(env,owner,args,sessionTag){
 if(!exactFields(args,['capability'])||typeof args.capability!=='string'||
   args.capability.length!==43||!sessionTag)reject('B_HOST_CAP_UNAVAILABLE',403);
 dec64(args.capability,32);
 await expireHostFlows(env);
 const hash=await digest(args.capability),at=now(),c=config(env);
 const row=await prepared(env.DB,
  "SELECT h.* FROM b_host_flow_caps h JOIN device_bindings d ON d.binding_id=h.binding_id AND d.generation=h.generation AND d.revoked_at IS NULL AND d.owner_subject=h.owner_subject AND d.installation_id=h.installation_id JOIN b_operations o ON o.owner_subject=h.owner_subject AND o.installation_id=h.installation_id AND o.op_id=h.source_op_id AND o.site_id=h.site_id AND o.binding_id=h.binding_id AND o.generation=h.generation AND o.result_digest=h.write_result_digest WHERE h.cap_hash=? AND h.owner_subject=? AND h.site_id=? AND h.session_tag=? AND h.claim_state='pending' AND h.expires_at>? AND h.cap_box IS NOT NULL AND o.status='completed' AND o.tool_name='setup_write_probe'",
  hash,owner,c.site_id,sessionTag,at).first();
 if(!row)reject('B_HOST_CAP_UNAVAILABLE',403);
 // Derived exclusively from a proven, unconsumed sidecar. No caller-selected op.
 const op_id=crypto.randomUUID(),claim_id=crypto.randomUUID();
 const internal={kind:HOST_RECEIPT_KIND,cap_hash:row.cap_hash,batch_id:row.batch_id,
  source_op_id:row.source_op_id,session_tag:row.session_tag,meta_digest:row.meta_digest};
 if(!exactFields(internal,HOST_INTERNAL_FIELDS))reject('B_HOST_CAP_UNAVAILABLE',403);
 const canon=canonicalize(internal),reqDigest=await digest(canon);
 await atomic(env.DB,[
  prepared(env.DB,
   "UPDATE b_host_flow_caps SET claim_state='claimed',cap_box=NULL,claim_id=?,claim_op_id=?,claimed_at=? WHERE cap_hash=? AND owner_subject=? AND session_tag=? AND claim_state='pending' AND expires_at>? AND cap_box IS NOT NULL",
   claim_id,op_id,at,row.cap_hash,owner,sessionTag,at),
  prepared(env.DB,
   "INSERT INTO b_operations(site_id,owner_subject,installation_id,binding_id,generation,op_id,tool_name,arguments,request_digest,status,created_at,start_before) SELECT h.site_id,h.owner_subject,h.installation_id,h.binding_id,h.generation,?,?,?,?,?,?,? FROM b_host_flow_caps h JOIN device_bindings d ON d.binding_id=h.binding_id AND d.generation=h.generation AND d.revoked_at IS NULL JOIN b_operations s ON s.owner_subject=h.owner_subject AND s.installation_id=h.installation_id AND s.op_id=h.source_op_id AND s.site_id=h.site_id AND s.binding_id=h.binding_id AND s.generation=h.generation AND s.status='completed' AND s.result_digest=h.write_result_digest AND s.tool_name='setup_write_probe' WHERE h.cap_hash=? AND h.claim_state='claimed' AND h.claim_id=? AND h.claim_op_id=? AND h.expires_at>?",
   op_id,HOST_OP,canon,reqDigest,'queued',at,Math.min(at+30000,row.expires_at),row.cap_hash,claim_id,op_id,at)
 ],[1,1]);
 return {queued:true,pending:true,verified:false,executed:false,op_id};
}
async function result(request,env){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const b=await bodyJSON(request,{max:72*1024});
 noExtra(b,['site_id','binding_id','generation','installation_id','nonce','device_signature','device_credential','op_id','request_digest','result_digest','result','host_flow_meta','host_flow_digest','host_flow_signature']);
 if(!UUID.test(b.op_id)||!SHA.test(b.request_digest)||!SHA.test(b.result_digest))reject('B_RESULT_INPUT',400);
 const row=await checkedDeviceRequest(env.DB,b,env,'chathand-site-result-v1',
  (item,v)=>[item.site_id,item.binding_id,String(item.generation),item.installation_id,v.nonce,v.op_id,v.request_digest,v.result_digest]);
 const host=await checkedHostFlowMeta(env,b,row);
 const existing=await prepared(env.DB,'SELECT * FROM b_results WHERE owner_subject=? AND installation_id=? AND op_id=?',
  row.owner_subject,row.installation_id,b.op_id).first();
 let ack_id;
 if(existing){
  if(existing.binding_id!==row.binding_id||existing.request_digest!==b.request_digest||existing.result_digest!==b.result_digest)reject('B_ACK_CONFLICT',409);
  ack_id=existing.ack_id;
  if(host){
   const previous=await prepared(env.DB,'SELECT meta_digest,cap_hash FROM b_host_flow_caps WHERE owner_subject=? AND installation_id=? AND source_op_id=?',
    row.owner_subject,row.installation_id,b.op_id).first();
   // A legacy result with no sidecar cannot gain a cap from retransmission.
   if(!previous||previous.meta_digest!==host.digest||previous.cap_hash!==host.meta.cap_hash)
    reject('B_HOST_META_CONFLICT',409);
  }
 }else{
  // Match the Mac store's pinned RFC8785 canonical result digest, not JSON object key order.
  let canonical;try{canonical=canonicalize(b.result);}catch{reject('B_RESULT_DIGEST',409)}
  if(typeof canonical!=='string'||await digest(canonical)!==b.result_digest)reject('B_RESULT_DIGEST',409);
  const encrypted=await encryptResult(env,b.result);ack_id=crypto.randomUUID();
  const rs=await env.DB.batch([
   prepared(env.DB,"INSERT INTO b_results(owner_subject,installation_id,op_id,binding_id,request_digest,result_digest,ack_id,result_box,created_at) SELECT o.owner_subject,o.installation_id,o.op_id,o.binding_id,o.request_digest,?,?,?,? FROM b_operations o WHERE o.owner_subject=? AND o.installation_id=? AND o.op_id=? AND o.binding_id=? AND o.generation=? AND o.request_digest=? AND o.status IN ('queued','leased')",
    b.result_digest,ack_id,encrypted,now(),row.owner_subject,row.installation_id,b.op_id,row.binding_id,row.generation,b.request_digest),
   prepared(env.DB,"UPDATE b_operations SET status='completed',result_digest=? WHERE owner_subject=? AND installation_id=? AND op_id=? AND binding_id=? AND generation=? AND request_digest=? AND EXISTS(SELECT 1 FROM b_results r WHERE r.owner_subject=? AND r.installation_id=? AND r.op_id=? AND r.result_digest=?)",
    b.result_digest,row.owner_subject,row.installation_id,b.op_id,row.binding_id,row.generation,b.request_digest,row.owner_subject,row.installation_id,b.op_id,b.result_digest),
   ...(host?[prepared(env.DB,
    "INSERT INTO b_host_flow_caps(owner_subject,installation_id,source_op_id,site_id,binding_id,generation,cap_hash,cap_box,meta_digest,batch_id,session_tag,nonce_digest,read_op_id,read_result_digest,write_result_digest,selection_revision,reconnect_epoch,transport_epoch,controller_epoch,issued_at,expires_at,created_at) SELECT r.owner_subject,r.installation_id,r.op_id,o.site_id,r.binding_id,o.generation,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM b_results r JOIN b_operations o ON o.owner_subject=r.owner_subject AND o.installation_id=r.installation_id AND o.op_id=r.op_id WHERE r.owner_subject=? AND r.installation_id=? AND r.op_id=? AND r.binding_id=? AND r.result_digest=? AND o.status='completed' AND o.tool_name='setup_write_probe' AND o.generation=?",
    host.meta.cap_hash,host.box,host.digest,host.meta.batch_id,host.meta.session_tag,
    host.meta.nonce_digest,host.meta.read_op_id,host.meta.read_result_digest,
    host.meta.write_result_digest,host.meta.selection_revision,host.meta.reconnect_epoch,
    host.meta.transport_epoch,host.meta.controller_epoch,host.meta.issued_at,
    host.meta.expires_at,now(),row.owner_subject,row.installation_id,b.op_id,
    row.binding_id,b.result_digest,row.generation)]:[])
  ]);
  if(rs.map(changes).join(',')!==(host?'1,1,1':'1,1'))
   reject('B_RESULT_PERSIST_UNCONFIRMED',409);
 }
 const ack=['chathand-site-result-ack-v1',row.site_id,row.binding_id,String(row.generation),row.installation_id,b.op_id,b.request_digest,b.result_digest,ack_id];
 const extra=host?{host_flow_digest:host.digest,
  host_flow_ack_signature:await signature(env,JSON.stringify(['chathand-site-result-host-ack-v1',
   row.site_id,row.binding_id,String(row.generation),row.installation_id,b.op_id,b.request_digest,
   b.result_digest,ack_id,host.digest]))}:{};
 return fixedJSON({site_id:row.site_id,binding_id:row.binding_id,installation_id:row.installation_id,generation:row.generation,
  op_id:b.op_id,request_digest:b.request_digest,result_digest:b.result_digest,ack_id,
  signature:await signature(env,JSON.stringify(ack)),...extra});
}
async function revoke(request,env){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const b=await bodyJSON(request,{max:8192});noExtra(b,['site_id','binding_id','generation','installation_id','nonce','device_signature','device_credential']);
 const binding=await checkedDeviceRequest(env.DB,b,env,'chathand-site-revoke-v1',
  (row,v)=>[row.site_id,row.binding_id,String(row.generation),row.installation_id,v.nonce]);
 const at=now();
 await env.DB.batch([
  prepared(env.DB,'UPDATE device_bindings SET revoked_at=? WHERE binding_id=? AND generation=? AND revoked_at IS NULL',at,binding.binding_id,binding.generation),
  prepared(env.DB,"UPDATE b_operations SET status='revoked' WHERE binding_id=? AND generation=? AND status IN ('queued','leased')",binding.binding_id,binding.generation)
 ]);
 const proof=['chathand-site-revoke-ack-v1',binding.site_id,binding.binding_id,String(binding.generation),binding.installation_id,b.nonce];
 return fixedJSON({revoked:true,site_id:binding.site_id,binding_id:binding.binding_id,generation:binding.generation,nonce:b.nonce,
  signature:await signature(env,JSON.stringify(proof))});
}
// ### PINNED_JCS_SERIALIZER_INSERTED_FROM_DEPENDENCY ###
/* Vendored upstream json-canonicalize@1.2.0 serializer.
 * MIT License
 *
 * Copyright (c) 2018 Riceball LEE
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
function _serialize(obj, options) {
    let buffer = '';
    const vInclude = options && options.include;
    let vExclude = options && options.exclude;
    if (vExclude) {
        if (typeof vExclude === 'string')
            vExclude = [vExclude];
    }
    if (vInclude)
        vInclude.sort();
    const visited = new WeakMap();
    const allowCircular = options && options.allowCircular;
    const filterUndefined = options && options.filterUndefined;
    const undefinedInArrayToNull = options && options.undefinedInArrayToNull;
    serialize(obj, '');
    return buffer;
    function serialize(object, path) {
        if (object === null ||
            typeof object !== 'object' ||
            object.toJSON != null) {
            /////////////////////////////////////////////////
            // Primitive data type - Use ES6/JSON          //
            /////////////////////////////////////////////////
            buffer += JSON.stringify(object);
        }
        else if (Array.isArray(object)) {
            /////////////////////////////////////////////////
            // Array - Maintain element order              //
            /////////////////////////////////////////////////
            const visitedPath = visited.get(object);
            if (visitedPath !== undefined) {
                if (path.startsWith(visitedPath)) {
                    if (!allowCircular) {
                        throw new Error('Circular reference detected');
                    }
                    buffer += '"[Circular]"';
                    return;
                }
            }
            visited.set(object, path);
            buffer += '[';
            let next = false;
            object.forEach((element, index) => {
                if (next) {
                    buffer += ',';
                }
                next = true;
                if (undefinedInArrayToNull && element === undefined) {
                    element = null;
                }
                /////////////////////////////////////////
                // Array element - Recursive expansion //
                /////////////////////////////////////////
                serialize(element, `${path}[${index}]`);
            });
            buffer += ']';
        }
        else {
            /////////////////////////////////////////////////
            // Object - Sort properties before serializing //
            /////////////////////////////////////////////////
            const visitedPath = visited.get(object);
            if (visitedPath !== undefined) {
                if (path.startsWith(visitedPath)) {
                    if (!allowCircular) {
                        throw new Error('Circular reference detected');
                    }
                    buffer += '"[Circular]"';
                    return;
                }
            }
            visited.set(object, path);
            buffer += '{';
            let next = false;
            const addProp = (property) => {
                if (vExclude && vExclude.includes(property)) {
                    return;
                }
                if (next) {
                    buffer += ',';
                }
                next = true;
                ///////////////////////////////////////////////
                // Property names are strings - Use ES6/JSON //
                ///////////////////////////////////////////////
                buffer += JSON.stringify(property);
                buffer += ':';
                //////////////////////////////////////////
                // Property value - Recursive expansion //
                //////////////////////////////////////////
                serialize(object[property], `${path}.${property}`);
            };
            if (path === '' && vInclude) {
                vInclude.forEach((property) => {
                    if (object.hasOwnProperty(property)) {
                        addProp(property);
                    }
                });
            }
            else {
                let vKeys = Object.keys(object);
                if (filterUndefined) {
                    vKeys = vKeys.filter((k) => object[k] !== undefined);
                }
                vKeys.sort();
                vKeys.forEach((property) => {
                    addProp(property);
                });
            }
            buffer += '}';
        }
    }
}

const canonicalize=x=>_serialize(x,{filterUndefined:true,undefinedInArrayToNull:true});
// Host-flow identity is an association tag, never a ChatGPT-client password.
// Only MCP params._meta from a private owner-mapped request may supply it.
const HOST_OP='b_host_receipt_commit';
const HOST_PROBE_KIND='b_host_probe_v1';
const HOST_RECEIPT_KIND='b_host_receipt_v1';
const B_CALL_CONTEXT_KIND='b_site_call_context_v2';
const REQUEST_ID=/^[A-Za-z0-9_-]{12,96}$/;
const HOST_RESOURCE='ui://chathand/b-host-flow.html';
const HOST_MIME='text/html;profile=mcp-app';
const HOST_META_FIELDS=['version','capability','cap_hash','batch_id','source_op_id','read_op_id',
 'read_result_digest','write_result_digest','installation_id','site_id','owner_subject','binding_id',
 'generation','session_tag','nonce_digest','selection_revision','reconnect_epoch',
 'transport_epoch','controller_epoch','issued_at','expires_at'];
const HOST_INTERNAL_FIELDS=['kind','cap_hash','batch_id','source_op_id','session_tag','meta_digest'];
const HOST_TTL_MS=120000;
const exactFields=(object,fields)=>object&&typeof object==='object'&&!Array.isArray(object)&&
 Object.keys(object).length===fields.length&&fields.every(k=>Object.hasOwn(object,k));
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
const hostNonce=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(x);
async function hostSessionTag(params,owner,site){
 const meta=params?._meta,value=meta&&typeof meta==='object'&&!Array.isArray(meta)?meta['openai/session']:null;
 if(typeof value!=='string'||!value.trim()||value.length>4096||/[\u0000-\u001f]/.test(value))return null;
 return digest(JSON.stringify(['b-host-session-v1',site,owner,value]));
}
function signedProbeArgs(tool,args,sessionTag,requestId){
 // The caller cannot supply the trusted envelope; every public request is wrapped
 // only after owner/binding authorization, and its full content is signed as job args.
 if(args?.kind===HOST_PROBE_KIND||args?.kind===HOST_RECEIPT_KIND||
   args?.kind===B_CALL_CONTEXT_KIND||tool===HOST_OP)reject('B_INTERNAL_TOOL_FORBIDDEN',403);
 if(['connection_check','setup_write_probe'].includes(tool)&&sessionTag&&
    exactFields(args,['nonce'])&&hostNonce(args.nonce))
  return {kind:HOST_PROBE_KIND,session_tag:sessionTag,tool_arguments:{nonce:args.nonce}};
 return {kind:B_CALL_CONTEXT_KIND,version:2,request_id:requestId,
  session_tag:sessionTag||null,tool_arguments:args};
}
async function expireHostFlows(env){
 // Bounded cleanup: never produce a capability or a new side effect.
 await prepared(env.DB,"UPDATE b_host_flow_caps SET claim_state='expired',cap_box=NULL WHERE rowid IN (SELECT rowid FROM b_host_flow_caps WHERE claim_state='pending' AND expires_at<=? ORDER BY expires_at LIMIT 20)",now()).run();
}
async function queueOwnerTool(env,owner,input,sessionTag=null){
 const c=config(env);if(!c)reject('B_SITE_UNCONFIGURED',503);
 const name=input.tool_name,binding_id=input.binding_id,args=input.arguments,requestId=input.request_id;
 if(typeof name!=='string'||!TOOL.test(name)||!UUID.test(binding_id)||!args||typeof args!=='object'||Array.isArray(args))reject('B_TOOL_INPUT',400);
 if(typeof requestId!=='string'||!REQUEST_ID.test(requestId))reject('B_REQUEST_ID_INVALID',400);
 if(name===HOST_OP||name==='chathand_host_flow_commit'||
    [HOST_PROBE_KIND,HOST_RECEIPT_KIND,B_CALL_CONTEXT_KIND].includes(args.kind))
  reject('B_INTERNAL_TOOL_FORBIDDEN',403);
 const canonicalArgs=signedProbeArgs(name,args,sessionTag,requestId);
 let canon,semantic;try{canon=canonicalize(canonicalArgs);semantic=canonicalize([name,args]);}catch{reject('B_ARGS_NOT_CANONICAL',400)}
 if(typeof canon!=='string'||encoder.encode(canon).length>60000)reject('B_ARGS_TOO_LARGE',413);
 const binding=await prepared(env.DB,'SELECT * FROM device_bindings WHERE binding_id=? AND site_id=? AND owner_subject=? AND revoked_at IS NULL',binding_id,c.site_id,owner).first();
 if(!binding)reject('B_BINDING_UNAVAILABLE',403);
 const op_id=crypto.randomUUID(),digestValue=await digest(canon),semanticDigest=await digest(semantic),at=now();
 // One atomic insert owns the durable intent key and queues the operation via
 // the migration trigger. Concurrent identical requests never create a second op.
 const inserted=await prepared(env.DB,
  'INSERT OR IGNORE INTO b_request_keys(site_id,owner_subject,installation_id,binding_id,request_id,generation,op_id,tool_name,arguments,request_digest,semantic_digest,session_tag,created_at,start_before) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  c.site_id,owner,binding.installation_id,binding.binding_id,requestId,binding.generation,
  op_id,name,canon,digestValue,semanticDigest,sessionTag||null,at,at+30000).run();
 const row=await prepared(env.DB,
  'SELECT k.*,o.status AS operation_status FROM b_request_keys k JOIN b_operations o ON o.op_id=k.op_id AND o.owner_subject=k.owner_subject AND o.installation_id=k.installation_id WHERE k.site_id=? AND k.owner_subject=? AND k.installation_id=? AND k.binding_id=? AND k.request_id=?',
  c.site_id,owner,binding.installation_id,binding.binding_id,requestId).first();
 if(!row)reject('B_QUEUE_UNCONFIRMED',500);
 if(row.semantic_digest!==semanticDigest||row.tool_name!==name)reject('B_REQUEST_ID_CONFLICT',409);
 if(row.generation!==binding.generation||row.session_tag!==(sessionTag||null))reject('B_REQUEST_SCOPE_CONFLICT',403);
 if(row.request_digest!==digestValue||row.arguments!==canon)reject('B_REQUEST_CONTEXT_CONFLICT',409);
 const status=row.operation_status;
 return {queued:status==='queued',op_id:row.op_id,state:status,pending:status==='queued'||status==='leased',
  // Only an unclaimed queue row proves no device execution. A retry reports
  // the original operation; a delivered result is not proof of business success.
  ...(status==='queued'?{executed:false}:{business_outcome:'unknown',do_not_replay:true}),
  replayed:changes(inserted)!==1,request_id:requestId,expired:status==='expired',start_before:row.start_before};
}
// Streamable HTTP (MCP 2025-06-18) transport framing only. Business/owner
// permissions below remain unchanged; no sessions, SSE or new tool methods.
const MCP_LATEST='2025-06-18',MCP_FALLBACK='2025-03-26';
const MCP_SUPPORTED=new Set([MCP_LATEST,MCP_FALLBACK,'2025-11-25','2026-07-28']);
const mcpRecord=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const mcpId=x=>x===null||typeof x==='string'||Number.isSafeInteger(x);
const mcpOk=(id,result)=>fixedJSON({jsonrpc:'2.0',id,result});
const mcpError=(id,code,message,status=200)=>fixedJSON({jsonrpc:'2.0',id,error:{code,message}},status);
const mcpAccepted=()=>new Response(null,{status:202,headers:{'cache-control':'no-store'}});
const mcpHeaderVersion=request=>{
 const value=request.headers.get('MCP-Protocol-Version');
 return value===null?MCP_FALLBACK:MCP_SUPPORTED.has(value)?value:null;
};
function mcpOriginAccepted(request,env){
 const supplied=request.headers.get('Origin');
 // Server-to-server MCP clients normally omit Origin. This is NOT a principal,
 // does not bypass the separate Sites private-owner and business gates.
 if(supplied===null)return true;
 let expected;try{expected=origin(env?.SITE_ORIGIN);}catch{return false;}
 // No guessed chatgpt.com/third-party/substring/wildcard origins.
 return env?.SITE_ORIGIN===expected&&supplied===expected&&
  new URL(request.url).origin===expected;
}
async function handleMcpMessage(json,request,env){
 if(!mcpRecord(json)||json.jsonrpc!=='2.0')
  return mcpError(null,-32600,'Invalid Request',400);
 const hasMethod=Object.hasOwn(json,'method'),hasId=Object.hasOwn(json,'id');
 if(!hasMethod){
  const hasResult=Object.hasOwn(json,'result'),hasError=Object.hasOwn(json,'error');
  const validError=hasError&&mcpRecord(json.error)&&
   Number.isSafeInteger(json.error.code)&&typeof json.error.message==='string';
  // A client's JSON-RPC response is acknowledged but never enters business dispatch.
  if(hasId&&mcpId(json.id)&&hasResult!==hasError&&(!hasError||validError))
   return mcpAccepted();
  return mcpError(null,-32600,'Invalid Request',400);
 }
 const method=json.method;
 if(typeof method!=='string'||!method||(hasId&&!mcpId(json.id)))
  return mcpError(null,-32600,'Invalid Request',400);
 const id=hasId?json.id:null;
 if(Object.hasOwn(json,'params')&&!mcpRecord(json.params))
  return mcpError(id,-32602,'Invalid params',400);
 if(method.startsWith('notifications/')){
  // No notification can carry a request id or trigger a business tool.
  return hasId?mcpError(null,-32600,'Invalid Request',400):mcpAccepted();
 }
 if(!hasId)return mcpError(null,-32600,'Invalid Request',400);
 if(method==='initialize'){
  const p=json.params;
  if(!mcpRecord(p)||typeof p.protocolVersion!=='string'||
   !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(p.protocolVersion)||
   !mcpRecord(p.capabilities)||!mcpRecord(p.clientInfo)||
   typeof p.clientInfo.name!=='string'||!p.clientInfo.name||
   typeof p.clientInfo.version!=='string'||!p.clientInfo.version)
   return mcpError(id,-32602,'Invalid initialize params');
  const negotiated=MCP_SUPPORTED.has(p.protocolVersion)?p.protocolVersion:MCP_LATEST;
  return mcpOk(id,{protocolVersion:negotiated,capabilities:{tools:{},resources:{}},
   serverInfo:{name:'ChatHand Private B',version:'1.0.0-source'}});
 }
 if(method==='tools/list')return mcpOk(id,{tools:[
  {name:'chathand_identity_check',description:'Read-only comparison of managed Site-scoped identity with the configured owner pin. No business access.',inputSchema:{type:'object',properties:{nonce:{type:'string',minLength:16,maxLength:128},protocol_version:{type:'string',const:'1'}},required:['nonce','protocol_version'],additionalProperties:false}},
  {name:'chathand_request',description:'Queues once for a stable user-intent request_id (12–96 ASCII letters, digits, underscore or hyphen); retry the SAME request_id only for the same authenticated scope, tool and arguments. A new intentional operation needs a new request_id. Pending and unknown are not success: poll the original op_id, never resubmit under another id.',inputSchema:{type:'object',properties:{binding_id:{type:'string'},request_id:{type:'string',pattern:'^[A-Za-z0-9_-]{12,96}$',minLength:12,maxLength:96},tool_name:{type:'string'},arguments:{type:'object'}},required:['binding_id','request_id','tool_name','arguments'],additionalProperties:false}},
  {name:'chathand_result',description:'Reads only the original op_id with a current authenticated binding and its original session association. A missing, revoked or mismatched scope never exposes a result; reads do not retry execution.',inputSchema:{type:'object',properties:{op_id:{type:'string'},binding_id:{type:'string'}},required:['op_id','binding_id'],additionalProperties:false},
   _meta:{ui:{resourceUri:HOST_RESOURCE},'openai/outputTemplate':HOST_RESOURCE}},
  {name:'chathand_host_flow_commit',description:'Single-use current-binding host application-flow receipt. App only; queued is not verified.',
   inputSchema:{type:'object',properties:{capability:{type:'string',minLength:43,maxLength:43}},
    required:['capability'],additionalProperties:false},
   _meta:{ui:{visibility:['app']},'openai/widgetAccessible':true}}
 ]});
 if(method==='resources/list'||method==='resources/read'){
  const identity=trustedOwner(request,env,{mcp:true});
  const registered=identity?await prepared(env.DB,
   'SELECT owner_subject FROM owner_registry WHERE owner_subject=?',identity).first():null;
  if(!identity||registered?.owner_subject!==identity)
   return mcpError(id,-32603,'Resource unavailable');
  if(method==='resources/list')return mcpOk(id,{resources:[
   {uri:HOST_RESOURCE,name:'ChatHand current-binding host receipt',
    mimeType:HOST_MIME,description:'Private application-flow confirmation widget'}]});
  const resourceParams=json.params;
  if(!mcpRecord(resourceParams)||resourceParams.uri!==HOST_RESOURCE||
     Object.keys(resourceParams).some(k=>!['uri','_meta'].includes(k))||
     Object.hasOwn(resourceParams,'_meta')&&!mcpRecord(resourceParams._meta))
   return mcpError(id,-32602,'Invalid resource URI');
  if(typeof B_HOST_WIDGET_SOURCE!=='string'||!B_HOST_WIDGET_SOURCE.startsWith('<!doctype html>'))
   return mcpError(id,-32603,'Resource unavailable');
  return mcpOk(id,{contents:[{uri:HOST_RESOURCE,mimeType:HOST_MIME,text:B_HOST_WIDGET_SOURCE}]});
 }
 if(method!=='tools/call')return mcpError(id,-32601,'Method not found');
 const name=json?.params?.name,args=json?.params?.arguments||{};
 // This one exact tool has no DB/secret dependency, no write, no ability to set
 // owner pin or MCP mapping flag. A successful tool response is NOT authorization.
 if(name==='chathand_identity_check')return mcpOk(id,{content:[
  {type:'text',text:JSON.stringify(readOnlyMcpIdentity(request,env,args))}]});
 const candidate=trustedOwner(request,env,{mcp:true});
 const registered=candidate?await prepared(env.DB,'SELECT owner_subject FROM owner_registry WHERE owner_subject=?',candidate).first():null;
 const owner=registered?.owner_subject===candidate?candidate:null,matching=Boolean(owner);
 if(!matching)return mcpOk(id,{isError:true,content:[{type:'text',text:'B_OWNER_MAPPING_UNVERIFIED'}]});
 const sessionTag=await hostSessionTag(json.params,owner,config(env).site_id);
 if(name==='chathand_request'){
  const value=await queueOwnerTool(env,owner,args,sessionTag);
  return mcpOk(id,{content:[{type:'text',text:JSON.stringify(value)}]});
 }
 if(name==='chathand_host_flow_commit'){
  const value=await commitHostFlow(env,owner,args,sessionTag);
  return mcpOk(id,{content:[{type:'text',text:JSON.stringify(value)}]});
 }
 if(name==='chathand_result'){
  if(!UUID.test(args.op_id)||!UUID.test(args.binding_id))reject('B_OPERATION_ID_INVALID',400);
  const site=config(env).site_id;
  const binding=await prepared(env.DB,
   'SELECT installation_id,generation FROM device_bindings WHERE binding_id=? AND site_id=? AND owner_subject=? AND revoked_at IS NULL',
   args.binding_id,site,owner).first();
  if(!binding)reject('B_RESULT_SCOPE_REQUIRED',403);
  const original=await prepared(env.DB,
   'SELECT k.generation,k.session_tag,k.request_digest,o.status FROM b_request_keys k JOIN b_operations o ON o.op_id=k.op_id AND o.owner_subject=k.owner_subject AND o.installation_id=k.installation_id WHERE k.op_id=? AND k.owner_subject=? AND k.site_id=? AND k.installation_id=? AND k.binding_id=?',
   args.op_id,owner,site,binding.installation_id,args.binding_id).first();
  // Pre-migration/unknown operations lack trustworthy association: no result disclosure.
  if(!original||original.generation!==binding.generation||
    original.session_tag!==(sessionTag||null))reject('B_RESULT_SCOPE_REQUIRED',403);
  const r=await prepared(env.DB,
   'SELECT r.result_box FROM b_results r WHERE r.op_id=? AND r.owner_subject=? AND r.installation_id=? AND r.binding_id=? AND r.request_digest=?',
   args.op_id,owner,binding.installation_id,args.binding_id,original.request_digest).first();
  if(!r)return mcpOk(id,{content:[{type:'text',text:JSON.stringify({
   state:original.status,pending:['queued','leased'].includes(original.status),
   ...(original.status==='queued'?{executed:false}:{business_outcome:'unknown',do_not_replay:true}),
   op_id:args.op_id})}]});
  const value=await decryptResult(env,r.result_box);
  // Mac-private widget/relay capabilities have no general Site consumer. Keep
  // their original box/digest/ACK intact, but never put them in model-visible
  // text or promote them to platform _meta. Only the dedicated verified Host
  // sidecar below may provide private Site metadata.
  const visible=mcpRecord(value)&&Object.hasOwn(value,'_card_meta')?
   Object.fromEntries(Object.entries(value).filter(([key])=>key!=='_card_meta')):value;
  const privateMeta=await hostFlowForResult(env,owner,args.op_id,sessionTag);
  return mcpOk(id,{content:[{type:'text',text:JSON.stringify(visible)}],
   ...(privateMeta?{_meta:privateMeta}:{})});
 }
 return mcpOk(id,{isError:true,content:[{type:'text',text:'B_TOOL_UNAVAILABLE'}]});
}
// Each JSON-RPC batch element passes the same independent readonly vs business
// authorization gates. A successful identity probe cannot confer privilege on
// any sibling tool call; all arrays and response counts are bounded.
async function handleMcp(request,env,protocolVersion){
 let input;
 try{input=await bodyJSON(request,{max:65536,allowArray:true,allowPrimitive:true});}
 catch(e){
  if(e instanceof Rejected&&e.code==='B_JSON_INVALID')return mcpError(null,-32700,'Parse error',400);
  if(e instanceof Rejected&&e.status===400)return mcpError(null,-32600,'Invalid Request',400);
  throw e;
 }
 const single=async item=>{
  try{return await handleMcpMessage(item,request,env);}
  catch(e){
   // Only these fixed, controlled business-tool failures are MCP tool results.
   // B_QUEUE_UNCONFIRMED remains uncertain: never imply replay is safe.
   // Envelope/invalid params still use JSON-RPC error, unknown errors stay redacted.
   if(e instanceof Rejected&&mcpRecord(item)&&item.jsonrpc==='2.0'&&
      item.method==='tools/call'&&Object.hasOwn(item,'id')&&mcpId(item.id)&&
      ['B_BINDING_UNAVAILABLE','B_ARGS_TOO_LARGE','B_QUEUE_UNCONFIRMED',
       'B_REQUEST_ID_CONFLICT','B_REQUEST_SCOPE_CONFLICT','B_REQUEST_CONTEXT_CONFLICT',
       'B_RESULT_SCOPE_REQUIRED','B_RESULT_UNAVAILABLE',
       'B_HOST_CAP_UNAVAILABLE','B_INTERNAL_TOOL_FORBIDDEN'].includes(e.code))
    return mcpOk(item.id,{isError:true,content:[{type:'text',text:e.code}]});
   const id=mcpRecord(item)&&mcpId(item.id)?item.id:null;
   return mcpError(id,e instanceof Rejected&&e.status===400?-32602:-32603,
    e instanceof Rejected&&e.status===400?'Invalid params':'Internal error');
  }
 };
 if(!Array.isArray(input))return single(input);
 // 2025-03-26 Streamable HTTP permits a request/notification/response batch;
 // 2025-06-18 explicitly requires exactly one JSON-RPC message per POST.
 if(protocolVersion!==MCP_FALLBACK)return mcpError(null,-32600,'Batch not supported',400);
 if(input.length<1||input.length>8)return mcpError(null,-32600,'Invalid Request',400);
 const responses=[];
 for(const item of input){
  const r=await single(item);
  if(r.status!==202)responses.push(await r.json());
 }
 return responses.length?fixedJSON(responses):mcpAccepted();
}
const B_HOST_WIDGET_SOURCE="<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\"><title>ChatHand 当前连接确认</title>\n<style>html,body{margin:0;padding:0;background:transparent;color:#23332e;font:14px/1.55 system-ui,-apple-system,\"PingFang SC\",sans-serif}main{box-sizing:border-box;padding:18px 20px;border:1px solid #d7e2dd;border-radius:14px;background:#f8fbf9;max-width:500px}h1{font-size:15px;line-height:1.4;margin:0 0 8px;font-weight:650}p{margin:0;color:#455a51}small{display:block;margin-top:9px;color:#697970;font-size:12px}</style></head>\n<body><main><h1>ChatHand · 当前绑定连接</h1><p id=\"status\" role=\"status\" aria-live=\"polite\">本次操作尚未取得有效的应用内连接回执。</p><small>只有本机收到有效回执后，连接状态才会更新。</small></main>\n<script>\n(function(){\n \"use strict\";\n const status=document.getElementById(\"status\");\n const TOOL=\"chathand_host_flow_commit\";\n const META_KEYS=[\"version\",\"capability\",\"cap_hash\",\"batch_id\",\"source_op_id\",\"read_op_id\",\"read_result_digest\",\"write_result_digest\",\"installation_id\",\"site_id\",\"owner_subject\",\"binding_id\",\"generation\",\"session_tag\",\"nonce_digest\",\"selection_revision\",\"reconnect_epoch\",\"transport_epoch\",\"controller_epoch\",\"issued_at\",\"expires_at\"].sort();\n const CAP=/^[A-Za-z0-9_-]{43}$/;\n const HEX=/^[a-f0-9]{64}$/;\n const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;\n let attempted=false,ready=false,capability=null,sourceOp=null,seq=0,initialized=false;\n const pending=new Map();\n function show(message){status.textContent=message;}\n function asRecord(v){return v!==null&&typeof v===\"object\"&&!Array.isArray(v);}\n function readFlow(payload){\n  if(!asRecord(payload))return null;\n  const result=asRecord(payload.result)?payload.result:payload;\n  return readFlowMetadata(asRecord(result._meta)?result._meta:null);\n }\n function readFlowMetadata(meta){\n  // Separate standard tool result and direct trusted ChatGPT metadata shapes.\n  const value=asRecord(meta)?meta.chathand_host_flow:null;\n  if(!asRecord(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(META_KEYS)||\n     value.version!==1||!CAP.test(value.capability)||!HEX.test(value.cap_hash)||\n     !ID.test(value.source_op_id)||!HEX.test(value.session_tag)||\n     !Number.isSafeInteger(value.expires_at)||value.expires_at<=Date.now())return null;\n  return {cap:value.capability,op:value.source_op_id};\n }\n function toHost(method,params){\n  const id=\"chathand-b-widget-\"+(++seq);\n  return new Promise((resolve,reject)=>{\n   pending.set(id,{resolve,reject});\n   try{window.parent.postMessage({jsonrpc:\"2.0\",id,method,params},\"*\");}\n   catch{pending.delete(id);reject(Error(\"bridge unavailable\"));}\n  });\n }\n async function submit(){\n  if(attempted||!capability)return;\n  if(!ready&&typeof window.openai?.callTool!==\"function\"){\n   show(\"当前宿主未提供可用的应用内工具通道。\");return;\n  }\n  attempted=true;\n  const secret=capability;capability=null;\n  show(\"应用内确认已发起，等待本机完成回执。\");\n  try{\n   let response;\n   if(ready){response=await toHost(\"tools/call\",{name:TOOL,arguments:{capability:secret}});}\n   else{response=await window.openai.callTool(TOOL,{capability:secret});}\n   if(asRecord(response)&&response.isError===true||\n      asRecord(response?.result)&&response.result.isError===true||\n      asRecord(response)&&asRecord(response.error)){\n    show(\"本次应用内确认未通过，请重新完成连接确认。\");return;\n   }\n   show(\"应用已送出回执请求；最终结果以本机当前连接状态为准。\");\n  }catch{show(\"无法确认本次请求是否到达本机。不会自动重试。\");}\n }\n function ingest(payload,source=\"result\"){\n  const flow=source===\"metadata\"?readFlowMetadata(payload):readFlow(payload);\n  if(!flow||attempted)return;\n  if(sourceOp&&sourceOp!==flow.op)return;\n  sourceOp=flow.op;capability=flow.cap;\n  void submit();\n }\n window.addEventListener(\"message\",function(event){\n  if(event.source!==window.parent||!asRecord(event.data)||event.data.jsonrpc!==\"2.0\")return;\n  const data=event.data;\n  if(typeof data.id===\"string\"&&pending.has(data.id)){\n   const item=pending.get(data.id);pending.delete(data.id);\n   if(asRecord(data.error)){item.reject(Error(\"bridge error\"));}\n   else{if(!initialized&&data.id===\"chathand-b-widget-1\"){\n    initialized=true;ready=true;\n    try{window.parent.postMessage({jsonrpc:\"2.0\",method:\"ui/notifications/initialized\"},\"*\");}catch{}\n    void submit();\n   }item.resolve(data.result);}\n   return;\n  }\n  if(data.method===\"ui/notifications/tool-result\")ingest(data.params);\n });\n // Metadata globals may update after initial render; same strict flow schema applies.\n window.addEventListener(\"openai:set_globals\",function(event){\n  const globals=event.detail?.globals;\n  if(asRecord(globals))ingest(globals.toolResponseMetadata,\"metadata\");\n });\n try{\n  if(typeof window.parent?.postMessage===\"function\"){\n   void toHost(\"ui/initialize\",{protocolVersion:\"2025-06-18\",\n    clientInfo:{name:\"ChatHand B host receipt\",version:\"1.0.0\"},capabilities:{}}).catch(()=>{\n     if(typeof window.openai?.callTool!==\"function\")show(\"应用内消息通道不可用。\");\n   });\n  }\n }catch{show(\"应用内消息通道不可用。\");}\n try{ingest(window.openai?.toolResponseMetadata,\"metadata\");}catch{}\n})();\n</script></body></html>";

const v412Relay=createRelayWorker({initialize:{protocolVersion:'2025-11-25',capabilities:{tools:{},resources:{}},serverInfo:{name:'chathand',version:'1.0.0-beta.4'}},serverDiscover:{supportedVersions:['2026-07-28','2025-11-25','2025-06-18'],capabilities:{tools:{},resources:{}}},tools:{tools:[]},resources:{resources:[]},resourceContents:{}});
async function v412Scope(env,binding){
 const scope_key=await digest(JSON.stringify([binding.site_id,binding.owner_subject,binding.installation_id,binding.binding_id,binding.generation]));
 await prepared(env.DB,'INSERT OR IGNORE INTO rc_scopes(scope_key,site_id,owner_subject,installation_id,binding_id,generation) SELECT ?,site_id,owner_subject,installation_id,binding_id,generation FROM device_bindings WHERE binding_id=? AND generation=? AND revoked_at IS NULL',scope_key,binding.binding_id,binding.generation).run();
 return scope_key;
}
async function v412Device(request,env,ctx){
 const c=config(env),url=new URL(request.url);if(!c||url.origin!==c.site_origin)reject('B_ORIGIN_INVALID',403);
 if(!['/relay/runtime','/relay/ws','/relay/disconnect'].includes(url.pathname))reject('B_ROUTE_RETIRED',410);
 if(request.method!==(url.pathname==='/relay/ws'?'GET':'POST'))reject('B_METHOD_INVALID',405);
 const header=request.headers.get('X-ChatHand-Device');if(!header||header.length>4096)reject('B_DEVICE_INPUT',400);
 let proof;try{proof=JSON.parse(decoder.decode(dec64(header)));}catch{reject('B_DEVICE_INPUT',400);}
 if(!Number.isSafeInteger(proof.expires_at)||proof.expires_at<=now()||proof.expires_at>now()+30000)reject('B_DEVICE_PROOF_EXPIRED',403);
 const body_hash=request.method==='POST'?await digest(new Uint8Array(await request.clone().arrayBuffer())):'';
 if(proof.body_hash!==body_hash)reject('B_DEVICE_BODY_HASH',403);
 const binding=await checkedDeviceRequest(env.DB,proof,env,'chathand-site-relay-v412',
  (row,v)=>[row.site_id,row.binding_id,String(row.generation),row.installation_id,v.nonce,request.method,c.site_origin,url.pathname,body_hash,String(v.expires_at)]);
 const scope_key=await v412Scope(env,binding);
 return v412Relay.fetch(request,{...env,__scopeKey:scope_key,__authenticatedDevice:true},ctx);
}
async function v412Mcp(request,env,ctx,protocolVersion=mcpHeaderVersion(request)){
 // Preserve strict JSON-RPC framing before entering the transparent relay.
 let rpc;try{rpc=await bodyJSON(request.clone(),{max:6*1024*1024,allowArray:true,allowPrimitive:true});}catch(e){if(e instanceof Rejected&&e.code!=='B_JSON_INVALID')throw e;return mcpError(null,-32700,'Parse error',400);}
 if(Array.isArray(rpc)){
  if(protocolVersion!==MCP_FALLBACK||rpc.length<1||rpc.length>8)return mcpError(null,-32600,'Batch not supported',400);
  const responses=[];for(const item of rpc){const result=await v412Mcp(new Request(request,{body:JSON.stringify(item)}),env,ctx,protocolVersion);if(result.status!==202)responses.push(await result.json());}return responses.length?fixedJSON(responses):mcpAccepted();
 }
 if(!mcpRecord(rpc)||rpc.jsonrpc!=='2.0')return mcpError(null,-32600,'Invalid Request',400);
 if(!Object.hasOwn(rpc,'method')){
  const hasResult=Object.hasOwn(rpc,'result'),hasError=Object.hasOwn(rpc,'error'),validError=hasError&&mcpRecord(rpc.error)&&Number.isSafeInteger(rpc.error.code)&&typeof rpc.error.message==='string';
  if(Object.hasOwn(rpc,'id')&&mcpId(rpc.id)&&hasResult!==hasError&&(!hasError||validError))return mcpAccepted();return mcpError(null,-32600,'Invalid Request',400);
 }
 const hasId=Object.hasOwn(rpc,'id');
 if(typeof rpc.method!=='string'||!rpc.method||(hasId&&!mcpId(rpc.id)))return mcpError(null,-32600,'Invalid Request',400);
 if(Object.hasOwn(rpc,'params')&&!mcpRecord(rpc.params))return mcpError(hasId?rpc.id:null,-32602,'Invalid params',400);
 if(rpc.method.startsWith('notifications/')&&hasId)return mcpError(null,-32600,'Invalid Request',400);
 if(!hasId&&!rpc.method.startsWith('notifications/'))return mcpError(null,-32600,'Invalid Request',400);
 if(rpc.method==='initialize'){
  const params=rpc.params;if(!mcpRecord(params)||typeof params.protocolVersion!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)||!mcpRecord(params.capabilities)||!mcpRecord(params.clientInfo)||typeof params.clientInfo.name!=='string'||!params.clientInfo.name||typeof params.clientInfo.version!=='string'||!params.clientInfo.version)return mcpError(rpc.id,-32602,'Invalid initialize params');
 }
 if(rpc.method==='resources/read'&&(!mcpRecord(rpc.params)||typeof rpc.params.uri!=='string'||!rpc.params.uri))return mcpError(hasId?rpc.id:null,-32602,'Invalid resource params');
 if(rpc.method==='tools/call'&&(!mcpRecord(rpc.params)||typeof rpc.params.name!=='string'||!rpc.params.name||Object.hasOwn(rpc.params,'arguments')&&!mcpRecord(rpc.params.arguments)))return mcpError(hasId?rpc.id:null,-32602,'Invalid tool params');
 const owner=trustedOwner(request,env,{mcp:true});const c=config(env);
 const registered=owner?await prepared(env.DB,'SELECT owner_subject FROM owner_registry WHERE owner_subject=?',owner).first():null;
 if(!c||!owner||registered?.owner_subject!==owner)return mcpError(hasId?rpc.id:null,-32001,'B_OWNER_MAPPING_UNVERIFIED');
 await recordMcpOwnerObservation(request,env,owner);
 const rows=(await prepared(env.DB,`SELECT b.* FROM device_bindings b WHERE b.site_id=? AND b.owner_subject=? AND b.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM device_bindings n WHERE n.site_id=b.site_id AND n.owner_subject=b.owner_subject AND n.installation_id=b.installation_id AND n.revoked_at IS NULL AND n.generation>b.generation)`,c.site_id,owner).all()).results||[];
 if(rows.length!==1)return mcpError(hasId?rpc.id:null,-32001,rows.length?'B_BINDING_AMBIGUOUS':'MAC_UNPAIRED');
 const scope_key=await v412Scope(env,rows[0]);
 return v412Relay.fetch(request,{...env,__scopeKey:scope_key,__verifiedCaller:owner},ctx);
}
const STRICT_POST=new Set(['/owner/rebind','/owner/grant','/pair/begin','/pair/complete','/device/health','/device/next','/device/result','/device/revoke','/mcp']);
export default {
 async fetch(request,env,ctx){
  void ctx;
  try{
   const url=new URL(request.url),route=url.pathname;
   if(route==='/mcp'){
    if(!mcpOriginAccepted(request,env))reject('B_MCP_ORIGIN_UNTRUSTED',403);
    const version=mcpHeaderVersion(request);
    if(version===null)return mcpError(null,-32600,'Unsupported protocol version',400);
    if(request.method==='GET'||request.method==='DELETE')
     return new Response(null,{status:405,headers:{allow:'POST','cache-control':'no-store'}});
    if(request.method!=='POST')
     return new Response(null,{status:405,headers:{allow:'POST','cache-control':'no-store'}});
    return await v412Mcp(request,env,ctx,version);
   }
   if(route.startsWith('/relay/'))return await v412Device(request,env,ctx);
   // Bootstrap is the sole pinless read-only route; evaluated before any DB,
   // signing key or business config lookup. Does not register an owner.
   if(route==='/bootstrap/identity'){
    const browser=prefersBootstrapHTML(request);
    try{
     if(request.method!=='GET')reject('B_BOOTSTRAP_METHOD_INVALID',405);
     const identity=bootstrapIdentity(request,env);
     return browser?await bootstrapIdentityPresentation(request,identity):identity;
    }catch(error){
     if(!browser)throw error;
     return bootstrapIdentityErrorPage(request,error instanceof Rejected?error.code:'B_BOOTSTRAP_UNCONFIRMED',error instanceof Rejected?error.status:500);
    }
   }
   if(!['GET','POST'].includes(request.method))reject('B_METHOD_INVALID',405);
   if(request.method==='POST'&&!STRICT_POST.has(route))reject('B_ROUTE_INVALID',404);
   if(request.method==='GET'&&route==='/health')return fixedJSON({configured:configured(env),site_deployed:!!config(env),device_ready:false,host_app_bridge:'unverified'});
   if(request.method==='GET'&&route==='/public/identity')return fixedJSON(await publicInfo(env));
   if(request.method==='GET'&&route==='/')return await ownerHome(request,env);
   if(request.method!=='POST')reject('B_ROUTE_INVALID',404);
   if(route==='/owner/rebind')return await ownerRebind(request,env);
   if(route==='/owner/grant')return await ownerGrant(request,env);
   if(route==='/pair/begin')return await pairBegin(request,env);
   if(route==='/pair/complete')return await pairComplete(request,env);
   if(route==='/device/health')return await health(request,env);
   if(route==='/device/next'||route==='/device/result')reject('B_TRANSPORT_UPGRADE_REQUIRED',410);
   if(route==='/device/revoke')return await revoke(request,env);
   reject('B_ROUTE_INVALID',404);
  }catch(error){return errResponse(error);}
 }
};
