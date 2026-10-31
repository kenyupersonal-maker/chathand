import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDir,fail} from '../../engine/src/core.mjs';

// Only these existing mutators take part in automatic task creation. Reads,
// task control, installation, and image selection keep their own state machines.
const FILE=new Set(['write_text','restore_file','create_directory','move_path','trash_path','restore_trash','edit_file']);
const UI=new Set(['browser_open','browser_tabs','browser_action','browser_upload','browser_download','browser_close','browser_batch','browser_wait_for','computer_action','computer_batch','computer_focus']);
const COMMAND=new Set(['propose_command','command_input']);
const ARTIFACT=new Set(['save_files','expect_download']);
const WITHOUT_ID=new Set(['log_note','task_checkpoint','request_update','desktop_action']);
const ID=/^[A-Za-z0-9_-]{8,96}$/;
const UUID=/^[a-f0-9-]{36}$/i;
export const AUTO_TASK_INTERNAL=Symbol('auto_task_internal');
// Only trusted pre-effect code may assert this; public arguments cannot forge it.
export const AUTO_TASK_NOT_EXECUTED=Symbol('auto_task_not_executed');
export const AUTO_TASK_IDENTITY=Symbol('auto_task_identity');
export const AUTO_TASK_WRAPPER_TOOLS=Object.freeze([...WITHOUT_ID]);

function atomic(file,body){
 const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);fs.writeFileSync(fd,body);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 finally{if(fd!==undefined&&fd!==null)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function stableStringify(value){if(Array.isArray(value))return '['+value.map(stableStringify).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableStringify(value[k])).join(',')+'}';return JSON.stringify(value);}
function valid(record,key){return record?.format===1&&record.key===key&&UUID.test(record.task_id)&&typeof record.digest==='string'&&typeof record.root==='string'&&['auto','full'].includes(record.access_mode)&&Number.isSafeInteger(record.permission_revision)&&['reserved','task_bound','started','completed','failed_definite','unknown'].includes(record.state);}

function uncertainResult(value,depth=0){
 if(!value||typeof value!=='object'||depth>8)return false;
 if(value.do_not_replay===true||value.delivery_unconfirmed===true||value.status==='failed'||value.ok===false||value.success===false)return true;
 if(['execution_state','status','state','delivery_status','stop_reason'].some(key=>['unknown','unconfirmed','posted_unconfirmed','failed_or_unknown','failed_or_unconfirmed'].includes(value[key])))return true;
 for(const key of ['receipts','steps','results'])if(Array.isArray(value[key])&&value[key].some(item=>uncertainResult(item,depth+1)))return true;
 return ['result','error','details','failure'].some(key=>uncertainResult(value[key],depth+1));
}
function receiptReference(value){
 const out={};for(const key of ['job_id','request_id','operation_id','input_id'])if(typeof value?.[key]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value[key]))out[key]=value[key];return out;
}

