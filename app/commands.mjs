import {CommandQueue} from '../engine/src/commands.mjs';
import {fail} from '../engine/src/core.mjs';

export function inputAvailability(j) {
 if(j.status==='timed_out')return {code:'STDIN_PROCESS_TIMED_OUT',message:'命令已超时退出。请查看原命令结果。'};
 if(['completed','failed'].includes(j.status)||j.finished_at)return {code:'STDIN_PROCESS_EXITED',message:'命令已结束，输入未发送。请查看退出码。'};
 if(['cancelled','rejected','expired','output_limit'].includes(j.status))return {code:'STDIN_PROCESS_STOPPED',message:'命令已停止，输入未发送。'};
 if(j.stdin_mode!=='pipe')return {code:'STDIN_NOT_PIPED',message:'此命令没有开启输入通道。'};
 if(j.status!=='running')return {code:'STDIN_NOT_RUNNING',message:'命令尚未运行，请查看原任务状态。'};
 if(j.child?.stdin?.writableEnded)return {code:'STDIN_ALREADY_CLOSED',message:'输入通道已结束，请查看原命令结果。'};
 if(!j.child?.stdin||j.child.stdin.destroyed||j.child.stdin.writable===false)return {code:'STDIN_UNAVAILABLE',message:'进程输入通道不可写，请查看原命令结果。'};
 return {code:'STDIN_WRITABLE',message:'可以发送输入。'};
}
export class DesktopCommandQueue extends CommandQueue {
 // Legacy/direct callers also expose bridge_info. Do not claim the derived
 // SandboxQueue's isolation or PTY support for this plain process backend.
 status(){const available=true;return {enabled:this.enabled&&available,available,node_path:process.execPath,stdin:'pipe',pty:false,backend:'local-process',approval:'local_confirmation',not_os_sandbox:true};}
 publicJob(job,options){return {...super.publicJob(job,options),input_state:inputAvailability(job).code,warning:'终端使用当前系统账户权限。工作区是命令起始目录。'};}
 remapInput(error,id){if(error.code!=='STDIN_CLOSED')throw error;const detail=inputAvailability(this.get(id));fail(detail.code==='STDIN_WRITABLE'?'STDIN_UNAVAILABLE':detail.code,detail.message);}
 proposeInput(spec){
  // Preserve the engine's duplicate-input receipt before checking current process state.
  try{return super.proposeInput(spec);}catch(e){return this.remapInput(e,spec.job_id);}
 }
 approveInput(id){try{return super.approveInput(id);}catch(e){return this.remapInput(e,this.inputs.get(id)?.job_id);}}
}
