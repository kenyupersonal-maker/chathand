import fs from 'node:fs';
import {t} from '../i18n.mjs';
import {gateCommand,needsFullAccessError} from './permissions.mjs';
import {highRiskError,neverError,adminFormError} from './high-risk.mjs';

// This is a deliberately small specification allowlist, not a claim that an
// arbitrary program's stdin is data. Scripts, wrappers, interpreters, PTYs and
// unrecognized invocations keep the existing executable-input heuristic.
// Use the queue's resolved executable and approved identity, never caller hints,
// a prompt/title, a basename alone, or a model's assertion about the consumer.
export function commandInputConsumer(job){
 if(!job||job.stdin_mode!=='pipe'||job.pty||job.admin||!Number.isFinite(job.started_at)||
    !Array.isArray(job.args)||!(job.args.length===0||job.args.length===1&&job.args[0]==='-'))
  return 'executable_or_unknown';
 try{
  if(!['/bin/cat','/usr/bin/cat'].includes(job.program)||fs.realpathSync(job.program)!==job.program)
   return 'executable_or_unknown';
  const st=fs.statSync(job.program),identity=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');
  if(st.isFile()&&st.uid===0&&(st.mode&0o022)===0&&identity===job.programIdentity)return 'data';
 }catch{/* Missing/replaced/unreadable executable: no data exemption. */}
 return 'executable_or_unknown';
}

// gateCommand's normal diagnostics include command/evidence text. Stdin may
// contain private application data even when its consumer is unknown; classify
// transiently, then rebuild only the known gate facts before any receipt/audit.
function inputError(error){
 if(error.details?.never_id)return neverError(error.details.never_id,'command_input');
 if(error.code==='HIGH_RISK_DISABLED')return highRiskError(error.details.risk_id,{
  command:'command_input',times:error.details.blocked_times
 });
 if(error.code==='NEEDS_FULL_ACCESS')return needsFullAccessError(t("permissions.input.scopeReason"),{command:'command_input'});
 if(error.code==='ADMIN_FORM_UNSUPPORTED')return adminFormError(t("permissions.input.adminForm"));
 return Object.assign(new Error(t("permissions.input.notSent")),{
  code:/^[A-Z_]{3,80}$/.test(error.code||'')?error.code:'ARG_INVALID'
 });
}
function privateGate(spec,context){
 const {blocks,confirmations}=context;
 let record,confirmation;
 try{
  return gateCommand({...context,spec,
   blocks:{adminAccess:blocks?.adminAccess,count:(...a)=>blocks?.count(...a)||0,record:value=>{record=value;}},
   confirmations:{allows:value=>confirmations?.allows(value),create:value=>{confirmation=value;}}
  });
 }catch(error){
  const safe=inputError(error);
  if(confirmation&&safe.details?.blocked)confirmations?.create({...confirmation,blocked:safe.details.blocked});
  if(record&&blocks){
   blocks.record({...record,command:'command_input',reason:safe.message,blocked:safe.details?.blocked});
   safe.blockRecorded=true;
  }
  throw safe;
 }
}
export function gateCommandInput({job,text,...context}){
 if(typeof text!=='string'||!text.length)return;
 const gateContext={...context,cwd:job.absoluteCwd||context.cwd};
 // Recheck the actual consumer before allowing input, including privilege/
 // computer-password entrypoints and current user high-risk switches.
 privateGate({program:job.program,args:job.args,stdin_mode:job.stdin_mode,pty:job.pty,mode:job.mode},gateContext);
 if(commandInputConsumer(job)!=='data'&&text.trim()){
  // Preserve the existing shell/code-stdin checks for all other consumers.
  // This heuristic cannot prove what arbitrary code will read/evaluate.
  privateGate({program:'/bin/sh',args:['-c',text]},gateContext);
 }
}
