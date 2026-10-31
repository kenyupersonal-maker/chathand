import {chromeDistribution,requireLegacyInstaller,storeMode} from './chrome-distribution.mjs';
import {chromeAccessFields} from './chrome-data-access.mjs';
import {chromeInstallFields,chromeInstallDurationLimit,chromeInstallFailureFields} from '../diagnostic-events.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
import {capabilityOn} from './permissions.mjs';
import {archiveInstallEvidence} from './chrome-install-evidence.mjs';

export const LEGACY_INSTALL_SOURCE_FILES=['manifest.json','background.js','driver.js','experience.js','page-helper.js','click-target.js','scroll-target.js','frame-tree.js','vendor/playwright-injected.js','popup.js','popup.html','popup.css'];
export const INSTALL_SOURCE_FILES=[...LEGACY_INSTALL_SOURCE_FILES,'locale.js','locale-catalogs.js','_locales/zh_CN/messages.json','_locales/en/messages.json','icons/chathand-16.png','icons/chathand-32.png','icons/chathand-48.png','icons/chathand-128.png'];
export const INSTALL_PROBE_PATH='/api/browser/extension/install/probe/';
function regular(file,root){
 const canonical=fs.realpathSync(file);if(canonical!==file||!(file===root||file.startsWith(root+path.sep)))fail('INSTALL_SOURCE_CHANGED','安装文件的来源不明确。');
 for(let cursor=file;;cursor=path.dirname(cursor)){if(fs.lstatSync(cursor).isSymbolicLink())fail('INSTALL_SOURCE_CHANGED','安装文件的来源不明确。');if(cursor===path.dirname(cursor))break;}
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>16*1024*1024)fail('INSTALL_SOURCE_CHANGED','安装文件不完整。');return fs.readFileSync(file);
}
export function helperFingerprint(folder,{olderThanBuild=null}={}){
 folder=path.resolve(folder);const hash=crypto.createHash('sha256');
 const manifest=JSON.parse(regular(path.join(folder,'manifest.json'),folder)),build=Number(String(manifest.version).split('.')[3]);
 const legacy=Number.isSafeInteger(olderThanBuild)&&Number.isSafeInteger(build)&&build>0&&build<olderThanBuild&&!manifest.default_locale;
 for(const name of legacy?LEGACY_INSTALL_SOURCE_FILES:INSTALL_SOURCE_FILES)hash.update(name).update('\0').update(regular(path.join(folder,name),folder)).update('\0');
 return hash.digest('hex');
}
export function installSource(root){
 root=path.resolve(root);if(fs.realpathSync(root)!==root)fail('INSTALL_SOURCE_CHANGED','安装目录的来源不明确。');
 const folder=path.join(root,'browser-extension'),hash=crypto.createHash('sha256');
 for(const name of INSTALL_SOURCE_FILES){hash.update(name).update('\0').update(regular(path.join(folder,name),root)).update('\0');}
 const manifest=JSON.parse(regular(path.join(folder,'manifest.json'),root));
 const pkg=JSON.parse(regular(path.join(root,'package.json'),root));
 if(Number(String(manifest.version).split('.')[3])!==pkg.kenBridge?.build_number)fail('INSTALL_SOURCE_CHANGED','安装文件版本不一致。');
 return {folder,fingerprint:hash.digest('hex'),version:manifest.version,build:pkg.kenBridge.build_number,host:{runtime_root:root,build:pkg.kenBridge.build_number,entry_sha256:crypto.createHash('sha256').update(regular(path.join(root,'app/v09/extension-host.mjs'),root)).digest('hex')}};
}
const activePhases=new Set(['loading','waiting_helper','probe_verified']);
const stages=new Set(['preparing','waiting_accessibility','opening_chrome','checking_profile','extensions','removing_copy','loading_directory','validating_helper']);
export const INSTALL_NATIVE_CODES=new Set(['BUSY','CANCELLED','INVALID_LEASE','SOURCE_MISMATCH','ACCESSIBILITY_REQUIRED','ACCESSIBILITY_TIMEOUT','CHROME_UNAVAILABLE','TARGET_UNKNOWN','FOCUS_UNKNOWN','SHEET_UNKNOWN','CONTROLS_UNKNOWN','PROFILE_UNKNOWN','CHROME_TOO_OLD','MANAGED_POLICY_BLOCKED','USER_INTERRUPTED','PERMISSION_CHANGED','TIMEOUT','INPUT_UNCONFIRMED','LOCAL_NETWORK','VERIFICATION_FAILED','NOT_INSTALLED','OTHER_PROFILE','NATIVE_HOST_NOT_CONNECTED','TARGET_HANDSHAKE_TIMEOUT'].map(code=>'CHROME_INSTALL_'+code));
INSTALL_NATIVE_CODES.add('CHROME_DATA_ACCESS_DENIED');
const fault=code=>fail(code,'Chrome 插件的安装已停止；请查看当前状态，不要重复原来的点击。');
const attemptID=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():null;
/** Private native installer lease. This never creates an AI task or grants a capability. */
export class ChromeInstallProbe{
 constructor({root,state,policy,extension,origin,ready=()=>true,audit=()=>{},diagnostic=()=>{},now=Date.now,ttl=90000,registrationOnlyAfterOptIn=false,browserOptIn=false,distribution=chromeDistribution()}){Object.assign(this,{root,state,policy,extension,origin,ready,audit,diagnostic,now,ttl,registrationOnlyAfterOptIn,browserOptIn,distribution});this.lease=null;this.nativeProgress=null;this.retiredAttempts=new Set();}
 note(event,details={}){
 const l=this.lease,ms=l?Math.max(0,Math.min(chromeInstallDurationLimit(l.stage),Math.round((l.finishedAt??this.now())-l.startedAt))):0;
 const metadata={stage:l?.stage||'preparing',code:details.code||({started:'CHROME_INSTALL_STARTED',stage:'CHROME_INSTALL_PROGRESS',helper_seen:'CHROME_INSTALL_PROGRESS',probe_verified:'CHROME_INSTALL_PROGRESS',completed:'CHROME_INSTALL_OK'}[event]||'CHROME_INSTALL_UNKNOWN'),ms,target_is_default:l?.targetIsDefault??false,outcome:event==='completed'?'completed':event==='stopped'?'stopped':event==='started'?'started':'running'};
 try{this.audit({event:'chrome_install_'+event,...details,...metadata});}catch{}
 try{this.diagnostic(metadata);}catch{}
 }
 nativeDiagnostic(data){requireLegacyInstaller(this.distribution);
  const {native_event,stage,code,elapsed_ms,target_is_default}=data;
  if(native_event==='choose_profile')return this.nativeProfileChoice(data);
  const defaultCode=native_event==='running'?'CHROME_INSTALL_PROGRESS':'CHROME_INSTALL_STARTED';
  if(!['started','running','stopped'].includes(native_event)||(native_event==='stopped'?!(INSTALL_NATIVE_CODES.has(code)||code==='CONFIRM_NOT_HUMAN'):code!==undefined&&code!==defaultCode))fault('INSTALL_STOPPED');
  const metadata=chromeInstallFields({stage,code:code||defaultCode,ms:elapsed_ms,target_is_default,outcome:native_event,detail_code:data.detail_code,ax_error:data.ax_error,fallback_code:data.fallback_code,
   window_relation:data.window_relation,empty_window_minimized:data.empty_window_minimized,empty_window_main:data.empty_window_main,empty_window_focused:data.empty_window_focused,app_active:data.app_active,app_hidden:data.app_hidden,window_subrole:data.window_subrole});
  if(!metadata||data.repair!==undefined&&typeof data.repair!=='boolean')fault('INSTALL_STOPPED');
  const id=data.attempt_id===undefined?null:attemptID(data.attempt_id);
  if(data.attempt_id!==undefined&&!id)fault('INSTALL_STOPPED');
  if(id&&(this.retiredAttempts.has(id)||activePhases.has(this.lease?.phase)))return {recorded:false,discarded:true};
  if(id&&stage!=='installed_verified'){
   const previous=this.nativeProgress;
   if(previous?.attempt_id!==id){
    if(native_event!=='started'||previous?.active)return {recorded:false,discarded:true};
    this.allowed();
    if(previous)this.retiredAttempts.add(previous.attempt_id);
    this.nativeProgress={attempt_id:id,phase:'loading',active:true,stage:null,code:null,repair:data.repair===true,target_is_default,epoch:this.policy.epoch,revision:this.policy.permissionRevision||0};
   }else{
    if(!this.nativeAttemptLive())return {recorded:false,discarded:true};
    // Duplicate starts and progress after a profile choice cannot restart a wait.
    if(native_event==='started'||previous.choose_profile&&native_event!=='stopped')return {recorded:false,discarded:true};
   }
   const p=this.nativeProgress;
   if(stage!=='installed_verified'){
    const sameStage=p.stage===stage,startedAt=this.now()-elapsed_ms,deadline=this.now()+chromeInstallDurationLimit(stage)-elapsed_ms;
    p.stageStartedAt=sameStage?Math.min(p.stageStartedAt,startedAt):startedAt;
    p.deadline=sameStage?Math.min(p.deadline,deadline):deadline;
    p.stage=stage;p.target_is_default=target_is_default;
    p.phase=native_event==='stopped'?'stopped':stage==='waiting_accessibility'?'waiting_accessibility':'loading';p.active=native_event!=='stopped';
    p.code=native_event==='stopped'?code:null;
    if(native_event==='stopped'){p.failureDetail=chromeInstallFailureFields(metadata);this.retiredAttempts.add(id);this.clearNativeChoice(p);}
   }
  }
  // Legacy metadata remains diagnostic-only. Attempt IDs and profile payloads never enter logs.
  try{this.audit({event:'chrome_install_native_'+native_event,...metadata});}catch{}
  try{this.diagnostic(metadata);}catch{}
  return {recorded:true};
 }
 clearNativeChoice(p){for(const key of ['choose_profile','profiles','selected_profile'])delete p[key];}
 nativeAttemptLive(){
  const p=this.nativeProgress;if(!p||this.retiredAttempts.has(p.attempt_id))return false;
  try{this.allowed();if(p.epoch!==this.policy.epoch||p.revision!==(this.policy.permissionRevision||0))fault('INSTALL_ACCESS_CHANGED');}
  catch{this.nativeStop('INSTALL_ACCESS_CHANGED');return false;}
  if(this.now()>=p.deadline){this.nativeStop(p.stage==='waiting_accessibility'?'CHROME_INSTALL_ACCESSIBILITY_TIMEOUT':'CHROME_INSTALL_TIMEOUT');return false;}
  return true;
 }
 nativeProfileChoice(data){requireLegacyInstaller(this.distribution);
  const id=attemptID(data.attempt_id),raw=data.profiles;
  if(!id||data.choose_profile!==true||typeof data.repair!=='boolean'||!Array.isArray(raw)||!raw.length||raw.length>100)fault('INSTALL_STOPPED');
  const profiles=raw.map(p=>{
   if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.id!=='string'||!/^(Default|Profile [0-9]{1,6})$/.test(p.id)||typeof p.name!=='string'||!p.name.length||p.name.length>160||/[\u0000-\u001f\u007f]/.test(p.name)||![true,false,null].includes(p.installed)||![true,false,null].includes(p.enabled))fault('INSTALL_STOPPED');
   return {id:p.id,name:p.name,installed:p.installed,enabled:p.enabled};
  });
  const selected=data.selected_profile;
  if(new Set(profiles.map(p=>p.id)).size!==profiles.length||selected!==null&&selected!==''&&!profiles.some(p=>p.id===selected))fault('INSTALL_STOPPED');
  if(activePhases.has(this.lease?.phase)||this.retiredAttempts.has(id)||this.nativeProgress?.attempt_id!==id||!this.nativeAttemptLive())return {recorded:false,discarded:true};
  const p=this.nativeProgress;
  if(p.choose_profile)return {recorded:false,discarded:true};
  Object.assign(p,{phase:'choose_profile',active:false,stage:'checking_profile',code:null,repair:data.repair,choose_profile:true,profiles,selected_profile:selected,stageStartedAt:this.now(),deadline:this.now()+90000});
  return {recorded:false,accepted:true};
 }
 nativeStop(code){
  const p=this.nativeProgress;if(!p||this.retiredAttempts.has(p.attempt_id))return;
  p.active=false;p.phase='stopped';p.code=code;delete p.failureDetail;this.retiredAttempts.add(p.attempt_id);this.clearNativeChoice(p);
  const metadata={stage:p.stage||'preparing',code,ms:Math.max(0,Math.min(chromeInstallDurationLimit(p.stage),Math.round(this.now()-(p.stageStartedAt??this.now())))),target_is_default:p.target_is_default,outcome:'stopped'};
  try{this.audit({event:'chrome_install_native_stopped',...metadata});}catch{}
  try{this.diagnostic(metadata);}catch{}
 }
 observeProfiles(ids){
  this.allowed();if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||!/^(Default|Profile [0-9]{1,6})$/.test(id)))fault('CHROME_INSTALL_PROFILE_UNKNOWN');
  const unique=[...new Set(ids)];this.observedProfiles={ids:unique,until:this.now()+15000,epoch:this.policy.epoch,revision:this.policy.permissionRevision||0};
  return {profiles:unique.map(id=>({id,name:id,installed:null,enabled:null})),selected_profile:unique.length===1?unique[0]:null,source:'chrome_version_ax'};
 }
 chooseObservedProfile(id){
  this.allowed();const seen=this.observedProfiles;
  if(!seen||this.now()>seen.until||seen.epoch!==this.policy.epoch||seen.revision!==(this.policy.permissionRevision||0))fault('CHROME_INSTALL_PROFILE_UNKNOWN');
  if(id===undefined&&seen.ids.length!==1)fault('CHROME_INSTALL_PROFILE_CHOICE_REQUIRED');
  id??=seen.ids[0];if(!seen.ids.includes(id))fault('CHROME_INSTALL_PROFILE_UNKNOWN');return id;
 }
 dataAccess(fields){const safe=chromeAccessFields(fields);if(!safe)return false;try{this.diagnostic({stage:'preparing',code:safe.code,ms:0,target_is_default:null,outcome:'stopped',...safe});}catch{}return true;}
 allowed(){requireLegacyInstaller(this.distribution);this.policy.check();if(!this.ready()||this.policy.transitioning||this.registrationOnlyAfterOptIn===true&&(this.state.data.browser_enabled!==true||(typeof this.browserOptIn==='function'?this.browserOptIn():this.browserOptIn)!==true)||!capabilityOn(this.state,'browser')||!capabilityOn(this.state,'desktop'))fault('INSTALL_ACCESS_CHANGED');}
 stop(code='INSTALL_CANCELLED'){if(storeMode(this.distribution))return {phase:'idle',active:false,code:'CHROME_INSTALL_LEGACY_DISABLED'};const l=this.lease;if(l&&activePhases.has(l.phase)){l.phase='stopped';l.finishedAt=this.now();l.code=code;l.request=null;l.title=null;this.note('stopped',{code});}this.nativeStop(code);return this.publicStatus();}
 check(id){requireLegacyInstaller(this.distribution);
 const l=this.lease;if(!l||id!==undefined&&id!==l.id)fault('INSTALL_LEASE_INVALID');
 if(!activePhases.has(l.phase))return l;
 try{this.allowed();if(this.now()>l.deadline)fault('INSTALL_EXPIRED');if(this.policy.epoch!==l.epoch||(this.policy.permissionRevision||0)!==l.revision)fault('INSTALL_ACCESS_CHANGED');const source=installSource(this.root);if(source.fingerprint!==l.source.fingerprint||source.host.entry_sha256!==l.source.host.entry_sha256||l.loadedFolder&&helperFingerprint(l.loadedFolder)!==l.source.fingerprint)fault('INSTALL_SOURCE_CHANGED');}catch(e){this.stop(/^[A-Z_]{3,80}$/.test(e.code||'')?e.code:'INSTALL_STOPPED');}
 return l;
 }
 begin(profileID='Default',{attempt_id}={}){
 if(this.lease&&activePhases.has(this.check().phase))fault('INSTALL_BUSY');
 if(attempt_id!==undefined&&(!attemptID(attempt_id)||this.nativeProgress?.attempt_id!==attemptID(attempt_id)||!this.nativeAttemptLive()))fault('INSTALL_STOPPED');
 if(this.nativeProgress&&!this.nativeAttemptLive())fault('INSTALL_STOPPED');
 this.allowed();if(!/^(Default|Profile [0-9]{1,6})$/.test(profileID))fault('INSTALL_LEASE_INVALID');if(this.extension.pending.size)fault('INSTALL_BROWSER_BUSY');
 const source=installSource(this.root),id=crypto.randomBytes(32).toString('hex'),url=this.origin()+INSTALL_PROBE_PATH+crypto.randomBytes(32).toString('hex');
  const nativeAttempt=this.nativeProgress?.attempt_id;if(nativeAttempt)this.retiredAttempts.add(nativeAttempt);this.nativeProgress=null;this.lease={id,attempt_id:nativeAttempt,url,title:'ChatHand '+crypto.randomBytes(24).toString('hex'),source,startedAt:this.now(),targetIsDefault:profileID==='Default',helperSeen:false,baseline:this.extension.session,epoch:this.policy.epoch,revision:this.policy.permissionRevision||0,deadline:this.now()+this.ttl,phase:'loading',stage:'preparing',code:null,request:null};
  this.note('started');
 return {lease_id:id,probe_url:url,extension_folder:source.folder,source_fingerprint:source.fingerprint};
 }
 setFolder(id,folder){requireLegacyInstaller(this.distribution);const l=this.check(id);if(!activePhases.has(l.phase)||helperFingerprint(folder)!==l.source.fingerprint)fault('INSTALL_SOURCE_CHANGED');l.loadedFolder=folder;return {lease_id:l.id,probe_url:l.url,extension_folder:folder,source_fingerprint:l.source.fingerprint};}
 publicStatus(id,attempt_id){if(storeMode(this.distribution))return {phase:'idle',active:false,code:'CHROME_INSTALL_LEGACY_DISABLED'};
  const l=this.lease?this.check(id):null,p=this.nativeProgress;
  if(attempt_id!==undefined&&(!attemptID(attempt_id)||p?.attempt_id!==attemptID(attempt_id)&&l?.attempt_id!==attemptID(attempt_id)))return {phase:'idle',active:false,stage:null,code:null,helper_seen:false};
  if(id===undefined&&p&&!activePhases.has(l?.phase)&&(attempt_id===undefined||p.attempt_id===attemptID(attempt_id))){
   this.nativeAttemptLive();
   return {phase:p.phase,active:p.active,stage:p.stage,code:p.code,helper_seen:false,attempt_id:p.attempt_id,repair:p.repair,...chromeInstallFailureFields({stage:p.stage,code:p.code,outcome:p.phase,...p.failureDetail}),...(p.choose_profile?{choose_profile:true,profiles:p.profiles.map(profile=>({...profile})),selected_profile:p.selected_profile}:{})};
  }
  return {phase:l?.phase||'idle',active:!!l&&activePhases.has(l.phase),stage:l?.stage||null,code:l?.code||null,helper_seen:l?.helperSeen===true};
 }
 progress(id,stage,data={}){requireLegacyInstaller(this.distribution);if(id===undefined&&data.native_event!==undefined)return this.nativeDiagnostic({...data,stage});const l=this.check(id);if(!activePhases.has(l.phase)||!stages.has(stage))fault('INSTALL_STOPPED');if(l.stage!==stage){l.stage=stage;this.note('stage');}return this.publicStatus(id);}
 evidence({lease_id,image_base64,evidence_code},stateDir){requireLegacyInstaller(this.distribution);const l=this.check(lease_id);if(l.phase!=='stopped'||l.evidenceRecorded||this.now()>l.deadline+15000)fault('INSTALL_STOPPED');let receipt;if(image_base64!==undefined)receipt=archiveInstallEvidence({stateDir,image_base64});else if(evidence_code==='CHROME_INSTALL_EVIDENCE_UNAVAILABLE')receipt={evidence_code};else fault('INSTALL_EVIDENCE_INVALID');l.evidenceRecorded=true;this.note('evidence',{code:l.code,...receipt,content_masked:!!receipt.file});return {recorded:true,content_masked:!!receipt.file};}
 page(url){if(storeMode(this.distribution))return null;const l=this.lease?this.check():null;if(!l||!activePhases.has(l.phase)||url!==new URL(l.url).pathname)return null;return '<!doctype html><html><head><meta charset="utf-8"><title>'+l.title+'</title></head><body>ChatHand Chrome extension check</body></html>';}
 sourceMatches(raw,l){return raw&&raw.runtime_root===l.source.host.runtime_root&&raw.build===l.source.host.build&&raw.entry_sha256===l.source.host.entry_sha256;}
 next(session,helper,host){if(storeMode(this.distribution))return null;
 const l=this.lease?this.check():null;if(!l||!activePhases.has(l.phase)||l.phase==='probe_verified'||!l.probeRequested)return null;
 if(session===l.baseline)return null;
 if(helper?.version!==l.source.version||helper?.build!==l.source.build||!this.sourceMatches(host,l))return null;
 if(l.session&&l.session!==session){this.stop('INSTALL_SESSION_CHANGED');return null;}
 if(!l.helperSeen){l.helperSeen=true;this.note('helper_seen');}
 l.session=session;l.phase='waiting_helper';
 if(l.request)return null;
 l.request={id:crypto.randomUUID(),session};
 return {kind:'install_probe',id:l.request.id,url:l.url,deadline:l.deadline};
 }
 authorize(session,id){requireLegacyInstaller(this.distribution);const l=this.lease?this.check():null;return {authorized:!!l&&activePhases.has(l.phase)&&l.phase!=='probe_verified'&&l.request?.id===id&&l.session===session&&this.extension.session===session&&this.extension.status().connected};}
 complete(session,id,result,error){requireLegacyInstaller(this.distribution);
 const l=this.lease?this.check():null;if(!l||!this.authorize(session,id).authorized)return {discarded:true};
 if(error||!result||result.title!==l.title||!Number.isInteger(result.tab_id)||!Number.isInteger(result.window_id)||result.tab_id<0||result.window_id<0){this.stop('INSTALL_PROBE_FAILED');return {accepted:true};}
 l.phase='probe_verified';l.request=null;l.title=null;this.note('probe_verified');return {accepted:true};
 }
 verify(id){requireLegacyInstaller(this.distribution);const l=this.check(id);if(activePhases.has(l.phase)&&l.session&&(this.extension.session!==l.session||!this.extension.status().connected))this.stop('INSTALL_DISCONNECTED');if(activePhases.has(l.phase)&&l.phase!=='probe_verified'){l.probeRequested=true;l.phase='waiting_helper';}return this.publicStatus(id);}
 finish({lease_id,native_verified,source_fingerprint}){
 const status=this.verify(lease_id),l=this.lease;
 if(status.phase!=='probe_verified'||native_verified!==true||source_fingerprint!==l.source.fingerprint)fault('INSTALL_NOT_VERIFIED');
  l.phase='installed_verified';l.stage='installed_verified';l.finishedAt=this.now();l.title=null;l.request=null;this.note('completed');return this.publicStatus(lease_id);
 }
 cancel(id,code,attempt_id){
  if(attempt_id!==undefined){const target=attemptID(attempt_id);if(!target)fault('INSTALL_STOPPED');const currentLease=activePhases.has(this.lease?.phase)&&this.lease.attempt_id===target&&(id===undefined||id===this.lease.id);if(target!==this.nativeProgress?.attempt_id&&!currentLease){this.retiredAttempts.add(target);return this.publicStatus();}}
  if(id!==undefined)this.check(id);return this.stop(INSTALL_NATIVE_CODES.has(code)?code:'INSTALL_CANCELLED');
 }
 close(){this.stop('INSTALL_CLOSED');this.lease=null;this.nativeProgress=null;}
}
