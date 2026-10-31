// Isolated state and fake administrator only. No real OS rule or permission UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop,needsInterface} from '../../app/server.mjs';
import {CONFIRM_TTL,confirmationScopes} from '../../app/v1/confirmations.mjs';
import {H8Cards} from '../../app/v1/h8-cards.mjs';
import {highRiskError} from '../../app/v1/high-risk.mjs';
import {capabilityError,permissionsInfo,chatgptSelfAllowed} from '../../app/v1/permissions.mjs';
let seq=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,adminAccess={supported:()=>false,ready:()=>false}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1041-transaction-'))),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'af'.repeat(32),adminAccess});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});
 const rpc=async(name,args={},session='test-session')=>(await app.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}},'test-caller',{setupPrincipal:'test-principal'})).result;
 const task=async(session='test-session')=>{const r=await rpc('begin_task',{request_id:'h8-test-task-'+(++seq),title:'H8 fixture',new_task:true},session);assert.equal(r.isError,false);return app.policy.get(r.structuredContent.task_id);};
 return {app,root,work,rpc,task};
}
test('H8 never grants temporary permission; erase has no allowed scope',()=>{
 assert.deepEqual(confirmationScopes(highRiskError('gatekeeper').details.blocked),['always']);assert.deepEqual(confirmationScopes(highRiskError('erase').details.blocked),[]);
 for(const id of ['admin','chatgpt_self'])assert.deepEqual(confirmationScopes(highRiskError(id).details.blocked),['always']);assert.deepEqual(confirmationScopes(capabilityError('browser').details.blocked),['always']);
});
test('checkpoint option is bound to caller, non-null session, task, transport, epoch/revision and fresh issuance',()=>{
 let now=100;const task={id:'task',caller:'caller',session_hash:'a'.repeat(64),status:'active'},policy={epoch:4,permissionRevision:2,require(id,caller){assert.equal(id,'task');if(caller&&caller!==task.caller)throw Error('owner');if(task.status!=='active')throw Error('ended');return task;}};
 const cards=new H8Cards({policy,now:()=>now});cards.register('skip_step',()=>({ok:true}));
 try{
  const result={task_id:task.id,checkpoint_seq:1,checkpoint:{blocked:{options:[{label:'skip',cost:'none',action:'skip_step'},{label:'other',cost:'none'}]}}};
  const issue=()=>cards.checkpoint(result,task.caller,task.session_hash,'legacy')._card_meta['chathand/card_nonce'];
  assert.throws(()=>cards.checkpoint(result,task.caller,null,'legacy'));
  let nonce=issue();const next=issue();assert.notEqual(nonce,next);assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'legacy'));nonce=next;
  assert.throws(()=>cards.consume(nonce,'1','other',task.session_hash,'legacy'));assert.throws(()=>cards.consume(nonce,'1',task.caller,'b'.repeat(64),'legacy'));assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'2026-07-28'));
  policy.permissionRevision++;assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'legacy'));policy.permissionRevision--;
  policy.epoch++;assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'legacy'));policy.epoch--;
  assert.equal(cards.consume(nonce,'1',task.caller,task.session_hash,'legacy').request,'option:'+task.id);assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'legacy'));
  nonce=issue();now+=CONFIRM_TTL;assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'legacy'));
  nonce=issue();task.status='completed';assert.throws(()=>cards.consume(nonce,'1',task.caller,task.session_hash,'legacy'));
 }finally{cards.close();}
});
test('new checkpoint, task end and settings revision invalidate current option cards',async t=>{
 for(const reason of ['checkpoint','settings','task_end']){
  const f=await fixture(t),task=await f.task(),card=await f.rpc('task_checkpoint',{task_id:task.id,done:'choose',waiting_user:true,blocked:{step:'fixture',error:'fixture',options:[{label:'skip',cost:'none',action:'skip_step'},{label:'other',cost:'none'}]}});assert.equal(card.isError,false,JSON.stringify(card.structuredContent));
  if(reason==='checkpoint')assert.equal((await f.rpc('task_checkpoint',{task_id:task.id,done:'new checkpoint'})).isError,false);
  if(reason==='settings')await f.app.handle('/api/settings',{desktop_enabled:false});
  if(reason==='task_end')await f.app.handle('/api/tasks/stop',{id:task.id});
  const answer=await f.rpc('card_answer',{nonce:card._meta['chathand/card_nonce'],choice:'1'});assert.equal(answer.isError,true,reason);assert.equal(f.app.queue.jobs.size,0);assert.equal(f.app.tools.confirmations.grants.length,0);
 }
});
test('local scope change revokes all old task authority and cancels pending effects',async t=>{
 const f=await fixture(t);await f.app.handle('/api/mode',{mode:'auto'});const mine=await f.task('mine'),other=await f.task('other'),before=f.app.policy.epoch;
 f.app.policy.approvals.set('fixture-approval',{task_id:mine.id,status:'pending_approval'});await f.app.handle('/api/mode',{mode:'full',confirm:true});
 assert.equal(f.app.policy.epoch,before+1);for(const task of [mine,other]){assert.notEqual(task.status,'active');assert.throws(()=>f.app.policy.require(task.id));}assert.equal(f.app.policy.approvals.get('fixture-approval').status,'cancelled');assert.notEqual(f.app.state.data.high_risk?.autostart,true);assert.notEqual(f.app.state.data.high_risk?.admin,true);
});
test('local administrator setting serializes competing permission writes and installs once',async t=>{
 const started=deferred(),done=deferred();let ready=false,installs=0;const fake={supported:()=>true,ready:()=>ready,install:async()=>{installs++;started.resolve();await done.promise;ready=true;return {status:'installed'};}};
 const f=await fixture(t,fake),pending=f.app.handle('/api/settings',{high_risk:{admin:true}});await started.promise;
 await assert.rejects(f.app.handle('/api/mode',{mode:'auto'}),{code:'PERMISSION_TRANSITION'});await assert.rejects(f.app.handle('/api/settings',{high_risk:{admin:true}}),{code:'PERMISSION_TRANSITION'});assert.equal(f.app.state.data.mode,'full');
 done.resolve();assert.equal((await pending).ok,true);assert.equal(installs,1);assert.equal(ready,true);assert.equal(f.app.state.data.high_risk.admin,true);await f.app.handle('/api/settings',{high_risk:{admin:true}});assert.equal(installs,1);
 const origin=permissionsInfo(f.app.state,{adminReady:true}).always_allowed.find(x=>x.id==='admin');assert.equal(origin.via,'settings');assert.ok(Number.isFinite(origin.since));
});
test('failed or thrown local partial administrator install removes only its new rule and never grants',async t=>{
 for(const outcome of ['failed','throw']){
  let ready=false,installs=0,removes=0;const fake={supported:()=>true,ready:()=>ready,install:async()=>{installs++;ready=true;if(outcome==='throw')throw Object.assign(Error('fixture partial failure'),{code:'ADMIN_SETUP_FAILED'});return {status:'failed',message:'fixture partial failure'};},uninstall(){removes++;ready=false;return {status:'removed'};}};
  const f=await fixture(t,fake);await assert.rejects(f.app.handle('/api/settings',{high_risk:{admin:true}}),{code:'ADMIN_SETUP_FAILED'});assert.notEqual(f.app.state.data.high_risk?.admin,true);assert.equal(ready,false);assert.equal(installs,1);assert.equal(removes,1);assert.equal(f.app.tools.confirmations.grants.length,0);
 }
});
test('failed local administrator install preserves a rule already ready before this request',async t=>{
 let ready=false,installs=0,removes=0;const fake={supported:()=>true,ready:()=>ready,install:async()=>{installs++;return {status:'failed',message:'fixture failure'};},uninstall(){removes++;ready=false;return {status:'removed'};}};
 const f=await fixture(t,fake);ready=true;await assert.rejects(f.app.handle('/api/settings',{high_risk:{admin:true}}),{code:'ADMIN_SETUP_FAILED'});assert.notEqual(f.app.state.data.high_risk?.admin,true);assert.equal(ready,true);assert.equal(installs,1);assert.equal(removes,0);
});
test('local scope change waits for old-process cleanup before committing full mode',async t=>{
 const f=await fixture(t);await f.app.handle('/api/mode',{mode:'auto'});let draining=true;const old=f.app.queue.list;f.app.queue.list=()=>draining?[{process_alive:true}]:[];
 try{const pending=f.app.handle('/api/mode',{mode:'full',confirm:true});assert.equal(f.app.policy.transitioning,true);assert.equal(f.app.state.data.mode,'auto');await assert.rejects(f.app.handle('/api/settings',{browser_enabled:true}),{code:'PERMISSION_TRANSITION'});draining=false;assert.equal((await pending).ok,true);assert.equal(f.app.state.data.mode,'full');assert.equal(f.app.policy.transitioning,false);}finally{f.app.queue.list=old;}
});
test('full tier keeps exact defaults; self capability works in folder scope; revoke is UI-only',async t=>{
 const f=await fixture(t);await f.app.handle('/api/permissions/tier',{tier:'full'});const info=permissionsInfo(f.app.state,{adminReady:false});assert.equal(info.tier,'full');assert.equal(info.capabilities.terminal.enabled,true);assert.equal(info.capabilities.browser.enabled,true);assert.equal(info.capabilities.desktop.enabled,true);
 for(const id of ['gatekeeper','power','pipe_run','keychain','bulk_delete','bulk_perm','chatgpt_self'])assert.equal(info.high_risk.find(x=>x.id===id).enabled,false,id);assert.equal(f.app.state.data.admin_requested,true);assert.equal(f.app.state.data.high_risk?.admin===true,false);
 await f.app.handle('/api/mode',{mode:'auto'});await f.app.handle('/api/settings',{high_risk:{chatgpt_self:true}});assert.equal(chatgptSelfAllowed(f.app.state),true);assert.equal(permissionsInfo(f.app.state).high_risk.find(x=>x.id==='chatgpt_self').usable_now,true);
 assert.equal(needsInterface('/api/permissions/revoke',{}),true);await f.app.handle('/api/permissions/revoke',{gate:'high_risk',id:'chatgpt_self'});assert.equal(chatgptSelfAllowed(f.app.state),false);assert.equal(permissionsInfo(f.app.state).always_allowed.some(x=>x.id==='chatgpt_self'),false);
});
test('finite option submission uses one checkpoint lock and skip only records, never grants permission',async t=>{
 const f=await fixture(t),task=await f.task(),before=JSON.stringify(f.app.state.data.high_risk),r=await f.rpc('task_checkpoint',{task_id:task.id,done:'blocked fixture',waiting_user:true,blocked:{step:'fixture',error:'fixture',options:[{label:'model label',cost:'none',action:'skip_step'},{label:'other',cost:'none'}]}});
 assert.equal(r.isError,false);assert.equal(r.structuredContent.checkpoint.blocked.options[0].label,'跳过此步骤');const nonce=r._meta['chathand/card_nonce'];
 const native={task_id:task.id,checkpoint_seq:r.structuredContent.checkpoint_seq,choice:'1',via:'window',input:{human:true}};
 assert.equal(needsInterface('/api/checkpoint/action',native),true);await assert.rejects(f.app.handle('/api/checkpoint/action',{...native,input:{human:false}}),{code:'CONFIRM_NOT_HUMAN'});
 const answers=await Promise.allSettled([f.rpc('card_answer',{nonce,choice:'1'}),f.rpc('card_answer',{nonce,choice:'1'}),f.app.handle('/api/checkpoint/action',native)]);assert.equal(answers.filter(x=>x.status==='fulfilled'&&(x.value.ok||x.value.structuredContent?.ok)).length,1);assert.equal(JSON.stringify(f.app.state.data.high_risk),before);
 assert.equal(f.app.tools.resume.tasks.get(task.id).checkpoints.at(-1).choice,'跳过此步骤');
});
