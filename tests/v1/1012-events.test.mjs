import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStateEvents, diffState, EVENT_TIMING, VOLATILE_STATE_PATHS } from '../../app/v1/events.mjs';

// No desktop/server import, persistent state, real network, processes or OS tools.
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
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      const [id, timer] = entry;
      this.time = timer.at;
      if (timer.interval) timer.at += timer.ms; else this.timers.delete(id);
      await timer.fn();
    }
    this.time = end;
  }
}

class Response extends EventEmitter {
  frames = []; headersSent = false; destroyed = false; writableEnded = false; writableLength = 0; backpressure = false;
  constructor(clock) { super(); this.clock = clock; }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  flushHeaders() { this.flushed = true; }
  write(frame) {
    const match = /^event: (\w+)\ndata: (.*)\n\n$/.exec(frame);
    assert.ok(match, 'one complete, JSON-escaped SSE frame');
    this.frames.push({ event: match[1], data: JSON.parse(match[2]), at: this.clock.now() });
    return !this.backpressure;
  }
  end() { this.writableEnded = true; this.emit('finish'); }
}

function fixture(t, options = {}) {
  const clock = new Clock(); let reads = 0;
  const value = { connection: { ready: false }, jobs: [{ job_id: 'one', status: 'running', stdout: '' }], settings: { theme: 'system' }, support: { recent_errors: [] } };
  const hub = createStateEvents({ clock, snapshot: () => { reads++; return value; }, pollMs: 0, ...options });
  t.after(() => hub.close());
  return { clock, value, hub, reads: () => reads, async connect() {
    const req = new EventEmitter(), res = new Response(clock);
    await hub.accept(req, res);
    return { req, res, patches: () => res.frames.filter(frame => frame.event === 'patch') };
  } };
}

function atPath(path, value) {
  return path.split('.').reverse().reduce((result, key) => ({ [key]: result }), value);
}

for (const path of VOLATILE_STATE_PATHS) test(`comparison excludes only probe noise: ${path}`, () => {
  const before = atPath(path, 10), after = atPath(path, 20);
  assert.deepEqual(diffState(before, after), {});
  assert.equal(JSON.stringify(after).includes('20'), true, 'comparison must not alter source');
});

for (const [path, before, after] of [
  ['connection.control_plane.state', 'up', 'down'],
  ['connection.control_plane.status', 'ok', 'unreachable'],
  ['connection.control_plane.down_since', 10, 20],
  ['connection.automatic.next_attempt_at', 10, 20],
  ['relay.online', true, false],
  ['automation.browser.extension.connected', true, false],
  ['automation.computer.native_online', true, false],
  ['jobs', [{ started_at: 10, next_cursor: 1 }], [{ started_at: 20, next_cursor: 2 }]],
  ['setup_test.expires_at', 10, 20],
  ['setup_test.expired', false, true],
  ['connection_check.time', 10, 20],
  ['settings.custom.checked_at', 10, 20],
  ['support.recent_errors', [{ time: 10 }], [{ time: 20 }]],
]) test(`meaningful changes survive: ${path}`, () => {
  const next = atPath(path, after);
  assert.deepEqual(diffState(atPath(path, before), next), next);
});

test('comparison is key-order independent and preserves full replacements and deletions', () => {
  assert.deepEqual(diffState({ settings: { a: 1, b: 2 } }, { settings: { b: 2, a: 1 } }), {});
  assert.deepEqual(diffState({ settings: { theme: 'dark', old: 1 }, repair: {} }, { settings: { theme: 'light' } }), { settings: { theme: 'light' }, repair: null });
});

test('SA-2 setup item heartbeat alias is ignored, while connected/status changes still patch', async t => {
  const f = fixture(t);
  f.value.setup = { open_items: [{ id: 'browser', status: 'done', detail: { connected: true, last_seen: 10 } }] };
  const c = await f.connect();
  f.value.setup.open_items[0].detail.last_seen = 20; f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.equal(c.patches().length, 0);
  f.value.setup.open_items[0].detail.connected = false;
  f.value.setup.open_items[0].status = 'todo'; f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.deepEqual(c.patches()[0].data, { setup: f.value.setup });
});

