import {jobRunning,jobRunMs} from './command-brief.mjs';
// 1022：回复停住了怎么接。
// 记每段对话最后一次调用、每个任务的进度和最近几步、调用间隔；据此判断「停住了」，
// 停住后下一次调用附一次 chathand_note；卡片领一次「替你发继续」。全部只存在本机。
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
import {PACING,stallBudget} from './pacing.mjs';
import {forecastCall,forecastHits,FORECAST_RANK} from './check-forecast.mjs';

const MIN_STALL_MS=120000,PROVISIONAL_MS=600000,MAX_GAP_MS=1800000,DATA_READY=200,GAP_KEEP=2000,STALL_KEEP=500,CHECKPOINT_KEEP=20,STEP_KEEP=8;
// 一轮正常结束的调用：之后的安静是在等用户，不算停住。
export function normalEnd(name,args={}){return name==='finish_task'||name==='image_batch_save'||name==='request_update'||name==='task_checkpoint'&&args.waiting_user===true;}
export function sessionHashOf(principal,session){return typeof principal==='string'&&principal&&typeof session==='string'&&session.trim()&&session.length<=4096?crypto.createHash('sha256').update(JSON.stringify([principal,session])).digest('hex'):null;}
// 回给 ChatGPT 的大概字数（只算长度，不存内容）。
function sizeOf(result){if(result===null||result===undefined)return 0;try{const text=typeof result==='string'?result:JSON.stringify(result);return typeof text==='string'?text.length:0;}catch{return null;}}
const clip=(v,n)=>typeof v==='string'?([...v].length>n?[...v].slice(0,n-1).join('')+'…':v):'';
function stepOf(name,args={}){
 const target=args.path?String(args.path):args.destination?String(args.destination):args.program?[args.program,...(Array.isArray(args.args)?args.args:[])].join(' '):args.url?String(args.url):args.query?String(args.query):'';
 return {tool:name,target:clip(target,120)};
}

export class ResumeKeeper{
 constructor({stateDir=null,now=Date.now,emit=()=>{},events=null}={}){
  Object.assign(this,{stateDir,now,emit,events});
  this.sessions=new Map();this.tasks=new Map();this.claims=new Map();
  this.file=stateDir?path.join(stateDir,'resume-stats.json'):null;
  this.data={gaps:[],stalls:[]};
  try{if(this.file&&fs.existsSync(this.file)){const d=JSON.parse(fs.readFileSync(this.file,'utf8'));if(Array.isArray(d.gaps))this.data.gaps=d.gaps.filter(Number.isFinite).slice(-GAP_KEEP);if(Array.isArray(d.stalls))this.data.stalls=d.stalls.slice(-STALL_KEEP);}}catch{/* 统计坏了就从头记 */}
 }
 save(){if(!this.file)return;try{fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}catch{/* 统计写不进去不影响工作 */}}
 task(id){let t=this.tasks.get(id);if(!t){t={checkpoints:[],checkpoint_seq:0,steps:[],forecast:'none',forecast_noted:false,auto_blocks:new Set(),hits:new Set()};this.tasks.set(id,t);}return t;}

 // 间隔的分布：99% 的情况都不超过的那个数。
 p99(){const g=[...this.data.gaps].sort((a,b)=>a-b);return g.length?g[Math.min(g.length-1,Math.floor(g.length*0.99))]:null;}
 threshold(hash,model=this.tasks.get(this.sessions.get(hash)?.task_id)?.model||'unknown'){
  const s=hash?this.sessions.get(hash):null,longest=s?.longest_gap||0,n=this.data.gaps.length,p=this.p99();
  if(n>=DATA_READY)return {ms:stallBudget(Math.max(MIN_STALL_MS,2*p,3*longest),model),basis:'data',samples:n};
  // 数据不够时只给卡片用（不弹通知、不自动发）：这段对话里见过的最长间隔的 3 倍，没有就保守地等 10 分钟。
  return {ms:stallBudget(Math.max(MIN_STALL_MS,3*longest,n>=20?2*p:PROVISIONAL_MS),model),basis:'provisional',samples:n};
 }

