import {t} from '../i18n.mjs';
import {currentSiteExecution,assertSiteExecution,siteDeliveryReady} from '../v1/site-execution-context.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {blockedForError} from '../v1/blocked.mjs';
import {capabilityError,capabilityAllowed,chatgptSelfAllowed,chatgptSelfError} from '../v1/permissions.mjs';
import {fail,redactErrorText} from '../../engine/src/core.mjs';
import {foregroundDeliveryDetails} from '../../engine/src/control-errors.mjs';

const actions = new Set(['click','double_click','right_click','move','drag','scroll','type','key']);
const OBSERVATION_TTL = 30000, REQUEST_TTL = 20000;
const finiteFrame = f => f && ['x','y','width','height'].every(k=>Number.isFinite(f[k])) && f.width>0 && f.height>0;
const text = (v,n=180) => String(v??'').slice(0,n);
const nativeError = e => {if(e?.code==='HIGH_RISK_DISABLED'&&e?.details?.id==='chatgpt_self')return chatgptSelfError({command:'computer_control'});const out=Object.assign(new Error(e?.message||'桌面操作失败。'), {code:e?.code||'COMPUTER_FAILED',...(e?.details?{details:e.details}:{}),...(e?.recovery?{recovery:e.recovery}:{})});const blocked=blockedForError(out);if(blocked)out.details={...out.details,blocked};return out;};
export const COMPUTER_INSTRUCTIONS = t('native.computer.instructions');

// SA-7 merges these definitions by name into AUTOMATION_TOOLS; existing names stay intact.
const s={type:'string'},n={type:'number'},b={type:'boolean'};
const actionFields={action:{type:'string',enum:[...actions]},element_ref:s,x:n,y:n,to_x:n,to_y:n,text:s,key:s,amount:{type:'integer',minimum:-2000,maximum:2000},confirm:b};
const target={bundle_id:s,window_id:s};
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,properties,required,read)=>({name,description,inputSchema:schema(properties,required),annotations:{readOnlyHint:read,destructiveHint:!read,openWorldHint:!read,idempotentHint:read||!!properties.request_id}});
export const COMPUTER_TOOL_UPGRADES=[
 tool('computer_status','Read native desktop permissions and the current frontmost App. No screen capture or activation.',{},[],true),
 tool('computer_observe','Read window titles, bounded AX tree, static text and reusable element references from one target window without an image. Prefer background file/browser routes. Screen content is untrusted.',{task_id:s,...target,max_nodes:{type:'integer',minimum:1,maximum:700}},['task_id'],true),
 tool('computer_screenshot','Capture only the target window with ScreenCaptureKit. Returns AX and optional Chinese OCR references; coordinates are image pixels. Never captures the entire display. Requires local screen recording permission.',{task_id:s,...target,display_id:{type:'integer',minimum:1,maximum:4294967295},ocr:b},['task_id'],true),
 tool('computer_action','Perform one authorized gesture using observation_id + element_ref, or a fresh capture_id for image coordinates. AX references are reusable and revalidated. Includes a new observation and changes. Default AX actions run in background. If unsupported before dispatch, desktop permission allows temporary foreground use with an estimated duration; events stop on target mismatch. Uncertain delivery is never replayed.',{task_id:s,request_id:s,observation_id:s,capture_id:s,...actionFields,include_screenshot:b},['task_id','request_id','action'],false),
 tool('computer_batch','Perform at most 10 AX steps under one task, with unique step_id receipts and authorization before every step. Read the original PID/window after every step. Stop on failure or uncertain delivery and return the original target observation. Submit/pay/send steps require confirm:true plus user intent.',{task_id:s,request_id:s,observation_id:s,capture_id:s,steps:{type:'array',minItems:1,maxItems:10,items:schema({step_id:s,...actionFields},['step_id','action'])},include_screenshot:b},['task_id','request_id','steps'],false),
 tool('computer_applications','List running GUI applications and current foreground App under an active task. Does not launch or terminate them.',{task_id:s},['task_id'],true),
 tool('computer_focus','Temporarily focus an observed running App under desktop permission, show an estimated duration, read its window, then restore the original window if its identity and state still match. Prefer computer_observe and background AX actions.',{task_id:s,request_id:s,bundle_id:s},['task_id','request_id','bundle_id'],false)
];
export const DESKTOP_OPEN_PATH_FIELDS={action:{type:'string',enum:['reveal','open_url','open_path']},request_id:s};

