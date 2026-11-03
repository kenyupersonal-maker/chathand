import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const section = (from, to) => { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); };
const plain = value => JSON.parse(JSON.stringify(value));
const locales = Object.fromEntries(['zh', 'en'].map(lang => [lang, JSON.parse(fs.readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), 'utf8'))]));

function statusFixture(extension = {}) {
  const context = vm.createContext({
    S: {settings: {browser_enabled: true}, automation: {browser: {extension: {distribution: 'chrome_web_store', ...extension}}}},
    T: (key, params) => key + (params?.build ? ` ${params.build}` : ''), capOn: key => context.S.settings[key] !== false, browserOn: () => false,
    helperNeedsHand: () => false, extRepairUnsupported: false, browserRetrying: false, browserRetryError: false, browserUpdateError: false, browserUpdating: false,
  });
  vm.runInContext(source.split('\n').find(line => line.startsWith('function browserState()')) + '\n' + section('function capBrowser()', 'function capDesktop()'), context);
  return context;
}

test('observed but disconnected Chrome extension is neutral and never reports Browser Use ready', () => {
  const ctx = statusFixture({connected: false, installed: true, installation_previously_observed: true, compatibility: {state: 'compatible'}});
  assert.equal(vm.runInContext('browserState()', ctx), 'down');
  const m = plain(vm.runInContext('capBrowser()', ctx));
  assert.equal(m.ok, false);
  assert.equal(m.neutral, true);
  assert.equal(m.res, 'ui.chrome.store.disconnected');
  assert.deepEqual(m.act, ['ui.chrome.store.reconnect', 'browserRetry']);
});

test('never observed extension stays neutral with install; a true connection alone gets green with no sub-text, versions stay in the details list', () => {
  const missing = statusFixture({connected: null, installed: null, installation_previously_observed: false});
  assert.equal(vm.runInContext('browserState()', missing), 'none');
  assert.equal(plain(vm.runInContext('capBrowser()', missing)).act[1], 'extensionSetup');
  const connected = statusFixture({connected: true, connection_state: 'connected', helper: {build: 1092}, compatibility: {state: 'compatible'}});
  const ready = plain(vm.runInContext('capBrowser()', connected));
  assert.equal(ready.ok, true);
  assert.equal(ready.note, undefined, 'a connected card has no sub-text; build and Chrome version stay in the details rows (Ken 11/3)');
});

test('retry success, failure, and busy state are visible and do not submit twice', async () => {
  let release;
  const calls = [], toasts = [];
  const context = vm.createContext({
    S: {automation:{browser:{extension:{connected:false}}}}, browserUpdateError:false, browserRetrying: false, browserRetryError: false, T: key => key,
    api: async route => { calls.push(route); return await new Promise(resolve => { release = resolve; }); },
    refresh: async () => {}, render: () => {}, extensionSuccessToast: async (...args) => toasts.push(args),
  });
  const body = section(" case'browserRetry':", " case'browserUpdate':");
  vm.runInContext('async function perform(name){switch(name){' + body + '}}', context);
  const pending = context.perform('browserRetry');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.browserRetrying, true);
  await context.perform('browserRetry');
  assert.equal(calls.length, 1);
  release({connected: true}); await pending;
  assert.equal(context.browserRetrying, false);
  assert.equal(context.browserRetryError, false);
  assert.equal(toasts.length, 1);

  context.api = async () => ({connected: false});
  await context.perform('browserRetry');
  assert.equal(context.browserRetryError, true);
});

test('update progress, failure fallback, and no-update incompatibility stay distinct', () => {
  for (const state of ['checking', 'waiting_idle', 'applying']) {
    const ctx = statusFixture({connected: false, installed: true, update: {state}});
    assert.equal(plain(vm.runInContext('capBrowser()', ctx)).res, `ui.chrome.store.updateState.${state}`);
  }
  const failed = statusFixture({connected: false, installed: true, update: {state: 'throttled'}});
  assert.equal(plain(vm.runInContext('capBrowser()', failed)).res, 'ui.chrome.store.updateFailed');
  const noUpdate = statusFixture({connected: true, compatibility: {state: 'incompatible'}, update: {state: 'no_update'}});
  const m = plain(vm.runInContext('capBrowser()', noUpdate));
  assert.equal(m.res, 'ui.chrome.store.updateFailed');
  assert.equal(m.act[1], 'chromeExtensionsManage');
});

