/** Local UI SSE. Authentication stays in server.mjs, before accept(req, res).
 * state is the unmodified /api/state JSON; patch is a shallow merge of its
 * changed top-level fields (no new wrapper objects for the existing UI).
 * Sampling is shared, starts with the first client, and stops with the last.
 */
export const EVENT_TIMING = Object.freeze({ mergeMs: 150, jobIntervalMs: 250, pingMs: 25_000, pollMs: 5_000 });
export const VALUE_INTERVAL_MS = 1000;

// Exact paths only: never strip arbitrary *_at, time, expires_at or job cursors.
// consecutive_failures is probe-frequency noise; control_plane.state still
// reports the checking -> down transition and down_since remains meaningful.
export const VOLATILE_STATE_PATHS = Object.freeze([
  'connection.control_plane.checked_at',
  'connection.control_plane.last_success_at',
  'connection.control_plane.consecutive_failures',
  'relay.last_heartbeat',
  'automation.browser.last_seen',
  'automation.browser.extension.last_seen',
  'settings.extension_last_seen',
  'update.checked_at',
  'output_retention_status.checked_at',
  'setup.open_items.*.detail.last_seen',
]);

export const STATE_FIELD_GROUPS = Object.freeze(Object.fromEntries(Object.entries({
  connection: ['tools_list_status', 'connection', 'relay', 'credentials', 'readiness', 'connection_check', 'tunnel_binary_hint'],
  jobs: ['jobs', 'confirmations', 'tasks', 'task_stalls', 'events', 'approvals', 'inputs', 'activity', 'history', 'last_calls', 'call_trace', 'keep_awake', 'value', 'output_retention_status'],
  capabilities: ['capabilities', 'permissions', 'automation', 'terminal', 'high_risk', 'high_risk_catalog', 'blocks', 'enabled', 'mode', 'full_armed', 'interface_protected', 'not_os_sandbox'],
  settings: ['settings', 'project', 'lifecycle', 'ui'],
  update: ['update', 'upgrade_pending', 'upgrade_guard', 'release'],
  support: ['support', 'repair', 'about'],
  setup: ['setup', 'setup_test', 'setup_skill', 'onboarding', 'manifest', 'version', 'runtime_api', 'instance_id', 'node', 'platform'],
}).map(([name, fields]) => [name, Object.freeze(fields)])));
const fieldGroups = new Map(Object.entries(STATE_FIELD_GROUPS).flatMap(([group, fields]) => fields.map(field => [field, group])));
const volatilePaths = new Set(VOLATILE_STATE_PATHS);
// These timestamps remain exact on the wire; only their comparison is coarse.
const confirmationPaths = new Set(['connection.control_plane.last_success_at', 'connection.display.last_confirmed_at']);
const groupOf = field => fieldGroups.get(field) || 'settings'; // Future fields must not silently disappear.
// Value belongs to the jobs data group, with its own 1Hz clock; it never slows job output's 4Hz clock.
const timingGroup = field => field === 'value' ? 'value' : groupOf(field);

function comparable(value, path) {
  if (confirmationPaths.has(path) && typeof value === 'number' && Number.isFinite(value)) return Math.floor(value / 30_000);
  if (Array.isArray(value)) return value.map(item => comparable(item, `${path}.*`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
    const child = path ? `${path}.${key}` : key;
    return volatilePaths.has(child) && !confirmationPaths.has(child) ? [] : [[key, comparable(value[key], child)]];
  }));
  return value;
}

/** Comparison only; original values, including timestamps, stay on the wire. */
export function stateFingerprints(state) {
  return new Map(Object.keys(state).map(field => [field, JSON.stringify(comparable(state[field], field))]).filter(([, value]) => value !== undefined));
}

/** A removed top-level field is represented by null for a shallow UI merge. */
export function diffState(previous, next) {
  const before = stateFingerprints(previous), after = stateFingerprints(next);
  return Object.fromEntries([...new Set([...before.keys(), ...after.keys()])]
    .filter(field => before.get(field) !== after.get(field))
    .map(field => [field, Object.hasOwn(next, field) ? next[field] : null]));
}

const realClock = { now: () => performance.now(), setTimeout, clearTimeout, setInterval, clearInterval };

