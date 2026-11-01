import {TaskPolicy} from '../../app/policy.mjs';
import {sessionHashOf} from '../../app/v1/resume.mjs';
const fixturePrincipal='native-receipt-fixture',fixtureSession='native-receipt-session-1049';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Tools} from '../../app/tools.mjs';
import {Automation} from '../../app/v07/automation.mjs';
import {NativeComputer} from '../../app/v07/computer.mjs';
import {UIOperations} from '../../app/v07/operations.mjs';
import {cleanError} from '../../engine/src/core.mjs';
import {DESKTOP_ERROR_CODES,BROWSER_ERROR_CODES,CONTROL_DETAIL_CODES} from '../../engine/src/control-errors.mjs';
import {errorRecovery} from '../../app/v1/workflow.mjs';

// Actual RPC/invoke, native reply queue and action journal; isolated temporary
// state and fake native replies only. No server, GUI, native executable, AX,
// permission query, capture, input event or browser constructor is invoked.
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1035-b2-rpc-')));
 const workspace=path.join(root,'workspace'),stateDir=path.join(root,'state');fs.mkdirSync(workspace);
 const state={data:{mode:'auto',desktop_enabled:true,active:'p',projects:[{id:'p',name:'fixture',path:workspace}]},save(){}};
 const store={root:workspace,stateDir,audit(){}};
 const policy=new TaskPolicy(state,store,{jobs:new Map()});policy.enabled=true;policy.epoch=1;policy.permissionRevision=0;policy.tasks.set('task-b2',{id:'task-b2',caller:'owner',project_id:'p',root:workspace,epoch:1,status:'active',expires_at:null,jobs:[],session_hash:sessionHashOf(fixturePrincipal,fixtureSession)});
 const computer=new NativeComputer(state,policy),ops=new UIOperations(stateDir,policy);
 computer.heartbeat({accessibility:true,screen_recording:true});
 const automation=Object.assign(Object.create(Automation.prototype),{computer,ops});
 const tools=Object.assign(Object.create(Tools.prototype),{state,store,policy,queue:{},blocks:{record(){}},lastCalls:{},automation});
 t.after(()=>{computer.cancelAll();fs.rmSync(root,{recursive:true,force:true});});
 return {tools,computer,ops};
}
const b2={method:'background_target_click',background:true,delivery_unconfirmed:true,do_not_replay:true,
 delivery_status:'posted_unconfirmed',attempted_target_channels:10,target_focus_records:2};
const observed={native_snapshot_id:'native-b2',target_bundle:'test.b2',window_id:'w23',frame:{x:0,y:0,width:800,height:500},
 elements:[{ref:'a1',role:'AXTextField',name:'fixture',frame:{x:20,y:30,width:400,height:30}}],tree:'fixture'};
