import fs from 'node:fs';
import path from 'node:path';
import {fail} from '../../engine/src/core.mjs';
import {archiveRecord,processFacts} from './process-facts.mjs';

function readRecord(file){
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const st=fs.fstatSync(fd,{bigint:true});
  if(!st.isFile()||st.size>65536n)return null;
  return {value:JSON.parse(fs.readFileSync(fd,'utf8')),stat:st};
 }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function alive(pid){
 if(!Number.isSafeInteger(pid)||pid<=1)return false;
 try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
function present(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function stale(record){
 if(!record)return false;
 const pid=record?.value?.pid;
 const valid=Number.isSafeInteger(pid)&&pid>1&&pid<=2147483647;
 let facts;try{facts=processFacts(valid?pid:process.pid);}catch{return false;}
 if(Number.isSafeInteger(facts.boot_seconds)&&Number.isSafeInteger(facts.boot_microseconds)){
  const boot=BigInt(facts.boot_seconds)*1000000000n+BigInt(facts.boot_microseconds)*1000n;
  if(record.stat.mtimeNs<boot)return true;
 }
 if(Number.isSafeInteger(pid)&&pid>2147483647)return true;
 if(!valid)return false;
 if(facts.absent)return true;
 const v=record.value;
 if(!facts.unknown&&Number.isSafeInteger(v.start_seconds)&&v.start_seconds>0&&Number.isSafeInteger(v.start_microseconds)&&v.start_microseconds>=0&&v.start_microseconds<1000000&&
    (v.start_seconds!==facts.start_seconds||v.start_microseconds!==facts.start_microseconds))return true;
 return false;
}
async function recordedServiceRunning(dir){
 const runtime=readRecord(path.join(dir,'runtime.json'))?.value;
 if(runtime?.product!=='ken-bridge'||!alive(runtime.pid)||!/^[a-f0-9]{64}$/.test(runtime.admin_token||''))return false;
 let origin;
 try{origin=new URL(runtime.ui_origin);}catch{return false;}
 if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname))return false;
 try{
  const response=await fetch(new URL('/api/state',origin),{headers:{Authorization:'Bearer '+runtime.admin_token},signal:AbortSignal.timeout(1200)});
  if(response.ok){const state=await response.json();return state.version===runtime.version&&typeof state.instance_id==='string'&&alive(runtime.pid);}
 }catch(error){
  if(error?.code==='ECONNREFUSED'||error?.cause?.code==='ECONNREFUSED')return false;
  return alive(runtime.pid);
 }
 return false;
}
export async function acquireAppLock(dir){
 const file=path.join(dir,'app.lock'),runtimeFile=path.join(dir,'runtime.json');
 const self=processFacts(process.pid);if(self.absent||self.unknown)throw Error('PROCESS_FACTS_UNAVAILABLE');
 const own={pid:process.pid,start_seconds:self.start_seconds,start_microseconds:self.start_microseconds};
 let recovered=false;
 const lock=readRecord(file),runtime=readRecord(runtimeFile),lockExists=present(file),runtimeExists=present(runtimeFile),lockStale=stale(lock),runtimeStale=stale(runtime);
 if((lockStale||runtimeStale)&&((lockExists&&!lock)||(runtimeExists&&!runtime)))fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');
 if((lockStale||runtimeStale)&&runtime&&!runtimeStale)fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');
 if((lockStale||runtimeStale)&&(!lock||lockStale||!Number.isSafeInteger(lock.value?.pid)||lock.value.pid<=1)&&(!runtime||runtimeStale)){
  let archived=false;
  // Back up runtime before the lock. Exclusive destination names keep a
  // second starter from moving records created by the first one.
  for(const [name,record] of [[runtimeFile,runtime],[file,lock]])if(record){
   if(!archiveRecord(name,record.stat))fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');archived=true;
  }
  if(archived)console.error(JSON.stringify({code:'STALE_RUNTIME_RECORD'}));
 }else if(fs.existsSync(file)){
  const previous=lock?.value,valid=Number.isSafeInteger(previous?.pid)&&previous.pid>1;
  if(valid?alive(previous.pid):await recordedServiceRunning(dir))fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');
  recovered=!valid;
  fs.unlinkSync(file);
 }
 try{fs.writeFileSync(file,JSON.stringify(own),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')fail('ALREADY_RUNNING','ChatHand 已运行，请打开已有应用。');throw e;}
 return {file,recovered,identity:own};
}