 // 一次不是卡片发起的调用进来（在执行之前）。返回要附在这次结果里的话。
 before(hash,name,args={}){
  if(!hash)return null;const now=this.now(),s=this.sessions.get(hash);let note=null;
  if(s){
   const gap=now-s.last_at;
   if(!s.normal_end&&gap>0&&gap<MAX_GAP_MS){
    const th=this.threshold(hash);
    if(gap>th.ms){note=this.resumeNote(s);this.markResumed(s,now);}
    else{this.data.gaps.push(gap);this.data.gaps=this.data.gaps.slice(-GAP_KEEP);s.longest_gap=Math.max(s.longest_gap||0,gap);s.gaps=[...(s.gaps||[]),gap].slice(-50);this.unsaved=(this.unsaved||0)+1;}
   }else if(!s.normal_end&&gap>=MAX_GAP_MS){note=this.resumeNote(s);this.markResumed(s,now);}
   }
  const activeTask=args.task_id||s?.task_id;
  if(activeTask&&!['begin_task','task_status','show_task','bridge_info','task_checkpoint'].includes(name)&&!(['command_result','propose_command'].includes(name)&&args.wait_ms>0)){const t=this.tasks.get(activeTask);if(t){t.waiting_job=null;t.waited_job=null;}}
  const next=s||{longest_gap:0,task_id:null};
  if(!['task_status','show_task','bridge_info','task_checkpoint'].includes(name)){next.last_real_call_at=now;next.real_call_seq=(next.real_call_seq||0)+1;}
  next.last_at=now;next.last_tool=name;next.normal_end=false;next.pending=true;next.call_started=now;this.sessions.set(hash,next);
  if(this.unsaved>=20){this.unsaved=0;this.save();}
  return note;
 }
 // 执行完。绑上任务、记一步、算预报；返回第一次到「可能」时要附的提醒。
 after(hash,name,args={},result=null,isError=false){
  const s=hash?this.sessions.get(hash):null,taskId=args.task_id||(name==='begin_task'?result?.task_id:null)||s?.task_id||null;
  const now=this.now(),ms=s?.call_started?Math.max(0,now-s.call_started):null,bytes=sizeOf(result);
  if(s){s.pending=false;if(!isError)s.normal_end=normalEnd(name,args);if(taskId&&name!=='task_status')s.task_id=taskId;
   // 1027：停住记录要看停之前最后几次调用花了多久、回了多少字、成没成。
   s.recent=[...(s.recent||[]),{tool:name,at:now,ms,bytes,ok:!isError}].slice(-5);}
  if(!taskId)return null;
  const t=this.task(taskId);
  if(name==='begin_task'&&!isError){t.model=result?.model||'unknown';t.trial=result?.trial||'medium';}
  if(!['task_status','show_task','task_checkpoint','bridge_info'].includes(name)){t.steps.push({...stepOf(name,args),at:now,ok:!isError,ms,bytes});t.steps=t.steps.slice(-STEP_KEEP);}
  if(hash)t.session_hash=hash;
  if(!['begin_task','task_status','show_task','bridge_info','task_checkpoint'].includes(name)&&!(name==='command_result'&&args.wait_ms>0)){
   const b=t.block||(t.block={n:0,at:now,noted:false});b.n++;
   const limit=PACING.block[t.trial||'medium'];
   if(!b.noted&&!this.waitingJob(taskId)&&(b.n>=limit.calls||now-b.at>=limit.ms)){
    b.noted=true;t.block_note={zh:`这一块已经做了 ${b.n} 次调用、${Math.floor((now-b.at)/60000)} 分钟：调一次 task_checkpoint 记下做到哪，记完接着做，不结束这一轮。`};this.events?.record('block.nudge',{task:taskId,n:b.n,ms:now-b.at});
   }
  }
  if(name==='read_file'&&typeof args.path==='string'&&args.path.includes('ChatHand-工具返回.noindex/')&&Number.isSafeInteger(result?.next_offset))t.archive_cursor={path:args.path,next_offset:result.next_offset};
  if(name==='command_result'&&args.full===true&&!isError)t.full_output_cursor={job_id:args.job_id,full_cursor:result?.read_full_cursor??null,final_total:result?.final_total===true};
  const level=forecastCall(name,args,result);
  if(level!=='none')for(const w of forecastHits(name,args,result))if(t.hits.size<12)t.hits.add(w);
  if(FORECAST_RANK[level]>FORECAST_RANK[t.forecast])t.forecast=level;
  if(FORECAST_RANK[t.forecast]>=1&&!t.forecast_noted){t.forecast_noted=true;return forecastNote(t.forecast);}
  return null;
 }

