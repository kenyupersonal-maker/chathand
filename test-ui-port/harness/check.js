#!/usr/bin/env node
'use strict';
/* 1011 单页工作台自检：保留向导和首次设置助手检查；主窗口仅做 15 条冒烟检查。
   npm --prefix test-ui-port test；本机 Chrome，不下载浏览器。截图放 ~/Developer/ChatHand-builds.noindex/1011-ui-check/。 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { start } = require('./server');
const { ROOT, openProduct, launchBrowser } = require('./common');
const fixtures = require('./fixtures');
const { screenshot, XOUT } = require('./states');
const os = require('node:os');

const args = process.argv.slice(2);
const VERBOSE = args.includes('-v') || args.includes('--verbose');
const only = ((args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '').split(',').filter(Boolean);
const wants = key => !only.length || only.includes(key);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCENARIOS = ['run', 'idle', 'offline', 'unset'];
const ISSUES_URL = 'https://github.com/kenyupersonal-maker/chathand/issues/new/choose';
const RELEASES_URL = 'https://github.com/kenyupersonal-maker/chathand/releases';
const TUNNEL = fixtures.TUNNEL, IDS = fixtures.IDS;

/* ---------- 记结果 ---------- */
const results = [];
let group = '';
const pass = name => { results.push({ group, name, ok: true }); if (VERBOSE) console.log('    通过  ' + name); };
const fail = (name, detail) => { results.push({ group, name, ok: false, detail }); console.log('    失败  ' + name + (detail ? '  ——  ' + detail : '')); };
function check(name, cond, detail) { if (cond) pass(name); else fail(name, typeof detail === 'function' ? detail() : detail); return !!cond; }
async function checkA(name, cond, detail) { if (cond) pass(name); else fail(name, detail ? await detail() : undefined); return !!cond; }   // detail 要异步取的时候用这个
const note = text => console.log('    提示  ' + text);
function begin(name) { group = name; console.log('\n== ' + name); }

/* ---------- 小工具 ---------- */
async function waitFor(fn, ms = 2500, step = 40) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* 页面正在重绘，再试 */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}
const posts = srv => srv.log.filter(x => x.method === 'POST');
const gotPost = (srv, url, pred = () => true) => posts(srv).some(x => x.url === url && pred(x.body || {}));
const expectPost = async (name, srv, url, pred) => check(name, await waitFor(() => gotPost(srv, url, pred)), () => `假服务没收到 POST ${url}${pred ? '（或内容不对）' : ''}；收到的有 ${posts(srv).map(x => x.url).join(' ') || '无'}`);
const nativeCalls = page => page.evaluate(() => window.__native.slice());
async function expectNative(name, page, action, pred = () => true) {
  const ok = await waitFor(async () => (await nativeCalls(page)).some(x => x.action === action && pred(x.data || {})));
  if (ok) return pass(name);
  fail(name, `原生桥没收到 ${action}${pred.length ? '（或内容不对）' : ''}；收到的有 ${(await nativeCalls(page)).map(x => x.action).join(' ') || '无'}`);
}
const toastText = page => page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : ''; });
async function expectToast(name, page, re) {
  let last = '';
  const ok = await waitFor(async () => { last = await toastText(page); return re.test(last); });
  check(name, ok, () => `提示框里是「${last}」，想要 ${re}`);
}
/* 点一下，并等这次点击引出的动作跑完（按钮的处理函数最后会 refresh 一次），下一步操作才不会和它撞在一起 */
async function click(page, sel, name, opts = {}) {
  try { await page.click(sel, { timeout: 3000, ...opts }); }
  catch (e) { fail(name || `点 ${sel}`, String(e.message).split('\n')[0]); return false; }
  await page.waitForTimeout(60);
  await settle(page).catch(() => {});
  return true;
}
const count = (page, sel) => page.locator(sel).count();
/* 等页面里正在进行的那次状态刷新结束。app.js 的 refresh() 在上一次没结束时会直接返回，紧挨着改设置的话，弹窗里可能读到旧状态 */
const settle = page => page.evaluate(async () => { for (let i = 0; i < 100 && refreshing; i++) await new Promise(r => setTimeout(r, 10)); });
/* 在弹窗里换「连接方式」：等上一次刷新结束后，立刻在同一个 JS 任务里改值、发 change，缩小和 2.5 秒轮询撞上的机会（Playwright 自己的 selectOption 要来回好几毫秒） */
const chooseBackend = (page, value) => page.evaluate(async v => {
  for (let i = 0; i < 100 && refreshing; i++) await new Promise(r => setTimeout(r, 5));
  const sel = document.querySelector('#backend');
  sel.value = v;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const text = (page, sel) => page.locator(sel).first().innerText({ timeout: 1000 }).catch(() => '');
const modalOpen = page => page.evaluate(() => document.querySelector('#modal').open);
const wizardOpen = page => page.evaluate(() => !document.querySelector('#setupWizard').hidden);
async function goPage(page, p) { await page.click(`#rail [data-action="drawer"][data-id="${p}"]`, { timeout: 3000 }); await page.waitForTimeout(120); }
async function closeModal(page) { if (await modalOpen(page)) { await page.click('#closeModal', { timeout: 2000 }).catch(() => {}); await page.waitForTimeout(60); } }
async function closeWizard(page) { if (await wizardOpen(page)) { await page.click('#setupWizard .setup-later', { timeout: 2000 }).catch(() => {}); await page.waitForTimeout(80); } }
const noErrors = (page, name, since = 0) => { const errs = page.errors.slice(since); return check(name, !errs.length, () => errs.join(' | ')); };

/* 页面里点过的动作名，最后汇总一下哪些 data-action 从来没被点过 */
const covered = new Set();
async function harvest(page) { try { for (const c of await page.evaluate(() => window.__clicks || [])) covered.add(c); } catch { /* 页面已关 */ } }

/* 打开产品页：真实时间（不固定，轮询照常跑）、不冻动画、装上假原生桥、confirm 一律点确定、记下意外弹出的新窗口 */
async function open(browser, srv, theme, scenario, opts = {}) {
  const r = await openProduct(browser, srv.url, theme, scenario, { now: 0, freeze: false, native: true, ...opts });
  r.page.dialogs = [];
  r.page.popups = [];
  r.page.on('dialog', d => { r.page.dialogs.push(d.message()); d.accept().catch(() => {}); });
  r.ctx.on('page', p => { r.page.popups.push(p.url()); p.close().catch(() => {}); });
  await r.page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-action],[data-toggle],[data-filter],[data-task],[data-page],[data-wizard],[data-sub]');
      if (b) window.__clicks.push(b.dataset.action || (b.dataset.toggle && 'toggle:' + b.dataset.toggle) || (b.dataset.filter && 'filter:' + b.dataset.filter) || (b.dataset.task && 'task-row') || (b.dataset.page && 'nav:' + b.dataset.page) || (b.dataset.wizard && 'wizard:' + b.dataset.wizard) || (b.dataset.sub !== undefined && 'wizard:sub') || '');
    }, true);
  });
  return r;
}
async function done(r) { await harvest(r.page); await r.ctx.close(); }