test('update states and manual recovery copy exist in both languages', () => {
  for (const key of ['ui.chrome.store.checking', 'ui.chrome.store.updateState.checking', 'ui.chrome.store.updateState.waiting_idle', 'ui.chrome.store.updateState.applying', 'ui.chrome.store.manualRecovery', 'ui.chrome.store.updateButton', 'ui.chrome.store.checkUpdate']) {
    assert.ok(locales.zh[key], `zh ${key}`); assert.ok(locales.en[key], `en ${key}`);
  }
  assert.match(locales.zh['ui.chrome.store.manualRecovery'], /开发者模式/);
  assert.match(locales.zh['ui.chrome.store.retryFailed'], /请检查插件是否已开启/);
  assert.match(locales.en['ui.chrome.store.manualRecovery'], /Developer mode/);
  assert.match(source, /u\.state==='updated'/);
  assert.match(source, /openChromeExtensions/);
});

test('Browser settings keep install visible and leave other actions to the status box', () => {
  const pg = section('function pgBrowser()', 'function pgDesktop()');
  assert.match(pg, /ui\.chrome\.store\.install/);
  assert.doesNotMatch(pg, /ui\.chrome\.store\.(manage|reconnect)"/);
  assert.match(pg, /bs==='connected'&&x\.compatibility\?\.state!=='incompatible'/);
  assert.match(pg, /bs==='connected'&&x\.helper\?\.build/);
});

test('streamed update completion notifies once and no-update never claims success', () => {
  const toasts=[];const ctx=vm.createContext({S:{automation:{browser:{extension:{update:{id:'operation',state:'checking'}}}}},browserUpdatePending:false,browserUpdateNotice:'',browserUpdateError:true,browserFixPending:true,T:k=>k,toast:m=>toasts.push(m),extensionSuccessToast:m=>toasts.push(m)});
  vm.runInContext(section('function noteBrowserUpdate()', 'function noteBrowserFixed()'),ctx);
  ctx.noteBrowserUpdate();assert.equal(ctx.browserUpdatePending,true);
  ctx.S.automation.browser.extension.update.state='updated';ctx.noteBrowserUpdate();ctx.noteBrowserUpdate();
  assert.deepEqual(toasts,['ui.chrome.store.updated']);assert.equal(ctx.browserUpdateError,false);
  ctx.S.automation.browser.extension.update={id:'second',state:'checking'};ctx.noteBrowserUpdate();ctx.S.automation.browser.extension.update.state='no_update';ctx.noteBrowserUpdate();
  assert.deepEqual(toasts,['ui.chrome.store.updated','ui.chrome.store.noUpdate']);
});

test('progress and terminal status have valid status markup', () => {
  const ctx=vm.createContext({flash:null,icon:()=>'<i></i>',E:s=>s,btn:()=>'<button></button>'});
  vm.runInContext(source.split('\n').find(line=>line.startsWith('function dpRes(')),ctx);
  for(const model of [{spin:true,res:'Connecting'}, {ok:false,neutral:true,res:'Disconnected',note:'Check Chrome',act:['Manage','manage']}]){
    const html=ctx.dpRes(model,'browser');assert.match(html,/^<div class="[^"]*" role="status">/);assert.doesNotMatch(html,/class="[^">]*role=/);
  }
});

test('reconnect refused while busy cannot toast success from an existing connection', async () => {
 const notices=[];const ctx=vm.createContext({S:{automation:{browser:{extension:{connected:true}}}},browserRetrying:false,browserRetryError:false,browserUpdateError:false,T:k=>k,api:async()=>{throw Object.assign(Error('busy'),{code:'BROWSER_BUSY'});},refresh:async()=>{},render:()=>{},toast:m=>notices.push(m),extensionSuccessToast:()=>assert.fail('no reconnect completed')});
 vm.runInContext("async function run(){switch('browserRetry'){"+section(" case'browserRetry':", " case'browserUpdate':")+'}}',ctx);
 await ctx.run();assert.deepEqual(notices,['ui.chrome.store.retryBusy']);assert.equal(ctx.browserRetrying,false);
});

// Claude（Ken 11/2–11/3）：每种情况一个框、一句话；按钮跟框里的话对得上，能直接修好那件事。
test('each store state offers the action its sentence names', () => {
  const at = (extension, flags = {}) => { const ctx = statusFixture(extension); Object.assign(ctx, flags); return plain(vm.runInContext('capBrowser()', ctx)); };
  const actions = m => [m.act, ...(m.acts || [])].filter(Boolean).map(a => a[1]);
  const seen = {connected: false, installed: true, installation_previously_observed: true, last_seen: 1, compatibility: {state: 'compatible'}};

  // 读不到 Chrome 记录时照老样子：未连接、点「重新连接」；试了不行再给「打开扩展管理」「安装插件」两条路。
  const closed = at(seen);
  assert.equal(closed.res, 'ui.chrome.store.disconnected');
  assert.equal(closed.neutral, true);
  assert.equal(closed.note, undefined, 'no sentence about Chrome opening by itself');
  assert.deepEqual(actions(closed), ['browserRetry']);
  for (const [extension, flags] of [[seen, {browserRetryError: true}], [{...seen, wake: {connected: false}}, {}], [{...seen, presence: {state: 'unknown'}}, {browserRetryError: true}]]) {
    const failed = at(extension, flags);
    assert.equal(failed.neutral, undefined, 'a failed reconnect is a problem, not a neutral state');
    assert.equal(failed.note, 'ui.chrome.store.retryFailed');
    assert.deepEqual(actions(failed), ['chromeExtensionsManage', 'extensionSetup'], 'check it is on, or install it again');
  }

  // Chrome 记录说装着、开着：Chrome 没开也是绿的，什么都不用点。
  const enabled = at({...seen, presence: {state: 'enabled', chrome_running: false, stalled: false}});
  assert.equal(enabled.ok, true);
  assert.equal(enabled.tag, '');
  assert.equal(enabled.note, 'ui.chrome.store.installed');
  assert.deepEqual(actions(enabled), []);
  // 开着却一直连不上：只有这种给「重新连接」。
  for (const [presence, flags] of [[{state: 'enabled', chrome_running: true, stalled: true}, {}], [{state: 'enabled'}, {browserRetryError: true}]]) {
    const stalled = at({...seen, presence}, flags);
    assert.equal(stalled.ok, false);
    assert.equal(stalled.res, 'ui.chrome.store.stalled');
    assert.equal(stalled.tag, 'ui.chrome.store.tagStalled');
    assert.deepEqual(actions(stalled), ['browserRetry']);
  }
  // 被关了：去 Chrome 打开。
  const disabled = at({...seen, presence: {state: 'disabled'}});
  assert.equal(disabled.res, 'ui.chrome.store.disabled');
  assert.equal(disabled.tag, 'ui.chrome.store.tagDisabled');
  assert.deepEqual(actions(disabled), ['chromeExtensionDetails']);
  // 不在：以前见过是被删了（重新安装），没见过是还没装（安装插件）。
  const removed = at({...seen, presence: {state: 'missing'}});
  assert.equal(removed.res, 'ui.chrome.store.removed');
  assert.equal(removed.tag, 'ui.chrome.store.tagRemoved');
  assert.deepEqual(removed.act, ['ui.chrome.store.reinstall', 'extensionSetup']);
  assert.equal(removed.acts, undefined);
  const fresh = at({connected: null, installed: null, installation_previously_observed: false, presence: {state: 'missing'}});
  assert.equal(fresh.res, 'ui.chrome.store.notInstalled');
  assert.equal(fresh.neutral, true);
  assert.deepEqual(fresh.act, ['ui.chrome.store.install', 'extensionSetup']);
  // 被删、被关比「上回重连没成」更具体，先说它们。
  assert.equal(at({...seen, presence: {state: 'missing'}}, {browserRetryError: true}).res, 'ui.chrome.store.removed');
  assert.equal(at({...seen, presence: {state: 'disabled'}, wake: {connected: false}}).res, 'ui.chrome.store.disabled');
  // 连着就是绿的，过时的 presence 不管。
  assert.equal(at({...seen, connected: true, presence: {state: 'missing'}}).ok, true);
  // 正在连、正在更新：只转圈，没有按钮。
  for (const [extension, flags] of [[{...seen, presence: {state: 'disabled'}}, {browserRetrying: true}], [{...seen, update: {state: 'applying'}, presence: {state: 'enabled'}}, {}]]) {
    const spin = at(extension, flags);
    assert.equal(spin.spin, true);
    assert.deepEqual(actions(spin), []);
  }

  // 自动更新没成：照着手动更新，一个按钮；插件换新后自己连回来。
  const update = at({connected: true, compatibility: {state: 'incompatible'}, update: {state: 'failed'}});
  assert.deepEqual(actions(update), ['chromeExtensionsManage'], 'manual update only');
  for (const state of ['failed', 'unsupported', 'throttled', 'disconnected']) {
    const usable = at({connected: true, compatibility: {state: 'compatible'}, update: {state}});
    assert.equal(usable.ok, true, `${state}: a working extension stays green`);
    assert.equal(usable.act, undefined);
  }
});

test('turn on in Chrome opens the extension page, falling back to the extensions list on older ChatHand', async () => {
  const run = async replies => {
    const calls = [], toasts = [];
    const ctx = vm.createContext({browserFixPending: false, T: k => k, toast: m => toasts.push(m), native: async action => { calls.push(action); const r = replies[action]; if (r instanceof Error) throw r; return r; }});
    vm.runInContext("async function run(){switch('chromeExtensionDetails'){" + section(" case'chromeExtensionDetails':", '\n') + '}}', ctx);
    await ctx.run();
    return {calls, toasts, pending: ctx.browserFixPending};
  };
  assert.deepEqual(plain(await run({openChromeExtensionDetails: {opened: true}})), {calls: ['openChromeExtensionDetails'], toasts: [], pending: true});
  assert.deepEqual(plain(await run({openChromeExtensionDetails: {error: 'NATIVE_ACTION_UNKNOWN'}, openChromeExtensions: {opened: true}})), {calls: ['openChromeExtensionDetails', 'openChromeExtensions'], toasts: [], pending: true});
  assert.deepEqual(plain(await run({openChromeExtensionDetails: {opened: false}})), {calls: ['openChromeExtensionDetails'], toasts: ['ui.chrome.store.manageFailed'], pending: false});
  assert.deepEqual(plain(await run({openChromeExtensionDetails: new Error('bridge')})), {calls: ['openChromeExtensionDetails'], toasts: ['ui.chrome.store.manageFailed'], pending: false});
});

test('new extension states have copy in both languages', () => {
  for (const key of ['removed', 'reinstall', 'tagRemoved', 'disabled', 'disabledNote', 'turnOn', 'tagDisabled', 'stalled', 'stalledNote', 'tagStalled', 'installed', 'installedChrome', 'rowInstalled', 'notInstalled']) {
    assert.ok(locales.zh[`ui.chrome.store.${key}`], `zh ${key}`); assert.ok(locales.en[`ui.chrome.store.${key}`], `en ${key}`);
  }
  for (const lang of ['zh', 'en']) assert.match(locales[lang]['ui.chrome.store.installedChrome'], /\{chrome\}/);
  assert.equal(locales.zh['ui.chrome.store.autoOpen'], undefined, 'the “ChatHand opens Chrome by itself” sentence is gone');
});

test('the status box and the links below never repeat an action', () => {
  const ctx = vm.createContext({S: {}, T: k => k, TH: k => k, E: String, btn: (t, a) => `[${a}]`, tbtn: (t, a) => `{${a}}`,
    capOn: () => true, browserOn: () => false, helperNeedsHand: () => false, extRepairUnsupported: false, browserRetrying: false, browserRetryError: false, browserUpdateError: false, browserUpdating: false,
    browserRepairNotice: false, reconnectConfirm: false, flash: null, icon: () => '', dpHead: () => '', kvRow: () => '', browserBackends: () => [['extension', 'Extension']],
    timed: () => '', ago: () => '', helperFolderGuide: () => '', folderScopeNote: () => ''});
  vm.runInContext(source.split('\n').find(line => line.startsWith('function browserState()')) + '\n' + source.split('\n').find(line => line.startsWith('function dpRes(')) + '\n' + section('function capBrowser()', 'function capDesktop()') + '\n' + section('function pgBrowser()', 'function pgDesktop()'), ctx);
  const base = {distribution: 'chrome_web_store', configuration_state: 'ready', connected: false, installed: true, installation_previously_observed: true, last_seen: 1, compatibility: {state: 'compatible'}};
  const cases = [[{installed: null, installation_previously_observed: false, last_seen: null}], [{}], [{}, {browserRetryError: true}], [{presence: {state: 'enabled'}}], [{presence: {state: 'enabled', stalled: true}}], [{presence: {state: 'disabled'}}], [{presence: {state: 'missing'}}],
    [{installed: null, installation_previously_observed: false, last_seen: null, presence: {state: 'missing'}}], [{wake: {connected: false}}],
    [{connected: true}], [{connected: true, compatibility: {state: 'incompatible'}}], [{connected: true, compatibility: {state: 'incompatible'}, update: {state: 'failed'}}],
    [{connected: true, update: {state: 'waiting_idle'}}], [{connected: true, update: {state: 'throttled'}}]];
  for (const [extension, flags = {}] of cases) {
    Object.assign(ctx, {browserRetryError: false}, flags);
    ctx.S = {settings: {browser_enabled: true}, automation: {browser: {extension: {...base, ...extension}}}};
    const html = vm.runInContext('pgBrowser()', ctx), actions = [...html.matchAll(/[\[{](\w+)[\]}]/g)].map(m => m[1]);
    assert.equal(new Set(actions).size, actions.length, JSON.stringify([extension, flags, actions]));
    assert.ok(actions.includes('extensionSetup'), 'install is always somewhere on the page');
  }
});

test('two buttons in one status box sit in one row with the first as the main one', () => {
  const ctx = vm.createContext({flash: null, icon: () => '', E: s => s, btn: (t, a, id, cls) => `<button class="${cls}">${a}</button>`});
  vm.runInContext(source.split('\n').find(line => line.startsWith('function dpRes(')), ctx);
  const html = ctx.dpRes({res: 'x', note: 'y', act: ['A', 'first'], acts: [['B', 'second']]}, 'browser');
  assert.match(html, /<span class="dp-res-acts"><button class="sm primary">first<\/button><button class="sm">second<\/button><\/span>/);
  assert.equal(html.match(/<button/g).length, 2);
});

test('a refused reconnect while a task runs only says so once', async () => {
  const notices = [];
  const ctx = vm.createContext({S: {automation: {browser: {extension: {connected: false}}}}, browserRetrying: false, browserRetryError: false, browserUpdateError: false, T: k => k,
    api: async () => { throw Object.assign(Error('busy'), {code: 'BROWSER_BUSY'}); }, refresh: async () => {}, render: () => {}, toast: m => notices.push(m), extensionSuccessToast: () => assert.fail('not connected')});
  vm.runInContext("async function run(){switch('browserRetry'){" + section(" case'browserRetry':", " case'browserUpdate':") + '}}', ctx);
  await ctx.run();
  assert.equal(ctx.browserRetryError, false, 'busy is not a state of the extension: the box stays as it was');
  assert.deepEqual(notices, ['ui.chrome.store.retryBusy'], 'one line says to try again when the task is done');
});
