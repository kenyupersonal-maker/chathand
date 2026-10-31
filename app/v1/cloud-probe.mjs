import {execFile} from 'node:child_process';
import {currentSystemProxy,CONTROL_PLANE_ORIGIN} from '../../engine/src/tunnel.mjs';
const execute=(program,args,options)=>new Promise((resolve,reject)=>execFile(program,args,options,(error,stdout)=>error?reject(error):resolve(stdout)));
/** A public HEAD only. Never inherits shell proxy/auth configuration or user curlrc. */
export async function probeCloud({systemProxy=currentSystemProxy,run=execute,now=Date.now}={}){
 const start=now(),proxy=systemProxy()||'';
 const args=['--disable','--head','--silent','--output','/dev/null','--write-out','%{http_code}','--connect-timeout','2','--max-time','5','--proto','=https','--proxy',proxy,'--noproxy','','--no-netrc',CONTROL_PLANE_ORIGIN+'/'];
 const result=(reachable,code)=>({reachable,code,elapsed_ms:Math.max(0,Math.round(now()-start)),target:new URL(CONTROL_PLANE_ORIGIN).hostname,via_system_proxy:!!proxy});
 try{const status=Number(String(await run('/usr/bin/curl',args,{env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:6000,maxBuffer:1024,encoding:'utf8'})).trim());return status>=100&&status<=599?result(true,'HTTP_RESPONSE'):result(false,'NO_RESPONSE');}
 catch(e){return result(false,({7:'CONNECT_FAILED',28:'TIMEOUT',60:'TLS_FAILED'})[e.code]||'PROBE_FAILED');}
}
/** Bind every asynchronous answer to the current transport and selected route. */
export class CloudProbe {
 constructor({run=probeCloud,current,onChange=()=>{}}){Object.assign(this,{run,current,onChange});this.context=null;this.down=false;this.value=null;this.sequence=0;}
 observe(context){
  const same=(a,b)=>a&&b&&a.generation===b.generation&&a.child===b.child&&a.route===b.route;
  if(!same(context,this.context)){this.context=context;this.down=false;this.value=null;this.sequence++;}
  if(context.route!=='openai'||context.cp?.state!=='down'){this.down=false;this.value=null;this.sequence++;return;}
  if(this.down)return;this.down=true;this.value=null;
  const pending=this.context,sequence=++this.sequence;
  Promise.resolve().then(()=>this.run()).then(value=>{if(sequence===this.sequence&&this.context===pending&&same(pending,this.current())&&this.down){this.value=value;this.onChange();}},()=>{});
 }
 snapshot(){const a=this.context,b=this.current();return a&&b&&a.generation===b.generation&&a.child===b.child&&a.route===b.route?this.value:null;}
}
