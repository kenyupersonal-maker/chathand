import {DiagnosticEvents} from '../app/diagnostic-events.mjs';
import {OnboardingTelemetry,onboardingErrorCode,onboardingFailure} from '../app/onboarding-telemetry.mjs';
import {localText} from '../app/i18n.mjs';
import {appProcessExecutable} from './process-identity.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {armUpgradeGuard} from '../app/v08/upgrade-guard.mjs';
import {normalizeSwitches} from '../app/v1/high-risk.mjs';
import {verifyPayload} from '../app/v09/payload-integrity.mjs';
import {upgradeTransaction,recoverUpgrade} from '../app/v07/upgrade-transaction.mjs';import {dataDirectory,upgradeHome} from '../app/v07/paths.mjs';
import {saveJSON} from '../engine/src/core.mjs';
import {assertTemporaryUpdatePaths,clientSettings} from '../app/v1/client-features.mjs';
const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function readUpgradeLifecycleKey({input=process.stdin,timeout=1000}={}) {
 if(input.isTTY)return Promise.resolve(null);
 return new Promise(resolve=>{let value='',done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);input.off('data',data);input.off('end',finish);input.off('error',finish);input.pause();resolve(/^[a-f0-9]{64}$/.test(value.trim())?value.trim():null);};const data=chunk=>{value+=String(chunk);if(value.length>256||value.includes('\n'))finish();};const timer=setTimeout(finish,timeout);input.on('data',data);input.once('end',finish);input.once('error',finish);});
}
export function upgradeOwnerHeaders(admin,route,lifecycleKey){return {Authorization:'Bearer '+admin,'Content-Type':'application/json',...(route==='/api/lifecycle/quit'&&/^[a-f0-9]{64}$/.test(lifecycleKey||'')?{'X-ChatHand-Upgrade':lifecycleKey}:{})};}

