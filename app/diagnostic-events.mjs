import {resourceDiagnosticFields} from './v1/resource-diagnostics.mjs';
import {chromeAccessFields} from './v1/chrome-data-access.mjs';
/** Local metadata only. Failure is deliberately independent of execution/authority. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {onboardingFields,onboardingEntry,projectOnboardingEntries} from './onboarding-telemetry.mjs';
const safeFile=st=>st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o077)===0;
export function diagnosticDirectory(stateDir){
 const dir=path.join(stateDir,'diagnostics');
 try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('unsafe diagnostics directory');
 return dir;
}
export function installationSalt(stateDir){
 try{
  const file=path.join(diagnosticDirectory(stateDir),'trace-salt');
  if(!fs.existsSync(file)){
   const tmp=file+'.'+crypto.randomUUID()+'.tmp';
   try{fs.writeFileSync(tmp,crypto.randomBytes(32),{flag:'wx',mode:0o600});try{fs.linkSync(tmp,file);}catch(e){if(e.code!=='EEXIST')throw e;}}finally{try{fs.unlinkSync(tmp);}catch{}}
  }
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const st=fs.fstatSync(fd);if(!safeFile(st)||st.size!==32)throw Error('unsafe salt');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
 }catch{return crypto.randomBytes(32);} // Unsafe persistence never blocks a tool or opens another file.
}
const schema={
 'onboarding.step':[], 'chrome.install':[], 'mcp.resource':[], 'site.watch':['phase','reason','code'],
 'conn.startup':['stage','outcome','code','ms','n','source'],
 'conn.cloud':['from','to','reason','ms','status','code','source'],'conn.restart':['reason','ms','n','source'],
 'conn.state':['from','to','reason','source','n','code'],'conn.unhealthy':['n','ms'],'conn.grace':['route','outcome','ms'],
 access:['enabled','reason','source'],revoke_all:['reason','source','n','jobs'],'task.end':['task','status','end_reason','saved'],
 cap:['code','n'],'relay.checkpoint':['task','seq','continuing','waiting_user','card'],
 'relay.ctl':['task','action','mode','granted','reason','outcome'],'relay.unclaimed':['task','ms'],'relay.disable':['code'],
 stall:['task','ms','threshold_ms','waiting_job','model'],'task.begin':['task','model','trial'],'block.nudge':['task','n','ms'],
 'wait.poll':['task','job','asked_ms','ms','n','run_ms'],'wait.end':['task','job','run_ms','polls','seen','late_ms'],
 'return.paged':['tool','n','chars','saved'],'relay.auto':['task','prompt_kind','block_n','task_n'],'card.errors':['n','codes']};
const numeric=new Set(['n','jobs','ms','seq','threshold_ms','asked_ms','run_ms','polls','late_ms','chars','block_n','task_n']);
const boolean=new Set(['enabled','saved','continuing','waiting_user','card','granted','waiting_job']);
const values=new Set(('started stopped rejected CODE_ACCEPTED WATCH_STARTED WATCH_STOPPED WATCH_PAIRED WATCH_EXPIRED INVALID_FORMAT INVALID_ORIGIN NO_PENDING PAIR_FAILED health authenticated_call call_ok error unhealthy degraded disabled ok starting up down health_ok health_checking health_down health_unavailable proxy_changed external_wait threshold_provisional unrecoverable persistence_failure user_resume route_changed started wait_done wait_over off checking pairing healthy unconfigured idle connecting running ready needs_login needs_retry reconnecting failed online offline login_required auth_required probe_unhealthy cloud_down proxy_change periodic_retry periodic auth credential_save tunnel relay site site_b onConnecting onUnavailable onReady grace_end user mode paused revoked stopped permission_changed workspace_changed connection_lost expired superseded rejected cancelled completed active pending_approval authority_changed task_ended idle continuing waiting_user not_continuing new_tool new_checkpoint disabled not_stalled stale_checkpoint checkpoint_already_registered resume_timeout already_claimed same_block_again too_early manual auto claim begin_dispatch report cancel interruption view accepted rejected unknown dispatching resumed limit armed manual_ready retry_wait permit awaiting reconnected user_stop config_changed pro thinking instant other fine medium coarse in_turn after_resume resume split_smaller block_limit task_limit new_call unattributed_tool access_disabled installation_ineligible task_missing session_missing legacy inflight task_not_active task_changed pending_send not_ready consumed permission_denied').split(' '));
// Startup diagnostics are categorical only: never preserve exception text or arbitrary codes.
const startupFields={
 stage:new Set('app_start startup_delay proxy_wait credential_read configure attempt doctor transport healthy credential_save retry_wait'.split(' ')),
 outcome:new Set('begin ok failed timeout cancelled skipped'.split(' ')),
 source:new Set('server controller tunnel site'.split(' ')),
 code:new Set('OK CANCELLED UNKNOWN SPAWN_ERROR ENOENT EACCES DOCTOR_FAILED DOCTOR_TIMEOUT CONNECTION_UNAVAILABLE CONNECTION_AUTH_FAILED CREDENTIAL_BUSY CREDENTIAL_STORE_UNSAFE CREDENTIAL_STORE_CORRUPT CREDENTIAL_STORE_VERSION CREDENTIAL_CHANGED CREDENTIAL_CONFLICT CREDENTIAL_WRITE_VERIFY_FAILED CREDENTIAL_SAVE_FAILED SAVED_CONNECTION_MISSING KEY_INVALID KEY_EXPIRED AUTH_REQUIRED TUNNEL_ID_INVALID TUNNEL_UNCONFIGURED TUNNEL_RUNNING'.split(' '))
};
export function connectionStartupCode(code){return startupFields.code.has(code)?code:'UNKNOWN';}
export function validCardErrors(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!Number.isSafeInteger(value.n)||value.n<1||!Array.isArray(value.codes)||value.codes.length>5||value.codes.some(c=>typeof c!=='string'||!(/^[A-Z][A-Z0-9_]{0,39}$/).test(c)))return null;
 return {n:value.n,codes:[...new Set(value.codes)]};
}
// Installation telemetry contains categories only; profile names, paths, helper
// payloads and arbitrary native error text never enter the diagnostic stream.
const chromeInstallStages=new Set('preparing waiting_accessibility opening_chrome checking_profile extensions removing_copy loading_directory validating_helper installed_verified'.split(' '));
const chromeInstallOutcomes=new Set('started running completed stopped'.split(' '));
const chromeInstallCodes=new Set(('BUSY CANCELLED INVALID_LEASE SOURCE_MISMATCH ACCESSIBILITY_REQUIRED ACCESSIBILITY_TIMEOUT CHROME_UNAVAILABLE TARGET_UNKNOWN FOCUS_UNKNOWN SHEET_UNKNOWN CONTROLS_UNKNOWN PROFILE_UNKNOWN CHROME_TOO_OLD MANAGED_POLICY_BLOCKED USER_INTERRUPTED PERMISSION_CHANGED TIMEOUT INPUT_UNCONFIRMED LOCAL_NETWORK VERIFICATION_FAILED NOT_INSTALLED OTHER_PROFILE NATIVE_HOST_NOT_CONNECTED TARGET_HANDSHAKE_TIMEOUT STARTED PROGRESS OK UNKNOWN').split(' ').map(x=>'CHROME_INSTALL_'+x));
chromeInstallCodes.add('CONFIRM_NOT_HUMAN');chromeInstallCodes.add('CHROME_DATA_ACCESS_DENIED');
for(const code of 'ACCESS_CHANGED EXPIRED SOURCE_CHANGED STOPPED SESSION_CHANGED PROBE_FAILED DISCONNECTED CANCELLED CLOSED'.split(' '))chromeInstallCodes.add('INSTALL_'+code);
export const chromeInstallDurationLimit=stage=>stage==='waiting_accessibility'?300000:90000;
const chromePreflightTargetDetails=new Set('WINDOWS_AX_ERROR WINDOWS_VALUE_MISSING WINDOWS_VALUE_INVALID WINDOWS_TOO_MANY WINDOW_ID_DUPLICATE'.split(' '));
const chromePreflightSheetDetails=new Set('WINDOW_ROLE_AX_ERROR WINDOW_ROLE_VALUE_INVALID WINDOW_ROLE_MISMATCH WINDOW_ID_READER_MISSING WINDOW_ID_UNAVAILABLE SHEETS_DEADLINE SHEETS_TIMEOUT_AX_ERROR SHEETS_AX_ERROR SHEETS_NOVALUE_WITH_VALUE SHEETS_VALUE_MISSING SHEETS_VALUE_NOT_ARRAY SHEETS_ARRAY_CAST_FAILED SHEETS_ELEMENT_INVALID SHEETS_PRESENT'.split(' '));
const chromePreflightErrorDetails=new Set('WINDOWS_AX_ERROR WINDOW_ROLE_AX_ERROR SHEETS_TIMEOUT_AX_ERROR SHEETS_AX_ERROR'.split(' '));
const chromePreflightNoErrorDetails=new Set('WINDOW_ID_DUPLICATE WINDOW_ID_READER_MISSING WINDOW_ID_UNAVAILABLE SHEETS_DEADLINE'.split(' '));
const chromePreflightFallbackCodes=new Set('ENTRY_VALUE_PRESENT DEADLINE PERMISSION_CHANGED TIMEOUT_SETUP_FAILED WINDOW_ROLE_READ_FAILED WINDOW_ROLE_INVALID CHILDREN_READ_FAILED CHILDREN_INVALID CHILDREN_EMPTY CHILDREN_LIMIT CHILD_IDENTITY_INVALID CHILD_ROLE_READ_FAILED CHILD_ROLE_INVALID CHILD_ROLE_DISALLOWED CHILD_PARENT_READ_FAILED CHILD_PARENT_INVALID SNAPSHOT_CHANGED'.split(' '));
const chromeEmptyWindowRelations=new Set('SAME OTHER UNKNOWN PROCESS_CHANGED ANCHOR_MISSING'.split(' '));
const chromeEmptyWindowSubroles=new Set('STANDARD DIALOG UNKNOWN'.split(' '));
function chromeEmptyWindowFields(fields){
 const safe={};
 if(chromeEmptyWindowRelations.has(fields.window_relation))safe.window_relation=fields.window_relation;
 for(const key of ['empty_window_minimized','empty_window_main','empty_window_focused','app_active','app_hidden'])if(typeof fields[key]==='boolean')safe[key]=fields[key];
 if(chromeEmptyWindowSubroles.has(fields.window_subrole))safe.window_subrole=fields.window_subrole;
 return safe;
}
// Optional failure categories never carry raw AX values, window labels or paths.
// Invalid detail is omitted while the original stopped outcome remains valid.
export function chromeInstallFailureFields(fields){
 if(!fields||fields.stage!=='preparing'||fields.outcome!=='stopped')return {};
 const {detail_code,ax_error,code}=fields;
 if(!(code==='CHROME_INSTALL_TARGET_UNKNOWN'&&chromePreflightTargetDetails.has(detail_code)||code==='CHROME_INSTALL_SHEET_UNKNOWN'&&chromePreflightSheetDetails.has(detail_code)))return {};
 if(chromePreflightNoErrorDetails.has(detail_code))return ax_error===undefined?{detail_code}:{};
 if(!Number.isInteger(ax_error)||ax_error < -2147483648||ax_error > 2147483647)return {};
 if(detail_code==='SHEETS_NOVALUE_WITH_VALUE')return ax_error===-25212?{detail_code,ax_error}:{};
 if(chromePreflightErrorDetails.has(detail_code)){
  if(ax_error===0||detail_code==='SHEETS_AX_ERROR'&&ax_error===-25212)return {};
  const fallback=detail_code==='SHEETS_AX_ERROR'&&ax_error===-25205&&chromePreflightFallbackCodes.has(fields.fallback_code)?fields.fallback_code:null;
  return {detail_code,ax_error,...(fallback?{fallback_code:fallback,...(fallback==='CHILDREN_EMPTY'?chromeEmptyWindowFields(fields):{})}:{})};
 }
 return ax_error===0?{detail_code,ax_error}:{};
}
export function chromeInstallFields(fields){
 const {stage,code,ms,target_is_default,outcome}=fields;
 if(!chromeInstallStages.has(stage)||!chromeInstallCodes.has(code)||!chromeInstallOutcomes.has(outcome)||!Number.isSafeInteger(ms)||ms<0||ms>chromeInstallDurationLimit(stage)||(target_is_default!==null&&typeof target_is_default!=='boolean'))return null;
 const access=code==='CHROME_DATA_ACCESS_DENIED'?chromeAccessFields(fields):null;
 return {stage,code,ms,target_is_default,outcome,...(access||{}),...chromeInstallFailureFields(fields)};
}
export class DiagnosticEvents{
 constructor(stateDir,{salt=installationSalt(stateDir),maxBytes=2*1024*1024,retain=5,now=Date.now,tools=[]}={}){Object.assign(this,{stateDir,salt,maxBytes,retain,now});this.tools=new Set(tools);this.write_failures=0;this.startupEvents=[];this.connectionEvents=[];}
 timelineSnapshot(){return this.connectionEvents.map(entry=>({...entry}));}
 startupSnapshot(){return this.startupEvents.map(entry=>({...entry}));}
 hash(value){return crypto.createHmac('sha256',this.salt).update(String(value)).digest('hex').slice(0,24);}
 record(kind,fields={}){
  if(!Object.hasOwn(schema,kind))return false;
  try{
   const entry={at:new Date(this.now()).toISOString(),kind};
   if(kind==='onboarding.step'){const safe=onboardingFields(fields);if(!safe)return false;Object.assign(entry,safe);}
   if(kind==='chrome.install'){const safe=chromeInstallFields(fields);if(!safe)return false;Object.assign(entry,safe);}
   if(kind==='mcp.resource'){const safe=resourceDiagnosticFields(fields);if(!safe)return false;Object.assign(entry,safe);}
   for(const key of schema[kind]){const v=fields[key];if(v===undefined||v===null)continue;
    if(kind==='conn.startup'&&startupFields[key]){if(startupFields[key].has(v))entry[key]=v;}
    else if(key==='task'||key==='job'){if(typeof v==='string')entry[key]=this.hash(v);}
    else if(numeric.has(key)){if(Number.isSafeInteger(v)&&v>=0)entry[key]=v;}
    else if(boolean.has(key)){if(typeof v==='boolean')entry[key]=v;}
    else if(key==='codes'){const valid=validCardErrors({n:fields.n,codes:v});if(valid)entry.codes=valid.codes;}
    else if(key==='code'){if(typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,60}$/.test(v))entry[key]=v;}
    else if(key==='tool'){if(this.tools.has(v))entry[key]=v;}
    else if(typeof v==='string'&&values.has(v))entry[key]=v;
   }
   if(kind.startsWith('conn.')){this.connectionEvents.push({...entry});this.connectionEvents=this.connectionEvents.slice(-200);}
   if(kind==='conn.startup'){this.startupEvents.push({...entry});this.startupEvents=this.startupEvents.slice(-100);}
   const dir=diagnosticDirectory(this.stateDir),file=path.join(dir,'events.jsonl'),line=JSON.stringify(entry)+'\n';
   const existing=f=>{try{const st=fs.lstatSync(f);if(!safeFile(st))throw Error('unsafe event file');return st;}catch(e){if(e.code==='ENOENT')return null;throw e;}};
   const st=existing(file);
   // retain is the total number of files, including the active file.
   if(st&&st.size+Buffer.byteLength(line)>this.maxBytes){
    for(let i=this.retain-1;i>=1;i--){const f=file+'.'+i;if(existing(f)){if(i===this.retain-1)fs.unlinkSync(f);else fs.renameSync(f,file+'.'+(i+1));}}
    if(this.retain>1)fs.renameSync(file,file+'.1');else fs.unlinkSync(file);
   }
   const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
   try{if(!safeFile(fs.fstatSync(fd)))throw Error('unsafe event handle');fs.writeSync(fd,line);}finally{fs.closeSync(fd);}
   return true;
  }catch{this.write_failures++;return false;}
 }
}

/** Bounded read and reconstruction. Never export arbitrary event or trace bytes. */
function readProjectedDiagnosticEvents(stateDir,project,finish,{limit=500,maxBytes=2*1024*1024,retain=5}={}){
 const rows=[];let unreadable=0,bytes=0,truncated=false;
 limit=Number.isSafeInteger(limit)?Math.max(0,Math.min(500,limit)):500;
 maxBytes=Number.isSafeInteger(maxBytes)?Math.max(0,Math.min(2*1024*1024,maxBytes)):2*1024*1024;
 retain=Number.isSafeInteger(retain)?Math.max(1,Math.min(5,retain)):5;
 const dir=path.join(stateDir,'diagnostics');
 try{const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())return {events:[],unreadable:1,truncated:false};}catch{return {events:[],unreadable:0,truncated:false};}
 for(let i=0;i<retain;i++){
  const file=path.join(dir,'events.jsonl'+(i?'.'+i:''));let fd;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!safeFile(st))throw Error('unsafe');
   const size=Math.min(st.size,maxBytes-bytes);if(size<=0){truncated=true;break;}
   const data=Buffer.alloc(size),start=st.size-size;fs.readSync(fd,data,0,size,start);bytes+=size;
   let lines=data.toString('utf8').split('\n');if(start>0){lines.shift();truncated=true;}
   const found=lines.flatMap(line=>{try{const v=project(JSON.parse(line));return v?[v]:[];}catch{return [];}});
   rows.unshift(...found);
  }catch(e){if(e.code!=='ENOENT')unreadable++;}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 if(rows.length>limit)truncated=true;
 return {events:limit===0?[]:finish(rows,{limit}),unreadable,truncated};
}