/**
 * createStateEvents({snapshot, ...timing}) -> {accept, publish, refresh, close, status}
 * - await accept(req,res): fresh state first, then patches/pings; false if closed.
 * - publish(snapshotJSON): optional immediate notification from existing hooks.
 * - await refresh(): serialize/coalesce source reads; optional AbortSignal is
 *   passed as snapshot({signal}). pollMs:0 disables automatic source sampling.
 *   Periodic sources must be memory-only; server uses createCachedStateSource
 *   rather than passing its HTTP /api/state snapshot/health probes here.
 * - close(): synchronous, idempotent; call before the HTTP servers are closed.
 * No filesystem, process, credentials, network, or application access here.
 */
export function createStateEvents({ snapshot, clock = realClock, onError = () => {},
  onActive = () => {}, onIdle = () => {},
  mergeMs = EVENT_TIMING.mergeMs, jobIntervalMs = EVENT_TIMING.jobIntervalMs,
  valueIntervalMs = VALUE_INTERVAL_MS,
  pingMs = EVENT_TIMING.pingMs, pollMs = EVENT_TIMING.pollMs,
  maxBufferedBytes = 4 * 1024 * 1024,
} = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('snapshot must be a function');
  for (const [name, value] of Object.entries({ mergeMs, jobIntervalMs, valueIntervalMs, pingMs, pollMs, maxBufferedBytes })) {
    if (!Number.isFinite(value) || value < 0 || (['pingMs', 'maxBufferedBytes'].includes(name) && value === 0)) throw new TypeError(`Invalid ${name}`);
  }
  const clients = new Set();
  let latest = null, fingerprints = new Map(), pollTimer = null, pingTimer = null, reading = null, closed = false, epoch = 0;
  const unref = timer => { timer?.unref?.(); return timer; };
  const report = error => { try { onError(error); } catch { /* Reporting must not affect cleanup. */ } };

  function stopIdle() {
    if (clients.size) return;
    epoch++;
    if (pollTimer !== null) clock.clearTimeout(pollTimer);
    if (pingTimer !== null) clock.clearInterval(pingTimer);
    pollTimer = pingTimer = null;
    const old = reading;
    reading = null; // Late source results must not publish or recreate timers.
    old?.controller.abort();
    latest = null;
    fingerprints = new Map();
    onIdle();
  }

  function disconnect(client, end = true) {
    if (!clients.delete(client)) return;
    if (client.timer !== null) clock.clearTimeout(client.timer);
    client.timer = null;
    client.pending.clear();
    client.req.off('aborted', client.onClose);
    for (const event of ['close', 'finish', 'error']) client.res.off(event, client.onClose);
    client.res.off('drain', client.onDrain);
    client.cancel();
    if (end && !client.res.destroyed && !client.res.writableEnded) {
      try { client.res.end(); } catch { /* Already gone. */ }
    }
    stopIdle();
  }

  function write(client, event, data) {
    if (!clients.has(client) || client.res.destroyed || client.res.writableEnded) { disconnect(client); return false; }
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if ((client.res.writableLength || 0) + Buffer.byteLength(frame) > maxBufferedBytes) { disconnect(client); return false; }
    try {
      client.blocked = client.res.write(frame) === false;
      return true;
    } catch { disconnect(client); return false; }
  }

  function changedFields(client) {
    return [...new Set([...client.sent.keys(), ...fingerprints.keys()])]
      .filter(field => client.sent.get(field) !== fingerprints.get(field));
  }

  function schedule(client) {
    if (client.timer !== null) clock.clearTimeout(client.timer);
    client.timer = null;
    if (!client.ready || !clients.has(client)) return;
    const groups = new Set(changedFields(client).map(timingGroup)), now = clock.now();
    for (const group of client.pending.keys()) if (!groups.has(group)) client.pending.delete(group);
    for (const group of groups) if (!client.pending.has(group)) client.pending.set(group, now + mergeMs);
    if (client.blocked || !client.pending.size) return;
    const due = Math.min(...[...client.pending].map(([group, time]) => Math.max(time, group === 'jobs' ? client.lastJobs + jobIntervalMs : group === 'value' ? client.lastValue + valueIntervalMs : -Infinity)));
    client.timer = unref(clock.setTimeout(() => { client.timer = null; flush(client); }, Math.max(0, due - now)));
  }

  function flush(client) {
    if (!clients.has(client) || client.blocked) return;
    const now = clock.now(), due = new Set([...client.pending]
      .filter(([group, time]) => now >= time && (group !== 'jobs' || now >= client.lastJobs + jobIntervalMs) && (group !== 'value' || now >= client.lastValue + valueIntervalMs)).map(([group]) => group));
    const fields = changedFields(client).filter(field => due.has(timingGroup(field)));
    const patch = Object.fromEntries(fields.map(field => [field, Object.hasOwn(latest, field) ? latest[field] : null]));
    if (fields.length && !write(client, 'patch', patch)) return;
    for (const field of fields) {
      if (fingerprints.has(field)) client.sent.set(field, fingerprints.get(field));
      else client.sent.delete(field);
    }
    if (fields.some(field => timingGroup(field) === 'jobs')) client.lastJobs = now;
    if (fields.includes('value')) client.lastValue = now;
    for (const group of due) client.pending.delete(group);
    schedule(client);
  }

  function publish(state, { fresh = false } = {}) {
    if (closed || !clients.size) return false;
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('snapshot must return a JSON object');
    const next = stateFingerprints(state), value = {};
    // Compare blocks first. Detach only changed blocks, so a mutable source can
    // never alter a queued patch. A new subscriber gets all raw timestamps fresh.
    for (const [field, fingerprint] of next) value[field] = fresh || !latest || fingerprints.get(field) !== fingerprint
      ? JSON.parse(JSON.stringify(state[field])) : latest[field];
    latest = value;
    fingerprints = next;
    for (const client of clients) schedule(client);
    return true;
  }

  function refresh({ fresh = false } = {}) {
    if (closed || !clients.size) return Promise.resolve(null);
    if (reading) { reading.fresh ||= fresh; return reading.promise; }
    const operation = { controller: new AbortController(), promise: null, fresh };
    reading = operation;
    operation.promise = Promise.resolve().then(() => snapshot({ signal: operation.controller.signal })).then(value => {
      if (reading !== operation || closed || !clients.size) return null;
      publish(value, { fresh: operation.fresh });
      return latest;
    }).catch(error => {
      if (reading !== operation || closed || !clients.size) return null;
      throw error;
    }).finally(() => { if (reading === operation) reading = null; });
    return operation.promise;
  }

  function startPolling() {
    if (closed || !clients.size || !pollMs || pollTimer !== null) return;
    const generation = epoch;
    pollTimer = unref(clock.setTimeout(async () => {
      pollTimer = null;
      try { await refresh(); } catch (error) {
        if (generation !== epoch) return;
        report(error);
        for (const client of [...clients]) disconnect(client);
      }
      if (generation === epoch) startPolling();
    }, pollMs));
  }

  async function accept(req, res) {
    if (closed || req.aborted || res.destroyed || res.writableEnded) { res.end(); return false; }
    let cancel;
    const cancelled = new Promise(resolve => { cancel = () => resolve(null); });
    const client = { req, res, cancel, ready: false, blocked: false, sent: new Map(), pending: new Map(), timer: null, lastJobs: -Infinity, lastValue: -Infinity };
    client.onClose = () => disconnect(client);
    client.onDrain = () => { client.blocked = false; schedule(client); };
    clients.add(client);
    req.once('aborted', client.onClose);
    for (const event of ['close', 'finish', 'error']) res.once(event, client.onClose);
    res.on('drain', client.onDrain);
    try {
      if (clients.size === 1) onActive();
      const state = await Promise.race([refresh({ fresh: true }), cancelled]);
      if (!state || !clients.has(client)) { disconnect(client); return false; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.flushHeaders?.();
      // Use the current value if a second client/source update won the race.
      if (!write(client, 'state', latest)) return false;
      client.sent = new Map(fingerprints);
      client.ready = true;
      if (pingTimer === null) pingTimer = unref(clock.setInterval(() => {
        for (const item of [...clients]) if (item.ready) {
          if (item.blocked) disconnect(item); // Bound stalled clients without buffering heartbeats.
          else write(item, 'ping', {});
        }
      }, pingMs));
      startPolling();
      return true;
    } catch (error) { disconnect(client, res.headersSent); throw error; }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const client of [...clients]) disconnect(client);
    stopIdle();
  }

  return { accept, publish, refresh, close, status: () => ({ closed, clients: clients.size,
    timers: Number(pollTimer !== null) + Number(pingTimer !== null) + [...clients].filter(client => client.timer !== null).length,
    sampling: reading !== null }) };
}

