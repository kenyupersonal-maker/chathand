import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import {chromium} from 'playwright-core';
import {findChrome} from '../support/real-chrome.mjs';

const root=new URL('../../',import.meta.url),read=name=>fs.readFileSync(new URL(name,root),'utf8');
const runtime=read('ui/local-text.js'),source=read('ui/app.js'),index=read('ui/index.html');
const zh=JSON.parse(read('locales/zh.json'));
function fixture(catalogs={zh,en:{}}){const context=vm.createContext({__CHATHAND_TEXT_CATALOGS__:catalogs,document:{documentElement:{dataset:{}}}});context.window=context;vm.runInContext(runtime,context);return context;}
function functionSource(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,name);let end=source.indexOf('\n',start);for(;end>=0;end=source.indexOf('\n',end+1)){const candidate=source.slice(start,end);try{new vm.Script(candidate);return candidate;}catch{}}throw Error('Function source not complete: '+name);}
function loadFunctions(context,names){vm.runInContext('const T=(key,params={})=>ChatHandText.t(key,params);const TH=(key,params={})=>ChatHandText.html(key,Object.fromEntries(Object.entries(params).map(([k,v])=>[k,ChatHandText.trusted(v)])));',context);for(const name of names)vm.runInContext(functionSource(name),context);}

