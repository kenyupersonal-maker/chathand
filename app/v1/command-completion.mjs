const FINISHED=new Set(['completed','failed','cancelled','timed_out','output_limit','rejected','expired']);
const STOPPED=new Set(['cancelled','timed_out','rejected','expired','output_limit']);
const SIGNAL_CODE={SIGINT:130,SIGKILL:137,SIGTERM:143};
const EXIT_WORDS={0:'正常结束',1:'执行出错',2:'用法错误',126:'无运行权限',127:'未找到命令',130:'已中断',137:'已强制结束',143:'已停止'};
export function commandFinished(job){return !!job&&FINISHED.has(job.status)&&Number.isFinite(job.finished_at)&&!job.process_alive&&!job.cleanup_pending;}
export function commandEndWords(job){
 if(STOPPED.has(job.status))return '已停止';
 const code=job.exit_code??SIGNAL_CODE[job.signal];
 if(code===0&&job.status==='completed')return '正常结束';
 return `${EXIT_WORDS[code]||'执行出错'}（退出码 ${Number.isInteger(code)?code:'未知'}）`;
}
function durationWords(ms){const seconds=Math.max(0,Math.round(ms/1000));if(seconds<60)return seconds+' 秒';if(seconds<3600)return Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';return Math.floor(seconds/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分';}

// Memory only. Queue data is consulted after the next tool returns; no polling loop,
// no tool invocation, and no output or raw openai/session is kept here.
export class CommandCompletionNotes {
 constructor({readJob,maxEntries=1000}={}){this.readJob=readJob;this.maxEntries=maxEntries;this.entries=new Map();}
 job(id,caller,hash){try{return this.readJob(id,caller,hash);}catch{return null;}}
 collect(hash,caller,name,args={},result=null,{failed=false}={}){
  if(!hash||!caller)return null;
  let justRunning=null;
  if(!failed){
   if(['propose_command','command_result'].includes(name)&&result?.status==='running'&&typeof result.job_id==='string'){
    const id=result.job_id,job=this.job(id,caller,hash);justRunning=id;
    if(job&&!this.entries.has(id)){
     this.entries.set(id,{hash,caller,task_id:job.task_id,handled:false});
     if(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    }
   }
   // Only results actually returned to this conversation suppress its reminder.
   const shown=name==='command_result'||name==='cancel_command'?result:name==='operation_status'?result?.result:null;
   if(shown?.job_id&&commandFinished(shown)){const entry=this.entries.get(shown.job_id);if(entry?.hash===hash&&entry.caller===caller)entry.handled=true;}
   if(name==='task_status'&&result?.task_id){
    for(const [id,entry] of this.entries){
     if(entry.hash!==hash||entry.caller!==caller||entry.task_id!==result.task_id)continue;
     const visible=(result.jobs||[]).find?.(j=>j&&typeof j==='object'&&j.job_id===id);
     const terminal=result.terminal===true||result.execution_complete===true;
     if(commandFinished(visible)||terminal&&(result.jobs||[]).includes(id)&&commandFinished(this.job(id,caller,hash)))entry.handled=true;
    }
   }
  }
  const jobs=[];
  for(const [id,entry] of this.entries){
   if(id===justRunning||entry.handled||entry.hash!==hash||entry.caller!==caller)continue;
   const job=this.job(id,caller,hash);if(!commandFinished(job))continue;
   const start=Number.isFinite(job.started_at)?job.started_at:job.finished_at,duration_ms=Math.max(0,job.finished_at-start);
   jobs.push({job_id:id,task_id:entry.task_id,status:job.status,exit_code:job.exit_code??null,signal:job.signal??null,finished_at:job.finished_at,duration_ms,outcome:commandEndWords(job)});
   entry.handled=true;
  }
  if(!jobs.length)return null;
  return {kind:'command_finished',jobs,zh:jobs.map(j=>`命令 ${j.job_id} 已结束：${j.outcome}，用了 ${durationWords(j.duration_ms)}。用 command_result 看输出。`).join('\n'),en:jobs.map(j=>`Command ${j.job_id} finished (${j.status}, exit ${j.exit_code??'unknown'}) in ${Math.round(j.duration_ms/1000)} s. Use command_result to read its output.`).join('\n')};
 }
}
