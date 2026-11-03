import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../../engine/src/core.mjs';
import {WorkspaceInspector,WorkspaceMonitor} from './workspace-inspector.mjs';

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
 const message=['WORKSPACE_TIMEOUT','WORKSPACE_PROBE_BUSY'].includes(status.code)?'工作区暂时没有响应，请稍后重试或换一个文件夹。 / The workspace did not respond. Retry or choose another folder.':status.status==='inaccessible'?'无法访问工作区，请检查文件夹权限或换一个文件夹。 / Workspace access denied or unavailable. Check folder permissions or choose another folder.':'工作区无法访问，请在 ChatHand 窗口选择「在原位置重新建」或「换一个文件夹」。 / Workspace unavailable. Recreate it at the original location or choose another folder in ChatHand.';
 return Object.assign(new Error(message),{code:'WORKSPACE_UNAVAILABLE'});
}
export function workspaceReadOnly(){return Object.assign(new Error('工作区只读，请检查文件夹权限或换一个文件夹。 / Workspace is read-only. Check folder permissions or choose another folder.'),{code:'WORKSPACE_READ_ONLY'});}

// Workspace authority is separate from browser/desktop permission authority.
// A task keeps the workspace generation it was created with even if it has
// only used the browser so far; recovery never grants it a new file scope.
const WORKSPACE_TOOLS=new Set(['read_file','get_file_info','list_directory','read_text','search_text','start_search','search_results','git_inspect','write_text','edit_file','restore_file','create_directory','move_path','trash_path','restore_trash','propose_command','command_input','save_files','expect_download','records_export','browser_upload','browser_download','image_batch_start','image_batch_save']);
export function usesWorkspace(name,args={}){return WORKSPACE_TOOLS.has(name)||name==='desktop_action'&&['reveal','open_path'].includes(args.action)||name==='system_inspect'&&args.section==='disk';}
export function workspaceRecord(record){return record.workspace_dependent===true||WORKSPACE_TOOLS.has(record.name)||record.name==='desktop_action'&&record.workspace_dependent!==false;}

export function bindWorkspaceRecovery(state,store,policy,probeOptions={}){
 const inspector=new WorkspaceInspector(probeOptions);
 store.workspaceEpoch=Number.isSafeInteger(state.data.workspace_epoch)?state.data.workspace_epoch:0;
 let tools=null,closed=false;
 const monitor=new WorkspaceMonitor({...probeOptions,onResult:result=>{if(closed||store.workspaceTransitioning)return;try{store.applyWorkspaceInspection(result,{watch:false});}catch{}}});
 const stopWatch=()=>monitor.stop();
 const startWatch=()=>{
  if(closed||store.workspaceTransitioning||!store.workspaceStatus().available)return;
  if(!monitor.start(store.workspacePath,store.stateDir))store.invalidateWorkspace({...store.workspace,available:false,status:'inaccessible',code:'WORKSPACE_PROBE_BUSY'});
 };
 const use=task=>{
  startWatch();if(!task)return;
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
 const mark=()=>{
  stopWatch();const project=state.project();if(project.workspace_recovery_required===true)return;
  project.workspace_recovery_required=true;advance();
 };
 store.onWorkspaceUnavailable=mark;
 store.onWorkspaceVerified=({watch=true}={})=>{if(state.project().workspace_create_pending){delete state.project().workspace_create_pending;state.save();}if(watch)startWatch();};
 store.onWorkspaceInitialize=()=>{
  if(!state.project().workspace_create_pending)return;
  const root=state.project().path;
  if(typeof root!=='string'||!path.isAbsolute(root)||root.includes('\0'))return;
  try{fs.mkdirSync(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST'&&!/^E[A-Z]+$/.test(error.code||''))throw error;}
 };
 return {
  attach(value){tools=value;tools.ensureWorkspace=async()=>{const project=await this.check();if(project.workspace.available!==true)throw workspaceFailure(project.workspace);};},close(){closed=true;stopWatch();monitor.close();inspector.close();},
  project:()=>({...state.project(),workspace:store.workspaceStatus()}),
  async check({force=false}={}){
   const project=state.project(),epoch=store.workspaceEpoch;
   if(!force&&store.workspace.status!=='unchecked')return this.project();
   const result=await inspector.inspect(project.path,store.stateDir,{create:project.workspace_create_pending===true});
   if(result.cancelled||closed||state.project()!==project||store.workspaceEpoch!==epoch)return this.project();
   store.applyWorkspaceInspection(result,{recheck:true,watch:false});if(store.workspace.available)startWatch();return this.project();
  },
  cancelCheck(){inspector.cancel();return {cancelled:true};},
  async resetAuthority({switchProject=false}={}){
   if(store.workspaceTransitioning)fail('WORKSPACE_TRANSITION','工作区正在恢复，请稍后重试。');
   store.workspaceTransitioning=true;stopWatch();inspector.cancel();advance({switchProject});
   const until=Date.now()+5000;
   while(policy.queue.list().some(j=>j.process_alive||j.cleanup_pending)&&Date.now()<until)await new Promise(r=>setTimeout(r,25));
   if(policy.queue.list().some(j=>j.process_alive||j.cleanup_pending))fail('STOP_INCOMPLETE','旧任务尚未停止，请稍后重试。');
  },
  finishTransition(){store.workspaceTransitioning=false;if(store.workspaceStatus().available)startWatch();},
  activate(project,{switchProject=false}={}){
   store.setRoot(project.path,{recoverWorkspace:true});store.writesEnabled=policy.enabled;
   delete project.workspace_recovery_required;delete project.workspace_create_pending;
   state.data.active=project.id;state.data.setup_workspace_confirmed=true;
   if(switchProject)state.data.permission_tier_intent='custom';state.save();
   return {project:this.project()};
  },
  recreate(){
   if(store.workspaceStatus().status==='read_only')throw workspaceReadOnly();
   const project=state.project(),root=project.path;
   if(typeof root!=='string'||!root||root.includes('\0')||!path.isAbsolute(root)||path.dirname(root)===root)fail('ROOT_INVALID','原工作区路径无效，请换一个文件夹。');
   const parent=fs.realpathSync(path.dirname(root));
   if(parent!==path.dirname(root))fail('LINK_BLOCKED','原位置已改变，请换一个文件夹。');
   store.checkProtected(root,{write:true});
   try{const st=fs.lstatSync(root);if(st.isSymbolicLink()||!st.isDirectory())fail('ROOT_INVALID','原位置不是普通文件夹，请换一个文件夹。');}
   catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(root,{mode:0o700});}
   return this.activate(project);
  }
 };
}
