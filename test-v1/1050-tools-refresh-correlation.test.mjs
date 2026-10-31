// 1050 refresh delta — synthetic fixture only. No real ChatGPT tabs, network, install, or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolsRefresher,PLUGINS_URL} from '../app/v1/tools-refresh.mjs';
import {Tools,TOOLS} from '../app/tools.mjs';
import {storeTestDistribution,manifestStoreTestHelper} from '../test-support/chrome-store-fixture.mjs';

const detail=PLUGINS_URL+'/plugin_test';
const expected={build:1050,instance_id:'installed-1050',connector_api:23,tool_count:78,schema_sha256:'a'.repeat(64),
  connection_tag:'connection-opaque',principal_tag:'principal-opaque',route:'local_http'};
const receipt=(at,host=false,extra={})=>({
  kind:'tools_list',at,source:'trusted_server',authenticated:true,caller:'chatgpt',route:'local_http',
  installation:{build:1050,instance_id:'installed-1050'},
  contract:{connector_api:23,tool_count:78,schema_sha256:'a'.repeat(64)},
  connection_tag:'connection-opaque',principal_tag:'principal-opaque',
  host_binding:host?{attested_by:'trusted_host',page_id:'test-tab',plugin_url:detail}:null,
  ...extra,
});

function fixture({after=null,hasConfirm=false,hostError=false,deliveryUnknown=false,clickThrows=null,events=[]}={}){
 const p={time:1000,calls:[],clicks:[],notes:[],steps:[],seen:[...events],finished:null,closed:false,url:PLUGINS_URL,postReads:0,audit:[],injected:false};
 const base=[{ref:'app-entry',role:'button',name:'ChatHand 允许使用所有工具',app_id:'plugin_test',href:detail}];
 const details=[{ref:'refresh-ref',role:'button',name:'刷新工具',box:{x:10,y:20,width:80,height:30}},{ref:'delete',role:'button',name:'Delete app'}];
 p.invoke=async (name,a)=>{
  p.calls.push([name,a]);
  if(name==='browser_status')return {selected_backend:'extension',extension:{connected:true,compatibility:{state:'compatible'},helper:manifestStoreTestHelper()}};
  if(name==='begin_task')return {task_id:'fake-task'};
  if(name==='finish_task'){p.finished=a;return {};}
  if(name==='browser_open'){p.url=a.url;return {page_id:'test-tab',url:p.url};}
  if(name==='browser_wait_for')return {matched:true,url:p.url};
  if(name==='browser_find'){
   const options=p.url===detail?[{ref:'title',role:'heading',name:'ChatHand'},...details]:base;
   const match=options.filter(x=>(!a.role||x.role===a.role)&&(!a.text||(a.exact?x.name===a.text:x.name.includes(a.text))));
   return {elements:match,total_elements:match.length,url:p.url,lang:'zh-CN'};
  }
  if(name==='browser_action'){
   p.clicks.push(a.ref);
   if(a.ref==='app-entry')p.url=detail;
   if(a.ref==='refresh-ref'&&clickThrows)throw Object.assign(Error(clickThrows),{code:clickThrows});
   return {status:'completed',delivery_unconfirmed:a.ref==='refresh-ref'&&deliveryUnknown,
     click:{box:{x:10,y:20,width:80,height:30},point:{x:50,y:35}},
     changes:{url:p.url,url_changed:a.ref==='app-entry'},url:p.url};
  }
  if(name==='browser_snapshot'){
   p.postReads++;
   if(hasConfirm)return {aria_yaml:'- alertdialog "新工具确认"\n  - button "允许"\n  - button "取消"'};
   if(hostError)return {aria_yaml:'- alert "Error: failed to refresh"'};
   return {aria_yaml:'- main "ChatHand"'};
  }
  if(name==='browser_tabs'){p.closed=true;return {};}
  throw Error('unexpected '+name);
 };
 p.r=new ToolsRefresher({distribution:storeTestDistribution(),targetIdentity:()=>({app_id:'plugin_test',detail_url:detail}),invoke:p.invoke,now:()=>p.time,
  sleep:async ms=>{p.steps.push({now:p.time,state:p.r.snapshot().state,waiting:p.r.snapshot().waiting});p.time+=ms;
   if(after!==null&&p.time>=after&&!p.injected){p.injected=true;p.seen.push(receipt(p.time,after.host===true,after.event||{}));}},
  seen:()=>p.seen,expected:()=>expected,emit:(k,v)=>p.notes.push([k,v]),audit:e=>p.audit.push(e),
  urls:[PLUGINS_URL],observeMs:180000,toolsListWaitMs:20000});
 return p;
}
test('20s is intermediate, 180s unobserved is unverified, only one refresh click and no tab close',async()=>{
 const p=fixture(),v=await p.r.run();
 assert.equal(v.state,'unverified');assert.deepEqual(p.clicks,['app-entry','refresh-ref']);
 assert.ok(p.steps.some(x=>x.waiting==='tools_list'&&x.state==='running'),'20s waiting state');
 assert.ok(p.time>=180000,'observed 180s');assert.equal(p.closed,false);assert.equal(p.postReads,1);
 assert.equal(v.correlation.observed,0);assert.deepEqual(v.correlation.missing,['tools_list_not_observed']);
 assert.equal(v.bring_existing_tab.page_id,'test-tab');assert.equal(p.finished.success,false);
});
test('timestamps, mismatched client, wrong contract, wrong installation, or same principal without host never succeed',async()=>{
 const p=fixture({events:[10000,receipt(1300,false,{caller:'codex'}),receipt(1400,false,{contract:{connector_api:23,tool_count:77,schema_sha256:'not-78'}}),receipt(1500,false,{installation:{build:1049,instance_id:'old'}}),receipt(1600,false)]});
 const v=await p.r.run();
 assert.equal(v.state,'unverified');assert.equal(v.correlation.same_connection,1);
 assert.ok(v.correlation.missing.includes('target_chatgpt_page_not_attested'));assert.equal(p.clicks.filter(x=>x==='refresh-ref').length,1);
});
test('host-attested new list after 20s converges to refreshed without a second click',async()=>{
 const p=fixture({after:{host:true,event:{}},}),base=p.time;
 // Controlled fixture injects after 30s; no server or browser access.
 p.injectAt=base+30000;
 const old=p.r.sleep;p.r.sleep=async(ms)=>{const prior=p.time;await old(ms);if(!p.injectedLate&&p.time>=p.injectAt){p.injectedLate=true;p.seen.push(receipt(p.time,true));}};
 const v=await p.r.run();
 assert.equal(v.state,'refreshed');assert.equal(p.clicks.filter(x=>x==='refresh-ref').length,1);
 assert.ok(p.time>=p.injectAt);assert.equal(p.postReads,1);assert.equal(p.finished.success,true);
 assert.ok(p.audit.some(x=>x.event==='tools_refresh_correlated'));
});
test('confirmed dialog keeps the existing tab and provides bring-existing-tab metadata',async()=>{
 const p=fixture({hasConfirm:true}),v=await p.r.run();
 assert.equal(v.state,'needs_user');assert.equal(v.confirmation,'pending');assert.match(v.message,/ChatGPT 在等你确认新工具/);
 assert.deepEqual(v.bring_existing_tab,{action:'select',page_id:'test-tab',show:true,requires_user_request:true});
 assert.equal(p.closed,false);assert.equal(p.postReads,1);assert.deepEqual(p.clicks,['app-entry','refresh-ref']);
 assert.equal(p.time<180000,true);
});
test('explicit post-click host UI error does not turn into a success or manual retry',async()=>{
 const p=fixture({hostError:true}),v=await p.r.run();assert.equal(v.state,'host_error');assert.equal(v.code,'HOST_UI_ERROR');
 assert.equal(p.closed,false);assert.equal(p.postReads,1);assert.equal(p.clicks.filter(x=>x==='refresh-ref').length,1);
});
test('unconfirmed delivery remains distinct from no-list and is not replayed',async()=>{
 const p=fixture({deliveryUnknown:true}),v=await p.r.run();assert.equal(v.state,'dispatch_unconfirmed');
 assert.equal(p.clicks.filter(x=>x==='refresh-ref').length,1);assert.equal(p.closed,false);
 assert.ok(p.audit.some(x=>x.event==='tools_refresh_click'&&x.delivery_unconfirmed===true));
});
test('AI-selected path does not infer success from timestamps and never clicks twice',async()=>{
 const p=fixture();p.url=detail;p.r.value={state:'needs_ai',url:detail,lang:'zh-cn',buttons:[{number:1,role:'button',name:'刷新工具'}],finished_at:800};
 p.r.pending={page:'test-tab',url:detail,identity:{app_id:'plugin_test',detail_url:detail},lang:'zh-cn',at:800,buttons:[{number:1,ref:'refresh-ref',role:'button',name:'刷新工具'}]};
 p.seen=[900000];const v=await p.r.clickByNumber({number:1,meaning:'刷新此应用工具'});
 assert.equal(v.state,'unverified');assert.deepEqual(p.clicks,['refresh-ref']);assert.equal(p.closed,false);
});
test('RPC list event is taken only from server-owned routing callback, not forged params',async()=>{
 const fake={toolsListSeen:[],toolsListEvents:[],refreshListContext:(caller,context)=>context.transport==='local_http'&&caller==='chatgpt'?{
  ...receipt(0),host_binding:null}:null};
 const body={jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'openai/session':'spoof','refresh_tab':'test-tab',connector_api:999}}};
 const response=await Tools.prototype.rpcInternal.call(fake,body,'chatgpt',{transport:'local_http'});
 assert.equal(response.result.tools.length,TOOLS.length);
 assert.equal(fake.toolsListEvents.length,1);assert.equal(fake.toolsListEvents[0].host_binding,null);
 assert.equal(fake.toolsListEvents[0].source,'trusted_server');
 const localFake={toolsListSeen:[],refreshListContext:()=>null};
 await Tools.prototype.rpcInternal.call(localFake,body,'local-mcp',{transport:'local_http'});
 assert.equal(localFake.toolsListEvents,undefined);
});
test('Upgrade status preserves pending confirmation and page control, and avoids re-refresh notice',()=>{
 const state={state:'needs_user',clicked:true,message:'ChatGPT 在等你确认新工具',bring_existing_tab:{action:'select',page_id:'test-tab',show:true}};
 const obj={updater:{aiStatus:()=>({phase:'updated',current:{build:1050},tools_changed:true})},toolsRefresh:{snapshot:()=>state}};
 const v=Tools.prototype.upgradeView.call(obj);assert.equal(v.tools_refresh.bring_existing_tab.page_id,'test-tab');
 assert.match(v.message,/ChatGPT 在等你确认新工具/);
 const note=Tools.prototype.toolsRefreshNote.call({toolsRefresh:{snapshot:()=>({...state,state:'unverified',finished_at:15000})},toolsRefreshNoted:new Set()},'session','bridge_info');
 assert.equal(note,null);
});
test('audit records no page content, tokens, headers or private payload',async()=>{
 const p=fixture(),v=await p.r.run();assert.equal(v.state,'unverified');
 const serialized=JSON.stringify(p.audit);
 assert.ok(p.audit.some(x=>x.event==='tools_refresh_click'&&x.page_id==='test-tab'&&x.request_id));
 assert.ok(!/authorization|header|token|secret|payload|aria_yaml/i.test(serialized));
});