/* 在页面里跑的自查：图标、图片、文字、按钮名字、重复 id、溢出 */
const AUDIT = () => {
  const out = [];
  const q = s => [...document.querySelectorAll(s)];
  /* 收起的 <details> 里的东西 Chromium 照样能量出尺寸，得单独排除（它自己的 <summary> 除外） */
  const visible = el => { if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false; const d = el.closest('details:not([open])'); return !d || (el.tagName === 'SUMMARY' && el.parentElement === d); };
  for (const u of q('use')) { const id = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').replace(/^#/, ''); if (id && !document.getElementById(id)) out.push('图标 #' + id + ' 在 index.html 里没有定义'); }
  for (const i of q('img')) if (i.complete && !i.naturalWidth) out.push('图片没加载出来：' + i.getAttribute('src'));
  const shown = ['#app', '#modal[open]', '#drawer[open]', '#toast:not([hidden])', '#setupWizard:not([hidden])', 'dialog.tutorialZoom[open]'].map(s => { const e = document.querySelector(s); return e ? e.innerText : ''; }).join('\n');
  const bad = shown.match(/undefined|\bnull\b|NaN|\[object|\$\{/g);
  if (bad) out.push('可见文字里出现了 ' + [...new Set(bad)].join('、'));
  for (const b of q('button, a[data-action], summary')) {
    if (!visible(b)) continue;
    const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (!name) out.push('没有文字也没有 aria-label 的按钮：' + b.outerHTML.slice(0, 90));
  }
  const seen = new Map();
  for (const e of q('[id]')) seen.set(e.id, (seen.get(e.id) || 0) + 1);
  for (const [k, n] of seen) if (n > 1) out.push('重复的 id：' + k);
  const m = document.querySelector('#main');
  if (m && m.scrollWidth > m.clientWidth + 1) out.push('主区域横向溢出 ' + m.scrollWidth + ' > ' + m.clientWidth);
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push('整页横向溢出 ' + document.documentElement.scrollWidth + ' > ' + innerWidth);
  return out;
};
async function audit(page, label, quiet = false) {
  const issues = await page.evaluate(AUDIT);
  for (const i of issues) fail(label + '：' + i);
  if (!issues.length && !quiet) pass(label + '：页面自查通过');
  return !issues.length;
}

/* ============================== 1. 静态 ============================== */
async function staticChecks(browser) {
  begin('静态检查');
  const ui = f => path.join(ROOT, 'ui', f);
  for (const f of ['app.js', 'wizard.js']) {
    try { execFileSync(process.execPath, ['--check', ui(f)], { stdio: 'pipe' }); pass(f + ' 语法'); }
    catch (e) { fail(f + ' 语法', String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')); }
  }
  const css = fs.readFileSync(ui('style.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const n = c => bare.split(c).length - 1;
  check('style.css 花括号成对', n('{') === n('}'), `{ ${n('{')} 个，} ${n('}')} 个`);
  check('style.css 注释成对', (css.match(/\/\*/g) || []).length === (css.match(/\*\//g) || []).length);
  const audit1 = await cssAudit(browser, css);
  check(`style.css 的 ${audit1.n} 条规则，浏览器的选择器和声明都认`, !audit1.bad.length, () => audit1.bad.slice(0, 8).join('；'));
  const propertyCanary=await cssAudit(browser,"@property --sa6-good{syntax:'<color>';inherits:true;initial-value:transparent}@property --sa6-bad{syntax:'<color>';inherits:banana;initial-value:transparent}");
  check('@property 使用浏览器描述符语法且拒绝无效注册',propertyCanary.bad.length===1&&propertyCanary.bad[0].includes('--sa6-bad'),()=>propertyCanary.bad.join('；'));
  const mixedPropertyCanary=await cssAudit(browser,"@property --sa6-unknown{syntax:'<color>';inherits:true;initial-value:transparent;bogus:banana}@property --sa6-duplicate{syntax:'<color>';inherits:true;initial-value:transparent;inherits:banana}");
  check('@property 不漏掉被浏览器静默丢弃的未知或无效重复描述符',mixedPropertyCanary.bad.length===2&&['--sa6-unknown','--sa6-duplicate'].every(name=>mixedPropertyCanary.bad.some(b=>b.includes(name))),()=>mixedPropertyCanary.bad.join('；'));
  const ordinaryCssCanary=await cssAudit(browser,'.sa6-invalid-css{color:banana}');
  check('普通无效CSS声明仍被拒绝',ordinaryCssCanary.bad.length===1&&ordinaryCssCanary.bad[0].includes('color: banana'),()=>ordinaryCssCanary.bad.join('；'));
  const fontFaceCanary=await cssAudit(browser,'@font-face{font-family:"sa6-good";src:local("PingFangSC-Regular");font-weight:600 900;unicode-range:U+3000-303F}@font-face{font-family:"sa6-bad";src:local("PingFangSC-Regular");unicode-range:banana}');
  check('@font-face 使用浏览器描述符语法且拒绝无效 unicode-range',fontFaceCanary.bad.length===1&&fontFaceCanary.bad[0].includes('unicode-range: banana'),()=>fontFaceCanary.bad.join('；'));
  const html = fs.readFileSync(ui('index.html'), 'utf8');
  const app = fs.readFileSync(ui('app.js'), 'utf8');
  const used = [...new Set(app.match(/\b(?:i|ch)-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g) || [])];
  const missing = used.filter(id => !new RegExp(`<symbol[^>]*\\sid="${id}"`).test(html));
  check(`app.js 里用到的 ${used.length} 个图标，index.html 里都有`, !missing.length, () => '缺：' + missing.join(' '));
  for (const f of ['index.html', 'style.css', 'app.js']) {
    const t = fs.readFileSync(ui(f), 'utf8');
    check(f + ' 里没有留下 console.log / debugger / TODO', !/console\.log|debugger|TODO|FIXME/.test(t));
  }
  check('index.html 没有引用外网资源（页面要能离线打开）', !/<(?:script|link|img)[^>]+(?:src|href)="https?:/.test(html));
}

/* 把 CSS 拆成「选择器 + 声明」，交给浏览器逐条问一遍认不认。浏览器遇到不认的选择器会整条丢掉、不认的声明会悄悄丢掉，页面上看不出来，这里把它们找出来 */
function splitCss(css) {
  const t = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [], media = [];
  const skipTo = (str, i, ch) => { for (let d = 0, q = ''; i < str.length; i++) { const c = str[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '(') d++; else if (c === ')') d--; else if (c === ch && d <= 0) return i; } return str.length; };
  const blockEnd = (str, i) => { let d = 0, q = ''; for (; i < str.length; i++) { const c = str[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '{') d++; else if (c === '}') { d--; if (d === 0) return i; } } return str.length; };
  const decls = body => { const out = []; let i = 0; while (i < body.length) { const j = skipTo(body, i, ';'); const d = body.slice(i, j).trim(); i = j + 1; const k = d.indexOf(':'); if (d && k > 0) {const value=d.slice(k + 1);out.push([d.slice(0, k).trim(),value.replace(/!important\s*$/i, '').trim(),/!important\s*$/i.test(value)]);} } return out; };
  (function walk(str) {
    let i = 0;
    while (i < str.length) {
      const open = str.indexOf('{', i); if (open < 0) break;
      const prelude = str.slice(i, open).trim(), end = blockEnd(str, open), body = str.slice(open + 1, end);
      if (/^@(media|supports|layer|container)/.test(prelude)) { if (/^@media/.test(prelude)) media.push(prelude.replace(/^@media\s*/, '')); walk(body); }
      else if (/^@keyframes/.test(prelude)) { /* 关键帧里的声明也是普通声明 */ rules.push({ selector: null, decls: decls(body.replace(/[^{}]*\{([^}]*)\}/g, '$1;')) }); }
      else if (prelude.startsWith('@')) rules.push({ selector: null, atRule:prelude, body, decls: decls(body) });
      else rules.push({ selector: prelude, decls: decls(body) });
      i = end + 1;
    }
  })(t);
  return { rules, media };
}
async function cssAudit(browser, css) {
  const { rules, media } = splitCss(css);
  const page = await browser.newPage();
  const bad = await page.evaluate(({ rules, media }) => {
    const out = [];
    const frag = document.createDocumentFragment();
    for (const r of rules) {
      if (/^@font-face(?:\s|$)/i.test(r.atRule||'')) {
        // Parse each occurrence alone so a later valid duplicate cannot hide a
        // descriptor that the browser silently discarded.
        for(const[p,v,important]of r.decls){
          let accepted=false;
          try{const sheet=new CSSStyleSheet();sheet.replaceSync('@font-face{'+p+':'+v+(important?' !important':'')+'}');const rule=sheet.cssRules[0];accepted=rule?.constructor.name==='CSSFontFaceRule'&&!!rule.style.getPropertyValue(p); }catch{}
          if(!accepted)out.push(`无效字体描述符：${r.atRule} { ${p}: ${v}${important?' !important':''} }`);
        }
        continue;
      }
      if (/^@property(?:\s|$)/i.test(r.atRule||'')) {
        const parse=body=>{try{const sheet=new CSSStyleSheet();sheet.replaceSync(r.atRule+'{'+body+'}');return sheet.cssRules.length===1&&sheet.cssRules[0].constructor.name==='CSSPropertyRule'?sheet.cssRules[0]:null;}catch{return null;}};
        const registered=parse(r.body);
        if(!registered){out.push('无效属性注册：'+r.atRule);continue;}
        const baseline=new Map([['syntax',JSON.stringify(registered.syntax)],['inherits',String(registered.inherits)]]);
        if(registered.initialValue!==null)baseline.set('initial-value',registered.initialValue);
        // A surviving CSSPropertyRule may have silently discarded a descriptor.
        // Validate every source occurrence independently, including duplicates.
        for(const[p,v,important]of r.decls){const descriptor=p.toLowerCase();
          if(!['syntax','inherits','initial-value'].includes(descriptor)||important){out.push(`无效属性描述符：${r.atRule} { ${p}: ${v}${important?' !important':''} }`);continue;}
          const context=[...baseline].filter(([name])=>name!==descriptor).map(([name,value])=>name+':'+value);
          const tested=parse([...context,descriptor+':'+v].join(';'));
          if(!tested||descriptor==='initial-value'&&tested.initialValue===null)out.push(`无效属性描述符：${r.atRule} { ${p}: ${v} }`);
        }
        continue;
      }
      if (r.selector) { try { frag.querySelector(r.selector); } catch (e) { out.push('选择器不认：' + r.selector.slice(0, 90)); } }
      for (const [p, v] of r.decls) {
        if (p.startsWith('--') || p.startsWith('-webkit-')) continue;   // 自定义属性、WebKit 前缀（给 WKWebView 用的，Chromium 不认）不查
        if (!CSS.supports(p, v) && !CSS.supports(p, v.replace(/var\([^)]*\)/g, 'inherit'))) out.push(`声明不认：${(r.selector || '@').slice(0, 40)} { ${p}: ${v.slice(0, 60)} }`);
      }
    }
    return out;
  }, { rules, media });
  await page.close();
  return { bad, n: rules.length };
}

/* ============================== 1.5 收集器自己好不好用 ============================== */
async function canary(browser, srv) {
  begin('检查用的收集器本身能用（故意制造 3 种错误，都要被抓到）');
  const r = await open(browser, srv, 'light', 'idle');
  const { page } = r;
  await page.evaluate(() => {
    console.error('canary-console');
    setTimeout(() => { throw new Error('canary-throw'); }, 0);
    const img = new Image(); img.src = '/assets/canary-missing.png'; document.body.append(img);
  });
  await page.waitForTimeout(500);
  check('console.error 被抓到', page.errors.some(e => /canary-console/.test(e)));
  check('未捕获的异常被抓到', page.errors.some(e => /canary-throw/.test(e)));
  check('404 的资源被抓到', page.errors.some(e => /404|Failed to load/.test(e)));
  await page.evaluate(() => document.querySelector('img[src*="canary"]')?.remove());
  await r.ctx.close();
  const badCss = await cssAudit(browser, 'a{colr:red;color:bluee;margin:1px}b:nope(1){color:red}');
  check('CSS 检查能抓到写错的属性、值、选择器', badCss.bad.length === 3, () => badCss.bad.join('；'));
}

/* ============================== 2. 1011 工作台冒烟（最多 20 条） ============================== */
async function workbench(browser, srv) {
  begin('1011 单页工作台冒烟（15 条）');
  for (const theme of ['light','dark']) for (const [width,height] of [[1280,860],[980,680]]) {
    const issues = [];
    for (const scenario of SCENARIOS) {
      const r = await open(browser, srv, theme, scenario, { size: { width,height } });
      try {
        const bad = await r.page.evaluate(AUDIT);
        issues.push(...bad.map(x => scenario + '：' + x), ...r.page.errors.map(x => scenario + '：' + x));
        await screenshot(r.page, `home-${scenario}-${theme}-${width}x${height}`);
      } finally { await done(r); }
    }
    check(`${width}x${height}/${theme} 四个状态无报错、无横向溢出`, !issues.length, () => issues.join('；'));
  }
  const r = await open(browser, srv, 'light', 'idle', { size: { width: 1280,height: 860 } }), page = r.page;
  try {
    const failures = [];
    if (await count(page,'#rail .rail-stick > .card') !== 4) failures.push('右栏不是四张卡');
    await goPage(page,'settings');
    if (await text(page,'#drawerTitle') !== '设置') failures.push('设置抽屉没打开');
    for (const [view,title] of [['terminal','命令'],['browser','浏览器控制'],['desktop','桌面控制'],['scope','文件范围'],['conn','ChatGPT 连接'],['help','帮助与反馈']]) {
      await page.click(`#drawerBody [data-action="drawer"][data-id="${view}"]`);
      if (await text(page,'#drawerTitle') !== title) failures.push(view + ' 标题不对');
      await screenshot(page, 'drawer-' + view + '-light');
      await page.click('#drawerBack');
      if (await text(page,'#drawerTitle') !== '设置') failures.push(view + ' 返回失败');
    }
    await screenshot(page,'drawer-settings-light');
    await page.keyboard.press('Escape');
    if (await page.locator('#drawer').evaluate(d => d.open)) failures.push('Esc 未关闭抽屉');
    failures.push(...page.errors);
    check('四张卡、设置六页进入与返回、Esc 关闭', !failures.length, () => failures.join('；'));
    const switches = [];
    for (const [key,view] of [['terminal_enabled','terminal'],['browser_enabled','browser'],['desktop_enabled','desktop']]) {
      srv.log.length = 0;
      const selector = `#rail [data-toggle="${key}"]`, before = await page.locator(selector).getAttribute('aria-checked');
      await click(page,selector);
      if (!await waitFor(() => gotPost(srv,'/api/settings',b => b[key] === (before !== 'true')))) switches.push(key + ' 未发正确设置');
      if (posts(srv).some(x => x.url !== '/api/settings')) switches.push(key + ' 发了其它请求');
      if (await page.locator('#drawer').evaluate(d => d.open)) switches.push(key + ' 打开了抽屉');
      await click(page,`#rail .pr[data-id="${view}"] .pr-l`);
      if (await page.evaluate(v => drawer?.view === v,view) !== true) switches.push(view + ' 行没有打开详情');
      await page.keyboard.press('Escape');
    }
    check('外面三个开关只发设置；整行打开对应详情', !switches.length && !page.errors.length, () => switches.concat(page.errors).join('；'));
    await goPage(page,'settings'); await page.click('#drawerBody [data-action="drawer"][data-id="terminal"]');
    check('命令详情有黄条和九项高危命令', await count(page,'#drawerBody .ybar') === 1 && await count(page,'#drawerBody .risk-row') === 9 && !page.errors.length);
    await page.keyboard.press('Escape'); await goPage(page,'help');
    srv.log.length = 0;
    await click(page,'#drawerBody [data-action="repair"]');
    const repaired = await waitFor(async () => await count(page,'#drawerBody .rp-i') === 12);
    await screenshot(page,'help-repair-light');
    await click(page,'#drawerBody [data-action="aiBrief"]');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check('检查并修复发请求显示十二项；复制给 AI 发请求并复制', gotPost(srv,'/api/support/repair',b => b.login_item_requires_approval === false) && repaired && gotPost(srv,'/api/support/ai-brief') && copied.includes('测试用的诊断') && !page.errors.length, () => page.errors.join('；'));
  } finally { await done(r); }
  const u = await open(browser,srv,'light','idle',{ extra: '&api_unknown=1' });
  try {
    await goPage(u.page,'help');srv.log.length = 0;
    await click(u.page,'#drawerBody [data-action="repair"]');
    const hint = await toastText(u.page);
    await screenshot(u.page,'repair-api-unknown-light');
    check('API_UNKNOWN 只提示一句，页面不报错', gotPost(srv,'/api/support/repair') && hint === '当前版本不支持「检查并修复」，请先尝试「重新连接」' && await count(u.page,'#drawerBody .rp-i') === 0 && !u.page.errors.length, () => hint + ' ' + u.page.errors.join('；'));
  } finally { await done(u); }
  for (const [state,expected] of [['available','有新版本 1.0.1'],['downloading','正在下载 32%'],['waiting_tasks','任务完成后自动更新'],['failed','更新失败'],['just_updated','已更新到 1.0.1']]) {
    const issues = [];
    for (const theme of ['light','dark']) {
      const r = await open(browser,srv,theme,'run',{ extra:'&update='+state });
      try {
        const body = await text(r.page,'#bubble');
        if (!body.includes(expected)) issues.push(theme + ' 气泡文字不对');
        if (state === 'downloading' && await r.page.locator('#bubble .bb-bar i').evaluate(i => i.style.width) !== '32%') issues.push('下载进度条不是 32%');
        if (state === 'available' && (body.includes('设置页更好找') || !body.includes('修好了断网'))) issues.push('更新说明没有只显示第一行');
        if (state === 'failed' && !body.includes('已换回原来的版本')) issues.push('失败恢复文字缺失');
        if (state === 'just_updated' && !body.includes('刷新工具')) issues.push('工具更新提醒缺失');
        issues.push(...r.page.errors,...await r.page.evaluate(AUDIT));
        await screenshot(r.page,'update-'+state+'-'+theme);
      } finally { await done(r); }
    }
    check('更新气泡 '+state+' 浅深色文字与进度', !issues.length,() => issues.join('；'));
  }
  const flow = [];
  for (const pending of [false,true]) {
    const r = await open(browser,srv,'light','run',{ extra: pending ? '&pending=1' : '' });
    try {
      const glow = await count(r.page,'.tp.run');
      if (glow !== (pending ? 0 : 1)) flow.push(pending ? '待处理仍有流光' : '运行中缺少流光');
      if (!pending && !(await text(r.page,'.tp')).includes('正在验证 24 组参数组合')) flow.push('命令最后一行没显示');
      flow.push(...r.page.errors);
      await screenshot(r.page,pending ? 'home-pending-light' : 'home-running-light');
    } finally { await done(r); }
  }
  check('运行中有流光和命令最后一行；等你处理没有流光', !flow.length,() => flow.join('；'));
}

async function ensureManualWizard(page) {
  return waitFor(() => wizardOpen(page));
}

/* ============================== 4. 向导 ============================== */
async function wizard(browser, srv) {
  begin('设置向导：从第 1 步走到第 7 步');
  const r = await open(browser, srv, 'light', 'idle');
  const { page } = r;
  await goPage(page, 'conn');
  await click(page, '#drawerBody [data-action="manual"]', '连接页点「换一条通道」');
  check('打开向导，第 1 步「创建通道」', await waitFor(async () => (await wizardOpen(page)) && /创建通道/.test(await text(page, '.setup-step.current')) && (await count(page, '.tut-frame img')) === 1));
  await page.waitForTimeout(400);
  await audit(page, '向导第 1 步');
  check('左侧 7 个步骤', (await count(page, '.setup-step')) === 7);
  check('第 1 步没有「上一步」', (await count(page, '[data-wizard="back"]')) === 0);
  /* 放大截图 */
  await click(page, '.tut-frame', '点教程截图');
  check('点截图 → 放大弹窗（有图、有「关闭」）', await waitFor(async () => (await count(page, 'dialog.tutorialZoom[open] img')) === 1 && (await count(page, 'dialog.tutorialZoom[open] button')) === 1));
  await page.waitForTimeout(150);
  await audit(page, '放大弹窗');
  await click(page, 'dialog.tutorialZoom button', '点放大弹窗的「关闭」');
  check('点「关闭」→ 放大弹窗关掉', await waitFor(async () => (await count(page, 'dialog.tutorialZoom[open]')) === 0));
  /* 切换小步骤 */
  const src0 = await page.getAttribute('.tut-frame img', 'src');
  await click(page, '.tut-row >> nth=1', '点第 2 个小步骤');
  check('点第 2 个小步骤 → 高亮换了，截图换了', (await page.locator('.tut-row').nth(1).getAttribute('class')).includes('active') && (await page.getAttribute('.tut-frame img', 'src')) !== src0);
  /* 通道 ID 校验 */
  srv.log.length = 0;
  check('已经配置过通道时，输入框里预先填着当前的通道 ID', (await page.inputValue('#wizardTunnel')) === TUNNEL);
  await page.fill('#wizardTunnel', '');
  await click(page, '#wizardNext', '不填通道 ID 点「继续」');
  check('通道 ID 为空点「继续」→ 提示「请粘贴正确的通道 ID」', await waitFor(async () => /请粘贴正确的通道 ID/.test(await text(page, '#wizardError'))));
  await page.fill('#wizardTunnel', 'abc');
  await click(page, '#wizardNext', '填错的通道 ID 点「继续」');
  check('填错的通道 ID → 同样提示', /请粘贴正确的通道 ID/.test(await text(page, '#wizardError')));
  await page.fill('#wizardTunnel', TUNNEL);
  await click(page, '#wizardNext', '填对通道 ID 点「继续」');
  await expectPost('「继续」→ POST /api/setup/progress {step:1, tunnel_id}', srv, '/api/setup/progress', b => b.step === 1 && b.tunnel_id === TUNNEL);
  check('进入第 2 步「运行密钥」，出现「上一步」', await waitFor(async () => /运行密钥/.test(await text(page, '.setup-step.current')) && (await count(page, '[data-wizard="back"]')) === 1));
  check('左侧第 1 步打了对勾', /✓/.test(await text(page, '.setup-step.done')));
  await audit(page, '向导第 2 步');
  /* 第 2 步：⌘V 粘贴密钥 */
  await page.focus('.key-slot');
  await page.keyboard.press('Meta+v');
  await expectNative('在密钥框里按 ⌘V → 原生桥 pasteRuntimeKey', page, 'pasteRuntimeKey', d => d.tunnel_id === TUNNEL && d.trigger === 'command_v');
  check('粘贴后密钥框显示「已保存 · •••• a3f9」', await waitFor(async () => /已保存 · •••• a3f9/.test(await text(page, '.key-slot strong'))));
  await click(page, 'details:has-text("无法连接怎么办") summary', '点「无法连接怎么办」');
  srv.log.length = 0;
  await click(page, '[data-wizard="connectAgain"]', '点「重新连接」');
  await expectPost('向导里「重新连接」→ POST /api/connect/restore', srv, '/api/connect/restore');
  check('已连接时，「继续」是可点的', await waitFor(async () => !(await page.locator('#wizardNext').isDisabled())));
  await click(page, '#wizardNext', '第 2 步点「继续」');
  check('进入第 3 步「添加到 ChatGPT」，按钮写「我加好了」', await waitFor(async () => /添加到 ChatGPT/.test(await text(page, '.setup-step.current')) && /我加好了/.test(await text(page, '#wizardNext'))));
  await audit(page, '向导第 3 步');
  await page.evaluate(() => { window.__native.length = 0; });
  await click(page, '[data-wizard="copyName"]', '点「复制名称」');
  await expectNative('「复制名称」→ 原生桥 copyText「ChatHand」', page, 'copyText', d => d.text === 'ChatHand');
  await click(page, '[data-wizard="copyTunnel"]', '点「复制通道 ID」');
  await expectNative('「复制通道 ID」→ 原生桥 copyText（通道 ID）', page, 'copyText', d => d.text === TUNNEL);
  await expectToast('复制后提示「已复制」', page, /已复制/);
  await click(page, '#wizardNext', '点「我加好了」');
  check('进入第 4 步「测试连接」', await waitFor(async () => /测试连接/.test(await text(page, '.setup-step.current')) && (await count(page, '.test-prompt')) === 1));
  await audit(page, '向导第 4 步');
  const testStepText = await text(page, '.setup-controls');
  check('第 4 步不提示「永远允许」（只在第 7 步提一次）', /复制测试口令/.test(testStepText) && !/永远允许/.test(testStepText));
  await click(page, '[data-wizard="copyTest"]', '点「复制测试口令」');
  await expectNative('「复制测试口令」→ 原生桥 copyText（含暗号）', page, 'copyText', d => /暗号/.test(d.text));
  srv.log.length = 0;
  await click(page, '[data-wizard="retest"]', '点「重新测试」');
  await expectPost('「重新测试」→ POST /api/setup/test/start', srv, '/api/setup/test/start');
  check('测试没通过前，「继续」是灰的', await page.locator('#wizardNext').isDisabled());
  await click(page, '[data-wizard="back"]', '点「上一步」');
  check('「上一步」→ 回到第 3 步', await waitFor(async () => /添加到 ChatGPT/.test(await text(page, '.setup-step.current'))));
  await click(page, '.setup-later', '点「稍后继续」');
  check('「稍后继续」→ 向导收起，主界面恢复', !(await wizardOpen(page)) && await page.evaluate(() => !document.querySelector('#app').inert));
  noErrors(page, '向导第 1–4 步：console 没有报错');
  await done(r);

  /* 第 4 步测试通过之后的步骤：直接停在第 4 步，测试结果设成通过 */
  const r2 = await open(browser, srv, 'light', 'idle', { extra: '&wizard=3&test=ok' });
  const p2 = r2.page;
  check('带 &wizard=3&test=ok 打开，向导直接停在第 4 步', await waitFor(async () => (await wizardOpen(p2)) && /测试连接/.test(await text(p2, '.setup-step.current'))));
  check('两次测试都收到，「继续」可点', await waitFor(async () => /读写都通/.test(await text(p2, '#wizardTest')) && !(await p2.locator('#wizardNext').isDisabled())));
  await audit(p2, '向导第 4 步（测试通过）');
  await click(p2, '#wizardNext', '第 4 步点「继续」');
  check('进入第 5 步「工作区」，有两张范围卡片', await waitFor(async () => /工作区/.test(await text(p2, '.setup-step.current')) && (await count(p2, '.scope-card')) === 2));
  await audit(p2, '向导第 5 步');
  srv.log.length = 0;
  p2.dialogs.length = 0;
  await click(p2, '[data-wizard="full"]', '点「整台电脑」');
  check('点「整台电脑」→ 先弹确认框，再 POST /api/mode {mode:full}', await waitFor(() => p2.dialogs.some(d => /完全访问/.test(d))) && await waitFor(() => gotPost(srv, '/api/mode', b => b.mode === 'full' && b.confirm === true)));
  check('选中的卡片换成「整台电脑」', await waitFor(async () => /整台电脑/.test(await text(p2, '.scope-card.chosen'))));
  await click(p2, '[data-wizard="workspace"]', '点「工作区内自动」');
  await expectPost('「工作区内自动」→ POST /api/mode {mode:auto}', srv, '/api/mode', b => b.mode === 'auto');
  await click(p2, '[data-wizard="chooseWorkspace"]', '点「换一个文件夹」');
  await expectNative('「换一个文件夹」→ 原生桥 chooseFolder', p2, 'chooseFolder');
  await expectPost('→ POST /api/projects/add', srv, '/api/projects/add');
  srv.log.length = 0;
  await click(p2, '#wizardNext', '第 5 步点「继续」');
  await expectPost('「继续」→ POST /api/setup/workspace', srv, '/api/setup/workspace');
  check('进入第 6 步「浏览器和桌面」', await waitFor(async () => /浏览器和桌面/.test(await text(p2, '.setup-step.current')) && (await count(p2, '.control-row')) === 2));
  await audit(p2, '向导第 6 步');
  check('第 6 步的「继续」写着「继续（未开启的可稍后设置）」', /未开启的可稍后设置/.test(await text(p2, '#wizardNext')));
  await p2.evaluate(() => { window.__native.length = 0; });
  await click(p2, '[data-wizard="extension"]', '点「打开扩展文件夹」');
  await expectNative('「打开扩展文件夹」→ 原生桥 extensionSetup', p2, 'extensionSetup');
  check('弹出「装 Chrome 助手」窗口，在向导上面能点', await waitFor(async () => (await modalOpen(p2)) && /装 Chrome 助手/.test(await text(p2, '#modal h2'))));
  await audit(p2, '向导上面的弹窗');
  await click(p2, '#closeModal', '点弹窗右上角的 ×（弹窗在向导上面）');
  check('弹窗盖在向导上面，× 点得到、能关掉', await waitFor(async () => !(await modalOpen(p2))) && (await wizardOpen(p2)));
  await click(p2, '[data-wizard="extensions"]', '点「打开 Chrome 扩展页」');
  await expectNative('「打开 Chrome 扩展页」→ 原生桥 extensionSettings', p2, 'extensionSettings');
  await click(p2, '[data-wizard="permissions"]', '点「打开授权助手」');
  await expectNative('「打开授权助手」→ 原生桥 computerPermissions', p2, 'computerPermissions');
  await click(p2, '#wizardNext', '第 6 步点「继续」');
  check('进入第 7 步「完成」：大图标、「准备好了」、「打开 ChatGPT」', await waitFor(async () => /完成/.test(await text(p2, '.setup-step.current')) && (await count(p2, '.setup-done img')) === 1 && /准备好了/.test(await text(p2, '.setup-done h1'))));
  await audit(p2, '向导第 7 步');
  check('第 7 步没有「继续」', (await count(p2, '#wizardNext')) === 0);
  check('第 7 步在「打开 ChatGPT」按钮下面有一行小字，提示第一次调用时点「永远允许」', await p2.evaluate(() => {
    const kids = [...document.querySelectorAll('.setup-done > *')];
    const b = kids.findIndex(k => k.matches('[data-wizard="finish"]')), h = kids.findIndex(k => k.classList.contains('hint') && /点「永远允许」/.test(k.textContent));
    return b >= 0 && h > b;
  }));
  const hintCol = await p2.evaluate(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--ink-3)'; document.body.appendChild(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    const el = document.querySelector('.setup-done .hint'), cs = el && getComputedStyle(el);
    return { got: cs && cs.color, want, size: cs && parseFloat(cs.fontSize) };
  });
  check('第 7 步的提示是灰色小字（--ink-3、不大于 12px）', hintCol.got === hintCol.want && hintCol.size <= 12, () => `颜色 ${hintCol.got}（应为 ${hintCol.want}），字号 ${hintCol.size}px`);
  await p2.evaluate(() => { window.__native.length = 0; });
  await click(p2, '[data-wizard="finish"]', '点「打开 ChatGPT」');
  await expectNative('完成页先复制默认试用语',p2,'copyText',d=>d.text==='@ChatHand 查一下这台 Mac 的系统版本和剩余空间');
  check('完成页提示去 ChatGPT 粘贴发送',await waitFor(async()=>/在 ChatGPT 里粘贴发送/.test(await toastText(p2)),2500));
  await expectNative('「打开 ChatGPT」→ 原生桥 openExternal（chatgpt.com）', p2, 'openExternal', d => d.url === 'https://chatgpt.com/');
  check('点完向导收起', await waitFor(async () => !(await wizardOpen(p2))));
  noErrors(p2, '向导第 4–7 步：console 没有报错');
  await done(r2);
}

/* ---- 向导版面 ----
   向导（wizard.js / wizard.css）是照旧版的全局样式调的：p 没有外边距，空的 .field-error 不显示。新样式里这些要自己补，
   补漏了的话，每个 p 上下多出 13px、空的错误行占一行，教程区被挤到比内容还矮，第 2 步截图下面的小字被密钥框盖住，第 6 步出现滚动条。
   这里逐步骤量：在页面里跑 WIZARD_LAYOUT，返回问题列表。 */
const WIZARD_LAYOUT = () => {
  const bad = [];
  const root = document.querySelector('#setupWizard');
  const sc = root.querySelector('.setup-scroll');
  const r = el => el.getBoundingClientRect();
  const label = el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') + (el.id ? '#' + el.id : '');
  const kidsOf = el => [...el.children].filter(c => { const b = r(c); return b.width > 0 && b.height > 0 && getComputedStyle(c).position !== 'absolute'; });
  const flow = (parent, name) => {
    const kids = kidsOf(parent);
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = r(kids[i]), b = r(kids[i + 1]);
      if (a.bottom > b.top + 1.5) bad.push(`${name}：${label(kids[i])}（底 ${Math.round(a.bottom)}）盖住了 ${label(kids[i + 1])}（顶 ${Math.round(b.top)}）`);
    }
    if (parent !== sc) for (const k of kids) if (r(k).bottom > r(parent).bottom + 1.5) bad.push(`${name}：${label(k)} 的底 ${Math.round(r(k).bottom)} 超出了 ${label(parent)} 的底 ${Math.round(r(parent).bottom)}`);
  };
  flow(sc, '向导内容区');
  for (const k of kidsOf(sc)) if (k.children.length > 1) flow(k, label(k));
  if (sc.scrollWidth > sc.clientWidth + 1) bad.push('向导内容区横向溢出');
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('整页横向溢出');
  for (const p of root.querySelectorAll('p')) {
    if (!r(p).height) continue;
    const cs = getComputedStyle(p);
    if (parseFloat(cs.marginBottom) > 5 || parseFloat(cs.marginTop) > 5) bad.push(`段落 ${label(p)} 有默认外边距 ${cs.marginTop} / ${cs.marginBottom}`);
  }
  const err = root.querySelector('#wizardError');
  if (err && !err.textContent.trim() && getComputedStyle(err).display !== 'none') bad.push('空的 #wizardError 还占着一行');
  return bad;
};
const WIZARD_STEPS = [
  { name: '第 1 步', scenario: 'unset', extra: '' },
  { name: '第 2 步', scenario: 'unset', extra: '', go: async p => { await p.fill('#wizardTunnel', TUNNEL); await p.click('#wizardNext'); await p.waitForSelector('.key-slot'); } },
  { name: '第 3 步', scenario: 'idle', extra: '&wizard=2' },
  { name: '第 4 步（等你发口令）', scenario: 'idle', extra: '&wizard=3&test=wait' },
  { name: '第 4 步（只收到读取）', scenario: 'idle', extra: '&wizard=3&test=read' },
  { name: '第 4 步（测试通过）', scenario: 'idle', extra: '&wizard=3&test=ok' },
  { name: '第 5 步', scenario: 'idle', extra: '&wizard=4' },
  { name: '第 6 步', scenario: 'idle', extra: '&wizard=5' },
  { name: '第 7 步', scenario: 'idle', extra: '&wizard=6' },
];
async function wizardLayout(browser, srv) {
  begin('向导版面：每一步在 1280x720、1150x780 和原生最小窗口 980x680 下不重叠、不溢出');
  for (const [w, h] of [[1280, 720], [1150, 780], [980, 680]]) {
    for (const st of WIZARD_STEPS) {
      const r = await open(browser, srv, 'light', st.scenario, { extra: st.extra, size: { width: w, height: h } });
      const { page } = r;
      await ensureManualWizard(page);
      await waitFor(() => page.evaluate(() => !document.querySelector('#setupWizard').hidden && !!document.querySelector('#setupWizard .setup-scroll')), 5000);
      if (st.go) await st.go(page);
      await page.waitForTimeout(350);
      const bad = await page.evaluate(WIZARD_LAYOUT);
      check(`${w}x${h} ${st.name}：版面没有重叠、没有多余外边距`, !bad.length, () => bad.join('；'));
      await done(r);
    }
  }
  /* 出错提示：红色（--bad），不是普通的灰字 */
  const r = await open(browser, srv, 'light', 'unset');
  const { page } = r;
  await ensureManualWizard(page);
  await waitFor(() => page.evaluate(() => !!document.querySelector('#wizardTunnel')), 5000);
  await page.fill('#wizardTunnel', 'abc');
  await page.click('#wizardNext');
  await waitFor(async () => /请粘贴正确的通道 ID/.test(await text(page, '#wizardError')));
  const col = await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--bad)'; document.body.appendChild(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    return { got: getComputedStyle(document.querySelector('#wizardError')).color, want };
  });
  check('通道 ID 填错的提示是红色（--bad）', col.got === col.want, () => `颜色是 ${col.got}，应该是 ${col.want}`);
  await done(r);
}

/* ============================== 跑起来 ============================== */
(async () => {
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(),'chathand-ui-check-'));
  process.env.CHATHAND_STATE_DIR = tempState;
  const srv = await start({ port: 0 });
  const browser = await launchBrowser();
  const t0 = Date.now();
  try {
    if (wants('静态')) await staticChecks(browser);
    if (wants('静态')) await canary(browser, srv);
    if (wants('巡检') || wants('点击') || wants('窗口')) await workbench(browser,srv);
    if (wants('向导')) { await wizard(browser,srv); await wizardLayout(browser,srv); }
    if (wants('皮肤')) {
      begin('皮肤');
      const { checkTokens } = await import('../../scripts/check-skin-tokens.mjs');
      const { checkSkin } = await import('../../scripts/check-skin.mjs');
      const tokens = await checkTokens(), skin = checkSkin();
      check('五个产品文件的颜色全部使用变量', tokens.ok, () => JSON.stringify(tokens.issues));
      check('皮肤属性白名单、动态限制和本地资源', skin.ok, () => JSON.stringify(skin.issues));
    }
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(tempState,{ recursive:true,force:true });
  }

  /* 汇总 */
  const groups = [...new Set(results.map(r => r.group))];
  console.log('\n================ 汇总 ================');
  for (const g of groups) {
    const rs = results.filter(r => r.group === g), bad = rs.filter(r => !r.ok).length;
    console.log(`${bad ? '有失败' : '全部通过'}  ${g}：${rs.length - bad} / ${rs.length}`);
  }
  console.log('截图目录：' + XOUT);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} 项通过，${failed.length} 项失败，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  if (failed.length) { console.log('失败的项：'); for (const f of failed) console.log(`  - [${f.group}] ${f.name}${f.detail ? '  ——  ' + f.detail : ''}`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
