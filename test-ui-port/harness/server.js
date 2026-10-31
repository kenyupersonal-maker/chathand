#!/usr/bin/env node
'use strict';
/* ChatHand 主窗口的本地假服务。Node 22，不装任何依赖。

   用法：node harness/server.js [端口，默认 4173]
   然后打开  http://127.0.0.1:4173/?s=run#token
     s=run      已连接，有 1 个正在跑的任务（2 条命令、2 条文件改动），最近完成 3 个
     s=idle     已连接，没有在跑的任务，有历史
     s=offline  配置过，但连接断开了
     s=unset    第一次打开、没配置（向导会自动弹出）
   可选参数：&now=<毫秒>  把「现在」固定下来（截图脚本用，重跑结果一样）
             &paused=1    AI 操作已暂停      &update=1  有新版本
             &wizard=N    向导直接停在第 N 步（0~6）；&test=ok|read|wait 是第 4 步的测试结果

   - /            返回 ui/index.html，其余路径静态提供 ui/ 目录
   - GET  /api/state           按页面 URL 里的 s= 返回假数据（读 Referer；没有就用最近一次打开页面时的 s）
   - GET  /api/product-config  {}
   - POST /api/task-changes    带 id -> {changes:[...]}；带 operation_id -> {path,before,after,current_differs_from_receipt:false}
   - POST /api/settings|access|mode|browser/select 会记住改动（开关刷新后不弹回去）；/api/setup/test/start 返回暗号；/api/support/export 多带一个文件名；其余 POST /api/* 一律返回 {}
   - GET  /__log               收到过的 /api 请求（按时间顺序）；POST /__log/clear 清空
   也可以 require('./server').start({port}) 在别的脚本里起；返回的 { url, log, reset(), close() }：log 是收到的请求数组，reset() 清掉页面里改过的开关。 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./fixtures');

const UI_DIR = path.resolve(__dirname, '..', '..', 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function start({ port = 4173, host = '127.0.0.1' } = {}) {
  const log = [];
  let last = new URLSearchParams('s=run');   // 最近一次打开页面时的参数
  let savedSkin = 'default', skinRevision = 0;
  let over = {};                              // 页面里改过的开关等，重新打开页面就清掉

  const params = req => {
    try { if (req.headers.referer) { const u = new URL(req.headers.referer); if (u.searchParams.has('s')) return u.searchParams; } } catch { /* 忽略 */ }
    return last;
  };
  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const readBody = req => new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); try { resolve(t ? JSON.parse(t) : {}); } catch { resolve({}); } });
  });

  async function api(req, res, url) {
    const p = params(req);
    const scenario = p.get('s') || 'run';
    const now = Number(p.get('now')) || Date.now();
    if (req.method === 'GET' && url.pathname === '/api/state') {
      log.push({ method: 'GET', url: url.pathname, scenario });
      const opt = { ...over, settings: { ...(over.settings || {}), skin:savedSkin, skin_revision:skinRevision } };
      if (p.get('paused') === '1' && opt.enabled === undefined) opt.enabled = false;
      if (p.has('update') && !opt.update) opt.update = p.get('update') === '1' ? 'available' : p.get('update');
      if (p.get('pending') === '1') opt.pending = true;
      if (p.has('wizard')) { opt.wizard = p.get('wizard'); opt.test = p.get('test') || undefined; }
      return json(res, 200, fixtures.build(scenario, now, opt));
    }
    if (req.method === 'GET' && url.pathname === '/api/product-config') return json(res, 200, {});
    if (req.method !== 'POST') return json(res, 404, { error: { code: 'not_found', message: '没有这个接口' } });

    const body = await readBody(req);
    log.push({ method: 'POST', url: url.pathname, body });
    switch (url.pathname) {
      case '/api/task-changes':
        if (body.operation_id) return json(res, 200, fixtures.diffFor(body.operation_id));
        if (body.id) return json(res, 200, { changes: fixtures.changesFor(body.id, now) });
        return json(res, 200, {});
      case '/api/settings': if ('skin' in body) { savedSkin=body.skin;skinRevision++; } over.settings = { ...(over.settings || {}), ...body }; return json(res, 200, {skin:savedSkin,skin_revision:skinRevision});
      case '/api/access': if (typeof body.enabled === 'boolean') over.enabled = body.enabled; return json(res, 200, {});
      case '/api/mode': if (body.mode) over.mode = body.mode; return json(res, 200, {});
      case '/api/browser/select': if (body.backend) over.settings = { ...(over.settings || {}), browser_backend: body.backend }; return json(res, 200, {});
      case '/api/setup/skill': {const {setupHandoff}=await import('../../app/v1/setup-handoff.mjs');return json(res,200,{installed:true,...setupHandoff({appPath:'/tmp/ChatHand Synthetic.app',route:'openai'})});}
      case '/api/setup/test/start': over.setup_test = { nonce: 'k9x2m4', expired: false, status: 'not_received', read: false, write: false }; return json(res, 200, over.setup_test);   // 第 4 步「测试连接」要的暗号
      // 1083：建 Site 前查网络。页面参数 sitenet=clear | challenged | unreachable，默认 clear（没被拦）。
      case '/api/setup/site/network-check': { const result = ['clear', 'challenged', 'unreachable'].includes(p.get('sitenet')) ? p.get('sitenet') : 'clear'; return json(res, 200, { result, checked_at: now, ...(result === 'unreachable' ? { error_code: 'B_SITE_NETWORK_FAILED' } : { http_status: result === 'challenged' ? 403 : 404 }) }); }
      case '/api/support/repair':
        if (p.get('api_unknown') === '1') return json(res, 200, { error: { code: 'API_UNKNOWN', message: '这个接口还没接好' } });
        over.repair = fixtures.repairFor(now); return json(res, 200, over.repair);
      case '/api/support/ai-brief': return json(res, 200, { text: '我的 ChatHand 出了问题：测试用的诊断。\n请照 ChatHand 自带的修复手册处理。' });
      case '/api/support/update': return json(res, 200, fixtures.updateFor(p.get('update') || 'none'));
      case '/api/update/install': over.update = fixtures.updateFor('downloading'); return json(res, 200, over.update);
      case '/api/update/dismiss': over.update = { ...fixtures.updateFor('available'), dismissed_version: body.version }; return json(res, 200, { dismissed: body.version });
      case '/api/update/cancel': over.update = fixtures.updateFor('available'); return json(res, 200, over.update);
      case '/api/update/ack': over.update = fixtures.updateFor(); return json(res, 200, { acked: true });
      case '/api/support/export': return json(res, 200, { file: '/Users/trial/Downloads/ChatHand-diagnostic-20260929-142013.zip' });   // 页面拿它拼「诊断包已保存到…」的提示
      default: return json(res, 200, {});
    }
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + path.sep) && file !== UI_DIR) { res.writeHead(403); return res.end('forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found: ' + rel); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      if (rel === '/index.html') return res.end(fs.readFileSync(file,'utf8').replace('<html lang="zh-CN"', `<html lang="zh-CN" data-skin-saved="${savedSkin}"`));
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/__log') return json(res, 200, log);
      if (url.pathname === '/__log/clear') { log.length = 0; return json(res, 200, {}); }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/' || url.pathname === '/index.html') { last = url.searchParams.has('s') ? url.searchParams : last; over = {}; }
      return serveStatic(req, res, url);
    } catch (e) {
      json(res, 500, { error: { code: 'harness_error', message: String(e && e.message || e) } });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://${host}:${actual}`, log, reset: () => { over = {}; }, close: () => new Promise(r => server.close(r)) });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  start({ port }).then(s => {
    console.log(`ChatHand 假服务：${s.url}/?s=run#token   （s = run | idle | offline | unset）`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
