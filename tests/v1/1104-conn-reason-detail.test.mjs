// 1104（Claude，Ken 11/04）：外面写概况，里面写原因。
// OpenAI 通道连不上网时，首页卡片写「无法连接」+「请检查网络或代理设置」；连接详情也是无法连接（不退成灰的「未连接」），写全原因。
// 网络这种可能自己好，任务列表顶上不另挂一条。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {connectionDisplay} from '../../app/v1/connection-display.mjs';
const P=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const app=fs.readFileSync(path.join(P,'ui/app.js'),'utf8');
const zh=JSON.parse(fs.readFileSync(path.join(P,'locales/zh.json'),'utf8')),en=JSON.parse(fs.readFileSync(path.join(P,'locales/en.json'),'utf8'));
const between=(src,a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i,`${a} … ${b}`);return src.slice(i,j);};

function box(proxy,{selected='openai',state='down'}={}){
 const S={connection:{automatic:{phase:'offline'},control_plane:{state,proxy}},relay:{online:false},repair:null};
 const ctx=vm.createContext({S,T:k=>k,cloud:()=>S.connection.control_plane,selectedConnection:()=>selected,connState:()=>'offline',connected:()=>false,
  openaiLive:()=>false,siteBlock:()=>null,siteHealthy:()=>false,siteWhy:()=>'site',siteBlockText:()=>'blocked'});
 vm.runInContext(between(app,'function offlineReason(','// 1069（Claude）：Site 被拦住')+between(app,'function routeStatus(','// Site 连不上时说哪里不对'),ctx);
 return ctx;
}

test('detail is broken with the full reason; home gets the short one',()=>{
 const c=box('direct');
 assert.deepEqual({...c.routeStatus('openai')},{st:'broken',why:'ui.window.offlineReason.text2',soft:true});
 assert.equal(c.offlineReason(true),'ui.window.offlineReason.text3');
 assert.equal(box('system').routeStatus('openai').why,'ui.window.offlineReason.text3');
 assert.ok(/sub:site\?T\("ui\.window\.connModel\.sub\.text7"\):offlineReason\(true\)/.test(app),'home card asks for the short reason');
});

test('a network outage does not add a strip above the tasks',()=>{assert.equal(box('direct').stripBroken(),'');});

test('the standby tunnel stays idle when Site is in use',()=>{assert.equal(box('direct',{selected:'site'}).routeStatus('openai').st,'idle');});

test('the reasons do not repeat the title, and the long one stays in the detail',()=>{
 for(const k of ['ui.window.offlineReason.text2','ui.window.offlineReason.text3']){assert.doesNotMatch(zh[k],/OpenAI 通道/,k);assert.doesNotMatch(en[k],/OpenAI Tunnel/,k);}
 assert.ok(zh['ui.window.offlineReason.text3'].length<=12,'fits the home card line');
});

function liveBox({proxy='direct',phase='ready',error_code=null,state='down',local=true,enabled=true,userPaused=false}={}){
 const connection={process_running:local,healthy:local,ready:local,control_plane:{state,proxy},automatic:{phase,error_code}};
 connection.display=connectionDisplay(connection);
 const S={connection,relay:{online:false},repair:null,enabled,settings:{access_enabled:!userPaused}};
 const T=(k,p={})=>(zh[k]||k).replace(/\{(\w+)\}/g,(_,name)=>p[name]??'');
 const ctx=vm.createContext({S,T,cloud:()=>S.connection.control_plane,selectedConnection:()=> 'openai',connState:()=> 'offline',connected:()=>false,openaiLive:()=>false,
  siteBlock:()=>null,siteHealthy:()=>false,siteWhy:()=>'',siteBlockText:()=>'',upgrading:()=>false,routeLastCall:()=>null,appMissing:()=>false,btn:()=>'',tbtn:()=>'',timed:()=>'',ago:()=>'',connRes:(tone,title,sub)=>({tone,title,sub}),
  loadChanges:()=>{},isWaiting:()=>false,chatTitle:()=>'',isRefreshTask:()=>false,E:String,valueTaskMeta:()=>'',taskState:()=>({key:'run',cls:'run',dot:'',label:''}),TH:T,fullStop:s=>s+'。',taskNote:()=>'',taskBlocker:()=>'',taskContent:()=>'',icon:()=>''});
 vm.runInContext(between(app,'function offlineReason(','// 1069（Claude）：Site 被拦住')+between(app,'function openaiReason(','// Site 连不上时说哪里不对')+between(app,'function paused(){','function cloud(){')+between(app,'function connModel(','const statDot=')+between(app,'function taskParts(t){','function waitBlock(t)')+between(app,'function connUseRes(r){','function connUseWhy(r)'),ctx);
 return ctx;
}

