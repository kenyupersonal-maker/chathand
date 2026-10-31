import {refreshExpected,refreshProof} from '../test-support/refresh-proof.mjs';
// 1029 G：假页面和可推进的假时钟。不会连接 ChatGPT 或用户的 Chrome。
import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolsRefresher,PLUGINS_URL,REFRESH_NAMES_BUILTIN,DANGER} from '../app/v1/tools-refresh.mjs';
import {Tools} from '../app/tools.mjs';
import {storeTestDistribution,manifestStoreTestHelper} from '../test-support/chrome-store-fixture.mjs';
const box={x:20,y:30,width:100,height:40},point={x:70,y:50};
const failed=code=>({status:'failed',error:{code,message:code}});
function fixture({distribution=storeTestDistribution(),lang='zh-CN',label='刷新工具',helper,waitError,findError,clickError,learned={},refetch=true,detailUrl=PLUGINS_URL+'/plugin_test',extra=[]}={}){
 const p={now:1000,calls:[],seen:[],events:[],url:PLUGINS_URL,closed:false,finished:null,clicked:[],sleeps:[],snapshots:[]};
 const base=[{ref:'e1',role:'button',name:'ChatHand ChatHand 允许使用所有工具',app_id:'plugin_test',href:PLUGINS_URL+'/plugin_test',box},{ref:'e2',role:'button',name:'Figma',box},{ref:'perm',role:'button',name:'Permissions',box}];
 const detail=[{ref:'refresh',role:'button',name:label,box},{ref:'delete',role:'button',name:'Delete app'},{ref:'uninstall',role:'button',name:'Uninstall'},{ref:'edit',role:'button',name:'Edit'},{ref:'rename',role:'button',name:'Rename ChatHand'},...extra];
 p.invoke=async(name,a)=>{
  p.calls.push([name,a]);
  if(name==='browser_status'){const h=helper?typeof helper==='function'?helper(p):helper:manifestStoreTestHelper();return {selected_backend:'extension',extension:{connected:true,compatibility:{state:h.state==='outdated'||h.state==='reloading'?'incompatible':'compatible'},helper:h}};}
  if(name==='begin_task')return {task_id:'refresh-task'};
  if(name==='finish_task'){p.finished=a;return {};}
  if(name==='browser_open'){p.url=a.url;return {page_id:'ep:1029',url:p.url};}
  if(name==='browser_tabs'){p.closed=true;return {};}
  if(name==='browser_wait_for')return waitError?failed(waitError):{matched:true,url:p.url};
  if(name==='browser_find'){
   if(findError)return failed(findError);
   if(waitError==='PAGE_NOT_ALLOWED')return failed(waitError);
   if(waitError==='empty')return {elements:[],total_elements:0,url:p.url};
   let e=[...base,...(p.url===detailUrl?[{ref:'heading',role:'heading',name:'ChatHand'},...detail]:[])];
   e=e.filter(x=>(!a.role||x.role===a.role)&&(!a.text||(a.exact?x.name===a.text:x.name.includes(a.text))));
   const offset=a.offset||0,limit=a.limit||20;
   return {elements:e.slice(offset,offset+limit),total_elements:e.length,next_offset:offset+limit<e.length?offset+limit:null,url:p.url,lang};
  }
  if(name==='browser_action'){
   if(clickError)return failed(clickError);
   p.clicked.push(a.ref);const old=p.url;if(a.ref==='e1')p.url=detailUrl;
   if(a.ref==='refresh'&&refetch)p.seen.push(refreshProof(p.now,'ep:1029',p.url));
   const target=a.ref==='e1'?base[0]:detail.find(x=>x.ref===a.ref);
   return {status:'completed',click:{target,box,point},changes:{url:p.url,url_changed:old!==p.url,added:a.ref==='e1'?detail.map(x=>({name:x.name})):[]},url:p.url};
  }
  throw Error('unexpected '+name);
 };
 p.r=new ToolsRefresher({distribution,expected:refreshExpected,targetIdentity:()=>({app_id:'plugin_test',detail_url:PLUGINS_URL+'/plugin_test'}),observeMs:1000,invoke:p.invoke,seen:()=>p.seen,now:()=>p.now,sleep:async ms=>{p.sleeps.push(ms);p.snapshots.push(p.r.snapshot());p.now+=ms;},emit:(k,d)=>p.events.push([k,d]),names:{load:()=>learned,save:()=>{throw Error('G must not learn before a verified AI click');}},urls:[PLUGINS_URL]});
 return p;
}

