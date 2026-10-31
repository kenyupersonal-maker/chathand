import {storeTestDistribution,manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';
// 1050 UI wiring delta: only simulated update-card and isolated local management handler.
// No real Chrome, ChatGPT, credentials, app build, production connection or tool refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createDesktop,needsInterface} from '../../app/server.mjs';
import {PLUGINS_URL} from '../../app/v1/tools-refresh.mjs';

const UI_KEY='cd'.repeat(32);
const ROUTE='/api/refresh/return-existing-tab';
const detail=PLUGINS_URL+'/plugin_test';
const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
const template=source.slice(source.indexOf('const REFRESH_HELPER_STATES='),source.indexOf('function paintBubble(){'));
const figure='<svg data-refresh-figure="true"></svg>';
const textRuntime=fs.readFileSync(new URL('../../ui/local-text.js',import.meta.url),'utf8');
const textCatalogs=Object.fromEntries(['zh','en'].map(locale=>[locale,JSON.parse(fs.readFileSync(new URL("../../locales/"+locale+'.json',import.meta.url),'utf8'))]));
const active=(page)=>({state:'needs_user',clicked:true,confirmation:'pending',message:'ChatGPT 在等你确认新工具',url:detail,detail_url:detail,bring_existing_tab:{action:'select',page_id:page,show:true,requires_user_request:true}});

function renderBubble(state,{inApp=true,toolsChanged=true}={}){
 const ctx={S:{version:'1.0.0-beta.4',tools_refresh:state},IN_APP:inApp,bubbleHidden:new Set(),E:x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;'),upd:()=>({status:'updated',refresh_tools:toolsChanged,current_build:1050,just_updated:{to:'1.0.0-beta.4',build_to:1050}}),adminNeedsSetup:()=>false,refreshToolsFigure:()=>figure,btn:(label,act)=>'<button data-action="'+act+'">'+label+'</button>'};
 ctx.window=ctx;ctx.__CHATHAND_TEXT_CATALOGS__=textCatalogs;
 vm.createContext(ctx);vm.runInContext(textRuntime,ctx);
 vm.runInContext(source.match(/^const T=.*$/m)[0]+'\n'+source.match(/^const TH=.*$/m)[0],ctx);
 vm.runInContext(template,ctx);return vm.runInContext('bubbleHTML()',ctx);
}
test('existing update bubble shows exact confirmation and native-only return button without page ID in HTML',()=>{
 const state=active('test-epoch:41'),html=renderBubble(state);
 assert.match(html,/ChatGPT 正在等待你确认新工具/);assert.match(html,/回到原页面/);
 assert.match(html,/data-action="returnExistingRefreshTab"/);
 assert.doesNotMatch(html,/data-action="openRefreshTools"|data-refresh-figure/);
 assert.doesNotMatch(html,/test-epoch|plugin_test/);
 assert.doesNotMatch(renderBubble(state,{inApp:false}),/data-action="returnExistingRefreshTab"/);
 assert.doesNotMatch(renderBubble({...state,clicked:false}),/data-action="returnExistingRefreshTab"/);
 assert.doesNotMatch(renderBubble({...state,bring_existing_tab:null}),/data-action="returnExistingRefreshTab"/);
 assert.ok(source.includes("case'returnExistingRefreshTab':{if(!IN_APP)return;const r=await api('/api/refresh/return-existing-tab',{});"),'click action must POST empty body to UI-only handler');
});
test('unverified / delivery unknown / host error have no second-refresh links or diagram; unknown is neutral',()=>{
 for(const name of ['unverified','dispatch_unconfirmed','host_error']){
  const html=renderBubble({state:name,clicked:true,message:'保留原标签页，勿再刷新'});
  assert.match(html,/工具刷新未完成.*请前往已打开的 ChatGPT 标签页，手动点击「刷新工具」/);if(name==='host_error')assert.match(html,/ChatGPT 页面出错/);assert.doesNotMatch(html,/data-action="openRefreshTools"|data-refresh-figure|data-action="returnExistingRefreshTab"/);
 }
 const unknown=renderBubble({state:'unknown'});
 assert.match(unknown,/工具尚未刷新。请在 ChatGPT 插件页中点击「刷新工具」/);assert.doesNotMatch(unknown,/新工具能用了|data-action="openRefreshTools"|data-refresh-figure/);
 const running=renderBubble({state:'running',waiting:'tools_list'});assert.match(running,/正在 ChatGPT 中刷新工具/);
 const manual=renderBubble({state:'not_found',clicked:false,message:'没认准按钮'});assert.match(manual,/data-action="openRefreshTools"/);
});

async function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1050-refresh-ui-'))),work=path.join(root,'work');
 fs.mkdirSync(work);
 const control={value:{state:'idle'}},fake={snapshot:()=>structuredClone(control.value),run:async()=>{throw Error('UNEXPECTED_TOOLS_REFRESH_RUN');},clickByNumber:async()=>{throw Error('UNEXPECTED_TOOLS_REFRESH_CLICK');}};
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:UI_KEY,clientDeps:{chromeDistribution:storeTestDistribution(),
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic 1050',
  toolsRefreshFactory:()=>fake,
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1050,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await app.handle('/api/access',{enabled:true});
 await app.handle('/api/mode',{mode:'full',confirm:true});
 await app.handle('/api/settings',{browser_enabled:true});
 const ext=app.tools.automation.browser.extension;
 const session='22222222-2222-4222-8222-222222222222';ext.heartbeat(session);ext.noteHelper(session,manifestStoreTestHelper());
 const page=ext.epoch+':41';control.value=active(page);
 const requests=[];
 const post=async(body={},withKey=true)=>{
  const headers={'authorization':'Bearer '+app.adminToken,'content-type':'application/json',...(withKey?{'x-chathand-ui':UI_KEY}:{})};
  const response=await fetch('http://127.0.0.1:'+app.apiPort+ROUTE,{method:'POST',headers,body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 return {app,ext,page,control,post,requests};
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('isolated extension action did not enter the pending queue');}

test('real isolated HTTP UI-only route selects exactly its server-owned existing tab',async t=>{
 const f=await fixture(t);
 assert.equal(needsInterface(ROUTE,{}),true);
 await t.test('missing native UI key is forbidden before any browser or task action',async()=>{
  const before=f.app.policy.tasks.size,r=await f.post({},false);
  assert.equal(r.status,403);assert.equal(r.body.error.code,'UI_CONFIRM_REQUIRED');
  assert.equal(f.ext.pending.size,0);assert.equal(f.app.policy.tasks.size,before);
 });
 await t.test('client page_id, URL and arbitrary fields are rejected even with window UI key',async()=>{
  for(const extra of [{page_id:f.page},{url:detail},{action:'new'},{page_id:'forged',url:'https://example.com'}]){
   const before=f.app.policy.tasks.size,r=await f.post(extra);
   assert.notEqual(r.status,200);assert.equal(r.body.error.code,'ARG_INVALID');
   assert.equal(f.ext.pending.size,0);assert.equal(f.app.policy.tasks.size,before);
  }
 });
 await t.test('missing confirmed state or unbound URL refuses without touching Chrome',async()=>{
  const valid=f.control.value;
  for(const bad of [{...valid,state:'unverified'},{...valid,clicked:false},{...valid,confirmation:'unknown'},{...valid,url:'https://evil.example/path'},{...valid,detail_url:'https://evil.example/path'},{...valid,bring_existing_tab:{...valid.bring_existing_tab,action:'new'}}]){
   f.control.value=bad;const r=await f.post({});
   assert.notEqual(r.status,200);assert.equal(r.body.error.code,'REFRESH_TAB_UNAVAILABLE');assert.equal(f.ext.pending.size,0);
  }
  f.control.value=valid;
 });
 await t.test('synthetic extension delivery uses exact managed page, show true; never new/navigate/refresh',async()=>{
  // Simulate the Chrome-helper handshake wholly within this isolated createDesktop fixture.
  const session='22222222-2222-4222-8222-222222222222';f.ext.heartbeat(session);f.ext.noteHelper(session,manifestStoreTestHelper());
  const epoch=f.app.policy.epoch,enabled=f.app.state.data.browser_enabled;
  let early=null;const promise=f.post({}).then(r=>{early=r;return r;});
  await until(()=>f.ext.pending.size===1||early!==null);
  assert.equal(early,null,'handler ended before extension selection: '+JSON.stringify(early));
  const helper=manifestStoreTestHelper();
  const first=f.ext.next(session,helper,'synthetic-helper');
  assert.ok(!first.control||first.control==='pause','session initialization may require one safe pause before dispatch');
  const req=first.control==='pause'?f.ext.next(session,helper,'synthetic-helper'):first;
  assert.equal(req.kind,'request');assert.equal(req.action,'select');
  assert.equal(req.args.page_id,'41');assert.equal(req.args.show,true);assert.equal(req.args.allow_personal,false);
  assert.equal(req.options.chatgptSelfAllowed,true,'UI-only internal selection still uses the ordinary policy/owner gates');
  const auth=f.ext.authorize(session,req.id);assert.equal(auth.authorized,true);
  f.ext.complete(session,req.id,{selected:true,shown:true,page_id:'41'});
  const r=await promise;
  assert.equal(r.status,200);assert.deepEqual(r.body,{selected:true,shown:true});
  assert.equal(f.ext.pending.size,0);assert.equal(f.app.policy.epoch,epoch);assert.equal(f.app.state.data.browser_enabled,enabled);
  assert.equal(f.control.value.bring_existing_tab.page_id,f.page);
  const returns=[...f.app.policy.tasks.values()].filter(task=>task.title==='回到已有 ChatGPT 页面');
  assert.equal(returns.length,1);assert.equal(returns[0].status,'completed');
 });
 await t.test('expired extension epoch does not open another tab or replay selection',async()=>{
  // The page identity is stale; no Chrome helper round-trip is possible.
  const old=f.control.value;f.control.value=active('00000000-0000-4000-8000-000000000000:41');
  const r=await f.post({});assert.notEqual(r.status,200);assert.equal(r.body.error.code,'BROWSER_PAGE_MISSING');assert.equal(f.ext.pending.size,0);
  f.control.value=old;
 });
 await t.test('if return-state changes during the new task, selection is not dispatched',async()=>{
  const original=f.app.tools.invoke.bind(f.app.tools),old=f.control.value;
  f.app.tools.invoke=async(...args)=>{const result=await original(...args);if(args[0]==='begin_task')f.control.value={state:'unverified'};return result;};
  try{const r=await f.post({});assert.notEqual(r.status,200);assert.equal(r.body.error.code,'REFRESH_TAB_UNAVAILABLE');assert.equal(f.ext.pending.size,0);}finally{f.app.tools.invoke=original;f.control.value=old;}
 });
});

// Exercise real isolated revocation transitions, never override either production guard.
// Only the synthetic browser shutdown response is controllable within this fixture.
test('permission transition rejects return-existing-tab before begin_task and browser pending (parameterized)',async t=>{
 for(const mode of ['permissionChangePending','permissionRevocations.blocked']){
  const f=await fixture(t),browser=f.app.tools.automation.browser;
  const originalStop=browser.closeAll,originalInvoke=f.app.tools.invoke;
  let markEntered,releaseStop,beginCalls=0;
  const entered=new Promise(resolve=>{markEntered=resolve;});
  const hold=new Promise(resolve=>{releaseStop=resolve;});
  browser.closeAll=async function(...args){
   markEntered();
   await hold;
   if(mode==='permissionRevocations.blocked')throw Object.assign(Error('synthetic browser stop unconfirmed'),{code:'SYNTHETIC_STOP_UNCONFIRMED'});
   return originalStop.apply(this,args);
  };
  f.app.tools.invoke=async function(name,...args){if(name==='begin_task')beginCalls++;return originalInvoke.call(this,name,...args);};
  const revoke=f.app.handle('/api/permissions/revoke',{gate:'capability',id:'browser'}).then(value=>({ok:true,value}),error=>({ok:false,code:error?.code}));
  let ended;
  try{
   await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('isolated revocation never entered browser stop')),2000))]);
   if(mode==='permissionRevocations.blocked'){
    releaseStop();releaseStop=null;
    ended=await revoke;
    assert.equal(ended.ok,false,'synthetic stop must genuinely enter revocation recovery');
    assert.equal(ended.code,'SYNTHETIC_STOP_UNCONFIRMED');
    assert.equal(f.app.policy.transitioning,true,'blocked recovery keeps the real policy transition fence armed');
   }else{
    assert.equal(f.app.policy.transitioning,true,'real permission transaction is still pending');
   }
   const taskCount=f.app.policy.tasks.size,pendingCount=f.ext.pending.size;
   const response=await f.post({});
   assert.notEqual(response.status,200,mode);
   assert.equal(response.body.error.code,'PERMISSION_TRANSITION',mode);
   assert.equal(f.app.policy.tasks.size,taskCount,mode+': no new task');
   assert.equal(beginCalls,0,mode+': begin_task never dispatched');
   assert.equal(f.ext.pending.size,pendingCount,mode+': no browser action enqueued');
   assert.equal(pendingCount,0,mode+': no browser request before test');
  }finally{
   if(releaseStop)releaseStop();
   const result=ended||await revoke;
   browser.closeAll=originalStop;
   f.app.tools.invoke=originalInvoke;
   if(mode==='permissionChangePending')assert.equal(result.ok,true,'pending isolated revocation completed');
  }
 }
});
