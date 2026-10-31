import {selectFailureLines} from '../../engine/src/output-failure-ranges.mjs';
import {OUTPUT_REDUCED_NOTICE} from '../../engine/src/command-output-retention.mjs';
const LIMIT_CHARS=6000,LIMIT_LINES=120,TAIL_LINES=40;
const OMIT=(n,available,memoryComplete)=>`…（中间省略 ${n} 行；${available?'要全文用 command_result 带 full:true':memoryComplete?'普通输出仍完整，用 cursor 分页；不要重跑命令':'早期输出已丢失，不要为补输出重跑命令'}）…`;
const lineCount=text=>{if(typeof text!=='string'||!text)return 0;const a=text.split('\n');if(a.at(-1)==='')a.pop();return a.length;};
const split=text=>{if(typeof text!=='string'||!text)return {lines:[],trailing:false};const trailing=text.endsWith('\n'),lines=text.split('\n');if(trailing)lines.pop();return {lines,trailing};};
const statLine=line=>/^\s*(?:#|ℹ)\s+(?:tests|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(line);

function excerpt(text,budget,available,memoryComplete){
 if(typeof text!=='string'||!text)return {text:text??'',kept:0,blocks:0};
 const {lines,trailing}=split(text),tailStart=Math.max(0,lines.length-TAIL_LINES);
 const {indices:prefix,blocks}=selectFailureLines(lines,budget);
 for(let i=0;i<tailStart;i++)if(statLine(lines[i]))prefix.add(i);
 const prefixIdx=[...prefix].filter(i=>i<tailStart).sort((a,b)=>a-b),tailIdx=[];
 for(let i=tailStart;i<lines.length;i++)tailIdx.push(i);
 const kept=new Set([...prefixIdx,...tailIdx]),omitted=Math.max(0,lines.length-kept.size),out=[];
 for(const i of prefixIdx)out.push(lines[i]);
 if(omitted)out.push(OMIT(omitted,available,memoryComplete));
 // Failure lines in the tail must appear exactly once, not be dropped because
 // the same index was selected as a failure (the old prefix test lost them).
 for(const i of tailIdx)out.push(lines[i]);
 let value=out.join('\n');if(trailing&&value)value+='\n';
 return {text:value,kept:kept.size,blocks};
}

export function digestJob(job,{full=false}={}){
 const source=job&&typeof job==='object'?job:{},stdout=typeof source.stdout==='string'?source.stdout:'',stderr=typeof source.stderr==='string'?source.stderr:'';
 const total_chars=stdout.length+stderr.length,total_lines=lineCount(stdout)+lineCount(stderr);
 if(source.output_reduced===true||source.output_retention?.reduced===true){
  // Physical retention already selected the shared failures and COMBINED tail.
  // Do not summarize again, reinterpret sparse cursors, or offer lost text.
  return {...source,output_notice:OUTPUT_REDUCED_NOTICE,output_digest:{trimmed:true,
   retained_only:true,full_available:source.full_output_available===true,full_requested:full,total_lines,total_chars,
   original_lines:source.output_retention?.total_lines??null,
   failure_blocks:source.output_retention?.failure_blocks??null,kept_lines:total_lines,
   full_hint:source.full_output_available===true?'command_result({job_id,full:true}) 原文分页':null,notice:OUTPUT_REDUCED_NOTICE}};
 }
 if(full||(total_chars<=LIMIT_CHARS&&total_lines<=LIMIT_LINES))return {...source};
 const available=source.full_output_available===true,memoryComplete=source.truncated!==true,budget={blocks:0,chars:0};
 const a=excerpt(stdout,budget,available,memoryComplete),b=excerpt(stderr,budget,available,memoryComplete);
 return {...source,stdout:a.text,stderr:b.text,output_digest:{trimmed:true,total_lines,total_chars,
  failure_blocks:a.blocks+b.blocks,kept_lines:a.kept+b.kept,
  full_available:available,full_hint:available?'command_result({job_id, full:true})':memoryComplete?'command_result({job_id,cursor:0}) 按next_cursor续取普通输出，不重跑命令。':null}};
}
