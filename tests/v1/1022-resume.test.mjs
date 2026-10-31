import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';import {TOOLS} from '../../app/tools.mjs';import {TASK_URI} from '../../app/v06/features.mjs';import {WORKFLOW_INSTRUCTIONS} from '../../app/v1/workflow.mjs';
import {forecastText,forecastCall} from '../../app/v1/check-forecast.mjs';import {ResumeKeeper,normalEnd} from '../../app/v1/resume.mjs';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1022-resume-')),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'c'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1022,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 let now=1_000_000;app.tools.resume.now=()=>now;
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 let id=0;const call=async(name,args={},session='conv-a')=>{const r=await app.tools.rpc({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}},'chatgpt',{setupPrincipal:'acct-1'});return r.result;};
 return {app,work,call,tick:ms=>{now+=ms;},root};
}

test('forecast: plain work none, security-ish code maybe, attack wording likely',()=>{
 assert.equal(forecastText('整理下载文件夹，把 PDF 放进文档'),'none');
 assert.equal(forecastText('修改 app/v06/sandbox.mjs 的超时'),'maybe');
 assert.equal(forecastText('sandbox seatbelt 权限 拦截'),'maybe');
 assert.equal(forecastText('写一个 exploit 绕过 sandbox'),'likely');
 assert.equal(forecastCall('propose_command',{program:'codesign',args:['--verify','--deep','x.app']}),'none');
 assert.equal(forecastCall('read_text',{path:'notes.md'},{content:'kill SIGKILL sandbox 权限 管理员'}),'maybe');
 assert.ok(normalEnd('finish_task')&&normalEnd('task_checkpoint',{waiting_user:true})&&!normalEnd('task_checkpoint',{})&&!normalEnd('write_text'));
});

test('tools: checkpoint and claim exist; status is card-callable; instructions say keep going and checkpoint',()=>{
 const cp=TOOLS.find(x=>x.name==='task_checkpoint'),claim=TOOLS.find(x=>x.name==='task_resume_claim'),st=TOOLS.find(x=>x.name==='task_status');
 assert.deepEqual(cp.inputSchema.required,['task_id','done']);assert.equal(cp._meta.ui.resourceUri,TASK_URI);assert.equal(cp._meta['openai/outputTemplate'],TASK_URI);
 assert.equal(claim._meta['openai/visibility'],'private');assert.equal(st._meta['openai/widgetAccessible'],true);assert.equal(st.inputSchema.properties.from_card.type,'boolean');
 assert.ok(TOOLS.find(x=>x.name==='begin_task').inputSchema.properties.new_task);
 assert.ok(WORKFLOW_INSTRUCTIONS.includes('task_checkpoint')&&WORKFLOW_INSTRUCTIONS.includes('last_checkpoint'));
});

test('checkpoints keep the last 20 and drive task_status',async t=>{
 const {call}=await fixture(t);const b=(await call('begin_task',{request_id:'resume_cp_1',title:'长任务'})).structuredContent;
 for(let i=1;i<=22;i++)await call('task_checkpoint',{task_id:b.task_id,done:`第 ${i} 块`,next:`第 ${i+1} 块`,total:22,block:i});
 const s=(await call('task_status',{task_id:b.task_id})).structuredContent;
 assert.equal(s.checkpoints,20);assert.equal(s.last_checkpoint.done,'第 22 块');assert.equal(s.last_checkpoint.total,22);
 const bad=await call('task_checkpoint',{task_id:b.task_id,done:''});assert.equal(bad.isError,true);
 const w=(await call('task_checkpoint',{task_id:b.task_id,done:'问用户',waiting_user:true})).structuredContent;assert.equal(w.next_action,'end_turn_and_wait_for_user');
});

test('begin_task replays the same ID and reuses the open task without asking again',async t=>{
 const {call}=await fixture(t);const a=(await call('begin_task',{request_id:'resume_guard_a',title:'改代码'})).structuredContent;
 const again=await call('begin_task',{request_id:'resume_guard_b',title:'改代码'});
 assert.equal(again.isError,false);assert.equal(again.structuredContent.task_id,a.task_id);assert.equal(again.structuredContent.reused_open_task,true);assert.equal(again.structuredContent.status,'active');assert.equal(again.structuredContent.expires_at,null);
 assert.equal((await call('begin_task',{request_id:'resume_guard_a',title:'改代码'})).structuredContent.replayed,true);
 assert.ok((await call('begin_task',{request_id:'resume_guard_c',title:'别的'},'conv-b')).structuredContent.task_id);
 assert.ok((await call('begin_task',{request_id:'resume_guard_d',title:'另一件',new_task:true})).structuredContent.task_id);
 await call('finish_task',{task_id:a.task_id,summary:'好了'});
});

test('stall needs quiet and no normal end; trusted native status reads do not forge a model turn',async t=>{
 const {call,tick,app}=await fixture(t);const b=(await call('begin_task',{request_id:'resume_stall_1',title:'长任务'})).structuredContent;
 await call('task_checkpoint',{task_id:b.task_id,done:'第 1 块',next:'第 2 块'});
 // Native status projection, not an unverified public from_card RPC flag.
 const card=async()=>app.tools.resume.stall(app.policy.view(app.policy.get(b.task_id)));
 tick(9*60000);let s=await card();assert.equal(s.stalled,false);assert.equal(s.basis,'provisional');assert.equal(s.threshold_ms,600000);
 tick(2*60000);s=await card();assert.equal(s.stalled,true);
 // Trustworthy local snapshots are read-only and do not change last model activity.
 s=await card();assert.equal(s.stalled,true);
 // 正常结束（等用户）以后再安静多久都不算
 await call('task_checkpoint',{task_id:b.task_id,done:'要问用户',waiting_user:true});tick(60*60000);s=await card();assert.equal(s.stalled,false);assert.equal(s.waiting_user,true);
});

