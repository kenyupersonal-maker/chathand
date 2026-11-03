import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 1081（Claude，ChatGPT 复查 D06，Ken 点过头）：应用店装的插件断了，按钮是「打开 Chrome」（chromeStoreReconnect）。
// 原来的「重新连接」只让后台重新等，不会打开 Chrome；插件断了多半是 Chrome 没开。现在打开插件那一页，Chrome 一开插件就自己连上，
// 弹框说「正在等插件连上」，不放「点这两下」的图，提醒页面上的按钮不用点；插件被移除了，才在那一页点「添加至 Chrome」。
// 1081（Ken 10/27 02:19）再改：Chrome 只是没开，卡片什么都不说，AI 要用浏览器时 ChatHand 自己打开 Chrome；
// ChatHand 打开了 Chrome 插件还是没连上，卡片才报，按钮是「打开插件页面」（chromeStoreReconnect）。
// 1081（Ken 10/27 10:07）又改：「插件被关掉了」「插件被删了」各占一行；点「再试一次」时只转圈说「正在连接…」，不写做法。
// 「打开插件页面」只在 Chrome 里打开那一页、关掉框、提示一句，不再弹转圈等着的框；连上了再提示一句。
const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const zh = JSON.parse(fs.readFileSync(new URL('../../locales/zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x));
const section = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return source.slice(start, end); };

// status 里的一项是 'fail' 时，查连接状态那一下报错。
function fixture({replies = [], status = [{connected: false, compatibility: {state: 'unknown'}}], published = true, update = {state: 'updated'}} = {}) {
  const views = [], log = [], toasts = [], timers = new Map(), dialog = {open: false, dataset: {}};
  let next = 0;
  const S = {automation: {browser: {extension: {distribution: 'chrome_web_store', store_published: published, configuration_state: 'ready'}}}, settings: {browser_enabled: true}};
  const context = vm.createContext({
    S, Date, E: String, T: (k, p) => k + (p ? JSON.stringify(p) : ''), TH: k => k, browserRetrying: false, browserRetryError: false, browserUpdateError: false, browserUpdating: false, browserUpdatePending: false, browserUpdateNotice: '',
    btn: (text, action, id = '', cls = '') => `[${text}|${action}|${id}|${cls}]`,
    tbtn: (text, action, id = '') => `{${text}|${action}|${id}}`,
    modal: (html, kind) => { views.push({html, kind}); dialog.open = true; dialog.dataset.kind = kind; },
    $: () => dialog,
    closeModal: async (cancel = true) => { log.push(['closeModal', cancel]); dialog.open = false; },
    native: async (action, data) => { log.push(['native', action, data]); return replies.length ? replies.shift() : {}; },
    api: async (route, body) => {
      log.push(['api', route, body]);
      if (route === '/api/browser/extension/store/status') { const r = status.length > 1 ? status.shift() : status[0]; if (r === 'fail') throw Object.assign(Error('X'), {code: 'X'}); return r; }
      if (route === '/api/browser/extension/update') { S.automation.browser.extension.update = update; if (update.state === 'updated') { S.automation.browser.extension.connected = true; S.automation.browser.extension.compatibility = {state: 'compatible'}; } return {ext: {update}}; }
      if (route === '/api/browser/extension/reconnect') return {connected: true};
      return {};
    },
    refresh: async () => {}, render: () => {}, capOn: k => S.settings[k] === true, toast: m => toasts.push(m), browserFixPending: false,
    extensionSuccessToast: async (m, kind) => toasts.push([m, kind]),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(section('let chromeInstallView=', 'function desktopSheet()'), context);
  vm.runInContext(source.split('\n').find(l => l.startsWith('function noteBrowserFixed()')), context);
  vm.runInContext(source.split('\n').find(l => l.startsWith('function noteBrowserUpdate()')), context);
  const cases = section(" case'extensionSetup':", " case'revealHelperFolder':");
  vm.runInContext('async function perform(name,id=""){switch(name){' + cases + '}}', context);
  const tick = async () => { const first = [...timers][0]; if (!first) return false; timers.delete(first[0]); await first[1](); return true; };
  const natives = () => plain(log.filter(x => x[0] === 'native').map(x => [x[1], x[2] ?? null]));
  return {context, views, log, toasts, timers, tick, natives, last: () => views.at(-1), run: (name, id) => context.perform(name, id)};
}

test('1081 recovery UI: disconnected or unobserved store extensions are neutral, and legacy reconnection stays separate', () => {
  const ctx = vm.createContext({S: {}, T: k => k, capOn: () => true, browserOn: () => false, helperNeedsHand: () => false, extRepairUnsupported: false, browserRetrying: false, browserRetryError: false, browserUpdateError: false, browserUpdating: false});
  const card = source.slice(source.indexOf('function capBrowser()'), source.indexOf('function capDesktop()'));
  vm.runInContext(source.split('\n').find(l => l.startsWith('function browserState()')) + '\n' + card, ctx);
  const at = (distribution, ext = {}) => { ctx.S = {automation: {browser: {extension: {distribution, configuration_state: 'ready', connected: false, connection_state: 'disconnected', installed: true, installation_previously_observed: true, last_seen: Date.now() - 3600e3, compatibility: {state: 'compatible'}, ...ext}}}}; return plain(vm.runInContext('capBrowser()', ctx)); };
  const disconnected = at('chrome_web_store');
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.neutral, true);
  assert.equal(disconnected.tag, '');
  assert.equal(disconnected.res, 'ui.chrome.store.disconnected');
  assert.deepEqual(disconnected.act, ['ui.chrome.store.reconnect', 'browserRetry']);
  const chromeClosed = at('chrome_web_store');
  assert.equal(chromeClosed.res, 'ui.chrome.store.disconnected', 'Chrome being closed is not an error');
  assert.deepEqual(chromeClosed.act, ['ui.chrome.store.reconnect', 'browserRetry']);
  const wakeFailed = at('chrome_web_store', {wake: {connected: false}});
  assert.equal(wakeFailed.res, 'ui.chrome.store.disconnected');
  assert.equal(wakeFailed.note, 'ui.chrome.store.retryFailed');
  assert.deepEqual(wakeFailed.act, ['ui.chrome.store.manage', 'chromeExtensionsManage']);

  ctx.browserRetrying = true;
  const retrying = at('chrome_web_store');
  ctx.browserRetrying = false;
  assert.equal(retrying.spin, true);
  assert.equal(retrying.res, 'ui.chrome.store.connecting');
  ctx.browserRetryError = true;
  const failed = at('chrome_web_store');
  ctx.browserRetryError = false;
  assert.equal(failed.res, 'ui.chrome.store.disconnected');
  assert.equal(failed.note, 'ui.chrome.store.retryFailed');
  assert.deepEqual(failed.act, ['ui.chrome.store.manage', 'chromeExtensionsManage']);
  assert.ok(zh['ui.chrome.store.retryFailed'].includes('检查插件是否已开启') && zh['ui.chrome.store.retryFailed'].includes('重新安装'));
  assert.ok(en['ui.chrome.store.retryFailed'].includes('enabled') && en['ui.chrome.store.retryFailed'].includes('install it again'));

  const missing = at('chrome_web_store', {installed: null, installation_previously_observed: false, last_seen: null});
  assert.equal(missing.neutral, true);
  // Ken 11/2：从没见插件连上过，就当还没装，按钮是「安装插件」（装过的点了也会在 Chrome 打开后自己连上）。
  assert.equal(missing.res, 'ui.chrome.store.notInstalled');
  assert.equal(missing.act[1], 'extensionSetup');
  const incompatible = at('chrome_web_store', {connected: true, connection_state: 'connected', compatibility: {state: 'incompatible'}});
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.act[1], 'browserUpdate');
  ctx.browserUpdateError = true;
  const updateFailed = at('chrome_web_store', {connected: true, compatibility: {state: 'incompatible'}});
  ctx.browserUpdateError = false;
  assert.equal(updateFailed.res, 'ui.chrome.store.updateFailed');
  assert.equal(updateFailed.note, 'ui.chrome.store.manualRecovery');
  assert.deepEqual(updateFailed.act, ['ui.chrome.store.manage', 'chromeExtensionsManage']);
  assert.ok(zh['ui.chrome.store.manualRecovery'].includes('开发者模式') && zh['ui.chrome.store.manualRecovery'].includes('更新'));
  assert.ok(en['ui.chrome.store.manualRecovery'].includes('Developer mode') && en['ui.chrome.store.manualRecovery'].includes('Update'));

  assert.deepEqual(at('legacy_unpacked').act, ['ui.window.capBrowser.act.text', 'browserReconnect']);
  assert.match(source, /api\('\/api\/browser\/extension\/reconnect',\{\}\)/);
  assert.match(source, /browserRetrying\)return/);
});

test('1081 (Ken 10/27 10:07): “Open Extension Page” only opens the page in Chrome, closes the box and says so; no spinning wait; connecting later says so once', async () => {
  const f = fixture({published: false, replies: [{opened: true, selected_profile: 'Default'}]});
  await f.run('chromeStoreReconnect');
  assert.deepEqual(f.natives(), [['openChromeStore', {}]], 'no intro first: the extension was already set up');
  assert.match(f.views[0].html, /^<h2>ui\.chrome\.store\.reconnectTitle<\/h2>/);
  assert.match(f.views[0].html, /<span class="spinner"[^>]*><\/span><span>ui\.chrome\.store\.opening<\/span>/, 'only “opening” spins: ChatHand is the one doing it');
  assert.equal(f.views.length, 1, 'no waiting box after the page opened');
  assert.equal(f.context.dialog?.open ?? vm.runInContext('$()', f.context).open, false, 'the box is closed');
  assert.deepEqual(plain(f.toasts), ['ui.chrome.store.pageOpened']);
  assert.equal(f.timers.size, 0, 'nothing polls');
  assert.equal(vm.runInContext('browserFixPending', f.context), true);
  assert.equal(vm.runInContext('chromeInstallActive', f.context), false);
  // 状态更新进来：还没连上不提示；连上了、能用，提示一句，只一次
  f.context.S.automation.browser.extension = {distribution: 'chrome_web_store', connected: false};
  vm.runInContext('noteBrowserFixed()', f.context);
  assert.deepEqual(plain(f.toasts), ['ui.chrome.store.pageOpened']);
  f.context.S.automation.browser.extension = {distribution: 'chrome_web_store', connected: true, compatibility: {state: 'compatible'}};
  vm.runInContext('noteBrowserFixed()', f.context);
  vm.runInContext('noteBrowserFixed()', f.context);
  assert.deepEqual(plain(f.toasts), ['ui.chrome.store.pageOpened', ['ui.window.capBrowser.connected', 'chrome-store']]);
  assert.equal(vm.runInContext('browserFixPending', f.context), false);
});

test('1081 recovery: an incompatible extension uses the update API and only an updated result reports success', async () => {
  const f = fixture({update: {state: 'updated', from_version: '1.0.0', target_version: '1.0.1'}});
  f.context.S.automation.browser.extension = {...f.context.S.automation.browser.extension, connection_state: 'connected', connected: true, compatibility: {state: 'incompatible'}};
  await f.run('browserUpdate');
  assert.equal(f.context.S.automation.browser.extension.compatibility.state, 'compatible', 'updated means the new extension reconnected');
  assert.ok(f.context.browserUpdateError === false);
  assert.ok(f.log.some(x => x[0] === 'api' && x[1] === '/api/browser/extension/update'));
  assert.deepEqual(plain(f.toasts), [['ui.chrome.store.updated', 'chrome-store']]);
  assert.deepEqual(f.natives(), [], 'no store page or remove-and-reinstall action');

  const checking = fixture({update: {state: 'checking'}});
  checking.context.S.automation.browser.extension = {distribution: 'chrome_web_store', connected: false, installed: true, update: {state: 'idle'}};
  await checking.run('browserUpdate');
  assert.deepEqual(plain(checking.toasts), [], 'checking does not say the extension is updated');
  checking.context.S.automation.browser.extension.update = {state: 'updated', from_version: '1.0.0', target_version: '1.0.1'};
  vm.runInContext('noteBrowserUpdate()', checking.context);
  assert.deepEqual(plain(checking.toasts), [['ui.chrome.store.updated', 'chrome-store']], 'the update push ends with the success confirmation');

  const noUpdate = fixture({update: {state: 'no_update', from_version: '1.0.0'}});
  noUpdate.context.S.automation.browser.extension = {distribution: 'chrome_web_store', connected: true, compatibility: {state: 'incompatible'}};
  await noUpdate.run('browserUpdate');
  assert.ok(!plain(noUpdate.toasts).some(t => Array.isArray(t) && t[0] === 'ui.chrome.store.updated'), 'no_update while incompatible is not success');
  assert.equal(noUpdate.context.S.automation.browser.extension.update.state, 'no_update');
  const failed = fixture({update: {state: 'throttled'}});
  failed.context.S.automation.browser.extension = {distribution: 'chrome_web_store', connected: true, compatibility: {state: 'incompatible'}};
  await failed.run('browserUpdate');
  assert.equal(failed.context.S.automation.browser.extension.update.state, 'throttled');
  assert.ok(!plain(failed.toasts).includes('ui.chrome.store.updated'));
  assert.ok(zh['ui.chrome.store.manualRecovery'].includes('开发者模式') && !/从 Chrome 中移除/.test(zh['ui.chrome.store.manualRecovery']));
  assert.ok(en['ui.chrome.store.manualRecovery'].includes('Developer mode') && !/remove/i.test(en['ui.chrome.store.manualRecovery']));
});

test('1081 D06: choosing a profile and a failed open stay a reconnect; installing afterwards is a normal install', async () => {
  const f = fixture({replies: [
    {choose_profile: true, selected_profile: 'Default', profiles: [{id: 'Default', name: 'Ken'}, {id: 'Profile 1', name: 'Work'}]},
    {opened: true, selected_profile: 'Profile 1', profiles: [{id: 'Default', name: 'Ken'}, {id: 'Profile 1', name: 'Work'}]},
    {opened: false, error_code: 'CHROME_STORE_OPEN_FAILED'},
    {opened: true, selected_profile: 'Default'},
  ]});
  await f.run('chromeStoreReconnect');
  assert.match(f.last().html, /\[Ken\|chromeStoreReconnect\|Default\|sm primary\]\[Work\|chromeStoreReconnect\|Profile 1\|sm\]/);
  await f.run('chromeStoreReconnect', 'Profile 1');
  assert.deepEqual(f.natives().at(-1), ['openChromeStore', {profile_id: 'Profile 1'}]);
  assert.deepEqual(plain(f.toasts), ['ui.chrome.store.pageOpened']);
  await f.run('chromeStoreReconnect');
  const stopped = f.last().html;
  assert.match(stopped, /^<h2>ui\.chrome\.store\.reconnectTitle<\/h2>/);
  assert.match(stopped, /\[ui\.wizard\.retry\|chromeStoreReconnect\|\|sm primary\]/);
  await f.run('extensionSetup');
  assert.match(f.last().html, /^<h2>ui\.window\.capBrowser\.act\.text2<\/h2>/, 'the install intro is the install one');
  await f.run('chromeStoreOpen');
  const wait = f.last().html;
  assert.match(wait, /^<h2>ui\.window\.capBrowser\.act\.text2<\/h2>/);
  assert.match(wait, /<p class="cs-wait" role="status"><span>ui\.chrome\.store\.waitChrome<\/span><\/p>/, 'waiting for the person: no spinner');
  assert.match(wait, /cs-pics/);
  assert.equal(f.timers.size, 1, 'a first install waits in the box');
});

test('1081 copy (Ken 10/27 10:07): one case per line, says what the button does, in both languages', () => {
  for (const k of ['ui.chrome.store.reconnectTitle', 'ui.chrome.store.pageOpened', 'ui.window.capBrowser.connecting', 'ui.window.faq.text8', 'card.blocked.browser.where', 'ui.window.capBrowser.wakeFailed.off', 'ui.window.capBrowser.wakeFailed.gone', 'ui.window.pgBrowser.lostStore']) {
    assert.equal(typeof zh[k], 'string', k); assert.equal(typeof en[k], 'string', k);
    assert.doesNotMatch(zh[k], /后台|不抢前台|重新连接|宿主|登记|握手|心跳|多半|可能是|；/, k);
    assert.doesNotMatch(en[k], /background|stealing focus|Reconnect|registration|probably|;/i, k);
  }
  for (const k of ['ui.chrome.store.reconnectWait', 'ui.chrome.store.reconnectHint', 'ui.window.capBrowser.wakeFailed.hint', 'ui.chrome.store.oldTitle', 'ui.chrome.store.introDone']) assert.equal(zh[k], undefined, k + ' is gone');
  // 被关掉了：去 Chrome 的「管理扩展程序」打开；被删了：点「打开插件页面」再「添加至 Chrome」。一行只说一种
  const off = zh['ui.window.capBrowser.wakeFailed.off'], gone = zh['ui.window.capBrowser.wakeFailed.gone'];
  assert.ok(off.startsWith('如插件已被关闭，') && off.includes('「管理扩展程序」') && !/移除|添加至/.test(off), off);
  assert.ok(gone.startsWith('如插件已被移除，') && gone.includes(`「${zh['ui.chrome.store.openPage']}」`) && gone.includes('「添加至 Chrome」') && !/关闭|管理扩展程序/.test(gone), gone);
  assert.ok(en['ui.window.capBrowser.wakeFailed.off'].includes('Manage Extensions') && en['ui.window.capBrowser.wakeFailed.gone'].includes(`“${en['ui.chrome.store.openPage']}”`), 'English names the same places');
  // FAQ 和任务卡片不把两种情况挤在一句里，指到「浏览器控制」去看
  for (const k of ['ui.window.faq.text8', 'card.blocked.browser.where']) { assert.doesNotMatch(zh[k], /关掉|删了|关闭|移除|管理扩展程序/, k); assert.ok(zh[k].includes('「浏览器控制」'), k); }
  assert.match(en['ui.chrome.store.reconnectTitle'], /^(?:[A-Z][a-z]*\s?)+$/, 'Title Case');
});