 checkpoint(taskId,{done='',next='',waiting_user=false,block=null,total=null,blocked=null,choice=''}={}){
  if(typeof done!=='string'||!done.trim()||[...done].length>200)fail('ARG_INVALID','done 写这一块做完了什么，200 字以内。');
  if(typeof next!=='string'||[...next].length>200)fail('ARG_INVALID','next 写下一块做什么，200 字以内。');
  if(typeof choice!=='string'||[...choice].length>60)fail('ARG_INVALID','choice 写用户选了哪个，60 字以内。');
  for(const [k,v] of Object.entries({block,total}))if(v!==null&&v!==undefined&&!(Number.isInteger(v)&&v>=1&&v<=99))fail('ARG_INVALID',`${k} 需要是 1–99 的整数。`);
  if(block&&total&&block>total)fail('ARG_INVALID','block 不能大于 total。');
  const t=this.task(taskId);t.block=null;t.block_note=null;const seq=++t.checkpoint_seq,c={at:this.now(),done:done.trim(),next:next.trim(),waiting_user:waiting_user===true,block:block??seq,total:total??t.checkpoints.at(-1)?.total??null,...(blocked?{blocked:structuredClone(blocked)}:{}),...(choice.trim()?{choice:choice.trim()}:{})};
  t.waiting_user_call_seq=this.sessions.get(t.session_hash)?.real_call_seq||0;
  t.checkpoints.push(c);t.checkpoints=t.checkpoints.slice(-CHECKPOINT_KEEP);
  return {recorded:true,task_id:taskId,card:'checkpoint',checkpoint_seq:seq,checkpoint:{...c},checkpoints:t.checkpoints.length,waiting_user:c.waiting_user,next_action:c.waiting_user?'end_turn_and_wait_for_user':'continue_without_stopping',round_guidance:c.waiting_user?'等用户处理后继续。':'这块已记录，接着做下一块，不结束这一轮。'};
 }

