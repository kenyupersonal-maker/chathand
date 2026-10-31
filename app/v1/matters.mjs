// 1051: private, append-only local matter journal. No external execution capabilities.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateMatterEntry,validateMatterQuery,validateMatterWrite,scrubMatter} from './matter-contract.mjs';
const err=(code,message)=>{throw Object.assign(Error(message),{code});};
const hash=o=>crypto.createHash('sha256').update(typeof o==='string'?o:JSON.stringify(o)).digest('hex');
const SHA=/^[a-f0-9]{64}$/;
const OP=/^[A-Za-z0-9_-]{1,96}$/;
const LEDGER_MAX_BYTES=10*1024*1024;
// 1082（Claude，Ken 10/28 12:43）：任务结束的原因跟窗口里的说法一样（statusWords.stop.*），不再写「停下了」「收起了」。
const TASK_END_WORDS=Object.freeze({completed:'成功完成',failed:'未完成',cancelled:'已停止',expired:'任务已过期',superseded:'已被新任务取代',revoked:'未收到结果',paused:'因暂停已停止',connection_lost:'因连接中断已停止',permission_changed:'因文件范围变更已停止',workspace_changed:'因工作区变更已停止',idle:'超时已结束'});
const endedWaitingFor=reason=>reason?(TASK_END_WORDS[reason]||'任务已结束')+'，先放着':'本轮未报告下一步';

const plainObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const within=(p,base)=>p===base||p.startsWith(base+path.sep);
const idOf=n=>'CH-'+n;
const validId=id=>typeof id==='string'&&/^CH-[1-9]\d*$/.test(id);
 // Task finish may cross a soft-delete without a content conflict. Never
 // auto-merge an intervening answer, restore, or delete that changed any data.
 const finishCrossedOnlySoftDelete=(item,entry)=>Boolean(
  item?.deleted===true&&entry?.action==='append'&&
  Number.isSafeInteger(entry.base_revision)&&entry.base_revision>=1&&
  entry.base_revision<item.revision&&
  item.history?.filter(line=>line.revision>entry.base_revision).length>0&&
  item.history.filter(line=>line.revision>entry.base_revision).every(line=>
   line.action==='delete'&&Object.keys(line.data||{}).every(k=>k==='recorded_in'))
 );
