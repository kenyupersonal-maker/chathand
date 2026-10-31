import {text, setSystemLanguage, languageState} from '../browser-extension/locale.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {cleanHelper,hostSource} from '../app/v09/extension-host.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const probeURL='http://127.0.0.1:43127/api/browser/extension/install/probe/'+'a'.repeat(64);
function event(){const listeners=[];return {addListener(fn){listeners.push(fn);},fire(...args){return listeners.map(fn=>fn(...args));}};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));}
async function until(predicate){for(let i=0;i<40;i++){await flush();if(predicate())return;}throw Error('FIXTURE_TIMEOUT');}

async function backgroundFixture(query){
 const source=fs.readFileSync(path.join(root,'browser-extension/background.js'),'utf8').replace(/^import .*;\n/gm,'');
 let driverInstance=null;class FakeDriver{constructor(){this.attached=new Set();this.executions=0;driverInstance=this;}async execute(){this.executions++;return {};}async detachAll(){}invalidate(){}noteDetached(){}}
 const onInstalled=event(),onStartup=event(),runtimeOnMessage=event(),onAlarm=event(),onRemoved=event(),onUpdated=event(),onDetach=event(),onDebug=event();
 const ports=[];const store={enabled:true};let queryCount=0,queryArg=null;
 const chrome={
  runtime:{id:'ext',lastError:null,getURL:n=>'chrome-extension://ext/'+n,getManifest:()=>({version:'1.0.0.1042',version_name:'1.0.0-beta.4 (1042)'}),reload(){},connectNative(){const p={posted:[],onDisconnect:event(),onMessage:event(),postMessage(m){this.posted.push(m);},disconnect(){}};ports.push(p);return p;},onInstalled,onStartup,onMessage:runtimeOnMessage},
  storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:store[keys]};const out={};for(const k of keys||[])if(Object.hasOwn(store,k))out[k]=store[k];return out;},async set(v){Object.assign(store,v);}}},
  action:{async setBadgeText(){}},alarms:{create(){},onAlarm},
  tabs:{async query(info){queryCount++;queryArg=info;return typeof query==='function'?query():query;},onRemoved,onUpdated},
  debugger:{onDetach,onEvent:onDebug}
 };
 const context={text,setSystemLanguage,languageState,chrome,BrowserDriver:FakeDriver,setTimeout,clearTimeout,Date,Promise,URL,console};
 vm.runInNewContext(source,context,{filename:'background.js'});
 await flush();assert.equal(ports.length,1);
 return {port:ports[0],ports,chrome,context,store,get queryCount(){return queryCount;},get queryArg(){return queryArg;},driver:driverInstance};
}
function probe(port,id='lease-1042',url=probeURL){port.onMessage.fire({kind:'install_probe',id,url,deadline:Date.now()+50000});}
async function authorize(port,id,allowed=true){await until(()=>port.posted.some(x=>x.kind==='install_authorize'&&x.id===id));port.onMessage.fire({kind:'install_authorization',id,allowed});}
async function result(port,id){await until(()=>port.posted.some(x=>x.kind==='install_result'&&x.id===id));return port.posted.findLast(x=>x.kind==='install_result'&&x.id===id);}

test('install_probe 只读唯一普通 exact URL tab，标题与身份来自 query 结果',async()=>{
 const url=probeURL;
 const f=await backgroundFixture([{id:73,windowId:18,url,title:'actual fixture title',incognito:false},{id:99,windowId:20,url:'http://127.0.0.1:43127/unrelated',title:'unrelated',incognito:false}]);
 probe(f.port,'lease-ok',url);await authorize(f.port,'lease-ok');const out=await result(f.port,'lease-ok');
 assert.deepEqual(JSON.parse(JSON.stringify(out)),{kind:'install_result',id:'lease-ok',result:{title:'actual fixture title',tab_id:73,window_id:18}});
 assert.equal(f.queryCount,1);assert.equal(Object.keys(f.queryArg).length,0);
 assert.equal(f.driver.executions,0);
 assert.deepEqual(JSON.parse(JSON.stringify(f.port.posted.filter(x=>x.kind==='install_authorize'))),[{kind:'install_authorize',id:'lease-ok'}]);
});

test('install_probe 对零/多 tab 与 incognito 只发固定错误',async()=>{
 for(const [tabs,code] of [
  [[], 'INSTALL_TAB_NOT_FOUND'],
  [[{id:1,windowId:2,url:probeURL,title:'one',incognito:false},{id:3,windowId:4,url:probeURL,title:'two',incognito:false}], 'INSTALL_TAB_NOT_UNIQUE'],
  [[{id:5,windowId:6,url:probeURL,title:'private',incognito:true}], 'INSTALL_TAB_INCOGNITO']
 ]){
  const f=await backgroundFixture(tabs);probe(f.port,'lease-'+code);await authorize(f.port,'lease-'+code);const out=await result(f.port,'lease-'+code);
  assert.deepEqual(JSON.parse(JSON.stringify(out)),{kind:'install_result',id:'lease-'+code,error:code});assert.equal(f.driver.executions,0);
 }
});

