import {refreshExpected,refreshProof} from '../support/refresh-proof.mjs';
// 1028：「刷新工具」照真页面的样子再走一遍（Ken 10/7 的 ChatGPT 插件页：名字、说明、权限连在一个按钮名里；
// 点进 ChatHand 后列表还在，旁边多了 ChatHand 的设置、操作两个按钮）。没成时要说清卡在哪一步。
import vm from 'node:vm';
import {t as translate} from '../../app/i18n.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {ToolsRefresher,PLUGINS_URL,APPS_URLS,STEP_WORDS} from '../../app/v1/tools-refresh.mjs';
import {Tools} from '../../app/tools.mjs';
import {storeTestDistribution,manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';

const DETAIL=PLUGINS_URL+'/plugin_asdk_app_test';
const IDENTITY={app_id:'plugin_asdk_app_test',detail_url:DETAIL,app_name:'ChatHand'};
const LIST=[
 {ref:'t0',role:'heading',name:'插件'},
 {ref:'p0',role:'button',name:'允许使用低风险工具'},
 {ref:'p1',role:'button',name:'ChatHand ChatHand 允许使用所有工具'},
 {ref:'p2',role:'button',name:'Figma Create designs, ship to code 允许使用低风险工具'},
 {ref:'p3',role:'button',name:'Remote Desktop Commander Build and automate, anywhere 允许使用所有工具'},
];
const DETAIL_ITEMS=[
 {ref:'d0',role:'link',name:'查看详情'},{ref:'d1',role:'button',name:'卸载'},
 {ref:'d2',role:'button',name:'ChatHand（未关联账户） 的设置'},{ref:'d3',role:'button',name:'ChatHand（未关联账户） 的操作'},
 {ref:'d4',role:'button',name:'编辑'},{ref:'d5',role:'button',name:'编辑'},{ref:'d6',role:'button',name:'刷新工具'},{ref:'d7',role:'button',name:'删除应用'},
];
function chatgpt({list=LIST,refetch=true,waitErrors=0,openError=null,waitFatal=null,identity=IDENTITY,emptyReads=0}={}){
 // Explicit binding is reserved for single-app scenarios, not name-selection tests.
 list=list.map(x=>identity&&x.ref==='p1'?{...x,app_id:identity.app_id,href:identity.detail_url}:x);
 const p={identity,calls:[],seen:[],url:null,closed:false,clicked:[],now:1_000,waitErrors,emptyReads,findErrorsConsumed:0,emptyReadsConsumed:0};
 const elements=()=>p.url===DETAIL?[...list,{ref:'h1',role:'heading',name:'ChatHand'},...DETAIL_ITEMS]:p.url===PLUGINS_URL?list:[];
 p.invoke=async(name,args)=>{p.calls.push([name,args]);
  if(name==='browser_status')return {selected_backend:'extension',extension:{connected:true,helper:manifestStoreTestHelper(),compatibility:{state:'compatible'}}};
  if(name==='begin_task')return {task_id:'task_refresh'};
  if(name==='finish_task')return {};
  if(name==='browser_open'){if(openError)throw Object.assign(Error(openError.message),{code:openError.code});p.url=args.url===APPS_URLS[1]?PLUGINS_URL:args.url;return {page_id:'ep:1'};}
  if(name==='browser_snapshot')return {url:p.url,frames_truncated:false,ax_nodes_truncated:false,unsupported_frames:[],aria_yaml:'- heading 插件'};
  if(name==='browser_wait_for'){if(!elements().some(x=>x.name.includes(args.condition.text)))throw Object.assign(Error('WAIT_TIMEOUT'),{code:'WAIT_TIMEOUT'});return {matched:true};}
  if(name==='browser_find'){if(waitFatal)throw Object.assign(Error(waitFatal.message),{code:waitFatal.code});if(p.waitErrors>0){p.waitErrors--;p.findErrorsConsumed++;throw Object.assign(Error('页面还在跳转'),{code:'PAGE_NOT_ALLOWED'});}if(p.emptyReads>0){p.emptyReads--;p.emptyReadsConsumed++;return {elements:[],total_elements:0,lang:'zh-CN',url:p.url};}const found=elements().filter(x=>(!args.scope_ref||x.scope===args.scope_ref)&&(!args.role||x.role===args.role)&&(!args.text||(args.exact?x.name===args.text:x.name.toLowerCase().includes(args.text.toLowerCase()))));return {elements:found,total_elements:found.length,lang:'zh-CN',url:p.url};}
  if(name==='browser_action'&&args.action==='click'){p.clicked.push(args.ref);if(args.ref==='p1'){p.url=DETAIL;return {snapshot:{url:DETAIL}};}if(args.ref==='d6'&&refetch)p.seen.push(refreshProof(p.now,'ep:1',DETAIL));return {status:'completed',snapshot:{url:p.url}};}
  if(name==='browser_tabs'){p.closed=true;return {};}
  throw Error('unexpected '+name);
 };
 return p;
}
const make=p=>new ToolsRefresher({distribution:storeTestDistribution(),expected:refreshExpected,targetIdentity:()=>p.identity,observeMs:1000,invoke:p.invoke,seen:()=>p.seen,now:()=>{p.now+=100;return p.now;},sleep:async()=>{p.now+=500;}});

test('real page shape: unknown identity stops; registered ID finds the renamed app and clicks only refresh',async()=>{
 const unbound=chatgpt({identity:null}),unknown=await make(unbound).run({reason:'update'});assert.equal(unknown.state,'identity_required');assert.equal(unknown.code,'TOOLS_REFRESH_IDENTITY_REQUIRED');assert.deepEqual(unbound.clicked,[]);assert.deepEqual(unbound.calls,[]);
 const p=chatgpt({identity:IDENTITY,list:LIST.map(x=>x.ref==='p1'?{...x,name:'Mac Studio Production'}:x)}),r=make(p),v=await r.run({reason:'update'});
 assert.equal(v.state,'refreshed',JSON.stringify(v));
 assert.equal(p.calls.find(([n])=>n==='browser_open')[1].url,PLUGINS_URL,'no hop through the chat home page');
 assert.deepEqual(p.clicked,['p1','d6'],'the ChatHand entry, then 刷新工具; never 允许…, 卸载, 删除应用 or the settings/actions buttons');
 assert.deepEqual(v.steps.map(s=>[s.step,s.ok]),[['helper',true],['open',true],['page',true],['entry',true],['open_entry',true],['detail',true],['button',true],['click',true],['tools_list',true]]);
 assert.equal(v.detail_url,DETAIL,'the window can open ChatHand\'s own page next time');assert.equal(v.stopped_at,undefined);
 for(const s of v.steps)assert.ok(STEP_WORDS[s.step],s.step);
 const waits=p.calls.filter(([n])=>n==='browser_wait_for').map(([,a])=>a.condition.timeout_ms);assert.ok(waits.every(ms=>ms<=15000),'each wait fits the browser\'s 15-second limit');
});

test('a page that is still navigating is waited for, not given up on',async()=>{
 const p=chatgpt({waitErrors:2,emptyReads:1,identity:IDENTITY}),v=await make(p).run();
 assert.equal(v.state,'refreshed',JSON.stringify(v));assert.equal(p.findErrorsConsumed,2,'both PAGE_NOT_ALLOWED exceptions occurred in browser_find');assert.equal(p.waitErrors,0);assert.equal(p.emptyReadsConsumed,1,'the transient empty list was actually read');assert.equal(p.emptyReads,0);assert.deepEqual(p.clicked,['p1','d6']);assert.equal(p.calls.filter(([n])=>n==='browser_open').length,1,'stays on the plugins page');
 for(const kind of ['PAGE_NOT_ALLOWED','empty']){const pending=chatgpt({identity:IDENTITY,...(kind==='PAGE_NOT_ALLOWED'?{waitErrors:Infinity}:{list:[]})}),refresher=make(pending);pending.url=PLUGINS_URL;const started=pending.now,entry=await refresher.findEntry('task_refresh','ep:1');assert.equal(entry.total,0,kind);assert.equal(entry.list_ready,false,kind);assert.ok(pending.now-started>=refresher.pageWaitMs,'uses original pageWaitMs before stopping');assert.ok(pending.now-started<=refresher.pageWaitMs+300,'does not restart or extend the wait deadline');assert.deepEqual(pending.clicked,[]);if(kind==='PAGE_NOT_ALLOWED')assert.ok(pending.findErrorsConsumed>=2);}
});

test('when it does not work it says which step stopped it, and nothing is clicked',async()=>{
 let p=chatgpt({list:LIST.filter(x=>!x.name.startsWith('ChatHand'))}),v=await make(p).run();
 assert.equal(v.state,'not_found');assert.equal(v.stopped_at,'page');assert.match(v.message,/插件页 30 秒里没出现 ChatHand/);
 assert.deepEqual(v.steps.filter(s=>s.step==='page').map(s=>s.headings),[['插件'],['插件']],'the page did load: ChatHand is just not in the list');
 p=chatgpt({list:[...LIST.filter(x=>!x.name.startsWith('ChatHand')),{ref:'i1',role:'img',name:'ChatHand'}]});v=await make(p).run();
 assert.equal(v.state,'not_found');assert.equal(v.stopped_at,'page');assert.equal(v.code,'TOOLS_REFRESH_IDENTITY_NOT_FOUND');assert.equal(v.missing_reason,'refresh_not_found');
 assert.match(v.message,/没出现 ChatHand/);assert.deepEqual(p.clicked,[]);assert.equal(p.closed,true);
 p=chatgpt({list:[...LIST,{ref:'p9',role:'button',name:'ChatHand Dev 测试版',app_id:IDENTITY.app_id,href:IDENTITY.detail_url}]});v=await make(p).run();
 assert.equal(v.state,'ambiguous');assert.equal(v.stopped_at,'entry');assert.deepEqual(p.clicked,[]);
 p=chatgpt({openError:{code:'BROWSER_IN_USE',message:'浏览器由另一 AI 连接使用，请在本机停止后切换。'}});v=await make(p).run();
 assert.equal(v.state,'failed');assert.equal(v.stopped_at,'open');assert.match(v.message,/^打开 ChatGPT 插件页时出错：浏览器由另一 AI 连接使用/);assert.equal(v.code,'BROWSER_IN_USE');
});

test('a helper that drops while the page loads is reported as that, not as a missing page',async()=>{
 const p=chatgpt({identity:IDENTITY,waitFatal:{code:'EXTENSION_DISCONNECTED',message:'Chrome 助手曾经连接过，现在连接断开。'}}),v=await make(p).run();
 assert.equal(v.state,'failed');assert.equal(v.stopped_at,'page');assert.match(v.message,/^等待插件页加载时出错：Chrome 助手曾经连接过，现在连接断开/);
 assert.equal(v.code,'EXTENSION_DISCONNECTED');assert.equal(p.calls.filter(([n])=>n==='browser_find').length,1,'the real lookup throws once and does not keep waiting after disconnect');assert.deepEqual(p.clicked,[],'zero app clicks and zero refresh clicks');assert.equal(p.calls.filter(([n])=>n==='browser_open').length,1);
});

test('a 允许… button on the page is not a consent dialog; no new tool list means unverified',async()=>{
 const p=chatgpt({refetch:false,identity:IDENTITY}),v=await make(p).run();
 assert.equal(v.state,'unverified');assert.equal(v.stopped_at,'tools_list');assert.equal(v.steps.at(-1).code,'LIST_NOT_CORRELATED');assert.ok(v.correlation.missing.includes('tools_list_not_observed'));
 assert.equal(p.closed,false);assert.deepEqual(p.clicked,['p1','d6']);
});

test('upgrade_status passes on where it stopped, in words ChatGPT can relay',()=>{
 const self={upgradePending:false,updater:{aiStatus:()=>({phase:'updated',current:{version:'1.0.0',build:1028},target:null,install_state:'idle',just_updated:{},tools_changed:true,request:null})},
  toolsRefresh:{snapshot:()=>({state:'not_found',message:'插件页里找不到 ChatHand 那一项，没有点任何东西。',stopped_at:'entry',steps:[{step:'helper',ok:true,ms:900},{step:'entry',ok:false,ms:300,count:0}]})}};
 const v=Tools.prototype.upgradeView.call(self);
 assert.equal(v.tools_refresh.stopped_at,'entry');assert.equal(v.tools_refresh.steps.length,2);
 assert.match(v.message,/卡在「在插件页中查找 ChatHand」/);assert.match(v.message,/点「刷新工具」/);
});

test('window: a failed auto refresh says so first, in orange, then asks you to click; links go to the plugins page',()=>{
 const ui=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../../ui/style.css',import.meta.url),'utf8');
 assert.ok(ui.includes("const REFRESH_TOOLS_URL='https://chatgpt.com/settings/plugins-settings';"));assert.ok(!ui.includes('#settings/Connectors\';'));
 assert.ok(ui.includes("case'openRefreshTools':await native('openExternal',{url:refreshToolsURL()});return;"));
 const start=ui.indexOf('function toolsRefreshNoteBody('),end=ui.indexOf('/* 0010',start);assert.ok(start>=0&&end>start);
 for(const locale of ['zh','en']){
  const T=(key,params={})=>translate(key,params,locale),context={T,TH:T,E:String,REFRESH_HELPER_STATES:['helper_outdated','helper_broken','unavailable'],refreshToolsFigure:()=>'<figure></figure>',S:{}};
  const render=vm.runInNewContext(ui.slice(start,end)+';toolsRefreshNoteBody',context);
  const failed=render({state:'not_found'});assert.match(failed,/class="bb-warn"/);assert.ok(failed.includes(T('ui.window.toolsRefreshNoteBody.failed',{openStrong:'<strong>',closeStrong:'</strong>'})));
  const clicked=render({state:'unverified',clicked:true});assert.ok(clicked.includes(T('ui.window.toolsRefreshNoteBody.unverified',{openStrong:'<strong>',closeStrong:'</strong>'})));assert.ok(!clicked.includes('<figure>'),'uncertain prior click does not invite a second refresh');
  assert.ok(render({state:'refreshed'}).includes(T('ui.window.toolsRefreshNoteBody.refreshed')));
 }
 assert.ok(ui.includes("tr.clicked!==true"),'a clicked-but-unverified result does not prompt another click');
 assert.ok(css.includes('.bubble p.bb-warn strong{font-weight:600}'));
});
