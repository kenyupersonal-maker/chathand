import { createRelaySession } from './ws-relay-session.mjs';
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
export const TEMPLATE_VERSION='4.1.2';
export const DEFAULT_SETTINGS={hotMs:50,warmMs:100,coldMs:500,hotWindowMs:30000,warmWindowMs:300000,rotateMs:45000,maxOperations:200};
const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const HOT_WINDOW_MAX = 30_000;
const ACTIVE_RESULT_POLL_MS = 50;
export function hotPollDeadline(body, started = performance.now()) {
  const remaining = body?.hot_window_ms;
  return Number.isSafeInteger(remaining) && remaining > 0 ? started + Math.min(remaining, HOT_WINDOW_MAX) : 0;
}
export function pollingSleep(hotUntil, now = performance.now()) { return hotUntil > now ? 100 : 500; }

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
function trustedCaller(request, env) {
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  const user = request.headers.get('oai-authenticated-user-id')?.trim();
  if (env.RELAY_OWNER_EMAIL && email && email === env.RELAY_OWNER_EMAIL.trim().toLowerCase()) return `email:${email}`;
  if (env.RELAY_OWNER_USER_ID && user && user === env.RELAY_OWNER_USER_ID.trim()) return `user:${user}`;
  return null;
}
function paired(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer (.+)$/i.exec(authorization);
  return env.RELAY_ACTIVE === 'true' && !!env.RELAY_PAIRING_KEY && !!match && safeEqual(match[1], env.RELAY_PAIRING_KEY);
}
const TIMING_VERSION = 'rc-timing-1';
const MAX_TIMING_HEADER = 8 * 1024;
const MAX_DB_SPANS = 16;
const MAX_DB_META = 8;
export function accumulateDB(trace, entry) {
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
export function encodeTimingHeader(trace) {
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
  if (!env.DB) throw new Error('D1_UNAVAILABLE');
  if (!env.__rcTiming) return env.DB;
  if (env.__rcTimedDB) return env.__rcTimedDB;
  const trace = env.__rcTiming, raw = env.DB;
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
  const statement = db(env).prepare("INSERT INTO rc_chunks(job_id,direction,sequence,chunk_hash,data_b64) VALUES(?,'timing',0,?,?) ON CONFLICT(job_id,direction,sequence) DO UPDATE SET chunk_hash=excluded.chunk_hash,data_b64=excluded.data_b64")
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
    d.prepare("UPDATE rc_jobs SET status='expired',completed_at=? WHERE status='queued' AND expires_at<=?").bind(now, now),
    d.prepare("UPDATE rc_jobs SET status='unknown',completed_at=? WHERE status='claimed' AND expires_at<=? AND (http_wait_until IS NULL OR http_wait_until<=?)").bind(now, now, now),
    d.prepare("DELETE FROM rc_chunks WHERE job_id IN (SELECT id FROM rc_jobs WHERE status IN ('done','cancelled','unknown','expired') AND completed_at IS NOT NULL AND completed_at<=?)").bind(now - CONTENT_RETENTION),
    d.prepare('DELETE FROM rc_jobs WHERE tombstone_until<=?').bind(now),
    ...tail,
  ]);
}

