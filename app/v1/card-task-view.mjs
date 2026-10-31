// Display projection only. Identity/permission proof happens before this helper.
export function cardTaskView(full){
 const keys=['task_id','status','title','created_at','terminal','checkpoint_seq','last_checkpoint','stall','wait_state','forecast','blocker','summary','user_action','intermediate_errors','end_reason','continuity'];
 const out=Object.fromEntries(keys.filter(k=>full[k]!==undefined).map(k=>[k,structuredClone(full[k])]));
 if(out.last_checkpoint){const c=out.last_checkpoint;out.last_checkpoint={at:c.at,block:c.block,total:c.total,done:c.done,next:c.next,waiting_user:c.waiting_user};}
 if(full.recent_steps?.length)out.recent_steps=[structuredClone(full.recent_steps.at(-1))];
 if(out.stall){const s=out.stall;out.stall=Object.fromEntries(['stalled','waiting_user','quiet_ms','threshold_ms','last_at','running','waiting_job'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]]));}
 const controls=/^(?:task_id|job_id|status|state|action|end_reason|forecast|tool|kind|code|id)$/;
 const trim=(v,max,key='')=>{if(typeof v==='string')return controls.test(key)?v:v.slice(0,max);if(Array.isArray(v))return v.map(x=>trim(x,max,key));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,trim(x,max,k)]));return v;};
 let view=trim(out,200);
 for(const n of [100,50,20,0]){if(JSON.stringify(view).length<=2000)break;view=trim(view,n);}
 return view;
}

const line=value=>typeof value==='string'?value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g,' ').trim().slice(0,200):'';
const stamp=value=>Number.isFinite(value)&&value>=0?value:null;
const localPath=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f]/.test(value)&&!/^\w+:\/\//.test(value)&&!value.split(/[\\/]/).includes('..')?value:null;