export function readOnboardingEvents(stateDir,options={}){
 return readProjectedDiagnosticEvents(stateDir,onboardingEntry,projectOnboardingEntries,options);
}

/** Only independently revalidated installation metadata may leave the local log. */
export function readChromeInstallEvents(stateDir,options={}){
 const project=entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||entry.kind!=='chrome.install'||typeof entry.at!=='string'||entry.at.length!==24)return null;
  const at=new Date(entry.at);if(!Number.isFinite(at.getTime())||at.toISOString()!==entry.at)return null;
  const safe=chromeInstallFields(entry);return safe?{at:entry.at,kind:'chrome.install',...safe}:null;
 };
 return readProjectedDiagnosticEvents(stateDir,project,(rows,{limit})=>limit===0?[]:rows.slice(-limit),options);
}

/** Revalidate persisted connection/watch categories before diagnostic export. */
export function readConnectionTimeline(stateDir,options={}){
 const project=value=>{
  if(!value||typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||!['conn.startup','conn.cloud','conn.restart','conn.state','conn.unhealthy','conn.grace','site.watch'].includes(value.kind))return null;
  const out={at:new Date(value.at).toISOString(),kind:value.kind};
  for(const key of schema[value.kind]){const v=value[key];if(numeric.has(key)){if(Number.isSafeInteger(v)&&v>=0)out[key]=v;}else if(key==='code'){if(typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,60}$/.test(v))out[key]=v;}else if(typeof v==='string'&&values.has(v))out[key]=v;}
  return out;
 };
 return readProjectedDiagnosticEvents(stateDir,project,(rows,{limit})=>rows.sort((a,b)=>a.at.localeCompare(b.at)).slice(-limit),options);
}
const nativePhases=new Set('launch exit backend recovery uninstall startup instance relaunch'.split(' '));
const nativeCodes=new Set('INSTANCE_MARKED_QUITTING INSTANCE_QUIT_MARK_FAILED INSTANCE_WAIT_QUITTING INSTANCE_QUITTING_GONE INSTANCE_QUITTING_TIMEOUT INSTANCE_STALE_QUIT_RECORD REOPEN_DURING_QUIT REOPEN_HELPER_FAILED REOPEN_HELPER_READY REOPEN_HELPER_TIMEOUT REOPEN_WAIT_OLD REOPEN_OLD_GONE REOPEN_USE_NEW_OWNER REOPEN_STARTED INSTANCE_CLAIMED INSTANCE_WAKE_EXISTING INSTANCE_RUNNING_BUILD_UNKNOWN INSTANCE_STOP_OLDER INSTANCE_OLD_GONE INSTANCE_START_FAILED INSTANCE_PID_UNKNOWN INSTANCE_IDENTITY_CHANGED INSTANCE_STOP_DENIED INSTANCE_STOP_TIMEOUT INSTANCE_LOCK_BUSY INSTANCE_LOCK_UNSAFE INSTANCE_ENUMERATION_FAILED INSTANCE_ISOLATION_REQUIRED INSTANCE_SIGNATURE_UNKNOWN INSTANCE_SCOPE_MISSING RELAUNCH_SIGNATURE_UNKNOWN RELAUNCH_CANCELLED RELAUNCH_START_TIMEOUT RELAUNCH_FAILED ORPHAN_ALREADY_CLOSED ORPHAN_GRACEFUL_TIMEOUT ORPHAN_TERM_TIMEOUT ORPHAN_SHUTDOWN ORPHAN_FORCE_KILL ORPHAN_TERM_FALLBACK ORPHAN_GONE ORPHAN_IDENTITY_UNKNOWN ORPHAN_OWNER_STILL_RUNNING ORPHAN_STOP_DENIED ORPHAN_STOP_TIMEOUT RELAUNCH_REQUESTED RELAUNCH_BEGIN RELAUNCH_PID_GONE RELAUNCH_STARTED RELAUNCH_SOURCE_UNKNOWN RELAUNCH_TARGET_INVALID RELAUNCH_TARGET_MISSING RELAUNCH_START_FAILED RELAUNCH_INSTANCES_REMAIN RELAUNCH_HANDSHAKE_MISSING RELAUNCH_BUSY RELAUNCH_HELPER_MISSING APP_LAUNCH APP_WILL_TERMINATE QUIT_REQUESTED OWNER_PIPE_CLOSING NATIVE_TERMINATE BACKEND_EXIT RECOVERY_SUPPRESSED RECOVERY_EXHAUSTED RECOVERY_SCHEDULED UNINSTALL_BUSY APP_SHUTTING_DOWN CONFIRM_SHOWN CONFIRM_CANCELLED SERVICE_START INITIAL_START_TIMEOUT STARTUP_BACKEND_EXIT SERVICE_ATTACHED'.split(' '));
const uninstallPhases=new Set('uninstall_plan uninstall_upgrade uninstall_revoke uninstall_login uninstall_backend uninstall_host uninstall_host_backup uninstall_skill uninstall_cache uninstall_preferences uninstall_data uninstall_app uninstall_app_backup uninstall_audit uninstall_window uninstall_result'.split(' '));
const uninstallCodes=new Set('CHROME_DATA_ACCESS_DENIED PLAN_STARTED SERVICE_NOT_OWNED STARTED LOCKED REMOVED LOGIN_ITEM_IDENTITY LOGIN_ITEM_REMAINS ACCESS_DENIED LOGIN_ITEM_REMOVE_FAILED SHUTDOWN_REQUESTED OWNER_PIPE_CLOSED WAITING_BACKEND BACKEND_EXITED HELPER_TERM_REQUESTED RUNTIME_EXITED STOPPED BACKEND_TIMEOUT PROCESS_ENUMERATION_FAILED PROCESS_SIGNAL_FAILED BACKEND_STOP_FAILED PREFERENCES_CLEARED PREFERENCES_SYNC_FAILED CLOSED NOT_FOUND FOREIGN_RETAINED BACKEND_RUNNING UNSUPPORTED_LOCATION IDENTITY_FAILED UNSAFE_PATH TARGET_CHANGED UPGRADE_BUSY IO_FAILED AUDIT_UNAVAILABLE DATA_KEPT REMAINDER COMPLETED PARTIAL'.split(' '));
const uninstallRevokeCodes=new Set(['CONFIRMED','UNCONFIRMED','SKIPPED']);
/** Infer only from the product's standard data layout. Never use os.homedir()
 * as a fallback for temporary/rehearsal state or a caller-provided partial path. */
