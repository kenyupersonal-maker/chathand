// 1060 combined AutoTask + native receipt boundaries. Isolated temporary server
// state, fake native replies only; no execute(), OS AX, input, permission or UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../app/server.mjs';

const absent='00000000-0000-4000-8000-000000001060';
const sourceContext={setupPrincipal:'fixture:native-auto-one',session:'fixture-session-one',connectionPrincipal:'site:fixture-one'};
const otherContext={setupPrincipal:'fixture:native-auto-two',session:'fixture-session-two',connectionPrincipal:'site:fixture-two'};
const uncertainError=()=>({code:'COMPUTER_ACTION_UNCONFIRMED',message:'AX 写入已尝试，未读取敏感值。',
 details:{delivery_unconfirmed:true,do_not_replay:true,delivery_status:'posted_unconfirmed'},recovery:{next_action:'computer_observe',automatic_retry:false}});
const thrown=(payload)=>Object.assign(Error(payload.message),payload);
const posted={method:'background_target_click',background:true,delivery_status:'posted_unconfirmed',
 delivery_unconfirmed:true,do_not_replay:true,verified:false,completed:false,automatic_retry:false,
 attempted_target_channels:10,target_focus_records:2,next_action:'computer_screenshot'};

async function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-native-auto-'))),
  work=path.join(dir,'work'),stateDir=path.join(dir,'state');
 fs.mkdirSync(work);fs.mkdirSync(stateDir);
 const open=new Set();
 async function start(){const app=await createDesktop({stateDir,defaultRoot:work});open.add(app);return app;}
 async function stop(app){if(open.delete(app))await app.close();}
 t.after(async()=>{for(const app of [...open])await stop(app);fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,work,stateDir,start,stop,app:await start()};
}
function rpc(app,name,args,context=sourceContext){
 return app.tools.rpc({jsonrpc:'2.0',id:'fixture-'+args.request_id,method:'tools/call',
  params:{name,arguments:args,_meta:{'openai/session':context.session}}},'chatgpt',context);
}
function ledger(app,name,args){
 const auto=app.tools.autoTasks,id=auto.identity(name,args,{});
 return auto.read(auto.file(id),id.namespace+'\0'+id.id);
}
function forbidNative(app,counter){
 for(const name of ['action','batch','focus'])app.tools.automation.computer[name]=async()=>{
  counter.count++;throw Error('fixture: replay must not reach native');
 };
}
async function replayAndRestart(f,name,args){
 const repeat=await rpc(f.app,name,args,otherContext);
 await f.stop(f.app);
 const restarted=await f.start(),counter={count:0};forbidNative(restarted,counter);
 const afterRestart=await rpc(restarted,name,args,otherContext);
 assert.equal(counter.count,0,'restarting may read the durable record, never resubmit native work');
 return {repeat:repeat.result.structuredContent,afterRestart:afterRestart.result.structuredContent};
}

// This is the actual single sensitive AX setter outcome in ComputerControl:
// one set attempt, no readback, ControlFailure uncertain:true.
test('single native secure AX write stays unknown across Tools, task remap, repeated request and restart',async t=>{
 const f=await fixture(t),args={task_id:absent,request_id:'native-auto-secure-single',action:'type',element_ref:'fixture-secure',text:'fixture-1060-sensitive-value'};
 let writes=0;
 f.app.tools.automation.computer.action=async resolved=>{assert.notEqual(resolved.task_id,absent);writes++;throw thrown(uncertainError());};
 const first=await rpc(f.app,'computer_action',args),value=first.result.structuredContent;
 assert.equal(first.result.isError,true);assert.equal(value.code,'COMPUTER_ACTION_UNCONFIRMED');
 assert.equal(value.execution_state,'unknown');assert.equal(value.do_not_replay,true);
 assert.equal(value.details.delivery_unconfirmed,true);assert.equal(value.details.do_not_replay,true);
 assert.equal(ledger(f.app,'computer_action',args).state,'unknown');
 const remapped=await rpc(f.app,'computer_action',{...args,task_id:value.new_task_id},otherContext);
 assert.equal(remapped.result.structuredContent.execution_state,'unknown');
 const replay=await replayAndRestart(f,'computer_action',args);
 for(const result of Object.values(replay)){assert.equal(result.execution_state,'unknown');assert.equal(result.do_not_replay,true);assert.equal(result.replayed,true);}
 assert.equal(writes,1);
 assert.doesNotMatch(JSON.stringify([first,remapped,replay]),/fixture-1060-sensitive-value/);
});

