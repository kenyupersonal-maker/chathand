import {messageMetadata} from './message-metadata.mjs';
const listedUpdateError=e=>({UPDATE_DOWNLOAD_TIMEOUT:'update.downloadTimeout.message',UPDATE_HASH_MISMATCH:'update.hashMismatch.message'})[e?.code||e?.message]||null;
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {appProcessExecutable} from '../../scripts/process-identity.mjs';
import {clientSettings,assertTemporaryUpdatePaths} from './client-features.mjs';
import {fail,privateDir,saveJSON} from '../../engine/src/core.mjs';import {currentSystemProxy} from '../../engine/src/tunnel.mjs';import {dataDirectory,upgradeHome as defaultUpgradeHome} from '../v07/paths.mjs';import {buildInfo,compareVersions,RELEASES_URL} from './support.mjs';import {payloadManifest} from './payload-manifest.mjs';
import {verifyUpdateSignature,verifyInstalledUpdate} from './update-verification.mjs';
import {reconcileStartupUpgrade} from './upgrade-startup.mjs';
import {installationTask,finishInstallationTask} from './update-install-task.mjs';

export const PUBLIC_LATEST_URL='https://github.com/kenyupersonal-maker/chathand/releases/latest/download/latest.json';
const REPO='kenyupersonal-maker/chathand',DAY=24*60*60*1000,HOUR=60*60*1000,activeStates=new Set(['waiting_tasks','waiting_download','downloading','verifying','installing','restarting']);
const idle=()=>({state:'idle'}),json=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}},remove=file=>{try{fs.rmSync(file,{force:true});}catch{}},cancelled=()=>Object.assign(Error('UPDATE_CANCELLED'),{code:'UPDATE_CANCELLED'});
const https=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},version=value=>typeof value==='string'&&value.length<100&&compareVersions(value,value)!==null;
const macParts=value=>typeof value==='string'&&/^\d+(?:\.\d+){1,2}$/.test(value)?value.split('.').map(Number):null;
function macCompatible(current,minimum){const a=macParts(current),b=macParts(minimum);if(!a||!b)return false;for(let i=0;i<3;i++)if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);return true;}
function validLatest(value,local=false){return value?.format==='chathand-latest-v1'&&version(value.version)&&Number.isSafeInteger(value.build)&&value.build>0&&typeof value.published_at==='string'&&Number.isFinite(Date.parse(value.published_at))&&typeof value.notes==='string'&&value.notes.length<=20000&&macParts(value.min_macos)&&/^[a-f0-9]{64}$/.test(value.tool_schema_sha256||'')&&/^ChatHand[A-Za-z0-9._-]*\.dmg$/.test(value.dmg?.name||'')&&(https(value.dmg?.url)||(local&&typeof value.dmg?.url==='string'&&/^file:\/\/(?:\/|localhost\/)/.test(value.dmg.url)))&&/^[a-f0-9]{64}$/.test(value.dmg?.sha256||'')&&Number.isSafeInteger(value.dmg?.size)&&value.dmg.size>0&&https(value.release_page);}
const xmlText=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const mountPoints=xml=>[...String(xml).matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/g)].map(m=>xmlText(m[1]));
const within=(root,file)=>path.resolve(file).startsWith(path.resolve(root)+path.sep);
export function currentApplicationPath(executable=process.execPath){return path.resolve(executable).match(/^(.*?\.app)(?:\/|$)/)?.[1]||null;}
async function sha256(file){const hash=crypto.createHash('sha256');for await(const data of fs.createReadStream(file))hash.update(data);return hash.digest('hex');}

