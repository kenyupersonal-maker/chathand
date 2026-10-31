/** Categorical local observations only. No payload, identity, URL, path or receipt. */
import crypto from 'node:crypto';
export const ONBOARDING_FIELDS=Object.freeze(['step','phase','result','error_code','actor','wait_ms','source','span','observed_at']);
// Exact product codes only: never a regex that could preserve an arbitrary secret.
const knownErrors=new Set(`ARG_INVALID APP_NOT_RUNNING RUNTIME_UNSAFE RUNTIME_INVALID STATE_DIR_INVALID
OWNER_UNREACHABLE OWNER_RESPONSE_INVALID OWNER_REQUEST_FAILED PLATFORM_UNSUPPORTED
CLIPBOARD_NOT_A_KEY CLIPBOARD_SOURCE_REQUIRED CLIPBOARD_UNAVAILABLE KEY_INVALID KEY_EXPIRED KEY_SAVE_UNCONFIRMED
TUNNEL_ID_INVALID CONNECTION_NEEDS_LOGIN CONNECTION_NEEDS_RETRY CONNECTION_PENDING
SITE_LINE_INVALID SITE_LINE_STDIN_ONLY SITE_LINE_STDIN_REQUIRED SITE_SETUP_UNCONFIRMED SITE_PAIRING_FAILED
B_GRANT_EXPIRED B_HEALTH_LIFECYCLE_CHANGED B_ORIGIN_INVALID B_PAIRING_ATTEMPT_EXPIRED B_PAIRING_BINDING
B_PAIRING_BINDING_STALE B_PAIRING_CONFIG B_PAIRING_GENERATION_ROLLBACK B_PAIRING_INPUT B_PAIRING_INTENT_MISSING
B_PAIRING_INTENT_EXPIRED B_PAIRING_MISSING B_PAIRING_PARTIAL_COMMIT B_PAIRING_RECEIPT B_PAIRING_RECEIPT_SIGNATURE
B_PAIRING_SIGNATURE B_PAIR_RECOVERY_PENDING B_PAIR_RECOVERY_UNCONFIRMED B_SITE_COMMIT_PENDING B_SITE_TARGET_UNVERIFIED
B_SITE_TRANSPORT_UNAVAILABLE B_TEMPLATE_MISMATCH B_TEMPLATE_UNVERIFIED B_SITE_REQUEST_TIMEOUT B_SITE_NETWORK_FAILED
B_REMOTE_TRANSIENT AUTH_REQUIRED PERMISSION_DENIED SETUP_APP_PATH_UNAVAILABLE SETUP_ROUTE_INVALID SKILL_PATH_LINK
TOOLS_REFRESH_BUSY TOOLS_REFRESH_NOT_PENDING TOOLS_REFRESH_NUMBER_INVALID TOOLS_REFRESH_DANGEROUS
TOOLS_LIST_PROOF_UNAVAILABLE TOOLS_LIST_PROOF_SAVE_FAILED HOST_UI_ERROR CONSENT_DIALOG VERIFY_EXCEPTION
BROWSER_TIMEOUT BROWSER_BUSY PAGE_HELPER_FAILED SNAPSHOT_STALE ELEMENT_REF_COLLISION HELPER_TIMEOUT
MAC_REQUIRED USE_INSTALL_OR_RECOVER DESTINATION_APP_REQUIRED WRONG_DESTINATION_APP_ID WRONG_APP_ID
MANIFEST_VERSION_MISMATCH LOCAL_STEP_FAILED TASKS_RUNNING_FINISH_THEM_FIRST OLD_CONNECTOR_API_UNKNOWN
NEW_APP_NOT_READY VERSION_MISMATCH TOOLS_MISMATCH UPGRADE_GUARD_NOT_ACTIVE CONNECTION_NOT_RESTORED
RELAY_NOT_RESTORED ROLLBACK_FAILED RECOVERY_TARGET_MISMATCH UPGRADE_FAILED RECOVERY_FAILED
SETTING_NOT_RETAINED_BROWSER SETTING_NOT_RETAINED_ACTIVE SETTING_NOT_RETAINED_MODE
SETTING_NOT_RETAINED_PROJECTS SETTING_NOT_RETAINED_ACCESS_ENABLED SETTING_NOT_RETAINED_NOTIFICATIONS
SETTING_NOT_RETAINED_AUTO_CONNECT SETTING_NOT_RETAINED_CONNECTION_PREFERENCE SETTING_NOT_RETAINED_TUNNEL
SETTING_NOT_RETAINED_APPEARANCE SETTING_NOT_RETAINED_AUTO_UPDATE SETTING_NOT_RETAINED_SKIN
SETTING_NOT_RETAINED_SHOW_VALUE SETTING_NOT_RETAINED_VALUE_PLAN SETTING_NOT_RETAINED_HIGH_RISK
SETTING_NOT_RETAINED_ADMIN_REQUESTED`.split(/\s+/));
const timeoutErrors=new Set(['B_SITE_REQUEST_TIMEOUT','BROWSER_TIMEOUT','HELPER_TIMEOUT']);
export function onboardingErrorCode(error){
 const candidates=typeof error==='string'?[error]:[error?.code,error?.message];
 return candidates.find(code=>knownErrors.has(code))||'UNKNOWN';
}
export function onboardingFailure(error){const error_code=onboardingErrorCode(error);return {result:timeoutErrors.has(error_code)?'timeout':'failed',error_code};}
const sets={
 step:new Set('installer setup_conversation setup_skill setup_doctor setup_connect setup_site first_launch_guidance permission_accessibility permission_screen_recording site_deploy site_pair tools_refresh first_tool_call'.split(' ')),
 phase:new Set(['start','end']),result:new Set('pending ok failed timeout cancelled unknown skipped unobservable'.split(' ')),
 error_code:new Set([...knownErrors,...'NONE UNKNOWN UNOBSERVABLE CANCELLED INVALID_REQUEST LOCAL_FAILED HOST_UNCONFIRMED PERMISSION_PENDING PAIRING_PENDING TOOLS_LIST_UNCONFIRMED'.split(' ')]),
 actor:new Set('ai user_click system_dialog unknown'.split(' ')),source:new Set('installer native server setup_skill tools_refresh mcp manual'.split(' '))
};
export function validOnboardingTimestamp(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
export function onboardingFields(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!ONBOARDING_FIELDS.includes(k)))return null;
 const out={};for(const [key,allowed] of Object.entries(sets)){if(!allowed.has(input[key]))return null;out[key]=input[key];}
 if(!Number.isSafeInteger(input.wait_ms)||input.wait_ms<0||input.wait_ms>7*86400000||typeof input.span!=='string'||!/^o_[a-f0-9]{24}$/.test(input.span))return null;
 if(input.phase==='start'&&(input.result!=='pending'||input.wait_ms!==0||input.error_code!=='NONE'))return null;
 if(input.observed_at!==undefined&&!validOnboardingTimestamp(input.observed_at))return null;
 return {...out,wait_ms:input.wait_ms,span:input.span,...(input.observed_at!==undefined?{observed_at:input.observed_at}:{})};
}
export function onboardingEntry(input){
 const value=onboardingFields(Object.fromEntries(ONBOARDING_FIELDS.map(k=>[k,input?.[k]])));
 if(!value||input?.kind!=='onboarding.step'||typeof input.at!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.at)||!Number.isFinite(Date.parse(input.at)))return null;
 return {at:input.at,kind:'onboarding.step',...value};
}
/** Retried native delivery has one identity; raw append-only evidence stays intact. */
export function projectOnboardingEntries(entries,{limit=500}={}){
 limit=Number.isSafeInteger(limit)?Math.max(0,Math.min(500,limit)):500;
 if(!Array.isArray(entries)||limit===0)return [];
 const unique=new Map();
 for(const entry of entries.slice(-20000)){
  const safe=onboardingEntry(entry);if(!safe)continue;
  const identity=JSON.stringify([safe.span,safe.phase,safe.observed_at??safe.at]);
  if(!unique.has(identity))unique.set(identity,safe); // Preserve earliest locally received copy.
 }
 return [...unique.values()].slice(-limit);
}
export class OnboardingTelemetry{
 constructor(events,{now=Date.now}={}){this.events=events;this.now=now;}
 record(fields){try{return this.events?.record('onboarding.step',fields);}catch{return false;}}
 begin(step,{actor='unknown',source='server'}={}){
  const started=this.now(),span='o_'+crypto.randomBytes(12).toString('hex');let ended=false;
  const base={step,actor,source,span};this.record({...base,phase:'start',result:'pending',error_code:'NONE',wait_ms:0});
  return (result='ok',error_code='NONE')=>{if(ended)return;ended=true;const elapsed=this.now()-started;this.record({...base,phase:'end',result,error_code,wait_ms:Math.min(7*86400000,Math.max(0,Math.trunc(elapsed)))});};
 }
 async run(step,work,options={}){
  const end=this.begin(step,options);
  try{const value=await work();const status=options.classify?.(value)||{result:'ok',error_code:'NONE'};end(status.result,status.error_code);return value;}
  catch(error){const failure=onboardingFailure(error);end(failure.result,failure.error_code);throw error;}
 }
}