test('window local text keeps original Chinese, empty and whitespace English fall back',()=>{
 const f=fixture(),t=f.ChatHandText;t.installCatalogs({locale:'en',catalogs:{en:{'ui.window.prompts.text':'','ui.window.prompts.text2':'  \n  '}}});
 assert.equal(t.t('ui.window.prompts.text'),'@ChatHand 查一下这台 Mac 的系统版本和剩余空间');
 assert.equal(t.t('ui.window.prompts.text2'),'@ChatHand 在工作区新建今天的待办清单，同名文件不覆盖');
 assert.equal(t.t('ui.window.notPresent'),'ui.window.notPresent');
});
test('named placeholders preserve zero, false, repeated values and unknown placeholders',()=>{
 const f=fixture({zh:{'test.sentence':'{name} {count} {enabled} {name} {missing}'},en:{'test.sentence':'Hello {name}: {count} {enabled} {name} {missing}'}});f.ChatHandText.update({locale:'en'});
 assert.equal(f.ChatHandText.t('test.sentence',{name:'<Mac>',count:0,enabled:false}),'Hello <Mac>: 0 false <Mac> {missing}');
});
test('HTML text and ordinary values are escaped; source-owned markup requires trusted()',()=>{
 const f=fixture({zh:{'test.html':'<label> {name} {open}{value}{close}'},en:{}}),t=f.ChatHandText;
 assert.equal(t.html('test.html',{name:'<img src=x onerror=alert(1)>',open:t.trusted('<b>'),value:'"&\'',close:t.trusted('</b>')}),'&lt;label&gt; &lt;img src=x onerror=alert(1)&gt; <b>&quot;&amp;&#39;</b>');
});
test('runtime defaults to Chinese without native or browser language and emits shared updates',()=>{
 assert.doesNotMatch(runtime,/navigator|languagechange|Intl\.Locale/);
 const f=fixture();let calls=0;const stop=f.ChatHandText.subscribe(()=>calls++);assert.equal(f.ChatHandText.locale,'zh');f.ChatHandText.installCatalogs({locale:'en-GB'});assert.equal(f.ChatHandText.locale,'en');stop();f.ChatHandText.update({locale:'zh-Hant'});assert.equal(calls,1);assert.equal(f.document.documentElement.lang,'zh-CN');
});
test('date/count text is unchanged and filters remain based on machine state in English',()=>{
 const f=fixture();vm.runInContext(source.match(/^const valueNumber=.*$/m)[0],f);loadFunctions(f,['sameLocalDay','matterLabel','matterInFilter','formatTokens','formatShare','quotaShort','valueShareSentence','valueSince']);
 assert.equal(vm.runInContext('formatTokens(12345)',f),'1.2 万');
 assert.equal(vm.runInContext('quotaShort(0.01)',f),'约 Work 周额度的不到 0.1%');
 const stamp=new Date(2026,8,12).getTime();assert.match(vm.runInContext(`valueSince(${stamp})`,f),/9 月 12 日起$/);
 f.ChatHandText.installCatalogs({locale:'en',catalogs:{en:{'ui.window.matterLabel.text4':'Deferred'}}});
 assert.equal(vm.runInContext("matterLabel({state:'deferred'})",f),'Deferred');assert.equal(vm.runInContext("matterInFilter({state:'deferred'},'parked')",f),true);assert.equal(vm.runInContext("matterInFilter({state:'waiting_user'},'parked')",f),false);
});
test('the static catalog/runtime load before main code and native locale repaint invalidates every region',()=>{
 assert.ok(index.indexOf('/local-text-catalogs.js')<index.indexOf('/local-text.js'));
 assert.ok(index.indexOf('/local-text.js')<index.indexOf('/app.js'));
 assert.match(source,/native\('getLocalTextCatalogs',\{\}\)/);
 assert.match(source,/window\.ChatHandText\.subscribe\(applyLocalText\)/);
 assert.match(functionSource('applyLocalText'),/lastKey='';regionKeys\.clear\(\);regionHTML\.clear\(\)/);
 assert.doesNotMatch(source,/navigator\.language/);
});
test('classic/native/module and module/native orders share the authoritative catalog; repeated defaults emit no update',async()=>{
 const oldState=globalThis.__CHATHAND_TEXT_STATE__,oldAPI=globalThis.ChatHandText,oldCatalogs=globalThis.__CHATHAND_TEXT_CATALOGS__;
 try{
  delete globalThis.__CHATHAND_TEXT_STATE__;globalThis.__CHATHAND_TEXT_CATALOGS__={zh,en:{'ui.window.prompts.text':''}};vm.runInThisContext(runtime);
  globalThis.ChatHandText.installCatalogs({locale:'en',catalogs:{en:{'ui.window.prompts.text':'Native first {name}'}}});let notices=0;globalThis.ChatHandText.subscribe(()=>notices++);
  const mod=await import('../../ui/local-text.mjs');assert.equal(mod.uiText('ui.window.prompts.text',{name:'Mac'}),'Native first Mac');assert.equal(notices,0);
  vm.runInThisContext(runtime);assert.equal(mod.uiText('ui.window.prompts.text',{name:'Mac'}),'Native first Mac');assert.equal(notices,0);
  // The same module consumer sees a later authoritative native arrival.
  globalThis.ChatHandText.update({locale:'en',catalogs:{en:{'ui.window.prompts.text':'Native later {name}'}}});assert.equal(mod.uiText('ui.window.prompts.text',{name:'Mac'}),'Native later Mac');assert.equal(notices,1);
 }finally{if(oldState===undefined)delete globalThis.__CHATHAND_TEXT_STATE__;else globalThis.__CHATHAND_TEXT_STATE__=oldState;if(oldAPI===undefined)delete globalThis.ChatHandText;else globalThis.ChatHandText=oldAPI;if(oldCatalogs===undefined)delete globalThis.__CHATHAND_TEXT_CATALOGS__;else globalThis.__CHATHAND_TEXT_CATALOGS__=oldCatalogs;}
});

