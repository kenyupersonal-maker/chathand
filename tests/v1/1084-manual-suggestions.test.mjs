import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {macModel} from '../../app/v1/client-features.mjs';
import {createDesktop} from '../../app/server.mjs';
import {t as translate} from '../../app/i18n.mjs';

test('Mac model uses the hardware product name and safely falls back',()=>{
 const reply=JSON.stringify({SPHardwareDataType:[{machine_name:'  MacBook Pro  ',serial_number:'not-for-display'}]});
 assert.equal(macModel({platform:'darwin',exec:()=>reply}),'MacBook Pro');
 assert.equal(macModel({platform:'darwin',exec:()=>'{'}),'Mac');
 assert.equal(macModel({platform:'darwin',exec:()=>{throw Error('unavailable');}}),'Mac');
 assert.equal(macModel({platform:'darwin',exec:()=>JSON.stringify({SPHardwareDataType:[{}]})}),'Mac');
 assert.equal(macModel({platform:'linux',exec:()=>{throw Error('must not run');}}),'Mac');
});

test('the model is present in both the state response and live updates',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-model-fixture-')));
 let calls=0,app;
 t.after(async()=>{if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});});
 app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),uiKey:'a'.repeat(64),
  adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{macModel:()=>{calls++;return 'MacBook Pro';}}});
 assert.equal((await app.snapshot()).setup.device_model,'MacBook Pro');
 const abort=new AbortController();t.after(()=>abort.abort());
 const response=await fetch('http://127.0.0.1:'+app.apiPort+'/api/events',{headers:{authorization:'Bearer '+app.adminToken,'x-chathand-ui':app.uiKey},signal:abort.signal});
 assert.equal(response.status,200);
 const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
 while(!text.includes('event: state')){const chunk=await reader.read();assert.equal(chunk.done,false);text+=decoder.decode(chunk.value,{stream:true});}
 assert.match(text,/"device_model":"MacBook Pro"/);
 assert.equal(calls,1,'the hardware model is read only once');
 abort.abort();
});

function wizardHarness(locale,model,step){
 const source=fs.readFileSync(new URL('../../ui/wizard.js',import.meta.url),'utf8');
 const tutorial=JSON.parse(fs.readFileSync(new URL('../../ui/assets/tutorial/tutorial.json',import.meta.url),'utf8'));
 const clicks=[],copied=[],next={disabled:false},dialog={addEventListener(){},getBoundingClientRect(){return {left:0,right:0,top:0,bottom:0};}};
 const box={hidden:true,innerHTML:'',dataset:{},setAttribute(){},addEventListener(type,fn){if(type==='click')clicks.push(fn);},
  querySelector(q){return q==='#wizardNext'&&this.innerHTML.includes('id="wizardNext"')?next:null;},querySelectorAll(){return [];}};
 const text=(key,params={})=>translate(key,params,locale);
 const sandbox={S:{settings:{setup_step:step},setup:{device_model:model},credentials:{tunnel:true}},
  window:{ChatHandText:{t:text,subscribe(){}},addEventListener(){}},
  document:{createElement:tag=>tag==='section'?box:dialog,body:{append(){}},querySelector:()=>({inert:false})},
  fetch:async()=>({json:async()=>tutorial}),native:async(name,value)=>{if(name==='copyText')copied.push(value.text);return {};},
  toast(){},api:async()=>({}),connected:()=>false,connectionText:()=>'',E:value=>String(value??''),
  navigator:{clipboard:{writeText:async value=>copied.push(value)}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},
  userMessage:e=>e.message};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);
 const click=async({page,action})=>{
  const target={closest(selector){
   if(selector==='[data-sub]'&&page!==undefined)return {dataset:{sub:String(page)}};
   if(selector==='[data-wizard]'&&action)return {dataset:{wizard:action}};
   return null;
  }};
  for(const fn of clicks)await fn({target});
 };
 return {box,copied,start:()=>sandbox.window.startWizard(),click};
}

test('manual guidance shows and copies the localized tunnel and runtime-key names',async()=>{
 for(const [lang,name,description,key] of [
  ['zh','ChatHand MacBook Pro - 通道','用于通过 ChatHand 连接这台 Mac 和 ChatGPT。','ChatHand MacBook Pro - 运行密钥'],
  ['en','ChatHand MacBook Pro - Tunnel','Connects this Mac to ChatGPT through ChatHand.','ChatHand MacBook Pro - Runtime Key']
 ]){
  const tunnel=wizardHarness(lang,'MacBook Pro',0);await tunnel.start();await tunnel.click({page:1});
  assert.ok(tunnel.box.innerHTML.includes(name));assert.ok(tunnel.box.innerHTML.includes(description));
  assert.equal((tunnel.box.innerHTML.match(/class="wiz-copy-icon"/g)||[]).length,2);
  await tunnel.click({action:'copySuggestedTunnelName'});await tunnel.click({action:'copySuggestedTunnelDescription'});
  assert.deepEqual(tunnel.copied,[name,description]);
  await tunnel.click({page:2});assert.ok(tunnel.box.innerHTML.includes(translate('ui.wizard.tutorial.tunnel.oneWorkspaceHint',{},lang)));
  const runtime=wizardHarness(lang,'MacBook Pro',1);await runtime.start();await runtime.click({page:1});
  assert.ok(runtime.box.innerHTML.includes(key));
  await runtime.click({action:'copySuggestedRuntimeKeyName'});assert.deepEqual(runtime.copied,[key]);
 }
 const fallback=wizardHarness('zh',null,0);await fallback.start();await fallback.click({page:1});
 assert.ok(fallback.box.innerHTML.includes('ChatHand Mac - 通道'));
});