test('after a stall a model tool carries the resume note; retired parallel sender stays disabled',async t=>{
 const {call,tick,app}=await fixture(t);const b=(await call('begin_task',{request_id:'resume_note_1',title:'长任务'})).structuredContent;
 await call('task_checkpoint',{task_id:b.task_id,done:'改完 policy',next:'写测试',block:1,total:3});
 tick(11*60000);
 // Silent time alone is not a diagnostic event. A real card status observation
 // calls ResumeKeeper.stall(), which emits and persists the first stall record.
 assert.equal(app.tools.resume.diagnostics().recent_stalls.length,0,'no false stall without an observer');
 const card=app.tools.resume.stall(app.policy.view(app.policy.get(b.task_id)));
 assert.equal(card.stalled,true);
 const recorded=app.tools.resume.diagnostics().recent_stalls;
 assert.equal(recorded.length,1,'card observation persists exactly one stall');
 assert.equal(recorded[0].task_id,b.task_id);
 assert.equal(recorded[0].resumed_at,null);
 const retired=(await call('task_resume_claim',{task_id:b.task_id})).structuredContent;
 assert.equal(retired.granted,false);assert.equal(retired.reason,'old_parallel_sender_disabled');
 assert.ok(retired.chathand_note?.zh.includes('改完 policy'),'the public retired tool is a real model turn');
 tick(1000);
 const resumed=(await call('task_status',{task_id:b.task_id})).structuredContent;
 assert.equal(resumed.chathand_note,undefined);
 assert.equal((await call('task_status',{task_id:b.task_id})).structuredContent.chathand_note,undefined);
 tick(11*60000);
 const stillRetired=(await call('task_resume_claim',{task_id:b.task_id})).structuredContent;
 assert.equal(stillRetired.granted,false);
 assert.equal(stillRetired.reason,'old_parallel_sender_disabled');
 const log=app.tools.resume.diagnostics();
 assert.equal(log.recent_stalls.length,1);
 assert.equal(log.recent_stalls[0].task_id,b.task_id);
 assert.ok(Number.isFinite(log.recent_stalls[0].resumed_at),'actual next model call marks the recorded stall as resumed');
});

test('threshold comes from the gap data once there is enough of it',()=>{
 let now=0;const r=new ResumeKeeper({now:()=>now});
 for(let i=0;i<250;i++){r.before('h'.repeat(64),'read_text',{});now+=10000;}
 const th=r.threshold('h'.repeat(64));assert.equal(th.basis,'data');assert.equal(th.ms,120000);
 r.data.gaps=Array(250).fill(90000);assert.equal(r.threshold(null).ms,180000);
});

test('forecast note is attached once per task when it first reaches maybe',async t=>{
 const {call}=await fixture(t);const b=(await call('begin_task',{request_id:'resume_fc_1',title:'改 app/v06/sandbox.mjs 的超时'})).structuredContent;
 assert.equal(b.chathand_forecast.level,'maybe');assert.ok(b.chathand_forecast.tell_user.includes('请发送「继续」，不要点击「重试」'));
 const first=(await call('task_status',{task_id:b.task_id})).structuredContent;assert.equal(first.chathand_forecast,undefined);assert.equal(first.forecast,'maybe');
 const plain=(await call('begin_task',{request_id:'resume_fc_2',title:'整理照片'},'conv-c')).structuredContent;assert.equal(plain.chathand_forecast,undefined);
});


test('blocked checkpoint validates nested options, appears as blocker, and choice clears it',async t=>{
 const {call}=await fixture(t);const b=(await call('begin_task',{request_id:'resume_blocked_1',title:'卡住的任务'})).structuredContent;
 const blocked={step:'下载发布包',error:'HTTP 403: access denied',why:'没有下载权限',options:[{label:'用本机已有包',cost:'要核对版本'},{label:'等权限',cost:'现在先停'}]};
 const cp=(await call('task_checkpoint',{task_id:b.task_id,done:'下载这一步走不通',next:'等用户选',waiting_user:true,blocked})).structuredContent;
 assert.equal(cp.checkpoint.blocked.step,'下载发布包');
 let status=(await call('task_status',{task_id:b.task_id})).structuredContent;assert.equal(status.blocker.step,'下载发布包');assert.equal(status.blocker.options.length,2);
 const tooMany=await call('task_checkpoint',{task_id:b.task_id,done:'坏参数',blocked:{...blocked,options:[...blocked.options,{label:'3',cost:'x'},{label:'4',cost:'x'},{label:'5',cost:'x'}]}});
 assert.equal(tooMany.isError,true);assert.equal(tooMany.structuredContent.code,'ARG_INVALID');
 const noStep=await call('task_checkpoint',{task_id:b.task_id,done:'坏参数',blocked:{error:'x',options:blocked.options}});
 assert.equal(noStep.isError,true);assert.equal(noStep.structuredContent.code,'ARG_INVALID');
 await call('task_checkpoint',{task_id:b.task_id,done:'用户已经选了',next:'按选择继续',choice:'用本机已有包'});
 status=(await call('task_status',{task_id:b.task_id})).structuredContent;assert.equal(status.blocker,null);assert.equal(status.last_checkpoint.choice,'用本机已有包');
 assert.ok(WORKFLOW_INSTRUCTIONS.includes('blocked + waiting_user:true')&&WORKFLOW_INSTRUCTIONS.includes('task_checkpoint（choice）'));
});
