import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../../browser-extension/background.js',import.meta.url),'utf8');
const locale=new URL('../../browser-extension/locale.js',import.meta.url).href;
let sequence=0;
const event=()=>{const listeners=[];return {addListener(fn){listeners.push(fn);},fire(...args){for(const fn of listeners)fn(...args);}};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};
async function fixture(t,execute,onPost){
 const key='__uploadBackgroundFixture'+(++sequence),port={onDisconnect:event(),onMessage:event(),posted:[],postMessage(message){this.posted.push(message);queueMicrotask(()=>onPost?.(message,this));},disconnect(){}};
 const chrome={runtime:{id:'upload-fixture',getManifest:()=>({version:'1.0.0.1090'}),getURL:name=>'chrome-extension://upload-fixture/'+name,connectNative:()=>port,onInstalled:event(),onStartup:event(),onMessage:event()},storage:{local:{get:async()=>({enabled:true}),set:async()=>{}}},action:{setBadgeText:async()=>{}},alarms:{create(){},onAlarm:event()},tabs:{onRemoved:event(),onUpdated:event()},debugger:{onDetach:event()}};
 globalThis[key]={chrome,execute};const fake='data:text/javascript,'+encodeURIComponent(`const fixture=globalThis[${JSON.stringify(key)}];export class BrowserDriver{constructor(){this.attached=new Set();}async detachAll(){} cancel(){} invalidate(){} async execute(...args){return fixture.execute(...args);}}`);
 const modified=`const {chrome}=globalThis[${JSON.stringify(key)}];\n`+source.replace("'./driver.js'",JSON.stringify(fake)).replace("'./locale.js'",JSON.stringify(locale));await import('data:text/javascript;base64,'+Buffer.from(modified).toString('base64'));delete globalThis[key];await flush();
 t.after(()=>{chrome.runtime.onMessage.fire({action:'disable'},{id:'upload-fixture',url:chrome.runtime.getURL('popup.html')},()=>{});});
 const request=(id='upload-1')=>port.onMessage.fire({kind:'request',id,action:'upload',args:{page_id:'1',files:[{name:'fixture.bin',mimeType:'application/octet-stream',size:1}]},deadline:Date.now()+10000});
 return {port,chrome,request};
}
const authorize=(message,port)=>{if(message.kind==='authorize')port.onMessage.fire({kind:'authorization',id:message.id,allowed:true});};

test('background advertises payload capability, authorizes each chunk and correlates host response by both IDs',async t=>{
 let received=false;
 const f=await fixture(t,async(action,args,options)=>{assert.equal(action,'upload');const chunk=await options.readUploadChunk(0,0);assert.equal(chunk.base64,'eA==');received=true;return {performed:'upload'};},(message,port)=>{authorize(message,port);if(message.kind==='upload_chunk'){
  const reply={kind:'upload_chunk',id:message.id,chunk_id:message.chunk_id,index:0,offset:0,byteLength:1,base64:'eA==',eof:true};
  port.onMessage.fire({...reply,id:'wrong-request',base64:'AA=='});port.onMessage.fire({...reply,chunk_id:'wrong-chunk',base64:'AA=='});port.onMessage.fire(reply);
 }});
 assert.ok(f.port.posted[0].helper.features.includes('upload_payload_v1'));f.request();await flush();assert.equal(received,true);assert.equal(f.port.posted.filter(message=>message.kind==='authorize').length,2);assert.equal(f.port.posted.find(message=>message.kind==='result').result.performed,'upload');
 const chunk=f.port.posted.find(message=>message.kind==='upload_chunk');assert.deepEqual(Object.keys(chunk).sort(),['chunk_id','id','index','kind','offset']);
});

test('pause and disconnect reject outstanding chunks; late host data never resumes upload',async t=>{
 for(const stop of ['pause','disconnect','detach','navigation']){
  let resumed=0;const f=await fixture(t,async(action,args,options)=>{await options.readUploadChunk(0,0);resumed++;return {};},authorize);f.request();await flush();const pending=f.port.posted.find(message=>message.kind==='upload_chunk');assert.ok(pending);
  if(stop==='pause')f.port.onMessage.fire({control:'pause'});else if(stop==='detach')f.chrome.debugger.onDetach.fire({tabId:1},'target_closed');else if(stop==='navigation')f.chrome.tabs.onUpdated.fire(1,{status:'loading'});else f.port.onDisconnect.fire();await flush();f.port.onMessage.fire({...pending,index:0,offset:0,byteLength:1,base64:'eA==',eof:true});await flush();assert.equal(resumed,0);
 }
});

test('chunk permission revoked before read sends no payload request',async t=>{
 let checks=0;const f=await fixture(t,async(action,args,options)=>{await options.readUploadChunk(0,0);return {};},(message,port)=>{if(message.kind==='authorize')port.onMessage.fire({kind:'authorization',id:message.id,allowed:++checks===1});});f.request();await flush();assert.equal(f.port.posted.some(message=>message.kind==='upload_chunk'),false);assert.equal(f.port.posted.find(message=>message.kind==='result').error.code,'TASK_REVOKED');
});
