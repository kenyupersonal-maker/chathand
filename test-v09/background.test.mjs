import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../browser-extension/background.js',import.meta.url),'utf8');
const localeUrl=new URL('../browser-extension/locale.js',import.meta.url).href;
let fixtureSequence=0;
async function loadBackground(chrome,schedule,unschedule){
 const key=`__backgroundFixture${++fixtureSequence}`;
 const fixture={chrome,setTimeout:schedule,clearTimeout:unschedule,driver:null};
 globalThis[key]=fixture;
 try{
  const fakeDriverSource=`const fixture=globalThis[${JSON.stringify(key)}];export class BrowserDriver { constructor(){this.attached=new Set();this.detachCount=0;this.cancelCount=0;fixture.driver=this;} async detachAll(){this.detachCount++;} cancel(){this.cancelCount++;} async execute(){return {ok:true};} invalidate(){} }`;
  const fakeDriverUrl='data:text/javascript,'+encodeURIComponent(fakeDriverSource);
  const moduleSource=`const {chrome,setTimeout,clearTimeout}=globalThis[${JSON.stringify(key)}];\n`+source.replace("'./driver.js'",JSON.stringify(fakeDriverUrl)).replace("'./locale.js'",JSON.stringify(localeUrl));
  await import('data:text/javascript;base64,'+Buffer.from(moduleSource).toString('base64'));
  return fixture;
 }finally{delete globalThis[key];}
}

function event(){
 const listeners=[];
 return {
  addListener(listener){listeners.push(listener);},
  fire(...args){return listeners.map(listener=>listener(...args));},
  size(){return listeners.length;}
 };
}

async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
const MISSING=Symbol('missing');

async function harness(initialEnabled=true,{delayFirstGet=false,delayFirstSet=false,rejectSet=false}={}){
 const timers=new Map();
 let nextTimer=0;
 const missing=initialEnabled===MISSING;let storageEnabled=missing?undefined:initialEnabled,hasStoredEnabled=!missing;
 let delayedGetRelease=null,delayedSetRelease=null,setCalls=0;
 let connectCount=0;
 const ports=[];
 const badges=[];
 const alarmEvents=event();
 const runtimeMessage=event();

 function schedule(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;}
 function unschedule(id){timers.delete(id);}
 function nextTimerDelay(){const entry=[...timers.values()].sort((a,b)=>a.delay-b.delay)[0];return entry?.delay;}
 function runNextTimer(){const entry=[...timers.entries()].sort((a,b)=>a[1].delay-b[1].delay)[0];if(!entry)return false;timers.delete(entry[0]);entry[1].fn();return true;}

 const chrome={
  runtime:{
   id:'ext',
   lastError:undefined,
   getURL:name=>`chrome-extension://ext/${name}`,
   connectNative:()=>{
    connectCount++;
    const port={posted:[],disconnectCount:0,onDisconnect:event(),onMessage:event(),postMessage(message){this.posted.push(message);},disconnect(){this.disconnectCount++;}};
    ports.push(port);
    return port;
   },
   onInstalled:event(),
   onStartup:event(),
   onMessage:runtimeMessage
  },
  storage:{local:{get:async()=>{if(delayFirstGet){delayFirstGet=false;await new Promise(resolve=>{delayedGetRelease=resolve;});}return hasStoredEnabled?{enabled:storageEnabled}:{};},set:async values=>{setCalls++;if(delayFirstSet){delayFirstSet=false;await new Promise(resolve=>{delayedSetRelease=resolve;});}if(rejectSet)throw Error('STORAGE_WRITE_FAILED');if(Object.hasOwn(values,'enabled')){storageEnabled=values.enabled;hasStoredEnabled=true;}}}},
  action:{setBadgeText:async({text})=>{badges.push(text);}},
  alarms:{create(){},onAlarm:alarmEvents},
  tabs:{onRemoved:event(),onUpdated:event()},
  debugger:{onDetach:event()}
 };
 const moduleFixture=await loadBackground(chrome,schedule,unschedule);
 const popupSender={id:'ext',url:chrome.runtime.getURL('popup.html')};
 return {chrome,ports,badges,driver:()=>moduleFixture.driver,get connectCount(){return connectCount;},get storageEnabled(){return storageEnabled;},get setCalls(){return setCalls;},allowWrites(){rejectSet=false;},releaseDelayedGet(){delayedGetRelease?.();delayedGetRelease=null;},releaseDelayedSet(){delayedSetRelease?.();delayedSetRelease=null;},nextTimerDelay,runNextTimer,timerCount:()=>timers.size,alarmEvents,runtimeMessage,popupSender,flush};
}

