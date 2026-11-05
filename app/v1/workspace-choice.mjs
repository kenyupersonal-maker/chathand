import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {cleanError,fail} from '../../engine/src/core.mjs';
import {t,normalizeLocale} from '../i18n.mjs';
import {CONFIRM_TTL} from './confirmations.mjs';

// These actions exist only in server-created checkpoint results. They are not
// part of the model-callable task_checkpoint input schema.
export const WORKSPACE_CHOICE_ACTIONS=Object.freeze(['workspace_recreate','workspace_later']);

export class WorkspaceChoices{
 constructor({state,store,policy,recovery,routeAllowed=()=>true,now=Date.now}){
  Object.assign(this,{state,store,policy,recovery,routeAllowed,now});this.requests=new Map();
 }
 isControl(id){return this.policy.tasks.get(id)?.recovery_control===true;}
 prune(){
  for(const [id,r] of this.requests)if(this.now()>=r.expires_at){
   const task=this.policy.tasks.get(id);
   if(task?.status==='active'&&this.now()>=r.expires_at)try{this.policy.revokeTask(task,'expired');}catch{}
   this.requests.delete(id);
  }
 }
 current(r,{transition=false,applying=false}={}){
  const task=this.policy.tasks.get(r.task_id),project=this.state.project();
  return r.state===(applying?'applying':'waiting')&&this.now()<r.expires_at&&task?.status==='active'&&task.recovery_control===true&&
   task.caller===r.caller&&task.session_hash===r.session_hash&&(task.connection_principal??null)===r.connection_principal&&
   this.state.data.active===r.project_id&&project.id===r.project_id&&project.path===r.path&&
   this.state.data.mode==='auto'&&this.store.accessMode==='auto'&&this.policy.enabled===true&&!this.policy.connectionUnavailable&&!this.policy.transitioning&&!this.store.paused&&
   this.policy.epoch===r.epoch&&(this.policy.permissionRevision||0)===r.revision&&
   this.store.workspaceEpoch===r.workspace_epoch+(transition?1:0)&&!!this.store.workspaceTransitioning===transition&&
   project.workspace_recovery_required===true&&project.workspace_recovery_reason==='missing'&&
   this.routeAllowed(r.transport_source);
 }
 issue({caller,session_hash,connection_principal=null,card_domain,transport_source,locale}){
  this.prune();
  if(caller!=='chatgpt'||typeof session_hash!=='string'||!/^[a-f0-9]{64}$/.test(session_hash)||!this.routeAllowed(transport_source))return null;
  const p=this.state.project(),w=this.store.workspaceStatus(),root=p.path;
  if(this.state.data.mode!=='auto'||this.store.accessMode!=='auto'||!this.policy.enabled||this.policy.connectionUnavailable||this.policy.transitioning||this.store.paused||this.store.workspaceTransitioning||
   p.workspace_recovery_required!==true||p.workspace_recovery_reason!=='missing'||w.status!=='missing'||w.confirm_reason!=='missing'||
   typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||root.includes('\0')||path.dirname(root)===root)return null;
  locale=normalizeLocale(locale);
  for(const r of this.requests.values())if(r.caller===caller&&r.session_hash===session_hash&&r.connection_principal===connection_principal&&r.card_domain===card_domain&&r.transport_source===transport_source&&r.locale===locale&&this.current(r))return this.recipe(r);
  const view=this.policy.begin({request_id:crypto.randomUUID(),title:t('card.blocked.workspace.controlTitle',{},locale)},caller,{session_hash,connection_principal});
  const task=this.policy.tasks.get(view.task_id),expires_at=this.now()+CONFIRM_TTL;
  task.recovery_control=true;task.expires_at=expires_at;
  const r={task_id:task.id,caller,session_hash,connection_principal,card_domain,transport_source,locale,project_id:p.id,path:root,workspace_epoch:this.store.workspaceEpoch,epoch:this.policy.epoch,revision:this.policy.permissionRevision||0,expires_at,state:'waiting'};
  this.requests.set(task.id,r);return this.recipe(r);
 }
 recipe(r){return {tool:'task_checkpoint',arguments:{task_id:r.task_id,done:t('card.blocked.workspace.controlDone',{},r.locale)}};}
 allow(id,caller,session_hash,card_domain,{connection_principal=null,transport_source}={}){const r=this.requests.get(id);return !!r&&r.caller===caller&&r.session_hash===session_hash&&r.card_domain===card_domain&&r.connection_principal===connection_principal&&r.transport_source===transport_source&&this.current(r);}
 allowReceipt(id,caller,session_hash,card_domain,{connection_principal=null,transport_source}={}){
  const r=this.requests.get(id),task=this.policy.tasks.get(id);
  return !!r&&['answered','failed'].includes(r.state)&&this.now()<r.expires_at&&['completed','failed'].includes(task?.status)&&
   r.caller===caller&&r.session_hash===session_hash&&r.card_domain===card_domain&&r.connection_principal===connection_principal&&r.transport_source===transport_source&&this.routeAllowed(transport_source);
 }
 checkpoint(id,caller,session_hash,card_domain,identity){
  if(!this.allow(id,caller,session_hash,card_domain,identity))fail('WORKSPACE_CHOICE_EXPIRED',t('card.blocked.workspace.choiceExpired'));
  const locale=this.requests.get(id).locale,txt=key=>t(key,{},locale);
  return {task_id:id,done:txt('card.blocked.workspace.controlDone'),waiting_user:true,blocked:{step:txt('card.blocked.workspace.name'),error:txt('card.blocked.workspace.cause'),options:[
   {label:txt('card.blocked.workspace.recreate'),cost:txt('card.blocked.workspace.cardRecreateCost'),action:'workspace_recreate'},
   {label:txt('card.blocked.workspace.later'),cost:txt('card.blocked.workspace.laterDescription'),action:'workspace_later'}
  ]}};
 }
 async choose({task_id,caller,session_hash,action,transport,connection_principal=null,transport_source}){
  const r=this.requests.get(task_id);
  if(!r||!WORKSPACE_CHOICE_ACTIONS.includes(action)||!this.allow(task_id,caller,session_hash,transport,{connection_principal,transport_source}))
   return {ok:false,state:'failed',result_line:t('card.blocked.workspace.choiceExpired')};
  // Claim before awaiting: this request cannot execute twice.
  r.state='applying';
  if(action==='workspace_later'){r.state='answered';return {ok:true,state:'denied',result_line:t('card.blocked.workspace.keptPaused',{},r.locale)};}
  const owner=Symbol('workspace-choice');let transition=false,commitStarted=false;
  try{
   // Revalidate the original binding on both sides of the asynchronous probe
   // and authority transition; the request stays claimed throughout.
   const checked=await this.recovery.check();
   if(!this.current(r,{applying:true})||checked.workspace.status!=='missing'||checked.workspace.confirm_reason!=='missing')fail('WORKSPACE_CHOICE_EXPIRED',t('card.blocked.workspace.choiceExpired'));
   await this.recovery.resetAuthority({owner});transition=true;
   if(!this.current(r,{transition:true,applying:true}))fail('WORKSPACE_CHOICE_EXPIRED',t('card.blocked.workspace.choiceExpired'));
   commitStarted=true;this.recovery.recreate({expectedWorkspace:{missing:true}});
   r.state='answered';return {ok:true,state:'allowed',result_line:t('card.blocked.workspace.recreated',{},r.locale),ai_waiting:false};
  }catch(error){
   let missing=false;try{fs.lstatSync(r.path);}catch(e){missing=e.code==='ENOENT';}
   const uncertain=commitStarted&&!missing;r.state='failed';
   const message=cleanError(error).message;
   return {ok:false,state:uncertain?'unknown':'failed',result_line:t('card.blocked.workspace.recreateFailed',{message},r.locale),...(uncertain?{do_not_replay:true}:{})};
  }finally{this.recovery.finishTransition(owner);}
 }
 finish(task_id,caller,{success=true,summary=''}={}){
  const r=this.requests.get(task_id),task=this.policy.tasks.get(task_id);
  if(!r||!task||task.caller!==caller)return;
  if(task.status==='active')try{this.policy.finish(task_id,caller,success,summary);}catch{try{this.policy.revokeTask(task,'expired');}catch{}}
  // Keep the identity binding until expiry so the original card can read its
  // final receipt. The completed control task cannot execute more actions.
 }
 close(){this.requests.clear();}
}