// Rich widget-only projection. Callers must first prove ownership and provide
// records for this exact task. No title matching, session-wide grouping or IO.
export function consolidatedTaskCard(full,{checkpoints,changes}={}){
 const task_id=full?.task_id;
 if(typeof task_id!=='string'||!task_id)return null;
 const current=full.last_checkpoint||full.checkpoint||null;
 const history=Array.isArray(checkpoints)?checkpoints:full.stop_context?.checkpoints||full.continuation?.checkpoints||(current?[current]:[]);
 const seq=Number.isSafeInteger(full.checkpoint_seq)?full.checkpoint_seq:0;
 const cps=history.slice(-20),base=Math.max(0,seq-history.length);
 const timeline=cps.map((c,i)=>({id:`${task_id}:checkpoint:${base+history.length-cps.length+i+1}`,kind:'checkpoint',task_id,at:stamp(c.at),block:c.block??null,total:c.total??null,done:line(c.done),next:line(c.next),waiting_user:c.waiting_user===true,...(c.blocked?{blocked_step:line(c.blocked.step)}:{})}));
 const steps=Array.isArray(full.recent_steps)?full.recent_steps:[];
 for(const [i,s] of steps.slice(-8).entries())timeline.push({id:`${task_id}:step:${stamp(s.at)}:${i}`,kind:'step',task_id,at:stamp(s.at),tool:line(s.tool),ok:s.ok===true,ms:stamp(s.ms)});
 timeline.sort((a,b)=>(a.at??0)-(b.at??0)||a.id.localeCompare(b.id));
 const files=new Map();
 // Inherited rows are display metadata only. Every reveal uses the new task ID
 // and the current file scope; previous grants/nonces never enter this view.
 for(const f of full.stop_context?.files||full.continuation?.files||[]){const p=localPath(f.path);if(p)files.set(p,{name:p.split(/[\\/]/).at(-1),path:p,...(Number.isSafeInteger(f.bytes)?{bytes:f.bytes}:{}),source_tool:f.source_tool,at:stamp(f.at),reveal:{tool:'desktop_action',arguments:{task_id,action:'reveal',path:p},requires_current_scope:true},download:{status:'unverified'},attachment:{status:'unverified'}});}
 for(const c of Array.isArray(changes)?changes:[]){
  if(c.task_id!==undefined&&c.task_id!==task_id||c.status!=='applied'&&!(c.tool==='trash_path'&&c.status==='recycled'))continue;
  if(c.tool==='trash_path'||c.tool==='move_path'){
   const source=localPath(c.path),destination=localPath(c.destination);
   if(source)for(const [p,file] of [...files])if(p===source||p.startsWith(source+'/')){
    files.delete(p);
    if(c.tool==='move_path'&&destination){const next=destination+p.slice(source.length);files.set(next,{...file,name:next.split(/[\\/]/).at(-1),path:next,source_tool:c.tool,at:stamp(c.time),reveal:{...file.reveal,arguments:{...file.reveal.arguments,path:next}}});}
   }
  }
  const rows=c.tool==='save_files'&&Array.isArray(c.files)?c.files:['write_text','edit_file','restore_file','restore_trash','move_path'].includes(c.tool)?[{path:c.tool==='move_path'?c.destination:c.path}]:[];
  for(const f of rows){const p=localPath(f.path);if(!p)continue;files.set(p,{name:p.split(/[\\/]/).at(-1),path:p,...(Number.isSafeInteger(f.bytes)&&f.bytes>=0?{bytes:f.bytes}:{}),source_tool:c.tool,at:stamp(c.time),reveal:{tool:'desktop_action',arguments:{task_id,action:'reveal',path:p},requires_current_scope:true},download:{status:'unverified'},attachment:{status:'unverified'}});}
 }
 const terminal=full.terminal===true||['completed','failed','cancelled','revoked','expired','superseded','rejected','paused','permission_changed','workspace_changed','connection_lost'].includes(full.status);
 const unknown=full.do_not_replay===true||full.checkpoint_action_state==='unknown';
 const status=unknown?'unknown':full.status==='completed'?'completed':full.status==='failed'?'failed':terminal?'stopped':full.status==='pending_approval'?'waiting':full.blocker||current?.blocked&&!current.choice?'blocked':full.wait_state?.kind==='external'?'waiting':full.stall?.stalled===true?'stalled':full.status==='active'?'active':'unknown';
 const stopped=['stopped','blocked','stalled','unknown','failed'].includes(status);
 const root_task_id=full.continuity?.root_task_id||task_id;
 const card={protocol:1,card_id:task_id,task_id,continuity_id:root_task_id,...(full.continuity?{continuity:structuredClone(full.continuity)}:{}),scope:'task',grouping:{kind:'single_root_checkpoints',root_task_id,independent_task_ids_merged:false},title:line(full.title)||null,status,source_status:full.status??null,tone:['blocked','stalled','waiting'].includes(status)?'warning':status==='completed'?'success':['failed','unknown'].includes(status)?'danger':status==='stopped'?'muted':'neutral',terminal,
  progress:{done:line(current?.done),next:line(current?.next),block:current?.block??null,total:current?.total??null,checkpoint_seq:seq},
  timeline,files:[...files.values()].slice(-80),coverage:{checkpoints:checkpoints===undefined&&!full.stop_context&&!full.continuation?'latest_only':'provided_history',omitted_checkpoints:Math.max(0,seq-history.length)+Math.max(0,history.length-20),omitted_steps:Math.max(0,steps.length-8),files:changes===undefined?'not_provided':'provided_changes',omitted_files:(full.continuation?.coverage?.omitted_files||(!Array.isArray(changes)?full.stop_context?.coverage?.omitted_files:0)||0)+Math.max(0,files.size-80)},
  stopped_at:stopped?{checkpoint_seq:seq,block:current?.block??null,step:line(full.blocker?.step||current?.blocked?.step||current?.next||current?.done)||null,end_reason:line(full.end_reason)||null}:null,
  recovery:{verify_status_first:true,replay_completed:false,unknown_outcome_requires_inspection:true},
  controls:{continue:{enabled:false},stop:{enabled:false}},file_capabilities:{reveal:'requires_current_scope',download:'unverified',attachment:'unverified'}};
 // This private projection shares Site's 64KiB result envelope with the real
 // task result and widget metadata. Keep complete paths or omit whole rows;
 // never cut a reveal path or let rich presentation invalidate a saved effect.
 while(Buffer.byteLength(JSON.stringify(card),'utf8')>32768){
  if(card.files.length){card.files.shift();card.coverage.omitted_files++;continue;}
  if(card.timeline.length>1){const old=card.timeline.shift();card.coverage[old.kind==='checkpoint'?'omitted_checkpoints':'omitted_steps']++;continue;}
  break;
 }
 return card;
}
