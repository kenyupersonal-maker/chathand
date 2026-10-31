import {refreshExpected,refreshProof} from '../test-support/refresh-proof.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolsRefresher,PLUGINS_URL} from '../app/v1/tools-refresh.mjs';
import {Tools,TOOLS,mergeNotes} from '../app/tools.mjs';
import {BROWSER_EXPERIENCE_TOOLS,validateBrowserTool} from '../app/v09/browser-experience-tools.mjs';

const box={x:10,y:20,width:140,height:32},point={x:80,y:36};
const detailUrl=PLUGINS_URL+'/plugin_test';
function fixture({label='Refresh tools',lang='en-US',duplicate=false,reopen=false,seenAfter=false}={}){
 const p={now:1000,calls:[],clicked:[],closed:false,saved:null,seen:[],url:detailUrl,findCount:0};
 const buttons=[
  {ref:'refresh',role:'button',name:label,box},
  ...(duplicate?[{ref:'refresh2',role:'button',name:label,box:{x:10,y:60,width:140,height:32}}]:[]),
  {ref:'delete',role:'button',name:'Delete app',box},{ref:'uninstall',role:'button',name:'Uninstall',box},
  {ref:'edit',role:'button',name:'Edit',box},{ref:'rename',role:'button',name:'Rename ChatHand',box}
 ];
 p.invoke=async(name,a)=>{
  p.calls.push([name,a]);
  if(name==='begin_task')return {task_id:'ai-refresh-task'};
  if(name==='finish_task'){p.finished=a;return {};}
  if(name==='browser_open'){p.url=a.url;p.page='reopened';return {page_id:'reopened',url:p.url};}
  if(name==='browser_tabs'){p.closed=true;return {};}
  if(name==='browser_wait_for')return {matched:true,url:p.url};
  if(name==='browser_find'){
   p.findCount++;
   if(reopen&&p.findCount===1){const e=Error('page gone');e.code='BROWSER_PAGE_MISSING';throw e;}
   let e=[{ref:'h',role:'heading',name:'ChatHand'},...buttons];
   e=e.filter(x=>(!a.role||x.role===a.role)&&(!a.text||(a.exact?x.name===a.text:x.name.includes(a.text))));
   return {url:p.url,lang,elements:e,total_elements:e.length,next_offset:null};
  }
  if(name==='browser_action'){
   p.clicked.push(a.ref);
   if(a.ref==='refresh')p.seen.push(refreshProof(p.now,p.page||'old-page',p.url));
   const target=buttons.find(x=>x.ref===a.ref);
   return {status:'completed',click:{target,box:target?.box||box,point},changes:{url:p.url,url_changed:false,added:[]},url:p.url};
  }
  throw Error('unexpected '+name);
 };
 p.r=new ToolsRefresher({expected:refreshExpected,targetIdentity:()=>({app_id:'plugin_test',detail_url:detailUrl}),observeMs:1000,invoke:p.invoke,seen:()=>p.seen,now:()=>p.now,sleep:async ms=>{p.now+=ms;},names:{load:()=>p.saved||{},save:v=>{p.saved=v;}},pluginsUrl:PLUGINS_URL,toolsListWaitMs:50,pageWaitMs:50});
 p.r.value={state:'needs_ai',url:detailUrl,lang:lang.toLowerCase(),buttons:[{number:1,role:'button',name:label,box}],rules:{},message:'pick',finished_at:900};
 p.r.pending={page:'old-page',url:detailUrl,identity:{app_id:'plugin_test',detail_url:detailUrl},lang:lang.toLowerCase(),buttons:[{number:1,ref:'refresh',role:'button',name:label,box}],at:950};
 if(seenAfter)p.seen=[refreshProof(951,'old-page',detailUrl)];
 return p;
}

test('clickByNumber rejects when not pending; dangerous names never click and pending stays',async()=>{
 const p=fixture();p.r.value={state:'idle'};p.r.pending=null;
 assert.throws(()=>p.r.clickByNumber({number:1,meaning:'refresh'}),e=>e.code==='TOOLS_REFRESH_NOT_PENDING');
 for(const name of ['删除应用','Delete app','Uninstall','编辑','Rename ChatHand']){
  const q=fixture({label:name});q.r.value.buttons[0].name=name;q.r.pending.buttons[0].name=name;
  assert.throws(()=>q.r.clickByNumber({number:1,meaning:'maybe'}),e=>e.code==='TOOLS_REFRESH_DANGEROUS');
  assert.deepEqual(q.clicked,[]);assert.equal(q.r.value.state,'needs_ai');assert.ok(q.r.pending);
 }
});

test('successful AI click learns exact language name and next run can match it',async()=>{
 const p=fixture(),v=await p.r.clickByNumber({number:1,meaning:'refresh this app tools'});
 assert.equal(v.state,'refreshed');assert.deepEqual(p.clicked,['refresh']);assert.deepEqual(p.saved,{'en-us':['Refresh tools']});
 assert.deepEqual(v.learned,{lang:'en-us',name:'Refresh tools'});const ai=v.steps.find(x=>x.step==='click');assert.equal(ai.number,1);assert.equal(ai.meaning,'refresh this app tools');assert.deepEqual(ai.box,box);assert.deepEqual(ai.point,point);
 const q=fixture();q.saved=p.saved;assert.equal(q.r.matchRefresh([{role:'button',name:'Refresh tools'}],'en-US').total,1);
});

