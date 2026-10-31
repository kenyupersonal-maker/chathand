import {t,localText,catalogs} from "../i18n.mjs";
// 1057：确认由本机用户作答；允许通过正常设置持久保存，不发临时放行。
import crypto from 'node:crypto';
import {fail,redactErrorText} from '../../engine/src/core.mjs';
export const CONFIRM_TTL=10*60*1000;
const stateOwners=new WeakMap();
export const bindConfirmations=(state,value)=>{stateOwners.set(state,value);};
export const confirmationsFor=state=>stateOwners.get(state)||null;
const key=(task,gate,item)=>JSON.stringify([task,gate,typeof item==='string'?item:item?.id]);
const words={always:t("card.confirmation.allow")};
// Static capability names can be localized; user-generated item names stay literal.
const notificationName=item=>{
 const key=[`permissions.risk.${item.id}.name`,`permissions.capability.${item.id}.name`,...(item.id==='full'?['permissions.scope.name']:[])].find(key=>Object.hasOwn(catalogs.zh,key));
 return key&&item.name===catalogs.zh[key]?localText(key):item.name;
};
const safe=(v,n=600)=>redactErrorText(String(v??'')).slice(0,n);
const copy=v=>structuredClone(v);
const itemId=item=>typeof item==='string'?item:item?.id;
const danger=new Set(['erase','bulk_delete','keychain','pipe_run','gatekeeper','bulk_perm','power']);
// 绑定程序、逐个原始参数和工作目录，避免截断、遮盖或参数拼接让另一条命令共用一次放行。
export function commandHash({program,args=[],cwd}={}){return crypto.createHash('sha256').update(JSON.stringify([program,args,cwd??null])).digest('hex');}
export function confirmationScopes(block){
 if(block?.kind!=='can_enable')return [];
 const id=block.item?.id;
 if(id==='erase')return [];
 if(block.gate==='high_risk'&&danger.has(id)||block.gate==='common'&&id==='autostart')return ['always'];
 if(['high_risk','common'].includes(block.gate)&&['admin','chatgpt_self'].includes(id))return ['always'];
 if(block.gate==='capability'&&['terminal','browser','desktop'].includes(id))return ['always'];
 if(block.gate==='scope'&&id==='full')return ['always'];
 return [];
}
export class Confirmations{
 constructor({audit=()=>{},emit=()=>{},now=Date.now,contextForTask=null,offerSettingsCards=true}={}){Object.assign(this,{audit,emit,now,contextForTask,offerSettingsCards});this.items=new Map();this.grants=[];this.denials=new Set();this.notes=new Map();this.waiters=new Map();this.applying=new Set();this.timers=new Map();this.ended=new Set();}
 event(kind,data){try{this.emit(kind,data);}catch{}}
 log(data){try{this.audit(data);}catch{}}
 get(id){this.prune();const c=this.items.get(id);if(!c)fail('CONFIRMATION_MISSING',t("card.confirmation.missing"));return copy(c);}
 prune(){
  const now=this.now();
  for(const c of this.items.values())if(c.state==='waiting'&&now>=c.expires_at&&!this.applying.has(c.id))this.closed(c,'expired');
  this.grants=this.grants.filter(g=>!this.ended.has(g.task_id)&&(!g.expires_at||g.expires_at>now)&&g.uses!==0);
  for(const [id,c] of this.items)if(!this.applying.has(id)&&c.state!=='waiting'&&now-(c.answered_at??c.closed_at??c.created_at)>CONFIRM_TTL)this.items.delete(id);
 }
 closed(c,state){
  if(!['waiting','applying'].includes(c.state))return;
  c.state=state;c.closed_at=this.now();clearTimeout(this.timers.get(c.id));this.timers.delete(c.id);
  this.event('confirmation_closed',{confirm_id:c.id,task_id:c.task_id,state});
 }
 create({blocked,task_id,session_hash=null,conversation_title=null,hash=''}={}){
  if(blocked?.kind==='can_enable'&&!this.offerSettingsCards){blocked.confirm=null;blocked.answer_in_chat=false;blocked.next=t("card.confirmation.disabledNext",{path:blocked.where?.path||blocked.where?.label||t("card.confirmation.defaultSetting")});if(Array.isArray(blocked.say_to_user))blocked.say_to_user[2]=blocked.next;blocked.instructions_for_ai=[blocked.next,'继续不依赖这个开关的部分，不弹授权卡、不重试、不绕过。'];return null;}
  this.prune();const scopes=confirmationScopes(blocked);if(!scopes.length||!task_id||this.ended.has(task_id))return null;
  const k=key(task_id,blocked.gate,blocked.item);
  if(this.denials.has(k)){blocked.confirm=null;blocked.answer='denied';return null;}
  if([...this.items.values()].some(c=>c.state==='unknown'&&key(c.task_id,c.gate,c.item)===k)){blocked.confirm=null;blocked.answer='unknown';blocked.next=t("card.confirmation.previousUnknown");return null;}
  let c=[...this.items.values()].find(x=>x.state==='waiting'&&key(x.task_id,x.gate,x.item)===k);
  if(!c){
   if(this.items.size>=1000)fail('CONFIRMATION_LIMIT',t("card.confirmation.limit"));
   const binding=this.contextForTask?.(task_id)||{},now=this.now();c={id:'cf_'+crypto.randomBytes(8).toString('hex'),gate:blocked.gate,item:copy(blocked.item),task_id,session_hash:typeof session_hash==='string'?session_hash:null,conversation_title:safe(conversation_title,160)||null,cause:safe(blocked.cause,160),effect:copy(blocked.effect),where:copy(blocked.where),alternative:safe(blocked.alternative),scopes,hash:String(hash),created_at:now,expires_at:now+CONFIRM_TTL,state:'waiting',...binding};
   this.items.set(c.id,c);const timer=setTimeout(()=>this.prune(),CONFIRM_TTL+1);timer.unref?.();this.timers.set(c.id,timer);
   this.event('confirmation_required',{confirm_id:c.id,task_id,title:localText("notification.confirmation.request",{name:notificationName(c.item)}),body:c.cause,scopes:copy(scopes)});
  }
 blocked.answer_in_chat=c.item.id!=='erase'&&!!c.session_hash;blocked.confirm={id:c.id,expires_at:c.expires_at,scopes:copy(c.scopes)};return copy(c);
 }
 pending({task_id=null,session_hash=null}={}){this.prune();const c=[...this.items.values()].find(c=>['waiting','applying'].includes(c.state)&&(task_id&&c.task_id===task_id||session_hash&&c.session_hash===session_hash));return c?copy(c):null;}
 allows({task_id,gate,item,hash='',consume=false}={}){
  this.prune();if(!task_id||this.ended.has(task_id))return false;
  const g=this.grants.find(g=>key(g.task_id,g.gate,g.item)===key(task_id,gate,item)&&(g.uses!==1||g.hash===hash));
  if(!g)return false;if(consume&&g.uses===1){g.uses=0;this.grants=this.grants.filter(x=>x!==g);}return true;
 }
 validateCurrent(id,{applying=false,expected=null}={}){
  this.prune();const c=this.items.get(id);if(!c)fail('CONFIRMATION_MISSING',t("card.confirmation.missing"));
  if(this.now()>=c.expires_at||this.ended.has(c.task_id)||c.invalidated||(!applying&&c.state!=='waiting')||(applying&&c.state!=='applying'))fail('CONFIRMATION_STATE',t("card.confirmation.alreadyHandled"));
  if(this.contextForTask){const current=this.contextForTask(c.task_id,{allowEpochTransition:applying&&c.gate==='scope'&&expected?.epoch===c.epoch+1}),binding=expected||c;for(const k of ['caller','epoch','revision'])if(current[k]!==binding[k])fail('CONFIRMATION_STATE',t("card.confirmation.contextChanged"));if(current.session_hash!==c.session_hash)fail('CONFIRMATION_OWNER',t("card.confirmation.ownerMismatch"));}
  return c;
 }
 validateAnswer(id,scope){
  this.prune();const c=this.items.get(id);if(!c)fail('CONFIRMATION_MISSING',t("card.confirmation.missing"));
  this.validateCurrent(id);if(this.applying.has(id))fail('CONFIRMATION_STATE',t("card.confirmation.applying"));
  if(scope!=='deny'&&!c.scopes.includes(scope))fail('CONFIRMATION_SCOPE',t("card.confirmation.scopeUnavailable"));return c;
 }
 answer(id,scope){
  const c=this.validateAnswer(id,scope);
  if(scope==='always'){
   let apply;if(c.gate==='scope')apply={route:'/api/mode',body:{mode:'full',confirm:true}};
   else if(c.gate==='capability')apply={route:'/api/settings',body:{[{terminal:'terminal_enabled',browser:'browser_enabled',desktop:'desktop_enabled'}[c.item.id]]:true}};
   else apply={route:'/api/settings',body:{high_risk:{[c.item.id]:true}}};
   // 先锁住这次回答，设置成功后再报已允许。等待中的写入闸门仍保持；失败不会假报成功。
   this.applying.add(id);c.state='applying';return {apply,confirm_id:id,task_id:c.task_id,item:copy(c.item),scope};
  }
  return this.setAnswer(c,scope);
 }
 completeApply(id,expected=null){const c=this.validateCurrent(id,{applying:true,expected});if(!this.applying.has(id))fail('CONFIRMATION_STATE',t("card.confirmation.noApply"));this.applying.delete(id);return this.setAnswer(c,'always');}
 failApply(id,{unknown=true}={}){const c=this.items.get(id);this.applying.delete(id);if(c&&['applying','waiting'].includes(c.state))this.closed(c,unknown?'unknown':'failed');this.prune();}
 setAnswer(c,scope){
  const now=this.now(),k=key(c.task_id,c.gate,c.item);
  if(scope==='deny')this.denials.add(k);
  c.scope=scope;c.answered_at=now;this.closed(c,scope==='deny'?'denied':'allowed');
  this.log({event:'confirmation',id:c.id,scope,via:c.via||'window',task_id:c.task_id,gate:c.gate,item:copy(c.item)});
  const message=scope==='deny'?localText("notification.confirmation.denied",{name:notificationName(c.item)}):localText("notification.confirmation.allowed",{name:notificationName(c.item),scope:scope==='always'?localText("card.confirmation.allow"):words[scope]});
  this.event('confirmation_answered',{confirm_id:c.id,task_id:c.task_id,item:copy(c.item),scope,state:c.state,message});
  if(c.session_hash){const zh=scope==='deny'?`这条「${c.item.name}」请求已拒绝：换不用它的做法，这个任务里别再要。`:c.gate==='scope'?'文件范围已改成整台电脑：用同一个 task_id 重做刚才那一步。':`已允许「${c.item.name}」（${words[scope]}）：重试刚才被拦的那一步。`;this.notes.set(c.session_hash,[...(this.notes.get(c.session_hash)||[]),{confirm_id:c.id,task_id:c.task_id,zh}].slice(-20));}
  return {ok:true,confirm_id:c.id,task_id:c.task_id,item:copy(c.item),state:c.state,scope};
 }
 rejectInput(id,input){const c=this.get(id);this.log({event:'confirmation_input_rejected',id,task_id:c.task_id,input:copy(input)});this.event('confirmation_input_rejected',{confirm_id:id,task_id:c.task_id,message:localText("notification.confirmation.inputRejected")});}
 withdraw(id,task_id=null){this.prune();const c=this.items.get(id);if(!c)fail('CONFIRMATION_MISSING',t("card.confirmation.missing"));if(task_id&&c.task_id!==task_id)fail('CONFIRMATION_OWNER',t("card.confirmation.withdrawOwner"));if(this.applying.has(id)){c.invalidated=true;return {withdrawn:false,state:'applying',do_not_replay:true,id};}if(c.state==='waiting')this.closed(c,'withdrawn');return {withdrawn:c.state==='withdrawn',id};}
 endTask(task_id){
  this.ended.add(task_id);for(const c of this.items.values())if(c.task_id===task_id){if(this.applying.has(c.id))c.invalidated=true;else if(c.state==='waiting')this.closed(c,'withdrawn');}
  this.grants=this.grants.filter(g=>g.task_id!==task_id);for(const k of this.denials)if(JSON.parse(k)[0]===task_id)this.denials.delete(k);
 }
 revoke(gate,id){this.grants=this.grants.filter(g=>!(g.gate===gate&&itemId(g.item)===id));for(const c of this.items.values())if(c.gate===gate&&itemId(c.item)===id){if(this.applying.has(c.id))c.invalidated=true;else this.closed(c,'withdrawn');}}
 permissionsChanged(except=null){for(const c of this.items.values())if(c.id!==except){if(this.applying.has(c.id))c.invalidated=true;else this.closed(c,'withdrawn');}}
 snapshot(){this.prune();return [...this.items.values()].map(c=>copy(c));}
 forTask(task_id){return this.snapshot().filter(c=>c.task_id===task_id).map(({id,item,state,scope,answered_at})=>({id,item,state,...(scope?{scope}:{}),...(answered_at!==undefined?{answered_at}:{})}));}
 waiter(task_id,active){const n=(this.waiters.get(task_id)||0)+(active?1:-1);if(n>0)this.waiters.set(task_id,n);else this.waiters.delete(task_id);}
 isWaiting(task_id){return (this.waiters.get(task_id)||0)>0;}
 takeNote(hash){if(!hash)return null;const notes=this.notes.get(hash);this.notes.delete(hash);return notes?.length?{...notes[0],...(notes.length>1?{also:notes.slice(1)}:{})}:null;}
 markPresented(id){const c=this.items.get(id);if(c)c.card_presented=true;}
 unpresentedNote(hash){if(!hash)return null;const c=[...this.items.values()].find(c=>c.state==='waiting'&&c.session_hash===hash&&!c.card_presented&&!c.card_reminded&&c.item.id!=='erase');if(!c)return null;c.card_reminded=true;return {kind:'permission_card',zh:'还有一个确认没放进对话：先 request_permission（task_id '+c.task_id+'，confirm_id '+c.id+'）。'};}
 close(){for(const t of this.timers.values())clearTimeout(t);this.timers.clear();this.grants=[];this.denials.clear();this.notes.clear();this.waiters.clear();this.items.clear();this.applying.clear();}
}
