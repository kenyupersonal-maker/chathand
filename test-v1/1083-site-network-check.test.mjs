import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createSiteNetworkCheck,SITE_NETWORK_PROBE_URL} from '../app/v1/site-network-check.mjs';
import {fixture,deferred} from './1070-chrome-server-fixture.mjs';

const response=(status,headers={})=>({status,headers:new Headers(headers),body:{cancel:async()=>{}}});

test('network check classifies response without sending identity or reading content',async()=>{
 for(const [status,headers,expected] of [[403,{'cf-mitigated':'challenge'},'challenged'],[403,{},'clear'],[200,{},'clear'],[404,{},'clear'],[301,{},'clear']]){
  let request;
  const check=createSiteNetworkCheck({now:()=>123,fetchImpl:async(url,options)=>{request={url,options};return response(status,headers);}});
  assert.deepEqual(await check(),{result:expected,checked_at:123,http_status:status});
  assert.equal(request.url,SITE_NETWORK_PROBE_URL);assert.equal(request.options.method,'GET');
  assert.equal(request.options.redirect,'manual');assert.equal(request.options.cache,'no-store');assert.equal(request.options.credentials,'omit');
  assert.equal(request.options.headers,undefined);assert.ok(request.options.signal instanceof AbortSignal);
 }
});
test('network errors and timeout expose only the two promised error codes',async()=>{
 const disconnected=createSiteNetworkCheck({now:()=>456,fetchImpl:async()=>{throw Error('private error text');}});
 assert.deepEqual(await disconnected(),{result:'unreachable',checked_at:456,error_code:'B_SITE_NETWORK_FAILED'});
 let signal;const timed=createSiteNetworkCheck({now:()=>789,timeoutMs:15,fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
 assert.deepEqual(await timed(),{result:'unreachable',checked_at:789,error_code:'B_SITE_REQUEST_TIMEOUT'});assert.equal(signal.aborted,true);
});
test('cache expires after 60 seconds, force checks again, and sites have separate entries',async()=>{
 let at=1000,calls=[];const check=createSiteNetworkCheck({now:()=>at,fetchImpl:async(url)=>{calls.push(url);return response(200);}});
 const first=await check();at+=59999;assert.deepEqual(await check(),first);assert.equal(calls.length,1);
 at++;assert.equal((await check()).checked_at,at);assert.equal(calls.length,2);
 await check({force:true});assert.equal(calls.length,3);
 await check({origin:'https://fixture.chatgpt.site'});assert.equal(calls.at(-1),'https://fixture.chatgpt.site/health');assert.equal(calls.length,4);
 assert.deepEqual(await check({origin:'https://evil.example'}),{result:'unreachable',checked_at:at,error_code:'B_SITE_NETWORK_FAILED'});assert.equal(calls.length,4);
});
test('concurrent callers share work and a force refresh cannot be overwritten by a late response',async()=>{
 const first=deferred(),second=deferred();let calls=0,at=1;
 const check=createSiteNetworkCheck({now:()=>at,fetchImpl:()=>++calls===1?first.promise:second.promise});
 const a=check(),b=check();await Promise.resolve();assert.equal(calls,1);
 at=2;const c=check({force:true});await Promise.resolve();assert.equal(calls,2);second.resolve(response(403,{'cf-mitigated':'challenge'}));assert.equal((await c).result,'challenged');
 at=3;first.resolve(response(200));assert.equal((await a).result,'challenged');assert.equal((await b).result,'challenged');
 assert.equal((await check()).result,'challenged');assert.equal(calls,2);
});

function effects(f){
 const a=f.app,local=a.tools.bSiteLocalStore,s=a.state.data;
 return {selection:local.selection(),intent:local.db.prepare('SELECT * FROM b_setup_intent').all(),pairIntents:local.db.prepare('SELECT * FROM b_pair_intents').all(),
  watch:s.setup_site_watch??null,selectOnPair:s.setup_site_select_on_pair??null,activity:JSON.parse(JSON.stringify((s.setup_activity??null))),
  installed:fs.existsSync(path.join(f.root,'state/integration-home/.codex/skills/chathand-setup'))};
}
for(const [label,fetchImpl,code] of [
 ['challenge',async()=>response(403,{'cf-mitigated':'challenge'}),'SITE_NETWORK_CHALLENGED'],
 ['unreachable',async()=>{throw Error('private network details');},'SITE_NETWORK_UNREACHABLE']
]){
 test(`${label} blocks new Site start and setup/add handoffs before any side effect`,async t=>{
  const f=fixture(t,{preference:'none',siteNetworkFetch:fetchImpl});await f.building;const before=effects(f),activity=(await f.app.snapshot()).setup_activity;
  for(const [route,body] of [['/api/setup/site/start',{}],['/api/setup/skill',{route:'site',intent:'setup'}],['/api/setup/skill',{route:'site',intent:'add'}]]){
   const result=await f.post(route,body);assert.equal(result.body.error.code,code);
   assert.equal(result.body.error.message,code==='SITE_NETWORK_CHALLENGED'?'这台 Mac 当前的网络会被 Site 的网络验证（Cloudflare）拦截，多半是在用代理或 VPN。请改用 OpenAI 通道，或关闭代理或 VPN 后重试。':'无法连接 ChatGPT Site，请检查网络后重试，或改用 OpenAI 通道。');
   assert.deepEqual(effects(f),before);assert.deepEqual((await f.app.snapshot()).setup_activity,activity);
  }
 });
}
test('network API requires owner, validates input and uses configured Site origin',async t=>{
 const calls=[];const f=fixture(t,{preference:'none',siteNetworkFetch:async(url,options)=>{calls.push({url,options});return response(401);}});await f.building;
 assert.equal((await f.post('/api/setup/site/network-check',{}, {owner:false})).status,401);assert.equal(calls.length,0);
 for(const value of [{force:false},{force:true,other:1},{url:'https://evil.example'}])assert.equal((await f.post('/api/setup/site/network-check',value)).body.error.code,'ARG_INVALID');
 assert.equal((await f.post('/api/setup/site/network-check',{})).body.result,'clear');assert.equal(calls[0].url,SITE_NETWORK_PROBE_URL);
 const local=f.app.tools.bSiteLocalStore;local.db.prepare("UPDATE b_routes SET configured=1,site_id=?,owner_subject=?,binding_id=?,generation=? WHERE route='site'").run('fixture-site','fixture-owner','fixture-binding',1);
 f.values.set('site_b',{installation_id:local.installationId,site_id:'fixture-site',owner_subject:'fixture-owner',binding_id:'fixture-binding',generation:1,site_origin:'https://fixture.chatgpt.site'});
 const result=await f.post('/api/setup/site/network-check',{});assert.deepEqual(result.body,{result:'clear',checked_at:result.body.checked_at,http_status:401});
 assert.equal(calls[1].url,'https://fixture.chatgpt.site/health');assert.equal(calls[1].options.headers,undefined);
 await f.post('/api/setup/site/network-check',{});assert.equal(calls.length,2);await f.post('/api/setup/site/network-check',{force:true});assert.equal(calls.length,3);
});
test('repair, already configured Site and OpenAI setup skip the check',async t=>{
 let calls=0;const f=fixture(t,{preference:'none',siteNetworkFetch:async()=>{calls++;throw Error('must not be reached');}});await f.building;
 const a=f.app,local=a.tools.bSiteLocalStore;
 assert.equal((await a.handle('/api/setup/skill',{route:'openai',intent:'setup'})).route,'openai');assert.equal(calls,0);
 local.db.prepare("UPDATE b_routes SET configured=1,site_id=?,owner_subject=?,binding_id=?,generation=? WHERE route='site'").run('fixture-site','fixture-owner','fixture-binding',1);
 f.values.set('site_b',{installation_id:local.installationId,site_id:'fixture-site',owner_subject:'fixture-owner',binding_id:'fixture-binding',generation:1,site_origin:'https://fixture.chatgpt.site'});
 for(const intent of ['setup','add','repair'])assert.equal((await a.handle('/api/setup/skill',{route:'site',intent})).route,'site');
 await a.handle('/api/setup/site/start',{}).catch(()=>{});assert.equal(calls,0);
});
test('changing the setup route while the network request is pending prevents a late Site start',async t=>{
 const wait=deferred(),f=fixture(t,{preference:'none',siteNetworkFetch:()=>wait.promise});await f.building;
 const pending=f.app.handle('/api/setup/site/start',{});await Promise.resolve();await f.app.handle('/api/setup/route',{route:'openai'});const before=effects(f);
 wait.resolve(response(200));await assert.rejects(pending,{code:'B_LIFECYCLE_CHANGED'});assert.deepEqual(effects(f),before);
});

test('failed results are cached and force can recover',async()=>{
 for(const first of [async()=>response(403,{'cf-mitigated':'challenge'}),async()=>{throw Error('offline');}]){
  let calls=0;const check=createSiteNetworkCheck({now:()=>1000,fetchImpl:async()=>++calls===1?first():response(200)});
  const result=await check();assert.notEqual(result.result,'clear');assert.deepEqual(await check(),result);assert.equal(calls,1);
  assert.equal((await check({force:true})).result,'clear');assert.equal(calls,2);
 }
});
test('default timeout is eight seconds and a late response cannot overwrite it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const wait=deferred();let settled=false;
 const check=createSiteNetworkCheck({now:()=>1000,fetchImpl:()=>wait.promise});
 const pending=check().then(value=>{settled=true;return value;});await Promise.resolve();
 t.mock.timers.tick(7999);await Promise.resolve();assert.equal(settled,false);
 t.mock.timers.tick(1);assert.deepEqual(await pending,{result:'unreachable',checked_at:1000,error_code:'B_SITE_REQUEST_TIMEOUT'});
 wait.resolve(response(200));await Promise.resolve();assert.equal((await check()).error_code,'B_SITE_REQUEST_TIMEOUT');
});
test('cancelling a pending Site start prevents it from starting later',async t=>{
 const wait=deferred(),f=fixture(t,{preference:'none',siteNetworkFetch:()=>wait.promise});await f.building;
 const pending=f.app.handle('/api/setup/site/start',{});await Promise.resolve();await f.app.handle('/api/site-b/enrollment/watch/stop',{});const before=effects(f);
 wait.resolve(response(200));await assert.rejects(pending,{code:'B_LIFECYCLE_CHANGED'});assert.deepEqual(effects(f),before);
});
test('closing while a Site start waits prevents a late start',async t=>{
 const wait=deferred(),f=fixture(t,{preference:'none',siteNetworkFetch:()=>wait.promise});await f.building;
 const pending=f.app.handle('/api/setup/site/start',{});await Promise.resolve();const closing=f.app.close();wait.resolve(response(200));
 await assert.rejects(pending,{code:'B_LIFECYCLE_CHANGED'});await closing;
});
test('switching route while a new Site skill handoff waits prevents installation',async t=>{
 const wait=deferred(),f=fixture(t,{preference:'none',siteNetworkFetch:()=>wait.promise});await f.building;
 const pending=f.app.handle('/api/setup/skill',{route:'site',intent:'add'});await Promise.resolve();await f.app.handle('/api/setup/route',{route:'openai'});const before=effects(f);
 wait.resolve(response(200));await assert.rejects(pending,{code:'B_LIFECYCLE_CHANGED'});assert.deepEqual(effects(f),before);
});
test('a refreshed challenge fences a Site start already waiting on an older check',async t=>{
 const old=deferred(),fresh=deferred();let calls=0;const f=fixture(t,{preference:'none',siteNetworkFetch:()=>++calls===1?old.promise:fresh.promise});await f.building;
 const pending=f.app.handle('/api/setup/site/start',{});await Promise.resolve();const forced=f.app.handle('/api/setup/site/network-check',{force:true});await Promise.resolve();
 fresh.resolve(response(403,{'cf-mitigated':'challenge'}));assert.equal((await forced).result,'challenged');const before=effects(f);
 old.resolve(response(200));await assert.rejects(pending,{code:'SITE_NETWORK_CHALLENGED'});assert.deepEqual(effects(f),before);
});
