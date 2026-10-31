import crypto from 'node:crypto';
import {sessionHashOf} from './resume.mjs';
import {localText} from '../i18n.mjs';
export const READ_TASK_INTERNAL=Symbol('read_task_internal');
const GROUPS={matters:['matter_query'],files:['read_file','get_file_info','list_directory','read_text'],search:['start_search','search_results','stop_search','search_text'],git:['git_inspect'],browserStatus:['browser_status'],browser:['browser_snapshot','browser_screenshot','browser_read','browser_find','browser_wait_for'],screen:['computer_status','computer_observe','computer_screenshot'],applications:['computer_applications'],system:['system_inspect']};
const BUSINESS_READS=new Map(Object.entries(GROUPS).flatMap(([group,names])=>names.map(name=>[name,group])));
const CONTROL=new Set(['task_changes','chathand_guide','artifact_status','image_batch_status','connection_check','setup_write_probe','bridge_info','task_status','task_history','list_conversations','show_task','operation_status','list_commands','command_result','input_status','upgrade_status','setup_status','setup_claim','setup_done','relay_card_control','card_answer','chathand_host_flow_commit']);
/** Observational task lifecycle only. Never changes a tool's inputs, authority,
 * output pagination, side-effect ledger, or execution/replay semantics. */
export class ReadTaskTracker {
 constructor({policy,now=Date.now,idleMs=15000,changed=()=>{},searchJobs=new Map()}){Object.assign(this,{policy,now,idleMs,changed,searchJobs});this.groups=new Map();}
 eligible(name,caller,context){return BUSINESS_READS.has(name)&&caller==='chatgpt'&&typeof context.setupPrincipal==='string'&&!!context.setupPrincipal&&context.invocationClass!=='private_card'&&!context[READ_TASK_INTERNAL];}
 scope(t){return t?.status==='active'&&t.root===this.policy.store.root&&t.project_id===this.policy.state.data.active&&t.epoch===this.policy.epoch;}
 promote(name,args,caller,context){
  if(context.invocationClass==='private_card'||CONTROL.has(name)||BUSINESS_READS.has(name)||name==='desktop_action'&&args.action==='reveal')return;
  const hash=sessionHashOf(context.setupPrincipal,context.session);
  for(const group of this.groups.values())if(group.caller===caller&&(args.task_id===group.id||hash&&group.hash===hash))group.owned=false;
  this.changed();
 }
 adoptTitle(id,title){const task=this.policy.tasks.get(id);if(task?.internal_source!=='read_task')return false;task.title=title;delete task.title_key;delete task.title_params;task.internal_source='read_task_promoted';for(const group of this.groups.values())if(group.id===id)group.owned=false;this.changed();return true;}
 async execute(name,args,caller,context,run){
  const p=this.policy,hash=sessionHashOf(context.setupPrincipal,context.session),principal=context.connectionPrincipal||null;
  // A missing session must never pool unrelated callers into one conversation.
  const key=JSON.stringify([caller,hash||crypto.randomUUID(),principal,p.state.data.active,p.store.root,p.epoch]);
  let group=this.groups.get(key),task=group&&p.tasks.get(group.id);
  if(!this.scope(task)){this.groups.delete(key);group=null;task=null;}
  if(!task&&typeof args.task_id==='string'){const claimed=p.tasks.get(args.task_id);if(this.scope(claimed))task=claimed;}
  if(!task&&hash)task=[...p.tasks.values()].reverse().find(t=>this.scope(t)&&t.caller===caller&&t.session_hash===hash&&t.connection_principal===principal);
  if(!group){
   let owned=false;
   if(!task){
    const category=name==='system_inspect'&&args.section==='disk'?'disk':BUSINESS_READS.get(name),titleKey='autoRead.'+category+'.title';
    try{const result=p.begin({request_id:'read_'+crypto.randomUUID(),title:localText('ui.server.'+titleKey)},caller,{session_hash:hash,connection_principal:principal});task=p.tasks.get(result.task_id);task.title_key=titleKey;task.title_params={};task.internal_source='read_task';owned=true;}
    catch{return run();} // Bookkeeping must never become a new permission gate.
   }
   group={id:task.id,caller,hash,owned,inflight:0,lastAt:this.now(),retryAt:0,failed:false,onlyBrowserStatus:name==='browser_status',browserUnavailable:false,searches:new Set()};this.groups.set(key,group);
  }
  if(name!=='browser_status'&&group.onlyBrowserStatus){group.onlyBrowserStatus=false;if(group.owned&&task.internal_source==='read_task'){const category=BUSINESS_READS.get(name);task.title_key='autoRead.'+category+'.title';task.title=localText('ui.server.'+task.title_key);task.title_params={};}}
  group.inflight++;group.retryAt=0;this.changed();
  try{const value=await run();if(name==='browser_status'){const backend=value?.selected_backend||value?.backend||'extension',selected=backend==='extension'?value?.extension||value:value;group.browserUnavailable=backend==='extension'||backend==='personal'?selected?.connected!==true||selected?.available===false:selected?.available!==true;}if(BUSINESS_READS.get(name)==='search'&&typeof value?.search_id==='string'&&this.searchJobs.has(value.search_id))group.searches.add(value.search_id);return value&&typeof value==='object'&&!Array.isArray(value)&&!value.task_id?{...value,task_id:group.id}:value;}
  catch(error){group.failed=true;throw error;}
  finally{group.inflight--;group.lastAt=this.now();group.retryAt=0;this.changed();}
 }
 nextDeadline(){let at=Infinity;for(const [key,g] of this.groups){if(!this.scope(this.policy.tasks.get(g.id))){this.groups.delete(key);continue;}if(g.owned&&!g.inflight)at=Math.min(at,Math.max(g.lastAt+this.idleMs,g.retryAt||0));}return at;}
 maintain(){
  for(const [key,g] of this.groups){const task=this.policy.tasks.get(g.id);if(!this.scope(task)){this.groups.delete(key);continue;}
   if(!g.owned||g.inflight||this.now()-g.lastAt<this.idleMs||this.now()<(g.retryAt||0))continue;
   const searches=[...g.searches].map(id=>this.searchJobs.get(id)).filter(Boolean);
   if(searches.some(j=>j.status==='failed'))g.failed=true;
   if(searches.some(j=>j.status==='running')||this.policy.hasLiveWork(task)||this.policy.hasUncertainWork?.(task.id)){g.retryAt=this.now()+1000;continue;}
   try{this.policy.finish(g.id,g.caller,!g.failed&&!(g.onlyBrowserStatus&&g.browserUnavailable));this.groups.delete(key);}catch{g.retryAt=this.now()+5000;/* Retry without changing the last real activity time. */}
  }
  this.changed();
 }
 close(){this.groups.clear();}
}
