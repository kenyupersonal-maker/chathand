import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
class ExtensionBrowser extends ProductionExtensionBrowser {constructor(state,store,policy){super(state,store,policy,{distribution:legacyChromeDistribution()});}}
import {text, setSystemLanguage, languageState} from '../browser-extension/locale.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {extensionVersion} from '../scripts/generate-version.mjs';
import {frame,FrameReader} from '../app/v09/extension-host.mjs';
import {ExtensionBrowser as ProductionExtensionBrowser} from '../app/v09/extension-browser.mjs';
import {t as translate} from '../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'browser-extension/manifest.json'),'utf8'));

function event(){const listeners=[];return {addListener(fn){listeners.push(fn);},fire(...args){return listeners.map(fn=>fn(...args));}};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));}

test('extensionVersion 与商店 manifest 的独立版本内部一致',()=>{
 assert.deepEqual(extensionVersion({version:'1.0.0-beta.4',kenBridge:{build_number:1029}}),{version:'1.0.0.1029',version_name:'1.0.0-beta.4 (1029)'});
 const named=/^(\d+\.\d+\.\d+(?:-[\w.]+)?) \(([1-9]\d*)\)$/.exec(manifest.version_name);
 assert.ok(named,'manifest version_name carries its own release and build');
 assert.equal(manifest.version,`${named[1].split('-')[0]}.${named[2]}`);
});

test('background hello 报 helper，reload 两分钟内只做一次并记 from/to',async()=>{
 const source=fs.readFileSync(path.join(root,'browser-extension/background.js'),'utf8').replace(/^import .*;\n/gm,'');
 class FakeDriver{constructor(){this.attached=new Set();}async detachAll(){}invalidate(){}noteDetached(){}}
 const onInstalled=event(),onStartup=event(),onMessage=event(),onAlarm=event(),onRemoved=event(),onUpdated=event(),onDetach=event(),onDebug=event();
 const ports=[];let reloads=0;
 const store={enabled:true};
 const chrome={
  runtime:{id:'ext',lastError:null,getURL:n=>'chrome-extension://ext/'+n,getManifest:()=>({version:'1.0.0.1029',version_name:'1.0.0-beta.4 (1029)'}),reload(){reloads++;},connectNative(){const p={posted:[],onDisconnect:event(),onMessage:event(),postMessage(m){this.posted.push(m);},disconnect(){}};ports.push(p);return p;},onInstalled,onStartup,onMessage},
  storage:{local:{async get(keys){if(typeof keys==='string')return {[keys]:store[keys]};const out={};for(const k of keys||[])if(Object.hasOwn(store,k))out[k]=store[k];return out;},async set(v){Object.assign(store,v);}}},
  action:{async setBadgeText(){}},alarms:{create(){},onAlarm},tabs:{onRemoved,onUpdated},debugger:{onDetach,onEvent:onDebug}
 };
 const context={text,setSystemLanguage,languageState,chrome,BrowserDriver:FakeDriver,setTimeout,clearTimeout,Date,Promise,console};
 vm.runInNewContext(source,context,{filename:'background.js'});
 await flush();
 assert.equal(ports.length,1);
 const hello=ports[0].posted[0];
 assert.equal(hello.kind,'hello');assert.equal(hello.version,1);assert.equal(hello.enabled,true);
 assert.equal(hello.helper.version,'1.0.0.1029');assert.equal(hello.helper.build,1029);assert.ok(hello.helper.features.includes('self_reload'));
 ports[0].onMessage.fire({control:'reload',expected_version:'1.0.0.1030'});await flush();
 assert.equal(reloads,1);assert.equal(store.helper_reload.from,'1.0.0.1029');assert.equal(store.helper_reload.to,'1.0.0.1030');
 ports[0].onMessage.fire({control:'reload',expected_version:'1.0.0.1030'});await flush();
 assert.equal(reloads,1);
});