/** The local window starts an operation; snapshots expose only user-facing state. */
export class Updater {
 constructor(deps={}){
  this.stateDir=deps.stateDir||dataDirectory();this.home=deps.upgradeHome||defaultUpgradeHome();this.app=Object.hasOwn(deps,'currentAppPath')?deps.currentAppPath:(process.env.NODE_TEST_CONTEXT?null:currentApplicationPath());this.schemaSha=deps.schemaSha||'';this.current=deps.version||buildInfo().version;this.currentBuild=deps.build??buildInfo().build;this.state=deps.state||{data:{}};
  for(const dir of [this.stateDir,this.home])if(typeof dir!=='string'||!path.isAbsolute(dir))throw Error('ABSOLUTE_UPDATE_PATH_REQUIRED');
  this.downloads=path.join(this.home,'downloads');this.staging=path.join(this.home,'staging');this.mounts=path.join(this.home,'mounts');this.userDownloads=deps.downloadsDir||path.join(os.homedir(),'Downloads');
  this.exec=deps.exec||promisify(execFile);this.spawn=deps.spawn||spawn;this.busy=deps.busy||(()=>false);this.openURL=deps.openURL||((url)=>this._command('/usr/bin/open',[url]));this.now=deps.now||Date.now;this.sleep=deps.sleep;this.proxy=deps.currentSystemProxy||currentSystemProxy;this.env=deps.env||process.env;this.automaticAllowed=deps.allowAutomaticInstall===true;this.autoAttempted=new Set();this.testMode=!!process.env.NODE_TEST_CONTEXT||!!deps.exec||!!deps.spawn;
  if(this.testMode)assertTemporaryUpdatePaths(this.stateDir,this.home,this.userDownloads,...(this.app?[this.app]:[]));
  this.pendingFile=path.join(this.stateDir,'update-pending.json');this.resultFile=path.join(this.stateDir,'update-result.json');this.value={status:'unknown',url:RELEASES_URL,checked_at:null,install:idle(),just_updated:null};this.latest=null;this.run=null;this.checking=null;this.timer=null;this.resultTimer=null;this.startupRetryTimer=null;this.closed=false;
  this.lifecycleKey=deps.lifecycleKey||null;
  this.emit=typeof deps.emit==='function'?deps.emit:(()=>{});this.local=null;this.request=null;
  // 1027：ChatGPT 经用户在对话里同意后自己装（install_update）。记一个标记，重启后的新版靠它知道这次是 ChatGPT 装的、要不要替用户刷新工具。
  this.completedFile=path.join(this.stateDir,'update-completed.json');this.completed=json(this.completedFile);
  this.aiFile=path.join(this.stateDir,'update-ai.json');this.ai=json(this.aiFile);this.aiTimer=null;this.aiDelayMs=deps.aiDelayMs??1500;this.onUpdated=typeof deps.onUpdated==='function'?deps.onUpdated:null;
  this.guard=deps.guard||null;this.liveContract=deps.liveContract||null;this.finishUpgrade=deps.finishUpgrade||null;this.onInstallTask=deps.onInstallTask||(()=>{});this.installTaskSource=deps.installTaskSource||(()=>null);this.toolListCurrent=deps.toolListCurrent||(()=>false);this.toolListStatus=deps.toolListStatus||(()=>null);this.installerActive=deps.installerActive||(()=>this._installerActive());
  this.supersededFile=path.join(this.stateDir,'update-superseded.json');this.superseded=json(this.supersededFile);
 }
 snapshot(){const install=this.value.install;const status=this.value.just_updated?'updated':install.state==='restarting'?'installing':install.state!=='idle'?install.state:this.value.status;return structuredClone({...this.value,status,availability:this.value.status,current_build:Number.isSafeInteger(this.currentBuild)?this.currentBuild:null,auto_update:clientSettings(this.state.data).auto_update,...(install.progress!==undefined?{progress:install.progress,downloaded_bytes:install.downloaded_bytes||0,total_bytes:install.total_bytes||this.latest?.dmg.size||0}:{}),...(this.value.just_updated?(this.value.just_updated.tool_schema_changed!==true?{refresh_tools:false}:{refresh_tools:true,message:'已更新，请去 ChatGPT 点一次“刷新工具”。'}):{}),request:this.request?{...this.request}:null,dismissed_version:this.state.data.update_dismissed_version||null});}
 async _command(program,args,options={}){const result=await this.exec(program,args,{encoding:'utf8',timeout:10000,maxBuffer:256*1024,...options});if(result&&typeof result==='object'&&result.status!==undefined&&result.status!==0)throw Object.assign(Error('UPDATE_LOCAL_STEP_FAILED'),{code:result.status,stdout:result.stdout});return typeof result==='string'?result:String(result?.stdout||'');}
 _curl(seconds){const args=['--fail','--location','--max-time',String(Math.max(1,seconds))];const proxy=this.proxy();if(proxy)args.push('--proxy',proxy);return args;}
 async _gh(timeout=2000){for(const program of ['/opt/homebrew/bin/gh','/usr/local/bin/gh'])try{await this._command(program,['auth','status'],{timeout});return program;}catch{}return null;}
 check(){if(this.local)return Promise.resolve(this.snapshot());if(this.checking)return this.checking;this.value.status='checking';this.checking=this._check().then(()=>{this.maybeAutoInstall();return this.snapshot();}).finally(()=>{this.checking=null;});return this.checking;}
 maybeAutoInstall(){if(this.latest?.source==='local'||!this.automaticAllowed||this.closed||!clientSettings(this.state.data).auto_update||this.value.status!=='available'||this.run||this.value.install.state!=='idle'||this.value.just_updated||json(this.pendingFile)&&!this._supersededForCurrent()||this.autoAttempted.has(this.latest?.version))return false;this.autoAttempted.add(this.latest.version);this.install(this.latest.version,{automatic:true});return true;}
 settingsChanged(){if(clientSettings(this.state.data).auto_update)return this.maybeAutoInstall();if(this.run?.automatic)this.cancel({automatic:true});return false;}
 async _check(){
  const deadline=Date.now()+14500,remaining=()=>Math.max(1,deadline-Date.now());let latest=null;
  const urls=[this.env.CHATHAND_UPDATE_URL,PUBLIC_LATEST_URL].filter(Boolean);
  for(const url of urls){if(Date.now()>=deadline)break;try{
   let text;if(url.startsWith('file://')&&url===this.env.CHATHAND_UPDATE_URL){const file=fileURLToPath(url);if(fs.statSync(file).size>256*1024)throw Error();text=fs.readFileSync(file,'utf8');}else if(https(url))text=await this._command('/usr/bin/curl',[...this._curl(Math.min(10,Math.floor(remaining()/1000))),url],{timeout:Math.min(10000,remaining())});else continue;
   const candidate=JSON.parse(text);if(validLatest(candidate,url.startsWith('file://')&&url===this.env.CHATHAND_UPDATE_URL)){latest=candidate;break;}
  }catch{}}
  if(!latest&&Date.now()<deadline){const gh=await this._gh(Math.min(1500,Math.floor(remaining()/3)));if(gh&&Date.now()<deadline)try{const candidate=JSON.parse(await this._command(gh,['release','download','--repo',REPO,'--pattern','latest.json','--output','-'],{timeout:remaining()}));if(validLatest(candidate))latest=candidate;}catch{}}
  if(latest){let compatible=false;try{compatible=macCompatible((await this._command('/usr/bin/sw_vers',['-productVersion'],{timeout:Math.min(1000,remaining())})).trim(),latest.min_macos);}catch{}
   this.latest=latest;Object.assign(this.value,{status:compatible&&(compareVersions(latest.version,this.current)>0||compareVersions(latest.version,this.current)===0&&latest.build>this.currentBuild)?'available':'up_to_date',version:latest.version,build:latest.build,notes:latest.notes,url:latest.release_page,tool_schema_changed:latest.tool_schema_sha256!==this.schemaSha,checked_at:this.now()});
  }else{this.latest=null;for(const key of ['version','build','notes','tool_schema_changed'])delete this.value[key];Object.assign(this.value,{status:'unknown',url:RELEASES_URL,checked_at:this.now()});}
  return this.snapshot();
 }
 dismiss(value){if(this.local&&value==='local:'+this.local.build){if(this.run)fail('UPDATE_IN_PROGRESS','正在安装，不能取消申请。');const build=this.local.build;this._clearLocal();this.request={status:'declined',build,at:this.now()};return {dismissed:value};}if(!version(value))fail('UPDATE_VERSION_MISMATCH','这个版本已变，请重新检查更新。');this.state.data.update_dismissed_version=value;this.state.save?.();return {dismissed:value};}
 install(value,{automatic=false}={}){
  const local=this.latest?.source==='local';
  if(this.value.status!=='available'||value!==(local?'local:'+this.latest.build:this.latest?.version))fail('UPDATE_VERSION_MISMATCH','这个版本已变，请重新检查更新。');
  if(this.run||activeStates.has(this.value.install.state))return this.snapshot();
  if(automatic&&(local||!this.automaticAllowed||!clientSettings(this.state.data).auto_update))return this.snapshot();
  if(this.testMode)assertTemporaryUpdatePaths(this.stateDir,this.home,this.userDownloads,...(this.app?[this.app]:[]));
  if(!this.app){this.value.install={state:'failed',...messageMetadata('message','update.devEnvironment.message'),message:'开发环境不能自动更新'};return this.snapshot();}
  if(this.ai?.to?.build!==this.latest.build||!this.ai?.install_task||this.ai.install_task.result){
   const sourceTask=local?this.installTaskSource(this.latest.task_id):null;
   this._createInstallMarker({build:this.latest.build,version:this.latest.version,local},{sourceTask,caller:sourceTask?.caller||'chatgpt',session_hash:sourceTask?.session_hash||null,source_task_ids:local?[this.latest.task_id].filter(Boolean):[],origin:automatic?'automatic':'native_ui'});
  }
  const run={automatic,latest:structuredClone(this.latest),abort:new AbortController(),child:null,part:null,stage:null,mountDir:null,points:[]};this.run=run;this.value.install=local?{state:this.busy(this.latest.task_id||null)?'waiting_tasks':'verifying'}:{state:!automatic&&this.busy()?'waiting_tasks':'downloading',progress:0,downloaded_bytes:0,total_bytes:this.latest.dmg.size};
  run.promise=Promise.resolve().then(()=>this._install(run)).catch(e=>{if(this.run===run&&e.code!=='UPDATE_CANCELLED'){this.value.install={state:'failed',...messageMetadata('message',e.updateMessage?e.updateMessageKey:'update.failedGeneric.message'),message:e.updateMessage||'没更新成功，请再试一次，或去下载页看看'};if(local&&this.request)this.request={...this.request,status:'failed',message:this.value.install.message};this._finishInstallTask(false);}}).finally(()=>{if(this.run===run)this.run=null;});
  return this.snapshot();
 }
 _assert(run){if(this.run!==run||run.abort.signal.aborted||this.closed)throw cancelled();}
 _set(run,state,extra={}){this._assert(run);this.value.install={state,...extra};}
 async _pause(run,ms){this._assert(run);const signal=run.abort.signal;let timer,listener;try{await new Promise((resolve,reject)=>{listener=()=>{clearTimeout(timer);reject(cancelled());};signal.addEventListener('abort',listener,{once:true});if(this.sleep)Promise.resolve(this.sleep(ms)).then(resolve,reject);else timer=setTimeout(resolve,ms);});}finally{signal.removeEventListener('abort',listener);}this._assert(run);}
 _directories(){for(const dir of [this.home,this.downloads,this.staging,this.mounts]){if(fs.existsSync(dir)&&(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory()))throw Error('UNSAFE_UPDATE_PATH');privateDir(dir);}}
 async _process(run,program,args,file){
  this._assert(run);let child;try{child=this.spawn(program,args,{stdio:['ignore','pipe','pipe']});}catch(e){throw e;}run.child=child;let stdout='';child.stdout?.on('data',data=>{stdout=(stdout+String(data)).slice(-4096);});child.stderr?.on('data',()=>{});
  const progress=()=>{if(this.run!==run)return;try{const bytes=fs.statSync(file).size;Object.assign(this.value.install,{progress:Math.max(0,Math.min(1,bytes/run.latest.dmg.size)),downloaded_bytes:bytes,total_bytes:run.latest.dmg.size});}catch{}};progress();const timer=setInterval(progress,1000);timer.unref?.();
  try{return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code)=>{progress();if(code===0)resolve(stdout);else reject(Object.assign(Error('UPDATE_DOWNLOAD_FAILED'),{code,httpStatus:Number(stdout.trim().slice(-3))}));});});}finally{clearInterval(timer);if(run.child===child)run.child=null;this._assert(run);}
 }
 async _download(run){
  const latest=run.latest,final=path.join(this.downloads,latest.dmg.name);run.part=final+'.part';remove(run.part);this._set(run,'downloading',{progress:0,downloaded_bytes:0,total_bytes:latest.dmg.size});
  try{await this._process(run,'/usr/bin/curl',[...this._curl(1800),'--output',run.part,'--write-out','%{http_code}',latest.dmg.url],run.part);this._assert(run);fs.renameSync(run.part,final);return final;}catch(e){if(e.code==='UPDATE_CANCELLED')throw e;remove(run.part);
   if(e.httpStatus===403||e.httpStatus===404){const gh=await this._gh();this._assert(run);if(gh)try{remove(final);await this._process(run,gh,['release','download',`b${latest.build}`,'--repo',REPO,'--pattern',latest.dmg.name,'--dir',this.downloads],final);this._assert(run);if(fs.existsSync(final))return final;}catch(ghError){if(ghError.code==='UPDATE_CANCELLED')throw ghError;remove(final);}}
  }
  const existed=new Set();try{for(const name of fs.readdirSync(this.userDownloads))existed.add(name);}catch{}
  this._set(run,'waiting_download',{url:latest.dmg.url});await this.openURL(latest.dmg.url);this._assert(run);const until=this.now()+30*60*1000;
  while(this.now()<until){let names=[];try{names=fs.readdirSync(this.userDownloads);}catch{}
   for(const name of names){if(existed.has(name)||!/^ChatHand.*\.dmg$/.test(name))continue;const file=path.join(this.userDownloads,name);try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==latest.dmg.size||await sha256(file)!==latest.dmg.sha256)continue;this._assert(run);fs.copyFileSync(file,run.part);fs.renameSync(run.part,final);return final;}catch(e){if(e.code==='UPDATE_CANCELLED')throw e;}}
   await this._pause(run,2000);
  }
  throw Object.assign(Error('UPDATE_DOWNLOAD_TIMEOUT'),{updateMessageKey:'update.downloadTimeout.message',updateMessage:'还没等到安装包，可以再试一次'});
 }
 async _detach(run){for(const point of run.points)try{await this._command('/usr/bin/hdiutil',['detach',point],{timeout:15000});run.points=run.points.filter(p=>p!==point);}catch{}if(run.points.length===0&&run.mountDir)try{fs.rmSync(run.mountDir,{recursive:true,force:true});}catch{}}
 async _install(run){
  // A build ChatGPT made on this Mac (request_update) skips download and disk image, then shares every check below.
  const local=run.latest.source==='local',excluded=this.ai?.to?.build===run.latest.build?this.ai.source_task_ids||[]:local?run.latest.task_id||null:null,except=Array.isArray(excluded)&&excluded.length===1?excluded[0]:excluded;
  if(!run.automatic)while(this.busy(except)){this._set(run,'waiting_tasks');await this._pause(run,5000);}this._assert(run);this._directories();
  if(local)this._set(run,'verifying');
  else{const file=await this._download(run);this._set(run,'verifying');
   if(await sha256(file)!==run.latest.dmg.sha256||fs.statSync(file).size!==run.latest.dmg.size){remove(file);throw Object.assign(Error('UPDATE_HASH_MISMATCH'),{updateMessageKey:'update.hashMismatch.message',updateMessage:'安装包校验不对，没有安装'});}this._assert(run);
   run.file=file;}
  run.stage=path.join(this.staging,local?'local-'+run.latest.build:run.latest.version);if(fs.existsSync(run.stage)){if(fs.lstatSync(run.stage).isSymbolicLink())throw Error('UNSAFE_UPDATE_PATH');fs.rmSync(run.stage,{recursive:true,force:true});}privateDir(run.stage);if(!local){run.mountDir=path.join(this.mounts,'update-'+crypto.randomUUID());privateDir(run.mountDir);}
  const app=path.join(run.stage,'ChatHand.app');
  try{
   if(local){await this._command('/usr/bin/ditto',[run.latest.app_path,app],{timeout:120000});this._assert(run);}
   else{const file=run.file;
   const attached=await this._command('/usr/bin/hdiutil',['attach','-nobrowse','-readonly','-noautoopen','-mountrandom',run.mountDir,file,'-plist'],{timeout:20000});this._assert(run);
   run.points=mountPoints(attached).filter(point=>within(run.mountDir,point));const volume=run.points.find(point=>fs.existsSync(path.join(point,'ChatHand.app')));if(!volume)throw Error('UPDATE_APP_MISSING');
   await this._command('/usr/bin/ditto',[path.join(volume,'ChatHand.app'),app],{timeout:120000});this._assert(run);await this._detach(run);this._assert(run);}
   saveJSON(path.join(run.stage,'payload-manifest.json'),payloadManifest(app,run.latest.version));
   await verifyUpdateSignature({app,signerApp:this.app,command:(...a)=>this._command(...a),exec:this.exec});this._assert(run);
   const plist=path.join(app,'Contents/Info.plist'),id=(await this._command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',plist])).trim(),v=(await this._command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',plist])).trim();if(id!=='com.kenyu.chathand'||v!==run.latest.version.split('-')[0])throw Error('UPDATE_APP_IDENTITY_MISMATCH');const release=json(path.join(app,'Contents/Resources/runtime/package.json'));if(release?.version!==run.latest.version||release?.kenBridge?.build_number!==run.latest.build)throw Error('UPDATE_APP_IDENTITY_MISMATCH');
   await this._command('/usr/bin/xattr',['-dr','com.apple.quarantine',app],{timeout:20000});this._assert(run);
  }catch(e){await this._detach(run);try{fs.rmSync(run.stage,{recursive:true,force:true});}catch{}throw Object.assign(e,{updateMessageKey:'update.checkFailed.message',updateMessage:'安装包检查没通过，没有安装'});}
  // Work can begin while the download runs. Do not stop it when the installer starts.
  while(this.busy(except)){this._set(run,'waiting_tasks');await this._pause(run,5000);}this._set(run,'installing');if(local&&this.request)this.request={...this.request,status:'installing'};privateDir(this.stateDir);remove(this.resultFile);saveJSON(this.pendingFile,{from:this.current,to:run.latest.version,schema_from:this.schemaSha,started_at:this.now(),build_from:this.currentBuild,build_to:run.latest.build,source:local?'local':'remote'});
  const runtime=path.join(app,'Contents/Resources/runtime'),log=fs.openSync(path.join(this.home,'last-update.log'),'a',0o600);
  try{const child=this.spawn(appProcessExecutable(path.join(run.stage,'ChatHand.app'),'node'),[path.join(runtime,'scripts/upgrade.mjs'),'--install',run.stage,'--destination',this.app,'--result',this.resultFile],{detached:true,stdio:[this.lifecycleKey?'pipe':'ignore',log,log],env:{...this.env,CHATHAND_STATE_DIR:this.stateDir}});
   await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});if(this.lifecycleKey){if(!child.stdin)throw Error('UPDATE_AUTHORITY_PIPE_REQUIRED');child.stdin.on('error',()=>{});child.stdin.end(this.lifecycleKey+'\n');}child.unref();this._set(run,'restarting');
  }catch(e){remove(this.pendingFile);throw e;}finally{fs.closeSync(log);}
 }
 _clearLocal(){this.local=null;this.latest=null;for(const key of ['version','build','notes','tool_schema_changed','source','request_id','from_chat','source_commit','source_clean'])delete this.value[key];this.value.status='unknown';}
 /** request_update: ChatGPT asks; only the user's click in this window (/api/update/install) installs. */
 async requestLocal({app_path,note='',task_id=null,conversation_title=null}={}){
  const bad=message=>fail('UPDATE_APP_INVALID',message),busyInstalling=()=>this.run||activeStates.has(this.value.install.state);
  if(!this.app)fail('UPDATE_UNAVAILABLE','这个 ChatHand 不是装在「应用程序」里的正式 App（开发或隔离环境），不能这样更新。');
  if(busyInstalling())fail('UPDATE_IN_PROGRESS','ChatHand 正在装别的版本，等它装完再申请。');
  if(typeof app_path!=='string'||!app_path||app_path.length>1024||app_path.includes('\0')||!path.isAbsolute(app_path)||!/\.app\/?$/.test(app_path))bad('app_path 要填打好的 ChatHand.app 的绝对路径。');
  let real=null;try{const st=fs.lstatSync(app_path.replace(/\/$/,''));if(st.isSymbolicLink()||!st.isDirectory())throw Error();real=fs.realpathSync(app_path);}catch{bad('找不到这个 .app，或者它是快捷方式（符号链接）。');}
  if(this.testMode)assertTemporaryUpdatePaths(real);
  const realOr=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
  const guarded=[this.app,this.home,this.stateDir,path.join(os.homedir(),'Library','Application Support','ChatHand')].filter(Boolean).map(realOr);
  if(guarded.some(p=>real===p||real.startsWith(p+path.sep)||p.startsWith(real+path.sep)))bad('不能拿正在用的 ChatHand，或 ChatHand 自己的数据、升级目录里的东西来装。');
  const runtime=path.join(real,'Contents/Resources/runtime');let pkg=null;try{const file=path.join(runtime,'package.json');if(fs.statSync(file).size>256*1024)throw Error();pkg=JSON.parse(fs.readFileSync(file,'utf8'));}catch{bad('这个 .app 里没有 ChatHand 的运行文件（Contents/Resources/runtime/package.json）。');}
  const v=pkg?.version,build=pkg?.kenBridge?.build_number;
  if(!version(v)||!Number.isSafeInteger(build)||build<1||pkg?.kenBridge?.bundle_id!=='com.kenyu.chathand')bad('这不是 ChatHand 的包（版本号、构建号或 bundle id 不对）。');
  const order=compareVersions(v,this.current);if(!(order>0||order===0&&build>this.currentBuild))fail('UPDATE_NOT_NEWER',`这个包是 ${v} 构建 ${build}，不比现在的 ${this.current} 构建 ${this.currentBuild} 新。把 package.json 里的 kenBridge.build_number 改大，运行 node scripts/generate-version.mjs，提交，再用 node scripts/build-v09.mjs 重新打包。`);
  const plist=path.join(real,'Contents/Info.plist');let id='',short='';try{id=(await this._command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',plist])).trim();short=(await this._command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',plist])).trim();}catch{}
  if(id!=='com.kenyu.chathand'||short!==v.split('-')[0])bad('Info.plist 里的 bundle id 或版本号和包里的不一致。');
  try{await verifyUpdateSignature({app:real,signerApp:this.app,command:(...a)=>this._command(...a),exec:this.exec});}catch(e){fail(e.code||e.message||'UPDATE_SIGNATURE_INVALID','签名检查没过，或不是同一张证书签的，没有安装。');}
  if(busyInstalling())fail('UPDATE_IN_PROGRESS','ChatHand 正在装别的版本，等它装完再申请。');
  const provenance=json(path.join(runtime,'build-provenance.json'));const source_commit=/^[a-f0-9]{40}$/.test(provenance?.source_commit||'')?provenance.source_commit:null,source_clean=typeof provenance?.source_clean==='boolean'?provenance.source_clean:null;
  const text=String(note??'').replace(/[\u0000-\u001f\u007f]+/g,' ').trim().slice(0,300),requested_at=this.now(),chat=typeof conversation_title==='string'&&conversation_title.trim()?conversation_title.trim().slice(0,40):null;
  this.local={source:'local',version:v,build,app_path:real,notes:text,task_id:typeof task_id==='string'?task_id:null,conversation_title:chat,source_commit,source_clean,requested_at};this.latest=this.local;
  delete this.value.tool_schema_changed;Object.assign(this.value,{status:'available',version:v,build,notes:text,source:'local',request_id:'local:'+build,from_chat:chat,source_commit,source_clean,url:RELEASES_URL,checked_at:requested_at});
  this.value.install=idle();this.request={status:'waiting_user',version:v,build,requested_at};
  try{this.emit('update_requested',{version:v,build});}catch{}
  // 1027：ChatGPT 接着调 install_update，在这一轮里装完（Ken 10/7 定）。窗口里的「安装」还在，ChatGPT 没接着装时用户也能自己点。
  return {status:'waiting_user',version:v,build,current:{version:this.current,build:this.currentBuild},install_how:'install_update_after_user_agrees',
   message_for_user:`新版（构建 ${build}）做好了，我接着装。ChatHand 会重启，半分钟左右连不上是正常的。`,
   next_steps:[`接着调 install_update（task_id 填这个任务，build:${build}），照它返回的 next_steps 在这一轮里等它装完。`,'不要用别的办法装。']};
 }
 /** 1027 install_update：装哪个、能不能装（request_update 核对过的本机包，或发布仓库里的正式版；Ken 10/7 定：不再要用户在窗口里点）。 */
 aiPlan({build=null}={}){
  if(!this.app)fail('UPDATE_UNAVAILABLE','这个 ChatHand 不是装在「应用程序」里的正式 App（开发或隔离环境），不能这样更新。');
  if(this.run||this.aiTimer||activeStates.has(this.value.install.state))fail('UPDATE_IN_PROGRESS','ChatHand 已经在装了。调 upgrade_status（wait_s:25）等它装完。');
  if(this.value.status!=='available'||!this.latest)fail('UPDATE_NONE','现在没有可以装的新版。本机打的包先调 request_update；正式版看 bridge_info.update 有没有新版。');
  const local=this.latest.source==='local';
  if(build!==null&&build!==undefined&&build!==this.latest.build)fail('UPDATE_VERSION_MISMATCH',`准备好的是构建 ${this.latest.build}，不是 ${build}。先调 bridge_info 看清楚。`);
  return {value:local?'local:'+this.latest.build:this.latest.version,local,build:this.latest.build,version:this.latest.version,note:String(this.latest.notes||'').split('\n')[0].slice(0,120),request_task:local?this.latest.task_id||null:null,tool_schema_changed:typeof this.value.tool_schema_changed==='boolean'?this.value.tool_schema_changed:null};
 }
 aiInstall(plan,{session_hash=null,caller='chatgpt',sourceTask=null,source_task_ids=[]}={}){
  const ignored=[...new Set([plan.request_task,...source_task_ids].filter(Boolean))];
  if(this.busy(ignored))fail('UPDATE_TASK_BUSY','还有别的任务没做完（或命令在跑）；等它们做完、收尾以后再装。');
  const {install_task,marker}=this._createInstallMarker(plan,{session_hash,caller,sourceTask,source_task_ids:ignored,origin:'install_update'});
  this.aiTimer=setTimeout(()=>{this.aiTimer=null;try{this.install(plan.value);}catch(e){this.value.install={state:'failed',...messageMetadata('message',e.updateMessage?e.updateMessageKey:e.message?listedUpdateError(e):'update.notStarted.message'),message:e.updateMessage||e.message||'没开始装'};this._finishInstallTask(false);}},this.aiDelayMs);
  return {status:'restarting_soon',from:{...marker.from},to:{...marker.to},starts_in_ms:this.aiDelayMs,expected_offline_seconds:'15–40',tools_will_change:plan.tool_schema_changed,
   message_for_user:`开始装构建 ${plan.build}。ChatHand 会重启，半分钟左右连不上是正常的；装好后我接着告诉你。`,
   installation_task:{...install_task.view},next_steps:['安装任务只包括安装；新版自检通过以后才会显示成功。现在调 upgrade_status，参数 wait_s:25。','重启那 15–40 秒里，调用会失败（连不上 ChatHand），这是正常的：隔几秒再调 upgrade_status（wait_s:25），最多等 2 分钟。',`直到 phase 是 updated、current.build 是 ${plan.build}；tools_refresh 说工具清单刷新了没有。`,'超过 2 分钟还连不上，或者 phase 是 failed：照实告诉用户，请他看 ChatHand 窗口。','导入待办等装好后的工作另开任务，并以实际写入回执为准。']};
 }
 _createInstallMarker(plan,{session_hash=null,caller='chatgpt',sourceTask=null,source_task_ids=[],origin='install_update'}={}){
  const install_task=installationTask({build:plan.build,caller,sourceTask,session_hash,now:this.now()});
  const marker={at:this.now(),origin,schema_from:this.schemaSha,session_hash:typeof session_hash==='string'?session_hash:null,from:{version:this.current,build:this.currentBuild},to:{version:plan.version,build:plan.build},local:plan.local,refresh:null,source_task_ids,install_task};
  privateDir(this.stateDir);saveJSON(this.aiFile,marker);this.ai=marker;this.onInstallTask({...install_task.view});return {install_task,marker};
 }
 _schemaChanged(before){if(/^[a-f0-9]{64}$/.test(before||''))return before!==this.schemaSha;const proof=this.toolListStatus();if(proof?.observed===true&&/^[a-f0-9]{64}$/.test(proof.schema_sha256||'')){if(proof.state==='current'&&proof.schema_sha256===this.schemaSha)return false;if(proof.state==='stale'&&proof.schema_sha256!==this.schemaSha)return true;}return this.toolListCurrent()?false:null;}
 _finishInstallTask(success,marker=this.ai,reason=null){const task=marker?.install_task;if(!task||task.result)return;const result=finishInstallationTask(this.stateDir,task,{success,build:success?this.currentBuild:marker.to.build,version:success?this.current:null,reason:success?null:reason||this.value.install.message,now:this.now()});task.result=result;saveJSON(this.aiFile,this.ai);this.onInstallTask({...result});}
 _resultMarker(pending,result){
  const ai=this.ai;if(!ai?.install_task||ai.install_task.result)return null;
  const target=pending?.to??result?.to,build=pending?.build_to;
  if(target&&target!==ai.to?.version||Number.isSafeInteger(build)&&build!==ai.to?.build)return null;
  return ai;
 }
 _supersededForCurrent(){if((this.ai?.to?.build??0)>this.currentBuild||(this.run?.latest?.build??0)>this.currentBuild)return null;const g=this.guard?.inspect(),s=this.superseded|| (g?.outcome==='superseded'?{current:g.superseded_by}:null);return s?.current?.version===this.current&&s.current.build===this.currentBuild&&s.current.schema_sha256===this.schemaSha&&g?.active===false?s:null;}
 async _installerActive(){
  const result=await this.exec('/bin/ps',['-axo','pid=,command='],{encoding:'utf8',timeout:2000,maxBuffer:2*1024*1024});
  const output=typeof result==='string'?result:String(result?.stdout||'');
  // Inspect internally and return only a boolean. Never log command text.
  return output.split('\n').some(line=>{
   if(!/^\s*\d+\s+/.test(line)||!/\/scripts\/upgrade\.mjs\s+--(?:install|recover)(?:\s|$)/.test(line))return false;
   const destination=line.match(/(?:^|\s)--destination\s+(.+?)(?=\s+--[a-z-]+(?:\s|$)|$)/)?.[1]?.trim();
   if(destination){const value=destination.replace(/^(["'])(.*)\1$/,'$2');return path.resolve(value)===path.resolve(this.app);}
   // Without a destination, only this product's own runtime/staging can be
   // associated. A foreign isolated installer is not evidence of our activity.
   return line.includes(this.home+path.sep)||line.includes(this.app+path.sep+'Contents/Resources/runtime/');
  });
 }

 _scheduleStartupRetry(){if(this.closed||this.startupRetryTimer)return;this.startupRetryTimer=setTimeout(async()=>{this.startupRetryTimer=null;if(this.closed)return;const before=this.value.install.state;await this.reconcileStartup();if(!this.guard?.inspect().active){this._readResult();if(this.value.install.code==='UPGRADE_STILL_RUNNING'&&!json(this.pendingFile))this.value.install=idle();}if(before!==this.value.install.state)this.emit('update_changed',{state:this.value.install.state});},500);this.startupRetryTimer.unref?.();}
 async reconcileStartup(){
  if(!this.guard?.inspect().active&&!this._supersededForCurrent())return {reconciled:false};
  try{const outcome=await reconcileStartupUpgrade({guard:this.guard,stateDir:this.stateDir,home:this.home,app:this.app,version:this.current,build:this.currentBuild,verifyCurrent:()=>verifyInstalledUpdate({app:this.app,version:this.current,build:this.currentBuild,liveContract:this.liveContract,command:(...a)=>this._command(...a),exec:this.exec}),finish:proof=>this.finishUpgrade?this.finishUpgrade(proof):this.guard.supersede(proof),installerActive:this.installerActive});
   if(outcome.reconciled){this.superseded={current:outcome.current,previous_result:json(this.resultFile),previous_pending:json(this.pendingFile),old_guard:{id:outcome.id??null,build:outcome.old_build},at:this.now()};saveJSON(this.supersededFile,this.superseded);this.value.install=idle();this.value.just_updated={from:this.ai?.from?.version||this.current,to:this.current,build_to:this.currentBuild,tool_schema_changed:this._schemaChanged(this.superseded?.previous_pending?.schema_from??this.ai?.schema_from),superseded:true};if(this.ai?.install_task&&!this.ai.install_task.result)this._finishInstallTask(false);}
   return outcome;
  }catch(e){if(e.code==='UPGRADE_STILL_RUNNING'){this.value.install={state:'verifying',code:e.code,message:'正在装新版，马上回来。'};this._scheduleStartupRetry();return {reconciled:false,pending:true,code:e.code};}this.value.install={state:'failed',...messageMetadata('message','update.dragAgain.message'),message:'请将新版本重新拖入「应用程序」并打开。',code:/^[A-Z_]+$/.test(e.code||e.message||'')?e.code||e.message:'UPGRADE_CURRENT_INVALID'};return {reconciled:false,code:this.value.install.code};}
 }
 /** upgrade_status 给 ChatGPT 看的：这次装到哪一步了。 */
 aiStatus(){
  // 新版刚起来时，升级结果可能已经写好了、计时器还没读到：先读一次，免得 ChatGPT 多等。
  if(!this.value.just_updated&&fs.existsSync(this.pendingFile))try{this._readResult();}catch{/* 读不到就按文件现状报 */}
  const superseded=this._supersededForCurrent();if(superseded)this._readResult();
  const install=this.value.install,ju=this.value.just_updated,ai=this.ai,pending=json(this.pendingFile),result=json(this.resultFile);
  let phase='idle';
  if(this.aiTimer)phase='starting';
  else if(install.state==='restarting')phase='restarting';
  else if(activeStates.has(install.state))phase='installing';
  else if(install.state==='failed')phase='failed';
  else if(superseded||ju||!pending&&(this._completedForCurrentBuild()||ai&&this.now()-(ai.at||0)<30*60*1000&&Number.isSafeInteger(ai.to?.build)&&this.currentBuild>=ai.to.build&&ai.to.build>(ai.from?.build??0)))phase='updated';
  else if(pending&&!result)phase='verifying';
  return {phase,current:{version:this.current,build:this.currentBuild},target:superseded||ai?.to?.build<=this.currentBuild?{version:this.current,build:this.currentBuild}:ai?.to?{...ai.to}:this.latest?{version:this.latest.version,build:this.latest.build}:null,install_state:install.state,...(install.message?{install_message:install.message}:{}),just_updated:ju?{...ju}:null,tools_changed:ju?(typeof ju.tool_schema_changed==='boolean'?ju.tool_schema_changed:null):phase==='updated'?this._completedForCurrentBuild()?.tools_changed??null:null,request:this.request?{...this.request}:null};
 }
 /** What bridge_info shows ChatGPT: no paths, only state. */
 forAI(){const s=this.snapshot(),local=this.latest?.source==='local';return {current:{version:this.current,build:this.currentBuild},status:s.status,install_state:this.value.install.state,...(this.value.install.message?{install_message:this.value.install.message}:{}),request:this.request?{...this.request}:null,just_updated:this.value.just_updated?{...this.value.just_updated}:null,
  // 1027：有可装的新版时告诉 ChatGPT 能不能自己装（install_update），还是要用户在窗口里点。
  ...(this.value.status==='available'&&this.latest&&!activeStates.has(this.value.install.state)?{installable:{version:this.latest.version,build:this.latest.build,source:local?'local_build':'release',...(local?{}:{notes:String(this.latest.notes||'').slice(0,300)}),how:'install_update_after_user_agrees'}}:{})};}
 cancel({automatic=false}={}){if(!['waiting_tasks','waiting_download','downloading',...(automatic&&this.run?.automatic?['verifying']:[])].includes(this.value.install.state))return this.snapshot();const run=this.run;if(run){run.abort.abort();try{run.child?.kill('SIGTERM');}catch{}if(run.part)remove(run.part);if(run.child&&run.latest?.dmg)remove(path.join(this.downloads,run.latest.dmg.name));this.run=null;}this.value.install=idle();if(run)this._finishInstallTask(false,this.ai,'安装已取消');return this.snapshot();}
 _completedForCurrentBuild(){const c=this.completed;return c?.version===this.current&&Number.isSafeInteger(c.build)&&c.build===this.currentBuild&&c.schema_sha256===this.schemaSha&&typeof c.tools_changed==='boolean'?c:null;}
 ack(){if(this._supersededForCurrent()){this.superseded={...(this.superseded||{current:this.guard.inspect().superseded_by}),acknowledged:true};saveJSON(this.supersededFile,this.superseded);}this.value.just_updated=null;if(!activeStates.has(this.value.install.state))this.value.install=idle();if(!this._supersededForCurrent()){remove(this.pendingFile);remove(this.resultFile);}if(this.resultTimer){clearInterval(this.resultTimer);this.resultTimer=null;}return {acked:true};}
 _readResult(){
  if(this._supersededForCurrent()){this.value.install=idle();if(!this.superseded?.acknowledged)this.value.just_updated||={from:this.current,to:this.current,build_to:this.currentBuild,tool_schema_changed:this._schemaChanged(this.superseded?.previous_pending?.schema_from??this.ai?.schema_from),superseded:true};if(this.ai?.install_task&&!this.ai.install_task.result)this._finishInstallTask(false);return false;}
  const result=json(this.resultFile),pending=json(this.pendingFile);if(!result)return !!pending;
  const marker=this._resultMarker(pending,result);
  if(marker&&Number.isFinite(Date.parse(result.time))&&Date.parse(result.time)<marker.at)return true;
  if(marker&&result.status==='COMMITTED'&&result.to!==this.current){this.value.install={state:'failed',...messageMetadata('message','update.versionUnverified.message'),message:'安装的版本未通过核验。'};this._finishInstallTask(false,marker);return false;}
  if(result.status==='COMMITTED'&&result.to===this.current){
   const task=marker?.install_task,expectedBuild=pending?.build_to??marker?.to?.build;
   if(Number.isSafeInteger(expectedBuild)&&expectedBuild!==this.currentBuild){this.value.install={state:'failed',rolled_back:true,...messageMetadata('message','update.buildNotInstalled.message',{expectedBuild,currentBuild:this.currentBuild}),message:`没装上新构建 ${expectedBuild}，现在还是构建 ${this.currentBuild}`};this._finishInstallTask(false,marker);return false;}
   if(task&&(this.guard?.inspect().active===true||!Number.isSafeInteger(expectedBuild))){this.value.install={state:'verifying'};return true;}
   if(task&&(result.schema_to!==this.schemaSha||marker.to?.version!==this.current)){this.value.install={state:'failed',...messageMetadata('message','update.selfCheckFailed.message'),message:'新版自检没有通过，请查看 ChatHand 窗口。'};this._finishInstallTask(false,marker);return false;}
   const from=result.from||pending?.from;
   if(version(from)){const fresh=!this.value.just_updated;this.value.just_updated={from,to:this.current,tool_schema_changed:this._schemaChanged(result.schema_from??pending?.schema_from??this.ai?.schema_from),...(Number.isSafeInteger(expectedBuild)?{...(Number.isSafeInteger(pending?.build_from)?{build_from:pending.build_from}:{}),build_to:this.currentBuild}:{})};
    if(Number.isSafeInteger(this.currentBuild)&&this.currentBuild>0){this.completed={version:this.current,build:this.currentBuild,schema_sha256:this.schemaSha,tools_changed:this.value.just_updated.tool_schema_changed,at:this.now()};saveJSON(this.completedFile,this.completed);}
    if(fresh&&this.onUpdated)try{this.onUpdated({...this.value.just_updated},this.ai?{...this.ai}:null);}catch{}
   }
   this.value.install=idle();this._finishInstallTask(true,marker);return false;
  }
  if(result.status==='ROLLBACK_FAILED'){this.value.install={state:'failed',rolled_back:false,...messageMetadata('message',this.guard?.inspect().active?'update.dragAgain.message':'update.rollbackFailed.message'),message:this.guard?.inspect().active?'请将新版本重新拖入「应用程序」并打开。':'没更新成功，原来的版本还没恢复，请检查并修复'};this._finishInstallTask(false,marker);return false;}
  if(typeof result.status==='string'&&(result.status.includes('ROLLED_BACK')||['FAILED','ERROR','ABORTED_AFTER_INTERRUPTION'].includes(result.status))){this.value.install={state:'failed',rolled_back:result.status.includes('ROLLED_BACK'),...messageMetadata('message',result.status.includes('ROLLED_BACK')?'update.rolledBack.message':'update.failedNotInstalled.message'),message:result.status.includes('ROLLED_BACK')?'没更新成功，已换回原来的版本':'没更新成功，没有安装新版'};this._finishInstallTask(false,marker);return false;}
  return !!pending;
 }

 start(){if(this.timer)return this.snapshot();this.closed=false;if(this._readResult()){const until=this.now()+10*60*1000;this.resultTimer=setInterval(()=>{if(!this._readResult()||this.now()>=until){clearInterval(this.resultTimer);this.resultTimer=null;}},500);this.resultTimer.unref?.();}void this.check();this.timer=setInterval(()=>void this.check(),DAY);this.timer.unref?.();return this.snapshot();}
 close(){this.cancel();this.closed=true;clearInterval(this.timer);clearInterval(this.resultTimer);clearTimeout(this.aiTimer);clearTimeout(this.startupRetryTimer);this.timer=null;this.resultTimer=null;this.aiTimer=null;this.startupRetryTimer=null;}
 async cleanupLeftovers(){
  let cleaned=0;const protectedPaths=[this.run?.stage,this.run?.mountDir,this.run?.part].filter(Boolean),journal=json(path.join(this.home,'current.json'));if(journal?.candidate&&!['committed','rolled_back','aborted'].includes(journal.phase))protectedPaths.push(path.dirname(journal.candidate));
  const inUse=file=>protectedPaths.some(p=>p===file||within(file,p)||within(p,file)),stale=file=>{try{const s=fs.lstatSync(file);return !s.isSymbolicLink()&&this.now()-s.mtimeMs>HOUR;}catch{return false;}};
  for(const root of [this.staging,this.downloads]){let entries=[];try{if(fs.lstatSync(root).isSymbolicLink())continue;entries=fs.readdirSync(root);}catch{}for(const name of entries){const file=path.join(root,name);if(root===this.downloads&&!name.endsWith('.part')||inUse(file)||!stale(file))continue;try{fs.rmSync(file,{recursive:root===this.staging,force:true});cleaned++;}catch{}}}
  try{if(fs.lstatSync(this.mounts).isSymbolicLink())return {cleaned};const info=await this._command('/usr/bin/hdiutil',['info','-plist'],{timeout:5000});for(const point of mountPoints(info)){if(!within(this.mounts,point)||inUse(point))continue;try{await this._command('/usr/bin/hdiutil',['detach',point],{timeout:10000});cleaned++;}catch{}}}catch{}return {cleaned};
 }
}
