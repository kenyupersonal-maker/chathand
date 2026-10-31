import test from 'node:test';import assert from 'node:assert/strict';
import {desktop} from './1052-a-fixture.mjs';
test('1058 disabled browser remains disabled, gives settings location and never creates a waiting grant card',async t=>{
 const f=await desktop(t);await f.app.handle('/api/settings',{browser_enabled:false});const id=await f.begin();
 const r=await f.rpc('browser_open',{task_id:id,request_id:'1058-off-browser',url:'https://example.invalid'});assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'CAPABILITY_OFF');
 const b=r.structuredContent.details.blocked;assert.equal(b.confirm,null);assert.equal(b.answer_in_chat,false);assert.match(b.next,/App|ChatHand/);assert.doesNotMatch(b.say_to_user.join(' '),/点对话里的确认卡/);
 assert.equal(f.app.tools.confirmations.pending({task_id:id}),null);assert.equal(f.app.state.data.browser_enabled,false);assert.equal(f.app.policy.get(id).status,'active');
});
test('1060 obsolete manual task approval flag cannot recreate pending approval',async t=>{
 const f=await desktop(t);f.app.state.data.mode='auto';f.app.state.data.auto_approve_tasks=false;f.app.policy.fullArmed=false;const r=f.ok(await f.rpc('begin_task',{request_id:'1058-manual-task',title:'手动审批'}));assert.equal(r.status,'active');assert.equal(r.expires_at,null);
 const write=await f.rpc('create_directory',{task_id:r.task_id,path:'denied',operation_id:'1058-manual-write'});assert.equal(write.isError,false);assert.equal(f.app.policy.get(r.task_id).status,'active');assert.equal(f.app.tools.confirmations.pending({task_id:r.task_id}),null);
});
test('1058 production rendered finish result carries shell data while card capability remains transport-only',async t=>{
 const f=await desktop(t),id=await f.begin();const response=await f.rpc('finish_task',{task_id:id,success:true,summary:'完成隔离核对'});const r=f.ok(response);
 assert.equal(r.widget_shell.protocol,1);assert.equal(r.widget_shell.density,'comfortable');assert.deepEqual(r.widget_shell.sections,[]);assert.equal(r._card_meta,undefined);
});