test('native host 把 helper 放进 next 正文，丢弃旧 reload 后仍转发正常 status',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-helper-host-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'connectors/browser-extension.json'),'utf8'));
 const token='a'.repeat(64),seen=[],frames=[];let nextReplies=0;
 let resolveBody,resolveFrame;
 const bodyP=new Promise(r=>resolveBody=r),frameP=new Promise(r=>resolveFrame=r);
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};seen.push({url:req.url,body});if(req.url==='/api/extension/next'){resolveBody(body);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(++nextReplies===1?{control:'reload'}:{kind:'status',ready:true}));return;}res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const origin=`http://127.0.0.1:${server.address().port}`;
 fs.writeFileSync(path.join(dir,'browser-extension-runtime.json'),JSON.stringify({origin,token,extension_id:cfg.extension_id}));
 const child=spawn(process.execPath,[path.join(root,'app/v09/extension-host.mjs'),`chrome-extension://${cfg.extension_id}/`],{cwd:root,env:{...process.env,CHATHAND_STATE_DIR:dir},stdio:['pipe','pipe','pipe']});
 t.after(()=>{if(!child.killed)child.kill('SIGTERM');});
 const reader=new FrameReader(v=>{frames.push(v);resolveFrame(v);});child.stdout.on('data',b=>reader.push(b));
 child.stdin.write(frame({kind:'hello',version:1,enabled:true,helper:{version:'1.0.0.1029',build:1029,features:['self_reload']}}));
 const body=await Promise.race([bodyP,new Promise((_,rej)=>setTimeout(()=>rej(Error('HOST_BODY_TIMEOUT')),4000))]);
 assert.equal(body.helper.version,'1.0.0.1029');assert.equal(body.helper.build,1029);
 const out=await Promise.race([frameP,new Promise((_,rej)=>setTimeout(()=>rej(Error('HOST_FRAME_TIMEOUT')),4000))]);
 assert.equal(out.kind,'status');assert.equal(out.ready,true);assert.ok(nextReplies>=2);assert.equal(frames.some(value=>value.control==='reload'),false);
 child.kill('SIGTERM');
});

function fixture(){const state={data:{mode:'auto',browser_enabled:true},project:()=>({path:'/tmp/测试工作区'}),save(){}},policy={epoch:'epoch',fullArmed:false,check(){},tasks:new Map([['task',{status:'active'}]]),require(task){if(task!=='task')throw Object.assign(Error('revoked'),{code:'TASK_REVOKED'});},emit(){}},ext=new ExtensionBrowser(state,{},policy);return {state,policy,ext};}
const sid=()=>crypto.randomUUID();

test('ExtensionBrowser 报 outdated/reloading/wrong_folder/current/stale 并能读 expected manifest',async t=>{
 const f=fixture();t.after(()=>f.ext.closeAll());f.ext.expected={version:'1.0.0.1030',build:1030,folder:'/Applications/ChatHand.app/Contents/Resources/runtime/browser-extension'};
 const s1=sid();f.ext.next(s1);assert.equal(f.ext.status().helper.state,'outdated');
 const reload=f.ext.next(s1,{version:'1.0.0.1029',build:1029,features:['self_reload']});assert.deepEqual(reload,{control:'reload',expected_version:'1.0.0.1030',expected_build:1030});assert.equal(f.ext.status().helper.state,'reloading');
 assert.notDeepEqual(f.ext.next(s1,{version:'1.0.0.1029',features:['self_reload']}),reload);
 const s2=sid();f.ext.next(s2,{version:'1.0.0.1029',build:1029,features:['self_reload']});assert.equal(f.ext.status().helper.state,'wrong_folder');assert.match(f.ext.status().helper.message,/browser-extension/);
 const s3=sid();f.ext.next(s3,{version:'1.0.0.1030',build:1030,features:['self_reload']});assert.equal(f.ext.status().helper.state,'current');

 const g=fixture();t.after(()=>g.ext.closeAll());g.ext.expected={version:'1.0.0.1030',build:1030,folder:'/x'};const sg=sid();g.ext.heartbeat(sg);g.ext.pauseRequested=false;g.ext.noteHelper(sg,{version:'1.0.0.1029',build:1029,features:['self_reload']});
 const pending=g.ext.request('snapshot',{},'caller','task');pending.catch(()=>{});
 const req=g.ext.next(sg,{version:'1.0.0.1029',build:1029,features:['self_reload']});assert.equal(req.kind,'request');assert.equal(g.ext.status().helper.state,'stale');g.ext.cancelAll();

 const h=fixture();t.after(()=>h.ext.closeAll());const expected=h.ext.expectedHelper();assert.equal(expected.version,manifest.version);
});

test('UI 显示助手更新状态和版本',()=>{
 const source=fs.readFileSync(path.join(root,'ui/app.js'),'utf8');
 for(const [key,text] of [['ui.window.capBrowser.res.text4','Chrome 插件版本过旧，请重新加载'],['ui.window.pgBrowser.text4','插件版本']]){assert.ok(source.includes(key),key);assert.equal(T(key),text);}
});
