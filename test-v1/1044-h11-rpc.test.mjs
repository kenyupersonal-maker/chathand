import {TaskPolicy} from '../app/policy.mjs';
import {sessionHashOf} from '../app/v1/resume.mjs';
const fixturePrincipal='native-receipt-fixture',fixtureSession='native-receipt-session-1049';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Tools} from '../app/tools.mjs';
import {Automation} from '../app/v07/automation.mjs';
import {NativeComputer} from '../app/v07/computer.mjs';
import {UIOperations} from '../app/v07/operations.mjs';
import {cleanError} from '../engine/src/core.mjs';

test('1047 late foreground native delivery survives final authorization and public RPC cleaning',async t=>{
 for(const change of ['deadline','epoch','revision','capability'])for(const resultKind of ['error','success','batch']){
  const {tools,computer}=fixture(t);
  const seen=await deliver(computer,rpc(tools,1,'computer_observe',{task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
  const args={task_id:'task-1044',request_id:`1047-late-${change}-${resultKind}`,
   observation_id:seen.response.result.structuredContent.observation_id,element_ref:'a1',action:'click'};
  const pending=rpc(tools,2,'computer_action',args);
  await new Promise(resolve=>setImmediate(resolve));
  const request=computer.next().request;
  if(change==='deadline')computer.pending.get(request.id).created=Date.now()-19500;
  if(change==='epoch')computer.policy.epoch++;
  if(change==='revision')computer.policy.permissionRevision=1;
  if(change==='capability')tools.state.data.desktop_enabled=false;
  const details={foreground_input_events:2,delivery_unconfirmed:true,do_not_replay:true,focus_reason:'surface_changed',raw_arguments:{secret:'private-fixture'}};
  const native=resultKind==='error'?{error:{code:'FOCUS_CHANGED',details}}:
   resultKind==='batch'?{failure:{code:'SECURE_INPUT',details}}:{performed:'type',foreground_input_events:2,private_text:'private-fixture'};
  assert.equal(computer.complete(request.id,native).discarded,true);
  const response=await pending,result=response.result.structuredContent;
  assert.equal(response.result.isError,true);
  assert.equal(result.code,change==='capability'?'CAPABILITY_OFF':change==='epoch'?'ROOT_CHANGED':'COMPUTER_REQUEST_EXPIRED');
  assert.equal(result.details?.foreground_input_events,2);
  assert.equal(result.details?.delivery_unconfirmed,true);
  assert.equal(result.details?.do_not_replay,true);
  assert.doesNotMatch(JSON.stringify(response),/private-fixture|raw_arguments|private_text/);
  assert.equal(computer.pending.size,0);
  assert.equal(computer.next().request,null);
 }
});

test('1047 zero or malformed foreground counts never invent late dispatch provenance',async t=>{
 for(const count of [0,-1,1.5,100001,NaN,Infinity,'2']){
  const {computer}=fixture(t);
  const pending=computer.request('action',{},'task-1044','owner').catch(e=>e);
  const request=computer.next().request;
  computer.policy.epoch++;
  computer.complete(request.id,{error:{code:'FOCUS_CHANGED',details:{foreground_input_events:count}}});
  const result=cleanError(await pending);
  assert.equal(result.details?.foreground_input_events,undefined);
  assert.equal(result.details?.delivery_unconfirmed,undefined);
 }
});

test('1047 journal final check preserves successful native attempt without leaking result content',async t=>{
 const {computer,ops}=fixture(t);let called=0;
 const args={task_id:'task-1044',request_id:'1047-journal-final-check'};
 const action=()=>ops.run('computer_action',args,'owner',async()=>{
  called++;computer.policy.epoch++;
  return {performed:'type',foreground_input_events:2,raw_arguments:{secret:'private-fixture'}};
 });
 const first=await action().catch(e=>cleanError(e));
 assert.equal(first.code,'ROOT_CHANGED','current task policy rejects the stale epoch before returning the native result');
 assert.deepEqual(first.details,{foreground_input_events:2,delivery_unconfirmed:true,do_not_replay:true});
 let repeat;try{repeat=await action();}catch(error){repeat=cleanError(error);}
 assert.equal(repeat.code,'ROOT_CHANGED','a revoked epoch fails closed before journal lookup');
 assert.equal(called,1,'the same request never reaches the operation callback again');
 assert.doesNotMatch(JSON.stringify(first),/private-fixture|raw_arguments/);
});

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1044-h11-rpc-'));
 const workspace=path.join(root,'workspace'),stateDir=path.join(root,'state');
 fs.mkdirSync(workspace);
 const state={data:{mode:'auto',desktop_enabled:true,active:'p',projects:[{id:'p',name:'fixture',path:workspace}]},save(){}};
 const store={root:workspace,stateDir,paused:false,audit(){}};
 const policy=new TaskPolicy(state,store,{jobs:new Map()});policy.enabled=true;policy.epoch=1;policy.permissionRevision=0;policy.tasks.set('task-1044',{id:'task-1044',caller:'owner',project_id:'p',root:workspace,epoch:1,status:'active',expires_at:null,jobs:[],session_hash:sessionHashOf(fixturePrincipal,fixtureSession)});
 const computer=new NativeComputer(state,policy),ops=new UIOperations(stateDir,policy);
 computer.heartbeat({accessibility:true,screen_recording:true});
 const automation=Object.assign(Object.create(Automation.prototype),{computer,ops});
 const tools=Object.assign(Object.create(Tools.prototype),
   {state,store,policy,queue:{},blocks:{record(){}},lastCalls:{},automation});
 t.after(()=>{computer.cancelAll();fs.rmSync(root,{recursive:true,force:true});});
 return {tools,computer,ops};
}
const posted={method:'background_target_click',background:true,
 delivery_unconfirmed:true,delivery_status:'posted_unconfirmed',verified:false,
 completed:false,do_not_replay:true,automatic_retry:false,
 attempted_target_channels:10,target_focus_records:2,
 message:'已发出，未确认；先截图确认，不要再点。',next_action:'computer_screenshot'};
const observed={native_snapshot_id:'native-1044',target_bundle:'fixture.b2',window_id:'w23',
 frame:{x:0,y:0,width:800,height:500},elements:[
 {ref:'a1',role:'AXButton',name:'owned fixture',frame:{x:20,y:30,width:400,height:30}}
 ],tree:'own fixture'};
const rpc=(tools,id,name,args)=>tools.rpc(
 {jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':fixtureSession}}},'owner',{setupPrincipal:fixturePrincipal});
async function deliver(computer,pending,nativeResult){
 await new Promise(resolve=>setImmediate(resolve));
 const request=computer.next().request;
 assert.ok(request,'native channel receives one queued call');
 assert.equal(computer.complete(request.id,nativeResult).accepted,true);
 return {request,response:await pending};
}

test('1044 actual public RPC: complete target-only recipe is non-error unverified, same request never enqueues again',async t=>{
 const {tools,computer,ops}=fixture(t);
 const observe=await deliver(computer,
   rpc(tools,1,'computer_observe',{task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
 const id=observe.response.result.structuredContent.observation_id;
 const args={task_id:'task-1044',request_id:'1044-rpc-one-click',
   observation_id:id,element_ref:'a1',action:'click'};
 const {request,response}=await deliver(computer,
   rpc(tools,2,'computer_action',args),{...posted,observation:observed});
 assert.equal(request.action,'action');
 assert.equal(request.args.native_snapshot_id,'native-1044');
 assert.equal(response.result.isError,false);
 const result=response.result.structuredContent;
 assert.equal(result.delivery_status,'posted_unconfirmed');
 assert.equal(result.do_not_replay,true);
 assert.equal(result.verified,false);
 assert.equal(result.completed,false);
 assert.equal(result.next_action,'computer_screenshot');
 assert.equal(result.observation.window_id,'w23');
 const again=await rpc(tools,3,'computer_action',args);
 assert.deepEqual(again.result.structuredContent,result);
 assert.equal(computer.next().request,null);
 assert.equal(ops.cache.size,1);
 assert.equal(computer.pending.size,0);
});

test('1044 actual public RPC: batch nonerror posted result stops and shows not_attempted, no second enqueue',async t=>{
 const {tools,computer}=fixture(t);
 const observedReply=await deliver(computer,
  rpc(tools,1,'computer_observe',{task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
 const id=observedReply.response.result.structuredContent.observation_id;
 const args={task_id:'task-1044',request_id:'1044-rpc-batch-stop',
   observation_id:id,steps:[
    {step_id:'first',action:'click',element_ref:'a1'},
    {step_id:'second',action:'click',element_ref:'a1'}
  ]};
 const native={completed:false,stop_reason:'posted_unconfirmed',
  delivery_status:'posted_unconfirmed',do_not_replay:true,verified:false,
  receipts:[{step_id:'first',index:0,status:'posted_unconfirmed',result:posted},
            {step_id:'second',index:1,status:'not_attempted'}],
  remaining_steps:1,observation:observed};
 const {request,response}=await deliver(computer,rpc(tools,2,'computer_batch',args),native);
 assert.equal(request.action,'batch');
 assert.equal(request.args.steps.length,2);
 assert.equal(response.result.isError,false);
 const r=response.result.structuredContent;
 assert.equal(r.completed,false);
 assert.equal(r.stop_reason,'posted_unconfirmed');
 assert.equal(r.receipts[0].status,'posted_unconfirmed');
 assert.equal(r.receipts[1].status,'not_attempted');
 assert.equal(r.next_action,'computer_screenshot');
 const repeat=await rpc(tools,3,'computer_batch',args);
 assert.deepEqual(repeat.result.structuredContent,r);
 assert.equal(computer.next().request,null);
});

test('1044 actual public RPC: late B2 batch observation/epoch failure remains error and non-replayable',async t=>{
 const {tools,computer,ops}=fixture(t);
 const seen=await deliver(computer,
   rpc(tools,1,'computer_observe',{task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
 const id=seen.response.result.structuredContent.observation_id;
 for(const [index,code] of ['COMPUTER_WINDOW_STALE','COMPUTER_REQUEST_EXPIRED'].entries()){
   const args={task_id:'task-1044',request_id:'1044-rpc-late-'+index,
     observation_id:id,steps:[
       {step_id:'first',action:'click',element_ref:'a1'},
       {step_id:'second',action:'click',element_ref:'a1'}
     ]};
   const error={code,message:'已投递但后续检查失败',
     details:{method:'background_target_click',background:true,
       delivery_status:'posted_unconfirmed',delivery_unconfirmed:true,do_not_replay:true,
       attempted_target_channels:10,target_focus_records:2,
       batch_stopped:true,remaining_steps:1,
       raw_arguments:{password:'secret-test-fixture'}}};
   const native={completed:false,remaining_steps:1,
     receipts:[{step_id:'first',index:0,status:'failed_or_unconfirmed',error},
       {step_id:'second',index:1,status:'not_attempted'}],
     failure:error,error,observation:observed};
   const {request,response}=await deliver(computer,rpc(tools,2+index,'computer_batch',args),native);
   assert.equal(request.action,'batch');
   assert.equal(response.result.isError,true,'B2 late-guard failure is not normal posted');
   const result=response.result.structuredContent;
   assert.equal(result.code,code,'original error code survives native and RPC');
   assert.equal(result.details?.method,'background_target_click');
   assert.equal(result.details?.delivery_unconfirmed,true);
   assert.equal(result.details?.do_not_replay,true);
   assert.equal(result.details?.batch_stopped,true);
   assert.equal(result.details?.remaining_steps,1);
   assert.equal(result.details?.remaining_status,'not_attempted');
   assert.deepEqual(result.recovery,
     {next_action:'computer_observe',automatic_retry:false,create_new_task:false});
   assert.doesNotMatch(JSON.stringify(response),/secret-test-fixture/);
   const again=await rpc(tools,10+index,'computer_batch',args);
   assert.equal(again.result.isError,true);
   assert.deepEqual(again.result.structuredContent,result);
   assert.equal(computer.next().request,null,'no second native dispatch');
 }
 assert.equal(ops.cache.size,2);
});

test('1044 native completion after task/epoch revocation retains B2 no-replay uncertainty',async t=>{
 const {tools,computer,ops}=fixture(t);
 const seen=await deliver(computer,rpc(tools,1,'computer_observe',
   {task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
 const args={task_id:'task-1044',request_id:'1044-rpc-epoch-after-native',
   observation_id:seen.response.result.structuredContent.observation_id,
   element_ref:'a1',action:'click'};
 const pending=rpc(tools,2,'computer_action',args);
 await new Promise(resolve=>setImmediate(resolve));
 const request=computer.next().request;
 assert.ok(request,'action already left the JS queue');
 computer.policy.epoch=2; // simulated permission/task epoch after native dispatch
 assert.equal(computer.complete(request.id,{...posted,observation:observed}).discarded,true);
 const response=await pending;
 assert.equal(response.result.isError,true);
 const result=response.result.structuredContent;
 assert.equal(result.code,'ROOT_CHANGED','the current policy reports a revoked task epoch');
 assert.equal(result.details?.delivery_unconfirmed,true);
 assert.equal(result.details?.do_not_replay,true);
 assert.equal(result.details?.method,'background_target_click');
 assert.equal(result.recovery?.automatic_retry,false);
 const repeat=await rpc(tools,3,'computer_action',args);
 assert.equal(repeat.result.isError,true);
 assert.equal(repeat.result.structuredContent.code,'ROOT_CHANGED','revoked task rejects before cached receipt lookup');
 assert.equal(computer.next().request,null);
 assert.equal(ops.cache.size,1);
 const journal=fs.readdirSync(ops.dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(ops.dir,name),'utf8')));
 assert.equal(journal.length,1);assert.equal(journal[0].status,'failed_or_unknown');
 computer.policy.tasks.get('task-1044').epoch=computer.policy.epoch;
 const restored=await rpc(tools,4,'computer_action',args);
 assert.deepEqual(restored.result.structuredContent,result,'restoring task authorization still reuses the original uncertain receipt');
 assert.equal(computer.next().request,null);
 const restarted=new UIOperations(path.dirname(ops.dir),computer.policy);let called=0;
 assert.throws(()=>restarted.run('computer_action',args,'owner',()=>{called++;}),e=>e.code==='UI_ACTION_ALREADY_ATTEMPTED');
 assert.equal(called,0,'restart cannot rerun a persisted attempted action');
});

test('1044 actual public RPC: contradictory normal B2 payload is rejected with uncertainty',async t=>{
 const {tools,computer}=fixture(t);
 const seen=await deliver(computer,rpc(tools,1,'computer_observe',
   {task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
 const args={task_id:'task-1044',request_id:'1044-rpc-contradictory',
   observation_id:seen.response.result.structuredContent.observation_id,
   element_ref:'a1',action:'click'};
 const {response}=await deliver(computer,rpc(tools,2,'computer_action',args),
   {...posted,completed:true,observation:observed});
 assert.equal(response.result.isError,true);
 const result=response.result.structuredContent;
 assert.equal(result.code,'COMPUTER_ACTION_UNCONFIRMED');
 assert.equal(result.details?.delivery_unconfirmed,true);
 assert.equal(result.details?.do_not_replay,true);
 assert.equal(computer.next().request,null);
});


test('late B2 uncertainty survives capability and journal revocation without disclosing native content',async t=>{
 const {tools,computer,ops}=fixture(t);
 const seen=await deliver(computer,rpc(tools,1,'computer_observe',{task_id:'task-1044',bundle_id:'fixture.b2'}),observed);
 const args={task_id:'task-1044',request_id:'b2-late-capability',observation_id:seen.response.result.structuredContent.observation_id,element_ref:'a1',action:'click'};
 const pending=rpc(tools,2,'computer_action',args);await new Promise(resolve=>setImmediate(resolve));
 const request=computer.next().request;assert.ok(request);tools.state.data.desktop_enabled=false;
 assert.equal(computer.complete(request.id,{...posted,raw_arguments:{text:'private-fixture'}}).discarded,true);
 const receipt=(await pending).result.structuredContent;
 assert.equal(receipt.code,'CAPABILITY_OFF');assert.equal(receipt.details.capability,'desktop');
 assert.equal(receipt.details.do_not_replay,true);assert.equal(receipt.details.delivery_unconfirmed,true);
 assert.doesNotMatch(JSON.stringify(receipt),/private-fixture|raw_arguments/);
 tools.state.data.desktop_enabled=true;let called=0;
 const finalArgs={task_id:'task-1044',request_id:'b2-final-journal-guard'};
 const failure=await ops.run('computer_action',finalArgs,'owner',async()=>{called++;computer.policy.epoch++;return {...posted,raw_arguments:{text:'private-fixture'}};}).catch(error=>cleanError(error));
 assert.equal(failure.code,'ROOT_CHANGED');assert.equal(failure.details.do_not_replay,true);
 assert.equal(failure.details.delivery_unconfirmed,true);assert.doesNotMatch(JSON.stringify(failure),/private-fixture|raw_arguments/);
 assert.equal(called,1);
 for(const patch of [{method:'arbitrary'},{background:false},{delivery_status:'verified'},{delivery_unconfirmed:false},{do_not_replay:false}])
  assert.equal(cleanError({code:'ROOT_CHANGED',message:'fixture',details:{...posted,...patch}}).details,undefined);
 assert.equal(cleanError({code:'UNRELATED_FAILURE',message:'fixture',details:posted}).details,undefined);
});
