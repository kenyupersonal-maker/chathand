import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const WORKSPACE_PROBE_TIMEOUT_MS=4000;
export const WORKSPACE_RETRY_BUDGET_MS=6000;
export const WORKSPACE_PROBE_ATTEMPTS=3;
export const WORKSPACE_RETRY_DELAY_MS=75;
export const temporaryWorkspaceFailure=result=>['WORKSPACE_TIMEOUT','WORKSPACE_PROBE_FAILED','WORKSPACE_PROBE_BUSY'].includes(result?.code);

export function spawnWorkspaceProbe(){
 return spawn(process.execPath,[fileURLToPath(new URL('./workspace-probe-child.mjs',import.meta.url))],{env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['ignore','ignore','ignore','ipc'],detached:true});
}
const unavailable=(root,code)=>({path:root,available:false,writable:false,status:'inaccessible',code});
function terminateOwned(record){const child=record.child;if(!child||!Number.isSafeInteger(child.pid)||child.pid<=1||child.exitCode!==null||child.signalCode!==null||child.killed)return;try{child.kill('SIGKILL');}catch{}}

// At most two owned probe processes can exist. Timeouts/cancellation never
// await an OS-blocked child; its PID is known and no external process is touched.
export class WorkspaceInspector{
 constructor({factory=spawnWorkspaceProbe,timeoutMs=WORKSPACE_PROBE_TIMEOUT_MS}={}){this.factory=factory;this.timeoutMs=timeoutMs;this.active=null;this.children=new Set();this.retiring=new Map();this.closed=false;}
 inspect(root,stateDir,{create=false,timeoutMs=this.timeoutMs}={}){
  const key=JSON.stringify([root,stateDir,create]);
  if(this.active?.key===key)return this.active.promise;
  this.cancel();if(this.closed)return Promise.resolve({cancelled:true});
  // A finished probe may still be exiting. Its result is never evidence for a
  // later operation; only callers of the same in-flight probe share a result.
  if(this.children.size>=2)return Promise.resolve(unavailable(root,'WORKSPACE_PROBE_BUSY'));
  const record={key,root,done:false,child:null,result:null};
  record.promise=new Promise(resolve=>{record.resolve=resolve;});this.active=record;
  const finish=(result,{terminate=false}={})=>{
   if(record.done)return;record.done=true;record.result=result;clearTimeout(record.timer);if(this.active===record)this.active=null;
   if(record.child){if(record.child.exitCode===null&&record.child.signalCode===null)this.retiring.set(key,record);if(terminate){terminateOwned(record);try{record.child.disconnect?.();}catch{}}}
   record.resolve(result);
  };
  record.finish=finish;
  try{
   const child=this.factory({root,stateDir,create});record.child=child;this.children.add(record);child.unref?.();child.channel?.unref?.();
   child.once('exit',()=>{this.children.delete(record);if(this.retiring.get(key)===record)this.retiring.delete(key);if(!record.done)finish(unavailable(root,'WORKSPACE_PROBE_FAILED'));});
   child.once('error',()=>{finish(unavailable(root,'WORKSPACE_PROBE_FAILED'),{terminate:true});if(!Number.isSafeInteger(child.pid))this.children.delete(record);});
   child.once('message',result=>{const valid=result&&typeof result.available==='boolean';record.returned=valid;finish(valid?{...result,path:root}:unavailable(root,'WORKSPACE_PROBE_FAILED'),{terminate:!valid});});
   record.timer=setTimeout(()=>finish(unavailable(root,'WORKSPACE_TIMEOUT'),{terminate:true}),Math.max(1,Math.min(this.timeoutMs,timeoutMs)));record.timer.unref?.();
   child.send({root,stateDir,create},error=>{if(error)finish(unavailable(root,'WORKSPACE_PROBE_FAILED'),{terminate:true});});
  }catch{finish(unavailable(root,'WORKSPACE_PROBE_FAILED'),{terminate:true});}
  return record.promise;
 }
 cancel(){this.active?.finish({cancelled:true},{terminate:true});}
 close(){this.closed=true;this.cancel();for(const record of this.children)if(!record.returned)terminateOwned(record);}
}

export async function inspectWorkspaceWithRetry(inspector,root,stateDir,{create=false,cancelled=()=>false,onAttempt=()=>{}}={}){
 const budget=Math.min(WORKSPACE_RETRY_BUDGET_MS,inspector.timeoutMs*WORKSPACE_PROBE_ATTEMPTS+WORKSPACE_RETRY_DELAY_MS*(WORKSPACE_PROBE_ATTEMPTS-1));
 const deadline=Date.now()+budget;let result=unavailable(root,'WORKSPACE_TIMEOUT');
 for(let attempt=0;attempt<WORKSPACE_PROBE_ATTEMPTS;attempt++){
  if(cancelled())return {cancelled:true};
  const remaining=deadline-Date.now();if(remaining<=0)break;
  result=await inspector.inspect(root,stateDir,{create,timeoutMs:remaining});
  if(cancelled()||result.cancelled)return {cancelled:true};
  onAttempt(result,attempt+1);
  if(!temporaryWorkspaceFailure(result))return result;
  if(attempt+1===WORKSPACE_PROBE_ATTEMPTS||deadline-Date.now()<=WORKSPACE_RETRY_DELAY_MS)break;
  await new Promise(resolve=>setTimeout(resolve,WORKSPACE_RETRY_DELAY_MS));
 }
 return result;
}
