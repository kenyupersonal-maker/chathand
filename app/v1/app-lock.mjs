import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../../engine/src/core.mjs';

function readRecord(file){
 try{
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>65536)return null;
  return JSON.parse(fs.readFileSync(file,'utf8'));
 }catch{return null;}
}
function alive(pid){
 if(!Number.isSafeInteger(pid)||pid<=1)return false;
 try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
async function recordedServiceRunning(dir){
 const runtime=readRecord(path.join(dir,'runtime.json'));
 if(runtime?.product!=='ken-bridge'||!alive(runtime.pid)||!/^[a-f0-9]{64}$/.test(runtime.admin_token||''))return false;
 let origin;
 try{origin=new URL(runtime.ui_origin);}catch{return false;}
 if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname))return false;
 // The existing private runtime record supplies both PID and local service
 // authentication. No process enumeration, signaling, or new lock is needed.
 try{
  const response=await fetch(new URL('/api/state',origin),{headers:{Authorization:'Bearer '+runtime.admin_token},signal:AbortSignal.timeout(1200)});
  if(response.ok){const state=await response.json();return state.version===runtime.version&&typeof state.instance_id==='string'&&alive(runtime.pid);}
 }catch(error){
  // A closed endpoint proves this runtime record is stale even if the OS has
  // reused its PID. Once connected, an uncertain timeout still retains it.
  if(error?.code==='ECONNREFUSED'||error?.cause?.code==='ECONNREFUSED')return false;
  return alive(runtime.pid);
 }
 return false;
}
export async function acquireAppLock(dir){
 const file=path.join(dir,'app.lock');let recovered=false;
 if(fs.existsSync(file)){
  const previous=readRecord(file),valid=Number.isSafeInteger(previous?.pid)&&previous.pid>1;
  if(valid?alive(previous.pid):await recordedServiceRunning(dir))fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');
  recovered=!valid;
  fs.unlinkSync(file);
 }
 fs.writeFileSync(file,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
 return {file,recovered};
}
