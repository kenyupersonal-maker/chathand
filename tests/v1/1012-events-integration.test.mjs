import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createCachedStateSource, memoryActivity, diffState, EVENT_TIMING } from '../../app/v1/events.mjs';
import { createDesktop } from '../../app/server.mjs';
import { withScopeNote } from '../../app/v1/permissions.mjs';

class Clock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => this.add(fn, ms, false);
  setInterval = (fn, ms) => this.add(fn, ms, true);
  clearTimeout = id => this.timers.delete(id);
  clearInterval = id => this.timers.delete(id);
  add(fn, ms, interval) { const id = ++this.next; this.timers.set(id, { fn, at: this.time + ms, ms, interval }); return id; }
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const entry = [...this.timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      const [id, timer] = entry; this.time = timer.at;
      if (timer.interval) timer.at += timer.ms; else this.timers.delete(id);
      await timer.fn();
    }
    this.time = end;
  }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message = 'condition') {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timeout: ${message}`); await turn(); }
}

test('cache reads only invalidated blocks; burst refresh merges and stays <=1Hz', async t => {
  const clock = new Clock(), counts = { history: 0, credentials: 0, support: 0 }; let output = 0;
  const source = createCachedStateSource({ clock, loaders: Object.fromEntries(Object.keys(counts).map(name => [name, () => ++counts[name]])), readLive: blocks => ({ ...blocks, output }) });
  t.after(() => source.close()); source.activate();
  const initial = await Promise.all([source.read(), source.read()]);
  assert.deepEqual(initial[0], initial[1]);
  for (let i = 0; i < 40; i++) { output++; await source.read(); await clock.advance(250); }
  assert.deepEqual(counts, { history: 1, credentials: 1, support: 1 });
  source.invalidate('support'); await clock.advance(80); source.invalidate('support');
  await clock.advance(69); assert.equal(counts.support, 1);
  await clock.advance(1); assert.equal(counts.support, 2);
  source.invalidate('support'); await clock.advance(999); assert.equal(counts.support, 2);
  await clock.advance(1); assert.equal(counts.support, 3);
  source.suspend(); assert.equal(clock.timers.size, 0);
});

for (const action of ['suspend', 'close']) test(`pending cache refresh cleans up and discards old async results: ${action}`, async t => {
  const clock = new Clock(); let settle, signal, reads = 0, output = 1;
  const source = createCachedStateSource({ clock, loaders: { history: ({ signal: value }) => {
    if (++reads === 1) { signal = value; return new Promise(resolve => { settle = resolve; }); }
    return 'fresh';
  } }, readLive: blocks => ({ ...blocks, output }) });
  t.after(() => source.close()); source.activate(); const old = source.read();
  await Promise.resolve(); source[action](); assert.equal(signal.aborted, true);
  assert.equal(source.status().timers, 0); assert.equal(source.status().refreshing, false);
  if (action === 'suspend') { output = 2; source.activate(); assert.deepEqual(await source.read(), { history: 'fresh', output: 2 }); }
  settle('obsolete'); assert.equal(await old, null);
  if (action === 'suspend') assert.deepEqual(await source.read(), { history: 'fresh', output: 2 });
});

test('memory activity keeps all groups in unlinked count while limiting visible rows', () => {
  const tasks = Array.from({ length: 120 }, (_, i) => ({ task_id: String(i), title: String(i), jobs: [], created_at: i }));
  const value = memoryActivity(tasks, { conversations: [] });
  assert.equal(value.items.length, 100); assert.equal(value.unlinked, 120);
});

test('async dirty-block completion cannot overwrite newer output or a newer block revision', async t => {
  const clock = new Clock(); let settle, reads = 0, output = 'initial'; const notifications = [];
  const source = createCachedStateSource({ clock, loaders: { history: () => {
    reads++; if (reads === 2) return new Promise(resolve => { settle = resolve; });
    return reads === 1 ? 'initial archive' : 'new archive';
  } }, readLive: blocks => ({ history: blocks.history, output }), onChange: () => notifications.push(output) });
  t.after(() => source.close()); source.activate(); await source.read();
  await clock.advance(1000); source.invalidate('history');
  const advancing = clock.advance(150); await until(() => settle);
  output = 'newest output'; source.invalidate('history');
  assert.deepEqual(await source.read(), { history: 'initial archive', output: 'newest output' });
  settle('obsolete archive'); await advancing;
  assert.deepEqual(await source.read(), { history: 'initial archive', output: 'newest output' });
  await clock.advance(1000);
  assert.deepEqual(await source.read(), { history: 'new archive', output: 'newest output' });
  assert.ok(notifications.every(value => value === 'newest output'));
});

function nativeSubstitute(state, clock) {
  const personal = { phase: 'disconnected', message: 'fixture browser', t: null, status: () => withScopeNote(state, { backend: 'personal', phase: personal.phase, connected: personal.phase === 'connected', personal_browser_attached: false, sessions: 0, message: personal.message }) };
  const managed = { sessions: new Map(), status: () => ({ available: false, sessions: 0 }) };
  const extension = { session: null, lastSeen: 0, status: () => ({ backend: 'extension', connected: !!extension.session && clock.now() - extension.lastSeen < 7000, last_seen: extension.lastSeen || null, installed: !!extension.lastSeen }) };
  const browser = { personal, managed, extension, status: () => ({ ...extension.status(), selected_backend: state.data.browser_backend || 'extension', extension: extension.status(), personal: personal.status(), fallback_to_isolated: false }) };
  const computer = { lastSeen: -Infinity, nativeStatus: null, status: () => ({ native_online: clock.now() - computer.lastSeen < 5000, permissions: computer.nativeStatus }), heartbeat: value => { computer.lastSeen = clock.now(); computer.nativeStatus = value; return computer.status(); }, next: () => { computer.lastSeen = clock.now(); return { request: null }; } };
  return { browser, computer, close: async () => {} };
}

async function desktop(t, { uiKey = 'a'.repeat(64) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-sa1-http-')), clock = new Clock(), counts = {}, credentialValues = {};
  let probes = 0, completed = 0, endpointRequests = 0;
  const health = http.createServer((req, res) => { endpointRequests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${health.address().port}`;
  const child = { spawnargs: [] }, tunnel = { child, doctorChild: null, status: 'running', log: [], healthUrl: base, tunnelId: 'tunnel_fixture0000', binary: 'fixture', key: '', exitCode: null,
    snapshot: async () => { probes++; const current = tunnel.child; await Promise.all(['/healthz', '/readyz', '/health?details=true'].map(route => fetch(base + route).then(res => res.json()))); completed++; return { status: tunnel.status, process_running: !!current, healthy: !!current, ready: !!current, control_plane: { state: 'up', checked_at: clock.now(), last_success_at: clock.now(), consecutive_failures: 0 }, ui_url: base + '/ui', tunnel_id: tunnel.tunnelId, exit_code: null, log: tunnel.log }; }, stop: () => { tunnel.child = null; tunnel.status = 'off'; } };
  const credentials = { get: name => credentialValues[name], set: (name, value) => { credentialValues[name] = value; }, remove: name => { delete credentialValues[name]; }, status: () => ({ format: 'injected-memory', healthy: true, tunnel: !!credentialValues.tunnel, relay: !!credentialValues.relay }) };
  const updateValue = { status: 'up_to_date', install: { state: 'idle' }, progress: 0, downloaded_bytes: 0, total_bytes: 0 };
  const updater = { snapshot: () => structuredClone(updateValue), start: () => {}, close: () => {}, settingsChanged: () => {}, cleanupLeftovers: () => ({ ok: true }) };
  const adminAccess = { supported: () => false, ready: () => false, uninstall: () => { assert.fail('must not use native admin'); } };
  const previous = process.env.CHATHAND_STATE_DIR; process.env.CHATHAND_STATE_DIR = path.join(root, 'state');
  let b;
  try { b = await createDesktop({ stateDir: process.env.CHATHAND_STATE_DIR, defaultRoot: path.join(root, 'workspace'), uiKey, adminAccess,
    clientDeps: { now: clock.now, computerName: () => 'isolated-fixture', credentials, tunnelFactory: () => tunnel, updaterFactory: () => updater,
      automationFactory: state => nativeSubstitute(state, clock), eventClock: clock, maintenanceClock: clock,
      onEventLoad: name => { counts[name] = (counts[name] || 0) + 1; } } });
  } finally { if (previous === undefined) delete process.env.CHATHAND_STATE_DIR; else process.env.CHATHAND_STATE_DIR = previous; }
  t.after(async () => { await b?.close(); health.closeAllConnections(); await new Promise(resolve => health.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const streams = [];
  async function stream() {
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${b.apiPort}/api/events`, { headers: { Authorization: `Bearer ${b.adminToken}`, 'X-ChatHand-UI': uiKey }, signal: abort.signal });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const frames = [], decoder = new TextDecoder(); let text = '';
    const reading = (async () => { try { for await (const chunk of res.body) {
      text += decoder.decode(chunk, { stream: true });
      let at; while ((at = text.indexOf('\n\n')) >= 0) { const frame = text.slice(0, at); text = text.slice(at + 2); const match = /^event: (\w+)\ndata: (.*)$/.exec(frame); assert.ok(match); frames.push({ event: match[1], data: JSON.parse(match[2]), receivedAt: clock.now() }); }
    } } catch (error) { if (!abort.signal.aborted) throw error; } })();
    const result = { frames, abort: async () => { abort.abort(); await reading; }, reading };
    streams.push(result); await until(() => frames.length, 'initial SSE state'); return result;
  }
  t.after(async () => { for (const item of streams) await item.abort(); });
  return { b, root, clock, counts, tunnel, credentials, updater, updateValue, stream, probes: () => probes, completed: () => completed, endpointRequests: () => endpointRequests,
    headers: { Authorization: `Bearer ${b.adminToken}`, 'X-ChatHand-UI': uiKey }, url: `http://127.0.0.1:${b.apiPort}` };
}

test('isolated HTTP requires both owner and window credentials, fails closed without window key', async t => {
  const f = await desktop(t);
  for (const [headers, status] of [
    [{}, 401], [{ 'X-ChatHand-UI': 'a'.repeat(64) }, 401],
    [{ Authorization: `Bearer ${f.b.adminToken}` }, 403],
    [{ Authorization: `Bearer ${f.b.adminToken}`, 'X-ChatHand-UI': f.b.adminToken }, 403],
    [{ Authorization: `Bearer ${f.b.adminToken}`, 'X-ChatHand-UI': 'forged' }, 403],
    [{ Authorization: 'Bearer invalid', 'X-ChatHand-UI': 'a'.repeat(64) }, 401],
  ]) { const res = await fetch(f.url + '/api/events', { headers }); assert.equal(res.status, status); await res.json(); }
  assert.equal(f.probes(), 0); assert.deepEqual(f.counts, {});
  const absent = await desktop(t, { uiKey: null });
  const res = await fetch(absent.url + '/api/events', { headers: { Authorization: `Bearer ${absent.b.adminToken}`, 'X-ChatHand-UI': 'a'.repeat(64) } });
  assert.equal(res.status, 403); await res.json();
});

test('actual HTTP initial state preserves GET contract; two clients and 10s output add no probes or heavy reads', async t => {
  const f = await desktop(t);
  const full = await fetch(f.url + '/api/state', { headers: f.headers }).then(res => res.json());
  const first = await f.stream(), second = await f.stream();
  assert.deepEqual(diffState(full, first.frames[0].data), {});
  assert.deepEqual(second.frames[0].data, first.frames[0].data);
  for (const name of ['metadata', 'skill', 'history', 'support', 'credentials', 'access', 'browser', 'guard']) assert.equal(f.counts[name], 1, name);
  assert.ok(first.frames[0].data.setup.open_items); assert.deepEqual(first.frames[0].data.setup.key_watch, { active: false, received: false, last4: null });
  assert.ok(first.frames[0].data.permissions); assert.equal(first.frames[0].data.update.downloaded_bytes, 0);
  const baseline = f.probes(); f.b.controller.desired = true; f.b.controller.phase = 'ready';
  const job = { id: crypto.randomUUID(), request_id: crypto.randomUUID(), status: 'running', args: [], program: 'fixture', cwd: '.', created_at: Date.now(), events: [], next_cursor: 0, base_cursor: 0, kept_bytes: 0, jobs: [], stdin_mode: 'closed', mode: 'task', timeout_ms: 1000 };
  f.b.queue.jobs.set(job.id, job);
  for (let i = 0; i < 40; i++) {
    f.b.queue.appendOutput(job, 'stdout', `line ${i}\n`);
    await f.clock.advance(250);
    if ((i + 1) % 4 === 0) await until(() => f.completed() === baseline + (i + 1) / 4, 'original maintenance probe');
  }
  await f.clock.advance(150); await until(() => first.frames.some(frame => frame.data.jobs?.[0]?.last_line === 'line 39'), 'final output');
  assert.equal(f.probes() - baseline, 10); assert.equal(f.endpointRequests(), f.probes() * 3);
  for (const value of Object.values(f.counts)) assert.equal(value, 1, 'no heavy reads from output/health changes');
  const jobs = first.frames.filter(frame => frame.event === 'patch' && frame.data.jobs);
  assert.ok(jobs.length > 0 && jobs.length <= 40);
  assert.ok(first.frames.every(frame => frame.event !== 'patch' || !frame.data.history && !frame.data.support && !frame.data.credentials));
  await first.abort(); await until(() => f.b.stateEvents.status().clients === 1);
  await second.abort(); await until(() => f.b.stateEvents.status().clients === 0);
  assert.equal(f.b.stateEvents.status().timers, 0); assert.equal(f.b.eventSourceStatus().timers, 0); assert.equal(f.b.eventSourceStatus().watchers, 0);
  const next = await f.stream(); assert.equal(next.frames[0].data.jobs[0].last_line, 'line 39');
  assert.equal(f.counts.history, 1); assert.equal(f.probes(), baseline + 10);
  await f.b.close(); await next.reading;
  assert.equal(f.clock.timers.size, 0); assert.equal(f.b.stateEvents.status().timers, 0); assert.equal(f.b.eventSourceStatus().watchers, 0);
});

test('HTTP live permission/online/expiry/update changes survive cache; stale connection generation is cleared', async t => {
  const f = await desktop(t), stream = await f.stream();
  const probes = f.probes();
  f.b.keyWatch.start('tunnel_fixture0000'); f.b.tools.setupTest.now = f.clock.now; f.b.tools.setupTest.start();
  f.b.tools.automation.computer.heartbeat({ accessibility: true, screen_recording: true });
  f.updateValue.status = 'downloading'; f.updateValue.downloaded_bytes = 123;
  f.b.state.data.desktop_enabled = false; f.b.state.save();
  await f.clock.advance(EVENT_TIMING.pollMs + EVENT_TIMING.mergeMs);
  await until(() => stream.frames.some(frame => frame.data.update?.downloaded_bytes === 123));
  assert.ok(stream.frames.some(frame => frame.data.permissions?.capabilities.desktop.enabled === false));
  assert.ok(stream.frames.some(frame => frame.data.setup?.key_watch.active === true));
  assert.equal(f.probes(), probes);
  f.b.state.data.mode = 'full'; f.b.state.save();
  await f.clock.advance(400);
  await until(() => stream.frames.some(frame => frame.data.automation && !frame.data.automation.browser.personal.details?.scope_note));
  f.b.keyWatch.now = () => 600001; f.b.tools.setupTest.now = () => 600001;
  await f.clock.advance(5000); await until(() => stream.frames.some(frame => frame.data.setup_test?.expired === true));
  assert.ok(stream.frames.some(frame => frame.data.setup?.key_watch.active === false));
  assert.ok(stream.frames.some(frame => frame.data.automation?.computer.native_online === false));
  await fetch(f.url + '/api/state', { headers: f.headers }).then(res => res.json());
  await f.clock.advance(400); await until(() => stream.frames.some(frame => frame.data.connection?.ready === true));
  f.b.controller.generation++; f.tunnel.child = { spawnargs: [] };
  await f.clock.advance(400); await until(() => stream.frames.some(frame => frame.data.connection?.ready === false));
  assert.equal(f.probes(), probes + 1, 'only explicit GET sampled health');
  await f.clock.advance(25000 - f.clock.now()); await until(() => stream.frames.some(frame => frame.event === 'ping'));
});

test('HTTP cache reloads real receipt/content changes; credential chmod has no feedback loop', async t => {
  const f = await desktop(t), file = path.join(f.root, 'state/credentials.json');
  fs.writeFileSync(file, JSON.stringify({ fixture: 1 }));
  const status = f.credentials.status;
  f.credentials.status = () => { fs.chmodSync(file, 0o600); return status(); };
  const stream = await f.stream();
  await turn(); await turn(); await f.clock.advance(10_000);
  assert.equal(f.counts.credentials, 1, 'reading/chmod does not invalidate contents');
  fs.writeFileSync(file, JSON.stringify({ fixture: 222 }));
  await until(() => f.b.eventSourceStatus().dirty.includes('credentials'), 'content watcher invalidation');
  await f.clock.advance(150); assert.equal(f.counts.credentials, 2);
  await turn(); await turn(); await f.clock.advance(2000); assert.equal(f.counts.credentials, 2);
  const id = crypto.randomUUID(), result = { task_id: id, status: 'completed', execution_complete: true, terminal: true, finished_at: 12, created_at: 1, jobs: [], project_id: f.b.state.data.active, title: 'isolated archive' };
  f.b.policy.receipts.save(id, 'fixture', true, result);
  await f.clock.advance(1000); await until(() => stream.frames.some(frame => frame.data.history?.some(task => task.task_id === id)));
  assert.equal(f.counts.history, 2); assert.equal(f.counts.support, 1);
  const full = await fetch(f.url + '/api/state', { headers: f.headers }).then(res => res.json());
  const patch = stream.frames.findLast(frame => frame.data.history);
  assert.deepEqual(patch.data.history, full.history); assert.deepEqual(patch.data.activity, full.activity);
});

test('HTTP memory sampler leaves task/job expiration to deadline maintenance', async t => {
  const f = await desktop(t), job = { id: crypto.randomUUID(), request_id: crypto.randomUUID(), status: 'pending_approval', program: 'fixture', args: [], cwd: '.', created_at: Date.now() - f.b.queue.approvalMs - 10, events: [], next_cursor: 0, base_cursor: 0, kept_bytes: 0, stdin_mode: 'closed', mode: 'task', timeout_ms: 1000 };
  f.b.queue.jobs.set(job.id, job);
  const stream = await f.stream();
  assert.equal(stream.frames[0].data.jobs[0].status, 'pending_approval');
  // The already-overdue record is serviced by the first maintenance deadline;
  // the initial memory-only SSE read itself did not expire it.
  await f.clock.advance(0); assert.equal(job.status, 'expired');
  await f.clock.advance(EVENT_TIMING.pollMs + EVENT_TIMING.mergeMs);
  await until(() => stream.frames.some(frame => frame.data.jobs?.[0]?.status === 'expired'));
  assert.equal(f.probes(), 0); assert.equal(f.counts.history, 1);
});

test('computer polling avoids SSE rebuilds, while real online/permission transitions notify immediately', async t => {
  const f = await desktop(t), stream = await f.stream();
  const post = async (route, body = {}) => {
    const response = await fetch(f.url + route, { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  const heartbeat = { accessibility: false, screen_recording: false, needs_restart: false, step: 'idle' };
  await post('/api/computer/heartbeat', heartbeat);
  await f.clock.advance(150); await until(() => stream.frames.some(frame => frame.data.automation?.computer.native_online === true));
  let rebuilds = 0; const refresh = f.b.stateEvents.refresh;
  f.b.stateEvents.refresh = (...args) => { rebuilds++; return refresh(...args); };
  for (let i = 0; i < 10; i++) {
    await post('/api/computer/heartbeat', heartbeat); await post('/api/computer/next'); await f.clock.advance(10);
  }
  assert.equal(rebuilds, 0, 'unchanged 0.3s native polls do not ask for full UI state');
  await post('/api/computer/heartbeat', { ...heartbeat, accessibility: true });
  assert.equal(rebuilds, 1, 'only meaningful permission changes rebuild');
  await f.clock.advance(150);
  await until(() => stream.frames.some(frame => frame.data.automation?.computer.permissions?.accessibility === true));
  assert.equal(f.clock.now(), 400, 'permission change arrives within one second, without fallback');
});