test('宿主断开后短延迟重连，alarm 不会重复建立连接',async()=>{
 const h=await harness();await h.flush();assert.equal(h.connectCount,1);assert.equal(h.ports[0].posted[0]?.kind,'hello');assert.equal(h.ports[0].posted[0]?.version,1);assert.equal(h.ports[0].posted[0]?.enabled,true);assert.ok(h.ports[0].posted[0]?.helper);
 h.ports[0].onDisconnect.fire();await h.flush();assert.equal(h.nextTimerDelay(),250);assert.equal(h.driver().detachCount,1);
 h.alarmEvents.fire({name:'ken-reconnect'});await h.flush();assert.equal(h.connectCount,1);
 assert.equal(h.runNextTimer(),true);await h.flush();assert.equal(h.connectCount,2);
 h.ports[0].onDisconnect.fire();await h.flush();assert.equal(h.connectCount,2);assert.equal(h.timerCount(),0);
 h.ports[1].onDisconnect.fire();await h.flush();assert.equal(h.nextTimerDelay(),500);
});

test('已保存的停用状态不会被 install 或 update 事件重置',async()=>{
 for(const reason of ['install','update']){
  const h=await harness(false);await h.flush();h.chrome.runtime.onInstalled.fire({reason});await h.flush();assert.equal(h.storageEnabled,false);assert.equal(h.connectCount,0);h.alarmEvents.fire({name:'ken-reconnect'});await h.flush();assert.equal(h.connectCount,0);
 }
 const h=await harness(false);await h.flush();h.chrome.runtime.onStartup.fire();await h.flush();assert.equal(h.storageEnabled,false);assert.equal(h.connectCount,0);
});

test('首次启动且没有保存状态时默认启用一次，install 事件不重复连接',async()=>{const h=await harness(MISSING);await h.flush();assert.equal(h.storageEnabled,true);assert.equal(h.connectCount,1);h.chrome.runtime.onInstalled.fire({reason:'install'});await h.flush();assert.equal(h.storageEnabled,true);assert.equal(h.connectCount,1);});

test('迟到的初始化读取不会覆盖停用，重复 install 事件也保留最后选择',async()=>{const h=await harness(true,{delayFirstGet:true});let disabled;h.runtimeMessage.fire({action:'disable'},h.popupSender,value=>{disabled=value;});await h.flush();h.releaseDelayedGet();await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(h.storageEnabled,false);assert.equal(JSON.stringify(disabled),JSON.stringify({enabled:false}));h.chrome.runtime.onInstalled.fire({reason:'install'});await h.flush();assert.equal(h.storageEnabled,false);assert.equal(h.connectCount,0);});

test('冷启动读取未完成时的真实 canceled_by_user 也会优先停用',async()=>{const h=await harness(true,{delayFirstGet:true});h.chrome.debugger.onDetach.fire({tabId:8},'canceled_by_user');await h.flush();h.releaseDelayedGet();await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(h.storageEnabled,false);assert.equal(h.connectCount,0);});

test('取消事件会使延迟 enable 写入失效，最终停用且不重连',async()=>{const h=await harness(false,{delayFirstSet:true});await h.flush();let enabled;h.runtimeMessage.fire({action:'enable'},h.popupSender,value=>{enabled=value;});await h.flush();assert.equal(h.connectCount,0);h.alarmEvents.fire({name:'ken-reconnect'});await h.flush();assert.equal(h.connectCount,0);h.chrome.debugger.onDetach.fire({tabId:7},'canceled_by_user');await h.flush();h.releaseDelayedSet();await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(JSON.stringify(enabled),JSON.stringify({enabled:true}));assert.equal(h.storageEnabled,false);assert.equal(h.connectCount,0);h.chrome.runtime.onStartup.fire();await h.flush();assert.equal(h.storageEnabled,false);assert.equal(h.connectCount,0);});

