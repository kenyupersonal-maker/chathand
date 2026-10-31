import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {UIOperations} from '../../app/v07/operations.mjs';

const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-handoff-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const policy={epoch:1,require(){}};
 return {dir,policy,ops:new UIOperations(dir,policy)};
}
const args={task_id:'handoff-task',request_id:'handoff-request-01',action:'click'};
const receipts=ops=>fs.readdirSync(ops.dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(ops.dir,n),'utf8')));

test('the same request changes caller without performing the UI effect twice',async t=>{
 const {ops}=fixture(t);let count=0,release;
 const waiting=new Promise(r=>release=r),run=()=>{count++;return waiting;};
 const first=ops.run('computer_action',args,'openai-caller',run);
 const second=ops.run('computer_action',args,'site-caller',run);
 assert.equal(first,second);release({completed:true});await first;
 assert.equal(count,1);assert.equal(receipts(ops).length,1);
 assert.deepEqual(await ops.previous('computer_action',args,'new-chat'),{completed:true});
 assert.throws(()=>ops.run('computer_action',{...args,action:'type'},'new-chat',run),{code:'OP_CONFLICT'});
});
test('a restart and caller handoff cannot replay a persisted UI attempt',async t=>{
 const {dir,policy,ops}=fixture(t);let count=0;
 await ops.run('computer_action',args,'openai-caller',()=>{count++;return {completed:true};});
 const restarted=new UIOperations(dir,policy);
 assert.throws(()=>restarted.run('computer_action',args,'site-caller',()=>{count++;}),{code:'UI_ACTION_ALREADY_ATTEMPTED'});
 assert.equal(count,1);
});
for(const status of ['started','completed','failed_or_unknown'])test(`legacy caller-keyed ${status} receipt also prevents replay across connections`,t=>{
 const {ops}=fixture(t),stamp=hash(JSON.stringify(['computer_action',args]));
 fs.writeFileSync(path.join(ops.dir,hash('old-caller\0'+args.request_id)+'.json'),JSON.stringify({version:1,tool:'computer_action',stamp,status,time:1}));
 assert.throws(()=>ops.previous('computer_action',args,'new-caller'),{code:'UI_ACTION_ALREADY_ATTEMPTED'});
 assert.throws(()=>ops.run('computer_action',args,'new-caller',()=>assert.fail('must not execute')),{code:'UI_ACTION_ALREADY_ATTEMPTED'});
});
test('different tasks may use the same local request ID without sharing effects',async t=>{
 const {ops}=fixture(t);let count=0;
 await ops.run('computer_action',args,'caller',()=>++count);
 await ops.run('computer_action',{...args,task_id:'other-task'},'caller',()=>++count);
 assert.equal(count,2);
});
test('posted-but-unconfirmed native success envelopes persist as unknown, never completed',async t=>{
 const {ops}=fixture(t);let count=0;
 const result={method:'background_target_click',background:true,delivery_status:'posted_unconfirmed',delivery_unconfirmed:true,do_not_replay:true,completed:false,verified:false};
 assert.deepEqual(await ops.run('computer_action',args,'caller',()=>{count++;return result;}),result);
 assert.equal(receipts(ops)[0].status,'failed_or_unknown');assert.equal(receipts(ops)[0].code,'UI_ACTION_UNCONFIRMED');assert.equal(ops.uncertainTasks.has(args.task_id),true);
 assert.deepEqual(await ops.run('computer_action',args,'another-caller',()=>{count++;}),result);assert.equal(count,1);
});
test('an explicit confirmed foreground receipt remains completed',async t=>{
 const {ops}=fixture(t);
 await ops.run('computer_action',args,'caller',()=>({completed:true,verified:true,foreground_input_events:2}));
 assert.equal(receipts(ops)[0].status,'completed');assert.equal(ops.uncertainTasks.has(args.task_id),false);
});
test('legacy request conflicts are checked for the current and original task caller',t=>{
 const {ops,policy}=fixture(t),stamp=hash(JSON.stringify(['computer_action',args]));
 policy.tasks=new Map([[args.task_id,{caller:'original-caller'}]]);
 fs.writeFileSync(path.join(ops.dir,hash('original-caller\0'+args.request_id)+'.json'),JSON.stringify({version:1,tool:'computer_action',stamp,status:'completed',time:1}));
 for(const caller of ['original-caller','new-caller']){
  const changed={...args,action:'type'};
  assert.throws(()=>ops.previous('computer_action',changed,caller),{code:'OP_CONFLICT'});
  assert.throws(()=>ops.run('computer_action',changed,caller,()=>assert.fail('must not dispatch')),{code:'OP_CONFLICT'});
 }
});
test('a resolved browser failure is not a completed action and retains only its code',async t=>{
 const {ops}=fixture(t);const result={status:'failed',error:{code:'ELEMENT_CHANGED',message:'fake private input body'}};
 assert.deepEqual(await ops.run('browser_action',args,'caller',()=>result),result);
 const [receipt]=receipts(ops);assert.equal(receipt.status,'failed_or_unknown');assert.equal(receipt.code,'ELEMENT_CHANGED');assert.doesNotMatch(JSON.stringify(receipt),/fake private/);
});
test('a legacy ingress receipt survives restart even when its old task is no longer live',t=>{
 const {ops,policy}=fixture(t),stamp=hash(JSON.stringify(['browser_tabs',args]));policy.tasks=new Map();
 fs.writeFileSync(path.join(ops.dir,hash('chatgpt\0'+args.request_id)+'.json'),JSON.stringify({version:1,tool:'browser_tabs',stamp,status:'failed_or_unknown',time:1}));
 assert.throws(()=>ops.previous('browser_tabs',args,'local-mcp'),{code:'UI_ACTION_ALREADY_ATTEMPTED'});
 assert.throws(()=>ops.previous('browser_tabs',{...args,action:'new'},'local-mcp'),{code:'OP_CONFLICT'});
});
