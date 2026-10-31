export const jobRunning=j=>!!j&&(j.status==='running'||j.status==='pending_approval'||j.process_alive===true||!!j.child||j.cleanup_pending===true||j.cleanupPending===true);
export const jobRunMs=(j,now=Date.now())=>j?.started_at?Math.max(0,(j.finished_at||now)-j.started_at):0;
export function briefJob(j,now=Date.now()){
 const text=[j.stdout||'',j.stderr||''].filter(Boolean).join('\n').trimEnd().split('\n').slice(-3).join('\n').slice(-300);
 return {job_id:j.job_id,status:j.status,exit_code:j.exit_code??null,run_ms:jobRunMs(j,now),last_lines:text?text.split('\n'):[],next_cursor:j.next_cursor,...(!jobRunning(j)?{note:'命令结束了，不带 brief 再调一次看结果。'}:{})};
}