// runBatch returns a normal object for a background AX write failure (no global
// foreground events and no B2 dispatch), with the uncertainty nested in failure.
test('native batch sensitive AX uncertainty must not be relabelled completed by automatic task creation',async t=>{
 const f=await fixture(t),args={task_id:absent,request_id:'native-auto-secure-batch',steps:[
  {step_id:'password',action:'type',element_ref:'fixture-secure',text:'fixture-1060-sensitive-value'},
  {step_id:'submit',action:'key',key:'Enter'}]};
 let writes=0;
 f.app.tools.automation.computer.batch=async()=>{writes++;return {completed:false,
  receipts:[{step_id:'password',index:0,status:'failed_or_unconfirmed',error:uncertainError()},
   {step_id:'submit',index:1,status:'not_attempted'}],failure:uncertainError(),remaining_steps:1};};
 const first=await rpc(f.app,'computer_batch',args),value=first.result.structuredContent;
 const stored=ledger(f.app,'computer_batch',args),replay=await replayAndRestart(f,'computer_batch',args);
 assert.equal(writes,1);assert.equal(value.completed,false);assert.equal(value.failure.details.do_not_replay,true);
 assert.equal(value.receipts[1].status,'not_attempted');
 assert.doesNotMatch(JSON.stringify([first,replay]),/fixture-1060-sensitive-value/);
 t.diagnostic(JSON.stringify({first:value.execution_state,ledger:stored.state,repeat:replay.repeat.execution_state,restart:replay.afterRestart.execution_state,writes}));
 assert.equal(value.execution_state,'unknown','AutoTask may not convert a failed/unconfirmed native batch into completed');
 assert.equal(value.do_not_replay,true);assert.equal(stored.state,'unknown');
 for(const result of Object.values(replay)){assert.equal(result.execution_state,'unknown');assert.equal(result.do_not_replay,true);}
});

test('normal B2 posted-unconfirmed receipt remains unknown on the first result and durable replay',async t=>{
 const f=await fixture(t),args={task_id:absent,request_id:'native-auto-b2-posted',action:'click',capture_id:'fixture-capture',x:20,y:30};
 let attempts=0;f.app.tools.automation.computer.action=async()=>{attempts++;return {...posted};};
 const first=await rpc(f.app,'computer_action',args),value=first.result.structuredContent;
 const stored=ledger(f.app,'computer_action',args),replay=await replayAndRestart(f,'computer_action',args);
 assert.equal(attempts,1);assert.equal(value.delivery_status,'posted_unconfirmed');assert.equal(value.do_not_replay,true);
 t.diagnostic(JSON.stringify({first:value.execution_state,ledger:stored.state,repeat:replay.repeat.execution_state,restart:replay.afterRestart.execution_state,attempts}));
 assert.equal(value.execution_state,'unknown','posted is not confirmation that the target effect completed');
 assert.equal(stored.state,'unknown');
 for(const result of Object.values(replay)){assert.equal(result.execution_state,'unknown');assert.equal(result.do_not_replay,true);}
});

for(const bundle of ['com.apple.SecurityAgent','com.apple.loginwindow','com.apple.LocalAuthentication.UIAgent']){
 test(`pre-dispatch system computer-password guard ${bundle} preserves native non-delivery facts without inventing a trusted proof or replaying`,async t=>{
  const f=await fixture(t),suffix=bundle.split('.').at(-1),args={task_id:absent,request_id:'native-auto-system-'+suffix,action:'type',text:'fixture-1060-not-dispatched'};
  let checks=0,writes=0;
  f.app.tools.automation.computer.action=async()=>{checks++;throw thrown({code:'LOCAL_USER_REQUIRED',
   message:'电脑密码只能你自己在 macOS 的框里输。',details:{delivery_unconfirmed:false,do_not_replay:false}});};
  const first=await rpc(f.app,'computer_action',args),value=first.result.structuredContent;
  const stored=ledger(f.app,'computer_action',args),replay=await replayAndRestart(f,'computer_action',args);
  assert.equal(first.result.isError,true);assert.equal(value.code,'LOCAL_USER_REQUIRED');
  assert.equal(value.details.delivery_unconfirmed,false);assert.equal(value.details.do_not_replay,false);
  assert.equal(writes,0);assert.equal(checks,1,'same request reuses the rejection instead of reentering the guard');
  assert.doesNotMatch(JSON.stringify([first,replay]),/fixture-1060-not-dispatched/);
  t.diagnostic(JSON.stringify({bundle,first:value.execution_state,ledger:stored.state,repeat:replay.repeat.execution_state,restart:replay.afterRestart.execution_state,checks,writes}));
  // Native's false flags are defaults, not a request-wide proof that no AX/B2
  // event was attempted. Preserve them but keep AutoTask conservative until a
  // trusted pre-dispatch marker exists; a public error code is not that marker.
  assert.equal(value.execution_state,'unknown');assert.equal(value.do_not_replay,true);
  assert.equal(stored.state,'unknown');
  for(const result of Object.values(replay)){assert.equal(result.execution_state,'unknown');assert.equal(result.do_not_replay,true);}
 });
}

