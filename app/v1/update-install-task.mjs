import crypto from 'node:crypto';
import {TaskReceipts} from '../task-receipts.mjs';

/** Installation progress outlives a process; it never carries an execution grant. */
export function installationTask({build,caller,sourceTask=null,session_hash=null,now=Date.now()}) {
 return {caller,view:{task_id:crypto.randomUUID(),title:`安装 ChatHand 构建 ${build}`,status:'installing',created_at:now,project_id:sourceTask?.project_id??null,root:sourceTask?.root??null,conversation_id:sourceTask?.conversation_id??null,conversation_title:sourceTask?.conversation_title??null,session_hash,request_id:'install_'+crypto.randomUUID(),jobs:[],terminal:false,execution_complete:false,source:'chathand_auto',source_kind:'install_update'},connection_principal:sourceTask?.connection_principal??null};
}
export function finishInstallationTask(stateDir,task,{success,build,version=null,reason=null,now=Date.now()}) {
 if(!task?.view||typeof task.caller!=='string'||!Number.isSafeInteger(build))throw Error('UPDATE_TASK_INVALID');
 const receipts=new TaskReceipts(stateDir),old=receipts.read(task.view.task_id,task.caller);
 if(old)return {...old.result,replayed:true}; // Never replace a historical terminal result.
 const result={...task.view,status:success?'completed':'failed',terminal:true,execution_complete:true,finished_at:now,receipt_id:task.view.task_id,success,installed:success?{version,build}:null,...(!success&&reason?{failure_reason:String(reason).slice(0,300)}:{}),summary:success?`已安装并核验构建 ${build}`:`构建 ${build} 安装未通过核验`,user_action:success?'':'请查看 ChatHand 窗口里的安装结果。',intermediate_errors:0,replayed:false,next_action:'report_once_then_stop',retry:{create_new_task:false,poll_automatically:false,max_status_checks_per_turn:0}};
 receipts.save(task.view.task_id,task.caller,success,result,task.connection_principal);
 return result;
}
