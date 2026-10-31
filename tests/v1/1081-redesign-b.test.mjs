import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {Repair} from '../../app/v1/repair.mjs';
import {ToolsRefresher} from '../../app/v1/tools-refresh.mjs';
import {setupOpenItems} from '../../app/v1/permissions.mjs';
import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';

// 1081 B 线（Ken 10/27 02:19，ChatGPT 复查 D03/D06/D07/D08）：
// Chrome 只是没开不算出错，界面上什么都不说；AI 要用浏览器时 ChatHand 自己在后台打开 Chrome，等插件连上接着做。
// 只有真出了问题才报，按原因只给一个按钮：没装插件「安装 Chrome 插件」；打开了 Chrome 插件还是没连上「打开插件页面」；
// 这台 Mac 上打不开 Chrome「下载 Chrome」；插件和 ChatHand 版本对不上「打开插件页面」（不重装）。
const zh = JSON.parse(fs.readFileSync(new URL('../../locales/zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8'));
const app = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const distribution = storeTestDistribution();

function browser(t, {installed = true, waitMs = 600} = {}) {
  const state = {data: {browser_enabled: true, mode: 'auto', ...(installed ? {chrome_store_observation: {extension_id: distribution.extension_id, last_seen: Date.now() - 3600e3}} : {})}, project: () => ({path: '/synthetic'}), save() {}};
  const emitted = [], opened = [];
  const policy = {epoch: 1, check() {}, require() {}, emit: (kind, data) => emitted.push([kind, data]), tasks: new Map([['task', {status: 'active'}]])};
  const ext = new ExtensionBrowser(state, {}, policy, {distribution});
  ext.wakeWaitMs = waitMs;
  t.after(() => ext.closeAll());
  const session = crypto.randomUUID(), helper = storeTestHelper();
  // 假的「在后台打开 Chrome」：插件过一会儿自己连上
  ext.wakeChrome = () => { opened.push(Date.now()); setTimeout(() => ext.next(session, helper), 30); };
  const deliver = async result => { await until(() => ext.pending.size > 0); const sent = ext.next(session, helper); assert.equal(sent.kind, 'request'); assert.equal(ext.authorize(session, sent.id).authorized, true); ext.complete(session, sent.id, result); return sent; };
  return {state, policy, ext, session, helper, opened, emitted, deliver};
}

test('1081 B: the extension is installed and Chrome is just closed: ChatHand opens Chrome itself and the action goes through', async t => {
  const b = browser(t);
  assert.equal(b.ext.status().connected, false);
  assert.equal(b.ext.status().wake, null, 'nothing has gone wrong yet');
  const running = b.ext.request('snapshot', {}, 'caller', 'task');
  assert.ok(running instanceof Promise, 'waking Chrome is the only path that returns a promise instead of throwing');
  const sent = await b.deliver({ok: true});
  assert.equal(sent.action, 'snapshot');
  assert.deepEqual(await running, {ok: true});
  assert.equal(b.opened.length, 1);
  assert.equal(b.ext.status().connected, true);
  assert.equal(b.ext.status().wake, null);
});

test('1081 B: never installed: no Chrome is opened; the card and ChatGPT both say “Install Extension”', t => {
  const b = browser(t, {installed: false});
  let error;
  try { b.ext.request('snapshot', {}, 'caller', 'task'); } catch (e) { error = e; }
  assert.equal(error?.code, 'EXTENSION_NOT_CONNECTED', 'thrown synchronously, like every other refusal');
  assert.equal(b.opened.length, 0);
  assert.equal(error.message, '还没装 Chrome 插件。');
  assert.match(error.recovery, /「安装 Chrome 插件」/);
  assert.match(error.recovery, /「添加至 Chrome」和「添加扩展程序」/);
  assert.doesNotMatch(error.message + error.recovery, /辅助功能|自动安装|本人|多半|可能是/, 'D03: no promise of an automatic install');
  const receipt = error.details.blocked;
  assert.equal(receipt.item.id, 'install');
  assert.equal(receipt.where.path, zh['card.blocked.browser.whereInstall']);
  assert.equal(receipt.cause, error.message, 'D08: the receipt sentence is the reason, not a tool name');
  assert.equal(error.details.where_to_enable, 'ChatHand →「浏览器控制」');
});

test('1081 B: checking whether a chat is still generating never opens Chrome; without a way to open Chrome it refuses as before', t => {
  const b = browser(t);
  assert.throws(() => b.ext.request('detect_generating_chat', {}, 'caller', 'task'), {code: 'EXTENSION_DISCONNECTED'});
  assert.equal(b.opened.length, 0);
  b.ext.wakeChrome = null; // 测试、隔离运行
  assert.throws(() => b.ext.request('snapshot', {}, 'caller', 'task'), {code: 'EXTENSION_DISCONNECTED'});
});

test('1081 B: ChatHand opened Chrome and the extension still did not connect: one clear reason, “Open Extension Page”, and no reopening for a minute', async t => {
  const b = browser(t, {waitMs: 300});
  b.ext.wakeChrome = () => { b.opened.push(Date.now()); }; // Chrome 开了，插件没来（被关掉或删了）
  await assert.rejects(b.ext.request('snapshot', {}, 'caller', 'task'), e => {
    assert.equal(e.code, 'EXTENSION_DISCONNECTED');
    assert.equal(e.message, zh['ui.window.capBrowser.wakeFailed.res'] + '。', 'ChatGPT hears the same sentence the window shows');
    assert.match(e.recovery, /「打开插件页面」/);
    assert.doesNotMatch(e.message + e.recovery, /多半|可能是|重新连接/);
    assert.equal(e.details.blocked.item.id, 'connect');
    assert.equal(e.details.blocked.where.path, zh['card.blocked.browser.where']);
    assert.equal(e.details.blocked.cause, e.message);
    return true;
  });
  assert.equal(b.opened.length, 1);
  assert.equal(b.ext.status().wake.connected, false, 'the window reads this and says what went wrong');
  assert.equal(b.ext.status().wake.chrome_open_failed, undefined);
  await assert.rejects(b.ext.request('click', {}, 'caller', 'task'), {code: 'EXTENSION_DISCONNECTED'});
  assert.equal(b.opened.length, 1, 'ChatGPT retrying does not open Chrome again and again');
  assert.equal(await b.ext.wakeAndWait({force: true}), false);
  assert.equal(b.opened.length, 2, '“Check and Repair” is the user asking, so it tries again');
  b.ext.next(b.session, b.helper);
  assert.equal(b.ext.wake, null, 'the moment the extension connects, the problem is gone');
  assert.equal(b.ext.status().wake, null);
});

test('1081 B: Chrome will not open on this Mac: “Download Chrome”', async t => {
  const b = browser(t, {waitMs: 300});
  b.ext.wakeChrome = () => { b.opened.push(Date.now()); throw Error('CHROME_OPEN_FAILED'); };
  await assert.rejects(b.ext.request('snapshot', {}, 'caller', 'task'), e => {
    assert.equal(e.message, zh['ui.window.capBrowser.noChrome.res'] + '。');
    assert.match(e.recovery, /Google Chrome/);
    assert.equal(e.details.blocked.where.path, zh['card.blocked.browser.whereChrome']);
    return true;
  });
  assert.deepEqual(plain(b.ext.status().wake), {at: b.ext.wake.at, connected: false, chrome_open_failed: true});
});

test('1081 B: several actions at once open Chrome only once', async t => {
  const b = browser(t);
  const first = b.ext.wakeAndWait(), second = b.ext.wakeAndWait();
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(b.opened.length, 1);
});

test('1081 B: the connection drops in the middle of an action: the action stops, but there is nothing for the user to fix, so no blocked card', async t => {
  const b = browser(t);
  b.ext.next(b.session, b.helper);
  const running = b.ext.request('click', {}, 'caller', 'task');
  await until(() => b.ext.pending.size > 0);
  b.ext.lastSeen = Date.now() - 8000; // 插件 7 秒没消息：Chrome 被关了
  b.ext.connectionLost();
  await assert.rejects(running, e => {
    assert.equal(e.code, 'EXTENSION_DISCONNECTED');
    assert.equal(e.details.blocked, undefined, 'Chrome being closed is not a problem the user has to handle');
    assert.equal(e.details.replay_safe, false);
    assert.match(e.recovery, /ChatHand 会自己打开 Chrome/);
    assert.match(e.recovery, /不要重放/);
    return true;
  });
  const lost = b.emitted.find(([kind]) => kind === 'browser_connection_lost');
  assert.ok(lost, 'the window still gets the notice');
  assert.doesNotMatch(lost[1].message + lost[1].recovery, /多半|可能是|停用/);
});

function repairHarness(t, ext, open = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1081b-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const s = {enabled: true, mode: 'full', settings: {browser_enabled: true, desktop_enabled: false, tunnel: {tunnel_id: 'test-only'}}, credentials: {healthy: true}, connection: {process_running: true, ready: true, healthy: true, control_plane: {state: 'up', proxy: 'http://127.0.0.1:7890'}}, automation: {browser: {extension: {...ext}}, computer: {permissions: {accessibility: true, screen_recording: true}}}, setup_test: {status: 'read_write'}};
  let now = 0; const calls = {open: 0}, noted = [];
  const host = {manifestPath: path.join(dir, 'com.kenyu.chathand.browser.json'), expectedBinary: path.join(dir, 'ken-browser-host'), register() { fs.writeFileSync(host.manifestPath, JSON.stringify({name: 'com.kenyu.chathand.browser', path: host.expectedBinary, type: 'stdio', allowed_origins: ['chrome-extension://' + distribution.extension_id + '/']})); }};
  const repair = new Repair({distribution, snapshot: () => s, now: () => now, sleep: async ms => { now += ms; }, systemProxy: () => 'http://127.0.0.1:7890', probePort: async () => false, browserHost: host, restoreTunnel: async () => {}, openChromeInBackground: async () => { calls.open++; await open(s.automation.browser.extension); }, noteWakeFailed: o => noted.push(o), cleanupUpgrade: async () => ({cleaned: 0})});
  const item = async () => { const running = repair.start({}); for (let i = 0; i < 300 && running.status === 'running'; i++) await new Promise(r => setImmediate(r)); assert.equal(running.status, 'done'); return plain(running.items.find(i => i.id === 'browser_helper')); };
  return {calls, noted, item};
}

test('1081 B: “Check and Repair” opens Chrome for an installed extension and names the real problem when it is still not connected', async t => {
  const installed = {connected: false, installed: true, last_seen: 1, compatibility: {state: 'unknown'}};

  const fixed = repairHarness(t, installed, async x => Object.assign(x, {connected: true, compatibility: {state: 'compatible'}}));
  assert.equal((await fixed.item()).status, 'fixed');
  assert.equal(fixed.calls.open, 1);
  assert.deepEqual(fixed.noted, []);

  const wakeFailed = repairHarness(t, installed);
  const failedItem = await wakeFailed.item();
  assert.equal(failedItem.status, 'action');
  assert.equal(failedItem.action.kind, 'open_extension_page');
  assert.equal(failedItem.message_key, 'repair.browser_helper.wakeFailed.message');
  assert.equal(failedItem.message, zh['ui.server.repair.browser_helper.wakeFailed.message']);
  assert.deepEqual(wakeFailed.noted, [{}], 'the browser page says the same thing');

  const noChrome = repairHarness(t, installed, async () => { throw Error('CHROME_OPEN_FAILED'); });
  const noChromeItem = await noChrome.item();
  assert.equal(noChromeItem.action.kind, 'download_chrome');
  assert.equal(noChromeItem.message, zh['ui.server.repair.browser_helper.noChrome.message']);
  assert.deepEqual(noChrome.noted, [{chrome_open_failed: true}]);

  const mismatch = repairHarness(t, {connected: true, installed: true, compatibility: {state: 'incompatible'}});
  const mismatchItem = await mismatch.item();
  assert.equal(mismatchItem.action.kind, 'open_store_page', 'D07: reinstalling the same extension would not help');
  assert.equal(mismatchItem.message, zh['ui.server.repair.browser_helper.mismatch.message']);
  assert.equal(mismatch.calls.open, 0);

  const never = repairHarness(t, {connected: false, installed: null, last_seen: null, compatibility: {state: 'unknown'}});
  assert.equal((await never.item()).action.kind, 'install_helper');
  assert.equal(never.calls.open, 0, 'nothing to wake when the extension was never installed');

  // 窗口里这三个按钮各去哪儿
  const ctx = vm.createContext({CHATGPT_URL: 'https://chatgpt.com/'});
  vm.runInContext(app.split('\n').find(l => l.startsWith('const REPAIR_ACTIONS=')) + '\nthis.actions=REPAIR_ACTIONS;', ctx);
  assert.deepEqual(plain(ctx.actions.open_extension_page), ['chromeStoreReconnect', '']);
  assert.deepEqual(plain(ctx.actions.open_store_page), ['chromeStoreOpen', '']);
  assert.deepEqual(plain(ctx.actions.download_chrome), ['chromeUpdate', '']);
  for (const kind of ['open_extension_page', 'open_store_page', 'download_chrome']) assert.ok(zh[`ui.server.repair.action.${kind}.label`] && en[`ui.server.repair.action.${kind}.label`], kind);
});

test('1081 B: refreshing ChatGPT tools wakes Chrome once before giving up', async t => {
  const run = async ({ext, legacy = false, wakeConnects}) => {
    let now = 0, woke = 0; const status = {selected_backend: 'extension', extension: {...ext}};
    const r = new ToolsRefresher({distribution: legacy ? legacyChromeDistribution() : distribution, invoke: async name => { assert.equal(name, 'browser_status'); return plain(status); }, now: () => now, sleep: async ms => { now += ms; },
      wakeChrome: async () => { woke++; if (wakeConnects) Object.assign(status.extension, {connected: true, compatibility: {state: 'compatible'}}); }});
    return {result: await r.waitHelper('manual'), woke};
  };
  const closed = {connected: false, installed: true, last_seen: 1, compatibility: {state: 'unknown'}};
  assert.deepEqual(await run({ext: closed, wakeConnects: true}), {result: {ok: true}, woke: 1});
  const failed = await run({ext: closed, wakeConnects: false});
  assert.equal(failed.woke, 1, 'only once');
  assert.equal(failed.result.code, 'EXTENSION_DISCONNECTED');
  assert.equal((await run({ext: {connected: false, installed: null, last_seen: null}})).woke, 0);
  // 旧装法也一样，没成时那句不猜原因
  assert.deepEqual(await run({ext: {connected: false, last_seen: 1}, legacy: true, wakeConnects: true}), {result: {ok: true}, woke: 1});
  const legacy = await run({ext: {connected: false, last_seen: 1}, legacy: true, wakeConnects: false});
  assert.equal(legacy.result.message, 'Chrome 插件未连接，无法自动点击。');
  assert.equal(legacy.result.message, zh['ui.server.refresh.message.unavailable.notConnected']);
});

test('1081 B: the setup list and the H10 check count an installed extension as done while Chrome is closed, but not after a failed wake', () => {
  const state = {data: {mode: 'auto', browser_enabled: true, terminal_enabled: true}, project: () => ({path: '/synthetic'})};
  const item = browser => setupOpenItems(state, {browser}).find(i => i.id === 'browser');
  assert.equal(item({backend: 'extension', connected: true}).status, 'done');
  const closed = item({backend: 'extension', connected: false, installed: true, last_seen: 1, wake: null});
  assert.equal(closed.status, 'done');
  assert.equal(closed.detail.connected, false, 'the wizard shows “Installed” instead of “Connected”');
  assert.equal(item({backend: 'extension', connected: false, installed: true, wake: {at: 1, connected: false}}).status, 'todo');
  assert.equal(item({backend: 'extension', connected: false, installed: null, last_seen: null}).status, 'todo');

  const host = fs.readFileSync(new URL('../../ui/h10/host.mjs', import.meta.url), 'utf8');
  const linked = vm.runInNewContext(host.split('\n').find(l => l.startsWith('const browserLinked=')) + '\nbrowserLinked');
  const at = (extension, personal) => linked({automation: {browser: {extension, ...(personal ? {personal} : {})}}});
  assert.equal(at({connection_state: 'connected'}), true);
  assert.equal(at({connected: false, installed: true}), true);
  assert.equal(at({connected: false, last_seen: 1}), true);
  assert.equal(at({connected: false, installed: true, wake: {connected: false}}), false);
  assert.equal(at({connected: false, installed: null}), false);
  assert.equal(at({}, {connected: true}), true);

  const wizard = fs.readFileSync(new URL('../../ui/wizard.js', import.meta.url), 'utf8');
  assert.match(wizard, /window\.ChatHandText\.t\(detail\.connected===false\?"ui\.wizard\.browserInstalled":"ui\.wizard\.connected"\)/);
  assert.match(wizard, /detail\.installed&&!detail\.connected&&!browserStore\(\)\?window\.ChatHandText\.t\("ui\.wizard\.browserAwaitChrome"\)/, 'no “waiting for Chrome” line for the store extension');
});

test('1081 B: the Browser Use page: Chrome closed reads as installed, a real problem reads as what it is', () => {
  const ctx = vm.createContext({S: {}, T: k => k, TH: (k, p) => k + (p ? JSON.stringify(p) : ''), E: String, btn: (text, action) => `[${text}|${action}]`,
    capOn: () => true, browserOn: () => false, helperNeedsHand: () => false, extRepairUnsupported: false, browserRetrying: false,
    dpHead: () => '', dpRes: m => `<res:${m.res}|${m.act ? m.act[1] : (m.acts || []).map(a => a[1]).join(',')}${m.notes ? '|' + m.notes.join(',') : ''}>`, kvRow: (k, v) => `<${k}=${v}>`, browserBackends: () => [['extension', 'Extension']],
    icon: () => '', timed: () => '', ago: () => '', helperFolderGuide: () => '', folderScopeNote: () => ''});
  const pg = app.slice(app.indexOf('function pgBrowser()'), app.indexOf('\nfunction ', app.indexOf('function pgBrowser()') + 1));
  vm.runInContext('var browserRepairNotice=true,reconnectConfirm=false;\n' + app.split('\n').find(l => l.startsWith('function browserState()')) + '\n' + app.slice(app.indexOf('function capBrowser()'), app.indexOf('function capDesktop()')) + '\n' + pg, ctx);
  const page = (extension, personal) => { ctx.S = {settings: {browser_backend: 'extension'}, automation: {browser: {extension: {configuration_state: 'ready', connection_state: 'disconnected', ...extension}, ...(personal ? {personal} : {})}}}; return vm.runInContext('pgBrowser()', ctx); };
  const store = {distribution: 'chrome_web_store', installed: true, last_seen: 1};

  const closed = page(store);
  assert.match(closed, /ui\.window\.pgBrowser\.lostStore/, 'the strip after a dropped action says ChatGPT can continue');
  assert.doesNotMatch(closed, /\|chromeStoreReconnect\]|\|browserReconnect\]/, 'no button: there is nothing to fix');
  assert.match(closed, /<ui\.window\.pgBrowser\.text2=ui\.window\.pgBrowser\.installed>/);
  assert.match(closed, /<res:ui\.window\.capBrowser\.res\.text5\|>/);

  const failed = page({...store, wake: {at: 1, connected: false}});
  assert.match(failed, /ui\.window\.pgBrowser\.text\{"openSpan":"<span>","closeSpan":"<\/span>","btn":""\}/, 'the strip has no button of its own; the card below has one');
  assert.match(failed, /<ui\.window\.pgBrowser\.text2=ui\.window\.capBrowser\.wakeFailed\.tag>/);
  // 断言跟着 Ken 10/27 10:07 改：两个按钮，「插件被关掉了」「插件被删了」各一行
  assert.match(failed, /<res:ui\.window\.capBrowser\.wakeFailed\.res\|chromeStoreReconnect,browserRetry\|ui\.window\.capBrowser\.wakeFailed\.off,ui\.window\.capBrowser\.wakeFailed\.gone>/);

  const noChrome = page({...store, wake: {at: 1, connected: false, chrome_open_failed: true}});
  assert.match(noChrome, /<ui\.window\.pgBrowser\.text2=ui\.window\.capBrowser\.noChrome\.tag>/);
  assert.match(noChrome, /<res:ui\.window\.capBrowser\.noChrome\.res\|chromeUpdate>/);
  assert.match(page(store, {chrome: {installed: false}}), /<res:ui\.window\.capBrowser\.noChrome\.res\|chromeUpdate>/, 'Chrome missing from this Mac counts too');

  const legacy = page({distribution: 'legacy_unpacked', last_seen: 1});
  assert.match(legacy, /\[ui\.window\.capBrowser\.act\.text\|browserReconnect\]/, 'the old local install keeps “Reconnect”');
});

