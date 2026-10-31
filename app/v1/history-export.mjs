/** 1052-candidate source: metadata-only export of tasks that this authenticated
 * caller + connection session owns. Never read another caller's payload. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail,digest} from '../../engine/src/core.mjs';
import {ownedTaskHistory} from '../v06/changes.mjs';
import {readTaskActivity} from './activity-notes.mjs';

const SESSION=/^[a-f0-9]{64}$/, KIND=new Set(['all','tasks','activity','workload']);
const MAX_EXPORT_BYTES=64*1024*1024;
const dirName='chathand-exports';
const safeLabel=v=>typeof v==='string'&&/^[A-Za-z_]{1,60}$/.test(v)?v:'other';
const number=v=>Number.isFinite(v)&&v>=0?Number(v):0;
const safeWork=v=>v&&typeof v==='object'?Object.fromEntries(['work','legacy_work','io_in','io_out','calls'].filter(k=>Number.isFinite(v[k])&&v[k]>=0).map(k=>[k,number(v[k])])):{};
const isWithin=(child,root)=>child===root||child.startsWith(root+path.sep);

function safeExportDirectory(store){
 store.checkActive(true); // A report file is still a local write; export never overrides the write switch.
 const root=fs.realpathSync(store.root),rel=dirName;
 if(root!==store.root)fail('EXPORT_ROOT_CHANGED','当前工作区已改变。');
 const requested=path.join(root,rel);
 try{if(fs.lstatSync(requested).isSymbolicLink())fail('LINK_BLOCKED','报告目录不能是符号链接。');}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const directory=store.writable(rel,true);
 if(directory!==requested||!isWithin(directory,root))fail('EXPORT_SCOPE_REQUIRED','报告只能放在当前工作区的普通目录，不能跟随别名或链接。');
 let st;
 try{st=fs.lstatSync(directory);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(st&&(!st.isDirectory()||st.isSymbolicLink()))fail('LINK_BLOCKED','报告目录不能是符号链接或普通文件。');
 if(!st){fs.mkdirSync(directory,{mode:0o700});st=fs.lstatSync(directory);}
 const current=fs.lstatSync(directory);
 if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==st.dev||current.ino!==st.ino||
    fs.realpathSync(directory)!==directory)fail('LINK_BLOCKED','报告目录不是稳定的普通文件夹。');
 store.writable(rel); // Revalidate scope and protected paths after creation.
 return {directory,root,ino:current.ino,dev:current.dev};
}
function stillDirectory(store,d){
 const live=fs.lstatSync(d.directory);
 if(!live.isDirectory()||live.isSymbolicLink()||live.dev!==d.dev||live.ino!==d.ino||
   fs.realpathSync(d.directory)!==d.directory||store.root!==d.root)
   fail('EXPORT_PATH_CHANGED','报告目录或工作区在导出时发生变化。');
 store.writable(dirName);
}
function recordsOfActivity({policy,store,task,caller,session_hash}){
 const rows=[];let offset=0,issue=null;
 while(true){
  const page=readTaskActivity({policy,stateDir:store.stateDir,taskId:task.task_id,caller,sessionHash:session_hash,offset,limit:50});
  if(page.state==='missing')break;
  if(page.state!=='ok'){issue=page.code||page.state;break;}
  for(const item of page.items){
   // Activity narrative/reference are deliberately excluded: they may contain pasted credentials.
   rows.push({type:'activity',task_id:task.task_id,at:typeof item.at==='string'?item.at.slice(0,80):null,
     event:safeLabel(item.event),kind:safeLabel(item.kind)});
  }
  if(page.next_offset===null)break;
  if(!Number.isInteger(page.next_offset)||page.next_offset<=offset){issue='ACTIVITY_OFFSET_INVALID';break;}
  offset=page.next_offset;
 }
 return {rows,issue};
}
function selectTask(item){
 // Explicit stable metadata whitelist. No user content, command, job arguments, auth markers or paths.
 return {type:'task',task_id:item.task_id,
   status:safeLabel(item.status),created_at:number(item.created_at),
   finished_at:number(item.finished_at),terminal:item.terminal===true,
   archived:item.archived===true,job_count:Array.isArray(item.jobs)?item.jobs.length:0};
}
export class HistoryExporter{
 constructor({store,policy,getValueStats=()=>null}={}){
  if(!store||!policy)throw TypeError('Missing authenticated export dependencies');
  this.store=store;this.policy=policy;this.getValueStats=getValueStats;
 }
 export(args={},context={}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='kind'))
    fail('ARG_INVALID','受控导出只允许选择类型，不能提供其他身份、任务编号或文件路径。');
  const kind=args.kind||'all',caller=context.caller,session_hash=context.session_hash;
  if(!KIND.has(kind))fail('ARG_INVALID','导出类型无效。');
  if(typeof caller!=='string'||!caller||typeof session_hash!=='string'||!SESSION.test(session_hash))
    fail('EXPORT_SESSION_REQUIRED','无法验证当前连接与会话归属，不读取或导出历史记录。');
  this.policy.check();
  const epoch=this.policy.epoch,project_id=this.policy.state.data.active,root=this.store.root;
  const before=ownedTaskHistory(this.policy,caller,session_hash);
  const snapshot=before.snapshot;
  const tasks=before.items,rows=[],issues=[];
  const activeValue=this.getValueStats?.()?.snapshot?.(this.policy.state.data)?.active||{};
  for(const t of tasks){
   if(kind==='all'||kind==='tasks')rows.push(selectTask(t));
   if(kind==='all'||kind==='workload'){
    const value=t.value||activeValue[t.task_id];
    if(value&&typeof value==='object')rows.push({type:'workload',task_id:t.task_id,...safeWork(value)});
   }
   if(kind==='all'||kind==='activity'){
    const notes=recordsOfActivity({policy:this.policy,store:this.store,task:t,caller,session_hash});
    rows.push(...notes.rows);
    if(notes.issue)issues.push({task_id:t.task_id,code:safeLabel(notes.issue)});
   }
  }
  const after=ownedTaskHistory(this.policy,caller,session_hash);
  if(this.policy.epoch!==epoch||this.policy.state.data.active!==project_id||this.store.root!==root||
     snapshot!==after.snapshot||this.store.paused||!this.policy.enabled)
    fail('HISTORY_CHANGED','导出期间任务或权限变化，请重新导出。');
  const d=safeExportDirectory(this.store),id=crypto.randomUUID(),rel=dirName+'/history-'+id+'.jsonl';
  const final=this.store.writable(rel,true),temp=path.join(d.directory,'pending-'+id+'.tmp');
  let fd=null,created=false,bytes=0;
  try{
   stillDirectory(this.store,d);
   fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
   const append=line=>{const b=Buffer.from(JSON.stringify(line)+'\n');bytes+=b.length;if(bytes>MAX_EXPORT_BYTES)fail('EXPORT_TOO_LARGE','本机报告体积超限，未发布不完整文件。');fs.writeSync(fd,b);};
   append({format:1,kind,scope:'authenticated_caller_current_project_current_session',
     task_records:tasks.length,total_tasks:before.complete?tasks.length:null,
     at_least:tasks.length,source_complete:before.complete,issues:issues.length,generated_at:new Date().toISOString()});
   for(const row of rows)append(row);
   fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
   stillDirectory(this.store,d);
   if(fs.existsSync(final))fail('EXPORT_EXISTS','报告目标已存在，请使用新的导出编号。');
   fs.linkSync(temp,final);created=true;fs.unlinkSync(temp);
   const check=fs.lstatSync(final);
   if(!check.isFile()||check.isSymbolicLink()||check.nlink!==1||check.size!==bytes)fail('EXPORT_PATH_CHANGED','报告写入核验失败。');
   const dirfd=fs.openSync(d.directory,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
   stillDirectory(this.store,d);
   if(snapshot!==ownedTaskHistory(this.policy,caller,session_hash).snapshot||this.policy.epoch!==epoch)
      fail('HISTORY_CHANGED','导出期间源记录发生变化，不保留可能不完整的文件。');
   const hash=digest(fs.readFileSync(final));
   return {exported:true,kind,path:rel,bytes,sha256:hash,task_count:tasks.length,
     records:rows.length,total:before.complete?tasks.length:null,at_least:tasks.length,
     truncated:!before.complete||issues.length>0,incomplete:!before.complete||issues.length>0,
     unreadable_receipts:before.unreadable_count,unreadable_activity:issues.length,
     source_scope:'owned_session_only',contents_not_in_tool_result:true,can_resume_execution:false};
  }catch(e){if(created)try{fs.unlinkSync(final);}catch{}throw e;}
  finally{if(fd!==null)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(temp);}catch{}}
 }
}
