import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {desktop} from './1052-a-fixture.mjs';
import {locateRuntime,run} from '../../skills/chathand-setup/scripts/setup.mjs';

const progress=activity=>Object.fromEntries(['active','last_at','last_command','route','finished_at'].map(k=>[k,activity[k]]));
async function context(t){
 const f=await desktop(t),app=f.app,r=locateRuntime({stateDir:path.join(f.root,'state'),probe:()=>{}});
 const headers={authorization:'Bearer '+app.adminToken,'x-chathand-ui':app.uiKey};
 const request=async(route,method='GET',body,extra={})=>{
  const res=await fetch(r.ui_origin+route,{method,headers:{...headers,...extra,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,value:await res.json()};
 };
 return {...f,r,request};
}

test('doctor records a new seen time without changing progress; window and tool reads do not',async t=>{
 const f=await context(t),before=(await f.request('/api/state')).value.setup_activity;
 assert.equal(before.seen_at,null);assert.equal(before.active,false);
 const firstDoctor=await run(['doctor'],{locate:()=>f.r});assert.equal(firstDoctor.secret_values_omitted,true);
 const first=(await f.request('/api/state')).value.setup_activity;
 assert.equal(Number.isSafeInteger(first.seen_at),true);assert.deepEqual(progress(first),progress(before));
 f.advance(25);await run(['doctor'],{locate:()=>f.r});const second=(await f.request('/api/state')).value.setup_activity;
 assert.ok(second.seen_at>first.seen_at);assert.deepEqual(progress(second),progress(before));
 await f.request('/api/state');await f.rpc('bridge_info');assert.equal((await f.request('/api/state')).value.setup_activity.seen_at,second.seen_at);
 const native=(await f.request('/api/native/state')).value;
 assert.equal(Object.hasOwn(native.setup_activity||{},'seen_at'),false);
});

test('only the private helper capability may report seen; normal activity stays unchanged',async t=>{
 const f=await context(t),state=()=>f.request('/api/state').then(x=>x.value),before=(await state()).setup_activity;
 const post=(body,extra={})=>f.request('/api/setup/assistant-seen','POST',body,extra);
 assert.equal((await post({})).status,403);
 assert.equal((await post({}, {'x-chathand-setup-helper':'incorrect'})).status,403);
 assert.equal((await post({}, {authorization:'Bearer '+f.app.mcpToken,'x-chathand-setup-helper':f.r.setup_helper_token})).status,401);
 assert.equal((await post({timestamp:1},{'x-chathand-setup-helper':f.r.setup_helper_token})).status,400);
 await f.request('/api/state','GET',undefined,{'x-chathand-setup-helper':f.r.setup_helper_token});
 const original=await f.request('/api/setup/activity','POST',{command:'doctor'});assert.equal(original.status,200);
 assert.deepEqual((await state()).setup_activity,before);
 const accepted=await post({}, {'x-chathand-setup-helper':f.r.setup_helper_token});assert.equal(accepted.status,200);
 const after=await state();assert.equal(after.setup_activity.seen_at,accepted.value.seen_at);assert.deepEqual(progress(after.setup_activity),progress(before));
 assert.equal(JSON.stringify(after).includes(f.r.setup_helper_token),false);
});

test('helper observation preserves existing progress and completion in both active and finished states',async t=>{
 const f=await context(t),data=f.app.state.data,finishedAt=f.now()-50;
 Object.assign(data,{setup_activity_last_at:f.now(),setup_activity_in_progress:true,setup_activity_last_command:'connect',setup_activity_route:'openai',setup_activity_finished_at:finishedAt});
 for(const active of [true,false]){
  data.setup_activity_in_progress=active;
  const before=(await f.request('/api/state')).value.setup_activity;
  assert.equal(before.active,active);assert.equal(before.finished_at,finishedAt);
  f.advance(1);await run(['doctor'],{locate:()=>f.r});
  const after=(await f.request('/api/state')).value.setup_activity;
  assert.deepEqual(progress(after),progress(before));assert.ok(Number.isSafeInteger(after.seen_at));
 }
});

test('a new service starts with no observation and rejects the previous helper capability',async t=>{
 const first=await context(t);await run(['doctor'],{locate:()=>first.r});
 assert.ok(Number.isSafeInteger((await first.request('/api/state')).value.setup_activity.seen_at));
 const second=await context(t);assert.notEqual(first.r.setup_helper_token,second.r.setup_helper_token);
 assert.equal((await second.request('/api/state')).value.setup_activity.seen_at,null);
 const old=await second.request('/api/setup/assistant-seen','POST',{}, {'x-chathand-setup-helper':first.r.setup_helper_token});
 assert.equal(old.status,403);assert.equal((await second.request('/api/state')).value.setup_activity.seen_at,null);
});

test('helper commands report once without arguments; old or unreachable services do not alter results',async()=>{
 const r={ui_origin:'http://127.0.0.1:1',admin_token:'a'.repeat(64),setup_helper_token:'b'.repeat(64)};
 const commands=[['doctor'],['connect'],['site'],['site-start'],['bind-app'],['prepare-browser'],['test-start'],['test-status'],['switch','--route','openai'],['site-replace','--grant-from-clipboard'],['clipboard-check','--tunnel-id','tunnel_12345678'],['quit']];
 for(const args of commands){
  let seen=0,body,keys,request;
  const options={locate:()=>r,seenFetch:async(_url,init)=>{seen++;request=init;body=init.body;keys=Object.keys(init.headers);return {body:{cancel:async()=>{}}};},
   call:async()=>{throw Error('synthetic command stopped');},stdin:async()=>'',clipboard:()=>'',quitDependencies:{context:()=>{throw Error('synthetic quit stopped');}}};
  try{await run(args,options);}catch{}
  assert.equal(seen,1,args[0]);assert.equal(body,'{}');assert.deepEqual(keys.sort(),['Authorization','Content-Type','X-ChatHand-Setup-Helper'].sort());assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');assert.equal(request.cache,'no-store');
 }
 let calls=0;const old=await run(['doctor'],{locate:()=>({}),seenFetch:()=>{calls++;},call:async()=>({connection:{ready:true,healthy:true}})});
 assert.equal(old.connected,true);assert.equal(calls,0);
 const check=await run(['clipboard-check','--tunnel-id','tunnel_12345678'],{locate:()=>{throw Error('APP_NOT_RUNNING');},clipboard:()=> 'tunnel_12345678'});assert.equal(check.matches,true);
 const started=Date.now();const timed=await run(['doctor'],{locate:()=>r,seenFetch:()=>new Promise(()=>{}),call:async()=>({connection:{ready:true,healthy:true}})});
 assert.equal(timed.connected,true);assert.ok(Date.now()-started<2500);
 for(const seenFetch of [async()=>{throw Error('unavailable');},async()=>({status:403}),async()=>({status:404})]){
  const unchanged=await run(['doctor'],{locate:()=>r,seenFetch,call:async()=>({connection:{ready:true,healthy:true}})});
  assert.equal(unchanged.connected,true);
 }
 let release,startedCommand;const entered=new Promise(resolve=>{startedCommand=resolve;});
 const command=run(['doctor'],{locate:()=>r,seenFetch:()=>new Promise(resolve=>{release=resolve;}),call:async()=>{startedCommand();return {connection:{ready:true,healthy:true}};}});
 await entered;assert.equal(typeof release,'function');release({status:200});assert.equal((await command).connected,true);
});

test('state event stream publishes the helper observation without activating setup',async t=>{
 const f=await context(t),abort=new AbortController();t.after(()=>abort.abort());
 const response=await fetch(f.r.ui_origin+'/api/events',{headers:{authorization:'Bearer '+f.app.adminToken,'x-chathand-ui':f.app.uiKey},signal:abort.signal});
 assert.equal(response.status,200);const reader=response.body.getReader();let buffer='';
 const until=async predicate=>{
  let timer;try{return await Promise.race([(async()=>{for(;;){
   for(const line of buffer.split('\n').filter(line=>line.startsWith('data:'))){try{const value=JSON.parse(line.slice(5));if(predicate(value))return value;}catch{}}
   const chunk=await reader.read();if(chunk.done)throw Error('STREAM_ENDED');buffer+=new TextDecoder().decode(chunk.value);
  }})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('STREAM_TIMEOUT')),3000);})]);}finally{clearTimeout(timer);}
 };
 await until(value=>value.setup_activity?.seen_at===null);buffer='';await run(['doctor'],{locate:()=>f.r});
 const event=await until(value=>Number.isSafeInteger(value.setup_activity?.seen_at));assert.equal(event.setup_activity.active,false);
});