test('授权拒绝不查询或返回成功；普通 runtime 消息不能启动 probe',async()=>{
 const f=await backgroundFixture([{id:1,windowId:2,url:probeURL,title:'fixture',incognito:false}]);
 f.chrome.runtime.onMessage.fire({kind:'install_probe',id:'ordinary',url:probeURL,deadline:Date.now()+50000},{id:'ext',url:'chrome-extension://ext/popup.html'},()=>{});
 for(const [id,url,deadline] of [
  ['bad-path','http://127.0.0.1:43127/install/nonce',Date.now()+50000],
  ['search',probeURL+'?x=1',Date.now()+50000],
  ['credentials',probeURL.replace('http://','http://user@'),Date.now()+50000],
  ['long-deadline',probeURL,Date.now()+130000]
 ])f.port.onMessage.fire({kind:'install_probe',id,url,deadline});
 await flush();assert.equal(f.queryCount,0);assert.equal(f.port.posted.some(x=>x.kind==='install_authorize'),false);
 probe(f.port,'lease-denied');await authorize(f.port,'lease-denied',false);const out=await result(f.port,'lease-denied');
 assert.deepEqual(JSON.parse(JSON.stringify(out)),{kind:'install_result',id:'lease-denied',error:'INSTALL_AUTHORIZATION_DENIED'});assert.equal(f.queryCount,0);
});

test('取消或断开在 query 等待中生效，不发迟到结果',async()=>{
 for(const disconnect of [false,true]){
  let releaseQuery,queryStarted;const started=new Promise(resolve=>{queryStarted=resolve;});
  const f=await backgroundFixture(()=>{queryStarted();return new Promise(resolve=>{releaseQuery=resolve;});});
  probe(f.port,disconnect?'lease-disconnect':'lease-cancel');await authorize(f.port,disconnect?'lease-disconnect':'lease-cancel');await started;
  if(disconnect)f.port.onDisconnect.fire();else f.port.onMessage.fire({control:'pause'});
  releaseQuery([{id:1,windowId:2,url:probeURL,title:'late title',incognito:false}]);await flush();
  assert.equal(f.port.posted.some(x=>x.kind==='install_result'),false);
 }
});

test('hostSource 使用 canonical runtime、package build 与入口字节 hash，拒绝 symlink',t=>{
 const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'chathand-1042-host-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'app/v09'),{recursive:true});
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({kenBridge:{build_number:1042}}));
 const sourcePath=path.join(root,'app/v09/extension-host.mjs'),entryPath=path.join(dir,'app/v09/extension-host.mjs');fs.copyFileSync(sourcePath,entryPath);
 const actual=hostSource(dir);
 assert.deepEqual(actual,{runtime_root:dir,build:1042,entry_sha256:crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')});
 const reported=cleanHelper({build:1,source:'/attacker',host_source:{runtime_root:'/attacker',build:999,entry_sha256:'f'.repeat(64)}});assert.equal(reported.host_source,undefined);assert.equal(reported.source,undefined);
 const alias=path.join(base,`chathand-1042-alias-${crypto.randomUUID()}`);fs.symlinkSync(dir,alias);t.after(()=>fs.rmSync(alias,{force:true}));assert.throws(()=>hostSource(alias),/HOST_SOURCE_PATH_INVALID/);
 const linkedEntry=path.join(base,`chathand-1042-entry-${crypto.randomUUID()}`);fs.mkdirSync(path.join(linkedEntry,'app/v09'),{recursive:true});fs.writeFileSync(path.join(linkedEntry,'package.json'),JSON.stringify({kenBridge:{build_number:1042}}));fs.symlinkSync(sourcePath,path.join(linkedEntry,'app/v09/extension-host.mjs'));t.after(()=>fs.rmSync(linkedEntry,{recursive:true,force:true}));assert.throws(()=>hostSource(linkedEntry),/HOST_SOURCE_PATH_INVALID/);
});

test('host routes install messages and attaches host-owned source on every next poll',()=>{
 const source=fs.readFileSync(path.join(root,'app/v09/extension-host.mjs'),'utf8');
 assert.match(source,/\/api\/extension\/install-authorize/);assert.match(source,/\/api\/extension\/install-result/);
 assert.match(source,/host_source:hostSource\(root\)/);assert.doesNotMatch(source,/message\.host_source|message\.source/);
});
