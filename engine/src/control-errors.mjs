/** Error detail contracts only. Unknown fields and raw action arguments never pass. */
export const DESKTOP_ERROR_CODES = Object.freeze(["ACCESSIBILITY_REQUIRED", "APP_NOT_AVAILABLE", "ARG_INVALID", "CAPABILITY_OFF", "COMPUTER_ACTION_UNCONFIRMED", "COMPUTER_ACTION_UNKNOWN", "COMPUTER_BATCH_ELEMENT_REQUIRED", "COMPUTER_BUSY", "COMPUTER_CAPTURE_REQUIRED", "COMPUTER_CAPTURE_STALE", "COMPUTER_CONFIRM_REQUIRED", "COMPUTER_ELEMENT_DISABLED", "COMPUTER_ELEMENT_FOCUS_FAILED", "COMPUTER_ELEMENT_STALE", "COMPUTER_FAILED", "COMPUTER_FOCUS_FAILED", "COMPUTER_FOREGROUND_CANCELLED", "COMPUTER_IMAGE_INVALID", "COMPUTER_OBSERVATION_INVALID", "COMPUTER_OBSERVATION_STALE", "COMPUTER_OPEN_UNCONFIRMED", "COMPUTER_PATH_SCOPE_REQUIRED", "COMPUTER_REQUEST_EXPIRED", "COMPUTER_TIMEOUT", "COMPUTER_WINDOW_AMBIGUOUS", "COMPUTER_WINDOW_MISSING", "COMPUTER_WINDOW_STALE", "COORDINATES_INVALID", "DISPLAY_MISSING", "ELEMENT_ACTION_UNSUPPORTED", "FILE_CHANGED", "FOCUS_CHANGED", "IMAGE_TOO_LARGE", "KEY_UNSUPPORTED", "LOCAL_USER_REQUIRED", "NATIVE_COMPUTER_OFFLINE", "NATIVE_STEP_AUTHORIZATION_REQUIRED", "PATH_INVALID", "SCREEN_CAPTURE_FAILED", "SCREEN_RECORDING_REQUIRED", "SECURE_INPUT", "TASK_REVOKED", "TYPE_BLOCKED"]);
export const BROWSER_ERROR_CODES = Object.freeze(["ACTION_CANCELLED", "ACTION_UNSUPPORTED", "ARG_INVALID", "BATCH_INVALID", "BROWSER_ACTION_FAILED", "BROWSER_BACKEND_UNSUPPORTED", "BROWSER_BUSY", "BROWSER_CONFIRM_REQUIRED", "BROWSER_IN_USE", "BROWSER_PAGE_MISSING", "BROWSER_REQUEST_EXPIRED", "BROWSER_RESULT_TOO_LARGE", "BROWSER_TIMEOUT", "CANVAS_TARGET_REQUIRED", "CDP_ATTACH_BUSY", "CDP_ATTACH_TIMEOUT", "CDP_COMMAND_TIMEOUT", "CDP_DETACH_BUSY", "CDP_DETACH_TIMEOUT", "CROSS_ORIGIN_FRAME_UNSUPPORTED", "ELEMENT_AMBIGUOUS", "ELEMENT_CHANGED", "ELEMENT_DISABLED", "ELEMENT_FRAME_UNSUPPORTED", "ELEMENT_GEOMETRY", "ELEMENT_INVALID", "ELEMENT_REF_COLLISION", "EXTENSION_DISCONNECTED", "EXTENSION_NOT_CONNECTED", "EXTENSION_PROFILE_BUSY", "EXTENSION_SESSION_INVALID", "FILE_INPUT_REQUIRED", "FILE_TOO_LARGE", "FOCUS_TARGET_REQUIRED", "HOST_BINARY_MISSING", "HOST_REGISTRATION_FAILED", "HOST_REGISTRATION_INVALID", "INPUT_INVALID", "KEY_UNSUPPORTED", "PAGE_HELPER_FAILED", "PAGE_NOT_ALLOWED", "PERSONAL_DOWNLOAD_LOCATION", "PERSONAL_TAB_CONFIRM_REQUIRED", "SCREENSHOT_TOO_LARGE", "SELECT_FAILED", "SENSITIVE_INPUT", "SNAPSHOT_STALE", "STEP_ALREADY_ATTEMPTED", "TAB_INVALID", "TASK_REVOKED", "TOOL_UNKNOWN", "URL_BLOCKED", "WAIT_CONDITION_INVALID", "WAIT_TIMEOUT"]);
export const CONTROL_DETAIL_CODES = new Set([...DESKTOP_ERROR_CODES,...BROWSER_ERROR_CODES]);
// 1035: exact native target identity failure, including pre-dispatch failures
// without B2 method metadata. Keep the frozen legacy desktop/browser tables.
export const isControlDetailCode=code=>CONTROL_DETAIL_CODES.has(code)||code==='TARGET_CHANGED';
const isDesktopDetailCode=code=>DESKTOP_ERROR_CODES.includes(code)||code==='TARGET_CHANGED';

