import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 1081（Claude，ChatGPT 复查 10/26）：应用店装 Chrome 插件那几个框，再改几处。
// 选 Chrome 用户排成一列，「关闭」单独放下面；查连接状态连着失败时照直说是 ChatHand 查不到（D04）；
// 知道装了 Chrome 就不让人下载 Chrome（D05）；「太旧」「这一版」「登记」这些说法换成普通人看得懂的；
// 本机连接没准备好时，不把后台原话摆出来，说一句怎么办。
const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../ui/style.css', import.meta.url), 'utf8');
const zh = JSON.parse(fs.readFileSync(new URL('../../locales/zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../../locales/en.json', import.meta.url), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x));
const section = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return source.slice(start, end); };

// status 里的一项是 'fail' 时，查连接状态那一下报错（后台没回、回了错）。
function fixture({replies = [], status = [{connected: false, compatibility: {state: 'unknown'}}], chrome} = {}) {
  const views = [], log = [], toasts = [], timers = new Map(), dialog = {open: false, dataset: {}};
  let next = 0;
  const S = {automation: {browser: {extension: {distribution: 'chrome_web_store', store_published: true}, ...(chrome ? {personal: {chrome}} : {})}}, settings: {browser_enabled: true}};
  const context = vm.createContext({
    S, Date, E: String, T: (k, p) => k + (p ? JSON.stringify(p) : ''), TH: k => k,
    btn: (text, action, id = '', cls = '') => `[${text}|${action}|${id}|${cls}]`,
    tbtn: (text, action, id = '') => `{${text}|${action}|${id}}`,
    modal: (html, kind) => { views.push({html, kind}); dialog.open = true; dialog.dataset.kind = kind; },
    $: () => dialog,
    closeModal: async (cancel = true) => { log.push(['closeModal', cancel]); dialog.open = false; },
    native: async (action, data) => { log.push(['native', action, data]); return replies.length ? replies.shift() : {}; },
    api: async (route, body) => {
      log.push(['api', route, body]);
      if (route === '/api/browser/extension/store/status') { const r = status.length > 1 ? status.shift() : status[0]; if (r === 'fail') throw Object.assign(Error('X'), {code: 'X'}); return r; }
      return {};
    },
    refresh: async () => {}, capOn: k => S.settings[k] === true, toast: m => toasts.push(m),
    extensionSuccessToast: async (m, kind) => toasts.push([m, kind]),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(section('let chromeInstallView=', 'function desktopSheet()'), context);
  const cases = section(" case'extensionSetup':", " case'revealHelperFolder':");
  vm.runInContext('async function perform(name,id=""){switch(name){' + cases + '}}', context);
  const tick = async () => { const first = [...timers][0]; if (!first) return false; timers.delete(first[0]); await first[1](); return true; };
  return {context, views, toasts, timers, tick, last: () => views.at(-1), run: (name, id) => context.perform(name, id)};
}

test('1081 Chrome profiles are a list, one per row; Close sits on its own below', async () => {
  const f = fixture({replies: [{choose_profile: true, selected_profile: 'Profile 1', profiles: [{id: 'Default', name: 'Ken'}, {id: 'Profile 1', name: 'Work'}]}]});
  await f.run('chromeStoreOpen');
  const html = f.last().html;
  assert.match(html, /<div class="cs-profiles">\[Ken\|chromeStoreOpen\|Default\|sm\]\[Work\|chromeStoreOpen\|Profile 1\|sm primary\]<\/div><div class="actions">\[ui\.window\.static\.close\|closeModal\|\|sm\]<\/div>/);
  assert.doesNotMatch(html, /actions cs-profiles/, 'the profiles are not a row of buttons any more');
  assert.match(css, /dialog#modal \.cs-profiles\{display:flex;flex-direction:column;/);
  assert.match(css, /dialog#modal \.cs-profiles \.btn\{width:100%;/);
});

test('1081 D04: when ChatHand cannot check the connection, it says so instead of asking about the two clicks', async () => {
  const f = fixture({replies: [{opened: true, selected_profile: 'Default'}], status: ['fail', 'fail', 'fail', 'fail', 'fail', 'fail', {connected: false, compatibility: {state: 'unknown'}}, {connected: true, compatibility: {state: 'compatible'}}]});
  await f.run('chromeStoreOpen');
  assert.match(f.last().html, /ui\.chrome\.store\.waitChrome/);
  const count = f.views.length;
  for (let i = 0; i < 4; i++) await f.tick();
  assert.equal(f.views.length, count, 'a few failed checks change nothing on screen');
  assert.equal(f.timers.size, 1, 'and it keeps checking');
  vm.runInContext('chromeStoreStarted=Date.now()-91000', f.context);
  await f.tick();
  const cant = f.last().html;
  assert.match(cant, /ui\.chrome\.store\.cantCheck/);
  assert.match(cant, /<p class="hint">ui\.chrome\.store\.cantCheckHint<\/p>/);
  // 断言跟着 Ken 10/27 10:07、10:18 改：查不到时只说查不到、到哪里修；不转圈、不放那两张图，也不放「再打开一次」「换一个用户」
  assert.match(cant, /<p class="cs-wait" role="status"><span>ui\.chrome\.store\.cantCheck<\/span><\/p>/, 'no spinner next to a manual fix');
  assert.doesNotMatch(cant, /cs-pics|cs-again|cs-profile|spinner/);
  assert.doesNotMatch(cant, /ui\.chrome\.store\.waitChrome|ui\.chrome\.store\.slow/, 'does not suggest the clicks were missed');
  assert.doesNotMatch(cant, /browserReconnect/, 'no recheck button while checking itself fails');
  const shown = f.views.length;
  await f.tick();
  assert.equal(f.views.length, shown, 'the same view is not repainted every second');
  await f.tick();
  assert.match(f.last().html, /ui\.chrome\.store\.waitChrome/, 'a check works again: back to waiting');
  assert.match(f.last().html, /ui\.chrome\.store\.slow/);
  assert.equal(vm.runInContext('chromeStoreFails', f.context), 0);
  await f.tick();
  assert.deepEqual(plain(f.toasts), [['ui.window.capBrowser.connected', 'chrome-store']]);
  assert.equal(f.timers.size, 0);
});

test('1081 D04: a new attempt starts counting from zero', async () => {
  const f = fixture({replies: [{opened: true}, {opened: true}], status: ['fail']});
  await f.run('chromeStoreOpen');
  for (let i = 0; i < 5; i++) await f.tick();
  assert.match(f.last().html, /ui\.chrome\.store\.cantCheck/);
  await f.run('chromeStoreOpen');
  assert.equal(vm.runInContext('chromeStoreFails', f.context), 0);
  assert.match(f.last().html, /ui\.chrome\.store\.waitChrome/);
});

test('1081 D05: with Chrome known to be installed, a failure never says to download Chrome', async () => {
  const chrome = {installed: true, version: '141.0.7390.66', major: 141};
  const open = fixture({replies: [{opened: false, error_code: 'CHROME_STORE_OPEN_FAILED'}], chrome});
  await open.run('chromeStoreOpen');
  assert.match(open.last().html, /ui\.chrome\.store\.stopped/);
  assert.doesNotMatch(open.last().html, /ui\.chrome\.store\.openFailed|chromeUpdate/);
  assert.match(open.last().html, /\[ui\.wizard\.retry\|chromeStoreOpen\|\|sm primary\]/);
  const list = fixture({replies: [{error: {code: 'CHROME_STORE_PROFILES_UNAVAILABLE'}}], chrome});
  await list.run('chromeStoreOpen');
  assert.match(list.last().html, /ui\.chrome\.store\.profilesUnavailable/);
  assert.doesNotMatch(list.last().html, /chromeUpdate/);
  const unknown = fixture({replies: [{opened: false, error_code: 'CHROME_STORE_OPEN_FAILED'}]});
  await unknown.run('chromeStoreOpen');
  assert.match(unknown.last().html, /ui\.chrome\.store\.openFailed/, 'not known: as before');
  assert.match(unknown.last().html, /\|chromeUpdate\|/);
  const missing = fixture({replies: [{opened: false, error_code: 'CHROME_STORE_OPEN_FAILED'}], chrome: {installed: false}});
  await missing.run('chromeStoreOpen');
  assert.match(missing.last().html, /\|chromeUpdate\|/);
});

test('1081: when the local connection is not ready, the window says what to do instead of showing the raw error', () => {
  const ctx = vm.createContext({S: {}, T: k => k, capOn: () => true, browserOn: () => false, helperNeedsHand: () => false, extRepairUnsupported: false});
  const card = section('function capBrowser()', 'function capDesktop()');
  vm.runInContext(source.split('\n').find(l => l.startsWith('function browserState()')) + '\n' + card, ctx);
  const raw = "EACCES: permission denied, open '/Users/someone/Library/Application Support/Google/Chrome/NativeMessagingHosts/x.json'";
  for (const distribution of ['chrome_web_store', 'legacy_unpacked']) {
    ctx.S = {automation: {browser: {extension: {distribution, configuration_state: 'ready', connection_state: 'disconnected', installed: true, host_registration: {status: 'failed', code: 'HOST_REGISTRATION_FAILED', message: raw}}}}};
    const m = plain(vm.runInContext('capBrowser()', ctx));
    assert.equal(m.res, 'ui.window.capBrowser.res.text2');
    assert.equal(m.note, 'ui.window.capBrowser.res.hostHint', distribution);
    assert.deepEqual(m.act, ['ui.window.capBrowser.act.text', 'browserReconnect'], 'Reconnect sets the connection up again');
  }
  const page = section('function pgBrowser()', 'function pgDesktop()');
  assert.doesNotMatch(page, /registration\.message/, 'the local connection row shows the state only');
  assert.match(page, /kvRow\(T\("ui\.window\.pgBrowser\.text10"\),`<span>\$\{E\(labels\[registration\.status\]\)\}<\/span>`\)/);
  assert.doesNotMatch(card, /host_registration\.message/);
  assert.doesNotMatch(css, /registration-message/);
});

test('1081 copy: plain words in both languages, no “too old”, “this version” or “registration”', () => {
  const changed = ['ui.chrome.store.introText', 'ui.chrome.store.noChrome', 'ui.chrome.store.permNote', 'ui.chrome.store.oldText', 'ui.chrome.store.resOld', 'ui.chrome.store.versionOld',
    'ui.chrome.store.resPending', 'ui.chrome.store.notReady', 'ui.chrome.store.cantCheck', 'ui.chrome.store.cantCheckHint', 'ui.window.capBrowser.res.hostHint', 'card.blocked.browser.where',
    'ui.server.repair.browser_host.title', 'ui.server.repair.browser_host.failed.message', 'ui.window.capBrowser.res.text2', 'ui.window.capBrowser.tag.text',
    'ui.window.pgBrowser.text10', 'ui.window.pgBrowser.registered.text', 'ui.window.pgBrowser.pending.text',
    // 1081（Ken 10/27）新加、改过的
    'card.blocked.browser.whereInstall', 'card.blocked.browser.whereChrome', 'ui.chrome.store.updateTitle', 'ui.chrome.store.tagMismatch', 'ui.window.capBrowser.res.text6',
    'ui.window.capBrowser.wakeFailed.res', 'ui.window.capBrowser.wakeFailed.off', 'ui.window.capBrowser.wakeFailed.gone', 'ui.chrome.store.versionNewer', 'ui.chrome.store.pageOpened', 'ui.window.capBrowser.connecting', 'ui.server.refresh.summary.helperStoreOld', 'ui.window.capBrowser.noChrome.res', 'ui.window.pgBrowser.lostStore',
    'ui.window.toolsRefreshNoteBody.helperFailedStoreOld', 'ui.window.toolsRefreshNoteBody.helperFailedStoreDown', 'ui.server.refresh.message.unavailable.notConnected',
    'ui.server.repair.browser_helper.wakeFailed.message', 'ui.server.repair.browser_helper.noChrome.message', 'ui.server.repair.browser_helper.mismatch.message'];
  for (const k of changed) {
    assert.equal(typeof zh[k], 'string', k); assert.equal(typeof en[k], 'string', k);
    assert.doesNotMatch(zh[k], /太旧|这一版|这版|登记|宿主|回执|凭据|握手|心跳|多半/, k);
    assert.doesNotMatch(en[k], /too old|outdated|this version|registration|Browser control/i, k);
  }
  for (const [k, v] of Object.entries(zh)) if (k.startsWith('ui.chrome.store.')) assert.doesNotMatch(v, /这一版 ChatHand|这版 ChatHand/, k);
  assert.ok(en['ui.chrome.store.introText'].includes(`“${en['ui.chrome.store.open']}”`), 'names the button the way it is spelled');
  assert.ok(zh['ui.chrome.store.introText'].includes(`「${zh['ui.chrome.store.open']}」`));
  assert.ok(zh['ui.chrome.store.cantCheckHint'].includes('「检查并修复」') && zh['ui.chrome.store.hostUnavailable'].includes('「检查并修复」'), 'the same button name as the other hint');
  assert.ok(en['ui.chrome.store.cantCheckHint'].includes('“Check & Repair”') && en['ui.chrome.store.hostUnavailable'].includes('“Check & Repair”'));
  assert.ok(zh['ui.window.capBrowser.res.hostHint'].includes(`「${zh['ui.window.capBrowser.act.text']}」`) && zh['ui.window.capBrowser.res.hostHint'].includes('「检查并修复」'), 'names the button next to it');
  assert.ok(en['ui.window.capBrowser.res.hostHint'].includes(`“${en['ui.window.capBrowser.act.text']}”`) && en['ui.window.capBrowser.res.hostHint'].includes('“Check & Repair”'));
  // 任务卡上「请你自己打开：…」那一句：说到「浏览器控制」里点哪个按钮，按钮名跟窗口里一样
  // 1081（Ken 10/27，断言跟着改）：按原因分句，每句只说一个按钮：没装插件、打不开 Chrome。
  // 装过的连不上（Ken 10/27 10:07 再改）：有两种情况、两个做法，任务卡只说到「浏览器控制」，那里一行一种写清楚。
  assert.equal(zh['card.blocked.browser.where'], 'ChatHand 的「浏览器控制」');
  const buttons = {'card.blocked.browser.whereInstall': 'ui.window.capBrowser.act.text2', 'card.blocked.browser.whereChrome': 'ui.window.showChromeInstall.text8'};
  for (const [where, button] of Object.entries(buttons)) {
    assert.ok(zh[where].includes(`「${zh[button]}」`) && en[where].includes(`“${en[button]}”`), where + ' names its button');
    assert.equal((zh[where].match(/「/g) || []).length, 2, where + ' names one place and one button');
    assert.doesNotMatch(zh[where], /入口|须本人|“/, where);
  }
  for (const L of [zh, en]) assert.match(L['ui.chrome.store.versionOld'], /^\{openSmall\}.+\{closeSmall\}$/);
  // 常见问题「插件显示没连上」：不说「后台」（1081 Ken 10/27 起，AI 要用浏览器时 ChatHand 会自己打开 Chrome，答案照这个说，不用「后台」这个词）
  assert.doesNotMatch(zh['ui.window.faq.text8'], /后台|不抢前台/); assert.doesNotMatch(en['ui.window.faq.text8'], /background|stealing focus/i);
});
