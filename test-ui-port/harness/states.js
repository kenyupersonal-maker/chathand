#!/usr/bin/env node
'use strict';
/* 1011 工作台截图：只用本机 Chrome，输出留在仓库外。check.js 也用同一截图入口。 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { start } = require('./server');
const { openProduct, launchBrowser } = require('./common');
const XOUT = process.env.CHATHAND_UI_OUTPUT ? path.join(process.env.CHATHAND_UI_OUTPUT,'legacy-static') : path.join(process.env.CHATHAND_BUILDS_ROOT || path.join(os.homedir(), 'Developer', 'ChatHand-builds.noindex'), '1011-ui-check');
async function screenshot(page, name) {
  fs.mkdirSync(XOUT, { recursive: true });
  const out = path.join(XOUT, `state-${name}.png`);
  await page.screenshot({ path: out, animations: 'disabled', mask: [page.locator('#wizardTunnel'), page.locator('.tech[open] .kv'), page.locator('[data-action="copy"][data-id^="tunnel_"]')] });
  return out;
}
const STATES = [
  ...['run', 'idle', 'offline', 'unset'].map(scenario => ({ name: 'home-' + scenario, scenario })),
  { name: 'home-pending', scenario: 'run', extra: '&pending=1' },
  ...['available', 'downloading', 'waiting_tasks', 'failed', 'just_updated'].map(update => ({ name: 'update-' + update, scenario: 'run', extra: '&update=' + update })),
  ...['settings','terminal','browser','desktop','scope','conn','help'].map(view => ({ name: 'drawer-' + view, scenario: 'idle', prep: p => p.evaluate(v => openDrawer(v), view) })),
];
module.exports = { screenshot, XOUT, STATES };
if (require.main === module) (async () => {
  const only = ((process.argv.slice(2).find(a => a.startsWith('--only=')) || '').split('=')[1]) || '';
  const srv = await start({ port: 0 }), browser = await launchBrowser();
  let n = 0;
  try {
    for (const theme of ['light','dark']) for (const st of STATES.filter(s => !only || s.name.includes(only))) {
      const { ctx, page } = await openProduct(browser, srv.url, theme, st.scenario, { size: { width: 1280, height: 860 }, extra: st.extra || '', native: true });
      try { if (st.prep) await st.prep(page); await screenshot(page, st.name + '-' + theme); n++; }
      finally { await ctx.close(); }
    }
  } finally { await browser.close(); await srv.close(); }
  console.log(`完成：${n} 张 -> ${XOUT}`);
})().catch(e => { console.error(e); process.exit(1); });
