// Continuity is saved progress, never a task grant, capability or command output.
import {consolidatedTaskCard} from './card-task-view.mjs';

const checkpoint=c=>({at:c.at,block:c.block,total:c.total,done:c.done,next:c.next,waiting_user:c.waiting_user===true,...(c.blocked?.step?{blocked:{step:c.blocked.step}}:{}),...(c.choice?{choice:c.choice}:{})});
const file=f=>({name:f.name,path:f.path,...(f.bytes!==undefined?{bytes:f.bytes}:{}),source_tool:f.source_tool,at:f.at});
export class TaskContinuity {
 constructor(policy,resume,changes){Object.assign(this,{policy,resume,changes});}
 snapshot(t){
  const view=this.policy.view(t),progress=this.resume.view(view,{record:false});
  let changes;try{changes=this.changes.read(t.id,t.caller);}catch{/* Coverage below explicitly reports unavailable metadata. */}
  const history=this.resume.tasks.get(t.id)?.checkpoints||t.continuation?.checkpoints||[];
  const card=consolidatedTaskCard({...view,...progress},{checkpoints:history,changes});
  const context={format:1,checkpoint_seq:progress.checkpoint_seq,checkpoints:history.slice(-20).map(checkpoint),
   recent_steps:progress.recent_steps.map(({tool,at,ok,ms})=>({tool,at,ok,ms})),files:(card?.files||[]).map(file),
   coverage:{omitted_checkpoints:Math.max(0,progress.checkpoint_seq-history.length),omitted_files:card?.coverage.omitted_files||0,files:card?.coverage.files||'not_provided'},
   recovery:{next_action:'begin_task',source_task_id:t.id,read_stop:{tool:'task_status',arguments:{task_id:t.id}},read_files:{tool:'task_changes',arguments:{task_id:t.id}},same_verified_conversation:true,new_request_id:true,new_task_for_independent_work:true,verify_status_first:true,replay_completed:false,inspect_uncertain_results:true,uses_current_permissions:true}};
  // Bounded durable metadata; keep whole paths and the most recent checkpoint.
  while(Buffer.byteLength(JSON.stringify(context))>16384){
   if(context.files.length){context.files.shift();context.coverage.omitted_files++;}
   else if(context.checkpoints.length>1){context.checkpoints.shift();context.coverage.omitted_checkpoints++;}
   else break;
  }
  return context;
 }
 latestCancelled(caller,session_hash){
  if(!session_hash)return null;
  const {policy}=this;let latest=null;
  const matches=t=>t.session_hash===session_hash&&t.project_id===policy.state.data.active&&t.root===policy.store.root;
  // Saved receipts supply restart continuity. Never use title/bookmark matching.
  for(const {file} of policy.receipts?.entries()||[]){
   let r;try{r=policy.receipts.read(file.slice(0,-5));}catch{return null;}
   if(r?.owner_hash!==policy.receipts.owner(caller)||!matches(r.result))continue;
   if(!latest||r.result.created_at>latest.created_at)latest=r.result;
  }
  // Live insertion order resolves equal timestamps in favor of the newer task.
  for(const t of policy.tasks.values())if(t.caller===caller&&matches(t)&&(!latest||t.created_at>=latest.created_at))latest=policy.view(t);
  const context=latest?.stop_context;
  return latest?.status==='cancelled'&&context?.format===1&&Number.isSafeInteger(context.checkpoint_seq)&&context.checkpoint_seq>=0&&Array.isArray(context.checkpoints)&&Array.isArray(context.recent_steps)&&Array.isArray(context.files)&&Buffer.byteLength(JSON.stringify(context))<=16384?latest:null;
 }
 carry(id,previous,session_hash){
  if(!previous)return;
  const t=this.policy.get(id),context=structuredClone(previous.stop_context);
  t.continuity={root_task_id:previous.continuity?.root_task_id||previous.task_id,previous_task_id:previous.task_id};
  t.continuation={from_task_id:previous.task_id,stopped_at:previous.finished_at,...context};
  const progress=this.resume.task(id);
  progress.checkpoints=structuredClone(context.checkpoints);progress.checkpoint_seq=context.checkpoint_seq;
  progress.steps=structuredClone(context.recent_steps);progress.session_hash=session_hash;
  // A user-requested continuation is fresh work; historical waiting checkpoints
  // remain visible but cannot put the new task back into waiting_user.
  progress.waiting_user_call_seq=-1;
 }
}
