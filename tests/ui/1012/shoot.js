'use strict';
/* 截图小工具（无头 Chrome，不下载浏览器，不碰电脑操作工具）。
   命令行：node shoot.js "conn=offline&task=wait" out.png [light|dark] [宽x高=1280x860] ["页面里先执行的 JS"]
   代码里：const {open}=require('./shoot'); const {page,errs,close}=await open('tier=light',{theme:'dark'}); ...
   由 run.js 起随机端口假服务；CHATHAND_UI_URL 是本轮服务地址。
   找 Playwright 和 Chrome 的顺序：
     Playwright：仓库 node_modules 里的 playwright-core → 全局的 playwright / playwright-core
     Chrome：环境变量 CHATHAND_TEST_CHROME → /Applications/Google Chrome.app → /Applications/Chromium.app → /opt/pw-browsers 里的 chromium */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '../../..');
function loadPW() {
  const tries = [path.join(ROOT, 'node_modules/playwright-core'), 'playwright-core', 'playwright', path.join(require('os').homedir(), '.npm-global/lib/node_modules/playwright')];
  for (const t of tries) { try { return require(t); } catch { /* 下一个 */ } }
  throw new Error('找不到 playwright-core；仓库 node_modules 里应该有。');
}
function findChrome() {
  const c = [process.env.CHATHAND_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  try { for (const d of fs.readdirSync('/opt/pw-browsers')) if (d.startsWith('chromium')) c.push(path.join('/opt/pw-browsers', d, 'chrome-linux/chrome')); } catch { /* 不是那台机器 */ }
  const f = c.find(p => p && fs.existsSync(p));
  if (!f) throw new Error('找不到现成的 Chrome/Chromium；用 CHATHAND_TEST_CHROME 指定路径。不要下载浏览器。');
  return f;
}
async function open(query = '', { theme = 'light', w = 1280, h = 860, dsf = 2, now = '1790957400000', wait = '#main' } = {}) {
  const { chromium } = loadPW();
  const b = await chromium.launch({ executablePath: findChrome(), headless: true });
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme, locale: 'zh-CN', deviceScaleFactor: dsf });
  await ctx.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__clip=String(text);},readText:async()=>window.__clip||''}}));
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`${process.env.CHATHAND_UI_URL}/?${query}${query.includes('now=') ? '' : '&now=' + now}#tok.uikey`);
  await page.waitForSelector(wait, { timeout: 8000 }); await page.waitForTimeout(900);
  return { page, errs, close: () => b.close() };
}
module.exports = { open };
if (require.main === module) (async () => {
  const [q = '', out = 'shot.png', theme = 'light', size = '1280x860', js] = process.argv.slice(2);
  const [w, h] = size.split('x').map(Number);
  const { page, errs, close } = await open(q, { theme, w, h });
  if (js) { await page.evaluate(js); await page.waitForTimeout(700); }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await page.screenshot({ path: out });
  console.log('wrote', out, errs.length ? ('errors: ' + errs.slice(0, 5).join(' | ')) : 'no errors');
  await close();
})().catch(e => { console.error(e.message); process.exit(1); });
