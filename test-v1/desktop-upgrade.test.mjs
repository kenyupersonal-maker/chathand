import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {NativeComputer,COMPUTER_TOOL_UPGRADES,COMPUTER_INSTRUCTIONS,validateComputerToolArgs} from '../app/v07/computer.mjs';

// Fake transport only: no native execute, native heartbeat HTTP, permission probe,
// screen capture, clipboard access, input event, or daily state directory.
function fixture(t,mode='auto') {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-sa4-')));
 const state={data:{mode,desktop_enabled:true,active:'p',projects:[{id:'p',name:'测试文件夹',path:root}]}};
 const policy={epoch:1,store:{root,resolve(input){const full=fs.realpathSync(path.resolve(root,input));if(full!==root&&!full.startsWith(root+path.sep))throw Object.assign(Error('outside scope'),{code:'SCOPE_REQUIRED'});return full;}},
  require(task,caller){if(task!=='task-a'||caller!=='owner')throw Object.assign(Error('owner mismatch'),{code:'TASK_OWNER'});}};
 const computer=new NativeComputer(state,policy);
 t.after(()=>{computer.cancelAll();fs.rmSync(root,{recursive:true,force:true});});
 computer.heartbeat({screen_recording:true,accessibility:true,accessibility_elements:true,front_app:{bundle_id:'test.front',name:'Front',pid:4}});
 return {computer,state,policy,root};
}
const observed=(overrides={})=>({native_snapshot_id:'native-1',target_bundle:'test.app',front_bundle:'test.front',window_id:'w1',frame:{x:-1000,y:100,width:1000,height:500},tree:'中文静态文字',elements:[
 {ref:'a1',role:'AXTextField',name:'笔记',value:'原文',enabled:true,sensitive:false,frame:{x:10,y:20,width:400,height:30}},
 {ref:'a2',role:'AXStaticText',name:'提示',text:'中文静态文字',interactive:false,frame:{x:10,y:80,width:400,height:30}},
 {ref:'a3',role:'AXSecureTextField',name:'密码',value:'do-not-return',sensitive:true,frame:{x:10,y:150,width:400,height:30}},
 {ref:'a4',role:'AXButton',name:'发送',consequential:true,frame:{x:500,y:20,width:80,height:30}},
],...overrides});
async function reply(computer,promise,result) {
 const request=computer.next().request;assert.ok(request);computer.complete(request.id,result);
 return {request,result:await promise};
}
async function observation(computer) {
 return (await reply(computer,computer.observe({task_id:'task-a',bundle_id:'test.app'},'owner'),observed())).result;
}

