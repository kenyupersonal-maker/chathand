import {taskTitleMetadata,taskSummaryMetadata} from './v1/message-metadata.mjs';
import {taskProfile} from './v1/task-profile.mjs';
import {TaskReceipts} from './task-receipts.mjs';
import crypto from 'node:crypto';import {fail,digest,withFileTask} from '../engine/src/core.mjs';
export class TaskPolicy {
 constructor(state,store,queue){this.state=state;this.store=store;this.queue=queue;this.tasks=new Map();this.requests=new Map();this.approvals=new Map();this.events=[];this.enabled=false;this.fullArmed=false;this.jobOwners=new Map();this.inputOwners=new Map();this.epoch=0;this.sequence=0;this.receipts=store.stateDir?new TaskReceipts(store.stateDir):null;}
 emit(kind,data={}){this.events.push({id:++this.sequence,time:Date.now(),kind,...data});this.events=this.events.slice(-200);}
 check(){if(this.connectionUnavailable&&this.enabled)fail('CONNECTION_RECONNECTING','同一连接暂时不可用，任务保留；恢复连接后再接着做，这一步没有执行。');if(!this.enabled||this.store.paused)fail('LOCAL_DISABLED','本机执行已停止，请在客户端点击“连接 ChatGPT”。');}
 begin({request_id,title,conversation_id=null,conversation_title=null,model,trial},caller,{session_hash=null,connection_principal=null,reservedId=null}={}){this.check();const profile=taskProfile({model,trial});if(!/^[A-Za-z0-9_-]{8,96}$/.test(request_id)||typeof title!=='string'||!title.trim()||title.length>160)fail('ARG_INVALID','任务标题或请求编号不正确。');
  if(conversation_title!==null&&(typeof conversation_title!=='string'||!conversation_title.trim()||[...conversation_title.trim()].length>10))fail('ARG_INVALID','对话名称需为 1–10 个字。');
  if(session_hash!==null&&!/^[a-f0-9]{64}$/.test(session_hash))fail('ARG_INVALID','会话标识无效。');
  if(connection_principal!==null&&(typeof connection_principal!=='string'||!/^[-a-z0-9:]{8,180}$/.test(connection_principal)))fail('ARG_INVALID','可信连接来源标记无效。');
  const fp=digest(JSON.stringify([title,conversation_id,this.state.data.active,conversation_title,session_hash]));const key=caller+':'+request_id;if(this.requests.has(key)){const r=this.requests.get(key),id=typeof r==='string'?r:r.id,t=this.get(id);if((r.fingerprint||t.fingerprint)!==fp)fail('OP_CONFLICT','同一任务编号的内容不同。');return {...this.view(t),replayed:true};}
  this.pruneTerminal();
  if([...this.tasks.values()].filter(t=>['active','pending_approval'].includes(t.status)).length>=300)fail('TASK_LIMIT','同时进行的任务已达300条，请先完成或停止现有任务。');
  const chat=conversation_id?this.state.data.conversations.find(c=>c.id===conversation_id&&c.project_id===this.state.data.active):null;if(conversation_id&&!chat)fail('CHAT_NOT_BOUND','该对话未绑定当前项目。');
  if(session_hash){this.state.data.session_groups||={};const group=this.state.data.session_groups[session_hash]||={title,created_at:Date.now()};if(conversation_title){group.title=conversation_title.trim();group.explicit_title=true;}if(chat&&!group.conversation_id){group.conversation_id=chat.id;group.link_source='user_bound';}this.state.save();}
  const t={...profile,session_hash,connection_principal,conversation_title:conversation_title?.trim()||null,id:reservedId||crypto.randomUUID(),request_id,fingerprint:fp,title,conversation_id,caller,project_id:this.state.data.active,root:this.store.root,epoch:this.epoch,status:'active',created_at:Date.now(),expires_at:null,jobs:[]};
  this.tasks.set(t.id,t);this.diagnostics?.record('task.begin',{task:t.id,...profile});this.requests.set(key,{id:t.id,fingerprint:fp});this.emit('task_started',{task_id:t.id,conversation_id,title});return this.view(t);
 }
 pruneTerminal(now=Date.now()){
  for(const [id,t] of this.tasks)if(!['active','pending_approval'].includes(t.status)&&!t.persistence_error&&
   now-(t.completion?.finished_at||t.revoked_at||t.finished_at||t.created_at||now)>3600000&&!this.hasLiveWork(t)&&
   !t.jobs.some(id=>{const j=this.queue.jobs?.get(id);return !j||j.status==='unknown'||j.delivery_unconfirmed||j.do_not_replay;})&&
   ![...this.approvals.values()].some(a=>a.task_id===id&&(a.result?.do_not_replay||a.result?.state==='unknown'))&&
   !this.hasUncertainWork?.(id))this.tasks.delete(id);
 }
 reuse(id,args,caller,{session_hash,connection_principal=null}={}){
  this.getBound(id,caller,session_hash,connection_principal);
  const key=caller+':'+args.request_id,old=this.requests.get(key);
  if(!old)this.requests.set(key,{id,fingerprint:digest(JSON.stringify([args.title,args.conversation_id??null,this.state.data.active,args.conversation_title??null,session_hash]))});
  try{return this.begin(args,caller,{session_hash,connection_principal});}catch(e){if(!old)this.requests.delete(key);throw e;}
 }
 view(t){
  if(t.completion)return structuredClone(t.completion);
  const terminal=['completed','failed','expired','superseded','revoked','rejected','cancelled','paused','permission_changed','workspace_changed','connection_lost'].includes(t.status);
  return {...(t.internal_source==='tools_refresh'?{source:'chathand_auto',source_kind:'tools_refresh',...((this.automaticTaskView?.(t)||t.automatic_task)?{automatic_task:structuredClone(this.automaticTaskView?.(t)||t.automatic_task)}:{})}:{}),model:t.model||'unknown',trial:t.trial||'medium',root:t.root,session_hash:t.session_hash||null,conversation_title:t.conversation_title||null,...(t.end_reason?{end_reason:t.end_reason}:{}),task_id:t.id,created_at:t.created_at,title:t.title,...taskTitleMetadata(t),request_id:t.request_id,status:t.status,project_id:t.project_id,conversation_id:t.conversation_id,expires_at:t.expires_at,jobs:[...t.jobs],mode:this.state.data.mode,
    ...(t.continuity?{continuity:structuredClone(t.continuity)}:{}),...(t.stop_context?{stop_context:structuredClone(t.stop_context)}:{}),...(t.continuation?{continuation:structuredClone(t.continuation)}:{}),
    execution_complete:['completed','failed'].includes(t.status),terminal,next_action:t.status==='pending_approval'?'wait_for_user':t.status==='active'?'continue_existing_task':'stop',
    retry:{create_new_task:false,poll_automatically:false,max_status_checks_per_turn:1}};
 }
 get(id,caller){
  let t=this.tasks.get(id);
  if(!t){const r=this.receipts?.read(id);if(!r)fail('TASK_MISSING','找不到任务，请检查原任务回执。');t={...r.result,id,caller,jobs:[...r.result.jobs],completion:r.result,connection_principal:r.connection_principal??null,archived:true,finish_success:r.success};}
  if(t.status==='active'&&t.expires_at!==null&&Date.now()>t.expires_at)this.revokeTask(t,'expired');
  return t;
 }
 // The server authenticates the connection before dispatch. A task ID may be
 // continued from another conversation or Site binding within the current
 // project; the current workspace and permission epoch still govern effects.
 getBound(id,caller,session_hash,connection_principal=null){
  let t=this.tasks.get(id),saved=null;
  if(!t){
   saved=this.receipts?.read(id);
   if(!saved)fail('TASK_MISSING','找不到任务，请检查原任务回执。');
   t=saved.result;
  }
  if(t.project_id!==this.state.data.active||t.root!==this.store.root)fail('ROOT_CHANGED','原任务所在工作区已改变，请在当前范围新建任务。');
  // Reads of old terminal receipts remain possible; effects use require().
  return saved?{...t,id,caller,jobs:[...t.jobs],completion:t,connection_principal:saved.connection_principal??null,archived:true,finish_success:saved.success}:this.get(id);
 }
 require(id,caller){
  this.check();const t=this.get(id,caller);
  const errors={pending_approval:['TASK_PENDING_APPROVAL','任务等 ChatHand 窗口批准；保留原任务号，不执行、不重建。'],completed:['TASK_COMPLETED','任务已完成，请使用原回执。'],failed:['TASK_FAILED','任务已经按失败结束；保留结果，不自动重跑。'],expired:['TASK_EXPIRED','任务已过期，请保留原结果。'],superseded:['TASK_SUPERSEDED','原任务已由新任务接替，请查看原回执，不要重跑。'],rejected:['TASK_REJECTED','这条任务已被拒绝。'],cancelled:['TASK_CANCELLED','任务已停止。']};
  if(t.status!=='active'){const [code,msg]=errors[t.status]||['TASK_REVOKED','任务已撤销。'];fail(code,msg);}
  if(t.project_id!==this.state.data.active||t.root!==this.store.root||t.epoch!==this.epoch)fail('ROOT_CHANGED','工作区或权限已改变，请重新开始任务。');return t;
 }
 approve(id,{minutes=30}={}){this.check();const t=this.get(id);if(t.status!=='pending_approval')fail('TASK_STATE','任务已处理。');if(t.epoch!==this.epoch||t.project_id!==this.state.data.active)fail('ROOT_CHANGED','工作区已更换。');if(!Number.isInteger(minutes)||minutes<1||minutes>240)fail('ARG_INVALID','授权时长为 1–240 分钟。');t.status='active';t.expires_at=Date.now()+minutes*60000;this.emit('task_started',{task_id:id});return this.view(t);}
 revokeTask(t,status='revoked'){
  if(t.completion||['completed','failed'].includes(t.status))return this.view(t);
  if(!['active','pending_approval'].includes(t.status)&&t.status!==status)return this.view(t);
  let value;try{value=this.valueStats?.receiptValue(t.id);}catch{}
  try{this.relayKeeper?.cancelTask(t.id,status==='cancelled'?'stopped':'authority_changed');}catch{/* Relay failure must not prevent terminal revocation; authority is checked again on use. */}t.status=status;t.revoked_at??=Date.now();
  if(this.matterStore){const settle=Promise.resolve().then(()=>this.matterStore.endTask(t.id,t.caller,{project_id:t.project_id,session_hash:t.session_hash,reason:status}));this.matterSettlements??=new Set();this.matterSettlements.add(settle);settle.catch(()=>this.diagnostics?.record('task.end',{task:t.id,status,saved:false})).finally(()=>this.matterSettlements.delete(settle));}this.confirmations?.endTask(t.id);this.artifacts?.cancelTask(t.id);
  for(const id of t.jobs)try{this.queue.cancel(id);}catch{}
  for(const a of this.approvals.values())if(a.task_id===t.id&&a.status==='pending_approval')a.status='cancelled';
  const result={...this.view(t),finished_at:t.revoked_at,receipt_id:t.id,replayed:false};
  if(value)result.value=value;
  try{this.receipts?.saveRevocation(t.id,t.caller,result,t.connection_principal);delete t.persistence_error;}
  catch(e){t.persistence_error=e.code||'TASK_RECEIPT_WRITE_FAILED';this.diagnostics?.record('task.end',{task:t.id,status:t.status,end_reason:t.end_reason||status,saved:false});throw e;}
  t.completion=structuredClone(result);this.diagnostics?.record('task.end',{task:t.id,status:t.status,end_reason:t.end_reason||status,saved:true});try{this.valueStats?.endTask(t.id);}catch{}return result;
 }
 // 1026：没收尾的任务不会一直挂在「进行中」（Ken 10/7 实测：停住的任务和接着开的新任务一起挂着）。
 // 只收没有在跑命令、没有等确认的任务；收起以后显示「被新任务接替了」或「超时已结束」，任务结果记成没收到结果。
 hasLiveWork(t){return !!this.artifacts?.busy(t.id)||!!this.confirmations?.pending({task_id:t.id})||t.jobs.some(id=>{try{const j=this.queue.get(id);return !!(j.child||j.cleanupPending||j.process_alive||j.status==='running'||j.status==='pending_approval');}catch{return false;}})||[...this.approvals.values()].some(a=>a.task_id===t.id&&['pending_approval','running'].includes(a.status));}
 endQuietly(t,reason){if(t.status!=='active'||this.hasLiveWork(t))return false;t.end_reason=reason;try{this.revokeTask(t,reason==='superseded'?'superseded':'expired');}catch{return false;}this.emit('task_ended',{task_id:t.id,reason,title:t.title});return true;}
 expireIdle(lastActivity,maxIdleMs=3*3600000,now=Date.now()){let n=0;for(const t of this.tasks.values())if(t.status==='active'&&now-Math.max(t.created_at||0,lastActivity(t)||0)>maxIdleMs&&this.endQuietly(t,'idle'))n++;return n;}
 revokeAll(reason='revoked',{keepTask=null,source}={}){
  try{this.relayKeeper?.cancelAll(reason==='paused'?'paused':'authority_changed');}catch{/* Must still revoke the original TaskPolicy authority. */}
  this.diagnostics?.record('revoke_all',{reason,source,n:[...this.tasks.values()].filter(t=>t!==keepTask&&['active','pending_approval'].includes(t.status)).length,jobs:[...(this.queue.jobs?.values()||[])].filter(j=>j.status==='running'||j.status==='pending_approval').length});
  let error=null;
  for(const t of this.tasks.values())if(t!==keepTask&&(['active','pending_approval'].includes(t.status)||t.persistence_error))try{this.revokeTask(t,t.persistence_error?t.status:reason);}catch(e){error??=e;}
  // Even the retained task loses queued/running effects; only its identity survives.
  if(keepTask)for(const a of this.approvals.values())if(a.task_id===keepTask.id&&a.status==='pending_approval')a.status='cancelled';
  this.queue.cancelAll();this.artifacts?.cancelAll();this.epoch++;
  if(error)throw error;
 }
 async modeFromConfirmation(mode,task,validateCommit){if(this.tasks.get(task?.id)!==task||task.status!=='active')fail('TASK_REVOKED','原任务已停止。');await this.setMode(mode,true,{keepTask:task,validateCommit});}
 setMode(mode,confirm=false,{keepTask=null,validateCommit=null}={}){if(!['auto','full'].includes(mode))fail('ARG_INVALID','请选择有效权限模式。');if(mode==='full'&&confirm!==true)fail('FULL_CONFIRM_REQUIRED','完全访问需要用户确认。');this.revokeAll('permission_changed',{keepTask});validateCommit?.();this.state.data.mode=mode;this.fullArmed=mode==='full';this.state.save();if(keepTask){keepTask.epoch=this.epoch;keepTask.root=this.store.root;}this.emit('permissions_changed');}
 fileAction(t,name,args,action){return withFileTask(this.store,t,action);}
 approveAction(id){const a=this.approvals.get(id);if(!a||a.status!=='pending_approval')fail('APPROVAL_STATE','该操作已处理。');this.require(a.task_id);try{const result=a.run();if(result&&typeof result.then==='function'){a.status='running';return result.then(value=>{a.result=value;a.status=value?.status==='failed'?'failed':'applied';return value;},e=>{a.status='failed';a.error={code:e.code,message:e.message};throw e;});}a.result=result;a.status='applied';return a.result;}catch(e){a.status='failed';a.error={code:e.code,message:e.message};throw e;}}
 finish(id,caller,success=true,summary='',user_action=''){
  if(typeof success!=='boolean')fail('ARG_INVALID','success 必须为布尔值。');
  if(typeof summary!=='string'||[...summary.trim()].length>80)fail('ARG_INVALID','summary 需要是 80 字以内的一句话。');
  if(typeof user_action!=='string'||[...user_action.trim()].length>60)fail('ARG_INVALID','user_action 需要是 60 字以内的一句话。');
  // Inspect terminal state before require(): a replay is not a new authorization.
  let t=this.get(id,caller);
  const saved=t.completion?{success:t.finish_success,result:t.completion}:this.receipts?.read(id,caller);
  if(saved){
   if(!['completed','failed'].includes(saved.result.status)){
    const codes={cancelled:'TASK_CANCELLED',rejected:'TASK_REJECTED',expired:'TASK_EXPIRED',superseded:'TASK_SUPERSEDED'};
    fail(codes[saved.result.status]||'TASK_REVOKED','任务已停止；保留原回执，不重新执行。');
   }
   if(saved.success!==success)fail('TASK_FINISH_CONFLICT','完成参数与原结果不同；保留原结果，不重新授权。');
   return {...structuredClone(saved.result),replayed:true};
  }
  t=this.require(id,caller);if(this.artifacts?.busy(id))fail('TASK_BUSY','成果接收或下载等待还没有结束。');const jobs=t.jobs.map(id=>this.queue.get(id));
  if(jobs.some(j=>j.child||j.cleanupPending||j.status==='pending_approval'))fail('TASK_BUSY','任务仍有运行中或待批准的命令。');
  const actions=[...this.approvals.values()].filter(a=>a.task_id===id);
  if(actions.some(a=>['pending_approval','running'].includes(a.status))||[...(this.queue.inputs?.values()||[])].some(a=>t.jobs.includes(a.job_id)&&a.status==='pending_approval'))fail('TASK_BUSY','任务仍有待批准的文件操作或输入。');
  const jobFailed=j=>!(j.status==='completed'&&j.exit_code===0)&&!(j.mode==='service'&&j.status==='cancelled'&&j.started_at&&j.finished_at);
  const intermediate_errors=actions.filter(a=>a.status==='failed').length+jobs.filter(jobFailed).length;
  const result={...this.view(t),status:success?'completed':'failed',terminal:true,execution_complete:true,finished_at:Date.now(),receipt_id:id,success,summary:summary.trim(),...taskSummaryMetadata(t),user_action:user_action.trim(),intermediate_errors,replayed:false,next_action:'report_once_then_stop',retry:{create_new_task:false,poll_automatically:false,max_status_checks_per_turn:0}};
  try{const value=this.valueStats?.receiptValue(id);if(value)result.value=value;}catch{/* Flush completed calls before saving; never change completion/idempotency rules. */}
  this.receipts?.save(id,t.caller||caller,success,result,t.connection_principal); // Persist the original receipt identity before emitting.
  try{this.relayKeeper?.cancelTask(id,'task_ended');}catch{/* Receipt already committed; do not turn a saved success into a failure. */}
  t.status=result.status;t.completion=structuredClone(result);t.finish_success=success;this.confirmations?.endTask(t.id);
  try{this.valueStats?.endTask(id);}catch{}
  this.diagnostics?.record('task.end',{task:id,status:result.status,end_reason:result.status,saved:true});
  this.emit('task_finished',{task_id:id,conversation_id:t.conversation_id,success,title:t.title,receipt_id:id});return result;
 }
 summary(){for(const t of this.tasks.values())this.get(t.id);return {enabled:this.enabled,mode:this.state.data.mode,full_armed:this.fullArmed,tasks:[...this.tasks.values()].map(t=>this.view(t)),approvals:[...this.approvals.values()].map(({run,fp,...a})=>a),events:this.events};}
}
