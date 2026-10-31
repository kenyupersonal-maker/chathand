// Isolated local regression suite. No production service, credentials, UI or admin access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {CommandQueue,OUTPUT_LIMIT,HARD_OUTPUT_LIMIT} from '../../engine/src/commands.mjs';
import {FINISHED_OUTPUT_BUDGET,OUTPUT_RETENTION_AGE_MS,RETENTION_INTERVAL_MS,OUTPUT_REDUCED_NOTICE,
 outputBytes,reduceJobOutput} from '../../engine/src/command-output-retention.mjs';
import {MAX_BLOCKS,MAX_BLOCK_LINES,MAX_FAILURE_CHARS,selectFailureLines} from '../../engine/src/output-failure-ranges.mjs';
import {digestJob} from '../../app/v1/output-digest.mjs';
import {TaskPolicy} from '../../app/policy.mjs';
import {taskHistory} from '../../app/v06/changes.mjs';
import {activityHistory} from '../../app/v09/product-model.mjs';
import {lastOutputLine} from '../../app/v1/job-line.mjs';
import {CommandCompletionNotes} from '../../app/v1/command-completion.mjs';

const HASH='a'.repeat(64),CALLER='chatgpt';
function controlledClock(start=Date.now()){
 let at=start,next=0;const timers=new Map();
 return {now:()=>at,setInterval(fn,ms){const id=++next;timers.set(id,{fn,ms});return id;},
  clearInterval(id){timers.delete(id);},advance(ms){at+=ms;},fire(){for(const {fn} of timers.values())fn();},
  timers};
}
function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-command500-'));
 const store={root,stateDir:path.join(root,'state'),paused:false,writesEnabled:true,
  checkActive(){if(this.paused)throw Object.assign(Error('disabled'),{code:'LOCAL_DISABLED'});},
  resolve(value){const result=path.resolve(root,value);if(result!==root&&!result.startsWith(root+path.sep))throw Error('TEST_SCOPE');return result;},audit(){}};
 const clock=controlledClock(),queue=new CommandQueue(store,{killGraceMs:20,retentionClock:clock,...options});
 t.after(async()=>{await queue.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'chathand-command500-')));fs.rmSync(root,{recursive:true,force:true});});
 return {root,store,queue,clock};
}
function synthetic(queue,clock,{status='completed',finishedAt=clock.now(),texts=[],...extra}={}){
 const j={id:crypto.randomUUID(),request_id:'synthetic-'+crypto.randomUUID(),stamp:'synthetic-only',
  program:'/usr/bin/printf',args:['synthetic'],cwd:'.',absoluteCwd:queue.store.root,root:queue.store.root,
  mode:'task',timeout_ms:2000,stdin_mode:'closed',status,created_at:finishedAt-20,started_at:finishedAt-10,
  finished_at:finishedAt,exit_code:0,signal:null,child:null,cleanupPending:false,
  stdout:'',stderr:'',events:[],next_cursor:0,base_cursor:0,kept_bytes:0,raw_bytes:0,truncated:false,
  task_id:'synthetic-task',...extra};
 queue.jobs.set(j.id,j);
 for(const item of texts){const stream=typeof item==='string'?'stdout':item.stream,text=typeof item==='string'?item:item.text;queue.appendOutput(j,stream,text);j.raw_bytes+=Buffer.byteLength(text);}
 return j;
}
function metadata(j){return Object.fromEntries(['id','request_id','stamp','program','args','cwd','absoluteCwd','root','mode',
 'timeout_ms','stdin_mode','status','pid','exit_code','signal','created_at','started_at','finished_at','task_id','raw_bytes'].map(k=>[k,structuredClone(j[k])]));}
const spec=(request_id='retention-new-command')=>({program:process.execPath,args:['-e','process.stdout.write("isolated\\n")'],cwd:'.',request_id});
const orderedLines=job=>(job.events||[]).flatMap(event=>(event.text.match(/[^\n]*\n|[^\n]+$/g)||[]).map(text=>({stream:event.stream,text,cursor:event.cursor})));