function dirSafe(p){if(fs.existsSync(p)){const st=fs.lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink())err('MATTER_UNSAFE_PATH','事项目录不是安全的普通目录');}else fs.mkdirSync(p,{recursive:true,mode:0o700});fs.chmodSync(p,0o700);}
function regular(p){const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>10*1024*1024)err('MATTER_UNSAFE_FILE','事项记录不是安全的普通文件');return st;}
function syncDir(p){try{const fd=fs.openSync(p,fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(!['EINVAL','ENOTSUP'].includes(e.code))throw e;}}
function atomic(file,obj){const dir=path.dirname(file);dirSafe(dir);const tmp=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);try{fs.writeFileSync(fd,JSON.stringify(obj)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);syncDir(dir);}
// R10: entries of a finish intent that touched a purged matter keep only these
// keys. The ledger, not the stub, decides whether the operation had been applied.
const STUB_KEYS=['operation_id','action','id','base_revision'];
const stubEntry=e=>({...Object.fromEntries(STUB_KEYS.filter(k=>Object.hasOwn(e,k)).map(k=>[k,e[k]])),purged:true});
export class MatterStore{
 constructor({stateDir,now=Date.now}={}){
  if(!stateDir||typeof stateDir!=='string'||!path.isAbsolute(stateDir))err('MATTER_PATH','事项数据目录无效');
  this.dir=path.join(stateDir,'matters');this.pendingDir=path.join(this.dir,'finish-intents');this.claimsDir=path.join(this.dir,'begin-claims');this.now=now;this.items=new Map();this.operations=new Map();this.pending=new Map();this.selections=new Map();this.reports=[];this.queue=Promise.resolve();this.sequence=0;
  // R10 (Claude 1052 B2): permanent-delete ledger, kept apart from matter bodies.
  // purged: id -> {at,revision}. consumed: operation_id -> {digest,id,revision}.
  this.ledgerFile=path.join(this.dir,'purge-ledger.json');this.purged=new Map();this.consumed=new Map();
  dirSafe(this.dir);dirSafe(this.pendingDir);dirSafe(this.claimsDir);this.reload();
 }
 serialize(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
 persistSequence(number){if(!Number.isSafeInteger(number)||number<0)err('MATTER_SEQUENCE','事项编号溢出');if(number>this.sequence){atomic(path.join(this.dir,'sequence.json'),{format:1,last:number});this.sequence=number;}}
 file(id){if(!validId(id))err('MATTER_ID','事项编号无效');return path.join(this.dir,id+'.jsonl');}
 readLines(id){const file=this.file(id);if(!fs.existsSync(file))return {lines:[],dirty:false};
  const stat=regular(file),data=fs.readFileSync(file,'utf8');if(Buffer.byteLength(data)!==stat.size)err('MATTER_ENCODING','事项文件编码无效');
  const chunks=data.split('\n');let lines=[],end=0,dirty=false;
  for(const s of chunks.slice(0,-1)){if(!s){end++;continue;}try{const o=JSON.parse(s);if(o.id!==id||o.revision!==lines.length+1||typeof o.operation_id!=='string')throw Error();lines.push(o);end+=Buffer.byteLength(s+'\n');}catch{dirty=true;break;}}
  if(chunks.at(-1)!=='')dirty=true;
  if(dirty)this.reports.push({id,code:'MATTER_TRAILING_DAMAGE',bytes:stat.size,valid_bytes:end});
  return {lines,dirty,valid_bytes:end,size:stat.size};
 }
 // R10: the ledger is the commit point of a purge. Read it before any body file.
 // A damaged ledger fails closed: never guess which purged records may return.
 readLedger(){
  this.purged.clear();this.consumed.clear();if(!fs.existsSync(this.ledgerFile))return;
  let v;try{regular(this.ledgerFile);v=JSON.parse(fs.readFileSync(this.ledgerFile,'utf8'));}catch{err('MATTER_LEDGER_CORRUPT','永久删除记录无法读取，事项库暂停');}
  if(!plainObject(v)||Object.keys(v).sort().join(',')!=='consumed,format,purged'||v.format!==1||
     !plainObject(v.purged)||!plainObject(v.consumed))err('MATTER_LEDGER_CORRUPT','永久删除记录格式无效，事项库暂停');
  for(const [id,x] of Object.entries(v.purged)){
   const n=Number(id.slice(3));
   if(!validId(id)||!Number.isSafeInteger(n)||n<1||!plainObject(x)||Object.keys(x).sort().join(',')!=='at,revision'||
      !Number.isSafeInteger(x.at)||x.at<0||!Number.isSafeInteger(x.revision)||x.revision<1)
    err('MATTER_LEDGER_CORRUPT','永久删除记录格式无效，事项库暂停');
   this.purged.set(id,{at:x.at,revision:x.revision});
  }
  for(const [op,x] of Object.entries(v.consumed)){
   if(!OP.test(op)||!plainObject(x)||Object.keys(x).sort().join(',')!=='digest,id,revision'||
      !SHA.test(x.digest)||!this.purged.has(x.id)||!Number.isSafeInteger(x.revision)||
      x.revision<1||x.revision>this.purged.get(x.id).revision)
    err('MATTER_LEDGER_CORRUPT','永久删除记录格式无效，事项库暂停');
   this.consumed.set(op,{digest:x.digest,id:x.id,revision:x.revision});
  }
 }
 writeLedger(purged,consumed){const next={format:1,purged:Object.fromEntries(purged),consumed:Object.fromEntries(consumed)};
  if(Buffer.byteLength(JSON.stringify(next)+'\n','utf8')>LEDGER_MAX_BYTES)err('MATTER_LEDGER_FULL','永久删除记录已满，清空未执行');
  atomic(this.ledgerFile,next);this.purged=purged;this.consumed=consumed;}
 // Body files and damage backups of a purged id. Safe to repeat after a crash.
 bodyFiles(id){const base=id+'.jsonl',files=[];
  for(const name of fs.readdirSync(this.dir))if(name===base||name.startsWith(base+'.damage-')){
   const file=path.join(this.dir,name),st=fs.lstatSync(file);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)err('MATTER_UNSAFE_FILE','事项文件身份有变，永久删除暂停');
   files.push(file);
  }
  return files;
 }
 removeBodies(id){const files=this.bodyFiles(id);for(const file of files)fs.unlinkSync(file);return files.length;}
 // Every app-owned finish-intent file, including a rename-interrupted atomic
 // temp, must be understandable before a purge can claim content removal.
 scanIntents({strict=true}={}){
  const out=[];
  for(const name of fs.readdirSync(this.pendingDir)){
   const match=/^([a-f0-9-]{36})\.json((?:\.[a-f0-9-]{36}\.tmp)*)$/.exec(name);
   if(!match){if(strict)err('MATTER_PENDING_UNPROVEN','事项收尾记录无法核对，永久删除暂停');this.reports.push({code:'MATTER_PENDING_CORRUPT',name});continue;}
   const file=path.join(this.pendingDir,name);let value;
   try{regular(file);value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{
    if(strict)err('MATTER_PENDING_UNPROVEN','事项收尾记录无法核对，永久删除暂停');
    this.reports.push({code:'MATTER_PENDING_CORRUPT',name});continue;
   }
   if(!plainObject(value)||value.task_id!==match[1]||!Array.isArray(value.entries)||
      value.entries.some(x=>!plainObject(x)||!plainObject(x.entry)||!OP.test(x.entry.operation_id)||
       !['create','append','delete','restore'].includes(x.entry.action)||
       x.entry.id!==undefined&&!validId(x.entry.id)||
       x.reservedId!==null&&x.reservedId!==undefined&&!validId(x.reservedId))){
    if(strict)err('MATTER_PENDING_UNPROVEN','事项收尾记录无法核对，永久删除暂停');
    this.reports.push({code:'MATTER_PENDING_CORRUPT',name});continue;
   }
   out.push({file,canonical:match[2]==='',value});
  }
  return out;
 }
 // Drop matter content from finish intents that touched a purged id. Keeps the
 // operation ids so a replay is still recognised; never keeps raw/answer text.
 scrubIntents(){
  for(const {file,canonical,value:intent} of this.scanIntents()){
   let changed=false;const entries=intent.entries.map(x=>{const target=x.entry?.id||x.reservedId;if(x.entry?.purged!==true&&target&&this.purged.has(target)){changed=true;return {entry:stubEntry(x.entry),reservedId:x.reservedId||null};}return x;});
   if(changed){const next={...intent,entries};atomic(file,next);if(canonical)this.pending.set(intent.task_id,next);}
  }
 }
 reload(){
  this.items.clear();this.operations.clear();this.pending.clear();this.reports=[];let max=0;this.readLedger();for(const id of this.purged.keys())max=Math.max(max,Number(id.slice(3)));const count=path.join(this.dir,'sequence.json');if(fs.existsSync(count)){regular(count);const saved=JSON.parse(fs.readFileSync(count,'utf8'));if(saved.format!==1||!Number.isSafeInteger(saved.last)||saved.last<0)err('MATTER_SEQUENCE','持久事项编号无效');max=Math.max(max,saved.last);}
  for(const name of fs.readdirSync(this.dir).filter(f=>/^CH-[1-9]\d*\.jsonl$/.test(f)).sort((a,b)=>Number(a.slice(3))-Number(b.slice(3)))){
   const id=name.slice(0,-6),n=Number(id.slice(3));if(!Number.isSafeInteger(n))err('MATTER_ID','事项编号超出范围');max=Math.max(max,n);
   // R10: ledger already says purged, so a crash left the body behind. Finish the purge; never load it.
   if(this.purged.has(id)){this.removeBodies(id);syncDir(this.dir);this.reports.push({id,code:'MATTER_PURGE_COMPLETED'});continue;}
   const {lines}=this.readLines(id);if(!lines.length)continue;const item=this.fold(lines);this.items.set(id,item);
   for(const line of lines){if(this.operations.has(line.operation_id))err('MATTER_JOURNAL_CONFLICT','持久操作号重复，请检查源文件');if(this.consumed.has(line.operation_id))err('MATTER_LEDGER_CORRUPT','永久删除操作号与现存事项冲突，事项库暂停');this.operations.set(line.operation_id,{digest:line.digest,receipt:{operation_id:line.operation_id,id,revision:line.revision,state:line.state,saved:true,replayed:false}});}
  }
  if(this.purged.size){const left=fs.readdirSync(this.dir).filter(n=>/^CH-[1-9]\d*\.jsonl\.damage-/.test(n)).map(n=>n.slice(0,n.indexOf('.jsonl')));for(const id of new Set(left))if(this.purged.has(id)){this.removeBodies(id);syncDir(this.dir);}}
  this.sequence=max;
  for(const {canonical,value} of this.scanIntents({strict:this.purged.size>0}))if(canonical){this.pending.set(value.task_id,value);for(const x of value.entries)if(x.reservedId)this.sequence=Math.max(this.sequence,Number(x.reservedId.slice(3)));}
  if(this.purged.size)this.scrubIntents();
 }
 fold(lines){let value={id:lines[0].id,title:'',state:'deferred',revision:0,deleted:false,created_at:lines[0].at,history:[]};
  for(const line of lines){const d=line.data||{};for(const key of ['title','state','waiting_for','understanding','answer','raw','context','source','evidence','recorded_in','task_id'])if(Object.hasOwn(d,key))value[key]=structuredClone(d[key]);value.revision=line.revision;value.updated_at=line.at;if(line.action==='delete')value.deleted=true;if(line.action==='restore')value.deleted=false;value.history.push(line);}
  return value;
 }
 heal(id){
  const got=this.readLines(id);if(!got.dirty)return;
  const file=this.file(id),backup=file+'.damage-'+hash(fs.readFileSync(file)).slice(0,16);
  if(!fs.existsSync(backup))fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
  const old=fs.readFileSync(file);const fd=fs.openSync(file,fs.constants.O_RDWR);try{fs.ftruncateSync(fd,got.valid_bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  syncDir(this.dir);
  this.reports.push({id,code:'MATTER_DAMAGE_PRESERVED',backup:path.basename(backup),bytes:old.length});
 }
 append(item,e,digest,meta){
  const id=e.id||idOf(this.sequence+1),old=this.items.get(id),revision=(old?.revision||0)+1;
  if(revision===1&&old)err('MATTER_STATE','编号已占用');
  const data=scrubMatter(Object.fromEntries(Object.entries(e).filter(([k])=>!['operation_id','action','id','base_revision','create_anyway'].includes(k))));
  // Preserve the original project attribution. A later append, delete, or
  // finish cannot silently migrate a record into another project's mirror.
  if(old?.recorded_in?.project_id&&meta?.project_id!==old.recorded_in.project_id)
   err('MATTER_PROJECT_OWNER','事项归属其他项目，不能写入或改变导出范围');
  data.recorded_in=old
   ?structuredClone(old.recorded_in||{kind:'unbound',project_id:null})
   :meta?.recorded_in||{kind:'local_connector',project_id:meta?.project_id||null,session_hash:meta?.session_hash||null};
  if(e.action==='delete'||e.action==='restore')delete data.state;
  const line={format:1,id,revision,at:this.now(),operation_id:e.operation_id,digest,action:e.action,data};
  dirSafe(this.dir);
  if(revision>1)this.heal(id);else this.persistSequence(Number(id.slice(3)));
  const f=this.file(id);if(fs.existsSync(f))regular(f);
  const fd=fs.openSync(f,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>10*1024*1024)err('MATTER_UNSAFE_FILE','事项文件身份已变化');fs.writeFileSync(fd,JSON.stringify(line)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(revision===1)syncDir(this.dir);
  const next=this.fold([...(old?.history||[]),line]);this.items.set(id,next);
  const receipt={operation_id:e.operation_id,id,revision,state:next.state,saved:true,replayed:false};
  this.operations.set(e.operation_id,{digest,receipt});
  return receipt;
 }
 similar(e,meta){const t=e.title.toLowerCase().trim(),label=e.source?.label||'';return [...this.items.values()].filter(v=>!v.deleted&&(v.title.toLowerCase()===t||v.source?.label===label&&label&&v.title.toLowerCase().includes(t.slice(0,6)))).slice(0,3).map(v=>({id:v.id,revision:v.revision,title:v.title,state:v.state}));}
 one(e,meta={},options={}){
  const canonical={...e,...(meta.task_id?{task_id:meta.task_id}:{})},digest=hash(canonical),previous=this.operations.get(e.operation_id);
  if(previous){if(previous.digest!==digest)err('OP_CONFLICT','同一操作号带来不同内容，不写入');return {...previous.receipt,replayed:true};}
  // R10: an operation whose matter was purged already took effect once. Replay is a no-op.
  const gone=this.consumed.get(e.operation_id);
  if(gone){if(gone.digest!==digest)err('OP_CONFLICT','同一操作号带来不同内容，不写入');return {operation_id:e.operation_id,id:gone.id,revision:gone.revision,state:null,saved:true,replayed:true,purged:true};}
  if(e.id&&this.purged.has(e.id))err('MATTER_PURGED','事项已永久删除');
  if(options.reservedId&&this.purged.has(options.reservedId))err('MATTER_PURGED','事项已永久删除');
  let old=e.id?this.items.get(e.id):null;
  if(e.action==='create'){
   if(!options.reservedId&&!e.create_anyway){const matches=this.similar(e,meta);if(matches.length)return {operation_id:e.operation_id,id:null,revision:null,saved:false,replayed:false,needs_choice:true,candidates:matches,error_code:'MATTER_SIMILAR'};}
   if(options.reservedId){if(!validId(options.reservedId))err('MATTER_ID','预分配编号无效');if(this.items.has(options.reservedId))err('MATTER_DUPLICATE','预分配编号已存在');e={...e,id:options.reservedId};}
   old=null;
  }else if(!old)err('MATTER_MISSING','事项不存在');
  if(old){
   if(old.revision!==e.base_revision&&!(options.finishFromTask===true&&finishCrossedOnlySoftDelete(old,e)))
    err('MATTER_REVISION_CONFLICT','事项版本已有变化；请以最新版本继续');
   if(e.action==='delete'&&old.deleted)err('MATTER_DELETED','事项已在最近删除');
   if(e.action==='restore'&&!old.deleted)err('MATTER_NOT_DELETED','事项没有被删除');
   // A valid append does not restore a soft-deleted matter: fold() changes the
   // deleted flag only on explicit restore/delete events. Keep the strict
   // base_revision check above so genuine competing edits still conflict.
  }
  if(e.action==='delete'||e.action==='restore')return this.append(old,{...e},digest,meta);
  return this.append(old,e,digest,meta);
 }
 async write(args,meta={}){
  const entries=validateMatterWrite(args);return this.serialize(()=>{const items=[];
   for(const e of entries){try{items.push(this.one(e,meta));}catch(error){items.push({operation_id:e.operation_id,id:e.id||null,revision:this.items.get(e.id)?.revision||null,saved:false,replayed:false,error_code:error.code||'MATTER_ERROR'});}}
   const saved=items.every(x=>x.saved===true);
   return {saved,items,...(items.length===1&&items[0].saved?{notice:'已记：'+items[0].id+' '+(this.items.get(items[0].id)?.title||'事项')}:{}),scope:'local_user_only'};
  });
 }
 summary(v){return {id:v.id,revision:v.revision,title:v.title,state:v.state,waiting_for:v.waiting_for||'',source:v.source||null,answer:v.answer||null,deleted:v.deleted,updated_at:v.updated_at,task_id:v.task_id||null};}
 query(args={},meta={}){
  validateMatterQuery(args);if(args.scope==='current_conversation'&&!meta.session_hash)return {error_code:'MATTER_CONVERSATION_UNVERIFIED',items:[],scope:'unavailable'};
  let list=[...this.items.values()].filter(v=>args.view==='history'||args.view==='detail'||v.deleted!==true);
  const chosen=args.selection_id?this.resolveSelection(args.selection_id):args.ids;
  if(chosen?.length)list=list.filter(x=>chosen.includes(x.id));
  if(args.scope==='current_project')list=list.filter(v=>v.recorded_in?.project_id===meta.project_id);
  if(args.scope==='current_conversation')list=list.filter(v=>v.recorded_in?.session_hash===meta.session_hash);
  if(args.state?.length)list=list.filter(v=>args.state.includes(v.state));
  if(args.query){const parts=args.query.toLowerCase().split(/\s+/).filter(Boolean);list=list.filter(v=>parts.every(k=>JSON.stringify(v).toLowerCase().includes(k)));}
  list.sort((a,b)=>b.updated_at-a.updated_at||b.revision-a.revision);
  const limit=Math.min(20,args.limit||10);
  let offset=0,position=0;if(args.cursor){const m=/^([0-9]+):([0-9]+)$/.exec(args.cursor);if(!m)err('MATTER_CURSOR','分页标记无效');offset=Number(m[1]);position=Number(m[2]);if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(position))err('MATTER_CURSOR','分页标记无效');}
  const batch=list.slice(offset,offset+limit),items=batch.map(v=>{
   if(args.view==='history'||args.view==='detail'){const source=v.history.map(x=>({revision:x.revision,at:x.at,action:x.action,...x.data}));const full=args.view==='history'?source:[this.summary(v),{history:source}];const flat=JSON.stringify(full);const start=position,chunk=flat.slice(start,start+6000);return {id:v.id,revision:v.revision,view:args.view,chunk,chunk_offset:start,chunk_total:flat.length,chunk_cursor:start+6000<flat.length?offset+':'+(start+6000):null};}
   return this.summary(v);
  });
  return {items,total:list.length,next_cursor:offset+limit<list.length?(offset+limit)+':0':null,scope:args.scope||'all'};
 }
 prepareFinish(task,caller,updates,meta={}){
  if(!Array.isArray(updates)||updates.length>10)err('MATTER_INVALID','收尾事项超过10条');
  const explicit=updates.map(e=>validateMatterEntry(e,{finish:true})),explicitSig=hash([task.id,caller,explicit]);
  const old=this.pending.get(task.id);
  if(old){if(old.explicit_sig!==explicitSig)err('OP_CONFLICT','该任务已有不同的事项收尾内容');return old;}
  const changed=new Set(explicit.map(e=>e.id).filter(Boolean));
  const defaults=[...this.items.values()].filter(v=>!v.deleted&&v.task_id===task.id&&v.state==='waiting_ai'&&!changed.has(v.id))
   .map(v=>({operation_id:'end-'+task.id+'-'+v.id,action:'append',id:v.id,base_revision:v.revision,state:'deferred',waiting_for:endedWaitingFor(meta.reason)}));
  const list=[...explicit,...defaults],sig=hash([task.id,caller,list]);
  // Preflight every unsaved operation BEFORE a task may become terminal.
  for(const e of list){
   const digest=hash({...e,task_id:task.id}),same=this.operations.get(e.operation_id)||this.consumed.get(e.operation_id);
   if(same){if(same.digest!==digest)err('OP_CONFLICT','事项操作号内容不同');continue;}
   if(e.id&&this.purged.has(e.id))err('MATTER_PURGED','事项已永久删除');
   if(e.action==='append'){const cur=this.items.get(e.id);if(!cur)err('MATTER_MISSING','事项已不存在');if(cur.revision!==e.base_revision&&!finishCrossedOnlySoftDelete(cur,e))err('MATTER_REVISION_CONFLICT','事项版本已变化');}
   if(e.action==='create'&&!e.create_anyway&&this.similar(e).length)err('MATTER_SIMILAR','已有相似事项，先决定追加还是另建');
  }
  let reserve=this.sequence;const entries=list.map(e=>({entry:structuredClone(e),reservedId:e.action==='create'?idOf(++reserve):null}));
  const prepared={format:1,purge_ledger:1,task_id:task.id,owner_hash:hash(caller),receipt_owner_hash:meta.receipt_owner_hash||null,explicit_sig:explicitSig,sig,entries,at:this.now(),project_id:meta.project_id||null,session_hash:meta.session_hash||null};
  const file=path.join(this.pendingDir,task.id+'.json');atomic(file,prepared);this.pending.set(task.id,prepared);this.persistSequence(reserve);return prepared;
 }
 // R10: one entry of a finish intent. A scrubbed entry never reaches one(): its
 // content is gone, so only the ledger can say it had been applied. An intent
 // written before the ledger existed cannot prove a missing reserved id was
 // never created and then purged, so it may not create that id now.
 intentEntry(intent,entry,reservedId,meta){
  if(entry?.purged===true){const gone=this.consumed.get(entry.operation_id);return gone?{operation_id:entry.operation_id,id:gone.id,revision:gone.revision,state:null,saved:true,replayed:true,purged:true}:{operation_id:entry.operation_id,id:entry.id||reservedId||null,revision:null,saved:false,replayed:false,error_code:'MATTER_PURGED'};}
  if(intent.purge_ledger!==1&&entry.action==='create'&&reservedId&&!this.items.has(reservedId)&&!this.operations.has(entry.operation_id)&&!this.consumed.has(entry.operation_id))
   return {operation_id:entry.operation_id,id:reservedId,revision:null,saved:false,replayed:false,error_code:'MATTER_LEGACY_INTENT_UNPROVEN'};
  return this.one(entry,meta,{reservedId,finishFromTask:true});
 }
 async applyFinish(taskId,caller,meta={}){
  return this.serialize(()=>{const pending=this.pending.get(taskId);if(!pending)return {matters_saved:true,matters:[]};
   const matters=pending.entries.map(({entry,reservedId})=>{try{return this.intentEntry(pending,entry,reservedId,{...meta,task_id:taskId});}catch(e){return {operation_id:entry.operation_id,id:entry.id||reservedId,revision:this.items.get(entry.id||reservedId)?.revision||null,saved:false,replayed:false,error_code:e.code||'MATTER_ERROR'};}});
   return {matters_saved:matters.every(x=>x.saved===true),matters};
  });
 }
 async claim(task,ids,meta={}){return this.serialize(()=>{const claimFile=path.join(this.claimsDir,task.id+'.json'),fingerprint=hash([task.id,ids]),existing=fs.existsSync(claimFile)?JSON.parse(fs.readFileSync(claimFile,'utf8')):null;
  if(existing&&existing.fingerprint!==fingerprint)err('OP_CONFLICT','相同开工编号对应的事项集合已改变');
  if(!existing)atomic(claimFile,{task_id:task.id,fingerprint,ids:ids.slice(),at:this.now()});
  const matters=[];for(const id of ids){const operation_id='begin-'+task.id+'-'+id,previous=this.operations.get(operation_id);if(previous){matters.push({...previous.receipt,replayed:true});continue;}const gone=this.consumed.get(operation_id);if(gone){matters.push({operation_id,id:gone.id,revision:gone.revision,state:null,saved:true,replayed:true,purged:true});continue;}const current=this.items.get(id);if(!current||current.deleted){matters.push({operation_id,id,revision:current?.revision||null,saved:false,replayed:false,error_code:this.purged.has(id)?'MATTER_PURGED':'MATTER_MISSING'});continue;}
   const e={operation_id,action:'append',id,base_revision:current.revision,state:'waiting_ai',waiting_for:'AI 正在处理',task_id:task.id};
   try{matters.push(this.one(e,{...meta,task_id:task.id}));}catch(x){matters.push({operation_id:e.operation_id,id,revision:this.items.get(id)?.revision||null,saved:false,replayed:false,error_code:x.code||'MATTER_ERROR'});}}
  return {matters_saved:matters.every(v=>v.saved),matters};});}
 async endTask(taskId,caller,meta={}){
  return this.serialize(()=>{const results=[];
   for(const v of this.items.values())if(!v.deleted&&v.task_id===taskId&&v.state==='waiting_ai'){
    const e={operation_id:'end-'+taskId+'-'+v.id,action:'append',id:v.id,base_revision:v.revision,state:'deferred',waiting_for:endedWaitingFor(meta.reason)};
    try{results.push(this.one(e,{...meta,project_id:v.recorded_in?.project_id||null,session_hash:v.recorded_in?.session_hash||null}));}catch(x){results.push({id:v.id,revision:v.revision,saved:false,error_code:x.code||'MATTER_ERROR'});}
   }
   return results;
  });
 }
 async recoverOrphaned(isActive){
  const tasks=[...new Set([...this.items.values()].filter(v=>!v.deleted&&v.state==='waiting_ai'&&v.task_id&&!isActive(v.task_id)).map(v=>v.task_id))],results=[];
  for(const taskId of tasks){const owned=[...this.items.values()].find(v=>v.task_id===taskId&&v.state==='waiting_ai'&&!v.deleted);results.push(...await this.endTask(taskId,null,{project_id:owned?.recorded_in?.project_id||null,session_hash:owned?.recorded_in?.session_hash||null,reason:'startup_no_active_task'}));}
  return results;
 }
 // Repair only accepted data after finding an independent, genuine terminal task receipt.
 // Never resurrect a task, caller grant, checkpoint, or external action.
 async recoverFinished(readReceipt){
  return this.serialize(()=>{const results=[];
   for(const intent of this.pending.values()){
    let receipt=null;try{receipt=readReceipt(intent.task_id);}catch{}
    if(!receipt||receipt.format!==1||receipt.result?.execution_complete!==true||receipt.owner_hash!==intent.receipt_owner_hash)continue;
    const matters=intent.entries.map(({entry,reservedId})=>{try{
     const same=this.operations.get(entry.operation_id);if(same)return {...same.receipt,replayed:true};
     return this.intentEntry(intent,entry,reservedId,{task_id:intent.task_id,project_id:intent.project_id,session_hash:intent.session_hash});
    }catch(e){return {operation_id:entry.operation_id,saved:false,error_code:e.code||'MATTER_RECOVERY_FAILED'};}});
    results.push({task_id:intent.task_id,matters_saved:matters.every(x=>x.saved),items:matters.length});
   }
   return results;
  });
 }
 selection(ids){const set=[...new Set(ids)].filter(validId);if(!set.length||set.length>100)err('MATTER_SELECTION','请选择1至100条事项');const token='CS-'+crypto.randomBytes(12).toString('hex');this.selections.set(token,{ids:set,at:this.now()});return {selection_id:token,count:set.length};}
 resolveSelection(id){const value=this.selections.get(id);if(!value||this.now()-value.at>3600000)err('MATTER_SELECTION_EXPIRED','选择已失效，请重新选择');return value.ids.slice();}
 // R10 (Claude 1052 B2). Order inside one serialized step:
 // 1. ledger: purged ids + every operation they consumed (atomic; the commit point);
 // 2. finish intents: content of entries on those ids replaced by a stub;
 // 3. body files and damage backups removed.
 // A crash after 1 is finished by reload(); before 1 nothing changed.
 async purge({confirmed=false}={}){if(confirmed!==true)err('MATTER_CONFIRM_REQUIRED','清空最近删除须在本机窗口确认一次');return this.serialize(()=>{
  const victims=[...this.items.values()].filter(v=>v.deleted);if(!victims.length)return {purged:0};
  // Before the ledger commit, reject any unknown intent/content carrier and
  // unsafe body. A failed preflight does not alter the user's files.
  this.scanIntents();for(const v of victims)this.bodyFiles(v.id);
  const purged=new Map(this.purged),consumed=new Map(this.consumed),at=this.now();
  for(const v of victims){purged.set(v.id,{at,revision:v.revision});for(const line of v.history)consumed.set(line.operation_id,{digest:line.digest,id:v.id,revision:line.revision});}
  this.writeLedger(purged,consumed);
  this.scrubIntents();
  for(const v of victims){this.removeBodies(v.id);this.items.delete(v.id);for(const line of v.history)this.operations.delete(line.operation_id);}
  syncDir(this.dir);this.reload();
  return {purged:victims.length};});}
}