 waitingForUser(id){const t=this.tasks.get(id),s=this.sessions.get(t?.session_hash);return t?.checkpoints.at(-1)?.waiting_user===true&&(s?.real_call_seq||0)<=(t.waiting_user_call_seq||0);}
 // 卡片、ChatHand 窗口都用这个看任务停没停。
 stallSnapshot(task){return this.stall(task,{record:false});}
 stall(task,{record=true}={}){
  if(!task||!['active'].includes(task.status))return null;
  const t=this.tasks.get(task.task_id||task.id),hash=task.session_hash||t?.session_hash,s=hash?this.sessions.get(hash):null;
  if(!s||s.task_id&&s.task_id!==(task.task_id||task.id))return null;
  const now=this.now(),quiet=now-s.last_at,th=this.threshold(hash,task.model||t?.model||'unknown'),claim=this.claims.get(task.task_id||task.id);
  const awaiting=this.waitingForUser(task.task_id||task.id);
  const view={stalled:false,waiting_user:awaiting||!!s.normal_end,quiet_ms:quiet,threshold_ms:th.ms,basis:th.basis,last_at:s.last_at,last_tool:s.last_tool,running:!!s.pending,...(this.waitingJob(task.task_id||task.id)?{waiting_job:this.waitingJob(task.task_id||task.id)}:{})};
  view.external_wait=this.waitState?.(task.task_id||task.id)?.kind==='external';view.auto_allowed=th.basis==='data'&&!view.external_wait;
  if(claim)view.claim={claimed_at:claim.claimed_at,resumed:s.last_at>claim.claimed_at,block:claim.block};
  if(awaiting||s.normal_end||s.pending||quiet<=th.ms)return view;
  view.stalled=true;view.same_block_again=!!(t&&t.auto_blocks.has(this.blockKey(t)));
  const key=(task.task_id||task.id)+':'+s.last_at;
  if(record&&s.stall_key!==key){s.stall_key=key;this.logStall(task,t,th.basis,{quiet_ms:quiet,threshold_ms:th.ms,session:s});this.emit('task_stalled',{task_id:task.task_id||task.id,title:task.title,basis:th.basis});}
  return view;
 }
 nextStallAt(task){
  if(!task||task.status!=='active')return Infinity;
  const id=task.task_id||task.id,t=this.tasks.get(id),hash=task.session_hash||t?.session_hash,s=this.sessions.get(hash);
  if(!s||s.task_id&&s.task_id!==id||s.pending||s.normal_end||this.waitingForUser(id)||s.stall_key===id+':'+s.last_at)return Infinity;
  return s.last_at+this.threshold(hash,task.model||t?.model||'unknown').ms+1;
 }
 blockKey(t){return String(t.checkpoints.at(-1)?.block??0);}
 // 卡片替用户发「继续」前领一次：同一次停住只领得到一次；同一块已经自动发过就不再发。
 claim(task){
  const v=this.stall(task);if(!v?.stalled)return {granted:false,reason:'not_stalled'};
  const id=task.task_id||task.id,t=this.task(id),s=this.sessions.get(task.session_hash||t.session_hash),key=id+':'+s.last_at,block=this.blockKey(t);
  if(this.claims.get(id)?.key===key)return {granted:false,reason:'already_claimed'};
  if(t.auto_blocks.has(block))return {granted:false,reason:'same_block_again'};
  t.auto_blocks.add(block);this.claims.set(id,{key,claimed_at:this.now(),block});
  return {granted:true,claimed_at:this.now()};
 }
 takeBlockNote(hash){const t=this.tasks.get(this.sessions.get(hash)?.task_id),note=t?.block_note||null;if(t)t.block_note=null;return note;}
 waitingJob(id){
  const t=this.tasks.get(id);if(!t?.waiting_job)return null;
  const live=this.jobState?.(t.waiting_job.job_id);
  if(live?.mode==='service'){t.waiting_job=null;return null;}
  if(live){const w={...t.waiting_job,status:live.status,running:jobRunning(live),run_ms:jobRunMs(live,this.now()),exit_code:live.exit_code??null,finished_at:live.finished_at??null,timeout_at:live.timeout_at??(live.started_at?live.started_at+live.timeout_ms:null)};t.waited_job=w;if(!w.running){t.waiting_job=null;return null;}t.waiting_job=w;}
  return t.waiting_job;
 }
 observeJob(id,job,{wait_ms=0,elapsed_ms=0,record_poll=true}={}){
  if(job.mode!=='task')return null;
  const t=this.task(id),job_id=job.job_id,w=t.waited_job?.job_id===job_id?t.waited_job:null;
  const state={job_id,status:job.status,running:jobRunning(job),seen:!jobRunning(job),run_ms:jobRunMs(job,this.now()),exit_code:job.exit_code??null,finished_at:job.finished_at??null,timeout_at:job.started_at?job.started_at+job.timeout_ms:null,generation:w?.generation??t.resume_generation??0,polls:(w?.polls||0)+(wait_ms>0?1:0)};
  if(wait_ms>0&&record_poll)this.events?.record('wait.poll',{task:id,job:job_id,asked_ms:wait_ms,ms:elapsed_ms,n:state.polls,run_ms:state.run_ms});
  if(state.running&&wait_ms>0)t.waiting_job=state;
  if(w||wait_ms>0)t.waited_job=state;
  if(!state.running&&(w||wait_ms>0)){t.waiting_job=null;t.seen_jobs||=new Set();if(!t.seen_jobs.has(job_id)){t.seen_jobs.add(job_id);this.events?.record('wait.end',{task:id,job:job_id,run_ms:state.run_ms,polls:state.polls,seen:(t.resume_generation||0)>state.generation?'after_resume':'in_turn',late_ms:Math.max(0,this.now()-(state.finished_at||this.now()))});}}
  if(state.running&&state.run_ms>=PACING.wait.note_ms){t.wait_notes||=new Set();if(!t.wait_notes.has(job_id)){t.wait_notes.add(job_id);return {zh:`这条命令已经跑了 ${Math.floor(state.run_ms/60000)} 分钟：调一次 task_checkpoint 记下在等它，记完接着等，不结束这一轮。`};}}
  return null;
 }
 resumeHint(id){
  const t=this.tasks.get(id),waiting=this.waitingJob(id),job=waiting||t?.waited_job;
  return {last_checkpoint:t?.checkpoints.at(-1)||null,...(job?{waiting_job:{job_id:job.job_id,status:job.status,exit_code:job.exit_code??null},command_action:job.running?'接着用 command_result（brief:true）在这一轮里等。':'先 command_result 看输出，再决定下一步；结果不确定先看现状，不直接重做。'}:{}),...(t?.full_output_cursor?{full_output_cursor:{...t.full_output_cursor,recovery:'先用保存的 full_cursor 重取这一页，收到后再沿 next_full_cursor 继续；不要重跑命令。'}}:{}),...(t?.archive_cursor?{archive_cursor:{...t.archive_cursor}}:{}),uncertain_action:'上一步可能已执行时，先查看现状再决定，不直接重发；有明确未执行回执时按其重试提示。'};
 }
 resumeNote(s){
  const t=s.task_id?this.tasks.get(s.task_id):null,last=t?.checkpoints.at(-1)||null,steps=t?.steps.slice(-3)||[];
  const where=last?`上次记到第 ${last.block} 块：${last.done}；下一步：${last.next||'（没写）'}`:'这个任务还没记过进度';
  return {task_id:s.task_id,zh:`接着做：${where}。最近几步：${steps.map(x=>x.tool+(x.target?' '+x.target:'')).join('；')||'无'}。先 task_status 核对，做过的不重做，结果不明的先查；回复第一句告诉用户从哪接着做。`,en:'Resuming after a stall. Call task_status first, continue from the last checkpoint, never redo finished steps, check uncertain results, and tell the user in one sentence where you resume.',last_checkpoint:last,recent_steps:steps,resume_hint:this.resumeHint(s.task_id)};
 }
 markResumed(s,now){if(s.task_id){const t=this.task(s.task_id);t.resume_generation=(t.resume_generation||0)+1;}const e=this.data.stalls.findLast?.(x=>x.task_id===s.task_id&&!x.resumed_at);if(e){e.resumed_at=now;this.save();}}
 logStall(task,t,basis,{quiet_ms=null,threshold_ms=null,session=null}={}){
  // 1027：停住记全：停之前最后几次调用（工具、用时、回了多少字、成没成）、这段对话平时两次调用隔多久、预报命中的词、记到第几块。
  this.events?.record('stall',{task:task.task_id||task.id,ms:quiet_ms,threshold_ms,waiting_job:!!this.waitingJob(task.task_id||task.id),model:task.model||t?.model||'unknown'});
  const gaps=[...(session?.gaps||[])].sort((a,b)=>a-b),last=t?.checkpoints?.at(-1)||null;
  this.data.stalls.push({at:this.now(),task_id:task.task_id||task.id,title:clip(task.title||'',60),forecast:t?.forecast||'none',forecast_hits:[...(t?.hits||[])].slice(0,8),basis,quiet_ms,threshold_ms,
   last_steps:(t?.steps||[]).slice(-3).map(x=>x.tool+(x.target?' '+clip(x.target,60):'')),
   last_calls:(session?.recent||[]).slice(-3).map(x=>({tool:x.tool,ms:x.ms,bytes:x.bytes,ok:x.ok})),
   gap_median_ms:gaps.length?gaps[Math.floor(gaps.length/2)]:null,gap_longest_ms:gaps.length?gaps.at(-1):null,gap_count:gaps.length,
   checkpoints:t?.checkpoints?.length||0,last_block:last?last.block:null,resumed_at:null});
  this.data.stalls=this.data.stalls.slice(-STALL_KEEP);this.save();
 }
 blocker(t){const c=t?.checkpoints?.at(-1);return c?.blocked&&!c.choice?{...structuredClone(c.blocked),at:c.at,block:c.block,total:c.total}:null;}
 view(task,{record=true}={}){const id=task.task_id||task.id,t=this.tasks.get(id),saved=task.stop_context||task.continuation,history=t?.checkpoints.length?t.checkpoints:saved?.checkpoints||[],last=history.at(-1)||null;return {resume_hint:{...this.resumeHint(id),last_checkpoint:last},waiting_user_active:this.waitingForUser(id),last_checkpoint:last,checkpoints:history.length,checkpoint_seq:t?.checkpoint_seq||saved?.checkpoint_seq||0,blocker:this.blocker(t)||this.blocker({checkpoints:history}),recent_steps:t?.steps.length?t.steps.slice(-STEP_KEEP):saved?.recent_steps||[],forecast:t?.forecast||'none',stall:this.stall(task,{record})};}
 // 这次调用报错了，要附的话留给这段对话的下一次调用。
 carry(hash,note){if(hash&&note){const s=this.sessions.get(hash);if(s)s.carried=note;}}
 takeCarried(hash){const s=hash?this.sessions.get(hash):null;const n=s?.carried||null;if(s)s.carried=null;return n;}
 // 这个任务最后一次有动静的时间（调用、进度），给「长时间无活动就收起」用。
 lastActivity(taskId){const t=this.tasks.get(taskId);if(!t)return 0;return Math.max(t.steps.at(-1)?.at||0,t.checkpoints.at(-1)?.at||0,...[...this.sessions.values()].filter(s=>s.task_id===taskId).map(s=>s.last_at||0));}
 diagnostics(){const p=this.p99();return {gap_samples:this.data.gaps.length,gap_p99_ms:p,threshold_basis:this.data.gaps.length>=DATA_READY?'data':'provisional',recent_stalls:this.data.stalls.slice(-10)};}
 close(){this.save();}
}

