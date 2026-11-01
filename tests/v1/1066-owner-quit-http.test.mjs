import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop,needsInterface} from '../../app/server.mjs';

// Exercise the actual HTTP owner/interface/upgrade guards; only external services are fake.
async function fixture(t,{ui=true,installState='idle'}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-owner-quit-'));
 const uiKey=ui?'a'.repeat(64):null;
 const credentials={get:()=>null,set(){},remove(){},status:()=>({healthy:true,tunnel:false,relay:false})};
 const tunnel={child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({ready:false,healthy:false,process_running:false})};
 const transport={setRpcDelivery(){},setRuntimeFactory(){},setHostFlow(){},close(){},stop(){},status:()=>({ready:false})};
 let authority,app;
 t.after(async()=>{if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});});
 app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),uiKey,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{credentials,bSiteTransport:transport,currentAppPath:path.join(root,'Fake.app'),computerName:()=> 'Synthetic Quit Mac',maintenanceClock:{now:Date.now,setInterval:()=>({unref(){}}),clearInterval(){}},tunnelFactory:()=>tunnel,updaterFactory:deps=>{authority=deps.lifecycleKey;return {snapshot:()=>({status:'unknown',install:{state:installState}}),forAI:()=>({status:'unknown'}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})};}}});
 const request=async({route='/api/lifecycle/quit',auth='owner',headers={},method='POST',body='{}'}={})=>{
  const authorization=auth==='owner'?app.adminToken:auth==='mcp'?app.mcpToken:auth==='wrong'?'wrong-owner-token':null;
  const response=await fetch(`http://127.0.0.1:${app.apiPort}${route}`,{method,headers:{...(authorization?{authorization:'Bearer '+authorization}:{}),'content-type':'application/json',...headers},...(method==='GET'?{}:{body})});
  return {status:response.status,body:await response.json()};
 };
 return {app,request,authority,uiHeaders:uiKey?{'X-ChatHand-UI':uiKey}:{},exited:async()=> (await app.snapshot()).lifecycle.exit_requested};
}

test('owner quit without upgrade header succeeds with or without a native interface credential',async t=>{
 assert.equal(needsInterface('/api/lifecycle/quit',{}),true);
 for(const ui of [true,false])for(const headers of [{},{'X-ChatHand-UI':'forged'}]){
  const f=await fixture(t,{ui});assert.equal(await f.exited(),false);
  assert.deepEqual(await f.request({headers}),{status:200,body:{accepted:true}});
  assert.equal(await f.exited(),true);
 }
});

test('missing, wrong and MCP owner credentials cannot quit even with valid UI and upgrade proof',async t=>{
 const f=await fixture(t,{installState:'installing'});
 for(const auth of ['none','wrong','mcp'])for(const headers of [{},{...f.uiHeaders,'X-ChatHand-Upgrade':f.authority}]){
  assert.deepEqual(await f.request({auth,headers}),{status:401,body:{error:'OWNER_AUTH_REQUIRED'}});
  assert.equal(await f.exited(),false);
 }
});

test('other window-only routes retain owner 403 and unchanged access/exit state',async t=>{
 const f=await fixture(t);await f.request({route:'/api/access',body:JSON.stringify({enabled:false})});
 for(const [route,body] of [['/api/access',{enabled:true}],['/api/setup/await-key',{}],['/api/relay/forget',{}],['/api/shutdown',{}],['/api/settings',{auto_update:false}]]){
  assert.equal(needsInterface(route,body),true);
  for(const headers of [{},{'X-ChatHand-UI':'forged'}]){
   const result=await f.request({route,body:JSON.stringify(body),headers});
   assert.equal(result.status,403,route);assert.equal(result.body.error.code,'UI_CONFIRM_REQUIRED',route);
  }
 }
 assert.equal(f.app.policy.enabled,false);assert.equal(await f.exited(),false);
});

test('present empty or forged upgrade headers never enter the owner-only quit exception',async t=>{
 for(const installState of ['idle','installing','restarting']){
  const f=await fixture(t,{installState});
  for(const value of ['', 'forged']){
   const result=await f.request({headers:{'X-ChatHand-Upgrade':value}});
   assert.equal(result.status,403);assert.equal(result.body.error.code,'UI_CONFIRM_REQUIRED');assert.equal(await f.exited(),false);
  }
 }
});

test('valid upgrade proof still requires installation/restart stage and never authorizes other routes',async t=>{
 const idle=await fixture(t);assert.equal((await idle.request({headers:{'X-ChatHand-Upgrade':idle.authority}})).status,403);assert.equal(await idle.exited(),false);
 for(const installState of ['installing','restarting']){
  const f=await fixture(t,{installState});
  const denied=await f.request({route:'/api/access',body:JSON.stringify({enabled:true}),headers:{'X-ChatHand-Upgrade':f.authority}});
  assert.equal(denied.status,403);assert.equal(denied.body.error.code,'UI_CONFIRM_REQUIRED');assert.equal(await f.exited(),false);
  assert.deepEqual(await f.request({headers:{'X-ChatHand-Upgrade':f.authority}}),{status:200,body:{accepted:true}});assert.equal(await f.exited(),true);
 }
});

test('existing valid native UI path remains available with present upgrade headers',async t=>{
 for(const value of ['', 'forged','valid']){
  const f=await fixture(t),headers={...f.uiHeaders,'X-ChatHand-Upgrade':value==='valid'?f.authority:value};
  assert.deepEqual(await f.request({headers}),{status:200,body:{accepted:true}});assert.equal(await f.exited(),true);
 }
});

test('owner quit exception remains behind POST, JSON content type and body validation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request({method:'GET'})).status,405);
 assert.equal((await f.request({headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await f.request({body:'{'})).status,400);
 assert.equal(await f.exited(),false);
});
