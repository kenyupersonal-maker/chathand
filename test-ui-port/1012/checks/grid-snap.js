'use strict';
/* 对齐网点（10/4 定为默认：12 点间距、打开）。检查：
   1. 默认就是 12 点、html.snap-grid 打开；
   2. 主窗口里卡片、标题行、列表行的四条边都落在网点上（横向从左边距起，竖向从窗口顶边起）；
   3. 左右留白对称（最多差 1px）；
   4. 网点背景、鼠标光斑遮罩、画布网点（鼠标「让开」模式）跟着同一个原点；
   5. 有底栏的卡片，补齐高度多出来的放在底栏上面：底栏离卡片下边 = 卡片下内边距（边线 1px 以内）。
   换 8 / 16 / 24 点间距也要成立。单独跑：CHATHAND_TEST_CHROME=… node test-ui-port/1012/checks/grid-snap.js */
const { open } = require('../shoot');

function measure() {
  const r = document.documentElement, g = parseFloat(getComputedStyle(r).getPropertyValue('--dots-gap'));
  const dcs = getComputedStyle(document.querySelector('.dash')), pl = parseFloat(dcs.paddingLeft), pr = parseFloat(dcs.paddingRight);
  const ox = ((pl % g) + g) % g, off = (v, o) => { const m = (((v - o) % g) + g) % g; return Math.min(m, g - m); };
  const bad = [];
  for (const el of document.querySelectorAll('#main .tp-in,#main .orow,#rail .card,#main .col-h,#rail .col-h,.dtop,#main .recent-h,#main .rr')) {
    const b = el.getBoundingClientRect(); if (!b.width) continue;
    const f = [['L', b.left, ox], ['R', b.right, ox], ['T', b.top, 0], ['B', b.bottom, 0]].filter(([, v, o]) => off(v, o) > .6).map(([k, v]) => k + '=' + v.toFixed(1));
    if (f.length) bad.push(String(el.className.baseVal ?? el.className).slice(0, 24) + ' ' + f.join(' '));
  }
  const first = v => v.split(',')[0].trim().split(/\s+/).map(parseFloat), same = (a, b) => off(a, b) < .01;
  const [bx, by] = first(getComputedStyle(document.body).backgroundPosition);
  const spot = document.querySelector('.fx-spot'); let spotOk = true;
  if (spot) { const s = getComputedStyle(spot), [mx, my] = first(s.maskPosition || s.webkitMaskPosition); spotOk = same(mx, ox - g / 2) && same(my, -g / 2); }
  const foot = [];
  const tp = document.querySelector('#main .tp-in'), tf = tp?.querySelector(':scope>.tp-f');
  if (tf) foot.push(['进行中', tp.getBoundingClientRect().bottom - tf.getBoundingClientRect().bottom - parseFloat(getComputedStyle(tp).paddingBottom)]);
  const cc = document.querySelector('#rail .cc'), cf = cc?.querySelector('.cc-f');
  if (cf) foot.push(['ChatGPT 连接', cc.getBoundingClientRect().bottom - cf.getBoundingClientRect().bottom]);
  const pc = document.querySelector('#rail .pc'), sp = pc?.querySelector('.setup-pending');
  if (sp) foot.push(['权限与能力', pc.getBoundingClientRect().bottom - sp.getBoundingClientRect().bottom - parseFloat(getComputedStyle(pc).paddingBottom)]);
  return { g, snap: r.classList.contains('snap-grid'), pl, pr, ox, bgOk: same(bx, ox - g / 2) && same(by, -g / 2), spotOk, footBad: foot.filter(([, d]) => Math.abs(d) > 1.5).map(([k, d]) => k + ' ' + d.toFixed(1)), bad: bad.slice(0, 6), n: bad.length };
}

