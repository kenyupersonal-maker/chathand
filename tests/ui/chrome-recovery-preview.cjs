#!/usr/bin/env node
'use strict';
// Temporary visual fixture for the real ChatHand UI. It never starts Chrome or reads user state.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./harness/fixtures');
const ROOT = path.resolve(__dirname, '../..');
const UI = path.join(ROOT, 'ui');
const TYPES = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2' };
const SCENARIOS = ['disconnected','historical','missing','connected','incompatible','checking','waiting_idle','applying','throttled','failed','updated','wake_failed','no_chrome','incompatible_failed'];
const safe = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function start({ port = 0, host = '127.0.0.1', uiRoot = UI } = {}) {
  const calls = [];
  const nativeCalls = [];
  const streams = new Set();
  const overrides = new Map();
  const scenarioKey = params => [params.get('scenario') || 'disconnected', params.get('lang') || 'zh', params.get('theme') || 'light'].join(':');
  const currentParams = req => { try { return new URL(req.headers.referer || req.url, 'http://preview.local').searchParams; } catch { return new URLSearchParams(); } };
  const makeState = params => {
    const scenario = SCENARIOS.includes(params.get('scenario')) ? params.get('scenario') : 'disconnected';
    const lang = params.get('lang') === 'en' ? 'en' : 'zh';
    const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
    const now = Date.now();
    const state = fixtures.build('run', now, { settings: { appearance: theme, language: lang, browser_enabled: true, auto_connect: false } });
    const update = ['checking','waiting_idle','applying','throttled','failed','updated'].includes(scenario) ? scenario : scenario === 'incompatible_failed' ? 'failed' : 'idle';
    const connected = ['connected','incompatible','updated','incompatible_failed','checking','waiting_idle','applying'].includes(scenario);
    const ext = {
      distribution: 'chrome_web_store', configuration_state: 'ready', configuration_reason: '',
      installed: scenario === 'missing' ? null : true,
      installation_previously_observed: scenario !== 'missing',
      connected, connection_state: connected ? 'connected' : 'disconnected',
      last_seen: scenario === 'missing' ? null : now - 45 * 60_000,
      compatibility: { state: ['incompatible','incompatible_failed'].includes(scenario) ? 'incompatible' : connected ? 'compatible' : 'unknown' },
      ...(scenario === 'wake_failed' ? { wake: { connected: false } } : scenario === 'no_chrome' ? { wake: { chrome_open_failed: true } } : {}),
      helper: scenario === 'missing' ? null : { state: 'ready', build: 1092, stale: false },
      update: { state: update, from_version: '1.0.0', target_version: scenario === 'updated' ? '1.0.1' : null, code: null },
    };
    // 后台读到的 Chrome 自己的插件记录（presence=enabled|disabled|missing|unknown，stalled=1 表示 Chrome 开着插件一直没连上）。
    if (['enabled','disabled','missing','unknown'].includes(params.get('presence'))) ext.presence = { state: params.get('presence'), chrome_running: params.get('stalled') === '1', stalled: params.get('stalled') === '1', checked_at: now };
    Object.assign(ext, overrides.get(scenarioKey(params)) || {});
    state.automation.browser.extension = ext;
    state.automation.browser.personal = { connected: false, chrome: { installed: true, version: '140.0.7339.80', major: 140 } };
    return state;
  };
  const broadcast = () => {
    for (const item of streams) {
      const payload = JSON.stringify(makeState(item.params));
      item.res.write(`event: state\ndata: ${payload}\n\n`);
    }
  };
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'null' }); res.end(JSON.stringify(value)); };
  const body = req => new Promise(resolve => { const chunks=[]; req.on('data', c => chunks.push(c)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } }); });
  const shim = () => {const catalogs={zh:JSON.parse(fs.readFileSync(path.join(ROOT,'locales/zh.json'),'utf8')),en:JSON.parse(fs.readFileSync(path.join(ROOT,'locales/en.json'),'utf8'))}; return `<script>
(()=>{window.__chromeRecoveryNativeCalls=[];window.webkit={messageHandlers:{native:{postMessage(message){window.__chromeRecoveryNativeCalls.push(message);fetch('/__native-call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:message.action})}).catch(()=>{});let result={};if(message.action==='getLocalTextCatalogs'){const q=new URLSearchParams(location.search),locale=q.get('lang')==='en'?'en':'zh';result={locale,preference:locale,catalogs:${JSON.stringify(catalogs)}};}else if(message.action==='openChromeStore'||message.action==='openChromeExtensions'||message.action==='openChromeExtensionDetails')result={opened:true};else if(message.action==='getNativeStatus')result={login_item:{enabled:false}};else if(message.action==='setAppearance')result={ok:true};else if(message.action==='windowChrome')result={ok:true};setTimeout(()=>window.nativeReply?.({id:message.id,result}),0);}}}}})();
</script><script>setTimeout(()=>{if(window.showPage)window.showPage('settings','browser');},500);</script>`;};
  const controls = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chrome 恢复 UI 验收</title><style>body{font:15px system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#202a26}h1{font-size:22px}label{display:block;margin:18px 0 6px}select,button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid #bcc9c2}button{background:#e6f4ed;cursor:pointer;margin-top:24px}a{color:#226c4b}p{line-height:1.6}</style><h1>Chrome 恢复 UI 场景</h1><p>此页面只选择本地合成状态。提交后会打开真实的 ChatHand 设置页，供主代理直接截图和点击验收。</p><form id="form"><label>状态</label><select name="scenario">${SCENARIOS.map(s=>`<option value="${s}">${s}</option>`).join('')}</select><label>语言</label><select name="lang"><option value="zh">简体中文</option><option value="en">English</option></select><label>主题</label><select name="theme"><option value="light">浅色</option><option value="dark">深色</option></select><label>重新连接结果</label><select name="reconnect"><option value="failed">失败</option><option value="success">成功</option></select><label>点击「检查插件更新」的结果</label><select name="updateResult"><option value="updated">updated</option><option value="no_update">no_update</option><option value="throttled">throttled</option><option value="failed">failed</option><option value="unsupported">unsupported</option><option value="disconnected">disconnected</option></select><button type="submit">打开验收页面</button></form><script>document.querySelector('#form').onsubmit=e=>{e.preventDefault();const q=new URLSearchParams(new FormData(e.target));location.href='/?'+q.toString()+'#preview';};</script>`;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://preview.local');
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html'))overrides.delete(scenarioKey(url.searchParams));
    if (url.pathname === '/__controls') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(controls); }
    if (url.pathname === '/__calls') return json(res, 200, calls);
    if (url.pathname === '/__native-calls') return json(res, 200, nativeCalls);
    if (url.pathname === '/__native-call' && req.method === 'POST') { const record=await body(req); nativeCalls.push({action:String(record.action||'unknown')}); return json(res,200,{recorded:true}); }
    if (url.pathname === '/__calls/clear' && req.method === 'POST') { calls.length = 0; return json(res, 200, {cleared:true}); }
    if (url.pathname === '/api/events') {
      const params = currentParams(req); res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'}); res.write(`event: state\ndata: ${JSON.stringify(makeState(params))}\n\n`);
      const item = {res,params}; streams.add(item); const keep=setInterval(()=>res.write(': preview keepalive\n\n'),20000); req.on('close',()=>{clearInterval(keep);streams.delete(item);}); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const params = currentParams(req), key = scenarioKey(params), route = url.pathname;
      if (req.method === 'GET' && route === '/api/state') return json(res,200,makeState(params));
      if (req.method === 'GET' && route === '/api/product-config') return json(res,200,{});
      if (req.method !== 'POST') return json(res,404,{error:{code:'not_found'}});
      const posted = await body(req); calls.push({method:'POST',path:route,body:posted,scenario:params.get('scenario')||'disconnected'});
      if (route === '/api/browser/extension/reconnect') {
        const success = params.get('reconnect') === 'success';
        await new Promise(resolve=>setTimeout(resolve,700));
        if (params.get('reconnect') === 'busy') return json(res,409,{error:{code:'BROWSER_BUSY',message:'Browser tasks are still running.'}});
        if (success) overrides.set(key,{connected:true,connection_state:'connected',compatibility:{state:'compatible'},update:{state:'idle'}});
        broadcast(); return json(res,200,{connected:success,reconnecting:false});
      }
      if (route === '/api/browser/extension/update') {
        const result = ['updated','no_update','throttled','failed','unsupported','disconnected'].includes(params.get('updateResult')) ? params.get('updateResult') : 'updated';
        const old = overrides.get(key) || {};
        overrides.set(key,{...old,update:{state:'checking',from_version:'1.0.0',target_version:null,code:null}}); broadcast();
        await new Promise(resolve=>setTimeout(resolve,700));
        const extPatch = { ...old, update:{state:result,from_version:'1.0.0',target_version:result==='updated'?'1.0.1':null,code:result==='failed'?'PREVIEW_UPDATE_FAILED':null} };
        if (result === 'updated') Object.assign(extPatch,{connected:true,connection_state:'connected',compatibility:{state:'compatible'},helper:{state:'ready',build:1093,stale:false}});
        overrides.set(key,extPatch); broadcast(); const ext=makeState(params).automation.browser.extension; return json(res,200,{ext:{update:ext.update},update:ext.update});
      }
      if (route === '/api/settings') return json(res,200,{});
      return json(res,200,{});
    }
    let rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(uiRoot, rel));
    if (!file.startsWith(uiRoot + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file,(error, data)=>{
      if (error) { res.writeHead(404,{'Content-Type':'text/plain'}); return res.end('not found'); }
      if (rel === '/index.html') data=Buffer.from(data.toString('utf8').replace('<script src="/app.js"></script>',`${shim()}<script src="/app.js"></script>`));
      res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}); res.end(data);
    });
  }
  const server = http.createServer((req,res)=>{void handle(req,res).catch(error=>json(res,500,{error:String(error)}));});
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{const actual=server.address().port;resolve({server,url:`http://${host}:${actual}`,calls,nativeCalls,close:()=>new Promise(r=>{for(const x of streams)x.res.end();server.close(r);})});});});
}
if (require.main === module) start({port:Number(process.argv[2]||0)}).then(({url})=>console.log(`Chrome recovery preview: ${url}/__controls\nReal UI: ${url}/?scenario=disconnected&lang=zh&theme=light#preview`)).catch(error=>{console.error(error);process.exitCode=1;});
module.exports = { start, SCENARIOS };