test('停用保存失败会返回错误并在 status 可见，成功重试后清除警示',async()=>{const h=await harness(true,{rejectSet:true});await h.flush();assert.equal(h.connectCount,1);let disabled;h.runtimeMessage.fire({action:'disable'},h.popupSender,value=>{disabled=value;});await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(disabled?.enabled,false);assert.equal(disabled?.error,'PREFERENCE_SAVE_FAILED');assert.equal(h.storageEnabled,true);assert.equal(h.connectCount,1);let failedStatus;h.runtimeMessage.fire({action:'status'},h.popupSender,value=>{failedStatus=value;});assert.equal(failedStatus?.enabled,false);assert.equal(failedStatus?.connected,false);assert.equal(failedStatus?.preference_revision,1);assert.equal(failedStatus?.preference_ready,false);assert.equal(failedStatus?.preference_error,'PREFERENCE_SAVE_FAILED');assert.equal(failedStatus?.preference_error_enabled,false);h.alarmEvents.fire({name:'ken-reconnect'});await h.flush();h.chrome.runtime.onStartup.fire();await h.flush();assert.equal(h.connectCount,1);h.allowWrites();let enabled;h.runtimeMessage.fire({action:'enable'},h.popupSender,value=>{enabled=value;});await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(JSON.stringify(enabled),JSON.stringify({enabled:true}));let recoveredStatus;h.runtimeMessage.fire({action:'status'},h.popupSender,value=>{recoveredStatus=value;});assert.equal(recoveredStatus?.enabled,true);assert.equal(recoveredStatus?.preference_ready,true);assert.equal(recoveredStatus?.preference_error,null);assert.equal(h.connectCount,2);});

test('启用保存失败时 alarm 和 startup 不重连，成功重试后才连接',async()=>{const h=await harness(false,{rejectSet:true});await h.flush();let enabled;h.runtimeMessage.fire({action:'enable'},h.popupSender,value=>{enabled=value;});await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(enabled?.enabled,true);assert.equal(enabled?.error,'PREFERENCE_SAVE_FAILED');assert.equal(h.connectCount,0);let failedStatus;h.runtimeMessage.fire({action:'status'},h.popupSender,value=>{failedStatus=value;});assert.equal(failedStatus?.enabled,true);assert.equal(failedStatus?.connected,false);assert.equal(failedStatus?.preference_ready,false);assert.equal(failedStatus?.preference_error,'PREFERENCE_SAVE_FAILED');assert.equal(failedStatus?.preference_error_enabled,true);h.alarmEvents.fire({name:'ken-reconnect'});await h.flush();h.chrome.runtime.onStartup.fire();await h.flush();assert.equal(h.connectCount,0);h.allowWrites();h.runtimeMessage.fire({action:'enable'},h.popupSender,value=>{enabled=value;});await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(JSON.stringify(enabled),JSON.stringify({enabled:true}));assert.equal(h.connectCount,1);});

test('用户停用会取消重连，重新启用后才恢复连接',async()=>{
 const h=await harness();await h.flush();h.ports[0].onDisconnect.fire();await h.flush();assert.equal(h.timerCount(),1);
 let disabled;
 h.runtimeMessage.fire({action:'disable'},h.popupSender,value=>{disabled=value;});await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(JSON.stringify(disabled),JSON.stringify({enabled:false}));assert.equal(h.storageEnabled,false);assert.equal(h.timerCount(),0);
 h.alarmEvents.fire({name:'ken-reconnect'});await h.flush();assert.equal(h.connectCount,1);
 let enabled;
 h.runtimeMessage.fire({action:'enable'},h.popupSender,value=>{enabled=value;});await h.flush();await new Promise(resolve=>setImmediate(resolve));await h.flush();assert.equal(JSON.stringify(enabled),JSON.stringify({enabled:true}));assert.equal(h.storageEnabled,true);assert.equal(h.connectCount,2);
});

test('断端口发送异常不会让动作队列永久拒绝，重连后下一项仍可执行',async()=>{
 const h=await harness();await h.flush();const first=h.ports[0];const original=first.postMessage;let throwResult=true;first.postMessage=function(message){if(throwResult&&message.kind==='result'){throwResult=false;throw Error('PORT_CLOSED');}return original.call(this,message);};
 first.onMessage.fire({kind:'request',id:'first',action:'tabs',args:{},deadline:Date.now()+1000});await h.flush();first.onMessage.fire({kind:'authorization',id:'first',allowed:true});await h.flush();assert.equal(h.connectCount,1);assert.equal(h.nextTimerDelay(),250);
 h.runNextTimer();await h.flush();assert.equal(h.connectCount,2);const second=h.ports[1];second.onMessage.fire({kind:'request',id:'second',action:'tabs',args:{},deadline:Date.now()+1000});await h.flush();second.onMessage.fire({kind:'authorization',id:'second',allowed:true});await h.flush();assert.ok(second.posted.some(message=>message.kind==='result'&&message.id==='second'&&message.result?.ok===true));
});
