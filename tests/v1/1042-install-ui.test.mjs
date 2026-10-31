import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import catalogs from '../../ui/local-text-catalogs.mjs';

const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
const localText=fs.readFileSync(new URL('../../ui/local-text.js',import.meta.url),'utf8');
function fixture(replies=[]){
 const views=[],calls=[],timers=new Map(),dialog={open:false,dataset:{}};let next=0;
 const S={settings:{browser_enabled:false},automation:{browser:{extension:{distribution:'chrome_web_store',store_published:true,configuration_state:'ready'},personal:{chrome:{installed:true,major:140}}}}};
 const context=vm.createContext({S,Date,window:{},document:{documentElement:{dataset:{}}},setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(localText,context);
 context.window.ChatHandText=context.ChatHandText;
 context.ChatHandText.installCatalogs({locale:'zh',catalogs});
 const E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 context.E=E;context.T=(k,p={})=>context.ChatHandText.t(k,p);context.TH=(k,p={})=>context.ChatHandText.html(k,Object.fromEntries(Object.entries(p).map(([k,v])=>[k,context.ChatHandText.trusted(v)])));
 context.btn=(text,action,id='',cls='')=>`[${text}|${action}|${id}|${cls}]`;context.tbtn=(text,action,id='')=>`{${text}|${action}|${id}}`;
 context.modal=(html,kind)=>{views.push({html,kind});dialog.open=true;dialog.dataset.kind=kind;};context.$=()=>dialog;context.closeModal=async cancel=>{calls.push(['closeModal',cancel]);dialog.open=false;};context.toast=()=>{};context.refresh=async()=>{};context.capOn=k=>S.settings[k]===true;context.extensionSuccessToast=async()=>{};
 context.api=async(route,body)=>{calls.push(['api',route,body]);if(route==='/api/settings')Object.assign(S.settings,body);if(route==='/api/browser/extension/store/status')return {connected:false};return {};};
 context.native=async(action,data)=>{calls.push(['native',action,data]);const r=replies.length?replies.shift():{opened:true,selected_profile:'Default',profiles:[{id:'Default',name:'Ken'}]};return typeof r==='function'?r():r;};
 vm.runInContext(source.slice(source.indexOf('let chromeInstallView='),source.indexOf('function desktopSheet()')),context);
 const cases=source.slice(source.indexOf(" case'extensionSetup':"),source.indexOf(" case'revealHelperFolder':"));vm.runInContext('async function perform(name,id=""){switch(name){'+cases+'}}',context);
 return {context,S,views,calls,timers,dialog,run:(name,id)=>context.perform(name,id),last:()=>views.at(-1)};
}
test('1042 extensionSetup shows the Chrome Web Store intro without preparing or changing settings',async()=>{
 const f=fixture();await f.run('extensionSetup');assert.deepEqual(f.calls,[]);assert.equal(f.S.settings.browser_enabled,false);assert.match(f.last().html,/浏览器控制需要安装 Chrome 插件/);assert.match(f.last().html,/打开 Chrome\|chromeStoreOpen/);assert.doesNotMatch(f.last().html,/手动安装|extensionManual/);
});
test('1042 opening Chrome is a separate action and late completion after cancellation cannot reopen the UI',async()=>{
 for(const late of [{opened:true,selected_profile:'Default'},{error_code:'CHROME_STORE_OPEN_FAILED'}]){let release;const f=fixture([()=>new Promise(r=>{release=r;})]);const pending=f.run('chromeStoreOpen');await new Promise(r=>setImmediate(r));assert.match(f.last().html,/正在打开/);assert.equal(f.calls.some(x=>x[0]==='native'&&x[1]==='openChromeStore'),true);await f.run('extensionCancel');const count=f.views.length;release(late);await pending;assert.equal(f.views.length,count);assert.equal(f.timers.size,0);assert.ok(f.calls.some(x=>x[0]==='native'&&x[1]==='extensionCancel'));}
});
test('1042 tool-block card offers the install entry only for install requests and keeps reconnect separate',()=>{
 const f=fixture();Object.assign(f.context,{allTasks:()=>[],CHATGPT_URL:'https://chatgpt.com/',midText:String,ibtn:()=>'',icon:()=>''});vm.runInContext(source.slice(source.indexOf('function blockCard('),source.indexOf(" if(b.kind==='high_risk'",source.indexOf('function blockCard(')))+'return "";}',f.context);
 const install=f.context.blockCard({blocked:{kind:'needs_user',gate:'browser_helper',item:{id:'install'},say_to_user:['需要助手','用平时的Chrome','由本人确认']}});assert.match(install,/安装 Chrome 插件/);
 const other=f.context.blockCard({blocked:{kind:'needs_user',gate:'browser_helper',item:{id:'connect'}}});assert.doesNotMatch(other,/安装 Chrome 插件/);
});
test('1042 known policy block does not offer a manual bypass; missing/old Chrome uses the recovery action',()=>{
 const f=fixture();vm.runInContext("showChromeInstall({phase:'stopped',code:'CHROME_INSTALL_MANAGED_POLICY_BLOCKED'})",f.context);assert.match(f.last().html,/管理策略禁止/);assert.doesNotMatch(f.last().html,/手动安装/);
 vm.runInContext("showChromeInstall({phase:'stopped',code:'CHROME_INSTALL_CHROME_TOO_OLD'})",f.context);assert.match(f.last().html,/更新 Chrome/);
 vm.runInContext("showChromeInstall({phase:'stopped',code:'CHROME_INSTALL_CHROME_UNAVAILABLE'})",f.context);assert.match(f.last().html,/下载 Chrome/);
});
