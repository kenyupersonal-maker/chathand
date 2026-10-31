import {currentSiteExecution,assertSiteExecution} from '../../app/v1/site-execution-context.mjs';
/** Terminal jobs are real local processes, not an OS sandbox.
 * Remote callers can propose jobs/input, inspect output and stop bridge-owned jobs.
 * Approval lives exclusively on the authenticated, loopback-only control plane.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {FullOutputSpool,FullOutputCapture} from './full-output-spool.mjs';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { fail, digest, privateDir, saveJSON } from './core.mjs';
import {maintainFinishedOutput,outputCursorCoverage,OUTPUT_REDUCED_NOTICE,
  FINISHED_OUTPUT_BUDGET,OUTPUT_RETENTION_AGE_MS,RETENTION_INTERVAL_MS} from './command-output-retention.mjs';

export const OUTPUT_LIMIT = 1024 * 1024;       // retained combined transcript
export const HARD_OUTPUT_LIMIT = 16 * 1024 * 1024; // raw output before terminating
export const FINISHED = new Set(['completed','failed','rejected','cancelled','timed_out','output_limit','expired','interrupted']);
const WARNING = '终端命令使用当前系统账户的权限，不受项目目录隔离；可能修改其他文件或联网。每条命令及后续输入均需在本机确认。';

export function safeEnvironment() {
  // Construct an allowlist; never spread the parent's environment.
  const dirs = [path.dirname(process.execPath), path.join(os.homedir(),'.local/bin'), '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'];
  return { HOME:os.homedir(), PATH:[...new Set(dirs)].join(':'), LANG:process.platform==='darwin'?'en_US.UTF-8':'C.UTF-8', TMPDIR:os.tmpdir(), TERM:'dumb', NO_COLOR:'1', PAGER:'cat', GIT_PAGER:'cat', GIT_TERMINAL_PROMPT:'0', GIT_CONFIG_NOSYSTEM:'1' };
}
function stripOsc(text){
 let out=[],from=0,i=0;while(i<text.length){if(text.charCodeAt(i)!==27||text[i+1]!==']'){i++;continue;}let end=i+2;while(end<text.length&&text.charCodeAt(end)!==7&&!(text.charCodeAt(end)===27&&text[end+1]==='\\'))end++;if(end===text.length)break;out.push(text.slice(from,i));i=end+(text.charCodeAt(end)===7?1:2);from=i;}out.push(text.slice(from));return out.join('');
}
function redactAssignments(text){
 const re=/(?:api[_-]?key|token|password|authorization)/gi;let m,from=0,out=[];
 while((m=re.exec(text))){let p=re.lastIndex;while(p<text.length&&/\s/.test(text[p]))p++;if(text[p]==='"'||text[p]==="'")p++;while(p<text.length&&/\s/.test(text[p]))p++;if(text[p]!==':'&&text[p]!=='=')continue;p++;while(p<text.length&&/\s/.test(text[p]))p++;if(text[p]==='"'||text[p]==="'")p++;let end=p;while(end<text.length&&!/[\s,;"']/.test(text[end]))end++;if(end===p)continue;out.push(text.slice(from,p),'[REDACTED]');from=end;re.lastIndex=end;
 }out.push(text.slice(from));return out.join('');
}
export function redact(text) {
 return redactAssignments(stripOsc(String(text))
    .replace(/\x1b\[[0-?]{0,128}[ -/]{0,32}[@-~]/g,'')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[REDACTED_KEY]')
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+\b/g,'[REDACTED_KEY]')
    .replace(/(Bearer\s+)[^\s"']+/gi,'$1[REDACTED]'));
}
export function findExecutable(program) {
  if(typeof program!=='string'||!program||program.length>1024||/[\0\r\n]/.test(program)) fail('PROGRAM_INVALID','程序名称不正确。');
  const names=[program];
  const candidates=path.isAbsolute(program)?names:/^[A-Za-z0-9_.-]+$/.test(program)?safeEnvironment().PATH.split(path.delimiter).flatMap(p=>names.map(n=>path.join(p,n))):[];
  for(const item of candidates) {
    try { fs.accessSync(item,fs.constants.X_OK); const real=fs.realpathSync(item); if(fs.statSync(real).isFile()) return real; } catch {}
  }
  fail('PROGRAM_MISSING','找不到程序；用本机检查确认位置，可在命令参数中使用绝对路径。');
}
function identity(file) {
  const st=fs.statSync(file);
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}
function groupAlive(pid) { if(!pid) return false; try { process.kill(-pid,0); return true; } catch(e) { return e.code==='EPERM'; } }
function signalGroup(pid, signal) { if(!pid) return; try { process.kill(-pid,signal); } catch {} }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function checkId(id) { if(typeof id!=='string'||!/^[A-Za-z0-9_-]{8,96}$/.test(id)) fail('OP_INVALID','request_id 需为 8–96 个字母、数字、短横线或下划线。'); }

/** Keep incomplete lines private so a credential split across writes cannot leak.
 * Extremely long unbroken lines are omitted, not partially exposed.
 * Known-pattern redaction is not a general secret-detection guarantee.
 */
