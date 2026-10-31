/** Optional read-only app-server probe. Never reads authentication files or retains account objects. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
export const PROBE_INTERVAL_MS = 6*60*60_000;
export const PROBE_METHODS = Object.freeze(['account/read']);
export function findCodex({applications=['/Applications/ChatGPT.app',path.join(os.homedir(),'Applications/ChatGPT.app')],searchPath=process.env.PATH||''}={}){
 const candidates=applications.flatMap(app=>['Contents/Resources/codex-cli/bin/codex','Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','Contents/Resources/codex','Contents/MacOS/codex'].map(relative=>path.join(app,relative))).concat(searchPath.split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,'codex')));
 for(const candidate of candidates)try{fs.accessSync(candidate,fs.constants.X_OK);if(fs.statSync(candidate).isFile())return candidate;}catch{}
 return null;
}
export function planId(value){if(typeof value!=='string')return null;const key=value.toLowerCase().trim().replace(/[\s-]+/g,'_');return key==='plus'?'plus':['pro_5x','pro5x','prolite'].includes(key)?'pro_5x':['pro_20x','pro20x','pro'].includes(key)?'pro_20x':null;}
export class PlanProbe {
 constructor({findExecutable=findCodex,spawnProcess=spawn,now=Date.now,timeoutMs=10_000,lastAttempt=0,initialProbe=null}={}){Object.assign(this,{findExecutable,spawnProcess,now,timeoutMs,lastAttempt});this.inflight=null;this.child=null;this.last=initialProbe?{...this.empty('cached'),plan:planId(initialProbe.plan),calibrated_at:Number.isFinite(initialProbe.calibrated_at)?initialProbe.calibrated_at:null}:null;this.closed=false;}
 read(){if(this.closed)return Promise.resolve(this.empty('closed'));if(this.inflight)return this.inflight;if(this.lastAttempt&&this.now()-this.lastAttempt<PROBE_INTERVAL_MS)return Promise.resolve(this.last||this.empty('cached'));this.lastAttempt=this.now();this.inflight=this.run().catch(()=>this.empty('unavailable')).then(result=>{this.last=result;return result;}).finally(()=>{this.inflight=null;});return this.inflight;}
 empty(status){return {plan:null,week_tokens:null,calibrated_at:this.now(),executable_found:false,plan_type:null,handshake:status,methods:Object.fromEntries(PROBE_METHODS.map(method=>[method,status]))};}
 async run(){
  const executable=await this.findExecutable();if(!executable)return this.empty('not_found');
  const output=this.empty('unavailable');output.executable_found=true;
  let child,buffer='',serial=0,timer,ended=false;const pending=new Map();
  const rejectAll=reason=>{ended=true;for(const item of pending.values())item.reject(reason);pending.clear();};
  try{
   child=this.spawnProcess(executable,['app-server'],{stdio:['pipe','pipe','pipe']});this.child=child;
   child.once('error',()=>rejectAll('spawn_failed'));child.once('close',()=>rejectAll('closed'));
   child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();if(Buffer.byteLength(buffer)>2*1024*1024){buffer='';rejectAll('malformed');child.kill();return;}
    let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let message;try{message=JSON.parse(line);}catch{rejectAll('malformed');return;}const request=pending.get(message.id);if(!request)continue;pending.delete(message.id);if(message.error)request.reject(message.error.code===-32601?'unsupported':message.error.message==='Not initialized'?'not_initialized':'rpc_error');else request.resolve(message.result);}
   });
   // Discard stderr without forwarding it: it may describe account/configuration state.
   child.stderr.on('data',()=>{});child.stdin.on('error',()=>rejectAll('closed'));
   timer=setTimeout(()=>{rejectAll('timeout');child.kill();},this.timeoutMs);timer.unref?.();
   const request=(method,params={})=>new Promise((resolve,reject)=>{if(ended)return reject('closed');const id=++serial;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
   // Protocol connection only: no login, refresh, setting change, model or session request.
   try{await request('initialize',{clientInfo:{name:'chathand-plan-probe',version:'1.0.0'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');output.handshake='ok';}catch(reason){output.handshake=typeof reason==='string'?reason:'unavailable';output.methods=Object.fromEntries(PROBE_METHODS.map(method=>[method,'not_attempted']));return output;}
   try{const result=await request('account/read',{refreshToken:false});output.methods['account/read']='ok';const raw=result?.account?.planType??result?.planType;output.plan_type=typeof raw==='string'&&/^[A-Za-z0-9 _-]{1,48}$/.test(raw)?raw:null;output.plan=planId(output.plan_type);}catch(reason){output.methods['account/read']=typeof reason==='string'?reason:'unavailable';}
   return output;
  }finally{clearTimeout(timer);if(child){child.stdin.end();child.kill();const force=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},250);force.unref?.();}if(this.child===child)this.child=null;}
 }
 close(){this.closed=true;this.child?.kill();}
}