const chrome=findChrome();
test('real isolated Chrome: async native first load repaints constants, templates and static labels; 84px matter rows remain intact',{skip:chrome?false:'Chrome unavailable',timeout:45000},async t=>{
 const state={version:'locale-test',enabled:true,mode:'full',settings:{onboarding:false,last_seen_version:'locale-test',terminal_enabled:true,browser_enabled:true,desktop_enabled:true,high_risk:{}},connection:{ready:true,healthy:true},automation:{computer:{permissions:{}},browser:{extension:{}}},capabilities:{},project:{path:'/tmp/window-locales-fixture',name:'Fixture'},permissions:{},ui:{seen:['perm-hint-1012']},tasks:[],jobs:[],approvals:[],blocks:[],activity:{items:[]},matters:{items:[{id:'M-001',title:'Fixture matter',state:'deferred',updated_at:Date.now(),created_at:Date.now(),source:{label:'Fixture'}}]}};
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;if(pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pathname==='/api/state'?state:{}));return;}
  try{let body=read('ui/'+(pathname==='/'?'index.html':pathname.slice(1)));if(pathname==='/'){body=body.replace(/<script\b[^>]*src="\/(?:skin\.js|skin-switcher\.js|wizard\.js|stream\.js|h10\/host\.mjs)"[^>]*><\/script>/g,'');}res.setHeader('Content-Type',/\.(?:js|mjs)$/.test(pathname)?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.statusCode=404;res.end('');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--disable-background-networking','--disable-extensions','--use-mock-keychain','--password-store=basic']});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.__nativeCalls=[];window.webkit={messageHandlers:{native:{postMessage(message){window.__nativeCalls.push(message.action);if(message.action==='getLocalTextCatalogs'){window.__releaseText=result=>window.nativeReply({id:message.id,result});return;}if(message.id)queueMicrotask(()=>window.nativeReply({id:message.id,result:{ok:true}}));}}}};});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForSelector('.prompt-pill');
 assert.equal(await page.locator('[data-local-text="ui.window.brand.description"]').textContent(),'桌面任务助手');assert.equal(await page.locator('.prompt-pill span').first().textContent(),'查看系统版本和空间');
 // Deliberately synthetic test strings, never the English shipping catalog.
 await page.evaluate(()=>window.__releaseText({locale:'en',catalogs:{en:{'ui.window.brand.description':'Desktop task assistant','ui.window.promptLabels.text':'Check system version and available storage','ui.window.header.openChatGPT':'Open ChatGPT','ui.window.matterLabel.text4':'Deferred for a later conversation','ui.window.colHead.text3':'Notes and follow-up matters'}}}));
 await page.waitForFunction(()=>document.querySelector('.prompt-pill span')?.textContent==='Check system version and available storage');
 assert.equal(await page.locator('[data-local-text="ui.window.brand.description"]').textContent(),'Desktop task assistant');assert.equal(await page.locator('html').getAttribute('lang'),'en');
 await page.locator('[data-tab="matters"]').click();await page.waitForSelector('.matter-row');
 const dimensions=await page.evaluate(()=>({minHeight:getComputedStyle(document.querySelector('.matter-row')).minHeight,height:document.querySelector('.matter-row').getBoundingClientRect().height,statusOverflow:getComputedStyle(document.querySelector('.matter-open>.mt-st')).overflow,scrollWidth:document.documentElement.scrollWidth,width:innerWidth}));assert.equal(dimensions.minHeight,'84px');assert.ok(dimensions.height>=84);assert.equal(dimensions.statusOverflow,'hidden');assert.ok(dimensions.scrollWidth<=dimensions.width+1,JSON.stringify(dimensions));assert.deepEqual(errors,[]);if(process.env.CHATHAND_UI_LOCALE_SCREENSHOT)await page.screenshot({path:process.env.CHATHAND_UI_LOCALE_SCREENSHOT,fullPage:true});
 const noNative=await browser.newPage({viewport:{width:1280,height:900},locale:'en-US',reducedMotion:'reduce'});await noNative.goto('http://127.0.0.1:'+server.address().port);await noNative.waitForSelector('.prompt-pill');await noNative.evaluate(()=>window.ChatHandLocalTextReady);assert.equal(await noNative.locator('html').getAttribute('lang'),'zh-CN');assert.equal(await noNative.locator('.prompt-pill span').first().textContent(),'查看系统版本和空间');await noNative.close();
 const nativeFirst=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});await nativeFirst.addInitScript(()=>{window.webkit={messageHandlers:{native:{postMessage(message){if(message.id)queueMicrotask(()=>window.nativeReply({id:message.id,result:message.action==='getLocalTextCatalogs'?{locale:'en',catalogs:{en:{'ui.window.promptLabels.text':'Native catalog before state'}}}:{ok:true}}));}}}};});await nativeFirst.goto('http://127.0.0.1:'+server.address().port);await nativeFirst.waitForSelector('.prompt-pill');assert.equal(await nativeFirst.locator('.prompt-pill span').first().textContent(),'Native catalog before state');await nativeFirst.close();t.diagnostic(JSON.stringify({syntheticEnglish:true,dimensions}));
});


