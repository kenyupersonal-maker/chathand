// 1025：撤销一个任务用 ChatHand 文件工具做的改动（体验三.3）。只由用户在 ChatHand 窗口里点，AI 调不到。
// 从后往前一步步退：改过的写回原样，新建的放进 ChatHand 回收区（能找回），挪过的挪回去，回收的拿回来。
// 每一步都核对文件现在还是这个任务留下的样子；之后又被改过的不动，照实告诉用户。命令改的文件没有记录，不在这里。
import fs from 'node:fs';
import {fail} from '../../engine/src/core.mjs';

const UNDO_PREFIX='undo_';
export const isUndoRecord=c=>typeof c?.operation_id==='string'&&c.operation_id.startsWith(UNDO_PREFIX);
const opId=(taskId,i)=>`${UNDO_PREFIX}${taskId.replace(/-/g,'').slice(0,16)}_${i}`;
function receiptOf(store,id){if(!id)return null;try{return JSON.parse(fs.readFileSync(store.operationFile(id),'utf8'));}catch{return null;}}

// 每一条改动打算怎么退。
export function planUndo(changes,store){
 const items=[];
 changes.forEach((c,i)=>{
  if(isUndoRecord(c)||!['applied','recycled'].includes(c.status))return;
  const r=receiptOf(store,c.receipt_id);
  // Older restore_trash change entries already contain the confirmed snapshot
  // hash, even though their operation result omitted receipt_id. This also
  // works for directories: trash rechecks the full current directory snapshot.
  if(c.tool==='restore_trash'&&c.path&&/^[a-f0-9]{64}$/.test(c.sha256||'')){
   items.push({i,kind:'remove',path:c.path,expected:c.sha256});return;
  }
  if(r?.after_sha256&&(c.tool==='write_text'||c.tool==='edit_file'||c.tool==='restore_file'||c.tool==='restore_trash'||c.tool==='write_file')){
   items.push(r.before?{i,kind:'revert',path:r.path,content:r.before.content,expected:r.after_sha256}:{i,kind:'remove',path:r.path,expected:r.after_sha256});return;
  }
  if(c.tool==='move_path'&&c.path&&c.destination&&c.sha256){items.push({i,kind:'move_back',path:c.destination,to:c.path,expected:c.sha256});return;}
  if(c.tool==='trash_path'&&c.trash_id){items.push({i,kind:'untrash',path:c.path,trash_id:c.trash_id});return;}
  items.push({i,kind:'skip',path:c.path||c.destination||'',reason:c.tool==='create_directory'?'新建的文件夹留着了':'这一步没有能退回的记录'});
 });
 return items.reverse();
}
export function undoSummary(items){
 const n=k=>items.filter(x=>x.kind===k).length;
 return {revert:n('revert'),remove:n('remove'),move_back:n('move_back'),untrash:n('untrash'),skip:n('skip'),total:items.filter(x=>x.kind!=='skip').length};
}

// 照计划退。返回每一条的结果；一条退不了不影响别的。
export function runUndo(taskId,items,store,record,perform=(tool,args,action)=>{const result=action();record?.(tool,args,result);return result;}){
 const done=[],skipped=[];
 for(const it of items){
  if(it.kind==='skip'){skipped.push({path:it.path,reason:it.reason});continue;}
  const id=opId(taskId,it.i);
  try{
   let action,tool;
   if(it.kind==='revert'){tool='restore_file';action=()=>store.write(it.path,it.content,it.expected,id);}
   else if(it.kind==='remove'){tool='trash_path';action=()=>store.trash(it.path,it.expected,id);}
   else if(it.kind==='move_back'){tool='move_path';action=()=>store.move(it.path,it.to,it.expected,id);}
   else if(it.kind==='untrash'){tool='restore_trash';action=()=>store.restoreTrash(it.trash_id,id);}
   perform(tool,it.kind==='move_back'?{from:it.path,to:it.to,operation_id:id}:{path:it.path,operation_id:id},action);
   done.push({path:it.kind==='move_back'?it.to:it.path,kind:it.kind});
  }catch(e){skipped.push({path:it.path,reason:e.code==='HASH_CONFLICT'||e.code==='WRITE_CONFLICT'?'之后又被改过，没动它':e.code==='ENOENT'?'文件已经不在了':e.code==='EEXIST'?'原来的位置已经有同名文件':'没退成：'+(e.message||e.code)});}
 }
 return {done,skipped};
}

// 服务端入口：核对任务、工作区，暂时放开暂停（这是用户自己在窗口里点的），做完恢复。
export function undoTask({taskId,policy,store,changes,dryRun=false}){
 const t=policy.get(taskId);
 if(['active','pending_approval'].includes(t.status))fail('TASK_BUSY','任务还在做，先停下再撤销。');
 if(t.project_id!==policy.state.data.active)fail('PROJECT_CHANGED','这个任务是在别的工作区做的，切回那个工作区再撤销。');
 const list=changes.readForUndo(taskId);
 if(list.some(isUndoRecord))fail('ALREADY_UNDONE','这个任务的改动已经撤销过了。');
 const items=planUndo(list,store),summary=undoSummary(items);
 if(dryRun)return {summary};
 if(!summary.total)fail('NOTHING_TO_UNDO','这个任务没有能撤销的文件改动。');
 const saved={paused:store.paused,writesEnabled:store.writesEnabled};
 store.paused=false;store.writesEnabled=true;
 try{const r=runUndo(taskId,items,store,null,(tool,args,action)=>changes.capture(taskId,tool,args,action));return {summary,...r};}
 finally{store.paused=saved.paused;store.writesEnabled=saved.writesEnabled;}
}
