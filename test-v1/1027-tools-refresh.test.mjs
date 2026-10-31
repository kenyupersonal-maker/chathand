import {refreshExpected,refreshProof} from '../test-support/refresh-proof.mjs';
// 1027：替用户去 ChatGPT 设置里点 ChatHand 的「刷新工具」。有把握点对才点；点完要看到 ChatGPT 来拿新清单。
import vm from 'node:vm';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {ToolsRefresher,REFRESH_NAMES,DANGER} from '../app/v1/tools-refresh.mjs';
import {storeTestDistribution,manifestStoreTestHelper} from '../test-support/chrome-store-fixture.mjs';

const IDENTITY={app_id:'plugin_test',detail_url:'https://chatgpt.com/settings/plugins-settings/plugin_test',app_name:'ChatHand'};

// 假的 ChatGPT 设置页：先是应用列表，点进 ChatHand 才有「管理应用」那几行（应用名称、应用描述、刷新工具、删除应用）。
function page({loggedIn=true,entries=[{ref:'e1',role:'button',name:'ChatHand'},{ref:'e2',role:'button',name:'Figma'}],detail=[{ref:'b1',role:'button',name:'编辑'},{ref:'b2',role:'button',name:'刷新工具'},{ref:'b3',role:'button',name:'删除应用'}],confirmSubmit=false,refetch=true,dialog=null,connected=true,identity=IDENTITY}={}){
 // Only explicitly bound single-app scenarios receive trusted list identity.
 entries=entries.map(x=>identity&&x.ref==='e1'?{...x,app_id:identity.app_id,href:identity.detail_url}:x);
 const p={identity,calls:[],seen:[],opened:false,inDetail:false,closed:false,finished:null,clicked:[],now:1_000};
 const elements=()=>p.inDetail?[{ref:'h1',role:'heading',name:'ChatHand'},...detail,...(dialog&&p.clicked.includes('b2')?[{ref:'dg',role:'dialog',name:''},{ref:'d1',role:'button',name:dialog,scope:'dg'}]:[])]:loggedIn?entries:[{ref:'l1',role:'button',name:'登录'}];
 p.invoke=async(name,args)=>{p.calls.push([name,args]);
  if(name==='browser_status')return {selected_backend:'extension',extension:{connected,helper:manifestStoreTestHelper(),compatibility:{state:'compatible'}}};
  if(name==='begin_task')return {task_id:'task_refresh'};
  if(name==='finish_task'){p.finished=args;return {};}
  if(name==='browser_open'){p.opened=true;return {page_id:'ep:1'};}
  if(name==='browser_wait_for'){if(args.condition.kind==='text'&&!elements().some(x=>x.name.includes(args.condition.text)))throw Object.assign(Error('WAIT_TIMEOUT'),{code:'WAIT_TIMEOUT'});return {matched:true};}
  if(name==='browser_find'){const found=elements().filter(x=>(!args.scope_ref||x.scope===args.scope_ref)&&(!args.role||x.role===args.role)&&(!args.text||(args.exact?x.name===args.text:x.name.toLowerCase().includes(args.text.toLowerCase()))));return {elements:found,total_elements:found.length,lang:'zh-CN',url:'https://chatgpt.com/settings/plugins-settings'+(p.inDetail?'/plugin_test':'')};}
  if(name==='browser_action'&&args.action==='click'){
   if(args.ref==='e1'){p.inDetail=true;p.clicked.push('e1');return {};}
   if(args.ref==='b2'){if(confirmSubmit&&args.confirm!==true)throw Object.assign(Error('需要确认'),{code:'BROWSER_CONFIRM_REQUIRED'});p.clicked.push('b2');if(refetch)p.seen.push(refreshProof(p.now,'ep:1','https://chatgpt.com/settings/plugins-settings/plugin_test'));return {status:'completed'};}
   p.clicked.push(args.ref);return {};
  }
  if(name==='browser_snapshot')return {aria_yaml:dialog&&p.clicked.includes('b2')?'- dialog "更新"\n  - button "确认"':'- main "ChatHand"'};
  if(name==='browser_tabs'){p.closed=true;return {};}
  throw Error('unexpected '+name);
 };
 return p;
}
const make=(p,distribution=storeTestDistribution())=>new ToolsRefresher({distribution,expected:refreshExpected,targetIdentity:()=>p.identity,observeMs:1000,invoke:p.invoke,seen:()=>p.seen,now:()=>{p.now+=100;return p.now;},sleep:async()=>{p.now+=500;}});
const clicks=p=>p.calls.filter(([n,a])=>n==='browser_action'&&a.action==='click').map(([,a])=>a.ref);

test('names: only an exact refresh button; delete, disconnect and permission buttons never qualify',()=>{
 assert.deepEqual(REFRESH_NAMES,['刷新工具','Refresh tools','Refresh']);
 for(const name of ['删除应用','断开连接','Delete app','Disconnect','管理权限','Remove'])assert.ok(DANGER.test(name),name);
 for(const name of REFRESH_NAMES)assert.equal(DANGER.test(name),false,name);
});

test('opens ChatHand\'s page, clicks the one refresh button, and waits until ChatGPT fetches the tool list',async()=>{
 const p=page({identity:IDENTITY}),r=make(p),v=await r.run({reason:'update'});
 assert.equal(v.state,'refreshed');assert.deepEqual(v.target,{role:'button',name:'刷新工具'});
 assert.deepEqual(clicks(p),['e1','b2'],'opens the ChatHand entry, then refresh; never delete');assert.equal(p.clicked.includes('b3'),false);
 assert.equal(p.closed,false,'clicked tab remains available');assert.equal(p.finished.task_id,'task_refresh');assert.equal(p.finished.success,true);assert.equal(r.snapshot().state,'refreshed');
});

