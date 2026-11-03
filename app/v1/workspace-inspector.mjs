import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function spawnWorkspaceProbe(){
 return spawn(process.execPath,[fileURLToPath(new URL('./workspace-probe-child.mjs',import.meta.url))],{env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['ignore','ignore','ignore','ipc'],detached:true});
}
const unavailable=(root,code)=>({path:root,available:false,writable:false,status:'inaccessible',code});
function terminateOwned(record){const child=record.child;if(!child||!Number.isSafeInteger(child.pid)||child.pid<=1||child.exitCode!==null||child.signalCode!==null||child.killed)return;try{child.kill('SIGKILL');}catch{}}

// At most two owned probe processes can exist. Timeouts/cancellation never
// await an OS-blocked child; its PID is known and no external process is touched.
export class WorkspaceInspector{
 constructor({factory=spawnWorkspaceProbe,timeoutMs=2500}={}){this.factory=factory;this.timeoutMs=timeoutMs;this.active=null;this.children=new Set();this.retiring=new Map();this.closed=false;}
 inspect(root,stateDir,{create=false}={}){
  const key=JSON.stringify([root,stateDir,create]);
  if(this.active?.key===key)return this.active.promise;
  this.cancel();if(this.closed)return Promise.resolve({cancelled:true});
  if(this.retiring.has(key))return Promise.resolve(this.retiring.get(key).result||unavailable(root,'WORKSPACE_TIMEOUT'));
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
   record.timer=setTimeout(()=>finish(unavailable(root,'WORKSPACE_TIMEOUT'),{terminate:true}),this.timeoutMs);record.timer.unref?.();
   child.send({root,stateDir,create},error=>{if(error)finish(unavailable(root,'WORKSPACE_PROBE_FAILED'),{terminate:true});});
  }catch{finish(unavailable(root,'WORKSPACE_PROBE_FAILED'),{terminate:true});}
  return record.promise;
 }
 cancel(){this.active?.finish({cancelled:true},{terminate:true});}
 close(){this.closed=true;this.cancel();for(const record of this.children)if(!record.returned)terminateOwned(record);}
}

export class WorkspaceMonitor{
 constructor({factory=spawnWorkspaceProbe,timeoutMs=2500,onResult}={}){Object.assign(this,{factory,timeoutMs,onResult});this.record=null;this.children=new Set();}
 start(root,stateDir){
  if(this.record?.root===root)return true;this.stop();if(this.children.size>=2)return false;
  const record={root,child:null};this.record=record;
  const timeout=()=>{clearTimeout(record.timer);record.timer=setTimeout(()=>{if(this.record!==record)return;this.onResult(unavailable(root,'WORKSPACE_TIMEOUT'));this.stop();},this.timeoutMs);record.timer.unref?.();};
  try{const child=this.factory({root,stateDir,monitor:true});record.child=child;this.children.add(record);child.unref?.();child.channel?.unref?.();
   child.on('message',message=>{if(this.record!==record)return;if(message?.type==='checking')timeout();else if(message?.type==='result'&&typeof message.result?.available==='boolean'){clearTimeout(record.timer);this.onResult({...message.result,path:root});}});
   child.once('error',()=>{if(this.record===record){this.onResult(unavailable(root,'WORKSPACE_PROBE_FAILED'));this.stop();}});
   child.once('exit',()=>{this.children.delete(record);if(this.record===record){this.onResult(unavailable(root,'WORKSPACE_PROBE_FAILED'));this.stop();}});
   timeout();child.send({root,stateDir,monitor:true});return true;
  }catch{this.stop();return false;}
 }
 stop(){const record=this.record;this.record=null;if(!record)return;clearTimeout(record.timer);terminateOwned(record);try{record.child?.disconnect?.();}catch{}}
 close(){this.stop();for(const record of this.children)terminateOwned(record);}
}
