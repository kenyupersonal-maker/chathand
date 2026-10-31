import {beforeSiteExecution,currentSiteExecution} from '../v1/site-execution-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail,saveJSON,privateDir} from '../../engine/src/core.mjs';
import {foregroundDeliveryDetails,backgroundDeliveryDetails} from '../../engine/src/control-errors.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const operationKey=o=>hash('task\0'+o.task_id+'\0'+o.request_id);
const uncertainResult=r=>r?.delivery_unconfirmed===true||r?.do_not_replay===true||r?.status==='unknown'||r?.delivery_status==='posted_unconfirmed';
const failedResult=r=>r?.status==='failed'||r?.isError===true||!!r?.error;
/** UI actions may be irreversible. Journal intent first; never blindly replay after a crash. */
export class UIOperations {
 constructor(stateDir,policy){this.policy=policy;this.dir=path.join(stateDir,'ui-action-receipts');privateDir(this.dir);this.inflight=new Map();this.cache=new Map();this.active=new Map();this.uncertainTasks=new Set();this.tail=Promise.resolve();}
 busy(task){return (this.active.get(task)||0)>0;}
 async read(task,caller,fn,desktopAction=false){this.policy.require(task,caller);const epoch=this.policy.epoch;this.active.set(task,(this.active.get(task)||0)+1);try{const r=await fn();try{this.policy.require(task,caller);if(epoch!==this.policy.epoch)fail('RESULT_REVOKED','访问范围已变化，请重新观察。');}catch(e){const sent=desktopAction?(foregroundDeliveryDetails(r)||backgroundDeliveryDetails(r)):null;if(sent){e.details={...e.details,...sent};e.recovery={next_action:'computer_observe',automatic_retry:false};}throw e;}return r;}finally{this.active.set(task,Math.max(0,(this.active.get(task)||1)-1));}}
 attempted(file,stamp,o,caller){
  // Old receipts used a caller-derived filename. Their payload stamp includes
  // the task and request, so a handoff must find them without redoing the effect.
  const originalCaller=this.policy.tasks?.get(o.task_id)?.caller;
  // These are the two actual authenticated ingress caller classes, not a
  // guessed identity from chat text. Old tasks may be absent after restart.
  const known=new Set([file,...[caller,originalCaller,'chatgpt','local-mcp'].filter(v=>typeof v==='string').map(v=>path.join(this.dir,hash(v+'\0'+o.request_id)+'.json'))]);
  for(const candidate of known)if(fs.existsSync(candidate)){const old=JSON.parse(fs.readFileSync(candidate,'utf8'));if(old.stamp!==stamp)fail('OP_CONFLICT','请求编号已用于不同操作。');fail('UI_ACTION_ALREADY_ATTEMPTED','此操作已在此前会话尝试。先观察页面或桌面，不会自动重复点击。');}
  const files=fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(n=>path.join(this.dir,n));
  for(const candidate of files){const old=JSON.parse(fs.readFileSync(candidate,'utf8'));if(candidate===file&&old.stamp!==stamp)fail('OP_CONFLICT','请求编号已用于不同操作。');if(old.stamp===stamp)fail('UI_ACTION_ALREADY_ATTEMPTED','此操作已在此前会话尝试。先观察页面或桌面，不会自动重复点击。');}
 }
 previous(name,o,caller){
  const key=operationKey(o),stamp=hash(JSON.stringify([name,o])),cached=this.cache.get(key),file=path.join(this.dir,key+'.json');
  if(cached){if(cached.stamp!==stamp)fail('OP_CONFLICT','请求编号已用于不同操作。');return cached.promise;}
  this.attempted(file,stamp,o,caller);
  return null;
 }
 run(name,o,caller,fn){
  this.policy.require(o.task_id,caller);
  if(typeof o.request_id!=='string'||!/^[-_a-zA-Z0-9]{8,96}$/.test(o.request_id))fail('REQUEST_ID_REQUIRED','操作需要稳定的 request_id。');
  const key=operationKey(o),stamp=hash(JSON.stringify([name,o]));
  const cached=this.cache.get(key);if(cached){if(cached.stamp!==stamp)fail('OP_CONFLICT','请求编号已用于不同操作。');return cached.promise;}
  const file=path.join(this.dir,key+'.json');
  this.attempted(file,stamp,o,caller);
  const epoch=this.policy.epoch;
  const promise=this.tail.then(async()=>{
   if(currentSiteExecution())await beforeSiteExecution();
   this.policy.require(o.task_id,caller);if(epoch!==this.policy.epoch)fail('TASK_REVOKED','权限已变化，操作未执行。');
   saveJSON(file,{version:1,tool:name,stamp,status:'started',time:Date.now()});
   try {const result=await this.read(o.task_id,caller,fn,['computer_action','computer_batch'].includes(name));const uncertain=uncertainResult(result)||result?.completed===false,failed=failedResult(result);if(uncertain||failed)this.uncertainTasks.add(o.task_id);const rawCode=result?.error?.code,code=typeof rawCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode)?rawCode:uncertain?'UI_ACTION_UNCONFIRMED':'UI_ACTION_FAILED';saveJSON(file,{version:1,tool:name,stamp,status:uncertain||failed?'failed_or_unknown':'completed',...(uncertain||failed?{code}:{}),time:Date.now()});return result;}
   catch(e){this.uncertainTasks.add(o.task_id);saveJSON(file,{version:1,tool:name,stamp,status:'failed_or_unknown',code:e.code||'UI_ACTION_FAILED',time:Date.now()});throw e;}
  });
  this.tail=promise.catch(()=>{});this.cache.set(key,{stamp,promise});if(this.cache.size>300)this.cache.delete(this.cache.keys().next().value);return promise;
 }
}