test('anything unclear means no click: two refresh buttons, two entries claiming the bound identity, no entry, not logged in, helper offline, only a delete button',async()=>{
 let p=page({detail:[{ref:'b2',role:'button',name:'刷新工具'},{ref:'b4',role:'button',name:'刷新工具'}]}),v=await make(p).run();
 assert.equal(v.state,'ambiguous');assert.deepEqual(clicks(p),['e1']);assert.equal(p.closed,true);assert.equal(p.finished.success,false);
 p=page({entries:[{ref:'e1',role:'button',name:'ChatHand'},{ref:'e9',role:'link',name:'ChatHand 设置',app_id:IDENTITY.app_id,href:IDENTITY.detail_url}]});v=await make(p).run();assert.equal(v.state,'ambiguous');assert.deepEqual(clicks(p),[]);
 p=page({entries:[{ref:'e2',role:'button',name:'Figma'}]});v=await make(p).run();assert.equal(v.state,'not_found');assert.deepEqual(clicks(p),[]);
 p=page({loggedIn:false});v=await make(p).run();assert.equal(v.state,'not_found');assert.ok(v.message.includes('没有点任何东西'));assert.deepEqual(clicks(p),[]);
 p=page({connected:false});v=await make(p).run({reason:'manual'});assert.equal(v.state,'unavailable');assert.equal(p.opened,false);
 p=page({detail:[{ref:'b3',role:'button',name:'删除应用'}]});v=await make(p).run();assert.equal(v.state,'not_found');assert.deepEqual(clicks(p),['e1']);
});

test('a submit-style refresh button gets the explicit confirm; a consent dialog after the click is left to the user; no refetch is reported',async()=>{
 let p=page({confirmSubmit:true,identity:IDENTITY}),v=await make(p).run();assert.equal(v.state,'dispatch_unconfirmed');
 assert.deepEqual(p.calls.filter(([n,a])=>n==='browser_action'&&a.ref==='b2').map(([,a])=>a.confirm===true),[false],'uncertain dispatch is never retried');
 p=page({refetch:false,dialog:'确认更新',identity:IDENTITY});v=await make(p).run();assert.equal(v.state,'needs_user');assert.equal(v.confirmation,'pending');assert.deepEqual(clicks(p),['e1','b2'],'the dialog button is never clicked');assert.equal(p.closed,false,'1028: the tab stays open so the user can confirm');
 p=page({refetch:false,identity:IDENTITY});v=await make(p).run();assert.equal(v.state,'unverified');
});

test('right after an update ChatHand waits for the browser helper to reconnect',async()=>{
 const p=page({identity:IDENTITY});let n=0;const inner=p.invoke;p.invoke=async(name,args)=>{if(name==='browser_status'&&++n<3)return {selected_backend:'extension',extension:{connected:false,compatibility:{state:'compatible'}}};const status=await inner(name,args);if(name==='browser_status')status.extension.helper.state='current';return status;};
 const v=await make(p).run({reason:'update'});assert.equal(v.state,'refreshed');assert.equal(n,3);
});

test('only one run at a time; the server starts it when an update changed the tools',async()=>{
 const p=page(),r=make(p);
 const a=r.run(),b=r.run();assert.strictEqual(a,b);await a;
 const server=fs.readFileSync(new URL('../app/server.mjs',import.meta.url),'utf8');
 const match=server.match(/onUpdated:(ju=>\{.*?\}),currentSystemProxy/);assert.ok(match,'current update callback exists');
 for(const isolated of [false,true])for(const changed of [true,false,undefined]){
  const calls=[],callback=vm.runInNewContext('('+match[1]+')',{isolated,toolsRefresh:{run:async value=>{calls.push(value);}}});callback({tool_schema_changed:changed});
  assert.equal(calls.length,!isolated&&changed===true?1:0,'only a known schema change triggers refresh');
 }
 const ui=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');assert.equal(ui.includes('ai_install_local'),false);
});

test('store update reconnects on the third check or waits the full 45 seconds before reporting offline',async()=>{
 const p=page({identity:IDENTITY}),inner=p.invoke;let checks=0;
 p.invoke=async(name,args)=>name==='browser_status'&&++checks<3?{selected_backend:'extension',extension:{connected:false}}:inner(name,args);
 const reconnect=make(p);reconnect.now=()=>p.now;reconnect.sleep=async ms=>{p.now+=ms;};
 assert.equal((await reconnect.run({reason:'update'})).state,'refreshed');assert.equal(checks,3);
 const offline=page({identity:IDENTITY,connected:false}),offlineInvoke=offline.invoke;let offlineChecks=0;
 offline.invoke=async(name,args)=>{if(name==='browser_status')offlineChecks++;return offlineInvoke(name,args);};
 const timeout=make(offline),started=offline.now;timeout.now=()=>offline.now;timeout.sleep=async ms=>{offline.now+=ms;};
 const result=await timeout.run({reason:'update'});
 assert.equal(result.state,'unavailable');assert.equal(result.code,'EXTENSION_DISCONNECTED');
 assert.equal(offline.now-started,45000);assert.ok(offlineChecks>1);assert.equal(offline.opened,false);assert.deepEqual(clicks(offline),[]);
});
