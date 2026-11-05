import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fail} from '../../engine/src/core.mjs';
import {t} from '../i18n.mjs';
import {WorkspaceInspector,inspectWorkspaceWithRetry,temporaryWorkspaceFailure} from './workspace-inspector.mjs';
import {noteWorkspaceCommandsStopped} from './workspace-notice.mjs';

const inside=(target,base)=>target===base||target.startsWith(base+path.sep);
// Check the parent in the isolated probe, not on the server's event loop.
// The action repeats all checks because the folder can change after inspection.
function canRecreateWorkspace(root,stateDir){
 try{
  const parent=path.dirname(root);
  if(parent===root||path.resolve(root)!==root||inside(root,stateDir)||inside(stateDir,root))return false;
  const real=fs.realpathSync(parent);
  if(real!==parent||!fs.statSync(real).isDirectory())return false;
  fs.accessSync(real,fs.constants.W_OK|fs.constants.X_OK);
  return true;
 }catch{return false;}
}
export function inspectWorkspace(root,stateDir){
 const base={path:root,available:false,writable:false,status:'invalid',code:'ROOT_INVALID'};
 if(typeof root!=='string'||!root||root.length>4096||root.includes('\0')||!path.isAbsolute(root))return base;
 try{
  const real=fs.realpathSync(root),st=fs.statSync(real);
  if(!st.isDirectory())return base;
  if(inside(real,stateDir))return {...base,code:'ROOT_STATE_OVERLAP'};
  fs.accessSync(real,fs.constants.R_OK|fs.constants.X_OK);
  const valid={...base,available:true,writable:true,status:'available',code:null,real_path:real,identity:{dev:st.dev,ino:st.ino}};
  try{fs.accessSync(real,fs.constants.W_OK);}catch(error){if(!/^E[A-Z]+$/.test(error.code||''))throw error;return {...valid,writable:false,status:'read_only',code:error.code};}
  return valid;
 }catch(error){
  if(error.code==='ENOENT')return {...base,status:'missing',code:'ENOENT',can_recreate:canRecreateWorkspace(root,stateDir)};
  if(['ENOTDIR','ELOOP','ERR_INVALID_ARG_VALUE'].includes(error.code))return base;
  if(/^E[A-Z]+$/.test(error.code||''))return {...base,status:'inaccessible',code:error.code};
  throw error;
 }
}
export function workspaceFailure(status){
 const message=status.status==='stopping'?t('workspace.notice.stopping',{},'zh')+' / '+t('workspace.notice.stopping',{},'en'):temporaryWorkspaceFailure(status)?'工作区暂时没有响应，请稍后重试或换一个文件夹。 / The workspace did not respond. Retry or choose another folder.':status.status==='inaccessible'?'无法访问工作区，请检查文件夹权限或换一个文件夹。 / Workspace access denied or unavailable. Check folder permissions or choose another folder.':'工作区无法访问，请在 ChatHand 窗口选择「在原位置重新建」或「换一个文件夹」。 / Workspace unavailable. Recreate it at the original location or choose another folder in ChatHand.';
 const error=Object.assign(new Error(message),{code:'WORKSPACE_UNAVAILABLE',...(status.confirm_reason==='missing'||status.status==='missing'?{details:{workspace_reason:'missing'}}:{})});
 if(status.status==='stopping')Object.defineProperty(error,'workspaceAutoStopPending',{value:true});
 return error;
}
export function workspaceReadOnly(){return Object.assign(new Error('工作区只读，请检查文件夹权限或换一个文件夹。 / Workspace is read-only. Check folder permissions or choose another folder.'),{code:'WORKSPACE_READ_ONLY'});}

// Workspace authority is separate from browser/desktop permission authority.
// A task keeps the workspace generation it was created with even if it has
// only used the browser so far; recovery never grants it a new file scope.
const WORKSPACE_TOOLS=new Set(['read_file','get_file_info','list_directory','read_text','search_text','start_search','search_results','git_inspect','write_text','edit_file','restore_file','create_directory','move_path','trash_path','restore_trash','propose_command','command_input','save_files','expect_download','records_export','browser_upload','browser_download','image_batch_start','image_batch_save']);
export function usesWorkspace(name,args={}){return WORKSPACE_TOOLS.has(name)||name==='desktop_action'&&['reveal','open_path'].includes(args.action)||name==='system_inspect'&&args.section==='disk';}
export function workspaceRecord(record){return record.workspace_dependent===true||WORKSPACE_TOOLS.has(record.name)||record.name==='desktop_action'&&record.workspace_dependent!==false;}

