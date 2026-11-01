import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual browser script with in-memory HTTP/readers and virtual time.
// No browser, daemon, real credential store or network request is involved.
class Clock {
  time = 0; next = 0; timers = new Map();
  setTimeout = (fn, ms) => this.add(fn, ms, false);
  setInterval = (fn, ms) => this.add(fn, ms, true);
  clearTimeout = id => this.timers.delete(id);
  clearInterval = id => this.timers.delete(id);
  add(fn, ms, interval) { const id = ++this.next; this.timers.set(id, { fn, at: this.time + ms, ms, interval }); return id; }
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next; this.time = timer.at;
      if (timer.interval) timer.at += timer.ms; else this.timers.delete(id);
      timer.fn(); await settle();
    }
    this.time = end; await settle();
  }
}
class Surface {
  listeners = new Map();
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t, { hidden = false, nativeVisible = true, respond } = {}) {
  const clock = new Clock(), window = new Surface(), document = new Surface(), requests = [], streams = [];
  document.hidden = hidden; window.__chathandWindowVisible = nativeVisible;
  const draft = { text: '还没发出去的字', scrollTop: 127 }, states = [], patches = [], statuses = [];
  // A page-owned object survives every stream transition.
  window.draft = draft;
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (respond) return respond(url, options, requests.length);
    assert.equal(url, '/api/events');
    const pending = [], reader = { cancelled: false, read: () => new Promise(resolve => pending.push(resolve)), cancel: async () => { reader.cancelled = true; } };
    const stream = { reader, signal: options.signal, frame(event, value) {
      assert.ok(pending.length, 'script is waiting for the next frame');
      pending.shift()({ value: new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`), done: false });
    } };
    streams.push(stream);
    return { ok: true, status: 200, body: { getReader: () => reader } };
  };
  const context={
    window, document, fetch, location: { hash: '#synthetic-owner.synthetic-ui',href:'http://127.0.0.1:1/',origin:'http://127.0.0.1:1',hostname:'127.0.0.1' },URL, AbortController, TextDecoder,
    performance: { now: () => clock.time }, console: { warn() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../ui/auth.js', import.meta.url), 'utf8'),context);
  vm.runInNewContext(fs.readFileSync(new URL('../../ui/stream.js', import.meta.url), 'utf8'),context);
  const stream = window.ChatHandStream;
  t.after(() => stream.stop());
  const start = () => stream.start(value => states.push(value), value => patches.push(value), value => statuses.push(value));
  const native = visible => window.dispatchEvent({ type: 'chathand:window-visibility', detail: { visible } });
  const visibility = hidden => { document.hidden = hidden; document.dispatchEvent({ type: 'visibilitychange' }); };
  return { clock, window, document, draft, requests, streams, states, patches, statuses, stream, start, native, visibility };
}

test('native close stops all stream activity, preserves page/draft, and reopen accepts a fresh state only', async t => {
  const f = fixture(t); f.start(); await settle();
  const first = f.streams[0]; first.frame('state', { revision: 1 }); await settle();
  assert.equal(f.stream.status(), 'live');
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer synthetic-owner');
  assert.equal(f.requests[0].options.headers['X-ChatHand-UI'], 'synthetic-ui');
  f.native(false); await settle();
  assert.equal(first.signal.aborted, true); assert.equal(first.reader.cancelled, true);
  assert.equal(f.stream.status(), 'paused'); assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(120_000); assert.equal(f.requests.length, 1);
  assert.equal(f.window.draft, f.draft); assert.equal(f.draft.text, '还没发出去的字'); assert.equal(f.draft.scrollTop, 127);
  f.native(true); await settle(); assert.equal(f.requests.length, 2);
  first.frame('patch', { obsolete: true }); await settle(); assert.equal(f.patches.length, 0);
  assert.equal(f.streams[1].signal.aborted, false, 'old stream finally cannot abort its replacement');
  f.streams[1].frame('patch', { premature: true }); await settle(); assert.equal(f.patches.length, 0);
  f.streams[1].frame('state', { revision: 2 }); await settle();
  assert.deepEqual(f.states.map(value => value.revision), [1, 2]);
  f.streams[1].frame('patch', { revision: 3 }); await settle(); assert.equal(f.patches[0].revision, 3);
});

test('document and native visibility must both allow resume; stop cannot be undone by visibility', async t => {
  const f = fixture(t, { hidden: true }); f.start(); await settle();
  assert.equal(f.requests.length, 0); assert.equal(f.stream.status(), 'paused');
  f.native(false); f.visibility(false); await settle(); assert.equal(f.requests.length, 0);
  f.native(true); await settle(); assert.equal(f.requests.length, 1);
  f.visibility(true); await settle(); assert.equal(f.clock.timers.size, 0); assert.equal(f.streams[0].signal.aborted, true);
  f.stream.stop(); f.visibility(false); f.native(true); await settle(); assert.equal(f.requests.length, 1);
  f.start(); await settle(); assert.equal(f.requests.length, 2);
  f.streams[0].frame('state', { obsolete: true }); await settle(); assert.equal(f.states.length, 0);
  f.streams[1].frame('state', { fresh: true }); await settle(); assert.equal(f.states[0].fresh, true);
});

test('hide cancels network retries and thirty-second fallback; late fallback cannot overwrite restarted state', async t => {
  let resolveFallback;
  const f = fixture(t, { respond: async url => {
    if (url === '/api/state') return { ok: true, json: () => new Promise(resolve => { resolveFallback = resolve; }) };
    throw Error('synthetic offline');
  } });
  f.start(); await settle(); await f.clock.advance(4_000);
  assert.equal(f.stream.status(), 'fallback');
  await f.clock.advance(30_000); assert.equal(typeof resolveFallback, 'function');
  f.native(false); await settle(); const count = f.requests.length;
  assert.equal(f.clock.timers.size, 0); await f.clock.advance(90_000); assert.equal(f.requests.length, count);
  f.stream.stop(); resolveFallback({ obsolete: true }); await settle(); assert.equal(f.states.length, 0);
});

test('authorization rejection remains blocked across hide/show and never retries SSE without a new start', async t => {
  const f = fixture(t, { respond: async () => ({ ok: false, status: 403 }) });
  f.start(); await settle(); assert.equal(f.requests.length, 1);
  f.native(false); f.native(true); await settle(); await f.clock.advance(1_000);
  assert.equal(f.requests.length, 1); assert.equal(f.stream.status(), 'blocked');
  f.stream.stop(); assert.equal(f.clock.timers.size, 0);
});

 test('obsolete fallback authorization response cannot block a replacement stream', async t => {
  let release;
  const f=fixture(t,{respond:async url=>{if(url==='/api/state')return new Promise(resolve=>release=resolve);throw Error('synthetic offline');}});
  f.start();await settle();await f.clock.advance(34000);assert.equal(typeof release,'function');
  f.native(false);f.native(true);await settle();assert.equal(f.stream.status(),'reconnecting');
  release({ok:false,status:401});await settle();assert.equal(f.stream.status(),'reconnecting');
 });