test('folder/full desktop access table keeps task gate and reports scope correctly',async t=>{
 for(const mode of ['auto','full']) {
  const {computer,root}=fixture(t,mode);
  const {request,result}=await reply(computer,computer.applications({task_id:'task-a'},'owner'),{applications:[]});
  assert.equal(request.action,'applications');assert.equal(result.cacheScope,'private');assert.equal(result.ttlMs,1000);
  assert.equal(Boolean(result.details?.scope_note),mode==='auto');
  if(mode==='auto')assert.equal(result.details.scope_note,'文件范围是『'+path.basename(root)+'』：不要改动这个文件夹以外的文件；要下载、保存，存进这个文件夹。');
  assert.equal(computer.status().front_app.bundle_id,'test.front');
  assert.equal(computer.status().required_access,'active_task_and_desktop_permission');
 }
});
test('disabled desktop, wrong owner and offline never enqueue',t=>{
 const {computer,state}=fixture(t);
 for(const [mutate,code,caller] of [
  [()=>{state.data.desktop_enabled=false;},'CAPABILITY_OFF','owner'],
  [()=>{state.data.desktop_enabled=true;},'TASK_OWNER','other'],
  [()=>{computer.lastSeen=0;},'NATIVE_COMPUTER_OFFLINE','owner'],
 ]) {
  mutate();assert.throws(()=>computer.request('applications',{},'task-a',caller),{code});assert.equal(computer.pending.size,0);
 }
});
test('observe has no image, returns static text, redacts secure values and preserves references',async t=>{
 const {computer}=fixture(t),o=await observation(computer);
 assert.equal(o.image_base64,undefined);assert.ok(o.observation_id);assert.equal(o.elements[1].text,'中文静态文字');assert.equal(o.elements[2].value,'');assert.equal(o.elements[2].name,'');
 for(const action of ['click','type']) {
  const {request,result}=await reply(computer,computer.action({task_id:'task-a',observation_id:o.observation_id,element_ref:'a1',action,text:'中文😄\n长文'},'owner'),{performed:action,observation:observed({native_snapshot_id:'native-2'})});
  assert.equal(request.args.native_snapshot_id,'native-1');assert.equal(request.args.expected_front,'test.app');
  assert.equal(request.args.x,undefined);assert.equal(request.args.bundle_id,'test.app');assert.ok(result.observation.observation_id);
  assert.equal(computer.observations.has(o.observation_id),true);
 }
});
test('invalid/stale reference table does not dispatch input',async t=>{
 const {computer,policy}=fixture(t),o=await observation(computer);
 for(const [args,code] of [
  [{element_ref:'missing',action:'click'},'COMPUTER_ELEMENT_STALE'],
  [{action:'click',x:20,y:20},'COMPUTER_CAPTURE_REQUIRED'],
  [{element_ref:'a1',action:'type',text:'x'.repeat(4097)},'ARG_INVALID'],
 ]) {
  await assert.rejects(computer.action({task_id:'task-a',observation_id:o.observation_id,...args},'owner'),{code});assert.equal(computer.pending.size,0);
 }
 policy.epoch++;await assert.rejects(computer.action({task_id:'task-a',observation_id:o.observation_id,element_ref:'a1',action:'click'},'owner'),{code:'COMPUTER_OBSERVATION_STALE'});
});
test('target image coordinates map Retina and negative display origin; coordinate capture is single-use',async t=>{
 const {computer,root}=fixture(t);
 const shot=(await reply(computer,computer.screenshot({task_id:'task-a',bundle_id:'test.app'},'owner'),observed({image_base64:'jpeg-test',width:2000,height:1000,capture_scope:'target_window'}))).result;
 const {request}=await reply(computer,computer.action({task_id:'task-a',capture_id:shot.capture_id,action:'click',x:500,y:200,confirm:true},'owner'),{performed:'click'});
 assert.equal(request.args.x,-750);assert.equal(request.args.y,200);assert.equal(request.args.window_id,'w1');
 assert.equal(computer.captures.has(shot.capture_id),false);
 await assert.rejects(computer.action({task_id:'task-a',capture_id:shot.capture_id,action:'click',x:500,y:200,confirm:true},'owner'),{code:'COMPUTER_CAPTURE_STALE'});
});
test('batch validates every step before dispatch and returns partial receipt without replay',async t=>{
 const {computer}=fixture(t),o=await observation(computer);
 for(const steps of [
  [],Array(11).fill({step_id:'a',action:'click',element_ref:'a1'}),
  [{step_id:'same',action:'click',element_ref:'a1'},{step_id:'same',action:'type',element_ref:'a1',text:'x'}],
  [{step_id:'coords',action:'click',x:20,y:20}],
 ]) {
  await assert.rejects(computer.batch({task_id:'task-a',observation_id:o.observation_id,steps},'owner'));assert.equal(computer.pending.size,0);
 }
 const steps=[{step_id:'one',action:'type',element_ref:'a1',text:'中文'},{step_id:'two',action:'key',key:'Enter',confirm:true}];
 const {request,result}=await reply(computer,computer.batch({task_id:'task-a',observation_id:o.observation_id,steps},'owner'),{completed:false,receipts:[{step_id:'one',status:'performed'},{step_id:'two',status:'failed_or_unconfirmed'}],failure:{code:'COMPUTER_ACTION_UNCONFIRMED'},remaining_steps:0,observation:observed()});
 assert.equal(request.action,'batch');assert.equal(request.args.steps[0].step_id,'one');assert.equal(request.args.steps[1].confirm,true);
 assert.equal(result.completed,false);assert.equal(result.failure.code,'COMPUTER_ACTION_UNCONFIRMED');assert.equal(result.receipts.length,2);assert.ok(result.observation.observation_id);
});
test('native errors retain recovery and details; cancelled/epoch requests discard late replies',async t=>{
 const {computer,policy}=fixture(t);
 const pending=computer.request('action',{},'task-a','owner');const q=computer.next().request;
 computer.complete(q.id,{error:{code:'COMPUTER_ACTION_UNCONFIRMED',message:'uncertain',details:{delivery_unconfirmed:true},recovery:{automatic_retry:false}}});
 await assert.rejects(pending,e=>e.code==='COMPUTER_ACTION_UNCONFIRMED'&&e.details.delivery_unconfirmed&&e.recovery.automatic_retry===false);
 const late=computer.request('action',{},'task-a','owner');const q2=computer.next().request;const rejected=assert.rejects(late,{code:'COMPUTER_REQUEST_EXPIRED'});
 policy.epoch++;assert.equal(computer.complete(q2.id,{performed:'click'}).discarded,true);await rejected;
 const stopped=computer.request('action',{},'task-a','owner');const rejectedStop=assert.rejects(stopped,{code:'TASK_REVOKED'});computer.cancelAll();await rejectedStop;
 assert.equal(computer.pending.size,0);assert.equal(computer.observations.size,0);assert.equal(computer.captures.size,0);
});
test('observe can return window candidates when no focused window is available',async t=>{
 const {computer,root}=fixture(t);
 const {result}=await reply(computer,computer.observe({task_id:'task-a',bundle_id:'test.app'},'owner'),{windows:[{window_id:'w1',bundle_id:'test.app'}],observation_unavailable:true,failure:{code:'COMPUTER_WINDOW_MISSING'}});
 assert.equal(result.observation_unavailable,true);assert.equal(result.windows[0].window_id,'w1');assert.equal(result.observation_id,undefined);assert.equal(result.ttlMs,0);assert.equal(result.cacheScope,'private');
});
test('uncertain action errors preserve a fresh redacted observation and folder note',async t=>{
 const {computer,root}=fixture(t),o=await observation(computer);
 const p=computer.action({task_id:'task-a',observation_id:o.observation_id,element_ref:'a1',action:'click'},'owner');
 const q=computer.next().request;
 computer.complete(q.id,{error:{code:'COMPUTER_ACTION_UNCONFIRMED',message:'fixture',details:{do_not_replay:true}},observation:observed()});
 await assert.rejects(p,e=>e.details.do_not_replay&&e.details.observation.elements[2].value===''&&e.details.scope_note.includes(path.basename(root)));
});
test('open_path resolves scope and dispatches executable packages without confirmation',async t=>{
 const {computer,root,state}=fixture(t);
 state.data.desktop_enabled=false;
 for(const [file,directory,executable,confirm] of [['note.txt',false,false,false],['Unity.pkg',false,false,true],['disk.DMG',false,false,true],['Demo.app',true,false,true],['run',false,true,true]]) {
  const p=path.join(root,file);if(directory)fs.mkdirSync(p);else fs.writeFileSync(p,'fixture',{mode:executable?0o700:0o600});
  const {request}=await reply(computer,computer.openPath({task_id:'task-a',path:file},'owner'),{opened:true});
  assert.equal(request.action,'open_path');assert.equal(request.args.path,p);assert.equal(request.args.require_confirmation,undefined,file);
  assert.ok(Number.isFinite(request.args.identity.inode));assert.ok(Number.isFinite(request.args.identity.mtime_ms));
 }
 await assert.rejects(computer.openPath({task_id:'task-a',path:'..'},'owner'),{code:'SCOPE_REQUIRED'});assert.equal(computer.pending.size,0);
 assert.throws(()=>computer.request('action',{},'task-a','owner'),{code:'CAPABILITY_OFF'});
});
test('strict desktop validator accepts object steps and rejects nested/extra/nonfinite input',()=>{
 const definition=COMPUTER_TOOL_UPGRADES.find(t=>t.name==='computer_batch');
 const valid={task_id:'task-a',request_id:'desktop-op-1',observation_id:'observation-a',steps:[{step_id:'one',action:'type',element_ref:'a1',text:'中文'},{step_id:'two',action:'key',key:'Enter',confirm:true}]};
 assert.equal(validateComputerToolArgs(definition,valid),valid);
 for(const invalid of [
  {...valid,extra:true},{...valid,steps:['click']},{...valid,steps:[{step_id:'one',action:'click',element_ref:'a1',extra:true}]},
  {...valid,steps:[]},{...valid,steps:Array(11).fill(valid.steps[0])},{...valid,steps:[{step_id:'one',action:'click',x:NaN}]},
  {...valid,steps:[{step_id:'one',action:'type',text:23}]},{...valid,steps:[{step_id:'one',action:'type',confirm:'yes'}]},
  {...valid,request_id:'short'}, {...valid,steps:[{step_id:'one',action:'unknown'}]},
 ]) assert.throws(()=>validateComputerToolArgs(definition,invalid),{code:'ARG_INVALID'});
 const openDefinition={name:'desktop_action',inputSchema:{type:'object',properties:{task_id:{type:'string'},request_id:{type:'string'},action:{type:'string',enum:['open_path']},path:{type:'string'}},required:['task_id','action'],additionalProperties:false}};
 assert.throws(()=>validateComputerToolArgs(openDefinition,{task_id:'task-a',action:'open_path',path:'x.pkg',arguments:['--script']}),{code:'ARG_INVALID'});
 assert.throws(()=>validateComputerToolArgs(openDefinition,{task_id:'task-a',action:'open_path',path:'x.pkg'}),{code:'ARG_INVALID'});
 assert.ok(validateComputerToolArgs(openDefinition,{task_id:'task-a',request_id:'open-path-1',action:'open_path',path:'x.pkg'}));
});
test('tool upgrade manifests keep names, add observe/batch and stable receipts; no full-access wording',()=>{
 assert.equal(new Set(COMPUTER_TOOL_UPGRADES.map(t=>t.name)).size,COMPUTER_TOOL_UPGRADES.length);
 for(const name of ['computer_observe','computer_batch','computer_status','computer_action','computer_focus','computer_screenshot'])assert.ok(COMPUTER_TOOL_UPGRADES.some(t=>t.name===name));
 for(const tool of COMPUTER_TOOL_UPGRADES)assert.doesNotMatch(tool.description,/Requires full access|single-use capture_id/);
 assert.ok(COMPUTER_TOOL_UPGRADES.find(t=>t.name==='computer_batch').inputSchema.required.includes('request_id'));
 assert.match(COMPUTER_INSTRUCTIONS,/电脑密码只能你自己在 macOS 的框里输/);
});