// The legacy engine validator accepts string arrays only. Use this strict walker
// for COMPUTER_TOOL_UPGRADES, including object steps, before invoking the tool.
export function validateComputerToolArgs(definition,args){
 const invalid=(at,why)=>fail('ARG_INVALID','桌面参数 '+at+' '+why+'。');
 function walk(rule,value,at){
  if(rule.type==='object'){
   if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid(at,'必须为普通对象');
   const properties=rule.properties||{};
   if(Object.keys(value).some(k=>!Object.hasOwn(properties,k)))invalid(at,'含有不支持的字段');
   for(const required of rule.required||[])if(!Object.hasOwn(value,required))invalid(at+'.'+required,'是必填项');
   for(const [key,child] of Object.entries(properties))if(Object.hasOwn(value,key))walk(child,value[key],at+'.'+key);
  }else if(rule.type==='array'){
   if(!Array.isArray(value)||value.length<(rule.minItems??0)||value.length>(rule.maxItems??1000))invalid(at,'数组长度不符合限制');
   value.forEach(item=>walk(rule.items,item,at+'[]'));
  }else if(rule.type==='string'){
   if(typeof value!=='string'||value.length>(rule.maxLength??8192))invalid(at,'必须为限长文字');
  }else if(rule.type==='boolean'){
   if(typeof value!=='boolean')invalid(at,'必须为布尔值');
  }else if(rule.type==='number'||rule.type==='integer'){
   if(!Number.isFinite(value)||(rule.type==='integer'&&!Number.isInteger(value))||value<(rule.minimum??-Infinity)||value>(rule.maximum??Infinity))invalid(at,'数值不符合限制');
  }else invalid(at,'使用了不支持的参数类型');
  if(rule.enum&&!rule.enum.includes(value))invalid(at,'值不在允许列表中');
 }
 walk(definition.inputSchema,args,'arguments');
 if(definition.name==='computer_batch')for(const step of args.steps)if(!/^[-_a-zA-Z0-9]{1,96}$/.test(step.step_id))invalid('steps[].step_id','格式无效');
 if(['computer_action','computer_focus','computer_batch'].includes(definition.name)||definition.name==='desktop_action'&&args.action==='open_path'){
  if(typeof args.request_id!=='string'||!/^[-_a-zA-Z0-9]{8,96}$/.test(args.request_id))invalid('request_id','必须是稳定的 8–96 字符操作编号');
 }
 if(definition.name==='desktop_action'&&args.action==='open_path'&&typeof args.path!=='string')invalid('path','是必填项');
 return args;
}
export function computerErrorDetails(value,depth=0){
 if(typeof value==='string')return redactErrorText(value).slice(0,1200);
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value==='boolean'||value===null)return value;
 if(depth>3)return null;
 if(Array.isArray(value))return value.slice(0,20).map(v=>computerErrorDetails(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,30).map(([key,child])=>[key.slice(0,60),/^(?:api_key|runtime_key|admin_token|mcp_token|password|authorization)$/i.test(key)?'[REDACTED]':computerErrorDetails(child,depth+1)]));
 return null;
}

