import {storeBrowserFixture,storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';
const ExtensionBrowser=storeBrowserFixture(ProductionExtensionBrowser);
const desktop=t=>productionDesktop(t,{chromeDistribution:storeTestDistribution(),extensionHelper:storeTestHelper()});
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {desktop as productionDesktop} from './1052-a-fixture.mjs';
import {ExtensionBrowser as ProductionExtensionBrowser} from '../../app/v09/extension-browser.mjs';

function fixture(t) {
 const state={data:{mode:'full',browser_enabled:true},save(){}};
 const policy={epoch:'fixture-epoch',permissionRevision:0,check(){},require(id,caller){
  assert.equal(id,'fixture-task');assert.ok(['chatgpt','local-mcp'].includes(caller));
 },tasks:new Map()};
 const ext=new ExtensionBrowser(state,{},policy),session=crypto.randomUUID();
 ext.heartbeat(session);ext.pauseRequested=false;t.after(()=>ext.closeAll());
 return {ext,session,state,policy};
}
test('idle authenticated caller classes can hand off a task on the same extension session',async t=>{
 const {ext,session}=fixture(t),generation=ext.epoch;
 for(const caller of ['chatgpt','local-mcp','chatgpt']){
  const result=ext.tabs({task_id:'fixture-task',action:'list'},caller);
  const request=ext.next(session);if(request.kind!=='request')await result;assert.equal(request.kind,'request');
  assert.equal(ext.authorize(session,request.id).authorized,true);
  assert.deepEqual(ext.complete(session,request.id,{tabs:[{page_id:'7'}]}),{accepted:true});
  assert.equal((await result).tabs[0].page_id,generation+':7');
  assert.equal(ext.pending.size,0);
 }
 assert.equal(ext.session,session);assert.equal(ext.epoch,generation);
});

test('exclusivity lasts until every request from the current caller has settled',async t=>{
 const {ext,session}=fixture(t);
 const first=ext.request('tabs',{},'chatgpt','fixture-task');
 const second=ext.request('snapshot',{page_id:'7'},'chatgpt','fixture-task');
 const rejected=assert.rejects(second,{code:'BROWSER_ACTION_FAILED'});
 assert.throws(()=>ext.request('tabs',{},'local-mcp','fixture-task'),{code:'BROWSER_IN_USE'});
 const one=ext.next(session),two=ext.next(session);
 ext.complete(session,one.id,{});await first;
 assert.equal(ext.owner,'chatgpt');
 assert.throws(()=>ext.request('tabs',{},'local-mcp','fixture-task'),{code:'BROWSER_IN_USE'});
 ext.complete(session,two.id,null,{code:'BROWSER_ACTION_FAILED'});await rejected;
 assert.equal(ext.owner,null);assert.equal(ext.pending.size,0);
 const next=ext.request('tabs',{},'local-mcp','fixture-task'),request=ext.next(session);
 ext.complete(session,request.id,{});await next;
});
test('a discovery probe also protects its actual pending work without durable ownership',async t=>{
 const {ext,session}=fixture(t);
 const probe=ext.request('detect_generating_chat',{},'chatgpt','fixture-task');
 assert.equal(ext.owner,null);
 assert.throws(()=>ext.request('tabs',{},'local-mcp','fixture-task'),{code:'BROWSER_IN_USE'});
 const request=ext.next(session);ext.complete(session,request.id,{url:null});await probe;
 const next=ext.request('tabs',{},'local-mcp','fixture-task'),r=ext.next(session);
 ext.complete(session,r.id,{});await next;
});
test('unknown, undelivered and stale-generation replies cannot release a pending caller',async t=>{
 const {ext,session}=fixture(t),pending=ext.request('snapshot',{page_id:'7'},'chatgpt','fixture-task');
 const id=[...ext.pending.keys()][0];
 assert.deepEqual(ext.complete(session,id,{}),{discarded:true});
 const request=ext.next(session),p=ext.pending.get(request.id),generation=p.generation;
 assert.deepEqual(ext.complete(session,crypto.randomUUID(),{}),{discarded:true});
 p.generation='old-generation';
 assert.throws(()=>ext.authorize(session,id),{code:'BROWSER_REQUEST_EXPIRED'});
 assert.deepEqual(ext.complete(session,id,{}),{discarded:true});
 assert.throws(()=>ext.request('tabs',{},'local-mcp','fixture-task'),{code:'BROWSER_IN_USE'});
 p.generation=generation;ext.complete(session,id,{});await pending;
 assert.equal(ext.owner,null);
});
test('handoff keeps profile, target generation and session checks',async t=>{
 const {ext,session}=fixture(t),generation=ext.epoch;
 const pending=ext.request('tabs',{},'chatgpt','fixture-task'),request=ext.next(session);
 assert.throws(()=>ext.complete(crypto.randomUUID(),request.id,{}),{code:'EXTENSION_PROFILE_BUSY'});
 assert.equal(ext.pending.size,1);
 ext.complete(session,request.id,{});await pending;
 assert.throws(()=>ext.heartbeat(crypto.randomUUID()),{code:'EXTENSION_PROFILE_BUSY'});
 assert.throws(()=>ext.heartbeat('untrusted-session'),{code:'EXTENSION_SESSION_INVALID'});
 await assert.rejects(ext.snapshot({task_id:'fixture-task',page_id:'stale:7'},'local-mcp'),{code:'BROWSER_PAGE_MISSING'});
 assert.equal(ext.decode(generation+':7'),'7');assert.equal(ext.session,session);assert.equal(ext.epoch,generation);
});
for(const change of ['capability','revision','epoch','deadline'])test('pending '+change+' validation still rejects and clears idle ownership',async t=>{
 const {ext,session,state,policy}=fixture(t),pending=ext.request('tabs',{},'chatgpt','fixture-task');
 const request=ext.next(session),code=change==='deadline'?'BROWSER_TIMEOUT':'TASK_REVOKED';
 const rejected=assert.rejects(pending,{code});
 if(change==='capability')state.data.browser_enabled=false;
 if(change==='revision')policy.permissionRevision++;
 if(change==='epoch')policy.epoch='changed';
 if(change==='deadline')ext.pending.get(request.id).deadline=Date.now()-1;
 assert.deepEqual(ext.complete(session,request.id,{}),{discarded:true});await rejected;
 assert.equal(ext.owner,null);assert.equal(ext.pending.size,0);
 if(change==='capability')assert.throws(()=>ext.request('tabs',{},'local-mcp','fixture-task'),{code:'CAPABILITY_OFF'});
});
test('explicit user stop persists across idle caller handoff until explicit resume',async t=>{
 const {ext,session}=fixture(t),pending=ext.request('snapshot',{page_id:'7'},'chatgpt','fixture-task');
 const rejected=assert.rejects(pending,{code:'BROWSER_USER_ACTIVE'}),request=ext.next(session);
 ext.userStop('fixture-task');
 await rejected;assert.equal(ext.owner,null);
 assert.deepEqual(ext.complete(session,request.id,{}),{discarded:true});
 for(const caller of ['chatgpt','local-mcp'])
  assert.throws(()=>ext.request('snapshot',{page_id:'7'},caller,'fixture-task'),{code:'BROWSER_USER_ACTIVE'});
 ext.userResume('fixture-task');
 const resumed=ext.request('snapshot',{page_id:'7'},'local-mcp','fixture-task'),r=ext.next(session);
 ext.complete(session,r.id,{});await resumed;
});

test('authenticated loopback ingress hands one task from chatgpt to local-mcp with fake extension replies',async t=>{
 const f=await desktop(t),a=f.app,task_id=await f.begin();
 a.state.data.browser_enabled=true;
 const ext=a.tools.automation.browser.extension,session=crypto.randomUUID();
 ext.heartbeat(session);ext.pauseRequested=false;
 const request=async token=>{
  const r=await fetch('http://127.0.0.1:'+a.mcpPort+'/mcp',{method:'POST',
   headers:{'Content-Type':'application/json','X-Ken-Bridge-Token':token,Accept:'application/json, text/event-stream','Mcp-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'browser_tabs'},
   body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',
    params:{name:'browser_tabs',arguments:{task_id,request_id:crypto.randomUUID(),action:'list'},
     _meta:{'openai/session':'fake-handoff-session','io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})
  });
  return {status:r.status,body:await r.json()};
 };
 assert.equal((await request('invalid-synthetic-token')).status,401);
 for(const [token,caller] of [[a.mcpToken,'chatgpt'],[a.localToken,'local-mcp']]){
  let reply;const pending=request(token).then(v=>{reply=v;return v;});
  const until=Date.now()+1000;
  while(!ext.pending.size&&!reply&&Date.now()<until)await new Promise(r=>setTimeout(r,2));
  if(!ext.pending.size)t.diagnostic(JSON.stringify({caller,backend:a.state.data.browser_backend,reply,trace:a.tools.trace.entries.slice(-12).map(({event,tool,code})=>({event,tool,code}))}));
  assert.equal(ext.pending.size,1,reply?.body?.result?.structuredContent?.code||'fake ingress must enqueue');
  assert.equal([...ext.pending.values()][0].caller,caller);
  const r=ext.next(session);assert.equal(ext.authorize(session,r.id).authorized,true);
  ext.complete(session,r.id,{tabs:[{page_id:'7'}]});
  const result=await pending;assert.equal(result.status,200);assert.equal(result.body.result.isError,false);
  assert.equal(result.body.result.structuredContent.tabs[0].page_id,ext.epoch+':7');
  assert.equal(ext.pending.size,0);
 }
 assert.equal(a.policy.get(task_id).status,'active');assert.equal(ext.session,session);
});
