/** 1049: three evidence-based waiting states for active task cards. */
export function taskWaitState({task,jobs=[],confirmations=[],checkpoint=null,artifactBusy=false,inputs=[]}={}){
 if(!task||!['active','pending_approval'].includes(task.status))return null;
 const own=new Set(task.jobs||[]);
 const taskJobs=jobs.filter(j=>own.has(j.job_id));
 const pendingConfirm=confirmations.some(c=>['waiting','applying','pending_approval'].includes(c.state));
 const pendingInput=inputs.some(i=>own.has(i.job_id)&&i.status==='pending_approval');
 if(task.status==='pending_approval'||pendingConfirm||pendingInput||taskJobs.some(j=>j.status==='pending_approval'))
  return {kind:'external',label:'等外部条件',detail:'需要外部确认或输入'};
 if(checkpoint?.last_checkpoint?.waiting_user===true&&checkpoint?.waiting_user_active!==false||checkpoint?.blocker)
  return {kind:'external',label:'等外部条件',detail:'已明确停在等待用户或外部条件'};
 if(taskJobs.some(j=>j.status==='running'||j.process_alive===true||j.cleanup_pending===true||j.cleanupPending===true))
  return {kind:'command',label:'命令在跑',detail:'本机命令尚未结束'};
 if(artifactBusy)return {kind:'external',label:'等外部条件',detail:'文件接收或下载条件尚未完成'};
 return {kind:'ai',label:'等 AI 下一步',detail:'任务仍在进行，未观察到运行中的命令或待确认条件'};
}