test('production policy defaults are 500 active slots, ten minutes and UTF-8 200 MiB',t=>{
 const {queue}=fixture(t);assert.equal(FINISHED_OUTPUT_BUDGET,200*1024*1024);assert.equal(OUTPUT_RETENTION_AGE_MS,600000);
 assert.equal(RETENTION_INTERVAL_MS,30000);assert.equal(queue.finishedOutputBudget,FINISHED_OUTPUT_BUDGET);
 assert.equal(queue.outputRetentionAgeMs,600000);assert.equal(queue.maxRunning,4);
 assert.equal(queue.outputLimit,OUTPUT_LIMIT);assert.equal(queue.hardOutputLimit,HARD_OUTPUT_LIMIT);
 assert.deepEqual([MAX_BLOCKS,MAX_BLOCK_LINES,MAX_FAILURE_CHARS],[12,25,4000]);
});

test('600 real sequential commands and command 601; first record, ownership, finish and saved task history survive',
 {skip:process.platform==='win32',timeout:120000},async t=>{
 const {queue,root,store,clock}=fixture(t);
 const state={data:{active:'isolated-project',mode:'auto',auto_approve_tasks:true,conversations:[],session_groups:{}},save(){}};
 const policy=new TaskPolicy(state,store,queue);policy.enabled=true;
 const begun=policy.begin({request_id:'command500-real-task',title:'601 isolated commands'},CALLER,{session_hash:HASH});
 const task=policy.tasks.get(begun.task_id);let first,firstMetadata,firstSpec;
 for(let i=1;i<=601;i++){
  const text=i===1?Array.from({length:100},(_,line)=>line===1?'Error: retained synthetic test text':'first-line-'+line).join('\n'):'short-command-'+i;
  const input={...spec('command500-real-'+i),program:'/usr/bin/printf',args:['%s\n',text]};
  const proposed=queue.propose(input),job=queue.get(proposed.job_id);
  policy.jobOwners.set(job.id,task.id);task.jobs.push(job.id);queue.approve(job.id);
  const result=await queue.result(job.id,20000);
  assert.equal(result.status,'completed','command '+i);assert.equal(result.exit_code,0);assert.equal(result.cleanup_pending,false);
  for(let n=0;n<100&&!queue.settled(job);n++)await delay(5);
  assert.equal(queue.settled(job),true,'settled command '+i);
  if(i===1){first=job;firstMetadata=metadata(job);firstSpec=input;}
 }
 const timelineLast=lastOutputLine(first.events);
 clock.advance(OUTPUT_RETENTION_AGE_MS+120000);clock.fire();assert.equal(first.output_retention.reduced,true);
 assert.equal(lastOutputLine(first.events),timelineLast);
 assert.equal(queue.jobs.size,601);assert.deepEqual(metadata(queue.get(first.id)),firstMetadata);
 assert.equal(queue.list().find(j=>j.job_id===first.id).cwd,'.');assert.ok(first.program.endsWith('/printf'));
 assert.ok(first.created_at<=first.started_at&&first.started_at<=first.finished_at);
 assert.equal(policy.jobOwners.get(first.id),task.id);assert.equal(task.jobs[0],first.id);
 const replay=queue.propose(firstSpec);assert.equal(replay.replayed,true);assert.equal(replay.job_id,first.id);assert.equal(queue.jobs.size,601);
 assert.throws(()=>queue.propose({...firstSpec,args:['different']}),{code:'OP_CONFLICT'});
 const end=policy.finish(task.id,CALLER,true,'isolated regression complete');
 assert.equal(end.execution_complete,true);assert.equal(end.jobs.length,601);
 const history=taskHistory(policy,CALLER,{limit:100,detail:true},HASH);
 assert.equal(history.tasks.length,1);assert.equal(history.tasks[0].jobs[0],first.id);
 const home=activityHistory(policy,state);assert.equal(home.items.length,1);
 assert.equal(home.items[0].tasks[0].task_id,task.id);assert.equal(home.items[0].tasks[0].jobs[0],first.id);
 assert.equal(policy.receipts.read(task.id,CALLER).result.jobs.length,601);
 const disk=JSON.parse(fs.readFileSync(path.join(root,'state','command-receipts',first.request_id+'.json'),'utf8'));
 for(const field of ['program','args','cwd','stdout','stderr','events','output_retention'])assert.equal(Object.hasOwn(disk,field),false);
 assert.equal(disk.job_id,first.id);assert.equal(disk.exit_code,0);
 const restarted=new CommandQueue(store,{retentionClock:controlledClock()});
 try{assert.equal(restarted.jobs.size,0);assert.throws(()=>restarted.propose(firstSpec),{code:'REPLAY_PREVIOUS_SESSION'});}
 finally{await restarted.close();}
});