test('initial state is exact original JSON, including volatile values and SSE escaping', async t => {
  const f = fixture(t);
  f.value.connection.control_plane = { checked_at: 10, last_success_at: 10, state: 'up' };
  f.value.jobs[0].stdout = 'event: injected\n\ndata: wrong\r\n';
  const c = await f.connect();
  assert.equal(c.res.statusCode, 200);
  assert.match(c.res.headers['Content-Type'], /^text\/event-stream/);
  assert.equal(c.res.headers['Cache-Control'], 'no-store');
  assert.equal(c.res.flushed, true);
  assert.deepEqual(c.res.frames[0].data, f.value);
  f.value.connection.control_plane.checked_at = 20;
  f.value.connection.control_plane.last_success_at = 20;
  f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.equal(c.patches().length, 0);
  f.value.connection.ready = true;
  f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.equal(c.patches()[0].data.connection.control_plane.checked_at, 20);
});

for (const field of ['connection', 'jobs', 'permissions', 'settings', 'update', 'support', 'setup']) {
  test(`150ms fixed window merges the latest ${field} value only`, async t => {
    const f = fixture(t), c = await f.connect();
    f.value[field] = { value: 1 }; f.hub.publish(f.value);
    await f.clock.advance(80);
    f.value[field] = { value: 2 }; f.hub.publish(f.value);
    await f.clock.advance(69);
    assert.equal(c.patches().length, 0);
    await f.clock.advance(1);
    assert.deepEqual(c.patches().map(frame => frame.data), [{ [field]: { value: 2 } }]);
    assert.equal(c.patches()[0].at, 150);
  });
}

test('in-place source mutations detach; reversion cancels pending work', async t => {
  const f = fixture(t), c = await f.connect();
  f.value.settings.theme = 'dark'; f.hub.publish(f.value);
  f.value.settings.theme = 'system'; f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.equal(c.patches().length, 0);
  f.value.jobs[0].stdout = 'first'; f.hub.publish(f.value);
  f.value.jobs[0].stdout = 'unpublished';
  await f.clock.advance(150);
  assert.equal(c.patches()[0].data.jobs[0].stdout, 'first');
  assert.equal(c.res.frames[0].data.jobs[0].stdout, '');
});

test('continuous job output stays <=4Hz without delaying permissions, includes final output', async t => {
  const f = fixture(t), c = await f.connect();
  for (let i = 0; i < 50; i++) {
    f.value.jobs[0].stdout = String(i); f.hub.publish(f.value);
    if (i === 10) { f.value.permissions = { desktop: true }; f.hub.publish(f.value); }
    await f.clock.advance(20);
  }
  f.value.jobs[0].status = 'completed'; f.value.jobs[0].stdout = 'final'; f.hub.publish(f.value);
  await f.clock.advance(250);
  const jobs = c.patches().filter(frame => frame.data.jobs);
  for (let i = 1; i < jobs.length; i++) assert.ok(jobs[i].at - jobs[i - 1].at >= 250);
  for (const frame of jobs) assert.ok(jobs.filter(other => other.at >= frame.at && other.at < frame.at + 1000).length <= 4);
  assert.deepEqual(jobs.at(-1).data.jobs, f.value.jobs);
  assert.equal(c.patches().find(frame => frame.data.permissions).at, 350);
  assert.equal(c.patches().find(frame => frame.data.permissions).data.jobs, undefined);
});

test('idle stream only pings every 25 seconds', async t => {
  const f = fixture(t), c = await f.connect();
  await f.clock.advance(24_999);
  assert.equal(c.res.frames.length, 1);
  await f.clock.advance(1);
  assert.deepEqual(c.res.frames[1], { event: 'ping', data: {}, at: 25_000 });
  await f.clock.advance(25_000);
  assert.equal(c.res.frames.at(-1).at, 50_000);
  assert.equal(c.patches().length, 0);
});

for (const action of ['aborted', 'close', 'finish', 'error', 'hub.close']) test(`disconnect clears all timers and listeners: ${action}`, async t => {
  const f = fixture(t, { pollMs: 250 }), c = await f.connect();
  f.value.settings.theme = 'dark'; f.hub.publish(f.value);
  assert.equal(f.clock.timers.size, 3);
  if (action === 'hub.close') f.hub.close();
  else if (action === 'aborted') c.req.emit(action);
  else c.res.emit(action, action === 'error' ? Error('fixture') : undefined);
  assert.equal(f.clock.timers.size, 0);
  assert.deepEqual(f.hub.status(), { closed: action === 'hub.close', clients: 0, timers: 0, sampling: false });
  assert.equal(c.req.listenerCount('aborted'), 0);
  for (const event of ['close', 'finish', 'error', 'drain']) assert.equal(c.res.listenerCount(event), 0);
  await f.clock.advance(50_000);
  assert.equal(f.reads(), 1);
  assert.equal(c.res.frames.length, 1);
});