const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
// Only fixed native dispatch provenance survives a late authorization failure.
// It reports an attempted action; it never grants permission or authorizes replay.
export function foregroundDeliveryDetails(value){
 const sources=[value,value?.error?.details,value?.failure?.details].filter(plain);
 const counts=sources.map(v=>v.foreground_input_events).filter(v=>Number.isInteger(v)&&v>0&&v<=100000);
 if(!counts.length)return null;
 const reason=sources.map(v=>v.focus_reason).find(v=>['front_app_changed','surface_changed','focused_surface_changed'].includes(v));
 return {foreground_input_events:Math.max(...counts),delivery_unconfirmed:true,do_not_replay:true,...(reason?{focus_reason:reason}:{})};
}
// A late authorization failure may follow an already-posted B2 click. Only
// this fixed uncertainty marker survives; arbitrary native content never does.
export function backgroundDeliveryDetails(value){
 if(!plain(value)||value.method!=='background_target_click'||value.background!==true||
    value.delivery_status!=='posted_unconfirmed'||value.delivery_unconfirmed!==true||value.do_not_replay!==true)return null;
 return {method:'background_target_click',background:true,delivery_status:'posted_unconfirmed',delivery_unconfirmed:true,do_not_replay:true};
}
const lateAuthorizationCodes=new Set(['ROOT_CHANGED','RESULT_REVOKED','LOCAL_DISABLED','CONNECTION_RECONNECTING','TASK_MISSING','TASK_PENDING_APPROVAL','TASK_COMPLETED','TASK_FAILED','TASK_EXPIRED','TASK_SUPERSEDED','TASK_REJECTED','TASK_CANCELLED']);
export const isLateAuthorizationCode=code=>lateAuthorizationCodes.has(code);
const text=(value,redact,max=600)=>typeof value==='string'?redact(value).slice(0,max):undefined;
const pick=(value,strings,booleans,numbers,redact)=>{
 if(!plain(value))return {};
 const out={};
 for(const [key,max] of Object.entries(strings)){const s=text(value[key],redact,max);if(s!==undefined)out[key]=s;}
 for(const key of booleans)if(typeof value[key]==='boolean')out[key]=value[key];
 for(const key of numbers)if(Number.isFinite(value[key]))out[key]=value[key];
 return out;
};
const frame=value=>{if(!plain(value)||!['x','y','width','height'].every(k=>Number.isFinite(value[k]))||value.width<=0||value.height<=0)return undefined;return Object.fromEntries(['x','y','width','height'].map(k=>[k,value[k]]));};
const app=(value,redact)=>pick(value,{bundle_id:180,name:180},[],['pid'],redact);
const element=(value,redact)=>{
 const out=pick(value,{ref:96,role:80,name:400,value:1200,text:1200},['enabled','interactive','sensitive','consequential'],[],redact);
 if(value?.sensitive===true)for(const key of ['name','value','text'])if(key in out)out[key]='';
 if(['ax','ocr'].includes(value?.source))out.source=value.source;
 const f=frame(value?.frame);if(f)out.frame=f;return out;
};
const windows=(value,redact)=>Array.isArray(value)?value.slice(0,40).filter(plain).map(item=>{
 const out=pick(item,{window_id:96,bundle_id:180,title:600},['active','minimized'],['pid'],redact);const f=frame(item.frame);if(f)out.frame=f;return out;
}):undefined;
function observation(value,redact){
 const out=pick(value,{observation_id:96,native_snapshot_id:96,capture_id:96,window_id:96,target_bundle:180,front_bundle:180,window_title:600,tree:14000,text:14000,cacheScope:16},['truncated','untrusted_content','observation_unavailable'],['target_pid','ttlMs','expires_in_seconds'],redact);
 const f=frame(value?.frame);if(f)out.frame=f;
 if(plain(value?.front_app))out.front_app=app(value.front_app,redact);
 if(Array.isArray(value?.elements))out.elements=value.elements.slice(0,700).filter(plain).map(v=>element(v,redact));
 const w=windows(value?.windows,redact);if(w)out.windows=w;
 return out;
}
function changes(value,redact){
 const out=pick(value,{title:600,text_excerpt:2000},['title_changed','text_changed'],[],redact);
 for(const key of ['new_windows','dialogs']){const w=windows(value?.[key],redact);if(w)out[key]=w;}
 if(plain(value?.front_app))out.front_app=app(value.front_app,redact);
 if(plain(value?.focused_element))out.focused_element=element(value.focused_element,redact);
 return out;
}
// 1029 H：统一回执逐项精选；只解释被拦原因，不携带任意参数或授权内容。
export function blockedDetails(value,redact=v=>v){
 if(!plain(value)||value.version!==1||!['can_enable','needs_user','never'].includes(value.kind)||!['high_risk','common','admin_setup','scope','capability','system_permission','browser_helper','never'].includes(value.gate))return undefined;
 const out={version:1,kind:value.kind,gate:value.gate,item:pick(value.item,{id:80,name:160},[],[],redact),...pick(value,{cause:160,alternative:600,next:600},[],[],redact),effect:pick(value.effect,{can_do:600,risk:600},[],[],redact),where:value.kind==='never'?null:pick(value.where,{path:600,link:200},[],[],redact),confirm:null,say_to_user:Array.isArray(value.say_to_user)?value.say_to_user.filter(x=>typeof x==='string').slice(0,4).map(x=>text(x,redact,600)):[]};
 if(typeof value.answer_in_chat==='boolean')out.answer_in_chat=value.answer_in_chat;
 if(value.kind==='can_enable'&&plain(value.confirm)&&typeof value.confirm.id==='string'&&/^cf_[a-f0-9]{16}$/.test(value.confirm.id)&&Number.isFinite(value.confirm.expires_at))out.confirm={id:value.confirm.id,expires_at:value.confirm.expires_at,scopes:Array.isArray(value.confirm.scopes)?value.confirm.scopes.filter(x=>['once','always'].includes(x)).slice(0,2):[]};
 if(['denied','unknown'].includes(value.answer))out.answer=value.answer;
 return out;
}
export function controlErrorDetails(code,value,redact){
 if(!isControlDetailCode(code)||!plain(value))return null;
 const blocked=blockedDetails(value.blocked,redact);
 if(code==='CAPABILITY_OFF'){
  const names={terminal:'命令',browser:'浏览器控制',desktop:'桌面控制'},name=names[value.capability];
  if(!name)return null;
  const where_to_enable=`ChatHand 首页右边「权限与能力」→ ${name} → 打开开关`;
  return {capability:value.capability,name,enabled_now:false,where_to_enable,...(blocked?{blocked}:{}),...(foregroundDeliveryDetails(value)||{}),...(backgroundDeliveryDetails(value)||{}),instructions_for_ai:['不要重试，也不要换别的工具绕过。',`告诉用户这一步要用「${name}」，先 request_permission 放确认卡。`,'task_status（wait_ms:20000）最多6次；allowed才继续，denied换做法；仍等就task_checkpoint waiting_user，不finish_task。']};
 }
 const out=pick(value,{},['delivery_unconfirmed','do_not_replay','retry_after_user_action_only','snapshot_stale'],[],redact);
 // 1047: report the precise foreground gate without echoing titles, AX trees,
 // raw inputs or arbitrary diagnostic strings. Never authorize a replay here.
 if(isDesktopDetailCode(code)){
  if(['front_app_changed','surface_changed','focused_surface_changed'].includes(value.focus_reason))out.focus_reason=value.focus_reason;
  if(Number.isInteger(value.foreground_input_events)&&value.foreground_input_events>=0&&value.foreground_input_events<=100000)out.foreground_input_events=value.foreground_input_events;
 }
 // B2 is one fixed target-only click recipe. Never accept arbitrary method,
 // transport counts/statuses, action arguments, or browser claims of B2.
 if(isDesktopDetailCode(code)&&value.method==='background_target_click'&&value.background===true){
  out.method='background_target_click';out.background=true;
  for(const [key,max] of [['attempted_target_channels',10],['target_focus_records',2]])
   if(Number.isInteger(value[key])&&value[key]>=0&&value[key]<=max)out[key]=value[key];
  if(value.delivery_status==='posted_unconfirmed'&&value.delivery_unconfirmed===true&&value.do_not_replay===true)out.delivery_status='posted_unconfirmed';
  // Only a typed, bounded native B2 batch stop may expose aggregate progress.
  // No step parameters, labels, or model-controlled result body are reflected.
  if(value.batch_stopped===true&&Number.isInteger(value.remaining_steps)&&value.remaining_steps>=0&&value.remaining_steps<=9){
   out.batch_stopped=true;
   out.remaining_steps=value.remaining_steps;
   out.remaining_status='not_attempted';
  }
 }
 if(blocked)out.blocked=blocked;
 // Replay safety can only deny a replay; a remote payload cannot grant one.
 if(value.replay_safe===false)out.replay_safe=false;
 if(['connected','disconnected','not_installed'].includes(value.connection_state))out.connection_state=value.connection_state;
 if(['ChatHand →「浏览器控制」','ChatHand → 浏览器控制 → 重新连接'].includes(value.where_to_enable))out.where_to_enable=value.where_to_enable;
 if(typeof value.scope_note==='string'&&/^文件范围是『[^\r\n]{1,255}』：不要改动这个文件夹以外的文件；要下载、保存，存进这个文件夹。$/.test(value.scope_note))out.scope_note=text(value.scope_note,redact,600);
 if(code==='ELEMENT_AMBIGUOUS'||code==='ELEMENT_REF_COLLISION')if(Array.isArray(value.candidates))out.candidates=value.candidates.slice(0,20).filter(plain).map(v=>pick(v,{ref:96,role:80,name:400,frame_id:180},[],['ordinal','count'],redact));
 if(code==='BROWSER_CONFIRM_REQUIRED'){Object.assign(out,pick(value,{role:80,name:400},[],[],redact));if(['click','double_click','fill','select','select_value','press','scroll','scroll_to','wait_for'].includes(value.action))out.action=value.action;}
 if(code==='WAIT_TIMEOUT'){if(['text','text_absent','url_change','element','network_idle'].includes(value.condition))out.condition=value.condition;if(Number.isFinite(value.waited_ms)&&value.waited_ms>=0)out.waited_ms=Math.min(value.waited_ms,180000);}
 if(isDesktopDetailCode(code)){
  if(plain(value.observation))out.observation=observation(value.observation,redact);
  if(plain(value.changes))out.changes=changes(value.changes,redact);
 }
 return Object.keys(out).length?out:null;
}
const actions={
 CAPABILITY_OFF:'explain_to_user_and_wait',
 EXTENSION_NOT_CONNECTED:'explain_to_user_and_wait',EXTENSION_DISCONNECTED:'explain_to_user_and_wait',EXTENSION_PROFILE_BUSY:'explain_to_user_and_wait',HOST_BINARY_MISSING:'explain_to_user_and_wait',HOST_REGISTRATION_INVALID:'explain_to_user_and_wait',HOST_REGISTRATION_FAILED:'explain_to_user_and_wait',
 BROWSER_CONFIRM_REQUIRED:'wait_for_user',PERSONAL_TAB_CONFIRM_REQUIRED:'wait_for_user',SENSITIVE_INPUT:'wait_for_user',
 ELEMENT_AMBIGUOUS:'inspect_candidates_and_observe',ELEMENT_REF_COLLISION:'browser_snapshot',WAIT_TIMEOUT:'browser_snapshot',BROWSER_TIMEOUT:'browser_snapshot',SNAPSHOT_STALE:'browser_snapshot',BROWSER_PAGE_MISSING:'browser_tabs',STEP_ALREADY_ATTEMPTED:'browser_snapshot',CANVAS_TARGET_REQUIRED:'browser_screenshot',PAGE_HELPER_FAILED:'stop_and_report',BROWSER_BACKEND_UNSUPPORTED:'explain_to_user_and_wait',
 ACCESSIBILITY_REQUIRED:'explain_to_user_and_wait',SCREEN_RECORDING_REQUIRED:'explain_to_user_and_wait',NATIVE_COMPUTER_OFFLINE:'explain_to_user_and_wait',LOCAL_USER_REQUIRED:'wait_for_user',COMPUTER_FOREGROUND_CANCELLED:'wait_for_user',COMPUTER_CONFIRM_REQUIRED:'wait_for_user',SECURE_INPUT:'wait_for_user',
 ARG_INVALID:'stop_and_report',PATH_INVALID:'stop_and_report',TYPE_BLOCKED:'stop_and_report',KEY_UNSUPPORTED:'stop_and_report',COORDINATES_INVALID:'stop_and_report',COMPUTER_ACTION_UNKNOWN:'stop_and_report',COMPUTER_BATCH_ELEMENT_REQUIRED:'computer_observe',ELEMENT_ACTION_UNSUPPORTED:'stop_and_report',NATIVE_STEP_AUTHORIZATION_REQUIRED:'stop_and_report',TASK_REVOKED:'wait_for_user',
};
export function controlErrorRecovery(code){
 if(!isControlDetailCode(code))return null;
 const next_action=actions[code]||(isDesktopDetailCode(code)?'computer_observe':/TIMEOUT|ELEMENT_CHANGED|ELEMENT_INVALID|ELEMENT_DISABLED/.test(code)?'browser_snapshot':'stop_and_report');
 return {next_action,automatic_retry:false,create_new_task:false};
}
