import {text, setSystemLanguage, languageState} from '../browser-extension/locale.js';
// 1033 A：无头、临时配置的真 Chrome + 真 background/driver/helper。
// chrome.*、native port 和活动标签记录由 CDP 适配；不是已安装助手或 macOS 前台验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {findChrome, launchChrome, FakeChrome, startServer} from '../test-support/real-chrome.mjs';
import {BrowserDriver} from '../browser-extension/driver.js';

const CHROME = findChrome();
const event = () => {const listeners=[];return {addListener: fn=>listeners.push(fn),fire:(...args)=>listeners.map(fn=>fn(...args))};};
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check, message) {const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await sleep(20);}assert.fail(message);}
const html = body => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;

test('1033 A 真 Chrome：用户输入不暂停，后台不切活动页，明确停止后零投递', {skip:CHROME?false:'找不到 Chrome',timeout:60000}, async t => {
  const chrome=await launchChrome(CHROME);t.after(()=>chrome.close());
  const server=await startServer({
    '/user':html('<label for="user">用户输入</label><input id="user"><div style="height:3000px"></div><script>window.userEvents={};for(const kind of ["pointermove","pointerdown","keydown","wheel"])addEventListener(kind,e=>{if(e.isTrusted)userEvents[kind]=(userEvents[kind]||0)+1;},{capture:true});</script>'),
    '/ai':html('<label for="name">姓名</label><input id="name"><button id="button" type="button" onclick="document.getElementById(\'out\').textContent=\'点了\'">普通按钮</button><p id="out">准备好了</p>'),
    '/favicon.ico':''
  });t.after(()=>server.close());
  const api=new FakeChrome(chrome.cdp);t.after(()=>api.dispose());
  const inputs=[],uiCalls=[];
  const sendCommand=api.debugger.sendCommand,create=api.tabs.create,update=api.tabs.update;
  let gate=null,hold=false;
  api.debugger.sendCommand=async (target,method,params)=>{
    if(method.startsWith('Input.'))inputs.push({tabId:target.tabId,method});
    if(hold&&['DOM.focus','DOM.scrollIntoViewIfNeeded'].includes(method)){hold=false;await new Promise(resolve=>{gate=resolve;});}
    return sendCommand(target,method,params);
  };
  api.tabs.create=async args=>{uiCalls.push({kind:'create',...args});return create(args);};
  api.tabs.update=async (id,args)=>{uiCalls.push({kind:'update',id,...args});return update(id,args);};
  api.windows.update=async (id,args)=>{uiCalls.push({kind:'window',id,...args});return {id};};
  const user=await api.tabs.create({url:server.base+'/user',active:true});
  await until(async()=>await api.evaluate(user.id,'!!document.getElementById("user")'),'用户测试页没有载入');
  await api.tabs.update(user.id,{active:true});
  const userControl=api.requireTab(user.id).control;
  await chrome.cdp.send('Runtime.evaluate',{expression:'document.getElementById("user").focus()'},userControl);
  const activity=async()=>{
    for(const params of [{type:'mouseMoved',x:40,y:30},{type:'mousePressed',x:200,y:12,button:'left',clickCount:1},{type:'mouseReleased',x:200,y:12,button:'left',clickCount:1},{type:'mouseWheel',x:40,y:30,deltaX:0,deltaY:50}])await chrome.cdp.send('Input.dispatchMouseEvent',params,userControl);
    await chrome.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'u',code:'KeyU',windowsVirtualKeyCode:85},userControl);
    await chrome.cdp.send('Input.insertText',{text:'用户自己的输入'},userControl);
    await chrome.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'u',code:'KeyU',windowsVirtualKeyCode:85},userControl);
  };
  const posted=[],runtimeMessage=event(),port={onMessage:event(),onDisconnect:event(),disconnect(){},postMessage(message){posted.push(message);if(message.kind==='authorize')queueMicrotask(()=>port.onMessage.fire({kind:'authorization',id:message.id,allowed:true}));}};
  let saved={enabled:true},driver;
  Object.assign(api.runtime,{id:'test',getURL:name=>'chrome-extension://test/'+name,getManifest:()=>({version:'1.0.0.1033'}),connectNative:()=>port,onInstalled:event(),onStartup:event(),onMessage:runtimeMessage});
  api.storage={local:{get:async()=>saved,set:async values=>{saved={...saved,...values};}}};api.action={setBadgeText:async()=>{}};api.alarms={create(){},onAlarm:event()};
  class RealDriver extends BrowserDriver {constructor(api,options){super(api,{...options,idleMs:120000,settleMs:100,pollMs:20});driver=this;}}
  const source=fs.readFileSync(new URL('../browser-extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  const context=vm.createContext({text,setSystemLanguage,languageState,chrome:api,BrowserDriver:RealDriver,setTimeout,clearTimeout,Date,Promise,console});vm.runInContext(source,context);
  t.after(()=>driver.detachAll());
  await until(()=>posted.some(x=>x.kind==='hello'),'助手没有连接');port.onMessage.fire({kind:'status',ready:true});
  let seq=0;
  const enqueue=(action,args={})=>{const id='a-'+(++seq);port.onMessage.fire({kind:'request',id,action,args,deadline:Date.now()+20000});return id;};
  const call=async(action,args={})=>{const id=enqueue(action,args);await until(()=>posted.some(x=>x.kind==='result'&&x.id===id),action+'没有回执');const r=posted.find(x=>x.kind==='result'&&x.id===id);assert.equal(r.error,undefined,JSON.stringify(r));return r.result;};
  // 用户页也被观察过：旧 input watcher 会安装在这里，因而输入确实覆盖旧暂停路径。
  await call('snapshot',{page_id:String(user.id),allow_personal:true});
  const beforeUI=uiCalls.length;
  const opened=await call('new',{url:server.base+'/ai'}),page_id=opened.page_id,ai=Number(page_id);
  assert.equal(opened.shown,false);const selected=await call('select',{page_id});assert.equal(selected.selected,true);assert.equal(selected.shown,false);
  assert.equal(api.activeTab,user.id);
  assert.ok(uiCalls.slice(beforeUI).every(x=>x.active!==true&&x.focused!==true),'没有活动标签/聚焦窗口调用');
  const ready=await call('wait_for',{page_id,condition:{kind:'text',text:'准备好了',timeout_ms:10000}});assert.equal(ready.status,'completed');
  const snap=await call('snapshot',{page_id});const name=snap.elements.find(x=>x.role==='textbox'&&x.name==='姓名'),button=snap.elements.find(x=>x.role==='button'&&x.name==='普通按钮');assert.ok(name&&button);
  const generation=driver.generation;
  hold=true;const filling=enqueue('fill',{page_id,ref:name.ref,text:'后台填写'});
  await until(()=>gate!==null,'动作没有抵达可控投递前等待');await activity();const release=gate;gate=null;release();
  await until(()=>posted.some(x=>x.kind==='result'&&x.id===filling),'后台输入没有回执');
  const filled=posted.find(x=>x.kind==='result'&&x.id===filling);assert.equal(filled.error,undefined);assert.equal(filled.result.status,'completed',JSON.stringify(filled));assert.equal(await api.evaluate(ai,'document.getElementById("name").value'),'后台填写');assert.equal(driver.generation,generation);
  const userEvents=await api.evaluate(user.id,'userEvents');for(const kind of ['pointermove','pointerdown','keydown','wheel'])assert.ok(userEvents[kind]>0,kind+'是真 Chrome 可信输入');
  assert.equal(api.activeTab,user.id);assert.ok(uiCalls.slice(beforeUI).every(x=>x.active!==true&&x.focused!==true));
  const visibility={user:await api.evaluate(user.id,'document.visibilityState'),ai:await api.evaluate(ai,'document.visibilityState')};
  assert.deepEqual(visibility,{user:'visible',ai:'hidden'});
  // headless 没有可目视的标签栏；同时记录真实 visibility 和所有激活调用，避免只凭夹具 activeTab 判断。
  t.diagnostic(JSON.stringify({chrome:chrome.version,userEvents,visibility,uiCalls:uiCalls.slice(beforeUI),inputsBeforeStop:inputs.length}));
  hold=true;enqueue('click',{page_id,ref:button.ref});await until(()=>gate!==null,'停止场景没有抵达投递前等待');
  enqueue('fill',{page_id,ref:name.ref,text:'停止后不得填写'});const beforeStop=inputs.length;
  const disabled=await new Promise(resolve=>runtimeMessage.fire({action:'disable'},{id:'test',url:api.runtime.getURL('popup.html')},resolve));assert.equal(disabled.enabled,false);
  const stopRelease=gate;gate=null;stopRelease();await vm.runInContext('queue',context);
  enqueue('click',{page_id,ref:button.ref});await vm.runInContext('queue',context);await sleep(50);
  assert.equal(inputs.length,beforeStop,'停止后当前、队列及迟到请求都不再投递');assert.equal(saved.enabled,false);assert.equal(await api.evaluate(ai,'document.getElementById("out").textContent'),'准备好了');assert.equal(await api.evaluate(ai,'document.getElementById("name").value'),'后台填写');assert.equal(api.activeTab,user.id);
  t.diagnostic(JSON.stringify({stop:'popup disable',inputsAfterStop:inputs.length-beforeStop,userTabUnchanged:true}));
});
