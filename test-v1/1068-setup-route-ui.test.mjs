import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=file=>fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
const app=read('ui/app.js'),host=read('ui/h10/host.mjs'),wizard=read('ui/wizard.js');
// 1083（Claude，Ken 10/28 21:38）：没选过连接方式时默认 OpenAI 通道，原来是 Site。
test('fresh setup uses the OpenAI Tunnel as its default view; a saved setup choice or an existing connection still decides',()=>{
 const box=vm.createContext({S:{setup_route:'none',site_b:{selected:'openai',routes:{}}}});
 vm.runInContext(app.slice(app.indexOf('function selectedConnection()'),app.indexOf('function siteConfigured()')),box);
 assert.equal(box.selectedConnection(),'openai');
 box.S.setup_route='openai';assert.equal(box.selectedConnection(),'openai');
 box.S.setup_route='site';assert.equal(box.selectedConnection(),'site');
 box.S.site_b.routes.openai={configured:true};assert.equal(box.selectedConnection(),'openai','a pending setup preference never reroutes an existing connection');
 box.S.site_b.selected='site';box.S.setup_route='openai';assert.equal(box.selectedConnection(),'site');
});
test('H10 restarts use the saved setup choice, while unselected installs default to the OpenAI Tunnel unless the setup assistant already started Site pairing',()=>{
 const box=vm.createContext({window:{}}),start=wizard.indexOf('window.h10Entry=state=>{'),end=wizard.indexOf('window.wizardRefresh=state=>{',start);
 vm.runInContext(wizard.slice(start,end),box);
 for(const installed of [true,false])for(const choice of ['none','site','openai']){
  const result=box.window.h10Entry({setup_route:choice,settings:{},setup_skill:{installed},site_b:{selected:'openai',routes:{}}});
  assert.equal(result.route,choice==='site'?'site':'openai');
  assert.equal(result.screen,installed?'f7':'f6');
 }
 // 没选过，但配置助手已经开过 Site 配对（记了 setup_site_select_on_pair，或者正在配对）：照 Site 走。
 for(const extra of [{settings:{setup_site_select_on_pair:true}},{settings:{},site_b:{selected:'openai',routes:{},pairing:{phase:'pairing'}}},{settings:{},site_b:{selected:'openai',routes:{},pairing:{phase:'awaiting_pairing'}}}])
  assert.equal(box.window.h10Entry({setup_route:'none',setup_skill:{installed:true},site_b:{selected:'openai',routes:{}},...extra}).route,'site');
 assert.equal(box.window.h10Entry({setup_route:'none',settings:{setup_tunnel_id:'tun_8c41d2a7'},setup_skill:{installed:true},site_b:{selected:'openai',routes:{}}}).route,'openai');
 assert.equal(box.window.h10Entry({setup_route:'openai',settings:{},site_b:{routes:{openai:{configured:true}}}}),null);
});
test('route confirmation persists setup intent even for the default route and does not switch an unconfigured execution route',async()=>{
 const source=host.slice(host.indexOf('async function switchRoute(desired){'),host.indexOf("actions.addEventListener('click'",host.indexOf('async function switchRoute(desired){')));
 for(const desired of ['site','openai']){
  const calls=[],box=vm.createContext({busy:false,route:'site',routeChosen:false,screen:'f6',noticeText:'',
   bState:()=>({selected:'openai',routes:{}}),isHealthy:()=>false,siteCreatable:()=>true,
   routeName:x=>x,uiText:x=>x,api:async(p,b)=>{calls.push([p,b]);return {selected_route:b.route};},
   bridge:()=>({}),toastText:()=>{},render:()=>{},safeCode:e=>e.code});
  vm.runInContext(source,box);await box.switchRoute(desired);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['/api/setup/route',{route:desired}]]);
  assert.equal(box.route,desired);assert.equal(box.routeChosen,true);assert.equal(box.busy,false);
 }
 const box=vm.createContext({busy:false,route:'site',routeChosen:false,screen:'f6',noticeText:'',bState:()=>({}),isHealthy:()=>false,siteCreatable:()=>true,routeName:x=>x,uiText:(k,p)=>k+':'+p.code,
  api:async()=>{throw {code:'SAVE_FAILED'};},bridge:()=>({}),toastText:()=>{},render:()=>{},safeCode:e=>e.code});
 vm.runInContext(source,box);await box.switchRoute('openai');
 assert.equal(box.route,'site');assert.equal(box.routeChosen,false);assert.equal(box.busy,false);assert.match(box.noticeText,/SAVE_FAILED/);
});
