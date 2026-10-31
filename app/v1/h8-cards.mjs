import {t} from '../i18n.mjs';
// Request capabilities only: no permission state, payload logging or human-proof claims.
import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
import {CONFIRM_TTL} from './confirmations.mjs';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const invalid=()=>fail('CONFIRM_NONCE_INVALID',t('card.expired'));
export const CARD_ACTIONS=Object.freeze(['resume_browser','resume_desktop','stop_here','skip_step']);
const labels={resume_browser:t('card.action.resume'),resume_desktop:t('card.action.resume'),stop_here:t('card.action.stop'),skip_step:t('card.action.skip')};
export const cardObserverBody=body=>['card_answer','relay_card_control','chathand_host_flow_commit'].includes(body?.params?.name)?{jsonrpc:body.jsonrpc,...(Object.hasOwn(body,'id')?{id:typeof body.id==='number'?body.id:'private-card-request'}:{}),method:body.method,params:{name:body.params.name,arguments:{},...(body.params?._meta?{_meta:{...(typeof body.params._meta['openai/session']==='string'?{'openai/session':'private-card-session'}:{}),...(body.params._meta['io.modelcontextprotocol/protocolVersion']==='2026-07-28'?{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}:{})}}:{})}}:body;
const consumedWitnesses=new WeakSet();
export function takeInterruptionWitness(w,task_id,ctx,live,now){
 if(!w||!consumedWitnesses.has(w))return false;consumedWitnesses.delete(w);
 return w.task_id===task_id&&w.caller===ctx.caller&&w.session_hash===ctx.session_hash&&
  w.epoch===live.epoch&&w.revision===live.revision&&w.checkpoint_seq===live.checkpoint_seq&&now<w.expires_at;
}
export class H8Cards{
 constructor({policy,confirmations,now=Date.now,controlContext=()=>null,checkpointForTask=()=>0}={}){Object.assign(this,{policy,confirmations,now,controlContext,checkpointForTask});this.tokens=new Map();this.consumedInterruptionOrigins=new Map();this.consumedCardOrigins=new Map();this.requests=new Map();this.options=new Map();this.actions=new Map();this.unknownTasks=new Set();this.observers=new Map();}
 context(task_id,caller,session_hash,transport){if(typeof session_hash!=='string'||!/^[a-f0-9]{64}$/.test(session_hash))invalid();const t=this.policy.require(task_id,caller);if(t.session_hash!==session_hash)invalid();return {task_id,caller,session_hash,transport:transport||'legacy',epoch:this.policy.epoch,revision:this.policy.permissionRevision||0,project_id:t.project_id??null,connection_principal:t.connection_principal??null};}
 // Read-only origin proof: a forged name/from_card flag cannot claim widget
 // status. The live task + caller/session/project + unpredictable capability
 // must match. Real consume() still checks and spends the nonce.
 provePrivateNonce(nonce,caller,session_hash,transport,request=null){
  if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))return false;
  const c=this.tokens.get(hash(nonce)),t=c&&this.policy.tasks.get(c.task_id);
  if(!c||c.used||this.now()>=c.expires_at||!t||t.status!=='active'&&!c.request.startsWith('observe:'))return false;
  if(request!==null&&c.request!==request)return false;
  if(c.request.startsWith('relay-interruption:')&&!this.witnessCurrent(c))return false;
  if(c.request.startsWith('task-control:')&&(c.checkpoint_seq!==this.checkpointForTask(c.task_id)||this.unknownTasks.has(c.task_id)||(t.project_id??null)!==c.project_id||(t.connection_principal??null)!==c.connection_principal))return false;
  return c.caller===caller&&c.session_hash===session_hash&&c.transport===(transport||'legacy')&&
    c.epoch===this.policy.epoch&&c.revision===(this.policy.permissionRevision||0)&&
    t.caller===caller&&t.session_hash===session_hash&&t.project_id===this.policy.state.data.active;
 }
 // Permission status exposes only the nonce's own confirmation state. It is
 // deliberately independent of task/epoch/project liveness; real answers below
 // keep their strict context and one-use commit guards.
 provePermissionStatus(nonce,caller,session_hash,transport){
  if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))return false;
  const c=this.tokens.get(hash(nonce));
  return !!c&&!c.used&&this.now()<c.expires_at&&c.request.startsWith('permission:')&&
   typeof session_hash==='string'&&c.caller===caller&&c.session_hash===session_hash&&c.transport===(transport||'legacy');
 }
 permissionStatus(nonce,caller,session_hash,transport){
  if(!this.provePermissionStatus(nonce,caller,session_hash,transport))invalid();
  const c=this.tokens.get(hash(nonce)),id=c.request.slice(11),p=this.confirmations.items.get(id);
  const states=['waiting','applying','allowed','denied','withdrawn','expired','unknown','failed'];
  return {ok:true,confirm_id:id,state:!p?'expired':p.task_id!==c.task_id||p.session_hash!==c.session_hash?'expired':states.includes(p.state)?p.state:'unknown'};
 }
 // Same live capability proof as a submission, with no prune/consume or
 // confirmation/relay observer mutation. Only the capability's own state leaves.
 status(nonce,caller,session_hash,transport){
  if(!this.provePrivateNonce(nonce,caller,session_hash,transport))invalid();
  const c=this.tokens.get(hash(nonce));
  if(c.request.startsWith('permission:')){
   const p=this.confirmations.items.get(c.request.slice(11));
   if(!p||p.task_id!==c.task_id||p.session_hash!==c.session_hash)invalid();
   return {state:p.state};
  }
  if(c.request.startsWith('option:')){
   const o=this.options.get(c.request);if(!o)invalid();return {state:o.state};
  }
  invalid();
 }
 issue(request,context,expires_at){this.prune();if(this.tokens.size>=1000)fail('CONFIRMATION_LIMIT',t('card.limit'));const old=this.requests.get(request);if(old)this.tokens.delete(old);const nonce=crypto.randomBytes(32).toString('hex'),digest=hash(nonce);this.tokens.set(digest,{request,...context,expires_at,used:false});this.requests.set(request,digest);return nonce;}
 prune(){for(const map of [this.consumedInterruptionOrigins,this.consumedCardOrigins])for(const [digest,c] of map)if(this.now()>=c.expires_at)map.delete(digest);for(const [digest,c] of this.tokens)if(this.now()>=c.expires_at){this.tokens.delete(digest);if(this.requests.get(c.request)===digest)this.requests.delete(c.request);}for(const [id,o] of this.options)if(this.now()>=o.expires_at)this.options.delete(id);}
 // Spent provenance is read-only: it can yield only SUPERSEDED, never authority.
 // Permission commits may change the epoch; the original session/domain and TTL
 // still identify a second device's replay without touching a newer candidate.
 proveConsumedCard(nonce,caller,session_hash,transport){
  if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))return false;
  const c=this.consumedCardOrigins.get(hash(nonce));return !!c&&this.now()<c.expires_at&&c.caller===caller&&c.session_hash===session_hash&&c.transport===(transport||'legacy');
 }
 permission(task_id,confirm_id,caller,session_hash,transport){const context=this.context(task_id,caller,session_hash,transport),c=this.confirmations.validateCurrent(confirm_id);if(c.task_id!==task_id||c.session_hash!==session_hash)invalid();const chat_ok=c.item.id!=='erase';return {card:'permission',task_id,confirm_id:c.id,item:c.item,cause:c.cause,effect:c.effect,scopes:c.scopes,chat_ok,expires_at:c.expires_at,conversation_title:c.conversation_title,...(chat_ok?{_card_meta:{'chathand/card_nonce':this.issue('permission:'+c.id,context,c.expires_at)}}:{})};}
 // One-use private capability for converting an observed legacy stall into manual-only relay.
 // The tool's caller/session/epoch must match; the widget cannot supply identity.
 observerRevision(caller,session){return (this.observers.get(JSON.stringify([caller,null]))||0)+':'+(this.observers.get(JSON.stringify([caller,session]))||0);}
 noteOrdinary(caller,session){const key=JSON.stringify([caller,session||null]);this.observers.set(key,(this.observers.get(key)||0)+1);return this.observerRevision(caller,session);}
 witnessCurrent(record){const w=record.witness;return !!w&&this.policy.enabled!==false&&this.now()<w.expires_at&&
  w.observer_revision===this.observerRevision(record.caller,record.session_hash)&&w.checkpoint_seq===this.checkpointForTask(record.task_id);}
 relayInterruptionToken(task_id,caller,session_hash,transport,snapshot,observer_revision=this.observerRevision(caller,session_hash)){
  if(!snapshot?.stalled||snapshot.running||snapshot.waiting_user||!Number.isFinite(snapshot.last_at)||
   !Number.isFinite(snapshot.threshold_ms)||observer_revision!==this.observerRevision(caller,session_hash))return null;
  const c=this.context(task_id,caller,session_hash,transport),request='relay-interruption:'+task_id;
  const old=this.tokens.get(this.requests.get(request));
  if(old&&this.witnessCurrent(old)&&old.witness.last_at===snapshot.last_at)return old.privateNonce;
  const observed_at=snapshot.observed_at??this.now(),expires_at=observed_at+120000;if(expires_at<=this.now())return null;
  const nonce=this.issue(request,c,expires_at),record=this.tokens.get(hash(nonce));
  record.privateNonce=nonce;record.witness={...c,observed_at,last_at:snapshot.last_at,threshold_ms:snapshot.threshold_ms,
   basis:snapshot.basis,checkpoint_seq:this.checkpointForTask(task_id),observer_revision,expires_at};return nonce;
 }
 // A spent nonce proves only private origin, never another interruption grant.
 proveConsumedRelayInterruption(nonce,task_id,caller,session_hash,transport){
  if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))return false;
  const c=this.consumedInterruptionOrigins.get(hash(nonce)),t=c&&this.policy.tasks.get(c.task_id);
  return !!c&&this.now()<c.expires_at&&c.task_id===task_id&&c.caller===caller&&c.session_hash===session_hash&&c.transport===(transport||'legacy')&&
   !!t&&t.status==='active'&&t.caller===caller&&t.session_hash===session_hash&&t.project_id===c.project_id&&t.project_id===this.policy.state.data.active&&
   t.connection_principal===c.connection_principal&&c.epoch===this.policy.epoch&&c.revision===(this.policy.permissionRevision||0);
 }
 consumeRelayInterruption(nonce,task_id,caller,session_hash,transport){
  if(this.proveConsumedRelayInterruption(nonce,task_id,caller,session_hash,transport))fail('RELAY_CARD_SUPERSEDED',t('card.superseded'));
  if(!this.provePrivateNonce(nonce,caller,session_hash,transport,'relay-interruption:'+task_id))invalid();
  const key=hash(nonce),record=this.tokens.get(key),expected=this.context(task_id,caller,session_hash,transport);
  if(Object.keys(expected).some(k=>record[k]!==expected[k])||!this.witnessCurrent(record))invalid();
  record.used=true;this.consumedInterruptionOrigins.set(key,{...expected,expires_at:record.expires_at});while(this.consumedInterruptionOrigins.size>1000)this.consumedInterruptionOrigins.delete(this.consumedInterruptionOrigins.keys().next().value);this.tokens.delete(key);this.requests.delete(record.request);
  const witness=Object.freeze({...record.witness});consumedWitnesses.add(witness);return witness;
 }
 observationToken(task_id,caller,session_hash,transport){return this.issue('observe:'+task_id,this.context(task_id,caller,session_hash,transport),this.now()+7200000);}
 // Integration opt-in only: issuing this capability never stops/resumes work.
 // Owners must supply actions supported by their exact-task dispatcher.
 taskControls(task_id,caller,session_hash,transport,{actions=[]}={}){
  if(!Array.isArray(actions)||actions.some(a=>!['continue','stop'].includes(a)))invalid();
  if(!actions.length||this.unknownTasks.has(task_id))return {};
  const c=this.context(task_id,caller,session_hash,transport),checkpoint_seq=this.checkpointForTask(task_id);
  if(this.policy.tasks.get(task_id)?.status!=='active')invalid();
  const expires_at=this.now()+CONFIRM_TTL,allowed=[...new Set(actions)],nonce=this.issue('task-control:'+task_id,{...c,checkpoint_seq,control_actions:allowed},expires_at);
  return {'chathand/task_control_nonce':nonce,'chathand/task_controls':{task_id,checkpoint_seq,actions:allowed,expires_at}};
 }
 consumeTaskControl(nonce,action,caller,session_hash,transport){
  if(!this.provePrivateNonce(nonce,caller,session_hash,transport))invalid();
  const digest=hash(nonce),c=this.tokens.get(digest);
  if(!c.request.startsWith('task-control:')||!c.control_actions.includes(action))invalid();
  const current=this.context(c.task_id,caller,session_hash,transport);
  if(Object.keys(current).some(k=>current[k]!==c[k]))invalid();
  c.used=true;this.tokens.delete(digest);this.requests.delete(c.request);
  this.consumedCardOrigins.set(digest,{caller,session_hash,transport:c.transport,expires_at:c.expires_at});
  while(this.consumedCardOrigins.size>1000)this.consumedCardOrigins.delete(this.consumedCardOrigins.keys().next().value);
  return {task_id:c.task_id,scope:'task',action,checkpoint_seq:c.checkpoint_seq,epoch:c.epoch,revision:c.revision,project_id:c.project_id,connection_principal:c.connection_principal};
 }
 imageObservationToken(batch_id,task_id,caller,session_hash,transport){return this.issue('observe-image:'+batch_id,this.context(task_id,caller,session_hash,transport),this.now()+7200000);}
 imageObservation(nonce,caller,session_hash,transport){
  if(!this.provePrivateNonce(nonce,caller,session_hash,transport))invalid();const c=this.tokens.get(hash(nonce));
  if(!c.request.startsWith('observe-image:'))return null;
  const current=this.context(c.task_id,caller,session_hash,transport);if(Object.keys(current).some(k=>current[k]!==c[k]))invalid();
  return {batch_id:c.request.slice(14),task_id:c.task_id};
 }
 observation(nonce,caller,session_hash,transport){
  if(!this.provePrivateNonce(nonce,caller,session_hash,transport))invalid();const c=this.tokens.get(hash(nonce));
  if(!c.request.startsWith('observe:'))return null;
  const t=this.policy.tasks.get(c.task_id);if(!t||t.connection_principal!==undefined&&t.connection_principal!==c.connection_principal||t.project_id!==c.project_id)invalid();return c.task_id;
 }
 register(name,handler){if(!CARD_ACTIONS.includes(name)||typeof handler!=='function')fail('ARG_INVALID',t('card.unregistered'));this.actions.set(name,handler);}
 checkpoint(result,caller,session_hash,transport){if(this.unknownTasks.has(result.task_id)){const blocked=result.checkpoint?.blocked;return {...result,checkpoint:{...result.checkpoint,...(blocked?{blocked:{...blocked,options:blocked.options.map(({action,...plain})=>plain)}}:{})},chat_ok:false,checkpoint_action_state:'unknown',do_not_replay:true};}const options=result.checkpoint?.blocked?.options;if(!options?.some(o=>o.action))return result;const context=this.context(result.task_id,caller,session_hash,transport);for(const o of options)if(o.action&&!this.actions.has(o.action))fail('CARD_ACTION_UNAVAILABLE',t('card.unavailable'));const actual=this.controlContext(result.task_id),request='option:'+result.task_id,expires_at=this.now()+CONFIRM_TTL,shaped=options.map(o=>{if(o.action==='stop_here'&&(!actual||actual.epoch!==context.epoch)){const {action,...plain}=o;return plain;}return {...o,...(o.action?{label:labels[o.action]}:{})};});if(!shaped.some(o=>o.action))return {...result,checkpoint:{...result.checkpoint,blocked:{...result.checkpoint.blocked,options:shaped}}};this.options.set(request,{...context,seq:result.checkpoint_seq,options:structuredClone(shaped),control_scope:actual?.scope||null,expires_at,state:'waiting'});return {...result,checkpoint:{...result.checkpoint,blocked:{...result.checkpoint.blocked,options:shaped}},expires_at,chat_ok:true,_card_meta:{...(result._card_meta||{}),'chathand/card_nonce':this.issue(request,context,expires_at)}};}
 invalidateCheckpoint(task_id){const request='option:'+task_id,d=this.requests.get(request);if(d)this.tokens.delete(d);this.requests.delete(request);this.options.delete(request);}
 consume(nonce,choice,caller,session_hash,transport){this.prune();if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce)||typeof choice!=='string')invalid();const digest=hash(nonce),c=this.tokens.get(digest);if(!c||c.used)invalid();const now=this.context(c.task_id,caller,session_hash,transport);if(Object.keys(now).some(k=>now[k]!==c[k])||this.now()>=c.expires_at)invalid();if(c.request.startsWith('permission:')){const id=c.request.slice(11),p=this.confirmations.validateCurrent(id);if(p.task_id!==c.task_id||p.session_hash!==c.session_hash||p.item.id==='erase'||choice!=='deny'&&!p.scopes.includes(choice))invalid();}else{const o=this.options.get(c.request),n=Number(choice);if(!o||o.state!=='waiting'||!Number.isInteger(n)||String(n)!==choice||n<1||n>o.options.length||!o.options[n-1].action)invalid();}
 c.used=true;this.consumedCardOrigins.set(digest,{caller:c.caller,session_hash:c.session_hash,transport:c.transport,expires_at:c.expires_at});while(this.consumedCardOrigins.size>1000)this.consumedCardOrigins.delete(this.consumedCardOrigins.keys().next().value);this.tokens.delete(digest);this.requests.delete(c.request);return {...c,choice};}
 async answerOption(c,resume){const o=this.options.get(c.request),n=Number(c.choice);if(!o||o.state!=='waiting'||!Number.isInteger(n)||String(n)!==c.choice||!o.options[n-1]?.action)invalid();const current=this.context(c.task_id,c.caller,c.session_hash,c.transport);if(['epoch','revision'].some(k=>current[k]!==c[k])||this.now()>=o.expires_at)invalid();o.state='applying';const digest=this.requests.get(c.request);if(digest)this.tokens.delete(digest);this.requests.delete(c.request);const option=o.options[n-1],handler=this.actions.get(option.action);try{const result=await handler({task_id:c.task_id,caller:c.caller,session_hash:c.session_hash,choice:c.choice,action:option.action,scope:o.control_scope});const task=this.policy.require(c.task_id,c.caller);if(task.session_hash!==c.session_hash||this.policy.epoch!==c.epoch||(this.policy.permissionRevision||0)!==c.revision||this.now()>=o.expires_at||this.options.get(c.request)!==o)throw Error('changed');if(result?.ok===false||result?.delivery_unconfirmed||result?.do_not_replay||result?.state==='unknown')throw Error('unknown');o.state='answered';resume.checkpoint(c.task_id,{done:t('card.result.checkpoint',{label:option.label}),choice:option.label});return {ok:true,state:'allowed',result_line:t('card.result.selected',{label:option.label}),ai_waiting:false};}catch{o.state='unknown';this.unknownTasks.add(c.task_id);return {ok:false,state:'unknown',result_line:t('card.result.unknown'),do_not_replay:true,ai_waiting:false};}}
 windowOption({task_id,checkpoint_seq,choice},resume){const request='option:'+task_id,o=this.options.get(request);if(!o||o.seq!==checkpoint_seq)invalid();return this.answerOption({...o,request,choice},resume);}
 optionState(task_id){return this.unknownTasks.has(task_id)?{checkpoint_action_state:'unknown',do_not_replay:true}:{};}
 close(){this.tokens.clear();this.consumedInterruptionOrigins.clear();this.consumedCardOrigins.clear();this.requests.clear();this.options.clear();this.actions.clear();this.unknownTasks.clear();this.observers.clear();}
}
