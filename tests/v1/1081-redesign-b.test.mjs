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
// 浏览器状态只在插件真实连接时显示可用；商店版重连走 browserRetry，更新失败提供 Chrome 扩展管理手动入口。
// Chrome 未打开不报错；历史安装记录不作为在线状态。legacy_unpacked 保留原重连入口。
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

test('authorized browser work without installation history wakes Chrome and completes after a fresh handshake', async t => {
  const b = browser(t, {installed: false});
  const running=b.ext.request('snapshot', {}, 'caller', 'task');
  await b.deliver({ok:true});
  assert.deepEqual(await running,{ok:true});
  assert.equal(b.opened.length,1);
  assert.equal(b.ext.status().installed,true);
});

test('1081 B: checking whether a chat is still generating never opens Chrome; without a way to open Chrome it refuses as before', t => {
  const b = browser(t);
  assert.throws(() => b.ext.request('detect_generating_chat', {}, 'caller', 'task'), {code: 'EXTENSION_DISCONNECTED'});
  assert.equal(b.opened.length, 0);
  b.ext.wakeChrome = null; // 测试、隔离运行
  assert.throws(() => b.ext.request('snapshot', {}, 'caller', 'task'), {code: 'EXTENSION_DISCONNECTED'});
});

test('1081 B: ChatHand opened Chrome and the extension still did not connect: show reconnect and extension management steps', async t => {
  const b = browser(t, {waitMs: 300});
  b.ext.wakeChrome = () => { b.opened.push(Date.now()); }; // Chrome 开了，插件没来（被关掉或删了）
  await assert.rejects(b.ext.request('snapshot', {}, 'caller', 'task'), e => {
    assert.equal(e.code, 'EXTENSION_DISCONNECTED');
    assert.equal(e.message, zh['ui.window.capBrowser.wakeFailed.res'] + '。', 'ChatGPT hears the same sentence the window shows');
    assert.match(e.recovery, /「重新连接」/);
    assert.match(e.recovery, /「打开扩展管理」/);
    assert.doesNotMatch(e.message + e.recovery, /多半|可能是|打开插件页面/);
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
  assert.equal(failedItem.action.kind, 'manage_chrome_extensions');
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
  assert.equal(mismatchItem.action.kind, 'update_chrome_extension', 'D07: reinstalling the same extension would not help');
  assert.equal(mismatchItem.message, zh['ui.server.repair.browser_helper.mismatch.message']);
  assert.equal(mismatch.calls.open, 0);

  const never = repairHarness(t, {connected: false, installed: null, last_seen: null, compatibility: {state: 'unknown'}});
  assert.equal((await never.item()).action.kind, 'manage_chrome_extensions');
  assert.equal(never.calls.open, 1, 'a missing installation observation is not proof that the extension was removed');

  // 窗口里这三个按钮各去哪儿
  const ctx = vm.createContext({CHATGPT_URL: 'https://chatgpt.com/'});
  vm.runInContext(app.split('\n').find(l => l.startsWith('const REPAIR_ACTIONS=')) + '\nthis.actions=REPAIR_ACTIONS;', ctx);
  assert.deepEqual(plain(ctx.actions.manage_chrome_extensions), ['chromeExtensionsManage', '']);
  assert.deepEqual(plain(ctx.actions.update_chrome_extension), ['browserUpdate', '']);
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
  assert.equal((await run({ext: {connected: false, installed: null, last_seen: null}})).woke, 1, 'the extension may still be installed; wake once before giving up');
  // 旧装法也一样，没成时那句不猜原因
  assert.deepEqual(await run({ext: {connected: false, last_seen: 1}, legacy: true, wakeConnects: true}), {result: {ok: true}, woke: 1});
  const legacy = await run({ext: {connected: false, last_seen: 1}, legacy: true, wakeConnects: false});
  assert.equal(legacy.result.message, 'Chrome 插件未连接，无法自动点击。');
  assert.equal(legacy.result.message, zh['ui.server.refresh.message.unavailable.notConnected']);
});

test('1081 B: store setup items require a live connection; legacy retains installation history behavior', () => {
  const state = {data: {mode: 'auto', browser_enabled: true, terminal_enabled: true}, project: () => ({path: '/synthetic'})};
  const item = browser => setupOpenItems(state, {browser}).find(i => i.id === 'browser');
  assert.equal(item({backend: 'extension', connected: true}).status, 'done');
  const closed = item({backend: 'extension', distribution: 'chrome_web_store', connected: false, installed: true, last_seen: 1, wake: null});
  assert.equal(closed.status, 'todo');
  assert.equal(closed.detail.connected, false, 'historical installation is not a connected state');
  assert.equal(item({backend: 'extension', distribution: 'chrome_web_store', connected: false, installed: true, wake: {at: 1, connected: false}}).status, 'todo');
  assert.equal(item({backend: 'extension', distribution: 'chrome_web_store', connected: false, installed: null, last_seen: null}).status, 'todo');
  assert.equal(item({backend: 'extension', distribution: 'legacy_unpacked', connected: false, installed: true, last_seen: 1}).status, 'done', 'legacy install evidence remains supported');

  const host = fs.readFileSync(new URL('../../ui/h10/host.mjs', import.meta.url), 'utf8');
  const linked = vm.runInNewContext(host.split('\n').find(l => l.startsWith('const browserLinked=')) + '\nbrowserLinked');
  const at = (extension, personal) => linked({automation: {browser: {extension, ...(personal ? {personal} : {})}}});
  assert.equal(at({distribution: 'legacy_unpacked', connection_state: 'connected'}), true);
  assert.equal(at({distribution: 'chrome_web_store', connected: false, installed: true}), false);
  assert.equal(at({distribution: 'chrome_web_store', connected: false, last_seen: 1}), false);
  assert.equal(at({connected: false, installed: true, wake: {connected: false}}), false);
  assert.equal(at({connected: false, installed: null}), false);
  assert.equal(at({}, {connected: true}), true);

  const wizard = fs.readFileSync(new URL('../../ui/wizard.js', import.meta.url), 'utf8');
  assert.match(wizard, /window\.ChatHandText\.t\(detail\.connected===false\?"ui\.wizard\.browserInstalled":"ui\.wizard\.connected"\)/);
  assert.match(wizard, /detail\.installed&&!detail\.connected&&!browserStore\(\)\?window\.ChatHandText\.t\("ui\.wizard\.browserAwaitChrome"\)/, 'no “waiting for Chrome” line for the store extension');
});

test('1081 B recovery UI: Browser Use separates ChatGPT, extension installation, connection and update states', () => {
  const ctx = vm.createContext({S: {}, T: k => k, TH: (k, p) => k + (p ? JSON.stringify(p) : ''), E: String, btn: (text, action) => `[${text}|${action}]`, tbtn: (text, action) => `{${text}|${action}}`,
    capOn: () => true, browserOn: () => false, helperNeedsHand: () => false, extRepairUnsupported: false, browserRetrying: false, browserRetryError: false, browserUpdateError: false, browserUpdating: false,
    dpHead: () => '', dpRes: m => `<res:${m.res}|${m.act ? m.act[1] : (m.acts || []).map(a => a[1]).join(',')}${m.note ? '|' + m.note : ''}${m.notes ? '|' + m.notes.join(',') : ''}>`, kvRow: (k, v) => `<${k}=${v}>`, browserBackends: () => [['extension', 'Extension']],
    icon: () => '', timed: () => '', ago: () => '', helperFolderGuide: () => '', folderScopeNote: () => ''});
  const pg = app.slice(app.indexOf('function pgBrowser()'), app.indexOf('\nfunction ', app.indexOf('function pgBrowser()') + 1));
  vm.runInContext('var browserRepairNotice=false,reconnectConfirm=false;\n' + app.split('\n').find(l => l.startsWith('function browserState()')) + '\n' + app.slice(app.indexOf('function capBrowser()'), app.indexOf('function capDesktop()')) + '\n' + pg, ctx);
  const page = extension => { ctx.S = {settings: {browser_backend: 'extension', browser_enabled: true}, automation: {browser: {extension: {distribution: 'chrome_web_store', configuration_state: 'ready', connected: false, connection_state: 'disconnected', installed: true, installation_previously_observed: true, last_seen: 1, compatibility: {state: 'compatible'}, helper: {build: 1092}, ...extension}, personal: {connected: false, chrome: {version: '140.0.7339.80'}}}}}; return vm.runInContext('pgBrowser()', ctx); };

  const closed = page({});
  assert.match(closed, /<res:ui\.chrome\.store\.disconnected\|browserRetry>/, 'Chrome being closed shows a neutral disconnected state');
  assert.doesNotMatch(closed, /capBrowser\.connectedBuild|<ui\.window\.pgBrowser\.text4=/, 'a disconnected extension version is not presented as current');
  assert.match(closed, /\{ui\.chrome\.store\.install\|extensionSetup\}/, 'install remains available');
  // Ken 11/2：底下只常留「安装插件」；「打开扩展管理」「重新连接」只在上面的框里，不重复。
  assert.doesNotMatch(closed, /\{ui\.chrome\.store\.(manage|reconnect)\|/, 'other actions live only in the status box');

  const missing = page({installed: null, installation_previously_observed: false, last_seen: null, helper: null});
  assert.match(missing, /<res:ui\.chrome\.store\.notInstalled\|extensionSetup>/, 'never seen connected: install from the status box');
  assert.doesNotMatch(missing, /\{ui\.chrome\.store\.install\|extensionSetup\}/, 'install is not repeated below the box');
  assert.match(missing, /<ui\.window\.pgBrowser\.text2=ui\.window\.pgBrowser\.text3>/, 'the extension row agrees with the box');

  // Claude（Ken 11/3）：后台读到 Chrome 自己的记录（presence）时，框和「Chrome 插件」那一行说同一件事。
  const enabled = page({presence: {state: 'enabled'}});
  assert.match(enabled, /<res:ui\.window\.capBrowser\.res\.text5\|\|ui\.chrome\.store\.installedChrome>/, 'installed and on, Chrome just closed: ready, nothing to click');
  assert.match(enabled, /<ui\.window\.pgBrowser\.text2=ui\.chrome\.store\.rowInstalled>/);
  assert.match(enabled, /\{ui\.chrome\.store\.install\|extensionSetup\}/);
  const off = page({presence: {state: 'disabled'}});
  assert.match(off, /<res:ui\.chrome\.store\.disabled\|chromeExtensionDetails\|ui\.chrome\.store\.disabledNote>/);
  assert.match(off, /<ui\.window\.pgBrowser\.text2=ui\.chrome\.store\.tagDisabled>/);
  const removed = page({presence: {state: 'missing'}});
  assert.match(removed, /<res:ui\.chrome\.store\.removed\|extensionSetup>/);
  assert.match(removed, /<ui\.window\.pgBrowser\.text2=ui\.chrome\.store\.tagRemoved>/);
  assert.doesNotMatch(removed, /\{ui\.chrome\.store\.install\|extensionSetup\}/, 'reinstall is not repeated below the box');

  const connected = page({connected: true, connection_state: 'connected'});
  assert.match(connected, /<res:ui\.window\.capBrowser\.res\.text5\|/, 'only a connected extension gets ready state');
  assert.match(connected, /<ui\.window\.pgBrowser\.text4=.*"build":"1092"/);
  assert.match(connected, /\{ui\.chrome\.store\.checkUpdate\|browserUpdate\}/);

  const incompatible = page({connected: true, connection_state: 'connected', compatibility: {state: 'incompatible'}});
  assert.match(incompatible, /<res:ui\.chrome\.store\.resOld\|browserUpdate\|ui\.chrome\.store\.oldText>/);
  assert.doesNotMatch(incompatible, /从 Chrome 中移除|remove from Chrome/i);
  assert.match(incompatible, /\{ui\.chrome\.store\.install\|extensionSetup\}/);
  assert.doesNotMatch(incompatible, /\{ui\.chrome\.store\.(manage|reconnect|checkUpdate)\|/, 'only the box offers the update');

  ctx.browserUpdateError = true;
  const failed = page({connected: true, connection_state: 'connected', compatibility: {state: 'incompatible'}});
  ctx.browserUpdateError = false;
  assert.match(failed, /<res:ui\.chrome\.store\.updateFailed\|chromeExtensionsManage\|ui\.chrome\.store\.manualRecovery>/);
  assert.doesNotMatch(failed, /从 Chrome 中移除/);

  // 本地测试版仍保留原有重连动作。
  ctx.S.automation.browser.extension = {distribution: 'legacy_unpacked', connection_state: 'disconnected', last_seen: 1};
  assert.match(vm.runInContext('pgBrowser()', ctx), /<res:ui\.window\.capBrowser\.res\.text6\|browserReconnect>/);
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
  for (const k of ['ui.chrome.store.resOld', 'ui.chrome.store.updateTitle', 'ui.chrome.store.tagMismatch', 'ui.chrome.store.versionOld', 'ui.chrome.store.versionNewer']) {
    assert.doesNotMatch(zh[k], /旧|对不上|分钟|小时|几天|；/, k);
    assert.doesNotMatch(en[k], /too old|outdated|minute|hour|day|;/i, k);
  }
  assert.equal(zh['ui.chrome.store.versionNewer'], '{openSmall}有新版本{closeSmall}');
  assert.ok(zh['ui.chrome.store.manualRecovery'].includes('开发者模式') && zh['ui.chrome.store.manualRecovery'].includes('更新'));
  assert.ok(en['ui.chrome.store.manualRecovery'].includes('Developer mode') && en['ui.chrome.store.manualRecovery'].includes('Update'));
  assert.doesNotMatch(zh['ui.chrome.store.manualRecovery'] + zh['ui.chrome.store.retryFailed'], /从 Chrome 中移除|重新添加/);
  assert.doesNotMatch(en['ui.chrome.store.manualRecovery'] + en['ui.chrome.store.retryFailed'], /remove and reinstall|remove from Chrome/i);
});