test('live connection display reports the same network outage on home and in details',()=>{
 for(const proxy of ['direct','http://127.0.0.1:7890']){
  const c=liveBox({proxy}),home=c.connModel(),detail=c.routeStatus('openai');
  assert.equal(home.label,'无法连接');assert.equal(home.sub,'请检查网络或代理设置');assert.equal(home.dot,'warn');
  assert.equal(detail.st,'broken');assert.equal(detail.soft,true);assert.equal(detail.why,proxy==='direct'?'请检查网络；如使用代理，请检查代理状态':'请检查网络或代理设置');assert.equal(c.stripBroken(),'');assert.equal(c.taskParts({task_id:'test'}).banner,'');
 }
});

test('a network retry failure is distinct from an authentication failure or an idle connection',()=>{
 const retry=liveBox({local:false,phase:'needs_retry',error_code:'CONNECTION_UNAVAILABLE'});
 assert.equal(retry.connModel().label,'无法连接');assert.equal(retry.connModel().sub,'请检查网络或代理设置');assert.equal(retry.stripBroken(),'');
 const auth=liveBox({local:false,phase:'needs_login',error_code:'CONNECTION_AUTH_FAILED'});
 assert.equal(auth.connModel().label,'连接信息未通过验证');assert.equal(auth.routeStatus('openai').soft,undefined);assert.notEqual(auth.stripBroken(),'');assert.notEqual(auth.taskParts({task_id:'test'}).banner,'');
 const idle=liveBox({local:false,phase:'idle',state:'unknown'});assert.equal(idle.routeStatus('openai').st,'idle');
});

test('a long outage keeps the same explanation after access is held, while user pause stays visible',()=>{
 for(const enabled of [true,false]){
  const c=liveBox({enabled}),home=c.connModel();
  assert.equal(home.label,'无法连接');assert.equal(home.sub,'请检查网络或代理设置');
  assert.equal(c.routeStatus('openai').why,'请检查网络；如使用代理，请检查代理状态');
  assert.equal(c.connUseRes('openai'),null,'detail continues to show the full failure reason');
  assert.equal(c.taskParts({task_id:'test'}).banner,'');
 }
 const paused=liveBox({enabled:false,userPaused:true});
 assert.equal(paused.connModel().label,zh['ui.window.connModel.label.text2']);
 assert.equal(paused.connUseRes('openai').title,zh['ui.window.connModel.label.text2']);
 assert.notEqual(paused.taskParts({task_id:'test'}).banner,'');
});

test('a held authentication or storage error keeps its own reason',()=>{
 for(const [phase,error_code,title,detail] of [
  ['needs_login','CONNECTION_AUTH_FAILED','连接信息未通过验证','请检查密钥与通道权限。'],
  ['needs_retry','CREDENTIAL_SAVE_FAILED','连接信息保存失败','请检查本机存储后重试。']
 ]){
  const c=liveBox({local:false,phase,error_code,enabled:false});
  assert.equal(c.connModel().label,title);assert.equal(c.connModel().sub,detail);
  assert.equal(c.connUseRes('openai'),null);assert.match(c.routeStatus('openai').why,new RegExp(title));
  assert.match(c.taskParts({task_id:'test'}).banner,new RegExp(title));
  const paused=liveBox({local:false,phase,error_code,enabled:false,userPaused:true});
  assert.equal(paused.connModel().label,zh['ui.window.connModel.label.text2']);
 }
});