const observation={native_snapshot_id:'fixture-native-1060',target_bundle:'fixture.editor',window_id:'w1060',
 frame:{x:0,y:0,width:800,height:600},elements:[{ref:'a1',role:'AXTextField',name:'fixture note',
  sensitive:false,frame:{x:20,y:20,width:300,height:30}}],tree:'fixture editor'};
async function deliver(app,promise,result){
 const computer=app.tools.automation.computer;
 // Real Tools/operations scheduling uses the event loop; there is no OS wait.
 for(let n=0;n<20&&computer.pending.size===0;n++)await new Promise(resolve=>setImmediate(resolve));
 const request=computer.next().request;assert.ok(request,'fake native transport received exactly one request');
 computer.complete(request.id,result);return {request,result:await promise};
}
test('task_id continues across conversations while native target, current desktop switch, scope and epoch remain enforced',async t=>{
 const f=await fixture(t),app=f.app,computer=app.tools.automation.computer;
 const task=await app.tools.invoke('begin_task',{request_id:'native-cross-task-1060',title:'fixture cross conversation'},'chatgpt',sourceContext);
 computer.heartbeat({accessibility:true,accessibility_elements:true});
 const seen=await deliver(app,app.tools.invoke('computer_observe',{task_id:task.task_id,bundle_id:'fixture.editor'},'chatgpt',sourceContext),observation);
 const args={task_id:task.task_id,request_id:'native-cross-action-1060',action:'type',element_ref:'a1',text:'fixture note',observation_id:seen.result.observation_id};
 const action=await deliver(app,app.tools.invoke('computer_action',args,'chatgpt',otherContext),{performed:'type',method:'accessibility_value',verified:true});
 assert.equal(action.request.args.bundle_id,'fixture.editor');assert.equal(action.request.args.native_snapshot_id,'fixture-native-1060');
 assert.equal(action.result.performed,'type');assert.equal(app.policy.tasks.size,1);
 app.state.data.desktop_enabled=false;
 await assert.rejects(app.tools.invoke('computer_action',{...args,request_id:'native-switch-off-1060'},'chatgpt',otherContext),{code:'CAPABILITY_OFF'});
 assert.equal(computer.pending.size,0);assert.equal(app.policy.tasks.size,1);
 app.state.data.desktop_enabled=true;
 await assert.rejects(app.tools.invoke('write_text',{task_id:task.task_id,operation_id:'native-scope-off-1060',path:'../outside.txt',content:'fixture',expected_sha256:'MISSING'},'chatgpt',otherContext),{code:'SCOPE_REQUIRED'});
 assert.equal(fs.existsSync(path.join(f.dir,'outside.txt')),false);
 app.policy.epoch++;
 await assert.rejects(app.tools.invoke('computer_action',{...args,request_id:'native-epoch-off-1060'},'chatgpt',otherContext),{code:'ROOT_CHANGED'});
 assert.equal(computer.pending.size,0);assert.equal(app.policy.tasks.size,1);
 app.policy.epoch--;
 const root=app.store.root;app.store.root=path.join(f.dir,'different-root');
 await assert.rejects(app.tools.invoke('computer_action',{...args,request_id:'native-root-off-1060'},'chatgpt',otherContext),{code:'ROOT_CHANGED'});
 app.store.root=root;assert.equal(computer.pending.size,0);assert.equal(app.policy.tasks.size,1);
});
