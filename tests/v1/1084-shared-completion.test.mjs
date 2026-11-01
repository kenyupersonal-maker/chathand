import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {findChrome} from '../support/real-chrome.mjs';

const chrome=findChrome(),root=new URL('../../ui/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,root));
const zh=JSON.parse(fs.readFileSync(new URL('../../locales/zh.json',import.meta.url),'utf8'));

test('manual verified setup enters the same completion page and actions as assisted setup',
 {skip:chrome?false:'Chrome unavailable',timeout:45000},async t=>{
 const appSource=read('app.js').toString('utf8');
 const riskList=appSource.match(/^function riskList\(\).*$/m)?.[0];
 const setRisk=appSource.match(/^async function setRisk\(id,on\).*$/m)?.[0];
 assert.ok(riskList&&setRisk,'reuse the production permission action');
 const keySymbol=read('index.html').toString('utf8').match(/<symbol id="i-key"[^]*?<\/symbol>/)?.[0];
 assert.ok(keySymbol,'reuse the production key icon');
 const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/wizard.css"><link rel="stylesheet" href="/h10/h10.css"><link rel="stylesheet" href="/h10/host.css"></head><body><svg width="0" height="0" aria-hidden="true">${keySymbol}</svg><div id="app"></div><script src="/local-text-catalogs.js"></script><script src="/local-text.js"></script><script>
 var S={settings:{setup_complete:false,setup_step:3,tunnel:{tunnel_id:'tunnel_synthetic01'},chatgpt_app_name:'ChatHand-Fixture'},setup_test:{route:'openai',verified:true,nonce:'fixture'},permissions:{tier:'full',file_scope:'computer'},setup:{open_items:[]},credentials:{tunnel:true},automation:{browser:{extension:{}},computer:{permissions:{}}},site_b:{selected:'openai'}};
 window.fixtureCalls=[];window.rejectProgress=false;window.rejectAdmin=false;window.rejectTier=false;
 const E=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
 const T=(key,params)=>window.ChatHandText.t(key,params);
 async function api(route,body){window.fixtureCalls.push({route,body});if(route==='/api/setup/progress'&&body.step===6&&window.rejectProgress){let e=new Error('not verified');e.code='SETUP_TEST_REQUIRED';throw e;}if(route==='/api/setup/test/start')return {nonce:'new-fixture',verified:false};if(route==='/api/settings'&&typeof body.high_risk?.admin==='boolean'){if(window.rejectAdmin)throw Error('cancelled');S.settings.high_risk={admin:body.high_risk.admin};const item=S.setup.open_items.find(item=>item.id==='admin');if(item)item.status=body.high_risk.admin?'done':'todo';const risk=S.permissions.high_risk?.find(item=>item.id==='admin');if(risk){risk.enabled=body.high_risk.admin;risk.usable_now=body.high_risk.admin;}}return {};}
 async function native(action,data){window.fixtureCalls.push({native:action,data});return action==='copyText'?{copied:true}:{};}
 async function refresh(){window.wizardRefresh?.(S);} function toast(){} function userMessage(e){return e.message;} function connected(){return true;} function connectionText(){return '';}
 ${riskList}\n${setRisk}
 window.ChatHandH10Bridge={state:()=>S,api,native,refresh,openChatGPT:async(prompt,opts)=>{window.fixtureCalls.push({openChatGPT:prompt,opts});return {opened:true,prefilled:true};},applyTier:async tier=>{window.fixtureCalls.push({tier});if(window.rejectTier)throw Object.assign(Error('test failure'),{code:'TEST_SCOPE_FAILURE'});S.permissions.file_scope=tier==='light'?'folder':'computer';S.permissions.tier=tier;S.settings.browser_enabled=true;S.settings.desktop_enabled=tier==='full';S.permissions.capabilities={browser:{enabled:true},desktop:{enabled:tier==='full'}};if(tier==='light'){S.settings.high_risk={admin:false};S.permissions.high_risk=[{id:'admin',enabled:false,usable_now:false}];}return true;},setRisk:(id,on)=>setRisk(id,on)};
 </script><script src="/wizard.js"></script><script type="module" src="/h10/host.mjs"></script></body></html>`;
 const screenshots=process.env.CHATHAND_SHARED_SHOTS;
 const oldWizard=screenshots?execFileSync('git',['show','HEAD:ui/wizard.js']):null;
 const server=http.createServer((req,res)=>{const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(p==='/'||p==='/before/'){res.setHeader('content-type','text/html');res.end(p==='/before/'?html.replace('src="/wizard.js"','src="/before/wizard.js"'):html);return;}if(p==='/before/wizard.js'&&oldWizard){res.setHeader('content-type','text/javascript');res.end(oldWizard);return;}const file=p.replace(/^\//,'');if(file.includes('..')){res.statusCode=400;res.end();return;}try{res.setHeader('content-type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'application/octet-stream');res.end(read(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--disable-background-networking','--disable-extensions']});t.after(()=>browser.close());
 const url=`http://127.0.0.1:${server.address().port}/`;
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);await page.waitForFunction(()=>window.h10Ready);
 await page.evaluate(()=>window.startWizard({initialStep:3}));
 await page.locator('#h10Host [data-screen="f15"]').waitFor();
 assert.equal(await page.locator('#setupWizard').isHidden(),true);
 const settings=await page.locator('#h10Host .h10-settings').innerHTML();
 assert.equal(await page.locator('#h10Host .h10-capability').count(),3);
 const sizes=await page.locator('#h10Host .h10-settings').evaluate(el=>({cards:[...el.children].map(c=>c.getBoundingClientRect().height),rows:[...el.querySelectorAll('.h10-capability')].map(c=>c.getBoundingClientRect().height),options:[...el.querySelectorAll('.h10-option')].map(c=>c.getBoundingClientRect().height)}));
 assert.ok(Math.max(...sizes.cards)-Math.min(...sizes.cards)<1,JSON.stringify(sizes));
 assert.ok(Math.max(...sizes.rows)-Math.min(...sizes.rows)<1,JSON.stringify(sizes));
 assert.ok(sizes.options.every(height=>height>=98),JSON.stringify(sizes));
 assert.deepEqual(await page.locator('#h10Host .h10-footer [data-action]').evaluateAll(buttons=>buttons.map(button=>button.dataset.action)),['open-chatgpt','finish']);
 await page.locator('#h10Host [data-action="open-chatgpt"]').click();
 const calls=await page.evaluate(()=>window.fixtureCalls);
 const expected=zh['ui.h10.host.computerSample'].replace('{app}','ChatHand-Fixture');
 assert.ok(calls.some(call=>call.route==='/api/setup/progress'&&call.body.step===6));
 assert.ok(calls.some(call=>call.native==='copyText'&&call.data.text===expected));
 assert.ok(calls.some(call=>call.openChatGPT===expected));
 assert.equal(calls.some(call=>call.route==='/api/settings'&&call.body?.high_risk?.admin===true),false);
 assert.deepEqual(errors,[]);

 const assisted=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await assisted.goto(url);await assisted.waitForFunction(()=>window.h10Ready);
 await assisted.evaluate(()=>{S.settings.setup_complete=true;window.startH10({route:'openai',screen:'f12'});});
 await assisted.locator('#h10Host [data-screen="f15"]').waitFor();
 assert.equal(await assisted.locator('#h10Host .h10-settings').innerHTML(),settings);

 const admin=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await admin.goto(url);await admin.waitForFunction(()=>window.h10Ready);
 await admin.evaluate(()=>{S.settings.setup_complete=true;S.settings.high_risk={admin:false};S.high_risk={items:[{id:'admin',group:'common'}]};S.permissions.high_risk=[{id:'admin',enabled:false,usable_now:false}];window.startH10({route:'openai',screen:'f12'});});
 const adminSwitch=admin.locator('#h10Host [data-action="admin-capability"]');await adminSwitch.waitFor();
 await admin.evaluate(()=>window.rejectAdmin=true);await adminSwitch.click();
 await admin.waitForFunction(()=>window.fixtureCalls.some(call=>call.route==='/api/settings'&&call.body?.high_risk?.admin===true));
 assert.equal(await adminSwitch.getAttribute('aria-checked'),'false');
 await admin.evaluate(()=>{window.rejectAdmin=false;});await adminSwitch.click();
 await admin.waitForFunction(()=>document.querySelector('#h10Host [data-action="admin-capability"]')?.getAttribute('aria-checked')==='true');
 await adminSwitch.click();await admin.waitForFunction(()=>document.querySelector('#h10Host [data-action="admin-capability"]')?.getAttribute('aria-checked')==='false');
 await admin.evaluate(()=>{S.settings.high_risk.admin=true;S.permissions.high_risk[0].enabled=true;S.permissions.high_risk[0].usable_now=false;window.h10Refresh();});
 assert.equal(await adminSwitch.getAttribute('aria-checked'),'true');
 assert.equal(await admin.locator('#h10Host .h10-capability').last().locator('.h10-capability-note').textContent(),zh['ui.window.pgTerminal.text5']);

 const switching=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await switching.goto(url);await switching.waitForFunction(()=>window.h10Ready);
 await switching.evaluate(()=>{S.settings.setup_complete=true;S.settings.high_risk={admin:true};S.permissions.high_risk=[{id:'admin',enabled:true,usable_now:true}];window.startH10({route:'openai',screen:'f12'});});
 await switching.locator('#h10Host input[value="folder"]').check();
 await switching.waitForFunction(()=>window.fixtureCalls.some(call=>call.tier==='light'));
 await switching.waitForFunction(()=>document.querySelector('#h10Host [data-action="admin-capability"]')?.getAttribute('aria-disabled')==='true');
 assert.deepEqual(await switching.locator('#h10Host .h10-capability .switch').evaluateAll(buttons=>buttons.map(b=>b.getAttribute('aria-checked'))),['true','false','false']);
 assert.equal(await switching.locator('#h10HostNotice').isHidden(),true);
 await switching.locator('#h10Host input[value="computer"]').check();
 await switching.waitForFunction(()=>window.fixtureCalls.some(call=>call.tier==='full')&&S.permissions.file_scope==='computer');
 assert.equal(await switching.locator('#h10HostNotice').isHidden(),true);
 await switching.evaluate(()=>window.rejectTier=true);
 await switching.locator('#h10Host input[value="folder"]').click();
 await switching.waitForFunction(()=>document.querySelector('#h10HostNotice')?.textContent.includes('TEST_SCOPE_FAILURE'));
 assert.equal(await switching.locator('#h10HostNotice').isVisible(),true);
 assert.equal(await switching.evaluate(()=>S.permissions.file_scope),'computer');

 const folder=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'no-preference'});
 await folder.goto(url);await folder.waitForFunction(()=>window.h10Ready);
 await folder.evaluate(()=>{S.settings.setup_complete=true;S.settings.browser_enabled=true;S.settings.desktop_enabled=false;S.permissions={tier:'custom',file_scope:'folder',capabilities:{browser:{enabled:true},desktop:{enabled:false}},high_risk:[{id:'admin',enabled:true,usable_now:false}]};window.startH10({route:'openai',screen:'f12'});});
 await folder.locator('#h10Host [data-screen="f15"]').waitFor();
 assert.equal(await folder.locator('#h10Host input[value="folder"]').isChecked(),true);
 const folderSwitches=folder.locator('#h10Host .h10-capability .switch');
 assert.equal(await folderSwitches.count(),3);
 assert.deepEqual(await folderSwitches.evaluateAll(buttons=>buttons.map(b=>[b.getAttribute('aria-checked'),b.getAttribute('aria-disabled')])),[['true','true'],['false','true'],['true','true']]);
 assert.equal(await folder.evaluate(()=>window.fixtureCalls.some(call=>call.route==='/api/settings')),false);
 if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await folder.screenshot({path:`${screenshots}/folder-existing-on.png`});}
 const browserSwitch=folder.locator('#h10Host [data-action="browser-capability"]');
 await browserSwitch.hover();
 assert.equal(await browserSwitch.evaluate(el=>getComputedStyle(el).cursor),'not-allowed');
 const tip=folder.locator('#'+await browserSwitch.getAttribute('aria-describedby'));
 assert.equal(await tip.getAttribute('role'),'tooltip');
 assert.equal(await folder.locator('#h10-admin-folder-tip').textContent(),zh['ui.h10.views.folderAdminUnavailable']);
 await folder.waitForTimeout(300);assert.ok(await tip.evaluate(el=>Number(getComputedStyle(el).opacity)<.05));
 await folder.waitForFunction(()=>{const e=document.querySelector('#h10-browserControl-folder-tip');return e&&getComputedStyle(e).visibility==='visible'&&Number(getComputedStyle(e).opacity)>.9;},null,{timeout:2500});
 await folder.mouse.move(20,850);await folder.waitForFunction(()=>getComputedStyle(document.querySelector('#h10-browserControl-folder-tip')).visibility==='hidden');
 await browserSwitch.hover();
 await folder.evaluate(()=>{window.fixtureTooltipSeen=false;let n=0;const refreshes=setInterval(()=>{window.h10Refresh();if(++n===10)clearInterval(refreshes);},200);const watcher=setInterval(()=>{const tip=document.querySelector('#h10-browserControl-folder-tip');if(tip&&getComputedStyle(tip).visibility==='visible'&&Number(getComputedStyle(tip).opacity)>.9){window.fixtureTooltipSeen=true;clearInterval(watcher);}if(n===10)clearInterval(watcher);},30);});
 await folder.waitForFunction(()=>window.fixtureTooltipSeen===true,null,{timeout:2000});
 await folder.mouse.move(20,850);await folder.waitForFunction(()=>getComputedStyle(document.querySelector('#h10-browserControl-folder-tip')).visibility==='hidden');
 await folder.emulateMedia({reducedMotion:'reduce'});await browserSwitch.hover();
 await folder.waitForTimeout(300);assert.ok(await tip.evaluate(el=>Number(getComputedStyle(el).opacity)<.05));
 await folder.waitForFunction(()=>Number(getComputedStyle(document.querySelector('#h10-browserControl-folder-tip')).opacity)>.9,null,{timeout:2500});
 await browserSwitch.focus();await folder.evaluate(()=>window.h10Refresh());
 assert.equal(await browserSwitch.evaluate(el=>document.activeElement===el),true);
 const callsBefore=await folder.evaluate(()=>window.fixtureCalls.length);
 await browserSwitch.dispatchEvent('click');await folder.keyboard.press('Tab');
 await folder.evaluate(()=>document.querySelector('#h10Host [data-action="admin-capability"]').setAttribute('aria-disabled','false'));
 await folder.locator('#h10Host [data-action="admin-capability"]').dispatchEvent('click');
 assert.equal(await folder.evaluate(()=>window.fixtureCalls.length),callsBefore);
 for(const locale of ['zh','en'])for(const width of [900,1280]){
  await folder.setViewportSize({width,height:900});await folder.evaluate(locale=>window.ChatHandText.update({locale}),locale);
  const dimensions=await folder.locator('#h10Host .h10-settings').evaluate(el=>({cards:[...el.children].map(e=>e.getBoundingClientRect().height),rows:[...el.querySelectorAll('.h10-capability')].map(e=>e.getBoundingClientRect().height)}));
  assert.ok(Math.max(...dimensions.cards)-Math.min(...dimensions.cards)<1,JSON.stringify({locale,width,dimensions}));
  assert.ok(Math.max(...dimensions.rows)-Math.min(...dimensions.rows)<1,JSON.stringify({locale,width,dimensions}));
 }

 const denied=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await denied.goto(url);await denied.waitForFunction(()=>window.h10Ready);
 await denied.evaluate(()=>{window.rejectProgress=true;return window.startWizard({initialStep:3});});
 await denied.waitForFunction(()=>window.fixtureCalls.some(call=>call.route==='/api/setup/progress'&&call.body.step===6));
 await denied.waitForFunction(()=>window.fixtureCalls.some(call=>call.route==='/api/setup/test/start'));
 assert.equal(await denied.locator('#h10Host').isHidden(),true);
 assert.equal(await denied.locator('#setupWizard').isVisible(),true);

 for(const cancelled of [false,true]){
  const old=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  await old.goto(url);await old.waitForFunction(()=>window.h10Ready);
  await old.evaluate(cancelled=>{window.startH10=undefined;window.rejectAdmin=cancelled;S.settings.setup_complete=true;S.settings.high_risk={admin:false};S.high_risk={items:[{id:'admin',group:'common'}]};S.setup.open_items=[{id:'admin',status:'todo',detail:{}}];return window.startWizard({initialStep:6});},cancelled);
  await old.locator('#setupWizard [data-item="admin"]').click();
  await old.waitForFunction(()=>window.fixtureCalls.some(call=>call.route==='/api/settings'&&call.body.high_risk?.admin===true));
  await old.waitForFunction(()=>!document.querySelector('#setupWizard [data-item="admin"]')?.disabled);
  assert.equal(await old.evaluate(()=>S.settings.high_risk.admin),!cancelled);
  assert.equal(await old.locator('#setupWizard .open-done').count(),cancelled?0:1);
  await old.close();
 }

 if(screenshots){
  fs.mkdirSync(screenshots,{recursive:true});
  for(const before of [true,false])for(const scope of ['computer','folder'])for(const [locale,theme] of [['zh','light'],['zh','dark'],['en','light']]){
   const shot=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
   await shot.goto(url+(before?'before/':''));await shot.waitForFunction(()=>window.h10Ready);
   await shot.evaluate(({scope,locale,theme})=>{document.documentElement.dataset.theme=theme;window.ChatHandText.update({locale});S.settings.browser_enabled=false;S.settings.desktop_enabled=false;S.permissions={tier:scope==='folder'?'light':'full',file_scope:scope,capabilities:{browser:{enabled:false},desktop:{enabled:false}},high_risk:[{id:'admin',enabled:false,usable_now:false}]};S.setup.open_items=scope==='folder'?[{id:'folder',status:'todo',detail:{folder:'/Users/Example/ChatHand Workspace'}},{id:'browser',status:'todo',detail:{}}]:[{id:'admin',status:'todo',detail:{}},{id:'desktop',status:'todo',detail:{}},{id:'browser',status:'todo',detail:{}}];return window.startWizard({initialStep:3});},{scope,locale,theme});
   await shot.locator(before?'#setupWizard[data-step="6"]':'#h10Host [data-screen="f15"]').waitFor();
   await shot.screenshot({path:`${screenshots}/${before?'before':'after'}-${scope}-${locale}-${theme}.png`});
   if(!before&&scope==='folder'&&locale==='zh'&&theme==='light'){await shot.locator('[data-action="admin-capability"]').hover();await shot.waitForFunction(()=>getComputedStyle(document.querySelector('#h10-admin-folder-tip')).visibility==='visible');await shot.screenshot({path:`${screenshots}/folder-tooltip.png`});}
   await shot.close();
  }
 }
});