test('built-in mapping has only verified Chinese; rename/edit and destructive buttons are excluded',()=>{
 assert.deepEqual(REFRESH_NAMES_BUILTIN,{zh:['刷新工具']});
 for(const x of ['编辑','重命名','Rename ChatHand','Edit','Delete app','Uninstall','Permissions'])assert.ok(DANGER.test(x),x);
});
for(const code of ['empty','PAGE_NOT_ALLOWED'])test('bound identity lookup consumes the full 30 seconds for '+code,async()=>{
 const p=fixture({waitError:code}),start=p.now,v=await p.r.run();
 assert.equal(v.state,'not_found');assert.equal(v.stopped_at,'page');assert.equal(p.now-start,30000);
 const reads=p.calls.filter(([n])=>n==='browser_find');assert.ok(reads.length>4);assert.ok(p.sleeps.every(ms=>ms>0&&ms<=500));
 assert.equal(v.code,'TOOLS_REFRESH_IDENTITY_NOT_FOUND');assert.deepEqual(p.clicked,[]);
});
for(const phase of ['list','detail'])test('SNAPSHOT_STALE during '+phase+' stops without a refresh click',async()=>{
 const p=fixture(),original=p.invoke;
 p.r.invoke=async(name,args)=>name==='browser_find'&&(phase==='list'||p.clicked.includes('e1'))?failed('SNAPSHOT_STALE'):original(name,args);
 const v=await p.r.run();assert.equal(v.state,'helper_broken');assert.match(v.message,/SNAPSHOT_STALE/);assert.deepEqual(p.clicked,phase==='list'?[]:['e1']);assert.equal(p.calls.some(([n,a])=>n==='browser_action'&&a.ref==='refresh'),false);
});
test('a failed click is not reported as success and is never retried',async()=>{
 const p=fixture({clickError:'PAGE_HELPER_FAILED'}),v=await p.r.run();assert.equal(v.state,'helper_broken');assert.match(v.message,/PAGE_HELPER_FAILED/);assert.equal(p.calls.filter(([n])=>n==='browser_action').length,1);assert.equal(p.finished.success,false);
});
test('store helper incompatibility stops before any page opens',async()=>{
 for(const state of ['outdated','reloading']){const p=fixture({helper:{state}}),start=p.now,v=await p.r.run({reason:'update'});
  assert.equal(v.state,'helper_outdated');assert.equal(v.code,'CHROME_STORE_INCOMPATIBLE');assert.equal(p.now,start);assert.deepEqual(p.clicked,[]);assert.equal(p.calls.some(([n])=>n==='browser_open'),false);
 }
});
test('store helper disconnect waits at most 45 seconds without a page or task',async()=>{
 const p=fixture(),original=p.invoke;p.r.invoke=async(n,a)=>n==='browser_status'?{selected_backend:'extension',extension:{connected:false}}:original(n,a);
 const start=p.now,v=await p.r.run({reason:'update'});assert.equal(v.state,'unavailable');assert.equal(v.code,'EXTENSION_DISCONNECTED');assert.equal(p.now-start,45000);assert.equal(p.finished,null);assert.equal(p.calls.some(([n])=>n==='browser_open'),false);
});
test('store helper reconnect continues once with the current compatibility',async()=>{
 const p=fixture(),original=p.invoke;let checks=0;p.r.invoke=async(n,a)=>n==='browser_status'&&++checks<3?{selected_backend:'extension',extension:{connected:false}}:original(n,a);
 const v=await p.r.run({reason:'update'});assert.equal(v.state,'refreshed');assert.equal(checks,3);assert.deepEqual(p.clicked,['e1','refresh']);
});
test('Chinese fast path records both target and actual geometry, URL changes and new elements',async()=>{
 const p=fixture(),v=await p.r.run();assert.equal(v.state,'refreshed');assert.deepEqual(p.clicked,['e1','refresh']);
 for(const key of ['open_entry','click']){const s=v.steps.find(s=>s.step===key);assert.ok(s.target.name);assert.deepEqual(s.box,box);assert.deepEqual(s.point,point);assert.equal(typeof s.url_changed,'boolean');assert.equal(s.url,PLUGINS_URL+'/plugin_test');}
 assert.equal(v.steps.find(s=>s.step==='open_entry').url_changed,true);assert.ok(v.steps.length<=24);
});
test('unknown English produces only newly appeared safe candidates and preserves the tab',async()=>{
 const p=fixture({lang:'en-US',label:'Refresh tools'}),v=await p.r.run();assert.equal(v.state,'needs_ai');assert.equal(v.lang,'en-us');assert.deepEqual(v.buttons,[{number:1,role:'button',name:'Refresh tools',box}]);
 assert.ok(v.rules.zh&&v.rules.en);assert.deepEqual(p.clicked,['e1']);assert.equal(p.closed,false);assert.equal(p.finished.success,false);assert.equal(p.finished.summary,'等待 ChatGPT 识别刷新按钮');assert.equal(p.r.pending.buttons[0].ref,'refresh');assert.equal(v.buttons[0].ref,undefined);
});
test('a locally learned exact language label uses the fast path',async()=>{
 const p=fixture({lang:'en-US',label:'Refresh tools',learned:{'en-us':['Refresh tools']}}),v=await p.r.run();assert.equal(v.state,'refreshed');assert.deepEqual(p.clicked,['e1','refresh']);
});
test('unknown/detail URL and duplicate known buttons never trigger refresh',async()=>{
 let p=fixture({detailUrl:PLUGINS_URL}),v=await p.r.run();assert.equal(v.state,'not_found');assert.equal(v.stopped_at,'detail');assert.deepEqual(p.clicked,['e1']);
 p=fixture({extra:[{ref:'duplicate',role:'button',name:'刷新工具'}]});v=await p.r.run();assert.equal(v.state,'ambiguous');assert.deepEqual(p.clicked,['e1']);
});
test('learned names are exact, safe and language-ordered',()=>{
 const p=fixture({learned:{'en-us':['Refresh tools'],'en':['Reload actions'],'_':['Delete app','Refresh actions']}});
 assert.deepEqual(p.r.knownNames('en-US'),['Refresh tools','Reload actions','Refresh actions','刷新工具']);assert.equal(p.r.matchRefresh([{role:'button',name:'Refresh tools now'}],'en-US').total,0);
});
test('upgradeView carries waiting, candidate rules and learned labels unchanged',()=>{
 const r={state:'running',waiting:'helper_manual',message:'请重新加载助手。',lang:'en-us',buttons:[{number:1,name:'Refresh tools'}],rules:{zh:'只选刷新'},learned:{lang:'en-us',name:'Refresh tools'}};
 const self={updater:{aiStatus:()=>({phase:'updated',current:{build:1029},tools_changed:true})},toolsRefresh:{snapshot:()=>r}};
 let v=Tools.prototype.upgradeView.call(self);for(const k of ['waiting','lang','buttons','rules','learned'])assert.deepEqual(v.tools_refresh[k],r[k]);assert.match(v.message,/请他做完回你一句/);
 r.state='needs_ai';r.message='按 rules 认按钮';v=Tools.prototype.upgradeView.call(self);assert.match(v.message,/按 rules 认按钮/);
});