class OutputChannel {
  constructor(queue, job, field) { this.queue=queue; this.job=job; this.field=field; this.decoder=new StringDecoder('utf8'); this.pending=''; this.omitting=false; }
  accept(chunk, final=false) {
    const decoded=final?this.decoder.end():this.decoder.write(chunk);
    this.pending+=decoded;
    let at;
    while((at=this.pending.indexOf('\n'))!==-1) {
      const line=this.pending.slice(0,at+1); this.pending=this.pending.slice(at+1);
      if(!this.omitting) this.queue.appendOutput(this.job,this.field,redact(line));
      this.omitting=false;
    }
    if(this.pending.length>32768) {
      if(!this.omitting) this.queue.appendOutput(this.job,this.field,'[超长未换行输出已省略]\n');
      this.omitting=true; this.pending=''; this.job.truncated=true;
    }
    if(final&&this.pending) { if(!this.omitting)this.queue.appendOutput(this.job,this.field,redact(this.pending)); this.pending=''; }
  }
}

export class CommandQueue {
  constructor(store,{timeoutMs=120000,approvalMs=600000,maxRunning=4,outputLimit=OUTPUT_LIMIT,hardOutputLimit=HARD_OUTPUT_LIMIT,killGraceMs=600,
    outputRetentionAgeMs=OUTPUT_RETENTION_AGE_MS,finishedOutputBudget=FINISHED_OUTPUT_BUDGET,
    externalMaintenance=false,retentionIntervalMs=RETENTION_INTERVAL_MS,retentionClock={now:Date.now,setInterval,clearInterval}}={}) {
    if(!Number.isSafeInteger(outputRetentionAgeMs)||outputRetentionAgeMs<0||!Number.isSafeInteger(finishedOutputBudget)||finishedOutputBudget<0||
      !Number.isSafeInteger(retentionIntervalMs)||retentionIntervalMs<1||!retentionClock||
      ['now','setInterval','clearInterval'].some(key=>typeof retentionClock[key]!=='function'))throw new TypeError('OUTPUT_RETENTION_CONFIG_INVALID');
    this.store=store;
    this.enabled=true; // terminal is a first-class feature; execution STILL needs local approval
    this.jobs=new Map(); this.inputs=new Map(); this.timeoutMs=timeoutMs; this.approvalMs=approvalMs;
    this.maxRunning=maxRunning; this.outputLimit=outputLimit; this.hardOutputLimit=hardOutputLimit; this.killGraceMs=killGraceMs;
    this.fullScopes=new Map();this.fullOutputs=new Map();
    this.closed=false; this.dir=path.join(store.stateDir,'command-receipts'); privateDir(this.dir);
    this.outputRetentionAgeMs=outputRetentionAgeMs;this.finishedOutputBudget=finishedOutputBudget;
    this.retentionClock=retentionClock;this.settledJobs=new WeakSet();this.outputRetentionStatus=null;this.outputMaintenanceError=null;
    this.retentionTimer=externalMaintenance?null:retentionClock.setInterval(()=>{
      if(this.closed)return;
      try{this.maintainOutputs();}catch{this.outputMaintenanceError='OUTPUT_RETENTION_UNCONFIRMED';}
    },retentionIntervalMs);
    this.retentionTimer?.unref?.();
  }
  settled(j) {
    if(!j||!FINISHED.has(j.status)||j.child||j.process_alive||j.cleanupPending||j.cleanup_pending||
      ['pending','running','unconfirmed'].includes(j.cleanupState||j.cleanup_state))return false;
    if(this.settledJobs.has(j))return true;
    // A completed leader is insufficient while its original POSIX group still
    // exists. Cache only a positively settled record; live flags always win.
    if(j.pid&&j.cleanupStarted&&groupAlive(j.pid))return false;
    this.settledJobs.add(j);return true;
  }
  maintainOutputs() {
    const now=this.retentionClock.now(),settled=[...this.jobs.values()].filter(j=>this.settled(j)).sort((a,b)=>(a.finished_at||0)-(b.finished_at||0));
    const bytes=entry=>{if(!entry?.spool||entry.spool.disposed)return 0;try{return entry.spool.diskBytes();}catch{return entry.spool.committedFileBytes+entry.spool.indexCount*24;}};
    const drop=j=>{const e=this.fullOutputs.get(j.id);if(!e?.spool)return;e.capture?.abandon();e.spool.dispose();e.spool=null;e.capture=null;j.capture_error??='OUTPUT_SPOOL_CLEANED';};
    let disk=settled.reduce((n,j)=>n+bytes(this.fullOutputs.get(j.id)),0);
    for(const j of settled){if(disk<=this.finishedOutputBudget)break;const n=bytes(this.fullOutputs.get(j.id));drop(j);disk-=n;}
    this.outputRetentionStatus=maintainFinishedOutput(this.jobs.values(),{
      isSettled:j=>this.settled(j),now,ageMs:this.outputRetentionAgeMs,budgetBytes:Math.max(0,this.finishedOutputBudget-disk)});
    let total=disk+this.outputRetentionStatus.retained_bytes;
    Object.assign(this.outputRetentionStatus,{budget_bytes:this.finishedOutputBudget,archive_bytes:disk,combined_retained_bytes:total,over_budget:total>this.finishedOutputBudget});
    this.outputMaintenanceError=null;return this.outputRetentionStatus;
  }
  record(j) {
    // Persist metadata BEFORE spawn/input. Output lives separately in the private redacted journal; no command arguments or stdin in this receipt.
    saveJSON(path.join(this.dir,`${j.request_id}.json`),{v:1,job_id:j.id,request_id:j.request_id,stamp:j.stamp,status:j.status,pid:j.pid??null,created_at:j.created_at,started_at:j.started_at??null,finished_at:j.finished_at??null,exit_code:j.exit_code??null,cleanup_confirmed:j.cleanupConfirmed??null,cleanup_state:j.cleanupState??null,helper_exit_error:j.helperExitError??null});
  }
  recordLater(j) { try { this.record(j); } catch(e) { j.persistence_error=e.code||'PERSISTENCE_FAILED'; } }
  auditLater(j,event) { try { this.store.audit(event); } catch(e) { j.persistence_error=e.code||'AUDIT_FAILED'; } }
  active() { this.store.checkActive(); if(this.closed)fail('QUEUE_CLOSED','终端正在关闭。'); if(!this.enabled)fail('COMMANDS_DISABLED','本机暂时关闭了终端，请在本机面板恢复。'); }
  propose({program,args=[],cwd='.',request_id,mode='task',timeout_ms,stdin_mode='closed'}) {
    this.active(); checkId(request_id);
    if(!Array.isArray(args)||args.length>200||args.some(x=>typeof x!=='string'||x.length>65536||x.includes('\0'))||Buffer.byteLength(JSON.stringify(args))>128*1024)fail('ARG_INVALID','命令参数不正确或过长。');
    if(!['task','service'].includes(mode)||!['closed','pipe'].includes(stdin_mode))fail('ARG_INVALID','mode 或 stdin_mode 不正确。');
    const timeout=timeout_ms??(mode==='service'?3600000:this.timeoutMs);
    const max=mode==='service'?86400000:3600000;
    if(!Number.isInteger(timeout)||timeout<50||timeout>max)fail('ARG_INVALID','任务超时最多 1 小时，服务最多 24 小时；最少 50 毫秒。');
    const stamp=digest(JSON.stringify([program,args,cwd,this.store.root,mode,timeout,stdin_mode]));
    for(const j of this.jobs.values()) if(j.request_id===request_id) {
      if(j.stamp!==stamp)fail('OP_CONFLICT','同一个 request_id 已用于其他参数。');
      this.expire(j); return {...this.publicJob(j),replayed:true};
    }
    const ledger=path.join(this.dir,`${request_id}.json`);
    if(fs.existsSync(ledger)) {
      const old=JSON.parse(fs.readFileSync(ledger,'utf8'));
      if(old.stamp!==stamp)fail('OP_CONFLICT','这个 request_id 已用于其他命令。');
      fail('REPLAY_PREVIOUS_SESSION',`此前会话已接收这项命令（${old.status}）。未重新执行；先确认旧任务结果，再为新操作创建新 ID。`);
    }
    // The lifetime history and request-id ledger are never evicted for admission.
    // Expired approvals must leave the active count before either limit is read.
    for(const j of this.jobs.values())this.expire(j);
    this.maintainOutputs();
    if([...this.jobs.values()].filter(j=>!this.settled(j)).length>=500)
      fail('QUEUE_FULL','仍在运行、排队、待确认或清理未结束的命令已达 500 条；请先处理这些活动命令。已结束记录不占名额。');
    if([...this.jobs.values()].filter(j=>j.status==='pending_approval').length>=30)fail('QUEUE_FULL','待确认命令已达 30 条，请先处理。');
    const dir=this.store.resolve(cwd,{directory:true}); if(!fs.statSync(dir).isDirectory())fail('ARG_INVALID','cwd 不是目录。');
    const executable=findExecutable(program);
    if(['sudo','su','doas'].includes(path.basename(executable)))fail('PROGRAM_BLOCKED','客户端不执行提权入口。');
    const j={siteExecution:currentSiteExecution(),id:crypto.randomUUID(),request_id,stamp,program:executable,programIdentity:identity(executable),args:[...args],cwd,absoluteCwd:dir,dirIdentity:`${fs.statSync(dir).dev}:${fs.statSync(dir).ino}`,root:this.store.root,mode,timeout_ms:timeout,stdin_mode,status:'pending_approval',created_at:Date.now(),stdout:'',stderr:'',exit_code:null,truncated:false,raw_bytes:0,events:[],next_cursor:0,base_cursor:0,kept_bytes:0};
    this.record(j); this.jobs.set(j.id,j);
    this.store.audit({event:'command_proposed',job_id:j.id,program:path.basename(j.program),mode});
    return this.publicJob(j);
  }
  get(id) { const j=this.jobs.get(id); if(!j)fail('JOB_MISSING','当前会话找不到该命令。'); this.expire(j); return j; }
  expire(j) { if(j.status==='pending_approval'&&Date.now()-j.created_at>this.approvalMs) { j.status='expired'; this.record(j); } }
  publicJob(j,{includeOutput=true,cursor}={}) {
    const events=cursor===undefined?j.events:j.events.filter(x=>x.cursor>=cursor);
    const stdout=includeOutput?events.filter(x=>x.stream==='stdout').map(x=>x.text).join(''):undefined;
    const stderr=includeOutput?events.filter(x=>x.stream==='stderr').map(x=>x.text).join(''):undefined;
    const reduced=j.output_retention?.reduced===true;
    return {job_id:j.id,request_id:j.request_id,status:j.status,program:j.program,args:[...j.args],cwd:j.cwd,mode:j.mode,timeout_ms:j.timeout_ms,stdin_mode:j.stdin_mode,pid:j.pid??null,exit_code:j.exit_code,signal:j.signal??null,stdout,stderr,truncated:j.truncated,raw_bytes:j.raw_bytes,next_cursor:j.next_cursor,oldest_cursor:j.base_cursor,...outputCursorCoverage(j,cursor??0),process_alive:!!j.child,persistence_error:j.persistence_error??null,cleanup_pending:!!j.cleanupPending,cleanup_confirmed:j.cleanupConfirmed??null,cleanup_state:j.cleanupState??null,cleanup_error:j.cleanupError??null,helper_exit_error:j.helperExitError??null,created_at:j.created_at,started_at:j.started_at??null,finished_at:j.finished_at??null,warning:WARNING,
      full_output_available:!!this.fullOutputs.get(j.id)?.spool&&!j.capture_error,capture_error:j.capture_error??null,output_reduced:reduced,output_retention:j.output_retention?{...j.output_retention}:null,
      ...(reduced?{output_notice:OUTPUT_REDUCED_NOTICE}:{}),
      ...(includeOutput&&reduced?{output_events:events.map(event=>({...event}))}:{}),
      output_retention_status:this.outputStatus({includeCheckTime:false})};
  }
  nextMaintenanceAt(now=this.retentionClock.now()) {
    if(this.closed)return Infinity;let at=Infinity;
    for(const j of this.jobs.values()){
      if(j.status==='pending_approval')at=Math.min(at,j.created_at+this.approvalMs+1);
      if(Number.isFinite(j.finished_at)){
        if(!this.settled(j)){at=Math.min(at,now+1000);continue;} // bounded OS cleanup observation
        if(j.output_retention?.applied!==true)at=Math.min(at,j.finished_at+this.outputRetentionAgeMs+1);
      }
    }
    return at;
  }
  maintain() { for(const j of this.jobs.values())this.expire(j);return this.maintainOutputs(); }
  outputStatus({includeCheckTime=true}={}) { if(!this.outputRetentionStatus)return null;const {checked_at,...status}=this.outputRetentionStatus;return {...status,...(includeCheckTime?{checked_at}:{}),error_code:this.outputMaintenanceError}; }
  list({includeOutput=false}={}) { this.maintain();return [...this.jobs.values()].map(j=>this.publicJob(j,{includeOutput})); }
  appendOutput(j,stream,text) {
    if(!text)return;
    const event={cursor:j.next_cursor++,stream,text}; j.events.push(event); j.kept_bytes+=Buffer.byteLength(text);
    const high=this.outputLimit+Math.min(256*1024,Math.ceil(this.outputLimit/4));
    if(j.kept_bytes>high)this.trimOutput(j);
  }
  trimOutput(j){
    let count=0;while(j.kept_bytes>this.outputLimit&&count<j.events.length){j.kept_bytes-=Buffer.byteLength(j.events[count++].text);}
    if(count){j.events.splice(0,count);j.base_cursor=j.events[0]?.cursor??j.next_cursor;j.truncated=true;}
  }
  bindFullOutput(id,scope) {
    const j=this.get(id),old=this.fullScopes.get(id),value=JSON.stringify(scope);
    if(old&&JSON.stringify(old)!==value)fail('OUTPUT_SPOOL_SCOPE','全文输出不属于这个任务或连接。');
    if(!old&&j.status!=='pending_approval')fail('FULL_OUTPUT_UNAVAILABLE','旧命令没有完整输出档案；不能恢复已经丢弃的内容。');
    this.fullScopes.set(id,{...scope});
  }
  async resultFull(id,{scope,full_cursor=null,wait_ms=0,envelopeSize,compatibility_note}={}) {
    if(!Number.isInteger(wait_ms)||wait_ms<0||wait_ms>20000)fail('ARG_INVALID','wait_ms 只能是 0–20000。');
    const j=this.get(id),available=()=>{
     const entry=this.fullOutputs.get(id);
     if(!entry||!entry.spool||j.capture_error)fail('FULL_OUTPUT_UNAVAILABLE',j.capture_error==='OUTPUT_SPOOL_CLEANED'?'全文档案已按预算清理，不要为补输出重新执行。':j.capture_error?'全文档案不可用（'+j.capture_error+'）；命令状态和退出码不受影响，不要为补输出重新执行。':'这条命令尚未启动或属于旧会话，没有可确认完整的输出档案。不要为补输出重新执行。');
     entry.spool.check(scope);return entry;
    };
    let entry=available();if(full_cursor!==null)entry.spool.descriptor(full_cursor);
    const end=Date.now()+wait_ms;
    while(full_cursor!==null&&!entry.spool.hasNew(full_cursor,scope)&&!FINISHED.has(j.status)&&Date.now()<end){await sleep(Math.min(50,end-Date.now()));entry=available();}
    entry=available();
    return entry.spool.read({scope,full_cursor,envelopeSize,extra:{status:j.status,exit_code:j.exit_code??null,finished_at:j.finished_at??null,process_alive:!!j.child,cleanup_pending:!!j.cleanupPending,...(compatibility_note?{compatibility_note}:{}),next_action:'先用 read_full_cursor 重取本页；收到后沿 next_full_cursor 续取。运行中仅统计已脱敏完整行；结束且游标为空才读完。'}});
  }
  captureOutput(j,action) {
    const entry=this.fullOutputs.get(j.id);if(!entry)return;
    if(j.capture_error||!entry.capture)return;
    try{action(entry);}catch{j.capture_error='OUTPUT_SPOOL_WRITE_FAILED';if(entry.spool)entry.spool.failure=j.capture_error;entry.capture?.abandon();}
  }
  approve(id) {
    this.active(); const j=this.get(id);assertSiteExecution(j.siteExecution);
    if(j.status==='expired')fail('JOB_EXPIRED','这条命令已过期。');
    if(j.status!=='pending_approval')fail('JOB_STATE','这条命令已经处理。');
    if(j.root!==this.store.root)fail('ROOT_CHANGED','项目已更换。');
    if([...this.jobs.values()].filter(x=>x.child).length>=this.maxRunning)fail('JOB_BUSY','同时运行的任务已达上限；先停止或等现有任务完成。');
    const current=this.store.resolve(j.cwd,{directory:true}),st=fs.statSync(current);
    if(current!==j.absoluteCwd||`${st.dev}:${st.ino}`!==j.dirIdentity)fail('ROOT_CHANGED','工作目录已被替换。');
    if(identity(j.program)!==j.programIdentity)fail('PROGRAM_CHANGED','可执行程序已改变，请拒绝此项并重新提议。');
    const scope=this.fullScopes.get(id);
    if(scope&&!this.fullOutputs.has(id)){
      try{const parent=path.join(this.store.stateDir,'command-output');privateDir(parent);
       const spool=new FullOutputSpool({parent,jobId:id,scope});
       this.fullOutputs.set(id,{spool,capture:new FullOutputCapture(spool,redact)});
      }catch{j.capture_error='OUTPUT_SPOOL_CREATE_FAILED';this.fullOutputs.set(id,{spool:null,capture:null});}
    }
    let launch,child;
    try{j.status='running';j.started_at=Date.now();this.record(j);
    this.store.audit({event:'command_approved',job_id:id,program:path.basename(j.program)});
    launch=this.prepareSpawn?.(j);
    child=spawn(launch?.program||j.program,launch?.args||j.args,{cwd:j.absoluteCwd,env:launch?.env||safeEnvironment(),shell:false,detached:true,stdio:[j.stdin_mode==='pipe'?'pipe':'ignore','pipe','pipe']});
    }catch(e){this.finalizeLaunchFailure(j,e);throw e;}
    j.child=child; j.pid=child.pid??null;
    this.recordLater(j);
    child.stdin?.on('error',()=>{}); // EPIPE is reflected by state/close, never crashes the daemon.
    const out=new OutputChannel(this,j,'stdout'),err=new OutputChannel(this,j,'stderr');
    const collect=channel=>chunk=>{
      const readable=child[channel.field];readable.pause();
      try{
      j.raw_bytes+=chunk.length;if(!j.capture_frozen)this.captureOutput(j,e=>e.capture.accept(channel.field,chunk)); this.inspectChunk?.(j,chunk); channel.accept(chunk);
      if(j.raw_bytes>this.hardOutputLimit&&!j.capture_frozen) {j.capture_frozen=true;this.captureOutput(j,e=>{e.spool.markOutputLimited();e.capture.endStream('stdout');e.capture.endStream('stderr');}); j.truncated=true;if(j.status==='running')this.cancel(id,'output_limit'); }
      }finally{setImmediate(()=>readable.resume());}
    };
    child.stdout.on('data',collect(out)); child.stderr.on('data',collect(err));
    child.stdout.on('end',()=>this.captureOutput(j,e=>e.capture.endStream('stdout')));child.stderr.on('end',()=>this.captureOutput(j,e=>e.capture.endStream('stderr')));
    j.timer=setTimeout(()=>{try{this.cancel(id,'timed_out');}catch(e){j.persistence_error=e.code||'CANCEL_ERROR';j.status='failed';this.cleanupGroup(j);}},j.timeout_ms);
    child.on('error',e=>this.finalizeLaunchFailure(j,e));
    // A short-lived shell may exit while its children still hold stdio. Kill the
    // entire ORIGINAL group even on normal exit; never let group children escape by '&'.
    child.on('exit',()=>{this.cleanupGroup(j);});
    child.on('close',async(code,signal)=>{
      clearTimeout(j.timer);
      this.captureOutput(j,e=>{e.capture.endStream('stdout');e.capture.endStream('stderr');});
      clearTimeout(j.timer); out.accept(Buffer.alloc(0),true); err.accept(Buffer.alloc(0),true);this.trimOutput(j);
      j.exit_code=code; j.signal=signal; j.finished_at=Date.now();
      if(j.status==='running')j.status=code===0?'completed':'failed';
      j.child=null;
      if(j.cleanupPending&&!groupAlive(j.pid)){clearTimeout(j.cleanupTimer);j.cleanupPending=false;}
      for(const input of this.inputs.values())if(input.job_id===j.id&&input.status==='pending_approval')input.status='cancelled';
      this.cleanupGroup(j); this.recordLater(j);
      this.auditLater(j,{event:'command_finished',job_id:id,status:j.status,exit_code:code,raw_bytes:j.raw_bytes});
      // Let derived close listeners finish interpreting their final output first.
      queueMicrotask(()=>{if(!this.closed)try{this.maintainOutputs();}catch{this.outputMaintenanceError='OUTPUT_RETENTION_UNCONFIRMED';}});
    });
    return this.publicJob(j);
  }
  finalizeLaunchFailure(j,error){
    const allowed=new Set(['ENOENT','EACCES','ENOEXEC','EINVAL','EMFILE','ENFILE','ENOSPC','EROFS','EIO']);
    j.launch_error=allowed.has(error?.code)?error.code:'SPAWN_ERROR';
    const text=`程序启动失败：${j.launch_error}\n`;this.appendOutput(j,'stderr',text);this.trimOutput(j);
    this.captureOutput(j,e=>{e.capture.accept('stderr',Buffer.from(text));e.capture.endStream('stdout');e.capture.endStream('stderr');});
    if(j.status==='running')j.status='failed';j.finished_at=Date.now();this.recordLater(j);
  }
  cleanupGroup(j) {
    if(j.cleanupStarted||!j.pid)return;
    j.cleanupStarted=true;
    if(!groupAlive(j.pid))return;
    j.cleanupPending=true; signalGroup(j.pid,'SIGTERM');
    j.cleanupTimer=setTimeout(()=>{ signalGroup(j.pid,'SIGKILL'); j.cleanupPending=false; this.recordLater(j); },this.killGraceMs);
    // Timer remains referenced until escalation has run, including after leader exits.
  }
  deny(id) { const j=this.get(id); if(j.status!=='pending_approval')fail('JOB_STATE','只能拒绝待确认命令。');j.status='rejected';this.record(j);this.store.audit({event:'command_rejected',job_id:id});return this.publicJob(j); }
  cancel(id,reason='cancelled') {
    const j=this.get(id);
    if(j.status==='pending_approval') { j.status=reason; this.recordLater(j); }
    else if(j.status==='running'||j.child) { j.status=reason; clearTimeout(j.timer); this.cleanupGroup(j); this.recordLater(j); }
    return this.publicJob(j);
  }
  cancelAll() { for(const j of this.jobs.values())if(j.status==='pending_approval'||j.child)this.cancel(j.id);for(const p of this.inputs.values())if(p.status==='pending_approval')p.status='cancelled'; }
  setEnabled(value) { this.enabled=value; if(!value)this.cancelAll(); }
  async result(id,waitMs=0,cursor) {
    if(!Number.isInteger(waitMs)||waitMs<0||waitMs>20000)fail('ARG_INVALID','wait_ms 只能是 0–20000。');
    if(cursor!==undefined&&(!Number.isInteger(cursor)||cursor<0))fail('ARG_INVALID','cursor 需为非负整数。');
    const end=Date.now()+waitMs; let j=this.get(id);
    while((!FINISHED.has(j.status)||j.child||j.cleanupPending)&&Date.now()<end) { if(cursor!==undefined&&j.next_cursor>cursor)break; await sleep(Math.min(50,end-Date.now())); j=this.get(id); }
    this.maintainOutputs();
    return this.publicJob(j,{cursor});
  }
  proposeInput({job_id,text='',close=false,request_id}) {
    this.active();checkId(request_id);
    if(typeof text!=='string'||Buffer.byteLength(text)>16384||text.includes('\0')||typeof close!=='boolean')fail('ARG_INVALID','输入需为最多 16 KiB 的文本。');
    for(const p of this.inputs.values())if(p.request_id===request_id) { if(p.job_id!==job_id||p.text!==text||p.close!==close)fail('OP_CONFLICT','输入 request_id 冲突。'); return {...p}; }
    const j=this.get(job_id);if(j.status!=='running'||!j.child?.stdin||j.child.stdin.writableEnded)fail('STDIN_CLOSED','该进程没有可写输入；创建时需 stdin_mode=pipe。');
    if(this.inputs.size>=200||[...this.inputs.values()].filter(p=>p.status==='pending_approval').length>=30)fail('QUEUE_FULL','输入队列已满。');
    const p={input_id:crypto.randomUUID(),job_id,text,close,request_id,status:'pending_approval',created_at:Date.now()};Object.defineProperty(p,'siteExecution',{value:currentSiteExecution(),enumerable:false});this.inputs.set(p.input_id,p);return {...p};
  }
  approveInput(inputId) {
    this.active(); const p=this.inputs.get(inputId);if(!p)fail('INPUT_MISSING','找不到这项输入。');
    assertSiteExecution(p.siteExecution);if(p.status!=='pending_approval')fail('JOB_STATE','输入已经处理。');
    if(Date.now()-p.created_at>this.approvalMs){p.status='expired';fail('JOB_EXPIRED','输入已过期。');}
    const j=this.get(p.job_id);if(j.status!=='running'||!j.child?.stdin||j.child.stdin.writableEnded)fail('STDIN_CLOSED','进程输入已关闭。');
    p.status='sent';this.store.audit({event:'stdin_approved',job_id:j.id,input_id:p.input_id,bytes:Buffer.byteLength(p.text),close:p.close});
    if(p.close)j.child.stdin.end(p.text);else j.child.stdin.write(p.text);
    return {input_id:p.input_id,status:p.status};
  }
  denyInput(id) { const p=this.inputs.get(id);if(!p)fail('INPUT_MISSING','找不到输入。');if(p.status!=='pending_approval')fail('JOB_STATE','输入已处理。');p.status='rejected';return {input_id:id,status:p.status}; }
  async close() {
    this.closed=true;this.retentionClock.clearInterval(this.retentionTimer);this.cancelAll();
    const until=Date.now()+(this.killGraceMs+3000);
    while([...this.jobs.values()].some(j=>j.child||j.cleanupPending)&&Date.now()<until)await sleep(30);
    for(const entry of this.fullOutputs.values())entry.spool?.dispose();
    for(const j of this.jobs.values()) { clearTimeout(j.timer); if(j.child)signalGroup(j.pid,'SIGKILL'); }
  }
}
