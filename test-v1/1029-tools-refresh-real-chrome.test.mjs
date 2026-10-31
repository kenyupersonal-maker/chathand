import {refreshExpected,refreshProof} from '../test-support/refresh-proof.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {findChrome,launchChrome,FakeChrome,startServer} from '../test-support/real-chrome.mjs';
import {BrowserDriver} from '../browser-extension/driver.js';
import {ToolsRefresher} from '../app/v1/tools-refresh.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';
import {AUTOMATION_TOOLS} from '../app/v07/automation.mjs';
import {BROWSER_EXPERIENCE_TOOLS,browserToolDefinition,validateBrowserTool} from '../app/v09/browser-experience-tools.mjs';

const CHROME=findChrome();
const skip=CHROME?false:'找不到 Chrome';
const labels={
 'zh-CN':['权限 选择…','卸载','Rename ChatHand（未关联账户）','ChatHand（未关联账户） 的操作','删除应用','编辑','编辑','刷新工具'],
 'en-US':['Permissions…','Uninstall','Rename ChatHand (not linked)','Actions for ChatHand','Delete app','Edit','Edit','Refresh tools'],
 'ja-JP':['権限…','アンインストール','名前を変更','ChatHand の操作','アプリを削除','編集','編集','ツールを更新']
};
const refreshOf={'zh-CN':'刷新工具','en-US':'Refresh tools','ja-JP':'ツールを更新'};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const q=s=>JSON.stringify(String(s));
function listPage(base,lang){
 const id='plugin_test_'+lang.toLowerCase().replace('-','_');const detail=base+'/settings/plugins-settings/'+id;
 return `<!doctype html><html lang="${lang}"><body><button>默认权限</button><a id="ch" data-app-id="${detail.split('/').pop()}" href="${esc(detail)}">ChatHand ChatHand 允许使用所有工具</a><button>Figma Figma</button><button>Google Drive Google Drive</button><script>document.getElementById('ch').onclick=async event=>{event.preventDefault();await fetch('/clicked?name='+encodeURIComponent('ChatHand'));location.href=${q(detail)};};</script></body></html>`;
}
function detailPage(lang){
 const buttons=labels[lang].map((name,i)=>`<button data-i="${i}">${esc(name)}</button>`).join('');
 const refresh=refreshOf[lang];
 return `<!doctype html><html lang="${lang}"><body><h1>ChatHand</h1>${buttons}<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{const n=b.textContent;await fetch('/clicked?name='+encodeURIComponent(n));if(n===${q(refresh)})await fetch('/tools-list');};</script></body></html>`;
}
function definitions(){
 const map=new Map();
 for(const d of [...AUTOMATION_TOOLS,...BROWSER_EXPERIENCE_TOOLS])map.set(d.name,browserToolDefinition(d));
 return map;
}