test('partial matter reports add failed and unconfirmed counts instead of concatenating them',()=>{
 const en=JSON.parse(read('locales/en.json'));
 for(const locale of ['zh','en']){
  const f=fixture({zh,en});f.ChatHandText.installCatalogs({locale});
  vm.runInContext('const MATTER_DONE={save:"已保存"},MATTER_FAIL_WORDS={};const E=String;const btn=()=>"";function modal(text){globalThis.reportHTML=text;}function toast(text){globalThis.reportHTML=text;}',f);
  loadFunctions(f,['matterReport']);
  for(const [failed,unknown] of [[1,2],[0,2],[10,3]]){
   f.saved=[{}];f.failed=Array.from({length:failed},(_,i)=>({id:'F'+i,code:'TEST'}));f.unknown=Array.from({length:unknown},(_,i)=>({id:'U'+i}));
   vm.runInContext('matterReport("save",saved,failed,unknown)',f);
   const title=locale==='en'?`已保存 1, ${failed+unknown} failed`:`已保存 1 条，${failed+unknown} 条未完成`;
   assert.ok(f.reportHTML.startsWith(`<h2>${title}</h2>`),locale+' '+failed+' '+unknown);
  }
 }
});


test('shared words retain Chinese output while resume, restore, close and stopped have separate English meanings',()=>{
 const en=JSON.parse(read('locales/en.json'));
 for(const locale of ['zh','en']){
  const f=fixture({zh,en});f.ChatHandText.installCatalogs({locale});
  vm.runInContext('let S={settings:{high_risk:{admin:true,autostart:false}}};let isFull=true,caps={terminal_enabled:false,browser_enabled:false,desktop_enabled:false};const scopeFull=()=>isFull,capOn=k=>caps[k],risksOn=()=>[],workspaceName=()=>"Workspace";',f);
  loadFunctions(f,['permissionTierChanges']);
  let rows=Array.from(vm.runInContext('permissionTierChanges("full")',f));
  for(const key of ['ui.window.permCard.text3','ui.window.permCard.text4','ui.window.permCard.text5']){
   const name=f.ChatHandText.t(key);assert.ok(rows.includes(locale==='en'?`Turn on “${name}”`:`开启「${name}」`));
  }
  assert.ok(rows.includes(locale==='en'?'Turn on “Launch at login & scheduled tasks”':'开启「开机自启和定时任务」'));
  vm.runInContext('isFull=false;caps.desktop_enabled=true;S.settings.high_risk.autostart=true;',f);
  rows=Array.from(vm.runInContext('permissionTierChanges("light")',f));
  const name=f.ChatHandText.t('ui.window.permCard.text5');assert.ok(rows.includes(locale==='en'?`Turn off “${name}”`:`关闭「${name}」`));
  assert.ok(rows.includes(locale==='en'?'Turn off “Launch at login & scheduled tasks”':'关闭「开机自启和定时任务」'));
  assert.equal(f.ChatHandText.t('ui.window.action.resumeAI.button'),locale==='en'?'Resume':'恢复');
  assert.equal(f.ChatHandText.t('ui.window.toolWords.restore_file.text'),locale==='en'?'Restore':'恢复');
  assert.equal(f.ChatHandText.t('ui.window.permissionTierChanges.text4'),locale==='en'?'Close':'关闭');
  assert.equal(f.ChatHandText.t('ui.window.doneList.stoppedFilter'),locale==='en'?'Stopped':'已停止');
  assert.equal(f.ChatHandText.t('ui.window.doneList.text2'),locale==='en'?'Stop':'停止');
 }
});