/** Separate persistence reads from change notifications and fallback sampling. Load each block
 * once on subscription; only explicit invalidation refreshes it thereafter.
 * Refreshes merge for 150ms and each block reloads at most once per second.
 * Async results are fenced by block revision and subscription generation.
 */
export function createCachedStateSource({ loaders, readLive, clock = realClock,
  onChange = () => {}, onError = () => {}, mergeMs = 150, refreshIntervalMs = 1000 } = {}) {
  const names = Object.keys(loaders), data = {}, dirty = new Set(names), revisions = new Map(names.map(name => [name, 0])), loadedAt = new Map(), dirtyAt = new Map(names.map(name => [name, -Infinity]));
  let active = false, closed = false, firstRead = true, epoch = 0, timer = null, loading = null;
  function schedule() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (!active || closed || loading || !dirty.size || firstRead) return;
    const dueFor = name => Math.max(dirtyAt.get(name), (loadedAt.get(name) ?? -Infinity) + refreshIntervalMs);
    const due = Math.min(...[...dirty].map(dueFor));
    timer = clock.setTimeout(async () => {
      timer = null;
      const ready = [...dirty].filter(name => clock.now() >= dueFor(name));
      try { await load(ready); } catch (error) { onError(error); }
      schedule();
    }, Math.max(0, due - clock.now()));
    timer?.unref?.();
  }
  function load(keys) {
    if (loading) return loading.promise;
    const operation = { epoch, controller: new AbortController(), promise: null };
    loading = operation;
    operation.promise = Promise.all(keys.map(async name => {
      const revision = revisions.get(name);
      loadedAt.set(name, clock.now());
      const value = await loaders[name]({ signal: operation.controller.signal });
      if (closed || !active || epoch !== operation.epoch || revisions.get(name) !== revision) return;
      data[name] = value;
      dirty.delete(name);
      dirtyAt.delete(name);
    })).then(() => {
      if (active && epoch === operation.epoch && !firstRead) onChange();
    }).finally(() => {
      if (loading === operation) { loading = null; schedule(); }
    });
    return operation.promise;
  }
  async function read() {
    if (closed || !active) return null;
    const generation = epoch;
    if (firstRead) {
      // Initial fill is the only source read allowed to await heavy loaders.
      while (active && epoch === generation && names.some(name => !Object.hasOwn(data, name) || dirty.has(name))) await load([...dirty]);
      if (!active || epoch !== generation) return null;
      firstRead = false;
      schedule();
    }
    return readLive(data);
  }
  function invalidate(...keys) {
    for (const name of keys) {
      if (!Object.hasOwn(loaders, name)) throw new TypeError(`Unknown cached block: ${name}`);
      revisions.set(name, revisions.get(name) + 1);
      if (!dirty.has(name)) dirtyAt.set(name, clock.now() + mergeMs);
      dirty.add(name);
    }
    // Keep the first invalidation window fixed under a burst of notifications.
    if (timer === null) schedule();
  }
  function activate() { if (!closed && !active) { active = true; firstRead = true; epoch++; } }
  function suspend() {
    active = false; epoch++;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    const operation = loading; loading = null; operation?.controller.abort();
  }
  function close() { if (!closed) { closed = true; suspend(); } }
  return { read, invalidate, activate, suspend, close, status: () => ({ active, closed,
    timers: Number(timer !== null), refreshing: loading !== null, dirty: [...dirty] }) };
}