function canvasDots() {
  const c = document.getElementById('fx'), d = c.width / innerWidth, g = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dots-gap'));
  const pl = parseFloat(getComputedStyle(document.querySelector('.dash')).paddingLeft), ox = ((pl % g) + g) % g;
  const row = c.getContext('2d').getImageData(0, Math.round(10 * g * d), c.width, 1).data, xs = [];
  for (let x = 0; x < c.width; x++) {
    if (row[x * 4 + 3] > 20 && !(row[(x - 1) * 4 + 3] > 20)) { let e = x; while (row[(e + 1) * 4 + 3] > 20) e++; if (x > 0 && e < c.width - 1) xs.push(((x + e) / 2 + .5) / d); x = e; } // 贴边被切掉一半的点不算
  }
  const worst = Math.max(0, ...xs.slice(0, 40).map(x => { const m = (((x - ox) % g) + g) % g; return Math.min(m, g - m); }));
  return { on: document.documentElement.classList.contains('dots-canvas'), n: xs.length, worst: +worst.toFixed(2) };
}

async function setGap(page, g, extra = '') {
  await page.evaluate(([g, extra]) => { let st = document.getElementById('grid-snap-check'); if (!st) { st = document.createElement('style'); st.id = 'grid-snap-check'; document.head.append(st); } st.textContent = g || extra ? `html:root[data-scheme]{${g ? `--grid-snap:1;--dots-gap:${g};` : ''}${extra}}` : ''; dispatchEvent(new CustomEvent('chathand:fx')); }, [g, extra]);
  await page.mouse.move(5, 5); await page.waitForTimeout(450);
}

(async () => {
  let server = null;
  if (!process.env.CHATHAND_UI_URL) { server = await require('../server').start(); process.env.CHATHAND_UI_URL = server.url; }
  const results = [], check = (name, ok, evidence) => { results.push({ name, ok: !!ok, evidence }); if (!ok) console.log('FAIL', name, JSON.stringify(evidence)); };
  try {
    // 1137、1281 宽：零头是奇数，左右差 1px；1280 宽：零头平分；1440 宽：没有零头
    for (const [q, w, h] of [['task=run&value=mid', 1280, 800], ['task=multi&value=mid', 1137, 733], ['task=none&value=mid', 1281, 790], ['task=run&value=mid', 1440, 900]]) {
      for (const theme of ['light', 'dark']) {
        const { page, errs, close } = await open(q, { theme, w, h, dsf: 1 });
        try {
          await page.evaluate(() => document.querySelector('[data-action=permHint]')?.click()); await page.waitForTimeout(300);
          for (const g of theme === 'light' && w === 1280 ? [0, 8, 16, 24] : [0]) {
            await setGap(page, g);
            const m = await page.evaluate(measure), tag = `${theme} ${w} ${q.split('&')[0]} ${g ? g + ' 点' : '默认'}`;
            if (!g) check(`${tag}：默认 12 点、对齐打开`, m.snap && m.g === 12, m);
            check(`${tag}：四条边落在网点上`, m.snap && m.n === 0, m.bad);
            check(`${tag}：左右留白对称`, Math.abs(m.pl - m.pr) <= 1, { left: m.pl, right: m.pr });
            check(`${tag}：网点和光斑遮罩跟着原点`, m.bgOk && m.spotOk, { ox: m.ox });
            check(`${tag}：底栏贴底`, !m.footBad.length, m.footBad);
          }
          if (theme === 'light' && (w === 1281 || w === 1440)) {
            await setGap(page, 0, '--dots-a:2;--dots-size:1.2;');
            await page.evaluate(() => window.setFx(document.documentElement.classList.contains('bg-dots') ? 'dots' : 'dots-orb', { mouse: 'push' }));
            await page.waitForTimeout(500);
            const c = await page.evaluate(canvasDots);
            check(`light ${w}：画布网点（鼠标让开）也落在网格上`, c.on && c.n > 10 && c.worst <= .6, c);
          }
          check(`${theme} ${w}：没有脚本错误`, !errs.length, errs.slice(0, 3));
        } finally { await close(); }
      }
    }
  } finally { if (server) await server.close(); }
  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ name: 'grid-snap', passed: results.length - failed.length, total: results.length, failed: failed.map(f => f.name) }));
  if (failed.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
