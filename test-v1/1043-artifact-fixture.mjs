/** Temp-only manager adapter; native FD guarantees are tested separately. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {ArtifactImportManager} from '../app/v1/artifact-import.mjs';import {artifactHash} from '../app/v1/artifact-zip.mjs';import {Changes} from '../app/v06/changes.mjs';
export const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ0kAAAAASUVORK5CYII=','base64');
export const identity=p=>{const s=fs.statSync(p);return {dev:String(s.dev),ino:String(s.ino)};};
const error=code=>{throw Object.assign(Error('fixture denied'),{code});};
export function fakeNative(){const operations=new Map(),calls=[];let hook=null;
 const invoke=async(r,{signal}={})=>{calls.push(structuredClone({...r,entries:r.entries?.map(e=>({...e,data_base64:'[fixture data]'}))}));if(hook)await hook(r,signal);if(signal?.aborted)error('ARTIFACT_REVOKED');const target=r.path?path.join(r.root,r.path):null;
  if(r.action==='verify'){const x=fs.lstatSync(target);if(x.isSymbolicLink()||x.nlink>1)error('ARTIFACT_PATH_CHANGED');return {verified:true,is_directory:x.isDirectory(),relative_path:r.path,identity:identity(target),...(x.isFile()?{sha256:artifactHash(fs.readFileSync(target))}:{})};}
  if(r.action==='thumbnail')return fs.readFileSync(target).equals(PNG)?{available:true,width:1,height:1,mime_type:'image/png',image_base64:PNG.toString('base64')}:{available:false};
  if(r.action==='read'){const data=fs.readFileSync(target);return {status:'read',bytes:data.length,sha256:artifactHash(data),data_base64:data.toString('base64')};}
  if(r.action==='archive-download'){const op=operations.get(r.operation_id);if(op?.status!=='applied'||op.source!==r.sha256)error('ARTIFACT_INTENT_CONFLICT');const out='_待清理-'+r.archive_day+'.noindex/'+r.operation_id+'/'+r.path;fs.mkdirSync(path.dirname(path.join(r.root,out)),{recursive:true});fs.renameSync(target,path.join(r.root,out));return {status:'archived',archive_path:out};}
  if(r.action==='inspect-source'){const out='_待清理-'+r.archive_day+'.noindex/'+r.operation_id+'/'+r.path;return fs.existsSync(path.join(r.root,out))?{status:'archived',archive_path:out}:{status:'archive_unconfirmed'};}
  if(r.action==='cancel'){operations.delete(r.operation_id);return {status:'cancelled'};}
  if(r.action==='stage'){const op=operations.get(r.operation_id)||{entries:[],chunks:[],status:'staged',source:r.source_sha256};for(const e of r.entries){const data=Buffer.from(e.data_base64,'base64');op.entries.push({path:e.path,bytes:data.length,sha256:artifactHash(data),data,...(data.equals(PNG)?{image:{available:true,width:1,height:1,mime_type:'image/png'}}:{})});}op.manifest=artifactHash(Buffer.from(JSON.stringify(op.entries.map(({data,...e})=>e))));operations.set(r.operation_id,op);return {status:'staged',manifest_sha256:op.manifest,entries:op.entries.map(({data,...e})=>e)};}
  const op=operations.get(r.operation_id);if(!op)return {status:'absent'};
  if(r.action==='commit'){for(const e of op.entries){const p=path.join(r.root,r.destination,e.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,e.data,{flag:'wx'});}op.status='applied';return {status:'applied',manifest_sha256:op.manifest};}
  if(r.action==='inspect')return {status:op.status,manifest_sha256:op.manifest,entries:op.entries.map(({data,...e})=>e)};error('ARTIFACT_REQUEST_INVALID');
 };return {invoke,calls,operations,setHook:fn=>{hook=fn;}};
}
export function fixture(t,{download=async()=>Buffer.from('result')}={}){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1043-'))),root=path.join(temp,'work'),stateDir=path.join(temp,'state'),downloads=path.join(temp,'Downloads');for(const d of [root,stateDir,downloads])fs.mkdirSync(d);
 const task={id:crypto.randomUUID(),title:'测试成果',session_hash:'a'.repeat(64),caller:'chatgpt',project_id:'project',root,epoch:0,status:'active'},tasks=new Map([[task.id,task]]);
 const store={root,stateDir,paused:false,writesEnabled:true,accessMode:'folder',checkActive(write){if(this.paused||write&&!this.writesEnabled)error('LOCAL_DISABLED');},checkProtected(){},resolve:p=>fs.realpathSync(path.resolve(root,p))};
 const policy={tasks,epoch:0,permissionRevision:0,state:{data:{active:'project'},project:()=>({path:root})},get(id,caller){const x=tasks.get(id);if(!x)error('TASK_MISSING');if(caller&&x.caller!==caller)error('TASK_OWNER');return x;},check(){store.checkActive();},require(id,caller){this.check();const x=this.get(id,caller);if(x.status!=='active')error('TASK_REVOKED');if(x.root!==store.root||x.epoch!==this.epoch)error('ROOT_CHANGED');return x;},emit(){}};
 const native=fakeNative(),changes=new Changes(store,policy),manager=new ArtifactImportManager({store,policy,changes,runtimeRoot:temp,download,native:native.invoke,downloadsDir:downloads});policy.artifacts=manager;
 t.after(()=>{manager.close();fs.rmSync(temp,{recursive:true,force:true});});const args={task_id:task.id,request_id:'receive-one'};return {temp,root,stateDir,downloads,task,store,policy,native,changes,manager,args,save:extra=>manager.save({...args,...extra},task.caller,task.session_hash),status:()=>manager.status(args,task.caller,task.session_hash)};
}
