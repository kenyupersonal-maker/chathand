import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CommandCompletionNotes,commandEndWords} from '../app/v1/command-completion.mjs';
import {createDesktop} from '../app/server.mjs';
import {mergeNotes} from '../app/tools.mjs';

const notes=result=>{const n=result?.structuredContent?.chathand_note;return n?[n,...(n.also||[])]:[];};
const completion=result=>notes(result).find(n=>n.kind==='command_finished');
function unit(){const jobs=new Map(),n=new CommandCompletionNotes({readJob:(id,caller,hash)=>caller==='chatgpt'&&hash==='session-a'?jobs.get(id):null});
 const start=id=>{const j={job_id:id,task_id:'t',status:'running',started_at:1000,finished_at:null,process_alive:true};jobs.set(id,j);assert.equal(n.collect('session-a','chatgpt','propose_command',{},j),null);return j;};
 const end=(id,extra={})=>Object.assign(jobs.get(id),{status:'completed',exit_code:0,finished_at:22000,process_alive:false},extra);
 const call=(name='bridge_info',result={},hash='session-a',opts={})=>n.collect(hash,'chatgpt',name,{},result,opts);
 return {n,jobs,start,end,call};}

test('1030 C：同对话下一次调用提醒一次，另一对话不消费或泄露',()=>{
 const f=unit();f.start('j1');f.end('j1');assert.equal(f.call('bridge_info',{},'session-b'),null);
 const n=f.call();assert.equal(n.kind,'command_finished');assert.match(n.zh,/命令 j1 已结束：正常结束，用了 21 秒。用 command_result 看输出。/);assert.equal(n.jobs[0].duration_ms,21000);assert.equal(f.call(),null);
});
test('1030 C：已拿到 command_result 或嵌套 operation_status 的最终命令回执，不重复提醒',()=>{
 for(const name of ['command_result','operation_status']){const f=unit();const j=f.start('j');f.end('j');assert.equal(f.call(name,name==='operation_status'?{result:j}:j),null);assert.equal(f.call(),null);}
});
test('1030 C：task_status 真返回终态才算看过；只有任务ID列表不假装读过命令结果',()=>{
 const f=unit();f.start('j');f.end('j');assert.equal(f.call('task_status',{task_id:'t',terminal:true,jobs:['j']}),null);assert.equal(f.call(),null);
 const g=unit();g.start('j');g.end('j');assert.equal(g.call('task_status',{task_id:'t',terminal:false,jobs:['j']}).kind,'command_finished');
});
test('1030 C：命令刚回运行中、审批未执行、清理未结束都不提前报告',()=>{
 const f=unit();const j=f.start('j');assert.equal(f.call(),null);f.end('j',{cleanup_pending:true});assert.equal(f.call(),null);f.end('j',{cleanup_pending:false});assert.equal(f.call().jobs.length,1);
 const g=unit();g.jobs.set('late',{job_id:'late',task_id:'t',status:'completed',exit_code:0,started_at:0,finished_at:100});assert.equal(g.call('propose_command',{job_id:'late',status:'running'}),null);assert.ok(g.call());
 const h=unit();assert.equal(h.call('propose_command',{job_id:'no-run',status:'pending_approval'}),null);assert.equal(h.call(),null);
});
test('1030 C：多个已结束命令一起提醒，后续和重放不重复',()=>{
 const f=unit();f.start('a');f.start('b');f.end('a');f.end('b',{status:'failed',exit_code:2});const n=f.call();assert.equal(n.jobs.length,2);assert.match(n.zh,/用法错误（退出码 2）/);assert.equal(f.call(),null);
 assert.equal(f.call('propose_command',{job_id:'a',status:'running'}),null);assert.equal(f.call(),null);
});
test('1030 C：结束原因沿用退出码人话，错误回复也可合并其它提示',()=>{
 assert.equal(commandEndWords({status:'failed',exit_code:1}),'执行出错（退出码 1）');assert.equal(commandEndWords({status:'cancelled',exit_code:null}),'已停止');assert.equal(commandEndWords({status:'failed',signal:'SIGKILL'}),'已强制结束（退出码 137）');
 const f=unit();f.start('j');f.end('j');const n=f.call('read_text',null,'session-a',{failed:true}),merged=mergeNotes({kind:'confirmation',zh:'原提示'},n);assert.equal(merged.kind,'confirmation');assert.equal(merged.also[0].kind,'command_finished');
});

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1030-complete-')),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'c'.repeat(64),clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1029,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.state.data.mode='full';app.policy.enabled=true;app.policy.fullArmed=true;app.queue.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 let seq=0;const call=async(name,args={},session='conv-a',principal='acct-1')=>{const r=await app.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}},'chatgpt',{setupPrincipal:principal});return r.result;};
 const started=await call('begin_task',{request_id:'1030-command-note-fixture',title:'isolated completion'});assert.equal(started.isError,false);const task_id=started.structuredContent.task_id;
 const run=async()=>{const r=await call('propose_command',{task_id,program:process.execPath,args:['-e',"setTimeout(()=>console.log('done'),400)"],cwd:work,request_id:'command-fixture-'+(++seq),wait_ms:0,timeout_ms:5000});assert.equal(r.isError,false,JSON.stringify(r.structuredContent));assert.equal(r.structuredContent.status,'running');assert.equal(completion(r),undefined);const id=r.structuredContent.job_id;const final=await app.queue.result(id,3000);assert.equal(final.status,'completed');return id;};
 return {app,call,task_id,run};
}
test('1030 C RPC：真实隔离长命令结束后只提醒一次，普通 from_card 轮询不冒充私有卡片，其它账号不会消费',async t=>{
 const f=await fixture(t),id=await f.run();
 assert.equal(completion(await f.call('bridge_info',{},'conv-b')),undefined);assert.equal(completion(await f.call('bridge_info',{},'conv-a','acct-2')),undefined);
 const r=await f.call('task_status',{task_id:f.task_id,from_card:true});assert.equal(completion(r).jobs[0].job_id,id);assert.match(completion(r).zh,/正常结束/);assert.equal(completion(await f.call('bridge_info')),undefined);
});
test('1030 C RPC：ChatGPT 自己已查 command_result 全文，下一工具不再重复提醒',async t=>{
 const f=await fixture(t),id=await f.run();const r=await f.call('command_result',{job_id:id,full:true});assert.equal(r.structuredContent.segments.map(x=>x.text).join(''),'done\n');assert.equal(completion(r),undefined);assert.equal(completion(await f.call('bridge_info')),undefined);
});
test('1030 C RPC：下一工具报错仍携带完成提醒，但连接已停用时不泄露',async t=>{
 const f=await fixture(t),id=await f.run();f.policy=f.app.policy;f.policy.enabled=false;
 assert.equal(completion(await f.call('bridge_info')),undefined);f.policy.enabled=true;
 const r=await f.call('read_text',{path:'missing.txt'});assert.equal(r.isError,true);assert.equal(completion(r).jobs[0].job_id,id);assert.equal(completion(await f.call('bridge_info')),undefined);
});
test('1030 C RPC：task_status 已返回任务终态时不附重复的完成提醒',async t=>{
 const f=await fixture(t);await f.run();f.app.policy.finish(f.task_id,'chatgpt',true,'done');const r=await f.call('task_status',{task_id:f.task_id});assert.equal(r.structuredContent.terminal,true);assert.equal(completion(r),undefined);assert.equal(completion(await f.call('bridge_info')),undefined);
});
