/** Ten-minute/aggregate retention applies to in-memory output only.
 * Never delete jobs, renumber cursors or archive text. Journals use their own
 * session-long budget policy in CommandQueue. */
import {selectFailureLines} from './output-failure-ranges.mjs';
export const FINISHED_OUTPUT_BUDGET=200*1024*1024;
export const OUTPUT_RETENTION_AGE_MS=10*60*1000;
export const RETENTION_INTERVAL_MS=30000;
export const OUTPUT_TAIL_LINES=40;
export const OUTPUT_REDUCED_NOTICE='早期输出已缩减，仅保留失败段落和末尾输出';

export function outputBytes(job){
 return (job.events||[]).reduce((sum,event)=>sum+Buffer.byteLength(event.text||'','utf8'),0);
}

/** Sparse original event IDs describe both prefix loss and internal holes.
 * Partial events keep their original ID and disclose the intra-event loss.
 * End cursors remain exclusive; cursor=previous next_cursor never replays text.
 */
export function outputCursorCoverage(job,cursor=0){
 const end=job.next_cursor||0,gaps=[],partial=[];let next=cursor;
 for(const event of job.events||[]){
  if(event.cursor<cursor||event.cursor>=end)continue;
  if(event.cursor>next)gaps.push({from:next,to_exclusive:event.cursor});
  if(event.output_partial===true)partial.push(event.cursor);
  next=event.cursor+1;
 }
 if(next<end)gaps.push({from:next,to_exclusive:end});
 return {cursor_gap:gaps.length>0||partial.length>0,cursor_gaps:gaps,partial_event_cursors:partial};
}

/** No digest length gate and no independent stdout/stderr tail allowance.
 * Failure recognition/budget are shared with the presentation digest. The tail
 * is the final 40 observed lines across BOTH streams, including empty lines.
 */
export function reduceJobOutput(job,{now=Date.now(),reason='age'}={}){
 if(job.output_retention?.applied===true)return false;
 const original=job.events||[],rows=[];
 for(let eventIndex=0;eventIndex<original.length;eventIndex++){
  const event=original[eventIndex];
  for(const text of (event.text||'').match(/[^\n]*\n|[^\n]+$/g)||[])
   rows.push({eventIndex,text,line:text.endsWith('\n')?text.slice(0,-1):text});
 }
 const {indices,blocks}=selectFailureLines(rows.map(row=>row.line));
 const tailStart=Math.max(0,rows.length-OUTPUT_TAIL_LINES);
 for(let i=tailStart;i<rows.length;i++)indices.add(i);
 const parts=new Map();
 for(let i=0;i<rows.length;i++)if(indices.has(i)){
  const {eventIndex,text}=rows[i];
  if(!parts.has(eventIndex))parts.set(eventIndex,[]);
  parts.get(eventIndex).push(text);
 }
 const retained=[];
 for(let i=0;i<original.length;i++){
  const selected=parts.get(i);if(!selected)continue;
  const event=original[i],text=selected.join('');
  retained.push({...event,text,...(text!==event.text?{output_partial:true}:{})});
 }
 const before=outputBytes(job),after=retained.reduce((n,event)=>n+Buffer.byteLength(event.text,'utf8'),0);
 job.output_retention={version:1,applied:true,reduced:after<before,reason,compacted_at:now,
  original_bytes:before,retained_bytes:after,discarded_bytes:before-after,
  total_lines:rows.length,retained_lines:indices.size,tail_lines:rows.length-tailStart,
  failure_blocks:blocks,previously_truncated:job.truncated===true,
  original_base_cursor:job.base_cursor||0,original_next_cursor:job.next_cursor||0};
 job.events=retained;job.kept_bytes=after;
 job.base_cursor=retained[0]?.cursor??job.next_cursor;
 if(after<before)job.truncated=true;
 return true;
}

/** isSettled is supplied by the queue, which owns process/cleanup knowledge.
 * Thresholds are dependency-injected only in local tests, not tool parameters.
 */
export function maintainFinishedOutput(jobs,{isSettled,now=Date.now(),ageMs=OUTPUT_RETENTION_AGE_MS,budgetBytes=FINISHED_OUTPUT_BUDGET}={}){
 if(typeof isSettled!=='function'||!Number.isFinite(now)||!Number.isSafeInteger(ageMs)||ageMs<0||
    !Number.isSafeInteger(budgetBytes)||budgetBytes<0)throw new TypeError('OUTPUT_RETENTION_CONFIG_INVALID');
 const eligible=[...jobs].filter(isSettled).sort((a,b)=>{
  const endA=Number.isFinite(a.finished_at)?a.finished_at:Infinity;
  const endB=Number.isFinite(b.finished_at)?b.finished_at:Infinity;
  return endA-endB||(a.created_at||0)-(b.created_at||0)||String(a.id).localeCompare(String(b.id));
 });
 let total=eligible.reduce((n,job)=>n+outputBytes(job),0),processedNow=0;
 const apply=(job,reason)=>{
  const before=outputBytes(job);
  if(reduceJobOutput(job,{now,reason})){total+=outputBytes(job)-before;processedNow++;}
 };
 // Apply age independently, including when the memory budget is already met.
 for(const job of eligible)if(job.output_retention?.applied!==true&&
  Number.isFinite(job.finished_at)&&now-job.finished_at>ageMs)apply(job,'age');
 for(const job of eligible){
  if(total<=budgetBytes)break;
  if(job.output_retention?.applied!==true)apply(job,'budget');
 }
 return {budget_bytes:budgetBytes,retained_bytes:total,over_budget:total>budgetBytes,
  eligible_jobs:eligible.length,processed_jobs:eligible.filter(j=>j.output_retention?.applied===true).length,
  unprocessed_jobs:eligible.filter(j=>j.output_retention?.applied!==true).length,processed_now:processedNow,
  age_ms:ageMs,checked_at:now,scope:'settled_command_output_only',hard_process_memory_limit:false};
}