const rpc=(tools,id,name,args)=>tools.rpc({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':fixtureSession}}},'owner',{setupPrincipal:fixturePrincipal});
async function reply(computer,pending,result){
 await new Promise(resolve=>setImmediate(resolve));
 const request=computer.next().request;assert.ok(request,'real native queue received request');
 assert.equal(computer.complete(request.id,result).accepted,true);return {request,result:await pending};
}

test('B2 native replies survive actual RPC and TARGET_CHANGED never loses replay safety',async t=>{
 const {tools,computer,ops}=fixture(t);
 const observe=await reply(computer,rpc(tools,1,'computer_observe',{task_id:'task-b2',bundle_id:'test.b2'}),observed);
 assert.equal(observe.request.action,'observe');
 const observation_id=observe.result.result.structuredContent.observation_id;assert.ok(observation_id);
 for(const [index,code,safety] of [
  [0,'COMPUTER_ACTION_UNCONFIRMED',b2],
  [1,'TARGET_CHANGED',{...b2,attempted_target_channels:3,target_focus_records:1}],
  [2,'TARGET_CHANGED',{delivery_unconfirmed:false,do_not_replay:false}],
 ]){
  const request_id='b2-rpc-receipt-'+index,args={task_id:'task-b2',request_id,observation_id,element_ref:'a1',action:'click'};
  const details={...safety,raw_arguments:{password:'forbidden-password'},image_base64:'forbidden-image',
   arbitrary:'forbidden-field',observation:{...observed,native_snapshot_id:'after-'+index,image_base64:'forbidden-image'}};
  const {request,result}=await reply(computer,rpc(tools,10+index,'computer_action',args),
   {error:{code,message:'fixture',details,recovery:{next_action:'replay',automatic_retry:true}}});
  assert.equal(request.action,'action');assert.equal(request.args.native_snapshot_id,'native-b2');
  const receipt=result.result.structuredContent;assert.equal(result.result.isError,true);assert.equal(receipt.code,code);
  for(const [key,value] of Object.entries(safety))assert.equal(receipt.details[key],value,key);
  if(index===2){assert.equal(Object.hasOwn(receipt.details,'method'),false);assert.equal(Object.hasOwn(receipt.details,'delivery_status'),false);}
  assert.equal(receipt.details.observation.window_id,'w23');
  assert.deepEqual(receipt.recovery,{next_action:'computer_observe',automatic_retry:false,create_new_task:false});
  assert.deepEqual(JSON.parse(result.result.content[0].text),receipt);
  assert.doesNotMatch(JSON.stringify(result),/forbidden-|"replay"/);
  // The same public request ID reuses the real rejected operation promise;
  // it cannot enqueue the click again, even for the pre-dispatch failure.
  const again=await rpc(tools,30+index,'computer_action',args);
  assert.deepEqual(again.result.structuredContent,receipt);assert.equal(computer.next().request,null);
 }
 assert.equal(ops.cache.size,3);assert.equal(computer.pending.size,0);
});

test('B2 receipt contract permits exact desktop route and bounded integers only',()=>{
 assert.equal(DESKTOP_ERROR_CODES.length,43);assert.equal(BROWSER_ERROR_CODES.length,54);
 assert.equal(DESKTOP_ERROR_CODES.includes('TARGET_CHANGED'),false);assert.equal(CONTROL_DETAIL_CODES.has('TARGET_CHANGED'),false);
 const filtered=(code,details)=>cleanError({code,message:'fixture',details}).details;
 for(const code of ['COMPUTER_ACTION_UNCONFIRMED','TARGET_CHANGED']){
  assert.deepEqual(filtered(code,b2),b2);
  for(const [key,values] of [['attempted_target_channels',[-1,11,1.5,'10',NaN,Infinity]],['target_focus_records',[-1,3,0.5,'2',NaN,Infinity]]]){
   for(const value of values)assert.equal(Object.hasOwn(filtered(code,{...b2,[key]:value}),key),false,key+' rejects '+value);
  }
  for(const [channels,focus] of [[0,0],[10,2]]){
   const out=filtered(code,{...b2,attempted_target_channels:channels,target_focus_records:focus});
   assert.equal(out.attempted_target_channels,channels);assert.equal(out.target_focus_records,focus);
  }
  for(const patch of [{method:'arbitrary'}, {method:null}, {background:false}, {background:'true'}]){
   const out=filtered(code,{...b2,...patch});for(const key of ['method','background','attempted_target_channels','target_focus_records','delivery_status'])assert.equal(Object.hasOwn(out,key),false,key);
   assert.equal(out.do_not_replay,true);
  }
  for(const patch of [{delivery_status:'verified'},{delivery_status:'replay_safe'},{do_not_replay:false},{delivery_unconfirmed:false}])
   assert.equal(Object.hasOwn(filtered(code,{...b2,...patch}),'delivery_status'),false);
 }
 assert.equal(Object.hasOwn(filtered('BROWSER_ACTION_FAILED',b2),'method'),false);
 assert.equal(filtered('TARGET_CHANGED_OTHER',b2),undefined);
 const zero=filtered('TARGET_CHANGED',{delivery_unconfirmed:false,do_not_replay:false,method:'arbitrary',raw_arguments:{text:'forbidden'}});
 assert.deepEqual(zero,{delivery_unconfirmed:false,do_not_replay:false});
 assert.deepEqual(errorRecovery('TARGET_CHANGED'),{next_action:'computer_observe',automatic_retry:false,create_new_task:false});
});
