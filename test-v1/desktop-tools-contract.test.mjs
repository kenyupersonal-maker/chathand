import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Tools,TOOLS} from '../app/tools.mjs';
import {NativeComputer,COMPUTER_TOOL_UPGRADES} from '../app/v07/computer.mjs';
import {UIOperations} from '../app/v07/operations.mjs';

// Import and fake routing only: no Tools constructor, server, browser constructor,
// native execute, macOS permission probe, screenshot, clipboard or input event.
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-sa4-tools-'))),workspace=path.join(dir,'workspace'),stateDir=path.join(dir,'state');
 fs.mkdirSync(workspace);
 const state={data:{mode:'auto',desktop_enabled:true,active:'p',projects:[{id:'p',name:'测试文件夹',path:workspace}]}};
 const store={root:workspace,stateDir,audit(){},resolve(p){const real=fs.realpathSync(path.resolve(workspace,p));if(!real.startsWith(workspace+path.sep))throw Object.assign(Error('scope'),{code:'SCOPE_REQUIRED'});return real;}};
 const policy={epoch:1,store,tasks:new Map(),check(){},require(id,caller){if(id!=='task-a'||caller!=='owner')throw Object.assign(Error('owner'),{code:'TASK_OWNER'});}};
 const computer=new NativeComputer(state,policy),ops=new UIOperations(stateDir,policy);
 computer.heartbeat({accessibility:true,screen_recording:true});
 const tools=Object.assign(Object.create(Tools.prototype),{state,store,policy,queue:{},blocks:{record(){}},lastCalls:{},automation:{computer,ops,has(){return false;}},features:{has(){return false;}}});
 t.after(()=>{computer.cancelAll();fs.rmSync(dir,{recursive:true,force:true});});
 return {tools,computer,state,workspace};
}
const observed={native_snapshot_id:'native-fixture',target_bundle:'test.app',window_id:'w1',frame:{x:0,y:0,width:800,height:500},elements:[{ref:'a1',role:'AXTextField',name:'文字',frame:{x:20,y:30,width:400,height:30}}],tree:'中文'};
async function nativeReply(computer,pending,result){
 await new Promise(resolve=>setImmediate(resolve));
 const q=computer.next().request;assert.ok(q);computer.complete(q.id,result);return {request:q,result:await pending};
}

test('registered desktop contracts keep existing names unique and add object-step batch',()=>{
 for(const definition of COMPUTER_TOOL_UPGRADES)assert.equal(TOOLS.filter(t=>t.name===definition.name).length,1,definition.name);
 const desktop=TOOLS.find(t=>t.name==='desktop_action');
 assert.ok(desktop.inputSchema.properties.action.enum.includes('open_path'));
 assert.equal(desktop.inputSchema.properties.request_id.type,'string');
 assert.equal(TOOLS.find(t=>t.name==='computer_batch').inputSchema.properties.steps.items.type,'object');
 assert.equal(TOOLS.find(t=>t.name==='browser_batch').inputSchema.properties.steps.items.type,'object','browser upgrade contract retained');
});
test('Tools observe/batch routing accepts object steps, journals once, reuses the request receipt',async t=>{
 const {tools,computer}=fixture(t);
 const o=(await nativeReply(computer,tools.invoke('computer_observe',{task_id:'task-a',bundle_id:'test.app'},'owner'),observed)).result;
 const args={task_id:'task-a',request_id:'batch-contract-1',observation_id:o.observation_id,steps:[{step_id:'one',action:'type',element_ref:'a1',text:'中文'}]};
 const {request,result}=await nativeReply(computer,tools.invoke('computer_batch',args,'owner'),{completed:true,receipts:[{step_id:'one',status:'performed'}],observation:observed});
 assert.equal(request.action,'batch');assert.equal(request.args.steps[0].text,'中文');assert.equal(result.completed,true);
 const replay=await tools.invoke('computer_batch',args,'owner');assert.deepEqual(replay,result);assert.equal(computer.next().request,null);
 await assert.rejects(tools.invoke('computer_batch',{...args,steps:[{step_id:'one',action:'type',text:'x',extra:true}]},'owner'),{code:'ARG_INVALID'});
 assert.equal(computer.pending.size,0);
});
test('Tools open_path works with desktop input off and accepts no arbitrary launch arguments',async t=>{
 const {tools,computer,state,workspace}=fixture(t);state.data.desktop_enabled=false;
 fs.writeFileSync(path.join(workspace,'note.txt'),'fixture');
 const args={task_id:'task-a',request_id:'open-contract-1',action:'open_path',path:'note.txt'};
 const {request}=await nativeReply(computer,tools.invoke('desktop_action',args,'owner'),{opened:true});
 assert.equal(request.action,'open_path');assert.equal(request.args.path,path.join(workspace,'note.txt'));assert.equal(request.args.require_confirmation,undefined);
 await assert.rejects(tools.invoke('desktop_action',{...args,arguments:['--arbitrary']},'owner'),{code:'ARG_INVALID'});
 await assert.rejects(tools.invoke('computer_observe',{task_id:'task-a'},'owner'),{code:'CAPABILITY_OFF'});
 assert.equal(computer.pending.size,0);
});
test('desktop RPC preserves bounded redacted details and returns optional window image as image content',async t=>{
 const {tools}=fixture(t);
 tools.invoke=async()=>({performed:'click',observation:{observation_id:'o1',image_base64:'test-image-bytes',mimeType:'image/jpeg',window_id:'w1'}});
 const image=await tools.rpcInternal({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'computer_action',arguments:{}}},'owner');
 assert.equal(image.result.content[1].type,'image');assert.equal(image.result.content[1].data,'test-image-bytes');
 assert.equal(image.result.structuredContent.observation.image_base64,undefined);assert.doesNotMatch(image.result.content[0].text,/test-image-bytes/);
 tools.invoke=async()=>{throw Object.assign(Error('fixture'),{code:'COMPUTER_ACTION_UNCONFIRMED',details:{delivery_unconfirmed:true,scope_note:'folder',password:'fake-fixture',text:'sk-testFixtureSecret'},recovery:{next_action:'computer_observe',automatic_retry:false}});};
 const failure=await tools.rpcInternal({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'computer_action',arguments:{}}},'owner');
 assert.equal(failure.result.structuredContent.details.delivery_unconfirmed,true);
 for(const key of ['password','text'])assert.equal(Object.hasOwn(failure.result.structuredContent.details,key),false);assert.doesNotMatch(JSON.stringify(failure),/fake-fixture|sk-testFixtureSecret/);
 assert.equal(failure.result.structuredContent.recovery.next_action,'computer_observe');assert.equal(failure.result.structuredContent.recovery.automatic_retry,false);
 const init=await tools.rpcInternal({jsonrpc:'2.0',id:3,method:'initialize',params:{}},'owner');
 assert.match(init.result.instructions,/文件工具、命令、AppleScript、快捷指令或 URL scheme/);
});