test('ordinary password, OTP, submit and Return dispatch without confirmation; masked receipts do not echo values',async t=>{
 const {computer}=fixture(t),o=await observation(computer);
 for(const args of [
  {element_ref:'a3',action:'type',text:'fixture-password-1060'},
  {element_ref:'a1',action:'type',text:'fixture-otp-1060'},
  {element_ref:'a3',action:'click'}, {element_ref:'a4',action:'click'}, {action:'key',key:'Enter'},
 ]) {
  const {request,result}=await reply(computer,computer.action({task_id:'task-a',observation_id:o.observation_id,...args},'owner'),{performed:args.action,observation:observed()});
  assert.equal(request.args.action,args.action);assert.equal(request.args.confirm,false);
  assert.doesNotMatch(JSON.stringify(result),/fixture-password-1060|fixture-otp-1060|do-not-return/);
 }
 const steps=[{step_id:'password',element_ref:'a3',action:'type',text:'fixture-password-1060'},{step_id:'return',action:'key',key:'Enter'}];
 const {request}=await reply(computer,computer.batch({task_id:'task-a',observation_id:o.observation_id,steps},'owner'),{completed:true});
 assert.equal(request.args.steps[0].text,'fixture-password-1060');assert.equal(request.args.steps[1].confirm,false);
 const shot=(await reply(computer,computer.screenshot({task_id:'task-a',bundle_id:'test.app'},'owner'),observed({image_base64:'fixture-image',width:1000,height:500}))).result;
 const click=await reply(computer,computer.action({task_id:'task-a',capture_id:shot.capture_id,action:'click',x:20,y:20},'owner'),{performed:'click'});
 assert.equal(click.request.args.confirm,false);
 computer.userStop('task-a',{scope:'desktop'});
 assert.throws(()=>computer.request('action',{},'task-a','owner'),{code:'COMPUTER_USER_ACTIVITY'});
 assert.equal(computer.pending.size,0);
});
