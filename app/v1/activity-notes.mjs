/** 1049: 只读兼容旧活动串，不重写历史原文，也不用于内容统计。 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES=2*1024*1024;

// 旧版把两条 JSON 之间的换行写成了字面 \\n。
// 只在 JSON 对象外识别分隔符；正文字符串内的 \\n 和真实换行转义必须保持原样。
export function parseActivityNotes(source){
 if(typeof source!=='string')throw new TypeError('活动记录必须是文本');
 const result=[];let i=0;
 while(i<source.length){
  while(i<source.length){
   if(/\s/.test(source[i])){i++;continue;}
   if(source[i]==='\\'&&source[i+1]==='n'){i+=2;continue;}
   break;
  }
  if(i===source.length)break;
  if(source[i]!=='{')throw new SyntaxError('活动记录分隔或开头无效');
  const start=i;let depth=0,quoted=false,escape=false,ended=false;
  for(;i<source.length;i++){
   const ch=source[i];
   if(quoted){
    if(escape)escape=false;
    else if(ch==='\\')escape=true;
    else if(ch==='"')quoted=false;
   }else if(ch==='"')quoted=true;
   else if(ch==='{')depth++;
   else if(ch==='}'){
    depth--;
    if(depth===0){i++;result.push(JSON.parse(source.slice(start,i)));ended=true;break;}
   }
  }
  if(!ended)throw new SyntaxError('活动记录末尾不完整');
 }
 return result;
}

export function appendActivityNote(file,note){
 fs.appendFileSync(file,JSON.stringify(note)+'\n',{mode:0o600});
}

export function readActivityNotes(file){
 const original=fs.lstatSync(file);
 if(!original.isFile()||original.isSymbolicLink()||original.nlink!==1)throw activityError('ACTIVITY_LOG_UNSAFE','活动记录文件类型不安全');
 if(original.size>MAX_LOG_BYTES)throw activityError('ACTIVITY_LOG_TOO_LARGE','活动记录超过只读解析上限');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{
  const current=fs.fstatSync(fd);
  if(!current.isFile()||current.nlink!==1||current.dev!==original.dev||current.ino!==original.ino)
   throw activityError('ACTIVITY_LOG_UNSAFE','活动记录在读取前发生变化');
  const bytes=fs.readFileSync(fd);
  if(bytes.length!==original.size||fs.fstatSync(fd).size!==original.size)
   throw activityError('ACTIVITY_LOG_CHANGED','活动记录读取期间发生变化');
  let source;
  try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{throw activityError('ACTIVITY_LOG_ENCODING','活动记录不是有效的 UTF-8');}
  return parseActivityNotes(source);
 }finally{fs.closeSync(fd);}
}

const TASK_UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function activityError(code,message){return Object.assign(new Error(message),{code});}
function readFailure(error){
 if(error?.code==='ENOENT')return {state:'missing',items:[],total:0,next_offset:null};
 if(error?.code==='ACTIVITY_LOG_UNSAFE'||error?.code==='ELOOP')return {state:'unreadable',code:'ACTIVITY_LOG_UNSAFE',message:'活动记录不是安全的普通文件，原文件保持不变',items:[],next_offset:null};
 if(error?.code==='ACTIVITY_LOG_TOO_LARGE')return {state:'too_large',code:'ACTIVITY_LOG_TOO_LARGE',message:'活动记录超过只读解析上限，原文件保持不变',items:[],next_offset:null};
 if(error?.code==='ACTIVITY_LOG_CHANGED')return {state:'changed',code:'ACTIVITY_LOG_CHANGED',message:'活动记录读取期间发生变化，未写回原文件',items:[],next_offset:null};
 if(error?.code==='ACTIVITY_LOG_ENCODING')return {state:'corrupt',code:'ACTIVITY_LOG_ENCODING',message:'活动记录编码损坏，原文件保持不变',items:[],next_offset:null};
 if(error instanceof SyntaxError&&error.message==='活动记录末尾不完整')
  return {state:'truncated',code:'ACTIVITY_LOG_TRUNCATED',message:'活动记录末尾不完整，原文件保持不变',items:[],next_offset:null};
 if(error instanceof SyntaxError)return {state:'corrupt',code:'ACTIVITY_LOG_CORRUPT',message:'活动记录格式损坏，原文件保持不变',items:[],next_offset:null};
 return {state:'unreadable',code:'ACTIVITY_LOG_UNREADABLE',message:'活动记录无法安全读取，原文件保持不变',items:[],next_offset:null};
}
function publicNote(note){
 if(!note||typeof note!=='object'||Array.isArray(note)||typeof note.event!=='string'||typeof note.summary!=='string'||
   note.event.length>60||note.summary.length>500||
   (note.kind!==undefined&&(typeof note.kind!=='string'||note.kind.length>40))||
   (note.reference!==null&&note.reference!==undefined&&(typeof note.reference!=='string'||note.reference.length>500))||
   (note.at!==undefined&&(typeof note.at!=='string'||note.at.length>80)))return null;
 // Explicit whitelist: never forward unrecognized JSON fields or widget/private metadata.
 return {event:note.event,kind:note.kind??'activity',summary:note.summary,reference:note.reference??null,at:note.at??null};
}

/**
 * Product read path used by task_status(include_activity:true).
 * The current authenticated project and workspace must match before any
 * file stat/open. Task IDs can be continued across conversations.
 * This never rewrites legacy records, even if malformed or truncated.
 */
export function readTaskActivity({policy,stateDir,taskId,caller,sessionHash,offset=0,limit=20}={}){
 if(typeof taskId!=='string'||!TASK_UUID.test(taskId))throw activityError('TASK_MISSING','任务编号无效');
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)
  throw activityError('ARG_INVALID','活动记录读取范围无效');
 const task=policy.get(taskId,caller);
 if(task.project_id!==policy.state.data.active||task.root!==policy.store.root)
  return {state:'restricted',code:'ACTIVITY_SCOPE_MISMATCH',message:'任务与当前项目或文件范围不匹配，不能读取活动记录',items:[],next_offset:null};
 const file=path.join(stateDir,'activity-records',taskId+'.jsonl');
 let records;
 try{records=readActivityNotes(file);}catch(error){return readFailure(error);}
 const notes=records.map(publicNote);
 if(notes.some(note=>note===null))
  return {state:'corrupt',code:'ACTIVITY_LOG_CORRUPT',message:'活动记录字段损坏，原文件保持不变',items:[],next_offset:null};
 const page=notes.slice(offset,offset+limit);
 return {state:'ok',total:notes.length,offset,items:page,next_offset:offset+page.length<notes.length?offset+page.length:null};
}