function forecastNote(level){
 return {level,tell_user:'如显示 Message delivery timed out，请发送「继续」，不要点击「重试」。',zh:'提前提醒，不是拦下。这个任务可能被 OpenAI 多查一下，回复会变慢或停住。这一块还没记过进度的话，先调一次 task_checkpoint 记下做到哪（对话里会出进度卡）；回复第一句把 tell_user 原样告诉用户，再用一句话讲清这是在修什么、为了防什么（OpenAI 自己建议讲清用途）；范围收小：只读需要的那几行（先 search_text 再读）、测试只看失败的；每块小一点，完成一块调task_checkpoint，next写「接着做：…」，记完接着做，不结束这一轮。不要为了躲检查改写、拆开或藏起内容。这条提醒本身不是拦截，不要因为它停下、收口或说被拦。',en:'Advance notice, not a block. This task may get extra safety checks (slow or stalled replies). If this block has not been checkpointed yet, call task_checkpoint once so the progress card appears; tell the user tell_user first, then say in one sentence what you are fixing and what it protects against (OpenAI recommends stating the purpose). Keep scope narrow: read only the lines you need (search_text first), look only at failing tests. Keep blocks small; checkpoint after a completed block and continue in the same turn. Never rewrite, split or hide content to avoid checks. This notice itself is not a block: do not stop, finish or claim you were blocked because of it.'};
}
