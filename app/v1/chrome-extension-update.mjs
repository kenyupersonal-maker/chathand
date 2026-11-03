import crypto from 'node:crypto';
export const storeVersion=v=>typeof v==='string'&&v.length<=32&&v===v.trim()&&/^\d+(?:\.\d+){1,3}$/.test(v)&&v.split('.').every(n=>Number(n)<=65535);
export const newerStoreVersion=(a,b)=>storeVersion(a)&&storeVersion(b)&&a.split('.').map(Number).some((v,i,aa)=>{const bb=b.split('.').map(Number);return v>(bb[i]||0)&&aa.slice(0,i).every((x,j)=>x===(bb[j]||0));});
const validId=v=>typeof v==='string'&&v.length>=8&&v.length<=96&&!/[^A-Za-z0-9_-]/.test(v);
const supersededStates=new Set(['failed','unsupported','throttled','disconnected','no_update']);
const reports=new Set(['checking','update_available','no_update','throttled','failed','waiting_idle','applying']);
const codes=new Set(['UPDATE_CHECK_FAILED','UPDATE_CHECK_TIMEOUT','UPDATE_APPLY_FAILED','UPDATE_APPLY_TIMEOUT','BROWSER_BUSY','ACCESS_CHANGED','UPDATE_UNSUPPORTED','UPDATE_WAIT_TIMEOUT']);
export function cleanStoreUpdate(value){
 if(!value||typeof value!=='object'||!validId(value.id)||!reports.has(value.state)||!storeVersion(value.from_version)||!Number.isSafeInteger(value.sequence)||value.sequence<1)return null;
 if(value.target_version!=null&&!storeVersion(value.target_version))return null;
 return {id:value.id,sequence:value.sequence,state:value.state,from_version:value.from_version,target_version:value.target_version??null,...(codes.has(value.code)?{code:value.code}:{})};
}
export function storeUpdateControlAllowed(value){return value?.control==='store_update'&&['check','apply','cancel'].includes(value.operation)&&validId(value.id)&&typeof value.session==='string'&&value.session.length===36&&/^[-a-f0-9]{36}$/.test(value.session)&&storeVersion(value.from_version)&&Number.isSafeInteger(value.deadline)&&value.deadline>0&&(value.operation!=='apply'||newerStoreVersion(value.target_version,value.from_version));}
/** Update checks never grant page access; applying requires the original authority and an idle task/command queue. */
export class ChromeExtensionUpdate {
 constructor({current,usable=()=>false,allowed=()=>false,busy=()=>false,authority=()=>'',changed=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,timeoutMs=30000,waitTimeoutMs=300000,checkCooldownMs=60000}={}){Object.assign(this,{current,usable,allowed,busy,authority,changed,now,setTimer,clearTimer,timeoutMs,waitTimeoutMs,checkCooldownMs});this.value={state:'idle',from_version:null,target_version:null,code:null};this.timer=null;this.delivered=false;this.seen=new Set();this.lastReports=new Map();}
 status(){return {...this.value};}
 set(state,fields={}){this.value={...this.value,...fields,state};this.changed();return this.status();}
 clear(){this.clearTimer(this.timer);this.timer=null;}
 arm(code,ms=this.timeoutMs){this.clear();this.value.deadline=this.now()+ms;const id=this.value.id;this.timer=this.setTimer(()=>{if(this.value.id===id)this.finish('failed',code);},ms);this.timer?.unref?.();}
 finish(state,code=null){this.clear();return this.set(state,{code,deadline:null,...(state==='throttled'?{retry_at:this.now()+this.checkCooldownMs}:{})});}
 wait(fields={}){this.value.waiting_deadline??=this.now()+this.waitTimeoutMs;if(this.now()>=this.value.waiting_deadline)return this.finish('failed','UPDATE_WAIT_TIMEOUT');this.set('waiting_idle',fields);this.arm('UPDATE_WAIT_TIMEOUT',this.value.waiting_deadline-this.now());return this.status();}
 active(){return ['checking','waiting_idle','applying'].includes(this.value.state);}
 sameAuthority(){return this.allowed()&&this.authority()===this.grant;}
 start(){
  if(this.active()||this.value.state==='throttled'&&this.now()<this.value.retry_at)return this.status();const c=this.current();this.session=c.session??null;this.clear();this.value={state:'idle',from_version:c.helper?.version??null,target_version:null,code:null};
  if(!c.store)return this.finish('unsupported','UPDATE_UNSUPPORTED');if(!c.connected)return this.finish('disconnected','EXTENSION_DISCONNECTED');
  if(!storeVersion(c.helper?.version)||!c.helper?.features?.includes('store_update_v1'))return this.finish('unsupported','UPDATE_UNSUPPORTED');
  if(!this.allowed())return this.finish('failed','ACCESS_CHANGED');
  this.session=c.session;this.grant=this.authority();this.delivered=false;const id=crypto.randomUUID();this.seen.add(id);this.set('checking',{id,started_at:this.now()});this.arm('UPDATE_CHECK_TIMEOUT');return this.status();
 }
 observe(session,helper){
  const r=cleanStoreUpdate(helper?.update),v=this.value;
  if(supersededStates.has(v.state)&&session!==this.session&&(v.state==='disconnected'||newerStoreVersion(helper?.version,v.from_version))&&this.usable(helper)){
   const current=this.current();if(current.connected&&current.session===session){this.clear();this.session=session;this.value={state:'idle',from_version:helper.version,target_version:null,code:null};this.changed();return;}
  }
  if(v.state==='applying'&&this.sameAuthority()&&session!==this.session&&helper?.version===v.target_version&&newerStoreVersion(helper.version,v.from_version))return this.finish('updated');
  if(!helper?.features?.includes('store_update_v1')||!r||r.from_version!==helper.version)return;
  const key=session+':'+r.id;if(r.sequence<=(this.lastReports.get(key)||0))return;this.lastReports.set(key,r.sequence);if(this.lastReports.size>128)this.lastReports.delete(this.lastReports.keys().next().value);
  if(!this.active()){
   if(r.state!=='update_available'||this.seen.has(r.id)||!newerStoreVersion(r.target_version,helper.version)||!this.allowed())return;
   this.seen.add(r.id);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value);
   this.session=session;this.grant=this.authority();this.value={state:'waiting_idle',id:r.id,from_version:helper.version,target_version:r.target_version,code:null,started_at:this.now()};this.wait();return;
  }
  if(session!==this.session||r.id!==v.id||this.now()>(v.deadline??Infinity)||!this.sameAuthority())return;
  if(v.state==='checking'){
   if(r.state==='update_available'&&newerStoreVersion(r.target_version,v.from_version)){this.clear();return this.wait({target_version:r.target_version,code:null});}
   if(['no_update','throttled','failed'].includes(r.state))return this.finish(r.state,r.code??(r.state==='failed'?'UPDATE_CHECK_FAILED':null));
  }
  if(v.state==='applying'&&r.target_version===v.target_version){if(r.state==='waiting_idle'){this.clear();return this.wait({code:'BROWSER_BUSY',retry_at:this.now()+1000});}if(r.state==='failed')return this.finish('failed',r.code??'UPDATE_APPLY_FAILED');}
 }
 next(session){
  if(!this.active()||session!==this.session)return null;
  if(!this.sameAuthority()){this.cancel();return null;}
  if(this.value.state==='checking'&&!this.delivered){this.delivered=true;return this.control('check');}
  if(this.value.state==='waiting_idle'&&this.now()>=(this.value.retry_at||0)&&!this.busy()){this.set('applying',{code:null});this.arm('UPDATE_APPLY_TIMEOUT');return this.control('apply');}
  return null;
 }
 control(operation){return {control:'store_update',operation,id:this.value.id,session:this.session,from_version:this.value.from_version,target_version:this.value.target_version,deadline:this.value.deadline??this.now()+this.timeoutMs};}
 authorize(session,message){
  const v=this.value;if(v.state!=='applying'||session!==this.session||message?.id!==v.id||message.from_version!==v.from_version||message.target_version!==v.target_version||this.now()>(v.deadline??0))return {authorized:false,code:'UPDATE_EXPIRED'};
  if(!this.sameAuthority()){this.cancel();return {authorized:false,code:'ACCESS_CHANGED'};}
  if(this.busy()){this.clear();this.wait({code:'BROWSER_BUSY',retry_at:this.now()+1000});return {authorized:false,code:'BROWSER_BUSY'};}
  return {authorized:true};
 }
 disconnected(){if(this.active()&&this.value.state!=='applying')this.finish('disconnected','EXTENSION_DISCONNECTED');}
 cancel(){if(this.active())this.finish('failed','ACCESS_CHANGED');}
 close(){this.clear();}
}