async function markDisconnected(env, id) {
  try { await db(env).prepare("UPDATE rc_jobs SET status='unknown',completed_at=? WHERE id=? AND status IN ('queued','claimed')").bind(Date.now(), id).run(); } catch {}
}
async function markUnknownOnAbort(request, env, id) {
  if (request.signal.aborted) await markDisconnected(env, id);
  else request.signal.addEventListener('abort', () => { void markDisconnected(env, id); }, { once: true });
}
async function insertJob(env, caller, session, rpc, bodyBytes, now) {
  timingMark(env, 'enqueue_started_ms');
  const requestHash = await sha256(bodyBytes), callerHash = await sha256(utf8(caller));
  const sessionHash = await sha256(utf8(JSON.stringify(session))), rpcId = JSON.stringify([typeof rpc.id, rpc.id]);
  const dedupeKey = await sha256(utf8(JSON.stringify([callerHash, rpcId, sessionHash, requestHash])));
  const id = await sha256(utf8(JSON.stringify([dedupeKey, requestHash]))), chunks = split(bodyBytes), d=db(env);
  const statements=[d.prepare(`INSERT INTO rc_jobs
    (id,dedupe_key,caller_hash,rpc_id_json,session_hash,request_hash,method,request_bytes,request_chunks,created_at,expires_at,tombstone_until,http_wait_until,status)
    SELECT ?,?,?,?,?,?,?,?,?,${DB_NOW},${DB_NOW}+?,${DB_NOW}+?,${DB_NOW}+15000,'queued'
    WHERE EXISTS(SELECT 1 FROM rc_devices WHERE id='mac' AND last_seen>${DB_NOW}-?)
    ON CONFLICT DO NOTHING`).bind(id,dedupeKey,callerHash,rpcId,sessionHash,requestHash,rpc.params?.name||rpc.method,bodyBytes.byteLength,chunks.length,JOB_TTL,TOMBSTONE_RETENTION,ONLINE_WINDOW)];
  for(let i=0;i<chunks.length;i++)statements.push(d.prepare("INSERT INTO rc_chunks(job_id,direction,sequence,chunk_hash,data_b64) SELECT id,'request',?,?,? FROM rc_jobs WHERE id=? AND request_hash=? AND status='queued' ON CONFLICT(job_id,direction,sequence) DO NOTHING").bind(i,await sha256(chunks[i]),b64(chunks[i]),id,requestHash));
  statements.push(d.prepare("UPDATE rc_jobs SET waiters=waiters+1 WHERE id=? AND consumed_at IS NULL AND status IN ('queued','claimed','done')").bind(id));
  statements.push(d.prepare(`UPDATE rc_devices SET warm_until=${DB_NOW}+COALESCE((SELECT json_extract(settings_json,'$.warmWindowMs') FROM rc_runtime WHERE id='mac'),300000) WHERE id='mac'`));
  statements.push(d.prepare(`SELECT *,${DB_NOW} AS db_now_ms FROM rc_jobs WHERE id=?`).bind(id));
  const inserted=await d.batch(statements),job=inserted.at(-1).results[0];
  timingMark(env,'enqueue_committed_ms');
  if(!job)return {offline:true};
  if(job.request_hash!==requestHash||job.dedupe_key!==dedupeKey)return {conflict:true};
  if(env.__rcTiming)env.__rcTiming.db_enqueue_ms=job.created_at;
  return {job,cached:job.status==='done',consumed:job.consumed_at!==null};
}
async function releaseResult(env,jobId){
 const d=db(env);const out=await d.batch([
  d.prepare(`UPDATE rc_jobs SET waiters=MAX(0,waiters-1),consumed_at=CASE WHEN waiters<=1 AND status='done' THEN ${DB_NOW} ELSE consumed_at END WHERE id=? AND consumed_at IS NULL RETURNING consumed_at`).bind(jobId),
  d.prepare("DELETE FROM rc_chunks WHERE job_id=? AND EXISTS(SELECT 1 FROM rc_jobs WHERE id=? AND (consumed_at IS NOT NULL OR status IN ('cancelled','unknown','expired')))").bind(jobId,jobId)
 ]);if(env.__rcTiming)env.__rcTiming.db_consume_ms=out[0].results?.[0]?.consumed_at;
}

async function requestChunks(env, job) {
  return (await db(env).prepare("SELECT sequence,chunk_hash,data_b64 FROM rc_chunks WHERE job_id=? AND direction='request' ORDER BY sequence").bind(job.id).all()).results || [];
}
async function responseBytes(env, job, prefetched) {
  const stored = prefetched ?? ((await db(env).prepare("SELECT direction,sequence,chunk_hash,data_b64 FROM rc_chunks WHERE job_id=? AND direction IN ('result','timing') ORDER BY direction,sequence").bind(job.id).all()).results || []);
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
async function waitForResult(request, env, jobId) {
  if (env.__rcTiming) env.__rcTiming.waiter_sleep_ms = ACTIVE_RESULT_POLL_MS;
  const until = Date.now() + RPC_WAIT;
  let waiterLeaseRefreshAt = Date.now() + 5_000;
  await markUnknownOnAbort(request, env, jobId);
  while (!request.signal.aborted && Date.now() < until) {
    const d = db(env);
    const [state, contents] = await d.batch([
      d.prepare("SELECT j.*,dev.last_seen AS device_last_seen,CAST(unixepoch('subsec')*1000 AS INTEGER) AS db_read_ms FROM rc_jobs j LEFT JOIN rc_devices dev ON dev.id='mac' WHERE j.id=?").bind(jobId),
      d.prepare("SELECT direction,sequence,chunk_hash,data_b64 FROM rc_chunks WHERE job_id=? AND direction IN ('result','timing') AND EXISTS(SELECT 1 FROM rc_jobs WHERE id=? AND status='done') ORDER BY direction,sequence").bind(jobId, jobId),
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
    if (['cancelled','unknown','expired'].includes(job.status)) return { kind: job.status };
    if (job.status === 'queued') {
      if (job.device_last_seen === null || Date.now() - job.device_last_seen > ONLINE_WINDOW) {
        await db(env).prepare("UPDATE rc_jobs SET status='unknown',completed_at=? WHERE id=? AND status='queued'").bind(Date.now(), jobId).run();
        return { kind: 'unknown' };
      }
    }
    if (Date.now() >= waiterLeaseRefreshAt) {
      const leaseNow = Date.now();
      await db(env).prepare("UPDATE rc_jobs SET http_wait_until=? WHERE id=? AND status IN ('queued','claimed')").bind(leaseNow + 15_000, jobId).run();
      waiterLeaseRefreshAt = leaseNow + 5_000;
    }
    await new Promise(resolve => setTimeout(resolve, ACTIVE_RESULT_POLL_MS));
  }
  await db(env).prepare("UPDATE rc_jobs SET status='unknown',completed_at=? WHERE id=? AND status IN ('queued','claimed')").bind(Date.now(), jobId).run();
  return { kind: request.signal.aborted ? 'unknown' : 'timeout' };
}
function toolErr(code) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code,...code==='MAC_OFFLINE'?{message:'这台 Mac 现在不在线，打开 ChatHand 后再试'}:{} }) }],structuredContent:{code,...code==='MAC_OFFLINE'?{message:'这台 Mac 现在不在线，打开 ChatHand 后再试'}:{}} };
}
function metadata(manifest) {
  if (!manifest?.initialize || !manifest?.serverDiscover || !manifest?.tools || !manifest?.resources || !manifest?.resourceContents) throw new TypeError('manifest must contain initialize, serverDiscover, tools, resources, resourceContents');
  return manifest;
}

