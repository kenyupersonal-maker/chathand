import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chathandGuide} from '../../app/v1/guide.mjs';
import {desktop} from './1052-a-fixture.mjs';

test('guide split and begin_task guidance distinguish explicit pause, user-only gates, cancellation, and ordinary progress in both languages',async t=>{
 const split=chathandGuide('split').text;
 for(const phrase of ['先停，等我继续','waiting_user:true','task_stop','登录','系统批准','用户','换模型','汇报进度','English: Pause only','progress reports']){
  assert.ok(split.includes(phrase),`missing split rule: ${phrase}`);
 }
 const f=await desktop(t),r=f.ok(await f.rpc('begin_task',{request_id:'guidance-batch234-20261124',title:'等待规则'}));
 const guidance=r.guidance??(await f.app.tools.invoke('begin_task',{request_id:'guidance-batch234-20261124',title:'等待规则'},'chatgpt')).guidance;
 assert.ok(guidance,'begin_task must return runtime guidance');
 const both=JSON.stringify(guidance);
 for(const phrase of ['waiting_user:true','task_stop','换模型','汇报进度','login','password','OS approval','Model-switch','progress']){
  assert.ok(both.includes(phrase),`missing begin guidance: ${phrase}`);
 }
});

test('same-session next real call resumes after an explicit pause, disables auto continuation, and never re-executes step one',async t=>{
 const f=await desktop(t),id=await f.begin(),step1={task_id:id,path:'step1.txt',content:'once\\n',expected_sha256:'MISSING',operation_id:'batch234-three-step-one'};
 const first=f.ok(await f.rpc('write_text',step1));
 const cp=f.ok(await f.rpc('task_checkpoint',{task_id:id,done:'第 1 步完成',next:'接着做：第 2 步',block:1,total:3,waiting_user:true}));
 assert.equal(cp.next_action,'end_turn_and_wait_for_user');
 assert.equal(cp.relay.state,'cancelled','explicit waiting does not auto-send a continuation');
 assert.equal(f.app.tools.resume.waitingForUser(id),true);
 const status=f.ok(await f.rpc('task_status',{task_id:id}));
 assert.equal(status.last_checkpoint.done,'第 1 步完成');
 assert.equal(f.app.tools.resume.waitingForUser(id),true,'read-only status does not impersonate actual continuation');
 f.ok(await f.rpc('write_text',{task_id:id,path:'step2.txt',content:'two\\n',expected_sha256:'MISSING',operation_id:'batch234-three-step-two'}));
 assert.equal(f.app.tools.resume.waitingForUser(id),false,'same-session real file operation unlocks waiting');
 const replay=f.ok(await f.rpc('write_text',step1));
 assert.equal(replay.replayed,true,'same stable operation_id only executes once');
 assert.equal(replay.sha256,first.sha256);
 f.ok(await f.rpc('write_text',{task_id:id,path:'step3.txt',content:'three\\n',expected_sha256:'MISSING',operation_id:'batch234-three-step-three'}));
 for(const [file,expected] of [['step1.txt','once\\n'],['step2.txt','two\\n'],['step3.txt','three\\n']]){
  assert.equal(fs.readFileSync(path.join(f.work,file),'utf8'),expected);
 }
 const final=f.ok(await f.rpc('task_checkpoint',{task_id:id,done:'第 3 步完成',next:'全部完成',block:3,total:3}));
 assert.equal(final.checkpoint.waiting_user,false);
 assert.equal(final.waiting_user,false);
});