export function uninstallAuditRootForState(stateDir){
 if(typeof stateDir!=='string'||!path.isAbsolute(stateDir))return null;
 const resolved=path.resolve(stateDir),parts=resolved.split(path.sep);
 if(!['data','v05'].includes(parts.at(-1))||parts.at(-2)!=='ChatHand'||parts.at(-3)!=='Application Support'||parts.at(-4)!=='Library')return null;
 const home=parts.slice(0,-4).join(path.sep)||path.sep;
 if(home===path.sep)return null;
 return path.join(home,'Library/Logs/ChatHand/uninstall');
}
function nativeEntry(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||!(nativePhases.has(v.phase)&&nativeCodes.has(v.code)||uninstallPhases.has(v.phase)&&(v.phase==='uninstall_revoke'?uninstallRevokeCodes.has(v.code):uninstallCodes.has(v.code)))||typeof v.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v.at)||!Number.isFinite(Date.parse(v.at)))return null;
 const row={at:new Date(v.at).toISOString(),phase:v.phase,code:v.code};
 for(const key of ['build','pid','native_pid','backend_pid','attempt'])if(Number.isSafeInteger(v[key])&&v[key]>=0)row[key]=v[key];
 if(typeof v.generation==='string'&&/^[a-f0-9-]{36}$/i.test(v.generation))row.generation=v.generation;
 if(v.code==='CHROME_DATA_ACCESS_DENIED'){const access=chromeAccessFields(v);if(access)Object.assign(row,access);}
 return row;
}
function readNativeDirectory(directory,{audit=false}={}){
 const events=[];let unreadable=0,truncated=false;
 try{const dir=fs.lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||audit&&fs.realpathSync(directory)!==path.resolve(directory))return {events:[],unreadable:1,truncated:false};}
 catch(e){return {events:[],unreadable:e.code==='ENOENT'?0:1,truncated:false};}
 for(const suffix of ['.previous','']){const file=path.join(directory,'native-events.jsonl'+suffix);let fd;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!safeFile(st))throw Error('unsafe');const size=Math.min(st.size,512*1024),buf=Buffer.alloc(size);fs.readSync(fd,buf,0,size,st.size-size);const lines=buf.toString('utf8').split('\n');if(st.size>size){lines.shift();truncated=true;}for(const line of lines)try{const row=nativeEntry(JSON.parse(line));if(row)events.push(row);}catch{}}
  catch(e){if(e.code!=='ENOENT')unreadable++;}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 return {events,unreadable,truncated};
}
/** Manual export reads only two fixed files in state and, when eligible, in the
 * same installation home's independent uninstall audit directory. */