test('normal completed GET request close is not a stream disconnect', async t => {
  const f = fixture(t), c = await f.connect();
  c.req.emit('close');
  assert.equal(f.hub.status().clients, 1);
  f.value.settings.theme = 'dark'; f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.equal(c.patches().length, 1);
});

test('clients share sampling, have independent baselines, and reconnect receives fresh state', async t => {
  const f = fixture(t, { pollMs: 250 }), first = await f.connect();
  f.value.settings.theme = 'dark'; f.hub.publish(f.value);
  await f.clock.advance(80);
  const second = await f.connect();
  assert.equal(second.res.frames[0].data.settings.theme, 'dark');
  await f.clock.advance(70);
  assert.equal(first.patches().length, 1);
  assert.equal(second.patches().length, 0);
  await f.clock.advance(100);
  assert.equal(f.reads(), 3, 'two initial reads, one shared poll');
  first.res.emit('close');
  assert.equal(f.hub.status().clients, 1);
  second.res.emit('close');
  assert.equal(f.clock.timers.size, 0);
  f.value.settings.theme = 'light';
  const third = await f.connect();
  assert.equal(third.res.frames[0].data.settings.theme, 'light');
});

test('slow client holds only latest changes until drain; ping closes stalled client', async t => {
  const f = fixture(t), c = await f.connect();
  c.res.backpressure = true;
  f.value.settings.theme = 'dark'; f.hub.publish(f.value);
  await f.clock.advance(150);
  for (const theme of ['light', 'system', 'latest']) { f.value.settings.theme = theme; f.hub.publish(f.value); }
  await f.clock.advance(150);
  assert.equal(c.patches().length, 1);
  c.res.backpressure = false; c.res.emit('drain');
  await f.clock.advance(0);
  assert.equal(c.patches().at(-1).data.settings.theme, 'latest');
  c.res.backpressure = true;
  f.value.settings.theme = 'stalled'; f.hub.publish(f.value);
  await f.clock.advance(150);
  await f.clock.advance(25_000);
  assert.equal(f.hub.status().clients, 0);
  assert.equal(f.clock.timers.size, 0);
});

test('write budget and write errors disconnect without growing buffers', async t => {
  for (const kind of ['budget', 'throw']) {
    const f = fixture(t), c = await f.connect();
    if (kind === 'budget') c.res.writableLength = 4 * 1024 * 1024;
    else c.res.write = () => { throw Error('broken pipe'); };
    f.value.settings.theme = 'dark'; f.hub.publish(f.value);
    await f.clock.advance(150);
    assert.equal(f.hub.status().clients, 0);
    assert.equal(f.clock.timers.size, 0);
  }
});

test('source errors before headers reject cleanly; periodic failures close for fallback', async t => {
  const error = Error('fixture failure');
  const initial = fixture(t, { snapshot: () => { throw error; } });
  const req = new EventEmitter(), res = new Response(initial.clock);
  await assert.rejects(initial.hub.accept(req, res), error);
  assert.equal(res.headersSent, false);
  assert.equal(res.writableEnded, false, 'server can still send JSON error');
  assert.equal(initial.clock.timers.size, 0);
  let fail = false; const errors = [];
  const periodic = fixture(t, { pollMs: 250, snapshot: () => { if (fail) throw error; return {}; }, onError: value => errors.push(value) });
  await periodic.connect(); fail = true;
  await periodic.clock.advance(250);
  assert.deepEqual(errors, [error]);
  assert.equal(periodic.hub.status().clients, 0);
  assert.equal(periodic.clock.timers.size, 0);
});