test('1029 真 Chrome：中英日假插件页把刷新链路走通', {skip,timeout:240000}, async t=>{
 const toolsSeen=[];let activePage=null;
 const routes={
  '/settings/plugins-settings':(req,res,url,base)=>listPage(base,url.searchParams.get('lang')||'zh-CN'),
  '/settings/plugins-settings/plugin_test_zh_cn':()=>detailPage('zh-CN'),
  '/settings/plugins-settings/plugin_test_en_us':()=>detailPage('en-US'),
  '/settings/plugins-settings/plugin_test_ja_jp':()=>detailPage('ja-JP'),
  '/clicked':'ok','/tools-list':(req)=>{toolsSeen.push(refreshProof(Date.now(),activePage,req.headers.referer));return 'ok';},'/favicon.ico':''
 };
 const server=await startServer(routes);t.after(()=>server.close());
 const chrome=await launchChrome(CHROME);t.after(()=>chrome.close());
 const api=new FakeChrome(chrome.cdp);t.after(()=>api.dispose());
 const driver=api.wire(new BrowserDriver(api,{experience:true,actionabilityTimeoutMs:1000,idleMs:120000}));
 const defs=definitions();let request=0,taskSeq=0,finished=[];
 const learned={};
 const names={load:()=>learned,save:v=>{for(const k of Object.keys(learned))delete learned[k];Object.assign(learned,structuredClone(v));}};
 const clicks=()=>server.hits.filter(x=>x.startsWith('/clicked?')).map(x=>decodeURIComponent(new URL(x,'http://x').searchParams.get('name')||''));
 const seen=()=>toolsSeen.slice();
 const invoke=async(name,args={})=>{
  if(name==='begin_task')return {task_id:'refresh-real-'+(++taskSeq)};
  if(name==='finish_task'){finished.push(args);return {terminal:true};}
  if(name==='browser_status')return {selected_backend:'extension',extension:{connected:true,compatibility:{state:'compatible'},helper:{state:'current'}}};
  const def=defs.get(name);assert.ok(def,'real definition '+name);validateBrowserTool(def,args);
  if(name==='browser_open'){
   if(args.page_id)return driver.execute('navigate',{page_id:args.page_id,url:args.url,operation_key:'real:'+ ++request});
   return driver.execute('new',{url:args.url});
  }
  if(name==='browser_wait_for')return driver.execute('wait_for',{page_id:args.page_id,condition:args.condition,operation_key:'real:'+ ++request});
  if(name==='browser_find'){activePage=args.page_id;const {task_id,allow_personal,...rest}=args;return driver.execute('find',rest);}
  if(name==='browser_snapshot'){const {task_id,allow_personal,...rest}=args;return driver.execute('snapshot',rest);}
  if(name==='browser_action'){const {task_id,request_id,allow_personal,action,...rest}=args;return driver.execute(action==='select'?'select_value':action,{...rest,operation_key:'real:'+ ++request});}
  if(name==='browser_tabs'){const {task_id,request_id,allow_personal,action,...rest}=args;return driver.execute(action,{...rest,operation_key:'real:'+ ++request});}
  throw Error('unexpected '+name);
 };
 const make=(lang)=>new ToolsRefresher({distribution:storeTestDistribution(),expected:refreshExpected,targetIdentity:()=>({app_id:'plugin_test_'+lang.toLowerCase().replace('-','_'),detail_url:server.base+'/settings/plugins-settings/plugin_test_'+lang.toLowerCase().replace('-','_')}),observeMs:3000,invoke,seen,names,pluginsUrl:server.base+'/settings/plugins-settings',urls:[server.base+'/settings/plugins-settings?lang='+encodeURIComponent(lang)],pageWaitMs:8000,detailWaitMs:5000,toolsListWaitMs:4000,helperWaitMs:5000,helperManualWaitMs:5000});

 await t.test('中文走内置快路，只点 ChatHand 和刷新工具，点击回执有真实位置',async()=>{
  const before=clicks().length,r=await make('zh-CN').run();
  assert.equal(r.state,'refreshed');assert.deepEqual(clicks().slice(before),['ChatHand','刷新工具']);
  for(const key of ['open_entry','click']){const s=r.steps.find(x=>x.step===key);assert.ok(s?.target?.name);assert.ok(s.box?.width>0&&s.box?.height>0);assert.ok(Number.isFinite(s.point?.x)&&Number.isFinite(s.point?.y));}
 });

 await t.test('英文先 needs_ai，选 Refresh tools 后刷新并学习；下一遍直接快路',async()=>{
  const rfr=make('en-US'),r=await rfr.run();assert.equal(r.state,'needs_ai');assert.ok(r.buttons.some(x=>x.name==='Refresh tools'&&x.box?.width>0));
  for(const bad of ['Uninstall','Delete app','Edit','Rename ChatHand (not linked)'])assert.equal(r.buttons.some(x=>x.name===bad),false,bad);
  const good=r.buttons.find(x=>x.name==='Refresh tools'),rr=await rfr.clickByNumber({number:good.number,meaning:'refresh tools'});assert.equal(rr.state,'refreshed');assert.deepEqual(learned['en-us'],['Refresh tools']);
  const before=clicks().length,fast=await make('en-US').run();assert.equal(fast.state,'refreshed');assert.deepEqual(clicks().slice(before),['ChatHand','Refresh tools']);
 });

 await t.test('日文交给 ChatGPT 认；日文删除按钮也会出现在候选里，选更新后成功',async()=>{
  const rfr=make('ja-JP'),r=await rfr.run();assert.equal(r.state,'needs_ai');
  assert.ok(r.buttons.some(x=>x.name==='ツールを更新'));assert.ok(r.buttons.some(x=>x.name==='アプリを削除'));
  const good=r.buttons.find(x=>x.name==='ツールを更新'),rr=await rfr.clickByNumber({number:good.number,meaning:'ツールを更新 = update tools'});
  assert.equal(rr.state,'refreshed');assert.deepEqual(learned['ja-jp'],['ツールを更新']);
 });

 await t.test('即使把真实英文 Delete app 塞回待选编号，危险词守门也不点；随后正确按钮还能成功',async()=>{
  // Use a fresh English label that is not learned for this refresher.
  delete learned['en-us'];const rfr=make('en-US'),r=await rfr.run();assert.equal(r.state,'needs_ai');
  const found=await invoke('browser_find',{task_id:'probe',page_id:rfr.pending.page,role:'button',text:'Delete app',exact:true,limit:10,boxes:true});
  assert.equal(found.elements.length,1);const ref=found.elements[0].ref,n=30;rfr.pending.buttons.push({number:n,ref,role:'button',name:'Delete app',box:found.elements[0].box});
  const before=clicks().filter(x=>x==='Delete app').length;
  assert.throws(()=>rfr.clickByNumber({number:n,meaning:'delete app'}),e=>e.code==='TOOLS_REFRESH_DANGEROUS');
  assert.equal(clicks().filter(x=>x==='Delete app').length,before);assert.equal(rfr.snapshot().state,'needs_ai');
  const good=r.buttons.find(x=>x.name==='Refresh tools'),rr=await rfr.clickByNumber({number:good.number,meaning:'refresh tools'});assert.equal(rr.state,'refreshed');
 });
});