export class AutoTaskExecution{
 constructor({stateDir,policy,capabilities}){
  this.policy=policy;this.capabilities=capabilities;this.flights=new Map();this.dir=path.join(stateDir,'auto-task-execution');privateDir(this.dir);
  this.secretFile=path.join(this.dir,'fingerprint.key');
  try{const fd=fs.openSync(this.secretFile,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);try{fs.writeSync(fd,crypto.randomBytes(32));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const directory=fs.openSync(this.dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}catch(e){if(e.code!=='EEXIST')throw e;}
  const st=fs.lstatSync(this.secretFile);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==32||(st.mode&0o077)!==0)fail('AUTO_TASK_LEDGER_INVALID','自动任务指纹密钥无效，已停止写入。');
  this.secret=fs.readFileSync(this.secretFile);
 }
 kind(name,args){
  if(FILE.has(name))return {namespace:'file',id:args.operation_id};
  if(UI.has(name))return {namespace:'ui',id:args.request_id};
  if(COMMAND.has(name))return {namespace:name,id:args.request_id};
  if(ARTIFACT.has(name))return {namespace:name+':'+args.task_id,id:args.request_id,artifact:true};
  if(name==='desktop_action'&&args.action==='open_path')return {namespace:'ui',id:args.request_id};
  if(WITHOUT_ID.has(name))return {namespace:name,id:null};
  return null;
 }
 identity(name,args,context){
  const k=this.kind(name,args);if(!k)return null;
  if(k.id!==null){if(typeof k.id!=='string'||(k.artifact?(!k.id||k.id.length>120):!ID.test(k.id)))fail('OP_INVALID','操作编号需为 8–96 个字母、数字、下划线或短横线。');return {namespace:k.namespace,id:k.id};}
  const trusted=context[AUTO_TASK_IDENTITY];
  if(trusted&&trusted.kind==='site'&&typeof trusted.namespace==='string'&&trusted.namespace.length<=512&&typeof trusted.id==='string'&&trusted.id.length>=1&&trusted.id.length<=128)return {namespace:'delivery:'+trusted.namespace+':'+name,id:trusted.id};
  if(trusted&&trusted.kind==='wrapper'&&WITHOUT_ID.has(name)&&typeof trusted.id==='string'&&ID.test(trusted.id))return {namespace:'wrapper:'+name,id:trusted.id};
  return null;
 }
 file(identity){return path.join(this.dir,crypto.createHash('sha256').update(identity.namespace+'\0'+identity.id).digest('hex')+'.json');}
 hasRecord(name,args,context){const identity=this.identity(name,args,context);return !!identity&&fs.existsSync(this.file(identity));}
 read(file,key){let raw;try{raw=fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}let r;try{r=JSON.parse(raw);}catch{fail('AUTO_TASK_LEDGER_INVALID','自动任务记录无法读取；不能重做原动作。');}if(!valid(r,key))fail('AUTO_TASK_LEDGER_INVALID','自动任务记录不完整；不能重做原动作。');return r;}
 save(file,record){atomic(file,JSON.stringify(record));}
 fingerprint(name,args,deliveryDigest=null){return crypto.createHmac('sha256',this.secret).update(stableStringify([name,args,deliveryDigest])).digest('hex');}
 needsTask(name,args){return !!this.kind(name,args)&&typeof args?.task_id==='string';}
 sameScope(r){return r.project_id===this.policy.state.data.active&&r.root===this.policy.store.root&&r.epoch===this.policy.epoch&&r.access_mode===this.policy.store.accessMode&&r.permission_revision===(this.policy.permissionRevision||0);}
 live(id){let t;try{t=this.policy.get(id);}catch(e){if(e.code==='TASK_MISSING')return null;throw e;}if(t.status==='active'&&(t.project_id!==this.policy.state.data.active||t.root!==this.policy.store.root||t.epoch!==this.policy.epoch))fail('ROOT_CHANGED','当前文件范围或权限已改变；原任务不可恢复。');return t.status==='active'?t:null;}
 recipe(name,args){
  const request_id=crypto.randomUUID();return {execution_state:'not_started',task_created:false,next_action:'call_run_capability',message:'这一步尚未执行。按下面的编号继续，不需要你确认。',capability:'execute_task_step',parameters:{request_id,task_id:args.task_id,tool:name,arguments:args}};
 }
 result(r,state=r.state){return {execution_state:state,task_created:r.task_created!==false,previous_task_id:r.previous_task_id,new_task_id:r.task_id,task_id:r.task_id,local_capabilities:this.capabilities(),...(r.receipt_reference?{receipt_reference:r.receipt_reference}:{}),...(state==='unknown'?{do_not_replay:true,next_action:'查看原任务和操作回执；结果不明时不要用同一编号重做。'}:{})};}
 async execute(name,args,caller,context,run){
  if(!this.needsTask(name,args))return run(args);
  const identity=this.identity(name,args,context),existingTask=this.live(args.task_id);
  if(!identity)return existingTask?run(args):this.recipe(name,args);
  const key=identity.namespace+'\0'+identity.id,file=this.file(identity),prior=this.read(file,key);
  const canonical=prior&&args.task_id===prior.task_id?{...args,task_id:prior.previous_task_id}:args;
  const digest=this.fingerprint(name,canonical,identity.namespace.startsWith('delivery:')?context[AUTO_TASK_IDENTITY]?.requestDigest||null:null);
  const flight=this.flights.get(key);
  if(flight){if(flight.digest!==digest)fail('OP_CONFLICT','同一个调用编号对应不同操作，原记录保留。');return flight.promise;}
  if(!prior&&existingTask&&context[AUTO_TASK_IDENTITY]?.kind!=='wrapper')return run(args);
  const promise=this._execute({key,file,digest,name,args:canonical,caller,context,run,existingTask});this.flights.set(key,{digest,promise});
  try{return await promise;}finally{if(this.flights.get(key)?.promise===promise)this.flights.delete(key);}
 }
 async _execute({key,file,digest,name,args,caller,context,run,existingTask}){
  let r=this.read(file,key);
  if(r&&r.digest!==digest)fail('OP_CONFLICT','同一个调用编号对应不同操作，原记录保留。');
  if(r&&!this.sameScope(r))fail('ROOT_CHANGED','当前文件范围或权限已改变；原自动任务不可恢复。');
  if(r?.state==='completed')return {...this.result(r,'completed'),replayed:true,next_action:'查看原操作回执；这一步已执行，不重复执行。'};
  if(r?.state==='started'||r?.state==='unknown')return {...this.result(r,'unknown'),replayed:true};
  if(r?.state==='failed_definite')return {...this.result(r,'failed_definite'),replayed:true,next_action:'原操作已明确失败；新意图请使用新的调用编号。'};
  this.policy.check();
  if(!r){
   const task_id=existingTask?.id||crypto.randomUUID();r={format:1,key,digest,name,state:'reserved',task_created:!existingTask,previous_task_id:args.task_id,task_id,begin_request_id:'at_'+crypto.createHash('sha256').update(key).digest('hex').slice(0,48),title:name+' 自动任务',title_key:'autoTask.task.title',title_params:{name},project_id:this.policy.state.data.active,root:this.policy.store.root,epoch:this.policy.epoch,access_mode:this.policy.store.accessMode,permission_revision:this.policy.permissionRevision||0,created_at:Date.now()};this.save(file,r);
  }
  if(!this.sameScope(r))fail('ROOT_CHANGED','当前文件范围或权限已改变；原自动任务不可恢复。');
  // The reserved UUID precedes begin(), so a crash at either boundary always
  // recovers the same task identity. No assistant-visible task is required.
  let t=this.policy.tasks.get(r.task_id);
  if(!t&&r.task_created!==false){const out=this.policy.begin({request_id:r.begin_request_id,title:r.title},caller,{session_hash:context.session_hash||null,connection_principal:context.connectionPrincipal||null,reservedId:r.task_id});t=this.policy.get(out.task_id);}
  if(t&&r.task_created!==false&&r.title_key){t.title_key=r.title_key;t.title_params=structuredClone(r.title_params||{});}
  if(!t)fail('TASK_MISSING','原任务已不在本机；不能重做这一步。');
  if(r.state==='reserved'){r={...r,state:'task_bound'};this.save(file,r);}
  const resolved={...args,task_id:r.task_id};
  this.policy.require(r.task_id,caller);
  r={...r,state:'started',started_at:Date.now()};this.save(file,r);
  try{
   const value=await run(resolved);
   const state=value?.[AUTO_TASK_NOT_EXECUTED]===true?'failed_definite':uncertainResult(value)?'unknown':'completed';
   r={...r,state,completed_at:Date.now(),receipt_reference:receiptReference(value)};this.save(file,r);
   const outcome=this.result(r,state);
   // A normal JS return can still mean delivery is unknown or a batch stopped.
   // Preserve business evidence; never turn it into a completed action.
   return value&&typeof value==='object'&&!Array.isArray(value)?{...value,...outcome,...(state==='completed'&&typeof value.execution_state==='string'?{execution_state:value.execution_state}:{})}:outcome;
  }catch(e){
   // After started there is no general proof of non-execution. Preserve the
   // original error only in memory, never serialize payloads or secret text.
   const state=e?.[AUTO_TASK_NOT_EXECUTED]===true?'failed_definite':'unknown';
   try{r={...r,state,unknown_at:Date.now()};this.save(file,r);}catch{}
   e.auto_task=this.result(r,state);throw e;
  }
 }
}