export class NativeComputer {
 constructor(state,policy){this.state=state;this.policy=policy;this.pending=new Map();this.captures=new Map();this.observations=new Map();this.lastSeen=0;this.nativeStatus=null;this.frontApp=null;this.userStopped=new Set();}
 scopeNote(){
  if(this.state.data.mode==='full')return null;
  const project=this.state.project?.()||this.state.data.projects?.find(p=>p.id===this.state.data.active);
  const folder=path.basename(project?.path||this.policy.store?.root||'')||project?.name||'当前工作区';
  return '文件范围是『'+folder+'』：不要改动这个文件夹以外的文件；要下载、保存，存进这个文件夹。';
 }
 withScope(result){const note=this.scopeNote();return note?{...result,details:{...result?.details,scope_note:note}}:result;}
 status(){return this.withScope({native_online:Date.now()-this.lastSeen<5000,permissions:this.nativeStatus,front_app:this.frontApp,front_bundle:this.frontApp?.bundle_id||null,required_access:'active_task_and_desktop_permission',coordinates:'target-window image pixels; AX references preferred',additional_model_api:false,ttlMs:1000,cacheScope:'private',instruction:COMPUTER_INSTRUCTIONS});}
 touchNativeLease(){this.lastSeen=Date.now();}
 heartbeat(status){
  this.lastSeen=Date.now();
  this.nativeStatus={screen_recording:status?.screen_recording===true,accessibility:status?.accessibility===true,accessibility_elements:status?.accessibility_elements===true};
  this.frontApp=status?.front_app&&typeof status.front_app.bundle_id==='string'?{bundle_id:text(status.front_app.bundle_id),name:text(status.front_app.name),pid:Number.isInteger(status.front_app.pid)?status.front_app.pid:null}:null;
  return this.status();
 }
 check(task,caller,{fileOpen=false}={}){
  this.policy.require(task,caller);
  if(!fileOpen&&!capabilityAllowed(this.state,'desktop',{task_id:task}))throw capabilityError('desktop',{command:'computer_action'});
 }
 userStop(task,{scope}={}){if(scope!=='desktop')fail('ARG_INVALID','Invalid desktop scope.');this.userStopped.add(task);for(const p of [...this.pending.values()])if(p.task===task)this.reject(p,nativeError({code:'COMPUTER_USER_ACTIVITY',details:{user_stopped:true,do_not_replay:true}}));return {ok:true,stopped:true,user_stopped:true,scope};}
 userResume(task,{scope}={}){if(scope!=='desktop')fail('ARG_INVALID','Invalid desktop scope.');this.userStopped.delete(task);return {ok:true,resumed:true,user_stopped:false,scope,next_action:'computer_observe'};}
 request(action,args,task,caller){
  if(this.userStopped.has(task)&&!['observe','screenshot','applications'].includes(action))throw nativeError({code:'COMPUTER_USER_ACTIVITY',message:'User stopped this task; observe before resuming.',details:{user_stopped:true}});
  const selfAllowed=chatgptSelfAllowed(this.state,{task_id:task});args={...args,chatgpt_self_allowed:selfAllowed,...(Array.isArray(args.steps)?{steps:args.steps.map(step=>({...step,chatgpt_self_allowed:selfAllowed}))}:{})};
  this.check(task,caller,{fileOpen:action==='open_path'});
  if(Date.now()-this.lastSeen>5000)fail('NATIVE_COMPUTER_OFFLINE','请打开新版 ChatHand 应用；后台终端服务没有原生桌面控制窗口。');
  if(this.pending.size>=8)fail('COMPUTER_BUSY','桌面操作队列已满。');
  const id=crypto.randomUUID(),epoch=this.policy.epoch,created=Date.now();
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.pending.delete(id);reject(nativeError({code:'COMPUTER_TIMEOUT',message:'桌面请求超时；先观察结果，禁止自动重放。',details:{delivery_unconfirmed:true},recovery:{automatic_retry:false,next_action:'computer_observe'}}));},REQUEST_TTL);
   this.pending.set(id,{siteExecution:currentSiteExecution(),id,action,args,task,caller,epoch,revision:this.policy.permissionRevision||0,created,resolve,reject,timeout,delivered:false});
  });
 }
 authorize(id){const p=this.pending.get(id);if(!p)fail('COMPUTER_REQUEST_EXPIRED','桌面请求已过期。');assertSiteExecution(p.siteExecution);this.check(p.task,p.caller,{fileOpen:p.action==='open_path'});if(p.epoch!==this.policy.epoch||p.revision!==(this.policy.permissionRevision||0)||Date.now()-p.created>REQUEST_TTL-1000)fail('COMPUTER_REQUEST_EXPIRED','桌面请求已失效。');return p;}
 next(){this.lastSeen=Date.now();for(const p of this.pending.values()){if(p.delivered)continue;try{if(!siteDeliveryReady(p))continue;this.authorize(p.id);}catch(e){this.reject(p,e);continue;}p.delivered=true;return {request:{id:p.id,action:p.action,args:p.args,expires_at:p.created+REQUEST_TTL-1000}};}return {request:null};}
 reject(p,error){clearTimeout(p.timeout);this.pending.delete(p.id);p.reject(error);}
 complete(id,result){
  const p=this.pending.get(id);if(!p)return {discarded:true};
  try{this.authorize(id);}catch(e){
    // Native may have posted its B2 recipe before the task/epoch/revision
    // expired. Do not let the final JS authorization discard the only
    // evidence and make an already-attempted action look replayable.
    const b2Attempted=p.delivered&&['action','batch'].includes(p.action)&&(
      result?.method==='background_target_click'||
      result?.stop_reason==='posted_unconfirmed'||
      result?.error?.details?.method==='background_target_click');
    const foreground=p.delivered&&['action','batch'].includes(p.action)?foregroundDeliveryDetails(result):null;
    if(foreground){
      this.reject(p,nativeError({code:e?.code||'COMPUTER_ACTION_UNCONFIRMED',
        message:'输入回执到达时任务或权限已变化，原动作已经尝试；先观察原窗口，不要重发。',
        details:{...e?.details,...foreground},
        recovery:{next_action:'computer_observe',automatic_retry:false}}));
    }else if(b2Attempted){
      this.reject(p,nativeError({code:e?.code||'COMPUTER_ACTION_UNCONFIRMED',
        message:'后台点击回执到达时任务或权限已变化，原动作可能已投递；先观察原窗口，不要再点。',
        details:{...e?.details,method:'background_target_click',background:true,delivery_status:'posted_unconfirmed',
          delivery_unconfirmed:true,do_not_replay:true},
        recovery:{next_action:'computer_observe',automatic_retry:false}}));
    }else this.reject(p,e);
    return {discarded:true};
  }
  clearTimeout(p.timeout);this.pending.delete(id);
  if(result?.error){
   let observation=null;try{if(result.observation?.native_snapshot_id)observation=this.remember(result.observation,{task_id:p.task},p.caller);}catch{}
   const note=this.scopeNote();
   p.reject(nativeError({...result.error,details:{...result.error.details,...(observation?{observation,changes:result.changes}:{}),...(note?{scope_note:note}:{})}}));
  }else p.resolve(this.withScope(result));
  return {accepted:true};
 }
 prune(map){for(const [id,o] of map)if(Date.now()-o.at>OBSERVATION_TTL)map.delete(id);while(map.size>20)map.delete(map.keys().next().value);}
 sanitizeElements(result){
  return (Array.isArray(result.elements)?result.elements:[]).slice(0,700).filter(e=>e&&typeof e.ref==='string'&&typeof e.role==='string'&&finiteFrame(e.frame)).map(e=>({ref:text(e.ref,96),role:text(e.role,80),name:e.sensitive?'':text(e.name),value:e.sensitive?'':text(e.value,1200),text:e.sensitive?'':text(e.text,1200),enabled:e.enabled!==false,interactive:e.interactive!==false,sensitive:e.sensitive===true,source:e.source==='ocr'?'ocr':'ax',consequential:e.consequential===true,frame:{x:e.frame.x,y:e.frame.y,width:e.frame.width,height:e.frame.height}}));
 }
 remember(result,o,caller,image=false){
  if(!result||typeof result.native_snapshot_id!=='string'||!finiteFrame(result.frame))fail('COMPUTER_OBSERVATION_INVALID','原生观察结果无效，请重新观察。');
  const elements=this.sanitizeElements(result),observation_id=crypto.randomUUID();
  const entry={caller,task:o.task_id,epoch:this.policy.epoch,at:Date.now(),frame:result.frame,width:image?result.width:result.frame.width,height:image?result.height:result.frame.height,display_id:result.display_id,front:result.target_bundle||result.front_bundle,bundle_id:result.target_bundle||result.front_bundle,window_id:result.window_id,native_snapshot_id:result.native_snapshot_id,elements:new Map(elements.map(e=>[e.ref,e])),image};
  this.observations.set(observation_id,entry);this.prune(this.observations);
  let capture_id;
  if(image){capture_id=crypto.randomUUID();this.captures.set(capture_id,entry);this.prune(this.captures);}
  return this.withScope({...result,elements,observation_id,...(capture_id?{capture_id}:{}),untrusted_content:true,expires_in_seconds:30,ttlMs:0,cacheScope:'private',instruction:COMPUTER_INSTRUCTIONS});
 }
 target(o){if(o.bundle_id!==undefined&&(typeof o.bundle_id!=='string'||!/^[A-Za-z0-9.-]{3,180}$/.test(o.bundle_id)))fail('ARG_INVALID','应用标识无效。');if(o.window_id!==undefined&&(typeof o.window_id!=='string'||!/^w[0-9]+$/.test(o.window_id)))fail('ARG_INVALID','窗口标识无效。');return {bundle_id:o.bundle_id,window_id:o.window_id,...(o.display_id!==undefined?{display_id:o.display_id}:{})};}
 async observe(o,caller){const max=o.max_nodes??700;if(!Number.isInteger(max)||max<1||max>700)fail('ARG_INVALID','max_nodes 必须为 1–700。');const result=await this.request('observe',{...this.target(o),max_nodes:max},o.task_id,caller);if(result.observation_unavailable===true&&!result.native_snapshot_id)return this.withScope({...result,untrusted_content:true,ttlMs:0,cacheScope:'private',instruction:COMPUTER_INSTRUCTIONS});return this.remember(result,o,caller);}
 async screenshot(o,caller){
  const result=await this.request('screenshot',{...this.target(o),ocr:o.ocr!==false},o.task_id,caller);
  if(typeof result.image_base64!=='string'||result.image_base64.length>5*1024*1024||!Number.isInteger(result.width)||!Number.isInteger(result.height)||result.width<=0||result.height<=0)fail('COMPUTER_IMAGE_INVALID','原生截图返回无效。');
  return this.remember(result,o,caller,true);
 }
 context(o,caller){
  this.check(o.task_id,caller);
  const id=o.observation_id||o.capture_id,map=o.observation_id?this.observations:this.captures,c=map.get(id);
  if(!c||c.caller!==caller||c.task!==o.task_id||c.epoch!==this.policy.epoch||Date.now()-c.at>OBSERVATION_TTL)fail(o.observation_id?'COMPUTER_OBSERVATION_STALE':'COMPUTER_CAPTURE_STALE','观察已过期或不属于此任务，请调用 computer_observe。');
  return c;
 }
 actionArgs(o,c){
  if(!actions.has(o.action))fail('COMPUTER_ACTION_UNKNOWN','未知桌面操作。');
  const point=(x,y)=>{if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=c.width||y>=c.height)fail('COORDINATES_INVALID','坐标超出目标窗口范围。');return {x:c.frame.x+x*c.frame.width/c.width,y:c.frame.y+y*c.frame.height/c.height};};
  const args={action:o.action,expected_front:c.front,bundle_id:c.bundle_id||c.front,window_id:c.window_id,display_id:c.display_id,frame:c.frame,native_snapshot_id:c.native_snapshot_id,confirm:o.confirm===true};
  if(o.element_ref!==undefined){
   if(typeof o.element_ref!=='string'||!c.elements?.has(o.element_ref)||!c.native_snapshot_id)fail('COMPUTER_ELEMENT_STALE','原生控件不存在或已失效，请调用 computer_observe。');
   const e=c.elements.get(o.element_ref);
   if(e.enabled===false)fail('COMPUTER_ELEMENT_DISABLED','目标原生控件已禁用。');
   if(!['click','double_click','right_click','move','type','key','scroll'].includes(o.action))fail('ELEMENT_ACTION_UNSUPPORTED','此动作不支持 element_ref。');
   args.element_ref=o.element_ref;
  }else if(['click','double_click','right_click','move','drag','scroll'].includes(o.action)){
   if(!o.capture_id||!c.image)fail('COMPUTER_CAPTURE_REQUIRED','坐标操作需要新 computer_screenshot 的 capture_id；观察文字只能用于控件引用。');
   Object.assign(args,point(o.x,o.y));
  }
  if(o.action==='drag'){const end=point(o.to_x,o.to_y);args.to_x=end.x;args.to_y=end.y;}
  if(o.action==='scroll'){const amount=o.amount??400;if(!Number.isFinite(amount)||Math.abs(amount)>2000)fail('ARG_INVALID','单次滚动最多 2000。');args.amount=amount;}
  if(o.action==='type'){if(typeof o.text!=='string'||o.text.length>4096)fail('ARG_INVALID','单次输入最多 4096 字符。');args.text=o.text;}
  if(o.action==='key'){if(typeof o.key!=='string'||o.key.length>80)fail('ARG_INVALID','快捷键无效。');args.key=o.key;}
  return args;
 }
 postResult(result,o,caller,originalTarget=null){
  // Native B2 effects cannot be model-certified. The only non-error path is
  // the full fixed recipe without contradictory success/error fields.
  const hasContradiction=value=>['error','failure','performed','success','isError'].some(k=>Object.hasOwn(value,k));
  const strictSingle=value=>value&&typeof value==='object'&&!Array.isArray(value)&&
    value.method==='background_target_click'&&value.background===true&&
    value.delivery_status==='posted_unconfirmed'&&value.delivery_unconfirmed===true&&
    value.do_not_replay===true&&value.verified===false&&value.completed===false&&
    value.automatic_retry===false&&value.attempted_target_channels===10&&
    value.target_focus_records===2&&value.next_action==='computer_screenshot'&&!hasContradiction(value);
  const strictBatch=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||
       value.stop_reason!=='posted_unconfirmed'||value.delivery_status!=='posted_unconfirmed'||
       value.do_not_replay!==true||value.verified!==false||value.completed!==false||
       hasContradiction(value)||!Array.isArray(value.receipts)||value.receipts.length<1||
       value.receipts.length>10||!Number.isInteger(value.remaining_steps))return false;
    const index=value.receipts.findIndex(item=>item?.status==='posted_unconfirmed');
    if(index<0||value.remaining_steps!==value.receipts.length-index-1)return false;
    return value.receipts.every((item,n)=>item&&typeof item==='object'&&!('error'in item)&&
      (n<index?item.status==='performed':
       n===index?item.status==='posted_unconfirmed'&&strictSingle(item.result):
       item.status==='not_attempted'&&!('result'in item)));
  };
  const candidate=result&&typeof result==='object'&&
    (result.method==='background_target_click'||result.stop_reason==='posted_unconfirmed'||
     result.delivery_status==='posted_unconfirmed');
  const normalSingle=!!candidate&&strictSingle(result);
  const normalBatch=!!candidate&&strictBatch(result);
  if(candidate&&!normalSingle&&!normalBatch)throw nativeError({
    code:'COMPUTER_ACTION_UNCONFIRMED',
    message:'后台点击回执不完整或自相矛盾；先观察原窗口，禁止重发。',
    details:{method:'background_target_click',background:true,
      delivery_unconfirmed:true,do_not_replay:true,delivery_status:'posted_unconfirmed'},
    recovery:{next_action:'computer_observe',automatic_retry:false}
  });
  if(result?.observation?.native_snapshot_id)result={...result,observation:this.remember(result.observation,o,caller,typeof result.observation.image_base64==='string')};
  if(normalSingle||normalBatch){
    const bundle=originalTarget?.bundle_id,window=originalTarget?.window_id;
    const pinned=typeof bundle==='string'&&/^[A-Za-z0-9.-]{3,180}$/.test(bundle)&&
      typeof window==='string'&&/^w[0-9]+$/.test(window);
    return this.withScope({...result,next_action:pinned?'computer_screenshot':'computer_observe',
      ...(pinned?{next_target:{bundle_id:bundle,window_id:window}}:{})});
  }
  return this.withScope({...result,next_action:'use_returned_observation_or_computer_observe'});
 }
 async action(o,caller){
  const c=this.context(o,caller),args=this.actionArgs(o,c);
  // Only coordinate captures are single use. Reusable AX references are revalidated natively.
  if(!o.element_ref&&o.capture_id)this.captures.delete(o.capture_id);
  return this.postResult(await this.request('action',{...args,include_screenshot:o.include_screenshot===true},o.task_id,caller),o,caller,c);
 }
 async batch(o,caller){
  const c=this.context(o,caller);
  if(!Array.isArray(o.steps)||o.steps.length<1||o.steps.length>10)fail('ARG_INVALID','批量桌面操作必须为 1–10 步。');
  const ids=new Set(),steps=o.steps.map(step=>{
   if(!step||typeof step.step_id!=='string'||!/^[-_a-zA-Z0-9]{1,96}$/.test(step.step_id)||ids.has(step.step_id))fail('ARG_INVALID','每一步必须有不重复的 step_id。');ids.add(step.step_id);
   if(!step.element_ref&&['click','double_click','right_click','move','drag','scroll'].includes(step.action))fail('COMPUTER_BATCH_ELEMENT_REQUIRED','批量指针操作必须使用 AX element_ref；画布坐标请单独操作并重新截图。');
   return {...this.actionArgs({...o,...step},c),step_id:step.step_id};
  });
  return this.postResult(await this.request('batch',{steps,include_screenshot:o.include_screenshot===true},o.task_id,caller),o,caller,c);
 }
 async applications(o,caller){return this.withScope({...await this.request('applications',{},o.task_id,caller),ttlMs:1000,cacheScope:'private'});}
 async focus(o,caller){this.target(o);if(!o.bundle_id)fail('ARG_INVALID','请提供应用标识。');return this.postResult(await this.request('focus',{bundle_id:o.bundle_id},o.task_id,caller),o,caller);}
 async openPath(o,caller,store=this.policy.store){
  this.check(o.task_id,caller,{fileOpen:true});
  if(!store?.resolve)fail('COMPUTER_PATH_SCOPE_REQUIRED','打开文件需要当前文件范围的解析器。');
  const resolved=store.resolve(o.path),st=fs.statSync(resolved);
  if(!st.isFile()&&!st.isDirectory())fail('TYPE_BLOCKED','只能用默认程序打开普通文件或应用包。');
  return this.withScope(await this.request('open_path',{path:resolved,identity:{device:st.dev,inode:st.ino,size:st.size,mtime_ms:st.mtimeMs}},o.task_id,caller));
 }
 cancelAll(){for(const p of [...this.pending.values()])this.reject(p,nativeError({code:'TASK_REVOKED',message:'桌面操作已停止。'}));this.captures.clear();this.observations.clear();}
}
