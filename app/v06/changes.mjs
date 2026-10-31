import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {digest,saveJSON,fail,privateDir,hashConflict} from '../../engine/src/core.mjs';
import {ChangeLedger} from './change-ledger.mjs';
import {consumePreflightRefusal,preflightRefusalCheckpoint} from '../store.mjs';
const changeEntry=(name,args,result={})=>({tool:name,path:args.path||args.from||(name==='restore_trash'?result?.path:null)||null,destination:args.to||null,operation_id:args.operation_id||null,receipt_id:result?.receipt_id||null,sha256:result?.sha256||null,trash_id:result?.trash_id||null,...(result?.type?{type:result.type}:{}),time:Date.now(),status:result?.status||'applied'});
function artifactEntry({operation_id,directory,task_folder,files}){
 if(!/^[a-f0-9-]{36}$/i.test(operation_id)||!Array.isArray(files)||files.length>500)fail('ARTIFACT_RECEIPT_INVALID','成果记录无效。');
 const image=value=>{if(!value)return {};if(!Number.isSafeInteger(value.width)||value.width<1||!Number.isSafeInteger(value.height)||value.height<1||typeof value.mime_type!=='string'||value.mime_type.length>200||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/i.test(value.mime_type))fail('ARTIFACT_RECEIPT_INVALID','成果记录无效。');return {image:{width:value.width,height:value.height,mime_type:value.mime_type}};};
 return {tool:'save_files',path:directory,directory,...(task_folder?{task_folder}:{}),operation_id,status:'applied',time:Date.now(),files:files.map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256,...image(f.image)}))};
}
export function editFile(store,o){
  store.checkActive(true);
  if(!o.old_text||typeof o.new_text!=='string'||Buffer.byteLength(o.old_text+o.new_text)>128*1024)fail('EDIT_INVALID','提供唯一匹配的原文和替换文本，合计不超过 128 KiB。');
  const target=store.writable(o.path),receiptFile=store.operationFile(o.operation_id);
  const fingerprint=digest(JSON.stringify(['edit_file',store.root,o.path,o.old_text,o.new_text,o.expected_sha256]));
  if(fs.existsSync(receiptFile)){
    const receipt=JSON.parse(fs.readFileSync(receiptFile));
    if(receipt.fingerprint!==fingerprint)fail('OP_CONFLICT','此操作编号已用于其他内容。');
    if(receipt.status!=='applied')fail('OP_INCOMPLETE','前次修改结果尚未核实。');
    return {...receipt.result,replayed:true};
  }
  const before=store.bytes(o.path);if(before.sha256!==o.expected_sha256)hashConflict(store,o.path,before.sha256,o.expected_sha256);
  const at=before.content.indexOf(o.old_text);
  if(at<0||before.content.indexOf(o.old_text,at+1)!==-1)fail('EDIT_MATCH_NOT_UNIQUE','原文必须恰好匹配一处。请补充上下文。');
  const after=before.content.slice(0,at)+o.new_text+before.content.slice(at+o.old_text.length);
  if(Buffer.byteLength(after)>8*1024*1024||after.includes('\0'))fail('CONTENT_INVALID','编辑结果超过 8 MiB 或包含二进制数据。');
  const receipt={version:1,id:o.operation_id,root:store.root,path:o.path,fingerprint,status:'prepared',created_at:new Date().toISOString(),before:{content:before.content,sha256:before.sha256,mode:before.mode},after_sha256:digest(after)};
  saveJSON(receiptFile,receipt);
  const temp=path.join(path.dirname(target),'.ken-edit-'+crypto.randomUUID());
  try{
    const fd=fs.openSync(temp,'wx',before.mode);try{fs.writeFileSync(fd,after);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const current=store.bytes(o.path).sha256;if(store.writable(o.path)!==target||current!==before.sha256)hashConflict(store,o.path,current,o.expected_sha256);
    fs.renameSync(temp,target);receipt.status='applied';receipt.result={path:o.path,sha256:receipt.after_sha256,receipt_id:o.operation_id,created:false};saveJSON(receiptFile,receipt);
    store.audit({event:'edit_file',path:o.path,operation_id:o.operation_id});return receipt.result;
  }finally{try{fs.unlinkSync(temp);}catch{}}
}
export class Changes {
  constructor(store,policy){this.store=store;this.policy=policy;this.dir=path.join(store.stateDir,'task-changes');privateDir(this.dir);this.ledger=new ChangeLedger(this.dir);}
  file(id){if(!/^[a-f0-9-]{36}$/i.test(id))fail('TASK_MISSING','任务编号无效。');return path.join(this.dir,id+'.json');}
  read(id,caller){this.policy.get(id,caller);this.file(id);return this.ledger.read(id);}
  readForUndo(id){this.policy.get(id);this.file(id);return this.ledger.read(id,{undo:true});}
  prepare(id,name,args){
    this.policy.get(id);this.file(id);this.store.operationFile(args.operation_id);
    // Result metadata is bounded, including restore_trash's receipt-derived path.
    return this.ledger.prepare(id,args.operation_id,changeEntry(name,args,{path:'x'.repeat(4096),receipt_id:args.operation_id,sha256:'f'.repeat(64),trash_id:'f'.repeat(36),type:'directory'}));
  }
  capture(id,name,args,action){
    const fresh=this.prepare(id,name,args),checkpoint=preflightRefusalCheckpoint();
    try{const result=action();if(result?.status!=='pending_approval')this.record(id,name,args,result);return result;}
    catch(e){
      // Clear only our new intent, with a current-call proof that the mutation
      // callback was never entered, or no receipt was prepared at all.
      if(fresh&&(consumePreflightRefusal(e,this.store,args.operation_id,checkpoint)||!fs.existsSync(this.store.operationFile(args.operation_id))))this.ledger.cancel(id,args.operation_id);
      throw e;
    }
  }
  record(id,name,args,result){
    this.policy.get(id);this.file(id);this.ledger.append(id,changeEntry(name,args,result));
    this.store.runtimeChanges??=new Map();for(const rel of [args.path,args.from,args.to].filter(Boolean))this.store.runtimeChanges.set(path.resolve(this.store.root,rel),{task_id:id,time:Date.now()});
  }
  prepareArtifacts(id,receipt){
    this.policy.get(id);this.file(id);
    // Thumbnails may add bounded image metadata after the native commit.
    const reserved={...receipt,files:receipt.files.map(f=>({...f,image:{width:Number.MAX_SAFE_INTEGER,height:Number.MAX_SAFE_INTEGER,mime_type:'x/'+'x'.repeat(198)}}))};
    const fresh=this.ledger.prepare(id,receipt.operation_id,artifactEntry(reserved));
    // Only the caller which added this intent may cancel it, before commit.
    return fresh?()=>this.ledger.cancel(id,receipt.operation_id):null;
  }
  recordArtifacts(id,{operation_id,directory,task_folder,files}){
    this.policy.get(id);this.file(id);this.ledger.append(id,artifactEntry({operation_id,directory,task_folder,files}));this.store.runtimeChanges??=new Map();for(const f of files)this.store.runtimeChanges.set(path.resolve(this.store.root,f.path),{task_id:id,time:Date.now()});
  }
  preview(id,operationId,caller){
    const list=this.read(id,caller),entry=list.find(x=>x.operation_id===operationId);
    if(!entry)fail('CHANGE_NOT_FOUND','没有这次操作的变更记录；失败的操作不会记成已修改。');
    if(!entry.receipt_id||!['edit_file','write_text','restore_file'].includes(entry.tool))fail('PREVIEW_UNAVAILABLE','此操作不是文字修改，没有文本变更备份。');
    const task=this.policy.get(id,caller);if(task.project_id!==this.policy.state.data.active)fail('PROJECT_CHANGED','请切换到原工作区查看变更。');
    const receipt=JSON.parse(fs.readFileSync(this.store.operationFile(entry.receipt_id)));
    const target=this.store.resolve(entry.path);void target;
    const current=this.store.bytes(entry.path);const before=receipt.before?.content||'';
    return {path:entry.path,before:before.split('\n').slice(0,300).join('\n'),after:current.content.split('\n').slice(0,300).join('\n'),preview_line_limit:300,current_differs_from_receipt:current.sha256!==receipt.after_sha256};
  }
}
// Full current-project enumeration: never truncate receipt discovery before paginating.
// The server authenticates the request; conversation ownership is not a task boundary.
export function ownedTaskHistory(policy,caller,session_hash){
  if(typeof caller!=='string'||!caller||typeof session_hash!=='string'||!/^[a-f0-9]{64}$/.test(session_hash))
    fail('HISTORY_SESSION_REQUIRED','没有当前连接的可信会话归属，不能读取任务历史。');
  const project=policy.state.data.active, map=new Map(),skipped=[];
  for(const task of policy.tasks.values())if(task.project_id===project&&task.root===policy.store.root)
    map.set(task.id,policy.view(task));
  let files=[];
  try{files=fs.readdirSync(policy.receipts.dir).filter(f=>/^[a-f0-9-]{36}\.json$/i.test(f)).sort();}
  catch(e){if(e.code!=='ENOENT')fail('HISTORY_READ_FAILED','无法读取完整的任务索引；请不要把部分结果当作全量。');}
  for(const file of files){try{
    const receipt=policy.receipts.read(file.slice(0,-5),caller);
    const t=receipt?.result;
    if(t&&t.project_id===project&&t.root===policy.store.root&&!map.has(t.task_id))
      map.set(t.task_id,{...t,archived:true});
  }catch(e){if(e.code!=='TASK_OWNER')skipped.push(e.code||'HISTORY_UNREADABLE');}}
  const items=[...map.values()].sort((a,b)=>(b.finished_at||b.created_at||0)-(a.finished_at||a.created_at||0)||String(a.task_id).localeCompare(String(b.task_id)));
  const snapshot=digest(JSON.stringify([caller,session_hash,project,policy.epoch,items.map(t=>[t.task_id,t.status,t.created_at,t.finished_at,t.summary,t.jobs?.length])]));
  return {items,snapshot,complete:skipped.length===0,unreadable_count:skipped.length,project_id:project,source_receipt_entries:files.length};
}
export function taskHistory(policy,caller,options={},session_hash){
  if(typeof options==='number')options={limit:options};
  const {items,snapshot,complete,unreadable_count,source_receipt_entries}=ownedTaskHistory(policy,caller,session_hash);
  const limit=options.limit??20,cursor=options.cursor??null;
  let offset=options.offset??0;
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)
    fail('ARG_INVALID','任务历史分页范围无效。');
  if(cursor!==null){const m=typeof cursor==='string'&&/^v1:(\d+):([a-f0-9]{64})$/.exec(cursor);
    if(!m||Number(m[1])!==offset||m[2]!==snapshot)fail('HISTORY_CHANGED','历史记录或分页上下文已有变化，请从第一页重新查询。');
  }else if(offset!==0)fail('HISTORY_CURSOR_REQUIRED','翻页必须带上一页返回的 cursor，避免重复或漏记录。');
  const page=items.slice(offset,offset+limit),next_offset=offset+page.length<items.length?offset+page.length:null;
  return {tasks:options.detail===true?page:page.map(t=>({task_id:t.task_id,title:t.title,status:t.status,created_at:t.created_at,finished_at:t.finished_at,summary:t.summary||''})),offset,limit,total:complete?items.length:null,at_least:items.length,total_exact:complete,
    truncated:next_offset!==null||!complete,next_offset,next_cursor:next_offset===null?null:'v1:'+next_offset+':'+snapshot,
    incomplete:!complete,unreadable_count,source_receipt_entries,order:'terminal_or_creation_desc_then_task_id',
    ...(complete?{}:{note:'有记录无法安全读取，total未知；已显示的结果不是全部。'})};
}
// A local owner UI read-only projection, called only after /api/state bearer auth.
// It does not fake MCP caller/session ownership or remove ownedTaskHistory checks.
export function localUiTaskHistory(policy,{limit=100,offset=0}={}){
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)
  fail('ARG_INVALID','本机历史分页参数无效。');
 const project=policy.state.data.active,map=new Map(),unreadable=[];
 for(const t of policy.tasks.values())if(t.project_id===project)
  map.set(t.id,policy.view(t));
 let files=[];
 try{files=fs.readdirSync(policy.receipts.dir).filter(x=>/^[a-f0-9-]{36}\.json$/i.test(x)).sort();}
 catch(e){if(e.code!=='ENOENT')fail('HISTORY_READ_FAILED','本机历史索引无法完整读取。');}
 for(const file of files)try{
  const receipt=policy.receipts.read(file.slice(0,-5)),task=receipt?.result;
  if(task?.project_id===project&&typeof task.task_id==='string'&&!map.has(task.task_id))
   map.set(task.task_id,{...task,archived:true});
 }catch(e){unreadable.push(e.code||'HISTORY_UNREADABLE');}
 const all=[...map.values()].sort((a,b)=>
  (b.finished_at||b.created_at||0)-(a.finished_at||a.created_at||0)||
  String(a.task_id).localeCompare(String(b.task_id)));
 const tasks=all.slice(offset,offset+limit),complete=unreadable.length===0;
 return {tasks,offset,limit,total:complete?all.length:null,at_least:all.length,
  total_exact:complete,truncated:offset+tasks.length<all.length||!complete,
  next_offset:offset+tasks.length<all.length?offset+tasks.length:null,
  incomplete:!complete,unreadable_count:unreadable.length,
  source_receipt_entries:files.length,project_id:project,
  source:'authenticated_local_ui',read_only:true};
}