export function readNativeTimeline(stateDir,{auditRoot}={}){
 const state=readNativeDirectory(path.join(stateDir,'diagnostics'));
 const root=auditRoot===undefined?uninstallAuditRootForState(stateDir):typeof auditRoot==='string'&&path.isAbsolute(auditRoot)?auditRoot:null;
 const audit=root?readNativeDirectory(path.join(root,'diagnostics'),{audit:true}):{events:[],unreadable:0,truncated:false};
 const unique=[...new Map([...state.events,...audit.events].map(row=>[JSON.stringify(row),row])).values()].sort((a,b)=>a.at.localeCompare(b.at));
 return {events:unique.slice(-200),unreadable:state.unreadable+audit.unreadable,truncated:state.truncated||audit.truncated||unique.length>200,uninstall_audit:{eligible:!!root,events:audit.events.length,unreadable:audit.unreadable,truncated:audit.truncated}};
}

export function readResourceTimeline(stateDir,options={}){
 return readProjectedDiagnosticEvents(stateDir,entry=>{if(entry?.kind!=='mcp.resource'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry.at||''))return null;const safe=resourceDiagnosticFields(entry);return safe?{at:entry.at,...safe}:null;},(rows,{limit})=>rows.sort((a,b)=>a.at.localeCompare(b.at)).slice(-limit),options);
}