test('closed detail tab is reopened and exact button is clicked',async()=>{
 const p=fixture({reopen:true}),v=await p.r.clickByNumber({number:1,meaning:'refresh'});
 assert.equal(v.state,'refreshed');assert.ok(p.calls.some(([n])=>n==='browser_open'));assert.deepEqual(p.clicked,['refresh']);
});

test('duplicate same-name buttons become ambiguous and nothing is clicked',async()=>{
 const p=fixture({duplicate:true}),v=await p.r.clickByNumber({number:1,meaning:'refresh'});
 assert.equal(v.state,'ambiguous');assert.deepEqual(p.clicked,[]);assert.equal(p.finished.success,false);
});

test('new tools list already fetched after needs_ai means no click',async()=>{
 const p=fixture({seenAfter:true}),v=await p.r.clickByNumber({number:1,meaning:'refresh'});
 assert.equal(v.state,'refreshed');assert.match(v.message,/已经拿到新工具/);assert.deepEqual(p.clicked,[]);assert.ok(p.calls.some(([name])=>name==='browser_find'),'revalidate current exact page/node before reusing proof');
});

test('Tools.invoke delegates tools_refresh_click only after policy check',async()=>{
 let checked=0,called=0;
 const base={lastCalls:{},state:{data:{}},store:{},queue:{},policy:{check(){checked++;}},upgradePending:false,toolsRefresh:{clickByNumber:async a=>{called++;return {state:'refreshed',...a};}}};
 let v=await Tools.prototype.invoke.call(base,'tools_refresh_click',{number:2,meaning:'refresh'},'chatgpt',{});assert.equal(checked,1);assert.equal(called,1);assert.equal(v.number,2);
 base.policy.check=()=>{const e=Error('paused');e.code='LOCAL_DISABLED';throw e;};
 await assert.rejects(()=>Tools.prototype.invoke.call(base,'tools_refresh_click',{number:2,meaning:'refresh'},'chatgpt',{}),e=>e.code==='LOCAL_DISABLED');assert.equal(called,1);
});

test('refresh note fires once per session only when refresh ended and no later tools/list; notes merge',()=>{
 const fake={toolsRefresh:{running:null,snapshot:()=>({state:'needs_ai',finished_at:100,message:'pick'})},toolsListSeen:[],toolsRefreshNoted:new Set()};
 const a=Tools.prototype.toolsRefreshNote.call(fake,'session-1','bridge_info');assert.equal(a.kind,'tools_refresh');assert.match(a.zh,/tools_refresh_click/);
 assert.equal(Tools.prototype.toolsRefreshNote.call(fake,'session-1','bridge_info'),null);
 const merged=mergeNotes({kind:'stall',zh:'resume',en:'resume'},a);assert.equal(merged.kind,'stall');assert.equal(merged.also[0].kind,'tools_refresh');
 const newer={...fake,toolsRefreshNoted:new Set(),toolsListSeen:[101]};assert.equal(Tools.prototype.toolsRefreshNote.call(newer,'session-2','bridge_info').kind,'tools_refresh','an unrelated timestamp cannot suppress the current target-page refresh need');
 const excluded={...fake,toolsRefreshNoted:new Set()};assert.equal(Tools.prototype.toolsRefreshNote.call(excluded,'session-3','upgrade_status'),null);
});

test('browser_find accepts boxes and tool contract lists it',()=>{
 const def=BROWSER_EXPERIENCE_TOOLS.find(x=>x.name==='browser_find');assert.equal(def.inputSchema.properties.boxes.type,'boolean');
 assert.doesNotThrow(()=>validateBrowserTool(def,{task_id:'t',page_id:'p',role:'button',boxes:true}));
 const tool=TOOLS.find(x=>x.name==='tools_refresh_click');assert.ok(tool);assert.equal(tool.inputSchema.properties.number.maximum,30);assert.equal(tool.annotations.destructiveHint,false);
});

for(const mismatch of ['page','url','schema','timestamp'])test('already-fetched proof never skips click for mismatched '+mismatch,async()=>{
 const p=fixture(),proof=refreshProof(951,'old-page',detailUrl);
 if(mismatch==='page')proof.host_binding.page_id='another-page';if(mismatch==='url')proof.host_binding.plugin_url=detailUrl+'-other';if(mismatch==='schema')proof.contract.schema_sha256='0'.repeat(64);p.seen=[mismatch==='timestamp'?951:proof];
 const out=await p.r.clickByNumber({number:1,meaning:'refresh'});assert.deepEqual(p.clicked,['refresh']);assert.equal(out.state,'refreshed','only the later fully correlated callback from the one actual fixture click can succeed');
});