test('500 queued/running slots reject; terminal-but-live or cleaning still counts; no records removed',t=>{
 const {queue,clock}=fixture(t);
 for(let i=0;i<500;i++)synthetic(queue,clock,{status:i%2?'running':'queued'});
 assert.throws(()=>queue.propose(spec()),{code:'QUEUE_FULL'});
 const jobs=[...queue.jobs.values()];Object.assign(jobs[0],{status:'cancelled',child:{}});
 Object.assign(jobs[1],{status:'failed',cleanupPending:true});Object.assign(jobs[2],{status:'completed',process_alive:true});
 Object.assign(jobs[3],{status:'failed',containment:'windows-job',cleanupConfirmed:false,cleanupState:'unconfirmed'});
 for(const job of jobs.slice(0,4))assert.equal(queue.settled(job),false);
 assert.throws(()=>queue.propose(spec()),{code:'QUEUE_FULL'});
 jobs[0].child=null;assert.equal(queue.settled(jobs[0]),true);
 assert.equal(queue.propose(spec()).status,'pending_approval');assert.equal(queue.jobs.size,501);
 // Clear only synthetic live flags so the fixture never pretends to own processes.
 jobs[1].cleanupPending=false;jobs[2].process_alive=false;
});

test('expired approval is processed before both admission and 30-pending limit',t=>{
 const a=fixture(t),b=fixture(t);
 for(let i=0;i<499;i++)synthetic(a.queue,a.clock,{status:'queued'});
 const expired=synthetic(a.queue,a.clock,{status:'pending_approval',created_at:Date.now()-a.queue.approvalMs-1});
 assert.equal(a.queue.propose(spec('expired-slot-new')).status,'pending_approval');assert.equal(expired.status,'expired');
 for(let i=0;i<29;i++)synthetic(b.queue,b.clock,{status:'pending_approval'});
 synthetic(b.queue,b.clock,{status:'pending_approval',created_at:Date.now()-b.queue.approvalMs-1});
 assert.equal(b.queue.propose(spec('expired-pending-new')).status,'pending_approval');
 assert.throws(()=>b.queue.propose(spec('pending31-denied')),{code:'QUEUE_FULL'});
});

test('original maxRunning=4 remains independent of 500 active slots',t=>{
 const {queue,clock}=fixture(t);const pending=queue.propose(spec('parallel-limit-probe'));
 const live=Array.from({length:4},()=>synthetic(queue,clock,{status:'running',child:{}}));
 assert.throws(()=>queue.approve(pending.job_id),{code:'JOB_BUSY'});
 for(const job of live)job.child=null;
 assert.equal(queue.get(pending.job_id).status,'pending_approval');
});

test('time maintenance, without a new command, keeps failures plus exactly 40 combined tail lines under digest length gate',t=>{
 const {queue,clock}=fixture(t);const texts=Array.from({length:100},(_,i)=>({stream:i%2?'stderr':'stdout',text:'line-'+i+'\n'}));
 texts[2].text='✖ early failed test\n';texts[3].text='  assertion detail\n';texts[4].text='  expected value\n';
 const job=synthetic(queue,clock,{texts});const before=metadata(job),original=orderedLines(job),next=job.next_cursor;
 clock.advance(OUTPUT_RETENTION_AGE_MS);clock.fire();assert.equal(job.output_retention,undefined);
 clock.advance(1);clock.fire();assert.equal(job.output_retention.reduced,true);assert.equal(job.output_retention.reason,'age');
 assert.deepEqual(metadata(job),before);assert.equal(job.next_cursor,next);assert.equal(queue.jobs.size,1);
 assert.deepEqual(orderedLines(job).slice(-40),original.slice(-40));
 assert.deepEqual(job.events.map(e=>e.cursor),[2,3,4,...Array.from({length:40},(_,i)=>60+i)]);
 assert.equal(job.kept_bytes,outputBytes(job));
 const identity=job.events,receipt=job.output_retention;clock.fire();queue.list();assert.equal(job.events,identity);assert.equal(job.output_retention,receipt);
});

