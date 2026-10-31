import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {chromium} from 'playwright-core';
import {createDesktop} from '../../app/server.mjs';
import {findChrome} from '../support/real-chrome.mjs';
import {t as translate} from '../../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');

const cases=[
 ['terminal_enabled','terminal','命令','i-terminal','关闭后，ChatGPT 将无法在这台 Mac 上运行命令，如运行测试、安装依赖、打包等。','ChatGPT 可以在这台 Mac 上运行命令。高危命令仍保持关闭，需要时会先询问你。'],
 ['browser_enabled','browser','浏览器控制','i-globe','关闭后，ChatGPT 将无法操作浏览器（打开网页、点击按钮、填写表单），更新后也无法自动刷新工具。','ChatGPT 可以通过 Chrome 插件打开网页、点击按钮、填写表单、读取页面。'],
 ['desktop_enabled','desktop','桌面控制','i-monitor','关闭后，ChatGPT 将无法查看屏幕、使用鼠标和键盘，也无法操作其他 App。','ChatGPT 可以查看屏幕、使用鼠标和键盘、操作其他 App。使用时会占用前台。']
];
const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');

test('1030 A：三种能力在首页和抽屉都先确认；取消不发请求且状态不变，确认只发一次',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1030-toggle-')),uiKey='a'.repeat(64);let app,browser;
 t.after(async()=>{await browser?.close();await app?.close();fs.rmSync(root,{recursive:true,force:true});});
 app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),uiKey,clientDeps:{computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.state.data.setup_complete=true;app.state.data.tunnel={id:'isolated-toggle'};app.state.save();
 const origin=`http://127.0.0.1:${app.apiPort}`,headers={Authorization:'Bearer '+app.adminToken,'X-ChatHand-UI':uiKey,'Content-Type':'application/json'};
 const getState=async()=>{const r=await fetch(origin+'/api/state',{headers});assert.equal(r.status,200);return r.json();};
 const set=async body=>{const r=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);await r.json();};
 browser=await chromium.launch({headless:true,executablePath:findChrome()});
 for(const zone of ['home','drawer'])for(const [key,section,label,icon,offBody,onBody] of cases)for(const initial of [true,false]){
  await t.test(`${zone} ${key} ${initial?'关':'开'}`,async()=>{
   await set({[key]:initial});const context=await browser.newContext({viewport:{width:1280,height:860},locale:'zh-CN'}),page=await context.newPage();const posts=[],errors=[];
   try{
    await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(req.method()==='POST'&&url.pathname==='/api/settings'){const body=req.postDataJSON();if(cases.some(([cap])=>Object.hasOwn(body,cap)))posts.push(body);}return route.continue();});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/#'+app.adminToken+'.'+uiKey,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>S&&document.querySelector('#main > *'));
    // A running-task fixture affects only the isolated UI, never the user's actual task state.
    await page.evaluate(()=>{S.tasks=[{task_id:'toggle-running',status:'active',created_at:Date.now(),title:'运行中的测试'}];render();});
    if(zone==='drawer')await page.evaluate(section=>showPage('settings',section),section);
    const sw=page.locator(`${zone==='drawer'?'#drawer':'#rail'} [data-toggle="${key}"]`);
    await sw.waitFor({state:'visible'});assert.equal(await sw.getAttribute('aria-checked'),String(initial));
    const checkDialog=async()=>{await page.locator('#modal[open]').waitFor();assert.equal(await page.locator('#askTitle').innerText(),`要${initial?'关闭':'打开'}「${label}」吗？`);assert.ok((await page.locator('#modal').innerText()).includes(initial?offBody:onBody));assert.equal(await page.locator('#modal [data-action="askYes"]').innerText(),initial?'关闭':'打开');assert.equal(await page.locator('#modal .ask-icon use').getAttribute('href'),'#'+icon);assert.equal(await page.locator('#modal .ask-warning').count(),initial?1:0);};
    await sw.click();await checkDialog();assert.equal(posts.length,0);assert.equal((await getState()).settings[key],initial);
    await page.locator('#modal [data-action="askNo"]').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(posts.length,0);assert.equal(await sw.getAttribute('aria-checked'),String(initial));assert.equal((await getState()).settings[key],initial);
    // Reapply only the fake workload if a server event refreshed it while the dialog was open.
    await page.evaluate(()=>{S.tasks=[{task_id:'toggle-running',status:'active',created_at:Date.now(),title:'运行中的测试'}];render();});
    await sw.click();await checkDialog();assert.equal(posts.length,0);
    await page.locator('#modal [data-action="askYes"]').click();await page.waitForFunction(({key,value})=>S.settings[key]===value,{key,value:!initial});
    assert.deepEqual(posts,[{[key]:!initial}]);assert.equal((await getState()).settings[key],!initial);assert.deepEqual(errors,[]);
   }finally{await context.close();}
  });
 }
});

test('1030 A：没有运行任务时关闭不加 warning；打开始终不加 warning',()=>{
 const begin=source.indexOf('let CAP_WORDS='),end=source.indexOf('\n}',source.indexOf('function capabilityTogglePrompt',begin))+2;
 for(const count of [0,2]){const ctx=vm.createContext({runningCount:()=>count,T});vm.runInContext(source.slice(begin,end),ctx);for(const [key] of cases){assert.equal(ctx.capabilityTogglePrompt(key,false).warning,count?T('ui.window.capabilityTogglePrompt.warning.text'):'');assert.equal(ctx.capabilityTogglePrompt(key,true).warning,'');}}
});

test('1030 A：开机启动和普通设置仍直接走原路径，不调用 ask',async()=>{
 const start=source.indexOf(" const t=e.target.closest('[data-toggle]');"),end=source.indexOf(" const b=e.target.closest('[data-action]');",start);
 assert.ok(start>0&&end>start);const handler=source.slice(start,end);
 for(const key of ['launch_at_login','notifications']){
  let asks=0;const calls=[],attrs={'aria-checked':'false'},t={dataset:{toggle:key},getAttribute:k=>attrs[k],setAttribute:(k,v)=>{attrs[k]=v;},closest:()=>null};
  const context=vm.createContext({CAP_WORDS:Object.fromEntries(cases.map(x=>[x[0],[x[1],x[2],'']])),capUnsupported:()=>false,T,ask:async()=>{asks++;return false;},capabilityTogglePrompt:()=>({}),native:async(name,args)=>{calls.push([name,args]);return {};},api:async(name,args)=>{calls.push([name,args]);return {};},nativeStatus:{},nativeStatusAt:0,Date,toast(){},refresh:async()=>{},render(){},userMessage:String});
  const run=vm.runInContext('(async e=>{'+handler+'})',context);await run({target:{closest:()=>t}});
  assert.equal(asks,0);assert.equal(attrs['aria-checked'],'true');assert.equal(calls.length,1);assert.equal(calls[0][0],key==='launch_at_login'?'setLoginItemEnabled':'/api/settings');
 }
});