export function bindWorkspaceRecovery(state,store,policy,{defaultWorkspace=path.join(os.homedir(),'ChatHand-Workspace'),...probeOptions}={}){
 // UI cancellation must never cancel an operation's permission check.
 const channels={use:{inspector:new WorkspaceInspector(probeOptions),version:0},ui:{inspector:new WorkspaceInspector(probeOptions),version:0},auto:{inspector:new WorkspaceInspector(probeOptions),version:0}};
 store.workspaceEpoch=Number.isSafeInteger(state.data.workspace_epoch)?state.data.workspace_epoch:0;
 let tools=null,closed=false,transitionOwner=null,pendingStop=null;
 const identities=state.data.workspace_identities,saved=identities&&Object.hasOwn(identities,state.project().id)?identities[state.project().id]:null;
 const hasSavedIdentity=!!saved&&saved.path===state.project().path&&typeof saved.real_path==='string'&&path.isAbsolute(saved.real_path)&&saved.real_path.length<=4096&&!saved.real_path.includes('\0')&&Number.isSafeInteger(saved.ino)&&saved.ino>=0;
 if(hasSavedIdentity){store.workspaceAcceptedPath=saved.real_path;store.workspaceIdentity={ino:saved.ino};}
 const reasons=new Set(['replaced','missing','access_denied','inaccessible','invalid','legacy_identity_unknown']);
 if(store.workspaceRecoveryRequired&&reasons.has(state.project().workspace_recovery_reason)){store.workspaceConfirmReason=state.project().workspace_recovery_reason;store.workspace.confirm_reason=store.workspaceConfirmReason;}
 const rememberIdentity=()=>{
  const project=state.project(),value={path:project.path,real_path:store.workspaceAcceptedPath,ino:store.workspaceIdentity.ino},previous=state.data.workspace_identities,keys=['workspace_recovery_required','workspace_recovery_reason','workspace_create_pending'],flags=new Map(keys.filter(key=>Object.hasOwn(project,key)).map(key=>[key,project[key]]));let changed=false;
  if(JSON.stringify(state.data.workspace_identities?.[project.id])!==JSON.stringify(value)){
   if(!state.data.workspace_identities||typeof state.data.workspace_identities!=='object'||Array.isArray(state.data.workspace_identities))state.data.workspace_identities={};
   state.data.workspace_identities={...state.data.workspace_identities,[project.id]:value};changed=true;
  }
  for(const key of keys)if(Object.hasOwn(project,key)){delete project[key];changed=true;}
  if(changed)try{state.save();}catch(error){if(previous===undefined)delete state.data.workspace_identities;else state.data.workspace_identities=previous;for(const key of keys){if(flags.has(key))project[key]=flags.get(key);else delete project[key];}throw error;}
 };
 const cancel=channel=>{channel.version++;channel.inspector.cancel();};
 const use=task=>{
  if(!task)return;
  if((task.workspace_epoch||0)!==store.workspaceEpoch||!store.matchesRoot(task.root)||task.project_id!==state.data.active)fail('ROOT_CHANGED','工作区已改变，原任务不能获得恢复后文件夹的权限。请开始新任务。');
  if(!task.workspace_dependent){task.workspace_dependent=true;policy.emit('task_workspace_used',{task_id:task.id});}

 };
 store.onWorkspaceUse=use;policy.useWorkspace=task=>{store.requireWorkspace();use(typeof task==='string'?policy.get(task):task);};
 const revokeDependent=()=>{
  const ids=new Set([...policy.tasks.values()].filter(t=>t.workspace_dependent).map(t=>t.id));
  for(const [job,owner]of policy.jobOwners)if(policy.queue.jobs.has(job))ids.add(owner);
  for(const approval of policy.approvals.values())if(usesWorkspace(approval.tool||approval.name||approval.kind,approval.args||{}))ids.add(approval.task_id);
  let error=null;
  // Every command uses the selected workspace, including direct/local jobs
  // without a task/card owner. Cancel running process groups and inputs first.
  try{policy.queue.cancelAll();}catch(e){error??=e;}
  try{tools?.features.cancel();}catch(e){error??=e;}
  try{tools?.artifacts.cancelAll();}catch(e){error??=e;}
  for(const id of ids){const task=policy.tasks.get(id);if(!task)continue;
   try{tools?.automation.cancelTask?.(id);}catch(e){error??=e;}
   if(['active','pending_approval'].includes(task.status)||task.persistence_error)try{policy.revokeTask(task,'workspace_changed');}catch(e){error??=e;}
  }
  policy.emit('workspace_changed',{workspace_epoch:store.workspaceEpoch});
  if(error)throw error;
 };
 const advance=({switchProject=false}={})=>{
  store.workspaceEpoch++;state.data.workspace_epoch=store.workspaceEpoch;
  try{if(switchProject)policy.revokeAll('workspace_changed');else revokeDependent();}
  finally{state.save();}
 };
 const mark=status=>{
  const project=state.project(),reason=reasons.has(status?.confirm_reason)?status.confirm_reason:'legacy_identity_unknown',changed=project.workspace_recovery_reason!==reason;
  project.workspace_recovery_reason=reason;
  if(project.workspace_recovery_required===true){if(changed)state.save();return;}
  project.workspace_recovery_required=true;advance();
 };
 store.onWorkspaceUnavailable=mark;
 store.onWorkspaceVerified=rememberIdentity;
 // Full access may keep the same workspace path without revoking work. Repeat
 // every filesystem check synchronously: the child probe is only a hint.
 const fullReady=()=>state.data.mode==='full'&&state.data.full_access_confirmed===true&&store.accessMode==='full'&&policy.fullArmed===true&&policy.enabled===true&&!policy.connectionUnavailable&&!policy.transitioning&&!store.paused&&!store.workspaceTransitioning;
 const pendingView=p=>({workspace:{path:p.root,available:false,writable:false,status:'stopping',code:'WORKSPACE_STOPPING'}});
 const pendingCurrent=()=>pendingStop&&pendingStop.project===state.project()&&pendingStop.root===state.project().path&&pendingStop.epoch===store.workspaceEpoch?pendingStop:null;
 store.onWorkspaceAutoRecoveryPending=()=>{const p=pendingCurrent();return p?pendingView(p):null;};
 const waitForStop=p=>{
  if(!p.promise)p.promise=(async()=>{
   const until=Date.now()+5000;
   const stopped=()=>p.jobs.every(j=>typeof policy.queue.settled==='function'?policy.queue.settled(j):!j.child&&!j.cleanupPending&&!j.process_alive&&!j.cleanup_pending);
   while(!stopped()&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
   return stopped();
  })().finally(()=>{p.promise=null;});
  return p.promise;
 };
 store.onWorkspaceCanAutoRecover=()=>fullReady()&&(store.workspaceConfirmReason==='replaced'||store.workspaceConfirmReason==='missing'&&state.project().path===defaultWorkspace);
 store.onWorkspaceAutoRecover=(reason)=>{
  if(!fullReady())return null;
  const project=state.project(),root=project.path;
  if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||root.includes('\0')||path.dirname(root)===root)return null;
  if(reason==='missing'&&root!==defaultWorkspace)return null;
  let live=inspectWorkspace(root,store.stateDir);
  // The first observation may already be stale. An uncertain second check
  // does not establish a changed folder and must not stop running commands.
  if(!live.available&&live.status!=='missing')return {defer:true,workspace:live};
  try{
   const parent=path.dirname(root),realParent=fs.realpathSync(parent),before=fs.statSync(realParent);
   if(realParent!==parent||!before.isDirectory())return null;
   store.checkProtected(root,{write:true});
   const changed=live.available&&!!store.workspaceAcceptedPath&&store.workspaceIdentity?.ino!==undefined&&
    (live.real_path!==store.workspaceAcceptedPath||live.identity.ino!==store.workspaceIdentity.ino);
   const missing=live.status==='missing';
   if(missing&&root!==defaultWorkspace)return null;
   if(live.available){const leaf=fs.lstatSync(root);if(!leaf.isDirectory()||leaf.isSymbolicLink()||!live.writable||live.real_path!==root||leaf.ino!==live.identity.ino||leaf.dev!==live.identity.dev)return null;}
   const jobs=[...policy.queue.jobs.values()].filter(j=>j.child||j.cleanupPending||j.process_alive||j.cleanup_pending);
   if((missing||changed)&&jobs.some(j=>typeof policy.queue.settled==='function'?!policy.queue.settled(j):true)){
    // cancelAll initiates process-group cleanup; accepting the new folder
    // must wait until those processes really exit.
    const pending={root,project,epoch:store.workspaceEpoch,permissionEpoch:policy.epoch,revision:policy.permissionRevision||0,jobs,promise:null,finish:null};
    pendingStop=pending;
    try{policy.queue.cancelAll();}catch(error){pendingStop=null;throw error;}
    return {defer:true,...pendingView(pending)};
   }
   let recreated=false;
   if(live.status==='missing'){
    fs.accessSync(parent,fs.constants.W_OK|fs.constants.X_OK);
    try{fs.mkdirSync(root,{mode:0o700});recreated=true;}catch(error){if(error.code!=='EEXIST')throw error;}
    live=inspectWorkspace(root,store.stateDir);
   }
   // Only a normal, writable directory at the same path may be accepted.
   const leaf=fs.lstatSync(root),after=fs.statSync(fs.realpathSync(parent));
   if(!fullReady()||state.project()!==project||project.path!==root||!leaf.isDirectory()||leaf.isSymbolicLink()||!live.available||!live.writable||live.real_path!==root||leaf.ino!==live.identity.ino||leaf.dev!==live.identity.dev||before.ino!==after.ino||before.dev!==after.dev||fs.realpathSync(parent)!==parent)return null;
   return {workspace:live,recreated};
  }catch{return null;}
 };
 store.onWorkspaceInitialize=()=>{
  if(!state.project().workspace_create_pending)return;
  const root=state.project().path;
  if(typeof root!=='string'||!path.isAbsolute(root)||root.includes('\0'))return;
  try{fs.mkdirSync(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST'&&!/^E[A-Z]+$/.test(error.code||''))throw error;}
 };
 return {
  attach(value){
   tools=value;tools.ensureWorkspace=async()=>{const project=await this.check();if(project.workspace_commands_stopped)noteWorkspaceCommandsStopped();if(project.workspace.available!==true||store.workspaceTransitioning)throw workspaceFailure(project.workspace);return {recreated:project.workspace_recreated===true,commandsStopped:project.workspace_commands_stopped===true};};
   // Only an already-latched folder with a trustworthy saved identity needs a
   // startup check. Normal startup and pure browser/desktop work remain lazy.
   this.startupCheck=hasSavedIdentity&&state.project().workspace_recovery_required===true?this.check().catch(()=>null):Promise.resolve(null);
  },
  close(){closed=true;for(const channel of Object.values(channels)){cancel(channel);channel.inspector.close();}},
  project:()=>({...state.project(),workspace:store.workspaceStatus()}),
  async check({source='use'}={}){
   if(closed||store.workspaceTransitioning)fail('ROOT_CHANGED','工作区已改变，原操作不能继续。 / The workspace changed. Start the operation again.');
   const channel=source==='ui'?channels.ui:channels.use,project=state.project(),root=project.path,epoch=store.workspaceEpoch,version=channel.version;
   const key=JSON.stringify([project.id,root,epoch,version]);
   if(channel.flight?.key===key)return channel.flight.promise;
   const sameScope=()=>!closed&&!store.workspaceTransitioning&&state.project()===project&&project.path===root&&store.workspaceEpoch===epoch;
   const run=async()=>{
    const log=(outcome,status,n)=>tools?.events?.record('workspace.check',{source:source==='ui'?'ui':'use',outcome,code:status.code||'OK',confirm_reason:status.confirm_reason||null,...(n?{n}:{})});
    const result=await inspectWorkspaceWithRetry(channel.inspector,root,store.stateDir,{create:project.workspace_create_pending===true,cancelled:()=>channel.version!==version||!sameScope(),onAttempt:(result,n)=>{if(temporaryWorkspaceFailure(result))log('retry',result,n);}});
    if(!sameScope())fail('ROOT_CHANGED','工作区已改变，原操作不能继续。 / The workspace changed. Start the operation again.');
    if(result.cancelled||channel.version!==version){if(source==='ui')return this.project();fail('ROOT_CHANGED','工作区检查已取消，原操作不能继续。 / The workspace check was cancelled. Start the operation again.');}
    const before=store.workspaceStatus(),observation={};store.applyWorkspaceInspection(result,{recheck:true,recordNotice:false,observation});
    const pending=pendingCurrent();
    if(pending){
     // The owner keeps the gate closed through the fresh check and commit;
     // other callers share the same result instead of accepting stale probes.
     if(!pending.finish)pending.finish=(async()=>{
      const auto=channels.auto,autoVersion=auto.version;
      const pendingScope=()=>!closed&&!store.workspaceTransitioning&&state.project()===pending.project&&pending.project.path===pending.root&&store.workspaceEpoch===pending.epoch&&
       policy.epoch===pending.permissionEpoch&&(policy.permissionRevision||0)===pending.revision&&fullReady();
      if(!await waitForStop(pending))return {stopped:false};
      if(!pendingScope()){
       if(pendingStop===pending)pendingStop=null;
       fail('ROOT_CHANGED','工作区或权限已改变，原操作不能继续。 / The workspace or permissions changed. Start the operation again.');
      }
      const fresh=await inspectWorkspaceWithRetry(auto.inspector,pending.root,store.stateDir,{create:false,cancelled:()=>auto.version!==autoVersion||!pendingScope()});
      if(!pendingScope()||fresh.cancelled||auto.version!==autoVersion){
       if(pendingStop===pending)pendingStop=null;
       fail('ROOT_CHANGED','工作区或权限已改变，原操作不能继续。 / The workspace or permissions changed. Start the operation again.');
      }
      const recovered={commandsStopped:true};
      try{store.applyWorkspaceInspection(fresh,{recheck:true,recordNotice:false,observation:recovered,bypassAutoRecoveryPending:true});}
      finally{if(pendingStop===pending)pendingStop=null;}
      return {stopped:true,...recovered};
     })().finally(()=>{pending.finish=null;});
     const outcome=await pending.finish;
     if(outcome.stopped){observation.commandsStopped=true;if(outcome.recreated)observation.recreated=true;}
    }
    const status=store.workspaceStatus();if(!status.available||before.available!==true)log(status.available?'ok':'failed',status);
    return {...this.project(),...(observation.recreated?{workspace_recreated:true}:{}),...(observation.commandsStopped?{workspace_commands_stopped:true}:{})};
   };
   const flight={key};flight.promise=run().finally(()=>{if(channel.flight===flight)channel.flight=null;});channel.flight=flight;return flight.promise;
  },
  cancelCheck(){cancel(channels.ui);return {cancelled:true};},
  candidate(){const w=store.workspace;return w.status==='missing'?{missing:true}:w.real_path&&w.identity?{real_path:w.real_path,identity:{ino:w.identity.ino}}:null;},
  async resetAuthority({switchProject=false,owner=null}={}){
   if(store.workspaceTransitioning)fail('WORKSPACE_TRANSITION','工作区正在恢复，请稍后重试。');
   store.workspaceTransitioning=true;transitionOwner=owner;for(const channel of Object.values(channels))cancel(channel);advance({switchProject});
   const until=Date.now()+5000;
   while(policy.queue.list().some(j=>j.process_alive||j.cleanup_pending)&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
   if(policy.queue.list().some(j=>j.process_alive||j.cleanup_pending))fail('STOP_INCOMPLETE','旧任务尚未停止，请稍后重试。');
  },
  finishTransition(owner=null){if(transitionOwner!==owner)return false;store.workspaceTransitioning=false;transitionOwner=null;return true;},
  activate(project,{switchProject=false,expectedWorkspace=null}={}){
   store.setRoot(project.path,{recoverWorkspace:true,expectedWorkspace});store.writesEnabled=policy.enabled;
   state.data.active=project.id;state.data.setup_workspace_confirmed=true;
   if(switchProject)state.data.permission_tier_intent='custom';rememberIdentity();state.save();
   return {project:this.project()};
  },
  recreate({expectedWorkspace=null}={}){
   if(store.workspaceStatus().status==='read_only')throw workspaceReadOnly();
   const project=state.project(),root=project.path;
   if(typeof root!=='string'||!root||root.includes('\0')||!path.isAbsolute(root)||path.dirname(root)===root)fail('ROOT_INVALID','原工作区路径无效，请换一个文件夹。');
   const parent=fs.realpathSync(path.dirname(root));
   if(parent!==path.dirname(root))fail('LINK_BLOCKED','原位置已改变，请换一个文件夹。');
   store.checkProtected(root,{write:true});
   try{const st=fs.lstatSync(root);if(st.isSymbolicLink()||!st.isDirectory())fail('ROOT_INVALID','原位置不是普通文件夹，请换一个文件夹。');if(expectedWorkspace?.missing)throw workspaceFailure({status:'recovery_required'});}
   catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(root,{mode:0o700});}
   return this.activate(project,{expectedWorkspace:expectedWorkspace?.missing?inspectWorkspace(root,store.stateDir):expectedWorkspace});
  }
 };
}