test('budget shrinks oldest completed record first, leaves newer records intact after reaching budget',t=>{
 const {queue,clock}=fixture(t,{finishedOutputBudget:2600});
 const texts=Array.from({length:100},()=>('x'.repeat(9)+'\n'));
 const oldest=synthetic(queue,clock,{finishedAt:clock.now()-3000,texts});
 const middle=synthetic(queue,clock,{finishedAt:clock.now()-2000,texts});
 const newest=synthetic(queue,clock,{finishedAt:clock.now()-1000,texts});
 const newestEvents=newest.events,middleEvents=middle.events,status=queue.maintainOutputs();
 assert.equal(oldest.output_retention.reason,'budget');assert.equal(status.retained_bytes,2400);assert.equal(status.over_budget,false);
 assert.equal(middle.output_retention,undefined);assert.equal(newest.output_retention,undefined);
 assert.equal(middle.events,middleEvents);assert.equal(newest.events,newestEvents);assert.equal(queue.jobs.size,3);
});

test('UTF-8 bytes, not string length, determine memory trigger',t=>{
 const {queue,clock}=fixture(t,{finishedOutputBudget:300});
 const job=synthetic(queue,clock,{texts:Array.from({length:100},()=> '汉\n')});
 assert.equal(outputBytes(job),400);assert.equal(job.events.reduce((n,e)=>n+e.text.length,0),200);
 const status=queue.maintainOutputs();assert.equal(status.retained_bytes,160);assert.equal(job.output_retention.reason,'budget');
});

test('full:true and default both disclose loss; sparse cursors do not duplicate or conceal gaps',async t=>{
 const {queue,clock}=fixture(t);const texts=Array.from({length:100},(_,i)=>({stream:i%2?'stderr':'stdout',text:'row-'+i+'\n'}));
 texts[1].text='Error: early failure\n';const job=synthetic(queue,clock,{texts,finishedAt:clock.now()-600001});queue.maintainOutputs();
 const result=await queue.result(job.id,0,0);
 for(const full of [false,true]){
  const view=digestJob(result,{full});assert.equal(view.output_notice,OUTPUT_REDUCED_NOTICE);assert.equal(view.output_digest.full_available,false);
  assert.equal(view.output_digest.full_hint,null);assert.equal(view.stdout,result.stdout);assert.equal(view.stderr,result.stderr);
 }
 assert.equal(result.cursor_gap,true);assert.ok(result.cursor_gaps.some(g=>g.from===4&&g.to_exclusive===60));
 const ids=result.output_events.map(e=>e.cursor);assert.equal(new Set(ids).size,ids.length);assert.equal(result.next_cursor,100);
 const after=await queue.result(job.id,0,result.next_cursor);
 assert.equal(after.stdout,'');assert.equal(after.stderr,'');assert.deepEqual(after.output_events,[]);assert.equal(after.cursor_gap,false);
 assert.equal(after.next_cursor,100);assert.equal(result.output_events.at(-1).stream,texts.at(-1).stream);
});

test('a multiline event is shortened without renumbering its event ID; partial-event loss is explicit',async t=>{
 const {queue,clock}=fixture(t);const text=Array.from({length:100},(_,i)=>'multi-'+i+'\n').join('');
 const job=synthetic(queue,clock,{texts:[text],finishedAt:clock.now()-600001});queue.maintainOutputs();
 const result=await queue.result(job.id,0,0);assert.equal(result.next_cursor,1);assert.equal(result.output_events[0].cursor,0);
 assert.equal(orderedLines(job).length,40);assert.equal(result.cursor_gap,true);assert.deepEqual(result.partial_event_cursors,[0]);
 assert.equal((await queue.result(job.id,0,1)).stdout,'');
});