test('1081 B: the new sentences use plain words and name each button the way it is spelled', () => {
  const keys = ['ui.window.capBrowser.wakeFailed.res', 'ui.window.capBrowser.wakeFailed.off', 'ui.window.capBrowser.wakeFailed.gone', 'ui.window.capBrowser.noChrome.res', 'ui.window.pgBrowser.lostStore', 'ui.chrome.store.oldText', 'ui.window.faq.text8',
    'card.blocked.browser.where', 'card.blocked.browser.whereInstall', 'card.blocked.browser.whereChrome', 'native.notification.browserLost.body', 'ui.window.toolsRefreshNoteBody.helperFailedStoreDown', 'ui.window.toolsRefreshNoteBody.helperFailedStoreOld'];
  for (const k of keys) {
    assert.ok(zh[k] && en[k], k);
    assert.doesNotMatch(zh[k], /多半|可能是|大概|停用了|宿主|回执|凭据|握手|心跳|核验|这一?版 ChatHand/, k);
    assert.doesNotMatch(en[k], /probably|maybe|receipt|credential|handshake|heartbeat|verif|this build|Reconnect/i, k);
  }
  assert.ok(zh['ui.window.capBrowser.wakeFailed.gone'].includes(`「${zh['ui.chrome.store.openPage']}」`));
  assert.ok(en['ui.window.capBrowser.wakeFailed.gone'].includes(`“${en['ui.chrome.store.openPage']}”`));
  // D07 断言跟着 Ken 10/27 10:03 改：原来是「版本对不上」、不让人移除再添加。现在只有插件旧到用不了才报，像强制更新一样直说要更新，
  // 做法一句话（在插件页面移除再添加）；只缺后来加的动作照常用，版本那行只写「有新版本」。都不说「旧」、不说要等多久。
  for (const k of ['ui.chrome.store.resOld', 'ui.chrome.store.updateTitle', 'ui.chrome.store.tagMismatch', 'ui.chrome.store.versionOld']) assert.match(zh[k], /更新/, k);
  for (const k of ['ui.chrome.store.resOld', 'ui.chrome.store.updateTitle', 'ui.chrome.store.oldText', 'ui.chrome.store.tagMismatch', 'ui.chrome.store.versionOld', 'ui.chrome.store.versionNewer']) {
    assert.doesNotMatch(zh[k], /旧|对不上|分钟|小时|几天|；/, k);
    assert.doesNotMatch(en[k], /too old|outdated|minute|hour|day|;/i, k);
  }
  assert.equal(zh['ui.chrome.store.versionNewer'], '{openSmall}有新版本{closeSmall}');
  assert.ok(zh['ui.chrome.store.oldText'].includes(`「${zh['ui.chrome.store.openPage']}」`) && zh['ui.chrome.store.oldText'].includes('「从 Chrome 中移除」') && zh['ui.chrome.store.oldText'].includes('「添加至 Chrome」'));
  assert.doesNotMatch(zh['ui.chrome.store.oldText'], /自动/, 'unusable now: only what to do, not “it updates itself”');
});
