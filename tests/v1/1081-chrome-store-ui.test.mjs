import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 1081：正式版的 Chrome 插件只从 Chrome 网上应用店装。窗口这边只开商店页面、等连上；旧的本地装法只留给 legacy_unpacked。
// Ken 10/26：「安装 Chrome 插件」先出说明（在 Chrome 里点哪两下），点「打开 Chrome」（chromeStoreOpen）才开商店页面。
const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const wizard = fs.readFileSync(new URL('../../ui/wizard.js', import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
const section = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return source.slice(start, end); };

function fixture({replies = [], status = [{connected: false, compatibility: {state: 'unknown'}}], browserOn = true, distribution = 'chrome_web_store', published = true, extension = {}, chrome, platform} = {}) {
  const views = [], log = [], toasts = [], timers = new Map(), dialog = {open: false, dataset: {}};
  let next = 0;
  const S = {automation: {browser: {extension: {distribution, store_published: published, ...extension}, ...(chrome ? {personal: {chrome}} : {})}}, settings: {browser_enabled: browserOn}, ...(platform ? {platform} : {})};
  const context = vm.createContext({
    S, Date, E: String, T: (k, p) => k + (p ? JSON.stringify(p) : ''), TH: k => k,
    btn: (text, action, id = '', cls = '') => `[${text}|${action}|${id}|${cls}]`,
    tbtn: (text, action, id = '') => `{${text}|${action}|${id}}`,
    modal: (html, kind) => { views.push({html, kind}); dialog.open = true; dialog.dataset.kind = kind; },
    $: () => dialog,
    closeModal: async (cancel = true) => { log.push(['closeModal', cancel]); dialog.open = false; },
    native: async (action, data) => { log.push(['native', action, data]); const r = replies.length ? replies.shift() : {}; return typeof r === 'function' ? r() : r; },
    api: async (route, body) => { log.push(['api', route, body]); if (route === '/api/browser/extension/store/status') return status.length > 1 ? status.shift() : status[0]; if (route === '/api/settings') Object.assign(S.settings, body); return {}; },
    refresh: async () => {}, capOn: k => S.settings[k] === true, toast: m => toasts.push(m),
    extensionSuccessToast: async (m, kind) => toasts.push([m, kind]),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(section('let chromeInstallView=', 'function desktopSheet()'), context);
  const cases = section(" case'extensionSetup':", " case'revealHelperFolder':");
  vm.runInContext('async function perform(name,id=""){switch(name){' + cases + '}}', context);
  const tick = async () => { const first = [...timers][0]; if (!first) return false; timers.delete(first[0]); await first[1](); return true; };
  const natives = () => plain(log.filter(x => x[0] === 'native').map(x => [x[1], x[2] ?? null]));
  return {context, views, log, toasts, timers, S, dialog, tick, natives, last: () => views.at(-1), run: (name, id) => context.perform(name, id)};
}

test('1081 store mode opens the chosen Chrome profile and waits until any profile connects', async () => {
  const f = fixture({
    replies: [{choose_profile: true, selected_profile: null, profiles: [{id: 'Default', name: 'Ken'}, {id: 'Profile 1', name: 'Work'}, {id: '../escape', name: 'bad'}]}, {opened: true, selected_profile: 'Profile 1'}],
    status: [{connected: false, compatibility: {state: 'unknown'}}, {connected: true, compatibility: {state: 'compatible'}}],
  });
  await f.run('extensionSetup');
  assert.deepEqual(f.natives(), [], 'the intro comes first; Chrome is not opened yet');
  assert.match(f.last().html, /\[ui\.chrome\.store\.open\|chromeStoreOpen\|\|sm primary\]/);
  await f.run('chromeStoreOpen');
  assert.deepEqual(f.natives(), [['openChromeStore', {}]]);
  assert.equal(f.views[1].kind, 'chrome-store');
  assert.match(f.views[1].html, /ui\.chrome\.store\.opening/);
  assert.match(f.last().html, /ui\.chrome\.store\.profileTitle/);
  assert.match(f.last().html, /\[Ken\|chromeStoreOpen\|Default\|/);
  assert.match(f.last().html, /\[Work\|chromeStoreOpen\|Profile 1\|/);
  assert.doesNotMatch(f.last().html, /escape/);
  assert.equal(f.timers.size, 0, 'choosing a profile does not poll');

  await f.run('chromeStoreOpen', 'Profile 1');
  assert.deepEqual(f.natives().at(-1), ['openChromeStore', {profile_id: 'Profile 1'}]);
  assert.match(f.last().html, /ui\.chrome\.store\.stepPage/);
  assert.match(f.last().html, /\{ui\.chrome\.store\.reopen\|chromeStoreOpen\|Profile 1\}/, 'reopen keeps the chosen profile');
  assert.equal(f.toasts.length, 0, 'opened:true alone is not installation');
  assert.equal(f.timers.size, 1);

  await f.tick();
  assert.equal(f.toasts.length, 0);
  await f.tick();
  assert.deepEqual(f.toasts, [['ui.window.capBrowser.connected', 'chrome-store']]);
  assert.equal(f.timers.size, 0);
  const routes = f.log.filter(x => x[0] === 'api').map(x => x[1]);
  assert.ok(routes.includes('/api/browser/extension/store/status'));
  assert.ok(!routes.some(r => r.includes('/install/')), 'never polls the legacy installer');
  assert.ok(!f.natives().some(([a, d]) => a !== 'openChromeStore' || d?.wait_for_accessibility), 'no legacy native install, no Accessibility wait');
});

// 断言跟着 Ken 10/27 10:03、10:07 改：原来留在框里说「要更新」、接着等；现在关掉框，要更新由「浏览器控制」那条说（一句话、一个按钮），更新好了再提示。
test('1081 a connected but incompatible extension closes the box and leaves the update to Browser Use', async () => {
  const f = fixture({replies: [{opened: true, selected_profile: 'Default'}], status: [{connected: true, compatibility: {state: 'incompatible', missing_actions: ['upload']}}]});
  await f.run('chromeStoreOpen');
  await f.tick();
  assert.ok(!f.views.some(v => /extensionRepair|extGuideReplace|revealHelperFolder|oldTitle/.test(v.html)), 'no local replacement path and no old waiting box');
  assert.equal(f.toasts.length, 0, 'no “connected” toast for an extension that cannot be used');
  assert.equal(f.timers.size, 0, 'stops waiting');
  assert.equal(vm.runInContext('browserFixPending', f.context), true, 'says “connected” once it is updated');
});

test('1081 a slow wait offers a recheck, and the review note follows store_published', async () => {
  const f = fixture({replies: [{opened: true, selected_profile: 'Default'}], published: false});
  await f.run('chromeStoreOpen');
  assert.match(f.last().html, /ui\.chrome\.store\.unpublished/);
  assert.doesNotMatch(f.last().html, /ui\.chrome\.store\.slow/);
  vm.runInContext('chromeStoreStarted=Date.now()-91000', f.context);
  await f.tick();
  assert.match(f.last().html, /ui\.chrome\.store\.slow/);
  assert.match(f.last().html, /\|browserReconnect\|/);
  const g = fixture({replies: [{opened: true}], published: true});
  await g.run('chromeStoreOpen');
  assert.doesNotMatch(g.last().html, /ui\.chrome\.store\.unpublished/);
});

test('1081 stop reasons each give one next step', async () => {
  const cases = [
    [{registered: false, error: {code: 'CHROME_DATA_ACCESS_DENIED'}}, /ui\.chrome\.store\.dataAccess/, [/\|chromeStorePrivacy\|/, /\[ui\.wizard\.retry\|chromeStoreOpen\|/], []],
    [{opened: false, error_code: 'CHROME_STORE_OPEN_FAILED'}, /ui\.chrome\.store\.openFailed/, [/\|chromeUpdate\|/, /\|chromeStoreOpen\|/], []],
    [{error: {code: 'CHROME_STORE_PROFILES_UNAVAILABLE'}}, /ui\.chrome\.store\.profilesUnavailable/, [/\|chromeUpdate\|/], []],
    [{error_code: 'CHROME_STORE_PROFILE_UNKNOWN'}, /ui\.chrome\.store\.profileGone/, [/\|chromeStoreOpen\|\|/], []],
    [{error: {code: 'CHROME_STORE_HOST_UNAVAILABLE'}}, /ui\.chrome\.store\.hostUnavailable/, [/\|chromeStoreOpen\|/], []],
    [{error_code: 'CHROME_STORE_CONFIGURATION_PENDING'}, /ui\.chrome\.store\.notReady/, [/CHROME_STORE_CONFIGURATION_PENDING/], [/\|chromeStoreOpen\|/]],
    [{error_code: 'OWNED_WINDOW_REQUIRED'}, /ui\.chrome\.store\.windowOnly/, [], [/\|chromeStoreOpen\|/]],
    [{error: 'NATIVE_TIMEOUT'}, /ui\.chrome\.store\.stopped/, [/NATIVE_TIMEOUT/, /\|chromeStoreOpen\|/], []],
    [{}, /ui\.chrome\.store\.openFailed/, [/\|chromeUpdate\|/], [/CHROME_STORE_OPEN_FAILED/]],
  ];
  for (const [reply, text, has, hasNot] of cases) {
    const f = fixture({replies: [reply]});
    await f.run('chromeStoreOpen');
    assert.match(f.last().html, text, JSON.stringify(reply));
    for (const re of has) assert.match(f.last().html, re, JSON.stringify(reply));
    for (const re of hasNot) assert.doesNotMatch(f.last().html, re, JSON.stringify(reply));
    assert.equal(f.timers.size, 0, 'a stopped attempt does not poll');
  }
});

test('1081 cancel closes quietly; a native cancel reply is not shown as a failure', async () => {
  let release;
  const f = fixture({replies: [() => new Promise(r => { release = r; })]});
  const pending = f.run('chromeStoreOpen');
  await new Promise(r => setImmediate(r));
  await f.run('extensionCancel');
  release({cancelled: true, error_code: 'CHROME_STORE_CANCELLED'});
  await pending;
  assert.deepEqual(f.natives().map(x => x[0]), ['openChromeStore', 'extensionCancel']);
  assert.ok(f.log.some(x => x[0] === 'closeModal' && x[1] === false));
  assert.ok(!f.views.some(v => /INSTALL_CANCELLED|ui\.chrome\.store\.stopped/.test(v.html)));
  const g = fixture({replies: [{cancelled: true, error_code: 'CHROME_STORE_CANCELLED'}]});
  await g.run('chromeStoreOpen');
  assert.ok(g.log.some(x => x[0] === 'closeModal'));
  assert.ok(!g.views.some(v => /ui\.chrome\.store\.stopped/.test(v.html)));
});

test('1081 turns on Browser Use before preparing, and every old entry opens the same store flow', async () => {
  const f = fixture({browserOn: false, replies: [{opened: true}]});
  await f.run('extensionSetup');
  assert.deepEqual(f.log.filter(x => x[0] !== 'closeModal'), [], 'the intro alone changes nothing');
  await f.run('chromeStoreOpen');
  const order = f.log.filter(x => x[0] !== 'closeModal').map(x => x[0] === 'api' ? x[1] : x[1]);
  assert.ok(order.indexOf('/api/settings') >= 0 && order.indexOf('/api/settings') < order.indexOf('openChromeStore'));
  for (const name of ['extensionRepair', 'extensionSetupWithDesktop', 'extensionRepairWithDesktop']) {
    const g = fixture({replies: [{opened: true}]});
    await g.run(name);
    assert.deepEqual(g.natives(), [['openChromeStore', {}]], name);
  }
  for (const name of ['helperSheet', 'extensionManual', 'extGuideReplace', 'extensionSettings', 'revealHelperFolder']) {
    assert.match(source, new RegExp(` case'${name}':\\{?if\\(chromeStoreMode\\(\\)\\)\\{await startChromeStore\\(\\);`), name);
  }
  assert.match(source, / case'chromeDataAccessSettings':\{if\(chromeStoreMode\(\)\)\{await openChromeStorePrivacy\(\);return;\}/);
  assert.match(source, /native\('openPrivacySettings'\)/);
  assert.match(wizard, /if\(browserStore\(\)\)await action\('extensionSetup'\);/);
  assert.doesNotMatch(wizard, /openExternal',\{url:browserStore\(\)\}/, 'the wizard does not open a bare link without registering the host');
});

test('1081 legacy_unpacked keeps the parked local installer', async () => {
  const f = fixture({distribution: 'legacy_unpacked', replies: [{error_code: 'CHROME_INSTALL_CHROME_UNAVAILABLE'}]});
  vm.runInContext('var ask=async()=>false,capUnsupported=()=>false,quietModalOpen=()=>false,icon=()=>"";', f.context);
  await f.run('extensionSetup').catch(() => {});
  assert.equal(f.natives()[0][0], 'extensionSetup');
});

test('1081 Browser Use card reads store status without claiming the extension is missing', () => {
  const ctx = vm.createContext({S: {}, T: k => k, capOn: () => true, browserOn: () => false, helperNeedsHand: () => false, extRepairUnsupported: false, browserRetrying: false});
  const card = source.slice(source.indexOf('function capBrowser()'), source.indexOf('function capDesktop()'));
  vm.runInContext(source.split('\n').find(l => l.startsWith('function browserState()')) + '\n' + card, ctx);
  const at = ext => { ctx.S = {automation: {browser: {extension: {distribution: 'chrome_web_store', configuration_state: 'ready', connection_state: 'disconnected', ...ext}}}}; return vm.runInContext('capBrowser()', ctx); };
  const fresh = plain(at({installed: null, installation_state: 'unknown'}));
  assert.equal(fresh.tag, 'ui.window.capBrowser.tag.text4');
  assert.deepEqual(fresh.act, ['ui.window.capBrowser.act.text2', 'extensionSetup']);
  const seen = plain(at({installed: true, installation_state: 'observed', last_seen: Date.now() - 3600e3}));
  // 1081（Ken 10/27 02:19 定的，断言跟着改）：装过、只是 Chrome 没开，卡片照常，不标「没连上」、不放按钮；AI 要用浏览器时 ChatHand 自己打开 Chrome。
  assert.equal(seen.ok, true);
  assert.equal(seen.tag, '');
  assert.equal(seen.act, undefined);
  // 真出了问题才报：ChatHand 打开了 Chrome 插件还是没连上，「连不上」+「打开插件页面」；这台 Mac 上打不开 Chrome，「找不到 Chrome」+「下载 Chrome」。
  const failed = plain(at({installed: true, installation_state: 'observed', last_seen: Date.now() - 3600e3, wake: {at: Date.now(), connected: false}}));
  assert.equal(failed.ok, false);
  assert.equal(failed.tag, 'ui.window.capBrowser.wakeFailed.tag');
  // 断言跟着 Ken 10/27 10:07 改：两种情况各一行，按钮「打开插件页面」「再试一次」
  assert.deepEqual(failed.notes, ['ui.window.capBrowser.wakeFailed.off', 'ui.window.capBrowser.wakeFailed.gone']);
  assert.deepEqual(failed.acts, [['ui.chrome.store.openPage', 'chromeStoreReconnect'], ['ui.wizard.retry', 'browserRetry']]);
  const noChrome = plain(at({installed: true, installation_state: 'observed', last_seen: Date.now() - 3600e3, wake: {at: Date.now(), connected: false, chrome_open_failed: true}}));
  assert.equal(noChrome.tag, 'ui.window.capBrowser.noChrome.tag');
  assert.deepEqual(noChrome.act, ['ui.window.showChromeInstall.text8', 'chromeUpdate']);
  const old = plain(at({connection_state: 'connected', connected: true, compatibility: {state: 'incompatible'}}));
  assert.equal(old.res, 'ui.chrome.store.resOld');
  assert.deepEqual(old.act, ['ui.chrome.store.openPage', 'chromeStoreOpen'], 'an old extension goes straight to the store page, no install intro');
  assert.equal(old.tag, 'ui.chrome.store.tagMismatch');
  assert.equal(old.note, 'ui.chrome.store.oldText');
  // Ken 10/27 10:03：只缺后来加的动作照常能用，卡片什么都不说
  const partial = plain(at({connection_state: 'connected', connected: true, compatibility: {state: 'partial', missing_later_actions: ['x']}}));
  assert.equal(partial.ok, true);
  assert.equal(partial.tag, '');
  assert.equal(partial.act, undefined);
  const pending = at({configuration_state: 'pending'});
  assert.equal(pending.tag, 'ui.chrome.store.tagPending');
  assert.equal(pending.act, undefined);
  const ok = at({connection_state: 'connected', connected: true, compatibility: {state: 'compatible'}, helper: {build: 1080}});
  assert.equal(ok.ok, true);
});

test('1081 the store page opens in the profile Chrome last used; with several profiles the wait says which one and “Change” picks another', async () => {
  const profiles = [{id: 'Default', name: 'Ken'}, {id: 'Profile 1', name: 'Work <b>'}];
  const f = fixture({replies: [{opened: true, selected_profile: 'Profile 1', profiles}, {opened: true, selected_profile: 'Default', profiles}]});
  await f.run('chromeStoreOpen');
  assert.deepEqual(f.natives(), [['openChromeStore', {}]], 'no chooser first: the backend picks the profile');
  assert.match(f.last().html, /ui\.chrome\.store\.stepPage/);
  assert.match(f.last().html, /<p class="hint cs-profile">ui\.chrome\.store\.openedIn \{ui\.chrome\.store\.switchProfile\|chromeStoreSwitch\|\}<\/p>/);
  assert.equal(f.timers.size, 1);

  await f.run('chromeStoreSwitch');
  assert.equal(f.timers.size, 0, 'switching stops waiting');
  assert.match(f.last().html, /ui\.chrome\.store\.profileTitle/);
  assert.match(f.last().html, /\[Ken\|chromeStoreOpen\|Default\|sm\]/);
  assert.match(f.last().html, /\[Work <b>\|chromeStoreOpen\|Profile 1\|sm primary\]/, 'the profile it opened in is highlighted');
  await f.tick();
  assert.match(f.last().html, /profileTitle/, 'a stale poll does not cover the chooser');

  await f.run('chromeStoreOpen', 'Default');
  assert.deepEqual(f.natives().at(-1), ['openChromeStore', {profile_id: 'Default'}]);
  assert.match(f.last().html, /\{ui\.chrome\.store\.reopen\|chromeStoreOpen\|Default\}/);
});

test('1081 one Chrome profile, or a reply without the list: no profile line', async () => {
  for (const reply of [{opened: true, selected_profile: 'Default', profiles: [{id: 'Default', name: 'Ken'}]}, {opened: true, selected_profile: 'Default'}]) {
    const f = fixture({replies: [reply]});
    await f.run('chromeStoreOpen');
    assert.match(f.last().html, /ui\.chrome\.store\.stepPage/);
    assert.doesNotMatch(f.last().html, /cs-profile|chromeStoreSwitch/);
  }
});

test('1081 profile copy is short and says Chrome 用户 like the chooser', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../../locales/zh.json', import.meta.url), 'utf8'));
  const en = JSON.parse(fs.readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8'));
  // 断言跟着 Ken 10/28 改：标准说法
  assert.equal(zh['ui.chrome.store.openedIn'], '已在 Chrome 用户「{name}」中打开。');
  assert.equal(zh['ui.chrome.store.switchProfile'], '更换');
  assert.match(en['ui.chrome.store.openedIn'], /\{name\}/);
  assert.ok(en['ui.chrome.store.switchProfile'].length <= 8);
});

test('1081 the intro shows, before Chrome opens, the two clicks to make in Chrome', async () => {
  const f = fixture({chrome: {installed: true, version: '141.0.7390.66', major: 141}, platform: 'darwin'});
  await f.run('extensionSetup');
  const html = f.last().html;
  assert.equal(f.last().kind, 'chrome-store');
  assert.deepEqual(f.natives(), []);
  assert.equal(f.timers.size, 0, 'nothing is polled before Chrome opens');
  for (const key of ['introText', 'stepPage', 'stepDialog', 'picAdd', 'picConfirm', 'permNote']) assert.match(html, new RegExp(`ui\\.chrome\\.store\\.${key}`), key);
  assert.match(html, /class="cs-pics"/);
  assert.match(html, /<span class="cs-win" aria-hidden="true">/, 'the pictures are decoration; the captions carry the meaning');
  assert.match(html, /\[ui\.chrome\.store\.cancel\|closeModal\|\|sm\]/);
  assert.doesNotMatch(html, /ui\.chrome\.store\.(noChrome|chromeTooOld)/);
  assert.doesNotMatch(html, /introDone/, 'Ken 10/27 10:18: no extra line saying the same thing again');
});

test('1081 no Chrome, or Chrome too old for the extension: only that, with Download or Update Chrome', async () => {
  for (const [chrome, text, button] of [
    [{installed: false, version: null, major: null}, /ui\.chrome\.store\.noChrome/, /\[ui\.window\.showChromeInstall\.text8\|chromeUpdate\|\|sm primary\]/],
    [{installed: true, version: '120.0.6099.71', major: 120}, /ui\.chrome\.store\.chromeTooOld/, /\[ui\.window\.browserSheet\.text14\|chromeUpdate\|\|sm primary\]/],
  ]) {
    const f = fixture({chrome, platform: 'darwin'});
    await f.run('extensionSetup');
    assert.match(f.last().html, text, JSON.stringify(chrome));
    assert.match(f.last().html, button, JSON.stringify(chrome));
    assert.doesNotMatch(f.last().html, /chromeStoreOpen|cs-pics/, JSON.stringify(chrome));
    assert.deepEqual(f.natives(), []);
  }
  for (const chrome of [{installed: true, version: '128.0.6613.84', major: 128}, {installed: true, version: null, major: null}]) {
    const f = fixture({chrome, platform: 'darwin'});
    await f.run('extensionSetup');
    assert.match(f.last().html, /ui\.chrome\.store\.introText/, JSON.stringify(chrome));
  }
});

test('1081 while waiting, “Open it again” reopens the page; an extension already connected but old goes straight to Update', async () => {
  const f = fixture({replies: [{opened: true, selected_profile: 'Default'}, {opened: true, selected_profile: 'Default'}]});
  await f.run('chromeStoreOpen');
  assert.match(f.last().html, /<p class="hint cs-again">ui\.chrome\.store\.reopenAsk \{ui\.chrome\.store\.reopen\|chromeStoreOpen\|Default\}<\/p>/);
  assert.match(f.last().html, /ui\.chrome\.store\.waitChrome/);
  await f.run('chromeStoreOpen', 'Default');
  assert.deepEqual(f.natives(), [['openChromeStore', {}], ['openChromeStore', {profile_id: 'Default'}]]);
  assert.equal(f.timers.size, 1, 'reopening restarts one wait, not two');

  const g = fixture({replies: [{opened: true, selected_profile: 'Default'}], extension: {connection_state: 'connected', compatibility: {state: 'incompatible'}}, status: [{connected: true, compatibility: {state: 'incompatible'}}]});
  await g.run('chromeStoreOpen');
  // 断言跟着 Ken 10/27 10:07 改：要更新时只在 Chrome 里打开插件页面、关掉框、提示一句，不留在框里等
  assert.match(g.views[0].html, /^<h2>ui\.chrome\.store\.updateTitle<\/h2>/);
  assert.equal(g.views.length, 1);
  assert.ok(!g.views.some(v => /cs-pics|ui\.chrome\.store\.picAdd|cs-again/.test(v.html)), 'no “Add to Chrome” pictures for an update');
  assert.deepEqual(plain(g.toasts), ['ui.chrome.store.pageOpened']);
  assert.equal(g.timers.size, 0);
});

test('1081 intro copy says the buttons are in Chrome, in both languages', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../../locales/zh.json', import.meta.url), 'utf8'));
  const en = JSON.parse(fs.readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8'));
  for (const key of ['introText', 'stepPage', 'stepDialog', 'picAdd', 'picAsk', 'picCancel', 'picConfirm', 'permNote', 'open', 'waitChrome', 'reopenAsk', 'reopen', 'noChrome', 'chromeTooOld']) {
    assert.ok(zh['ui.chrome.store.' + key], 'zh ' + key);
    assert.ok(en['ui.chrome.store.' + key], 'en ' + key);
  }
  assert.match(zh['ui.chrome.store.introText'], /在 Chrome 中/); // 断言跟着 Ken 10/28 改：标准说法
  assert.match(en['ui.chrome.store.introText'], /in Chrome/);
  assert.match(zh['ui.chrome.store.chromeTooOld'], /\{version\}/);
  assert.match(en['ui.chrome.store.chromeTooOld'], /\{version\}/);
  for (const key of ['waitText', 'stepAdd', 'stepConfirm', 'waiting', 'introDone', 'oldTitle', 'reconnectWait', 'reconnectHint']) assert.equal(zh['ui.chrome.store.' + key], undefined, key + ' is gone');
});

// Codex 10/26 复查：应用店配置没配好（store_url 是空的）时，向导不能退回旧装法的说明；窗口也不出「打开 Chrome」
test('1081 store config not ready: no intro and no Chrome; the wizard keeps to the store wording, not the old local guide', async () => {
  const f = fixture({browserOn: false, extension: {configuration_state: 'pending', configuration_reason: 'store_url_missing', store_url: null}});
  await f.run('extensionSetup');
  assert.equal(f.last().kind, 'chrome-store');
  assert.match(f.last().html, /ui\.chrome\.store\.notReady/);
  assert.doesNotMatch(f.last().html, /chromeStoreOpen|cs-pics|ui\.chrome\.store\.introText/);
  assert.deepEqual(f.log.filter(x => x[0] !== 'closeModal'), [], 'nothing is turned on and Chrome is not opened');
  assert.match(wizard, /const browserStore=\(\)=>S\.automation\?\.browser\?\.extension\?\.distribution==='chrome_web_store';/);
  assert.match(wizard, /browser:browserPending\(\)\?window\.ChatHandText\.t\("ui\.chrome\.store\.resPending"\)/);
  assert.doesNotMatch(wizard, /extension\?\.store_url/, 'store_url is empty while the config is pending, so the wizard does not key on it');
});

// Codex 10/26 复查：完成页打开「浏览器控制」，说明框里点「取消」以后，开关和后台要一致
test('1081 the Browser control switch: extension never added, the setting waits for “Open Chrome”, so Cancel leaves it off', async () => {
  const load = f => {
    vm.runInContext(section('async function setCapability(', 'function capUnsupported('), f.context);
    vm.runInContext('var capUnsupported=()=>false,explainUnsupported=async()=>{},desktopState=()=>"on",userMessage=e=>String(e),browserOn=()=>S.automation.browser.extension.connected===true,action=n=>perform(n);', f.context);
  };
  const f = fixture({browserOn: false, replies: [{opened: true}]});
  load(f);
  await f.context.setCapability('browser', true);
  assert.match(f.last().html, /ui\.chrome\.store\.introText/);
  assert.equal(f.S.settings.browser_enabled, false, 'the intro alone does not turn Browser control on');
  assert.deepEqual(f.log.filter(x => x[0] !== 'closeModal'), []);
  await f.run('chromeStoreOpen');
  assert.equal(f.S.settings.browser_enabled, true, '“Open Chrome” turns it on before the store page opens');

  const g = fixture({browserOn: false, extension: {installed: true}});
  load(g);
  await g.context.setCapability('browser', true);
  assert.equal(g.S.settings.browser_enabled, true, 'added before: turning it on lets the extension reconnect');

  const h = fixture({browserOn: false, extension: {configuration_state: 'pending', store_url: null}});
  load(h);
  await h.context.setCapability('browser', true);
  assert.match(h.last().html, /ui\.chrome\.store\.notReady/);
  assert.equal(h.S.settings.browser_enabled, false);
});