test('running, cancelled-with-process, pending cleanup and unconfirmed Windows cleanup never shrink',t=>{
 const {queue,clock}=fixture(t,{finishedOutputBudget:1});
 const texts=Array.from({length:100},(_,i)=>'protected-'+i+'\n');
 const jobs=[synthetic(queue,clock,{status:'running',finishedAt:clock.now()-700000,texts}),
  synthetic(queue,clock,{status:'cancelled',child:{},finishedAt:clock.now()-700000,texts}),
  synthetic(queue,clock,{status:'failed',cleanupPending:true,finishedAt:clock.now()-700000,texts}),
  synthetic(queue,clock,{status:'failed',containment:'windows-job',cleanupConfirmed:false,cleanupState:'unconfirmed',finishedAt:clock.now()-700000,texts})];
 const original=jobs.map(j=>j.events);clock.fire();assert.equal(queue.outputRetentionStatus.eligible_jobs,0);
 jobs.forEach((j,i)=>{assert.equal(j.events,original[i]);assert.equal(j.output_retention,undefined);});
 jobs[1].child=null;jobs[2].cleanupPending=false;
});

test('all already-minimal output may remain over budget; records are retained and no second reduction runs',t=>{
 const {queue,clock}=fixture(t,{finishedOutputBudget:1});
 const jobs=[synthetic(queue,clock,{texts:['z'.repeat(1000)]}),synthetic(queue,clock,{texts:['汉'.repeat(500)]})];
 const first=queue.maintainOutputs();assert.equal(first.over_budget,true);assert.equal(first.retained_bytes,2500);
 assert.equal(first.processed_jobs,2);assert.equal(first.unprocessed_jobs,0);assert.equal(queue.jobs.size,2);
 const events=jobs.map(j=>j.events);assert.equal(queue.maintainOutputs().processed_now,0);
 jobs.forEach((j,i)=>assert.equal(j.events,events[i]));assert.equal(first.hard_process_memory_limit,false);
});

test('shared failure limits cap early blocks while final tail, including failures, is retained once',t=>{
 const lines=Array.from({length:400},(_,i)=>i%4===0?'Error: block '+i:'value '+i);
 const selected=selectFailureLines(lines);assert.ok(selected.blocks<=12);assert.ok(selected.indices.size<=12*25);
 assert.ok([...selected.indices].reduce((n,i)=>n+lines[i].length+1,0)<=4000);
 const {queue,clock}=fixture(t);const job=synthetic(queue,clock,{texts:lines.map(x=>x+'\n')});reduceJobOutput(job);
 assert.deepEqual(orderedLines(job).slice(-40).map(x=>x.text),lines.slice(-40).map(x=>x+'\n'));
 const tailFailure='Error: failure inside tail';const summary=digestJob({stdout:'ok\n'.repeat(140)+tailFailure+'\n',stderr:''});
 assert.equal(summary.stdout.split(tailFailure).length-1,1);
});

test('completion notices keep metadata and remain one-shot after reduction; timer is disposed on close',async t=>{
 const {queue,clock}=fixture(t);const job=synthetic(queue,clock,{status:'running',texts:Array.from({length:100},(_,i)=>'note-'+i+'\n')});
 const notes=new CommandCompletionNotes({readJob:id=>id===job.id?{...queue.publicJob(job),task_id:job.task_id}:null});
 assert.equal(notes.collect(HASH,CALLER,'propose_command',{},queue.publicJob(job)),null);
 job.status='completed';job.finished_at=clock.now()-700000;queue.maintainOutputs();
 const note=notes.collect(HASH,CALLER,'read_text',{},{});assert.equal(note.kind,'command_finished');assert.equal(note.jobs[0].job_id,job.id);
 assert.equal(notes.collect(HASH,CALLER,'read_text',{},{}),null);assert.equal(clock.timers.size,1);
 await queue.close();assert.equal(clock.timers.size,0);
});