/** Derive the expected live contract from the candidate's signed, verified payload. */
export function candidateUpgradeContract(app) {
 const runtime=path.join(app,'Contents/Resources/runtime'),pkg=JSON.parse(fs.readFileSync(path.join(runtime,'package.json'),'utf8')),api=pkg.kenBridge?.connector_api;
 if(!Number.isSafeInteger(api)||api<1)throw Error('CANDIDATE_CONNECTOR_API_INVALID');
 const frozen=JSON.parse(fs.readFileSync(path.join(runtime,`contracts/tools-v${api}.json`),'utf8'));
 if(!Array.isArray(frozen)||!frozen.length||frozen.some(t=>typeof t.name!=='string')||new Set(frozen.map(t=>t.name)).size!==frozen.length)throw Error('CANDIDATE_TOOLS_INVALID');
 const tools=frozen;
 return {version:pkg.version,connector_api:api,tool_count:tools.length,tool_names:tools.map(t=>t.name),schema_sha256:crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex')};
}
export function verifyUpgradeContract(actual,expected) {
 if(!expected||!actual||['version','connector_api','tool_count','schema_sha256'].some(k=>actual[k]!==expected[k])||JSON.stringify(actual.tool_names)!==JSON.stringify(expected.tool_names))throw Error('TOOLS_MISMATCH');
 return true;
}
export const UPGRADE_SETTINGS=Object.freeze(['active','access_enabled','projects','conversations','mode','notifications','browser','auto_connect','connection_preference','tunnel','appearance','auto_update','skin','show_value','value_plan','high_risk','admin_requested']);
export function retainedUpgradeSetting(before,after,field) {
 if(['appearance','auto_update','skin'].includes(field))return clientSettings(before)[field]===after[field];
 if(field==='access_enabled')return (before[field]===undefined?true:before[field])===after[field];
 if(field==='show_value')return (typeof before[field]==='boolean'?before[field]:true)===after[field];
 if(field==='value_plan')return (before[field]??'auto')===after[field];
 // 1026：管理员和高危开关按「规范化以后」比，新版本多出来的开关项默认关、不算不一致；admin_requested 按真假比。
 if(field==='high_risk')return JSON.stringify(normalizeSwitches(before[field]))===JSON.stringify(normalizeSwitches(after[field]));
 if(field==='admin_requested')return (before[field]===true)===(after[field]===true);
 return JSON.stringify(after[field])===JSON.stringify(before[field]);
}
/** Only this installer's committed transaction family, after successful self-check.
 * Never send backups to Trash or delete them. Foreign/unfinished backups stay put. */
export function archiveUpgradeBackups({backupRoot,currentTransaction,verified=false,now=new Date()}) {
 const empty={moved:[],retained:null};if(!verified)return empty;
 const ordinary=p=>{try{return !fs.lstatSync(p).isSymbolicLink()&&fs.statSync(p).isDirectory();}catch{return false;}};
 if(!ordinary(backupRoot)||!ordinary(currentTransaction)||path.dirname(path.resolve(currentTransaction))!==path.resolve(backupRoot))return empty;
 const read=p=>{try{const file=path.join(p,'journal.json');if(fs.lstatSync(file).isSymbolicLink())return null;return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
 const current=read(currentTransaction);
 if(current?.format!==1||current.phase!=='committed'||current.id!==path.basename(currentTransaction)||path.basename(current.destination||'')!=='ChatHand.app'||!Number.isFinite(Date.parse(current.created))||current.appBackup!==path.join(currentTransaction,'previous.app')||current.stateBackup!==path.join(currentTransaction,'state-backup'))return empty;
 const eligible=[];
 for(const name of fs.readdirSync(backupRoot)) {
  if(!/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/.test(name))continue;
  const dir=path.join(backupRoot,name),j=ordinary(dir)?read(dir):null;
  if(j?.format!==1||j.id!==name||j.phase!=='committed'||j.destination!==current.destination||j.stateDir!==current.stateDir||j.appBackup!==path.join(dir,'previous.app')||j.stateBackup!==path.join(dir,'state-backup')||j.hadApp!==true||!ordinary(j.appBackup)||!Number.isFinite(Date.parse(j.created))||Date.parse(j.created)>Date.parse(current.created))continue;
  eligible.push({dir,created:Date.parse(j.created)});
 }
 eligible.sort((a,b)=>b.created-a.created||b.dir.localeCompare(a.dir));if(!eligible.length)return empty;
 const result={moved:[],retained:eligible[0].dir};if(eligible.length<2)return result;
 const archive=path.join(backupRoot,`_待清理-${now.toISOString().slice(0,10)}.noindex`);
 if(fs.existsSync(archive)&&!ordinary(archive))throw Error('UNSAFE_BACKUP_ARCHIVE');
 fs.mkdirSync(archive,{recursive:true,mode:0o700});
 for(const {dir} of eligible.slice(1)){let target=path.join(archive,path.basename(dir)),index=0;while(fs.existsSync(target))target=path.join(archive,path.basename(dir)+'.'+(++index));fs.renameSync(dir,target);result.moved.push(target);}
 return result;
}
// The CLI defaults to the normal installation. Acceptance imports this
// factory with disposable paths and exercises these exact lifecycle hooks.
export function createUpgradeRunner({packageRoot,destination=path.join(os.homedir(),'Applications','ChatHand.app'),stateDir=dataDirectory(),backupRoot=upgradeHome(),isolatedLaunch=false,allowLifecycle=false,lifecycleKey=null,resultFile=path.join(stateDir,'update-result.json'),requireExistingDestination=false,executeCommand=spawnSync,iconWarning=code=>console.warn(code)}){
for(const value of [packageRoot,destination,stateDir,backupRoot])if(typeof value!=='string'||!path.isAbsolute(value))throw Error('ABSOLUTE_UPGRADE_PATH_REQUIRED');
if(!destination.endsWith('.app')||destination.includes('\0'))throw Error('APP_DESTINATION_REQUIRED');if(typeof resultFile!=='string'||!path.isAbsolute(resultFile)||resultFile.includes('\0'))throw Error('ABSOLUTE_RESULT_PATH_REQUIRED');
const candidate=path.join(packageRoot,'ChatHand.app');
const helper=appProcessExecutable(candidate,'upgrade'),manifestFile=path.join(packageRoot,'payload-manifest.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function command(program,args,extra={}){const env={...process.env};if(program===helper){delete env.KEN_BRIDGE_STATE_DIR;if(isolatedLaunch){env.KEN_BRIDGE_STATE_DIR=stateDir;env.CHATHAND_STATE_DIR=stateDir;}}const r=executeCommand(program,args,{encoding:'utf8',timeout:args[0]==='stop-backend-exact'?45000:20000,maxBuffer:1024*1024,env,...extra});if(r.status!==0)throw Object.assign(Error('LOCAL_STEP_FAILED'),{code:'LOCAL_STEP_FAILED'});return r.stdout.trim();}
function runtime(){try{const r=JSON.parse(fs.readFileSync(path.join(stateDir,'runtime.json'),'utf8'));if(!Number.isInteger(r.pid)||r.pid<2)return null;try{process.kill(r.pid,0);}catch(e){if(e.code==='ESRCH')return null;throw e;}if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(r.ui_origin)||typeof r.admin_token!=='string')throw Error();return r;}catch{return null;}}
async function owner(route,body){const r=runtime();if(!r)throw Error('RUNTIME_NOT_READY');const response=await fetch(r.ui_origin+route,{method:body===undefined?'GET':'POST',headers:upgradeOwnerHeaders(r.admin_token,route,lifecycleKey),...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(4000)});if(!response.ok)throw Object.assign(Error('OWNER_NOT_READY'),{httpStatus:response.status});return response.json();}
function metadata(){try{return JSON.parse(fs.readFileSync(path.join(stateDir,'desktop.json'),'utf8'));}catch{return null;}}
const fields=UPGRADE_SETTINGS;
let before=null,expectedVersion='',expectedBuild=null,from='',schemaFrom=null,schemaTo=null,connectorBefore=null,expectedContract=null;
function appInfo(app){const file=path.join(app,'Contents/Info.plist');return {bundle_id:command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',file]),version:command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',file])};}
function pending(){try{return JSON.parse(fs.readFileSync(path.join(stateDir,'update-pending.json'),'utf8'));}catch{return {};}}
function capture(state){if(!state)return;from=state.version||from;schemaFrom=state.manifest?.schema_sha256||schemaFrom;connectorBefore=state.manifest?.connector_api??connectorBefore;}
function result(status){return {status,from:from||pending().from||null,to:expectedVersion||pending().to||null,schema_from:schemaFrom||pending().schema_from||null,schema_to:schemaTo,...(Number.isSafeInteger(expectedBuild)?{build_to:expectedBuild}:{}),time:new Date().toISOString()};}
const hooks={
 async validate(app){
  command('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const self=JSON.parse(command(appProcessExecutable(app,'app'),['--self-check']));if(self.bundle_id!=='com.kenyu.chathand')throw Error('WRONG_APP_ID');expectedVersion=self.version;
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));if(manifest.version!==self.version)throw Error('MANIFEST_VERSION_MISMATCH');
  verifyPayload(app,manifest.files);
  expectedBuild=JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/runtime/package.json'),'utf8')).kenBridge?.build_number;expectedContract=candidateUpgradeContract(app);if(expectedContract.version!==self.version)throw Error('MANIFEST_VERSION_MISMATCH');
 },
 async stop(app){
  if(!fs.existsSync(app))return;const observed=JSON.parse(command(helper,['info',app]));if(observed.pids.length>1)throw Error('MULTIPLE_APP_INSTANCES');
  if(observed.kernel_scan!==true||!Array.isArray(observed.identities)||observed.identities.length!==observed.pids.length)throw Error('APP_PID_IDENTITY_UNKNOWN');
  let stoppedGUI=false;
  const r=runtime();let backendReceipt=null;
  if(r){backendReceipt=JSON.parse(command(helper,['backend-info',app,stateDir]));if(backendReceipt.present!==true||backendReceipt.signature_verified!==true||backendReceipt.identity?.pid!==r.pid)throw Error('OLD_BACKEND_IDENTITY_UNKNOWN');}
  if(r){let state;try{state=await owner('/api/state');if(!from)capture(state);}catch{}try{if(state?.lifecycle?.protocol===1){await owner('/api/lifecycle/quit',{});}else{await owner('/api/shutdown',{});}}catch(e){
   // Standalone CLI installs/recovery ask only the exact observed App to quit.
   // Its service observes loss of the exact owner PID; app updates instead
   // receive a private lifecycle authority over stdin, never argv/env/files.
   if(e.httpStatus!==403||observed.pids.length!==1)throw e;command(helper,['stop-exact',app,String(observed.pids[0])]);stoppedGUI=true;
  }const until=Date.now()+12000;while(runtime()&&Date.now()<until)await sleep(150);if(runtime())throw Error('SERVICE_DID_NOT_STOP');}
  // The service has stopped; terminate only the previously observed exact app if its GUI remains.
  if(!stoppedGUI&&observed.pids.length===1)command(helper,['stop-exact',app,String(observed.pids[0])]);
  if(r&&backendReceipt){
   const stopped=JSON.parse(command(helper,['stop-backend-exact',app,stateDir],{input:JSON.stringify({runtime:{pid:r.pid,ui_origin:r.ui_origin,admin_token:r.admin_token},receipt:backendReceipt})+'\n'}));
   if(stopped.pid_absent!==true)throw Error('OLD_BACKEND_PID_STILL_RUNNING');
   try{process.kill(r.pid,0);throw Error('OLD_BACKEND_PID_STILL_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}
  }
  // Kernel scan after shutdown is a separate mandatory gate before rename.
  const after=JSON.parse(command(helper,['info',app]));
  if(after.kernel_scan!==true||!Array.isArray(after.pids)||after.pids.length!==0)throw Error('OLD_APP_PID_STILL_RUNNING');
  for(const pid of observed.pids){try{process.kill(pid,0);throw Error('OLD_APP_PID_STILL_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}}
 },
 async migrate(dir){const journal=JSON.parse(fs.readFileSync(path.join(backupRoot,'current.json'),'utf8'));armUpgradeGuard(dir,expectedVersion,crypto.randomUUID(),{adminEnabled:before?.high_risk?.admin===true,build:expectedBuild,transactionId:journal.id});},
 async start(app,verifying){
  // The transaction calls this after replacing destination. Recovery starts do
  // not refresh metadata, and an alternate app path is never registered.
  if(verifying===true&&app===destination&&path.basename(destination)==='ChatHand.app'){
   let ordinary=false;try{ordinary=!fs.lstatSync(destination).isSymbolicLink()&&fs.statSync(destination).isDirectory();}catch{}
   if(ordinary)for(const [program,args,code] of [
    ['/usr/bin/touch',[destination],'UPGRADE_ICON_TOUCH_FAILED'],
    ['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',['-f',destination],'UPGRADE_ICON_REGISTER_FAILED']
   ]){
    try{const r=executeCommand(program,args,{timeout:3000,maxBuffer:4096,stdio:'ignore'});if(r.error||r.status!==0)throw Error(code);}
    catch{try{iconWarning(code);}catch{}}
   }
  }
  command(helper,['start',app,...(verifying?['--upgrade-verification']:[])]);
 },
 async resume(app){
  // A stop/recovery attempt can overlap a remaining GUI instance. Never create
  // a second one, and never call a launch request proof that the old service is back.
  const observed=JSON.parse(command(helper,['info',app]));
  if(observed.pids.length>1)throw Error('MULTIPLE_APP_INSTANCES');
  const version=JSON.parse(command(appProcessExecutable(app,'app'),['--self-check'])).version;
  if(observed.pids.length===0)await hooks.start(app,false);
  const until=Date.now()+30000;
  while(Date.now()<until){
   try{const restored=await owner('/api/state');if(restored.version===version&&restored.lifecycle?.exit_requested!==true)return {resumed:true,version};}catch{}
   await sleep(250);
  }
  throw Error('OLD_APP_NOT_READY');
 },
 async verify(){
  const until=Date.now()+60000;let last='NEW_APP_NOT_READY';
  while(Date.now()<until){try{const state=await owner('/api/state');if(state.version!==expectedVersion){last='VERSION_MISMATCH';await sleep(400);continue;}schemaTo=state.manifest?.schema_sha256||null;verifyUpgradeContract(state.manifest,expectedContract);
   const after=state.settings;for(const field of fields)if(before&&!retainedUpgradeSetting(before,after,field))throw Error('SETTING_NOT_RETAINED_'+field.toUpperCase());
   const needsTunnel=before?.connection_preference==='tunnel'&&before.auto_connect===true;
   if(needsTunnel&&!(state.connection?.ready&&state.connection?.healthy)){last='CONNECTION_NOT_RESTORED';await sleep(500);continue;}
   if(before?.connection_preference==='relay'&&before.auto_connect===true&&!state.relay?.online){last='RELAY_NOT_RESTORED';await sleep(500);continue;}
   if(state.upgrade_pending!==true)throw Error('UPGRADE_GUARD_NOT_ACTIVE');
   return {version:state.version,settings_retained:true,connection_restored:needsTunnel?true:null};
  }catch(e){if(String(e.message).startsWith('SETTING_')||['TOOLS_MISMATCH','UPGRADE_GUARD_NOT_ACTIVE'].includes(e.message))throw e;last=e.message;}await sleep(400);}
  throw Error(last);
 },
 async commit(){await owner('/api/upgrade/commit',{});}
};
async function main(mode){
 let endTelemetry=()=>{};
 // Imports cannot accidentally stop/replace a daily app. Isolated tests must
 // opt in and keep every filesystem target under a temporary directory.
 if(!allowLifecycle)throw Error('UPGRADE_LIFECYCLE_NOT_AUTHORIZED');
 if(isolatedLaunch||process.env.NODE_TEST_CONTEXT)assertTemporaryUpdatePaths(packageRoot,destination,stateDir,backupRoot,resultFile);
 // Begin only after lifecycle and isolated-path guards. This never reads credentials.
 try{fs.mkdirSync(stateDir,{recursive:true,mode:0o700});endTelemetry=new OnboardingTelemetry(new DiagnosticEvents(stateDir)).begin('installer',{source:'installer'});}catch{}
 try{
  if(process.platform!=='darwin')throw Error('MAC_REQUIRED');if(!['--install','--recover'].includes(mode))throw Error('USE_INSTALL_OR_RECOVER');fs.mkdirSync(path.dirname(destination),{recursive:true});
  if(requireExistingDestination&&!fs.existsSync(destination))throw Error('DESTINATION_APP_REQUIRED');if(fs.existsSync(destination)){const info=appInfo(destination);if(info.bundle_id!=='com.kenyu.chathand')throw Error('WRONG_DESTINATION_APP_ID');from=info.version;try{const pkg=JSON.parse(fs.readFileSync(path.join(destination,'Contents/Resources/runtime/package.json'),'utf8'));connectorBefore=pkg.kenBridge?.connector_api??null;}catch{}}
  before=metadata();const current=runtime();if(current){const state=await owner('/api/state');capture(state);if(mode==='--install'&&state.jobs?.some(j=>j.process_alive||j.cleanup_pending))throw Error('TASKS_RUNNING_FINISH_THEM_FIRST');}
  let outcome;
  if(mode==='--recover'){const file=path.join(backupRoot,'current.json');if(fs.existsSync(file)){const j=JSON.parse(fs.readFileSync(file));if(j.destination!==destination||j.stateDir!==stateDir)throw Error('RECOVERY_TARGET_MISMATCH');}const p=pending();from=p.from||from;schemaFrom=p.schema_from||schemaFrom;expectedVersion=p.to||expectedVersion;outcome=await recoverUpgrade({backupRoot,hooks});}
  else{try{expectedVersion=appInfo(candidate).version;if(connectorBefore===null){const pkg=JSON.parse(fs.readFileSync(path.join(candidate,'Contents/Resources/runtime/package.json'),'utf8'));connectorBefore=pkg.kenBridge?.connector_api??null;}}catch{}if(!(connectorBefore>0))throw Error('OLD_CONNECTOR_API_UNKNOWN');
   // The new service starts before verification finishes. Both CLI and window
   // installs leave a marker so its updater can wait for the final result.
   const prior=pending(),candidatePkg=JSON.parse(fs.readFileSync(path.join(candidate,'Contents/Resources/runtime/package.json'),'utf8'));saveJSON(path.join(stateDir,'update-pending.json'),{from,to:candidatePkg.version,schema_from:schemaFrom,started_at:Date.now(),...(Number.isSafeInteger(prior.build_from)?{build_from:prior.build_from}:{}),build_to:candidatePkg.kenBridge?.build_number,...(prior.source?{source:prior.source}:{})});try{fs.unlinkSync(resultFile);}catch{}
   console.log(localText('installer.console.working'));outcome=await upgradeTransaction({candidate,destination,stateDir,backupRoot,hooks});}
  endTelemetry(outcome.status==='COMMITTED'?'ok':'failed',outcome.status==='COMMITTED'?'NONE':onboardingErrorCode(outcome.error_code));const report=result(outcome.status);saveJSON(resultFile,report);let backup_archive=null;if(outcome.status==='COMMITTED')try{backup_archive=archiveUpgradeBackups({backupRoot,currentTransaction:outcome.transaction,verified:true});}catch{}return {...outcome,...report,backup_archive};
 }catch(e){const failure=onboardingFailure(e);endTelemetry(failure.result,failure.error_code);saveJSON(resultFile,result(e.code==='ROLLBACK_FAILED'?'ROLLBACK_FAILED':'FAILED'));throw e;}
}
return {run:main,hooks,owner};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
process.on('SIGHUP',()=>{});for(const stream of [process.stdout,process.stderr])stream.on('error',e=>{if(e.code!=='EPIPE')throw e;});
const args=process.argv.slice(2),mode=args[0];let packageRoot=args[1]&&!args[1].startsWith('--')?path.resolve(args[1]):path.dirname(source),destination,resultFile;try{for(let i=args[1]&&!args[1].startsWith('--')?2:1;i<args.length;i++){const name=args[i],value=args[++i];if(!value||!path.isAbsolute(value)||value.includes('\0'))throw Error('ABSOLUTE_UPGRADE_PATH_REQUIRED');if(name==='--destination')destination=value;else if(name==='--result')resultFile=value;else throw Error('UNKNOWN_UPGRADE_OPTION');}
const stateDir=process.env.CHATHAND_STATE_DIR||process.env.KEN_BRIDGE_STATE_DIR||dataDirectory();createUpgradeRunner({packageRoot,stateDir,allowLifecycle:true,lifecycleKey:await readUpgradeLifecycleKey(),...(destination?{destination,requireExistingDestination:true}:{}),...(resultFile?{resultFile}:{})}).run(mode).then(r=>{console.log(JSON.stringify(r,null,2));if(r.status==='COMMITTED')console.log(localText('installer.console.finished'));else if(r.status.includes('ROLLED_BACK'))console.log(localText('installer.console.rolledBack'));if(r.status==='ROLLED_BACK')process.exitCode=2;}).catch(e=>{console.error(localText('installer.console.failed',{reason:e.code||e.message}));process.exitCode=1;});
}catch(e){if(resultFile)try{saveJSON(resultFile,{status:'FAILED',from:null,to:null,schema_from:null,schema_to:null,time:new Date().toISOString()});}catch{}console.error(localText('installer.console.failed',{reason:e.code||e.message}));process.exitCode=1;}
}