export function validateSettings(input={}) {
 const result={...DEFAULT_SETTINGS};
 const ranges={hotMs:[25,1000],warmMs:[25,2000],coldMs:[100,10000],hotWindowMs:[1000,300000],warmWindowMs:[1000,3600000],rotateMs:[1000,120000],maxOperations:[20,1000]};
 for(const [key,value] of Object.entries(input)){if(!ranges[key]||!Number.isSafeInteger(value)||value<ranges[key][0]||value>ranges[key][1])throw Error('RUNTIME_SETTINGS_INVALID');result[key]=value;}
 if(result.hotMs>result.warmMs||result.warmMs>result.coldMs||result.hotWindowMs>result.warmWindowMs)throw Error('RUNTIME_SETTINGS_INVALID');
 return result;
}
export async function loadRuntime(env,bootstrap){
 const row=await db(env).prepare("SELECT manifest_json,settings_json,revision FROM rc_runtime WHERE id='mac'").first();
 if(!row)return {manifest:bootstrap,settings:{...DEFAULT_SETTINGS},configured:false,revision:null};
 return {manifest:metadata(JSON.parse(row.manifest_json)),settings:validateSettings(JSON.parse(row.settings_json)),configured:true,revision:row.revision};
}
async function registerRuntime(request,env){
 if(!paired(request,env))return json({error:'PAIRING_UNAUTHORIZED'},401);
 if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 let body;try{const bytes=await readBody(request);if(bytes.length>1024*1024)return json({error:'MANIFEST_TOO_LARGE'},413);body=JSON.parse(dec.decode(bytes));}catch{return json({error:'INVALID_JSON'},400);}
 let manifest,settings;try{manifest=metadata(body.manifest);settings=validateSettings(body.settings);const tools=manifest.tools.tools,resources=manifest.resources.resources;
 if(!Array.isArray(tools)||tools.length>500||!Array.isArray(resources)||resources.length>100||new Set(tools.map(t=>t.name)).size!==tools.length||tools.some(t=>typeof t.name!=='string'||!t.inputSchema||t.inputSchema.type!=='object'))throw Error('RUNTIME_MANIFEST_INVALID');
 }catch{return json({error:'RUNTIME_CONFIGURATION_INVALID'},400);}
 const serialized=JSON.stringify(manifest),configuration=JSON.stringify(settings),revision=await sha256(utf8(serialized+'\n'+configuration));
 await db(env).prepare(`INSERT INTO rc_runtime(id,manifest_json,settings_json,revision,updated_at) VALUES('mac',?,?,?,${DB_NOW}) ON CONFLICT(id) DO UPDATE SET manifest_json=excluded.manifest_json,settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`).bind(serialized,configuration,revision).run();
 return json({accepted:true,template_version:TEMPLATE_VERSION,revision,tool_count:manifest.tools.tools.length,resource_count:manifest.resources.resources.length,settings});
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
    return result ?? null;
  }
  return undefined;
}
function modernEnvelope(rpc, result, manifest) {
  if (rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') return result;
  return {
    ...result,
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': manifest.initialize.serverInfo },
  };
}
function backgroundClean(env, ctx) {
  if (!ctx?.waitUntil) return clean(env);
  const work = Promise.resolve().then(() => clean(env)).catch(() => { if (env.__rcTiming) env.__rcTiming.background_cleanup_errors = (env.__rcTiming.background_cleanup_errors || 0) + 1; });
  ctx.waitUntil(work);
  return Promise.resolve();
}
async function mcp(request, env, manifest, verifiedCaller, ctx) {
  const caller = verifiedCaller ?? trustedCaller(request, env);
  if (!caller) return json({ error: 'OWNER_AUTHENTICATION_REQUIRED' }, 401);
  let bytes;
  try { bytes = await readBody(request); }
  catch (e) { return json({ error: e.message === 'BODY_TOO_LARGE' ? 'MESSAGE_TOO_LARGE' : 'INVALID_BODY' }, e.message === 'BODY_TOO_LARGE' ? 413 : 400); }
  let rpc;
  try { rpc = JSON.parse(dec.decode(bytes)); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return json({ error: 'INVALID_JSONRPC' }, 400);
  console.log(JSON.stringify({event:'mcp_received',method:rpc.method.slice(0,80),at_ms:Date.now(),version:PRODUCT_VERSION}));
  if(['initialize','tools/list','resources/list','ping'].includes(rpc.method)) await db(env).prepare(`UPDATE rc_devices SET warm_until=${DB_NOW}+COALESCE((SELECT json_extract(settings_json,'$.warmWindowMs') FROM rc_runtime WHERE id='mac'),300000) WHERE id='mac'`).run();
  if (rpc.method === 'notifications/cancelled') {
    const id = rpc.params?.requestId;
    if (id === undefined) return new Response(null, { status: 202 });
    const session = await sha256(utf8(JSON.stringify(sessionFor(request))));
    const callerHash = await sha256(utf8(caller));
    const rpcId = JSON.stringify([typeof id, id]);
    await db(env).prepare("UPDATE rc_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,cancel_requested=CASE WHEN status='claimed' THEN 1 ELSE cancel_requested END,completed_at=CASE WHEN status='queued' THEN ? ELSE completed_at END WHERE id=(SELECT id FROM rc_jobs WHERE caller_hash=? AND rpc_id_json=? AND session_hash=? AND status IN ('queued','claimed') ORDER BY created_at LIMIT 1)").bind(Date.now(), callerHash, rpcId, session).run();
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
    return json(rpcReply(id, toolErr(state.kind === 'cancelled' ? 'CANCELLED' : state.kind==='consumed'?'RESULT_ALREADY_DELIVERED':'RESULT_UNKNOWN')));
    } finally { await deferRelease(env,ctx,created.job.id); }
  }
  const runtime=await loadRuntime(env,manifest);
  const result = staticResult(runtime.manifest, rpc.method, rpc.params || {});
  if (result !== undefined) return json(rpcReply(id, modernEnvelope(rpc, result, runtime.manifest)));
  return json(rpcError(id, -32601, 'Method not found'));
}

async function relay(request, env, path) {
  if (!paired(request, env)) return json({ error: 'PAIRING_UNAUTHORIZED' }, 401);
  if (path === '/relay/manifest' && request.method === 'GET') return json({ template_version:TEMPLATE_VERSION,compatible_client_versions:['4.1','4.0'],supports_runtime:true,version: VERSION, chunk_bytes: MAX_CHUNK, message_bytes: MAX_MESSAGE, poll_ms: POLL_WAIT, online_window_ms: ONLINE_WINDOW });
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  let body;
  if (path !== '/relay/disconnect') {
    if (path === '/relay/poll' && !request.body) body = {};
    else {
    try { body = JSON.parse(dec.decode(await readBody(request))); }
    catch (e) { return json({ error: e.message === 'BODY_TOO_LARGE' ? 'MESSAGE_TOO_LARGE' : 'INVALID_JSON' }, e.message === 'BODY_TOO_LARGE' ? 413 : 400); }
    }
  }
  const d = db(env);
  const now = Date.now();
  const pollHeartbeat = path === '/relay/poll' ? [d.prepare("INSERT INTO rc_devices(id,last_seen,generation) VALUES('mac',CAST(unixepoch('subsec')*1000 AS INTEGER),'generic-rpc-v4') ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,generation=excluded.generation").bind(now)] : [];
  await clean(env, now, pollHeartbeat);
  if (path === '/relay/poll') {
    const hotUntil = hotPollDeadline(body, env.__rcTiming?.mono_start_ms ?? performance.now());
    if (env.__rcTiming) env.__rcTiming.hot_window_ms = hotUntil ? Math.min(body.hot_window_ms, HOT_WINDOW_MAX) : 0;
    const end = now + POLL_WAIT;
    let heartbeatAt = now;
    if (body?.claim === false) {
      const cancellations = (await d.prepare("SELECT id,claim_id,rpc_id_json FROM rc_jobs WHERE status='claimed' AND cancel_requested=1").all()).results || [];
      return json({ job: null, cancellations });
    }
    while (Date.now() < end && !request.signal.aborted) {
      const stamp = Date.now();
      const heartbeatDue = stamp - heartbeatAt >= 10_000;
      const claimId = crypto.randomUUID();
      const statements = [];
      if (heartbeatDue) statements.push(d.prepare("UPDATE rc_devices SET last_seen=?,generation='generic-rpc-v1' WHERE id='mac'").bind(stamp));
      const claimIndex = statements.length;
      statements.push(
        d.prepare(`UPDATE rc_jobs SET status='claimed',claim_id=?,claimed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=(SELECT id FROM rc_jobs WHERE status='queued' AND expires_at>? ORDER BY created_at LIMIT 1) AND status='queued' RETURNING id,method,rpc_id_json,request_hash,request_bytes,request_chunks,expires_at,cancel_requested`).bind(claimId, stamp),
        d.prepare("SELECT id,claim_id,rpc_id_json FROM rc_jobs WHERE status='claimed' AND cancel_requested=1"),
        d.prepare("SELECT c.chunk_hash,c.data_b64 FROM rc_chunks c JOIN rc_jobs j ON j.id=c.job_id WHERE j.claim_id=? AND j.status='claimed' AND j.request_bytes<=? AND j.request_chunks=1 AND c.direction='request' AND c.sequence=0").bind(claimId, MAX_CHUNK),
      );
      const claimed = await d.batch(statements);
      if (heartbeatDue) heartbeatAt = stamp;
      const job = claimed[claimIndex].results[0];
      const cancellations = claimed[claimIndex + 1].results || [];
      if (job) timingMark(env, 'claim_confirmed_ms');
      if (job) {
        if (env.__rcTiming) env.__rcTiming.job_id = job.id;
        const reply = { job_id: job.id, claim_id: claimId, method: job.method, rpc_id: JSON.parse(job.rpc_id_json)[1], request_hash: job.request_hash, request_bytes: job.request_bytes, request_chunks: job.request_chunks, expires_at: job.expires_at, cancel_requested: !!job.cancel_requested, cancellations };
        if (job.request_bytes <= MAX_CHUNK && job.request_chunks === 1) {
          const chunk = claimed[claimIndex + 2].results[0];
          if (chunk) {
            const bytes = unb64(chunk.data_b64);
            if (bytes.byteLength === job.request_bytes && bytes.byteLength <= MAX_CHUNK && await sha256(bytes) === chunk.chunk_hash && chunk.chunk_hash === job.request_hash) {
              reply.request_inline = { data: chunk.data_b64, sha256: chunk.chunk_hash };
            }
          }
        }
        return json(reply);
      }
      if (cancellations.length) return json({ job: null, cancellations });
      const sleep = pollingSleep(hotUntil);
      if (env.__rcTiming) env.__rcTiming.poll_sleep_ms = sleep;
      await new Promise(resolve => setTimeout(resolve, sleep));
    }
    return json({ job: null, cancellations: [] });
  }
  if (path === '/relay/chunk') {
    if (body.action === 'get') {
      const job = await d.prepare("SELECT status,claim_id,request_chunks,request_bytes,request_hash FROM rc_jobs WHERE id=?").bind(body.job_id).first();
      if (!job || job.status !== 'claimed' || job.claim_id !== body.claim_id) return json({ error: 'JOB_NOT_CLAIMED' }, 409);
      const sequence = Number(body.sequence);
      if (!Number.isInteger(sequence) || sequence < 0 || sequence >= job.request_chunks) return json({ error: 'CHUNK_SEQUENCE_INVALID' }, 400);
      const chunk = await d.prepare("SELECT sequence,chunk_hash,data_b64 FROM rc_chunks WHERE job_id=? AND direction='request' AND sequence=?").bind(body.job_id, sequence).first();
      if (!chunk || await sha256(unb64(chunk.data_b64)) !== chunk.chunk_hash) return json({ error: 'REQUEST_CHUNK_INVALID' }, 409);
      return json({ sequence: chunk.sequence, total_chunks: job.request_chunks, request_bytes: job.request_bytes, request_hash: job.request_hash, sha256: chunk.chunk_hash, data: chunk.data_b64 });
    }
    if (body.action === 'put') {
      if (typeof body.job_id !== 'string' || typeof body.claim_id !== 'string' || body.direction !== 'result' || typeof body.data !== 'string') return json({ error: 'INVALID_CHUNK' }, 400);
      let bytes;
      try { bytes = unb64(body.data); } catch { return json({ error: 'INVALID_CHUNK' }, 400); }
      if (bytes.byteLength > MAX_CHUNK || typeof body.sha256 !== 'string' || await sha256(bytes) !== body.sha256) return json({ error: 'CHUNK_INTEGRITY_ERROR' }, 400);
      const job = await d.prepare("SELECT status,claim_id FROM rc_jobs WHERE id=?").bind(body.job_id).first();
      if (!job || job.status !== 'claimed' || job.claim_id !== body.claim_id) return json({ error: 'JOB_NOT_CLAIMED' }, 409);
      const seq = Number(body.sequence);
      if (!Number.isInteger(seq) || seq < 0 || seq >= 48) return json({ error: 'CHUNK_SEQUENCE_INVALID' }, 400);
      try { await d.prepare("INSERT INTO rc_chunks(job_id,direction,sequence,chunk_hash,data_b64) VALUES(?,'result',?,?,?)").bind(body.job_id, seq, body.sha256, body.data).run(); }
      catch {
        const old = await d.prepare("SELECT chunk_hash,data_b64 FROM rc_chunks WHERE job_id=? AND direction='result' AND sequence=?").bind(body.job_id, seq).first();
        if (!old || old.chunk_hash !== body.sha256 || old.data_b64 !== body.data) return json({ error: 'CHUNK_CONFLICT' }, 409);
      }
      return json({ accepted: true, sequence: seq });
    }
    return json({ error: 'INVALID_ACTION' }, 400);
  }
  if (path === '/relay/result') {
    if (typeof body?.job_id !== 'string' || typeof body?.claim_id !== 'string' || typeof body?.sha256 !== 'string') return json({ error: 'INVALID_RESULT' }, 400);
    const count = Number(body.total_chunks), size = Number(body.total_bytes);
    if (!Number.isInteger(count) || count < 1 || count > 48 || !Number.isInteger(size) || size < 1 || size > MAX_MESSAGE) return json({ error: 'RESULT_SIZE_INVALID' }, 413);
    let inlineBytes;
    if (body.inline_chunk !== undefined) {
      if (count !== 1 || size > MAX_CHUNK) return json({ error: 'INLINE_RESULT_NOT_SINGLE_CHUNK' }, 413);
      if (!body.inline_chunk || typeof body.inline_chunk.data !== 'string' || typeof body.inline_chunk.sha256 !== 'string') return json({ error: 'INVALID_INLINE_CHUNK' }, 400);
      try { inlineBytes = unb64(body.inline_chunk.data); } catch { return json({ error: 'INVALID_INLINE_CHUNK' }, 400); }
      if (inlineBytes.byteLength > MAX_CHUNK || inlineBytes.byteLength !== size) return json({ error: 'INLINE_RESULT_SIZE_INVALID' }, 413);
      const inlineHash = await sha256(inlineBytes);
      if (b64(inlineBytes) !== body.inline_chunk.data || inlineHash !== body.inline_chunk.sha256 || inlineHash !== body.sha256) return json({ error: 'RESULT_INTEGRITY_ERROR' }, 409);
    }
    const validationStatements = [d.prepare("SELECT rpc_id_json,claim_id,status,response_hash,response_bytes,response_chunks FROM rc_jobs WHERE id=?").bind(body.job_id)];
    if (body.inline_chunk !== undefined) validationStatements.push(d.prepare("INSERT INTO rc_chunks(job_id,direction,sequence,chunk_hash,data_b64) SELECT id,'result',0,?,? FROM rc_jobs WHERE id=? AND status='claimed' AND claim_id=? ON CONFLICT(job_id,direction,sequence) DO NOTHING").bind(body.inline_chunk.sha256, body.inline_chunk.data, body.job_id, body.claim_id));
    validationStatements.push(d.prepare("SELECT sequence,chunk_hash,data_b64 FROM rc_chunks WHERE job_id=? AND direction='result' ORDER BY sequence").bind(body.job_id));
    const validation = await d.batch(validationStatements);
    const claimed = validation[0].results[0];
    if (claimed?.status === 'done') {
      if (claimed.claim_id === body.claim_id && claimed.response_hash === body.sha256 && claimed.response_bytes === size && claimed.response_chunks === count) return json({ accepted: true, replayed: true });
      return json({ error: 'RESULT_CONFLICT' }, 409);
    }
    if (!claimed || claimed.status !== 'claimed' || claimed.claim_id !== body.claim_id) return json({ error: 'JOB_NOT_CLAIMED' }, 409);
    const rows = validation[validation.length - 1].results || [];
    if (body.inline_chunk !== undefined) {
      const stored = rows.find(row => row.sequence === 0);
      if (!stored || stored.chunk_hash !== body.inline_chunk.sha256 || stored.data_b64 !== body.inline_chunk.data) return json({ error: 'CHUNK_CONFLICT' }, 409);
    }
    if (rows.length !== count || rows.some((r, i) => r.sequence !== i)) return json({ error: 'RESULT_CHUNKS_INCOMPLETE' }, 409);
    const parts = rows.map(r => unb64(r.data_b64));
    if (parts.some(part => part.length > MAX_CHUNK)) return json({ error: 'RESULT_CHUNK_TOO_LARGE' }, 413);
    const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) { result.set(part, at); at += part.length; }
    if (result.length !== size || await sha256(result) !== body.sha256) return json({ error: 'RESULT_INTEGRITY_ERROR' }, 409);
    let rpc;
    try { rpc = JSON.parse(dec.decode(result)); } catch { return json({ error: 'RESULT_NOT_JSONRPC' }, 400); }
    if (rpc?.jsonrpc !== '2.0' || !('result' in rpc || 'error' in rpc)) return json({ error: 'RESULT_NOT_JSONRPC' }, 400);
    if (JSON.stringify([typeof rpc.id, rpc.id]) !== claimed.rpc_id_json) return json({ error: 'RPC_ID_MISMATCH' }, 409);
    const update = d.prepare("UPDATE rc_jobs SET status='done',response_hash=?,response_bytes=?,response_chunks=?,completed_at=? WHERE id=? AND claim_id=? AND status='claimed' AND expires_at>?").bind(body.sha256, size, count, now, body.job_id, body.claim_id, now);
    let updated;
    const transport = numericTransport(body.transport_timing || {});
    // Predict acceptance using the identical job guard before the done UPDATE.
    // Both run in the same transaction: failed acceptance cannot refresh the device.
    const heartbeat = d.prepare("UPDATE rc_devices SET last_seen=? WHERE id='mac' AND EXISTS(SELECT 1 FROM rc_jobs WHERE id=? AND claim_id=? AND status='claimed' AND expires_at>?)").bind(now, body.job_id, body.claim_id, now);
    if (env.__rcTiming) {
      const trace = env.__rcTiming;
      trace.job_id = body.job_id;
      transport.result = { result_received_ms: trace.wall_start_ms, accept_write_started_ms: timingPoint(trace), accepted_exact: 0, db: numericDb(trace.db), db_summary: { ...trace.db_summary } };
      const accepted = await d.batch([heartbeat, update, await timingStatement(env, body.job_id, transport)]);
      updated = accepted[1];
      trace.timing_row_sql_ms = accepted[2]?.meta?.timings?.sql_duration_ms ?? accepted[2]?.meta?.duration ?? null;
    } else { const accepted = await d.batch([heartbeat, update]); updated = accepted[1]; }
    if (!updated.meta?.changes && updated.changes !== 1) return json({ error: 'RESULT_EXPIRED_OR_ALREADY_SUBMITTED' }, 409);
    timingMark(env, 'result_accepted_ms');
    return json({ accepted: true });
  }
  if (path === '/relay/cancel') {
    if (typeof body?.job_id !== 'string') return json({ error: 'INVALID_CANCEL' }, 400);
    const updated = await d.prepare("UPDATE rc_jobs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,cancel_requested=CASE WHEN status='claimed' THEN 1 ELSE cancel_requested END,completed_at=CASE WHEN status='queued' THEN ? ELSE completed_at END WHERE id=? AND status IN ('queued','claimed')").bind(now, body.job_id).run();
    return json({ accepted: !!(updated.meta?.changes || updated.changes) });
  }
  if (path === '/relay/disconnect') {
    await d.prepare("UPDATE rc_devices SET last_seen=0 WHERE id='mac'").run();
    return json({ offline: true });
  }
  return json({ error: 'NOT_FOUND' }, 404);
}
async function claimJob(local,d,trace){
      const stamp = Date.now(), claimId = crypto.randomUUID(), started = performance.now();
      const claimed = await d.prepare(`UPDATE rc_jobs SET status='claimed',claim_id=?,claimed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=(SELECT id FROM rc_jobs WHERE status='queued' AND cancel_requested=0 AND expires_at>? ORDER BY created_at LIMIT 1) AND status='queued' AND cancel_requested=0 AND expires_at>? RETURNING *, (SELECT data_b64 FROM rc_chunks WHERE job_id=rc_jobs.id AND direction='request' AND sequence=0 AND rc_jobs.request_chunks=1) AS inline_data, (SELECT chunk_hash FROM rc_chunks WHERE job_id=rc_jobs.id AND direction='request' AND sequence=0 AND rc_jobs.request_chunks=1) AS inline_hash`).bind(claimId, stamp, stamp).all();
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
export function createWsHooks(env, ctx) {
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
    heartbeat: () => step('heartbeat', async (local,d) => { await d.prepare("INSERT INTO rc_devices(id,last_seen,generation) VALUES('mac',CAST(unixepoch('subsec')*1000 AS INTEGER),'generic-rpc-v4') ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,generation=excluded.generation").run(); }),
    cleanup: () => step('cleanup', local=>clean(local)).catch(error=>{connection.cleanup_errors++;throw error;}),
    preheat:()=>step('preheat',async(local,d)=>d.prepare(`UPDATE rc_devices SET warm_until=${DB_NOW}+COALESCE((SELECT json_extract(settings_json,'$.warmWindowMs') FROM rc_runtime WHERE id='mac'),300000) WHERE id='mac'`).run()),
    poll:()=>step('poll',async(local,d)=>{const result=(await d.prepare(`SELECT warm_until,MAX(0,warm_until-${DB_NOW}) AS warm_remaining_ms,(SELECT id FROM rc_jobs WHERE status='queued' AND cancel_requested=0 AND expires_at>${DB_NOW} ORDER BY created_at LIMIT 1) AS job_id,(SELECT settings_json FROM rc_runtime WHERE id='mac') AS settings_json FROM rc_devices WHERE id='mac'`).first())||{warm_remaining_ms:0,job_id:null};if(result.settings_json)result.settings=validateSettings(JSON.parse(result.settings_json));return result;}),
    claim: () => step('claim',claimJob),
    claimWarm: () => step('claimWarm',async(local,d,trace)=>{
      const config=d.prepare(`SELECT warm_until,MAX(0,warm_until-${DB_NOW}) AS warm_remaining_ms,(SELECT settings_json FROM rc_runtime WHERE id='mac') AS settings_json FROM rc_devices WHERE id='mac'`);
      let prefetched;
      // D1 bind returns a new statement; retain it for the atomic warm batch.
      const proxy={...d,prepare:sql=>{let q=d.prepare(sql);if(!sql.startsWith('UPDATE rc_jobs SET status=\'claimed\''))return q;return {bind(...args){q=q.bind(...args);return this;},async all(){const rows=await d.batch([q,config]);prefetched=rows[1].results?.[0];return rows[0];}};}};
      const result=await claimJob(local,proxy,trace);
      return {...result,warm_remaining_ms:prefetched?.warm_remaining_ms??0,settings:prefetched?.settings_json?validateSettings(JSON.parse(prefetched.settings_json)):undefined};
    }),
    cancellations: jobs => step('cancellations', async (local,d) => {
      if(!jobs.length)return [];
      return (await d.prepare(`SELECT id,claim_id FROM rc_jobs WHERE status='claimed' AND cancel_requested=1 AND id IN (${jobs.map(()=>'?').join(',')})`).bind(...jobs.map(job=>job.id)).all()).results || [];
    }),
    authorizeStart: job => step('start', async (local,d) => {
      const result=await d.prepare("UPDATE rc_jobs SET claim_id=claim_id WHERE id=? AND claim_id=? AND request_hash=? AND rpc_id_json=? AND status='claimed' AND cancel_requested=0 AND expires_at>? RETURNING id").bind(job.id,job.claim_id,job.request_hash,job.rpc_id_json,Date.now()).all();
      return result.results?.length===1;
    }),
    unknown: job => step('unknown', async (local,d) => { await d.prepare("UPDATE rc_jobs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'unknown' END,completed_at=? WHERE id=? AND claim_id=? AND status='claimed'").bind(Date.now(),job.id,job.claim_id).run(); }),
    restore: entry => step('restore', async (local,d) => {
      const job=await d.prepare('SELECT id,rpc_id_json,claim_id,status,request_hash,request_bytes,request_chunks,expires_at,cancel_requested,response_hash,response_bytes,response_chunks FROM rc_jobs WHERE id=? AND claim_id=?').bind(entry.job_id,entry.claim_id).first();
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
      const statements=assembly.parts.map(part=>d.prepare("INSERT INTO rc_chunks(job_id,direction,sequence,chunk_hash,data_b64) SELECT id,'result',?,?,? FROM rc_jobs WHERE id=? AND claim_id=? AND status='claimed' AND expires_at>? AND cancel_requested=? ON CONFLICT(job_id,direction,sequence) DO NOTHING").bind(part.sequence,part.chunk_hash,part.data_b64,job.id,job.claim_id,now,cancellationValue));
      if(assembly.parts.some((part,i)=>part.sequence!==i||!/^[0-9a-f]{64}$/.test(part.chunk_hash)))throw Error('RESULT_CHUNK_INVALID');
      // Literal sequence/hash come only from verified integers/SHA256; bound data stays below D1's 100-parameter limit even at 48 chunks.
      const mismatch=assembly.parts.map(part=>`(sequence=${part.sequence} AND (chunk_hash<>'${part.chunk_hash}' OR data_b64<>?))`).join(' OR ');
      const mismatchArgs=assembly.parts.map(part=>part.data_b64);
      const updateIndex=statements.length;
      statements.push(d.prepare(`UPDATE rc_jobs SET status='done',response_hash=?,response_bytes=?,response_chunks=?,completed_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=? AND claim_id=? AND request_hash=? AND rpc_id_json=? AND status='claimed' AND expires_at>? AND cancel_requested=? AND (SELECT COUNT(*) FROM rc_chunks WHERE job_id=? AND direction='result')=? AND NOT EXISTS(SELECT 1 FROM rc_chunks WHERE job_id=? AND direction='result' AND (${mismatch}))`).bind(assembly.sha256,assembly.total_bytes,assembly.total_chunks,job.id,job.claim_id,job.request_hash,job.rpc_id_json,now,cancellationValue,job.id,assembly.total_chunks,job.id,...mismatchArgs));
      const transport=numericTransport(diagnostic.transport_timing || {});transport.poll={server:job.claim_timing || {}};transport.result=resultClock;
      statements.push(await timingStatement(local,job.id,transport));
      const committed=await d.batch(statements),updated=committed[updateIndex];
      if(!updated.meta?.changes&&updated.changes!==1)return {accepted:false,error:'RESULT_GUARD_REJECTED'};
      trace.result_accepted_ms=timingPoint(trace);trace.accepted_exact=1;return {accepted:true};
    }),
  };
}
async function websocketRelay(request,env,ctx){
  if(!paired(request,env))return json({error:'PAIRING_UNAUTHORIZED'},401);
  if(request.method!=='GET')return json({error:'METHOD_NOT_ALLOWED'},405);
  if(request.headers.get('x-rc-ws-probe')!=='route-compare-20261003')return json({error:'EXPERIMENT_REQUEST_REQUIRED'},403);
  if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return json({error:'WEBSOCKET_UPGRADE_REQUIRED'},426);
  if(typeof WebSocketPair!=='function')return json({error:'WEBSOCKET_RUNTIME_UNAVAILABLE'},501);
  const [client,server]=Object.values(new WebSocketPair());server.accept();
  const runtime=await loadRuntime(env,env.__manifest);
  const hooks=createWsHooks(env,ctx);hooks.toolPolicy=name=>{const t=runtime.manifest.tools.tools.find(t=>t.name===name);return {known:!!t,readonly:t?.annotations?.readOnlyHint===true,destructive:t?.annotations?.destructiveHint===true};};hooks.onMetrics=metrics=>{try{server.send(JSON.stringify({v:1,type:'metrics',metrics,db_connection:hooks.connectionMetrics()}));}catch{}};
  const session=createRelaySession(server,hooks,{...runtime.settings,templateVersion:TEMPLATE_VERSION,runtimeConfigured:runtime.configured});
  ctx?.waitUntil?.(session.completion);
  return new Response(null,{status:101,webSocket:client});
}
export function createRelayWorker(inputManifest) {
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
      if (url.pathname.startsWith('/relay/')) return await relay(request, env, url.pathname);
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
        return await mcp(request, env, manifest, undefined, ctx);
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch {
      return json({ error: 'RELAY_STORAGE_UNAVAILABLE' }, 503);
    }
    };
    return timingHeader(await dispatch(), trace);
  } };
}
export default { fetch() { return json({ error: 'MANIFEST_REQUIRED' }, 503); } };