/** Same grouping/limits as activityHistory, with already loaded task rows. */
export function memoryActivity(tasks, settings, limit = 100) {
  const bindings = settings.activity_links || {}, groups = new Map();
  for (const task of [...tasks].sort((a, b) => (a.created_at || 0) - (b.created_at || 0))) {
    const session = task.session_hash, stateGroup = session ? settings.session_groups?.[session] : null;
    const chat = settings.conversations.find(item => item.id === (stateGroup?.conversation_id || bindings[task.task_id] || task.conversation_id));
    const key = session ? 'session:' + session : chat ? 'chat:' + chat.id : 'task:' + task.task_id;
    let group = groups.get(key);
    if (!group) {
      group = { id: key, session_hash: session || null, title: stateGroup?.title || task.conversation_title || chat?.title || task.title,
        conversation_url: chat?.url || null, link_source: chat ? (stateGroup?.link_source || 'user_bound') : 'not_provided_by_host', tasks: [], updated_at: 0 };
      groups.set(key, group);
    }
    group.tasks.push(task);
    group.updated_at = Math.max(group.updated_at, task.finished_at || task.created_at || 0);
  }
  const ordered=[...groups.values()].sort((a,b)=>b.updated_at-a.updated_at||String(a.id).localeCompare(String(b.id)));
  return {items:ordered.slice(0,limit),total:ordered.length,at_least:ordered.length,limit,offset:0,
    truncated:ordered.length>limit,next_offset:null,preview_only:true,
    unlinked:ordered.filter(group=>!group.conversation_url).reduce((sum,group)=>sum+group.tasks.length,0),chat_history_scraped:false};
}
