'use strict';
/* 截图脚本共用的常量和小函数：shots.js、domdiff.js、check.js 都用它。 */
process.env.TZ = 'Asia/Shanghai';
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../../..');
const PROTO_URL = 'file://' + path.join(ROOT, 'ref', 'prototype', 'proto.html');
const NOW = Date.UTC(2026, 8, 29, 6, 20, 13);        // 2026-09-29 14:20:13 +08:00，页面里的「现在」
const W = 1150, H = 780;                               // 窗口（网页内容区）大小
const TITLEBAR = 38;                                   // 原型窗口顶上假的红黄绿标题栏高度，真 App 里是系统标题栏，不在网页里

/* 不要动画和过渡，转圈、呼吸灯都停在起始位置，截图才稳定 */
const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
/* 这台 Linux 上没有 PingFang，中文会随机回退到不同的字体（文泉驿 / Noto），字宽差 1px。
   两边都把 Noto Sans CJK SC 放在字体列表最后，中文就稳定了；拉丁字母不受影响。macOS 上不需要，这只是截图环境的补丁。 */
const FONT_FIX = 'html:root{--font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Segoe UI",sans-serif,"Noto Sans CJK SC";--mono:"SF Mono",ui-monospace,Menlo,Consolas,"Liberation Mono",monospace,"Noto Sans CJK SC"}';
/* 原型窗口原本 1120x720，改成和产品一样：内容区 1150x780；贴在页面左上角（坐标是整数，文字才不会因为小数偏移被渲染得和产品不一样）；去掉圆角和阴影；收起来的抽屉（划到窗口外面）的阴影会漏进右边缘，也去掉 */
const PROTO_FIX = `.window{position:fixed!important;left:0!important;top:0!important;width:${W}px!important;height:${H + TITLEBAR}px!important;transform:none!important;margin:0!important;border-radius:0!important;box-shadow:none!important}#stagewrap{height:auto!important;overflow:visible!important}.drawer:not(.open){box-shadow:none!important}`;

/* Reuse an already installed browser; never download Playwright's browser. */
const CHROME_PATH = process.env.CHATHAND_TEST_CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(p => fs.existsSync(p));
async function launchBrowser() {
  if (!CHROME_PATH || !fs.existsSync(CHROME_PATH)) throw new Error('未找到本机 Chrome/Chromium；可用 CHATHAND_TEST_CHROME 指定现有浏览器路径。不会下载浏览器。');
  return chromium.launch({ headless: true, executablePath: CHROME_PATH });
}

/* 打开原型页并切到某一页。theme: light | dark。返回 { ctx, page } */
async function openProto(browser, theme, { dsf = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 1100 }, deviceScaleFactor: dsf, colorScheme: theme, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await ctx.addInitScript(() => { try { localStorage.setItem('chathand-proto-lang', 'zh'); localStorage.setItem('chathand-proto-homelayout', 'B'); localStorage.removeItem('chathand-proto-theme'); } catch (e) { /* 忽略 */ } });
  const page = await ctx.newPage();
  await page.goto(PROTO_URL);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.documentElement.setAttribute('lang', 'zh-CN'));   // 原型把 lang 设成 zh，产品是 zh-CN
  await page.addStyleTag({ content: FREEZE + FONT_FIX + PROTO_FIX });
  return { ctx, page };
}
async function protoGo(page, chip, state) {
  const click = sel => page.$eval(sel, el => el.click());   // 窗口盖在 chip 上面，用脚本点，不走鼠标命中
  await click(`.chip[data-show="${chip}"]`);
  await page.waitForTimeout(200);
  if (chip === 'home') {
    await click('#homeLayoutSwitch [data-layout="B"]');
    if (state) await click(`[data-homestate="${state}"]`);
  }
  await page.waitForTimeout(150);
}

/* 真 App 里页面靠 window.webkit.messageHandlers.native 和 Swift 说话，回复走 window.nativeReply({id, result})。
   自检脚本里用这个假的顶上：记下每次调用（window.__native），再按动作名回一个像样的结果。 */
const NATIVE_SHIM = `(() => {
  const replies = {
    chooseFolder: { path: '/Users/trial/Documents/研究资料' },
    extensionSetup: { extension_folder: '/Users/trial/ChatHand/browser-extension' },
    pasteRuntimeKey: { saved: true, last4: 'a3f9' },
  };
  window.__native = [];
  window.webkit = { messageHandlers: { native: { postMessage(m) {
    window.__native.push({ action: m.action, data: m.data });
    if(m.action==='copyText')window.__testClipboard=String(m.data?.text||'');
    setTimeout(() => window.nativeReply({ id: m.id, result: replies[m.action] || {} }), 5);
  } } } };
})();`;

/* 打开产品页（假服务）。返回 { ctx, page }，page.errors 里收着 console 报错
   选项：dsf 像素比；size 窗口；extra 追加在 URL 上的参数（如 '&paused=1'）；now 固定「现在」（0 = 用真实时间）；
         freeze 关掉动画（截图要，自检不要）；native 装上假的原生桥（自检要，截图不要） */
async function openProduct(browser, base, theme, scenario, { dsf = 1, size = { width: W, height: H }, extra = '', now = NOW, freeze = true, native = false } = {}) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: dsf, colorScheme: theme, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__testClipboard=String(text);},readText:async()=>window.__testClipboard||''}}));
  if (native) await ctx.addInitScript(NATIVE_SHIM);
  const page = await ctx.newPage();
  if (now) await page.clock.setFixedTime(now);
  page.errors = [];
  page.warnings = [];
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); else if (m.type() === 'warning') page.warnings.push(m.text()); });
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  page.on('requestfailed', r => page.errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  if (process.env.SKIN && !/[?&]skin=/.test(extra)) extra += '&skin=' + encodeURIComponent(process.env.SKIN);
  await page.goto(`${base}/?s=${scenario}${now ? '&now=' + now : ''}${extra}#token`);
  await page.addStyleTag({ content: (freeze ? FREEZE : '') + FONT_FIX });
  await page.waitForSelector('#main > *', { timeout: 8000 });
  return { ctx, page };
}

module.exports = { ROOT, PROTO_URL, NOW, W, H, TITLEBAR, FREEZE, FONT_FIX, PROTO_FIX, NATIVE_SHIM, openProto, protoGo, openProduct, launchBrowser };
