/**
 * Template-side checkpoint CLI. Invoked by STEPS.md in the SAME Site project.
 * It never invokes Sites, uploads, publishes, reads credentials, or stores tool
 * responses. All platform operations remain with the authenticated host tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const FORMAT='chathand-site-deploy-checkpoint';
const FIELDS=['format','version','project_id','source_commit','archive_sha256','version_id','deployment_id','deployment_status'];
const STATUS=new Set(['pending','building','publishing','succeeded','failed']);
const error=code=>Object.assign(Error(code),{code});
const fail=code=>{throw error(code);};
const opaque=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\s\x00-\x1f\x7f]/.test(v);
const sha=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const commit=v=>typeof v==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
function regularJSON(file,{optional=false,max=65536}={}){
 let st;try{st=fs.lstatSync(file);}catch(e){if(optional&&e.code==='ENOENT')return null;fail('CHECKPOINT_FILE_UNAVAILABLE');}
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>max)fail('CHECKPOINT_FILE_UNSAFE');
 let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('CHECKPOINT_JSON_INVALID');}
 if(!value||typeof value!=='object'||Array.isArray(value))fail('CHECKPOINT_JSON_INVALID');
 return value;
}
function atomicJSON(file,value){
 const tmp=path.join(path.dirname(file),'.deploy-write-'+crypto.randomUUID());
 let fd;try{
  fd=fs.openSync(tmp,'wx',0o600);
  fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(tmp,file);
  const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function validate(cp){
 if(Object.keys(cp).sort().join(',')!==[...FIELDS].sort().join(',')||cp.format!==FORMAT||cp.version!==1||
  !((cp.source_commit===null&&cp.archive_sha256===null)||(commit(cp.source_commit)&&sha(cp.archive_sha256)))||
  !['project_id','version_id','deployment_id'].every(k=>cp[k]===null||opaque(cp[k]))||
  !(cp.deployment_status===null||STATUS.has(cp.deployment_status))||
  cp.version_id!==null&&(cp.project_id===null||cp.source_commit===null)||cp.deployment_id!==null&&cp.version_id===null||
  cp.deployment_status!==null&&cp.deployment_id===null)fail('CHECKPOINT_SCHEMA_INVALID');
 return cp;
}
const keysByCommand={
 open:[],init:['commit','archive-sha256'],plan:[],inspect:[],
 'record-project':['project-id'],'record-version':['version-id'],
 'record-deployment':['version-id','deployment-id'],
 'record-status':['deployment-id','status']
};
function argumentsOf(args){
 const command=args[0],allowed=keysByCommand[command];if(!allowed)fail('CHECKPOINT_COMMAND_INVALID');
 const values={};
 for(let i=1;i<args.length;i+=2){
  const key=args[i]?.slice(2);
  if(!args[i]?.startsWith('--')||!allowed.includes(key)||Object.hasOwn(values,key)||typeof args[i+1]!=='string')fail('CHECKPOINT_ARGUMENT_INVALID');
  values[key]=args[i+1];
 }
 if(Object.keys(values).length!==allowed.length)fail('CHECKPOINT_ARGUMENT_INVALID');
 return {command,values};
}
function action(cp){
 if(cp.project_id===null)return 'resolve_project';
 if(cp.source_commit===null)return 'prepare_source';
 if(cp.version_id===null)return 'reconcile_versions';
 if(cp.deployment_id===null||cp.deployment_status==='failed')return 'deploy_saved_version';
 if(cp.deployment_status==='succeeded')return 'complete';
 return 'get_deployment_status';
}
export function runCheckpoint(args,{cwd=process.cwd()}={}){
 const {command,values}=argumentsOf(args);
 const base=path.join(fs.realpathSync(cwd),'.openai');
 try{fs.mkdirSync(base,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const st=fs.lstatSync(base);if(!st.isDirectory()||st.isSymbolicLink())fail('CHECKPOINT_DIRECTORY_UNSAFE');
 const file=path.join(base,'chathand-deploy-checkpoint.json'),hostingFile=path.join(base,'hosting.json');
 const hosting=regularJSON(hostingFile,{optional:true})||{};
 if(hosting.project_id!==undefined&&!opaque(hosting.project_id))fail('CHECKPOINT_HOSTING_PROJECT_INVALID');
 let cp=regularJSON(file,{optional:true,max:8192});
 if(cp)validate(cp);
 if(command==='open'&&!cp)cp={format:FORMAT,version:1,project_id:null,source_commit:null,archive_sha256:null,version_id:null,deployment_id:null,deployment_status:null};
 if(command==='init'){
  if(!commit(values.commit)||!sha(values['archive-sha256']))fail('CHECKPOINT_SOURCE_INVALID');
  if(cp&&cp.source_commit!==null&&(cp.source_commit!==values.commit||cp.archive_sha256!==values['archive-sha256']))fail('CHECKPOINT_SOURCE_CONFLICT');
  cp||={format:FORMAT,version:1,project_id:null,source_commit:null,archive_sha256:null,version_id:null,deployment_id:null,deployment_status:null};
  cp.source_commit=values.commit;cp.archive_sha256=values['archive-sha256'];
 }
 if(!cp)fail('CHECKPOINT_INIT_REQUIRED');
 if(hosting.project_id!==undefined){
  if(cp.project_id!==null&&cp.project_id!==hosting.project_id)fail('CHECKPOINT_PROJECT_CONFLICT');
  cp.project_id=hosting.project_id;
 }else if(cp.project_id!==null){
  // A prior atomic checkpoint still proves the project ID after accidental
  // hosting replacement. Restore by merge; never create another Site.
  hosting.project_id=cp.project_id;
  atomicJSON(hostingFile,hosting);
 }
 if(command==='record-project'){
  const id=values['project-id'];if(!opaque(id))fail('CHECKPOINT_ID_INVALID');
  if(cp.project_id!==null&&cp.project_id!==id)fail('CHECKPOINT_PROJECT_CONFLICT');
  // Write hosting FIRST. If interrupted between the two atomic writes, the
  // next invocation recovers from hosting.project_id without creating again.
  hosting.project_id=id;atomicJSON(hostingFile,hosting);cp.project_id=id;
 }else if(command==='record-version'){
  const id=values['version-id'];if(!opaque(id))fail('CHECKPOINT_ID_INVALID');
  if(cp.project_id===null||cp.source_commit===null)fail('CHECKPOINT_SOURCE_REQUIRED');
  if(cp.version_id!==null&&cp.version_id!==id)fail('CHECKPOINT_VERSION_CONFLICT');
  cp.version_id=id;
 }else if(command==='record-deployment'){
  const id=values['deployment-id'],versionId=values['version-id'];
  if(!opaque(id)||!opaque(versionId))fail('CHECKPOINT_ID_INVALID');
  if(cp.version_id!==versionId)fail('CHECKPOINT_VERSION_CONFLICT');
  if(cp.deployment_id!==null&&cp.deployment_id!==id&&!['failed','succeeded'].includes(cp.deployment_status))fail('CHECKPOINT_DEPLOYMENT_CONFLICT');
  if(cp.deployment_id!==id){cp.deployment_id=id;cp.deployment_status=null;}
 }else if(command==='record-status'){
  if(cp.deployment_id!==values['deployment-id'])fail('CHECKPOINT_DEPLOYMENT_CONFLICT');
  if(!STATUS.has(values.status))fail('CHECKPOINT_STATUS_INVALID');
  // Late observations cannot downgrade a known terminal deployment.
  if(['succeeded','failed'].includes(cp.deployment_status)&&cp.deployment_status!==values.status)fail('CHECKPOINT_STATUS_CONFLICT');
  cp.deployment_status=values.status;
 }
 validate(cp);
 // Persist only these exact allowlisted fields, never a tool response or env.
 // Commands are serial in STEPS.md. Do not run competing checkpoint writers.
 if(command!=='inspect')atomicJSON(file,cp);
 return {action:action(cp),...cp};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(runCheckpoint(process.argv.slice(2))));}
 catch(e){console.error(JSON.stringify({error_code:/^CHECKPOINT_[A-Z_]+$/.test(e.code||'')?e.code:'CHECKPOINT_IO_FAILED'}));process.exitCode=1;}
}