test('disconnect during async initial read aborts immediately; late results cannot leak into reconnect', async t => {
  for (const late of ['resolve', 'reject']) {
    let settle, signal, reads = 0;
    const f = fixture(t, { snapshot: ({ signal: value }) => {
      if (++reads > 1) return { settings: { theme: 'fresh' } };
      signal = value;
      return new Promise((resolve, reject) => { settle = late === 'resolve' ? () => resolve({ settings: { theme: 'old' } }) : () => reject(Error('obsolete')); });
    } });
    const req = new EventEmitter(), res = new Response(f.clock), accepting = f.hub.accept(req, res);
    await Promise.resolve(); req.emit('aborted');
    assert.equal(await accepting, false);
    assert.equal(signal.aborted, true);
    const next = await f.connect(); settle();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(next.res.frames.length, 1);
    assert.equal(next.res.frames[0].data.settings.theme, 'fresh');
    assert.equal(f.hub.status().clients, 1);
    next.res.emit('close');
    assert.equal(f.clock.timers.size, 0);
  }
});

test('concurrent clients coalesce initial reads and duplicate refresh requests', async t => {
  let settle, reads = 0;
  const f = fixture(t, { snapshot: () => { reads++; return new Promise(resolve => { settle = resolve; }); } });
  const requests = [1, 2].map(() => f.hub.accept(new EventEmitter(), new Response(f.clock)));
  const a = f.hub.refresh(), b = f.hub.refresh(); assert.equal(a, b);
  await Promise.resolve(); assert.equal(reads, 1); settle({ jobs: [] });
  assert.deepEqual(await Promise.all(requests), [true, true]);
  await a;
  f.hub.close(); f.hub.close();
  assert.equal(f.clock.timers.size, 0);
  assert.equal(await f.hub.refresh(), null);
  assert.equal(f.hub.publish({}), false);
});

test('future fields and top-level removals arrive as shallow patches', async t => {
  const f = fixture(t), c = await f.connect();
  delete f.value.support; f.value.future_feature = { enabled: true }; f.hub.publish(f.value);
  await f.clock.advance(150);
  assert.deepEqual(c.patches()[0].data, { support: null, future_feature: { enabled: true } });
});

test('production timing defaults and invalid options', () => {
  assert.deepEqual(EVENT_TIMING, { mergeMs: 150, jobIntervalMs: 250, pingMs: 25_000, pollMs: 5_000 });
  for (const options of [{}, { snapshot: () => ({}), pingMs: 0 }, { snapshot: () => ({}), pollMs: -1 }]) assert.throws(() => createStateEvents(options), TypeError);
});

test('default fallback samples only subscribed clients, once per five seconds', async t => {
  const f = fixture(t, { pollMs: EVENT_TIMING.pollMs });
  await f.clock.advance(20_000); assert.equal(f.reads(), 0);
  const c = await f.connect(); assert.equal(f.reads(), 1);
  await f.clock.advance(4_999); assert.equal(f.reads(), 1);
  await f.clock.advance(1); assert.equal(f.reads(), 2);
  c.req.emit('aborted');
  await f.clock.advance(20_000); assert.equal(f.reads(), 2);
  assert.equal(f.clock.timers.size, 0);
});

for (const path of ['connection.control_plane.last_success_at', 'connection.display.last_confirmed_at']) {
  test(`confirmation age compares thirty-second buckets, retaining exact wire values: ${path}`, async t => {
    assert.deepEqual(diffState(atPath(path, 30_001), atPath(path, 59_999)), {});
    assert.deepEqual(diffState(atPath(path, 59_999), atPath(path, 60_001)), atPath(path, 60_001));
    const f = fixture(t); f.value.connection = atPath(path, 30_001).connection;
    const first = await f.connect();
    f.value.connection = atPath(path, 59_999).connection; f.hub.publish(f.value);
    await f.clock.advance(150); assert.equal(first.patches().length, 0);
    const second = await f.connect();
    assert.deepEqual(second.res.frames[0].data.connection, atPath(path, 59_999).connection, 'new subscriber gets fresh raw time');
    f.value.connection = atPath(path, 60_001).connection; f.hub.publish(f.value);
    f.value.connection = atPath(path, 99_999).connection; // Unpublished mutation must not change the pending patch.
    await f.clock.advance(150);
    assert.deepEqual(first.patches()[0].data.connection, atPath(path, 60_001).connection);
    assert.deepEqual(second.patches()[0].data.connection, atPath(path, 60_001).connection);
  });
}
