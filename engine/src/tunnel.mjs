import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { fail } from './core.mjs';
import { findExecutable,safeEnvironment,redact } from './commands.mjs';

export function macSystemHttpsProxy(output) {
  const fields=new Map([...String(output).matchAll(/^\s*([A-Za-z]+)\s*:\s*([^\r\n]+)\s*$/gm)].map(([,key,value])=>[key,value.trim()]));
  if(fields.get('HTTPSEnable')!=='1')return null;
  const host=fields.get('HTTPSProxy')||'',port=Number(fields.get('HTTPSPort'));
  if(!host||(!net.isIP(host)&&!/^([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$/.test(host))||!Number.isInteger(port)||port<1||port>65535)return null;
  return `http://${net.isIP(host)===6?`[${host}]`:host}:${port}`;
}

/** The proxy macOS is using right now (System Settings / Clash-style apps). null when none. */
export function currentSystemProxy({platform=process.platform,systemProxy=()=>execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000,maxBuffer:65536})}={}) {
  if(platform!=='darwin')return null;
  try{return macSystemHttpsProxy(systemProxy());}catch{return null;}
}
const redactProxy=url=>String(url).replace(/\/\/[^@/]*@/,'//');
// Cloud status comes from tunnel-client's own health details. "down" only after this long without an ok control plane.
export const CONTROL_PLANE_DOWN_AFTER_MS=120000;

export function tunnelEnvironment({platform=process.platform,parent=process.env,systemProxy=()=>execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000,maxBuffer:65536})}={}) {
  const env={...safeEnvironment()};
  for(const name of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy'])if(parent[name])env[name]=parent[name];
  let httpsProxy=parent.HTTPS_PROXY||parent.https_proxy;
  if(!httpsProxy&&!parent.ALL_PROXY&&!parent.all_proxy&&platform==='darwin'){
    try{httpsProxy=macSystemHttpsProxy(systemProxy());}catch{}
    if(httpsProxy)env.HTTPS_PROXY=httpsProxy;
  }
  env.NO_PROXY=[parent.NO_PROXY||parent.no_proxy||'','127.0.0.1','localhost'].filter(Boolean).join(',');env.no_proxy=env.NO_PROXY;
  if(httpsProxy)env.CONTROL_PLANE_HTTP_PROXY=httpsProxy;
  return env;
}

export const CONTROL_PLANE_ORIGIN='https://api.openai.com';
export function profileText({tunnelId,mcpUrl,healthFile}) {
  if(!/^tunnel_[a-f0-9]{32}$/.test(tunnelId))fail('TUNNEL_ID_INVALID','通道 ID 应为 tunnel_ 加 32 位小写十六进制字符。');
  if(!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcpUrl))fail('MCP_URL_INVALID','本机工具地址不正确。');
  return `config_version: 1\ncontrol_plane:\n  base_url: ${CONTROL_PLANE_ORIGIN}\n  tunnel_id: ${tunnelId}\n  api_key: env:CONTROL_PLANE_API_KEY\nmcp:\n  server_urls:\n    - channel: main\n      url: ${mcpUrl}\n  extra_headers:\n    X-Ken-Bridge-Token: env:KEN_BRIDGE_MCP_TOKEN\n  discovery_extra_headers:\n    X-Ken-Bridge-Token: env:KEN_BRIDGE_MCP_TOKEN\nhealth:\n  listen_addr: 127.0.0.1:0\n  url_file: ${JSON.stringify(healthFile)}\nlog:\n  level: info\n  format: json\nadmin_ui:\n  open_browser: false\n`;
}
const CLOUD_STATES=new Set(['up','checking','down','unknown','ok','degraded','disabled','connecting','connected','reconnecting','error','failed','unhealthy','starting']);
const CLOUD_CODES=new Set(['HTTP_401','HTTP_403','HTTP_429','HTTP_500','HTTP_502','HTTP_503','HTTP_504','UPSTREAM_TIMEOUT','TIMEOUT','CONNECT_FAILED','TLS_FAILED','WS_CLOSED','AUTH_REQUIRED']);
export function controlPlaneCategory(cp){return {status:CLOUD_STATES.has(cp?.status)?cp.status:'unknown',code:cp?.status==='ok'?null:CLOUD_CODES.has(cp?.reason_code)?cp.reason_code:null};}
// A bare number (duration, port or request id) is not an HTTP failure.
export const authFailure=line=>{
 const text=String(line);let value;try{value=JSON.parse(text);}catch{}
 const fields=value?.fields&&typeof value.fields==='object'?value.fields:value;
 if(fields&&['status','status_code','http_status','http_status_code','response_status'].some(k=>[401,403,'401','403'].includes(fields[k])))return true;
 return /\bHTTP[_ /-](?:401|403)\b|\b(?:status|status_code|http_status|http_status_code)\s*[:=]\s*["']?(?:401|403)\b|invalid[_ -]?api[_ -]?key|\bunauthori[sz]ed\b/i.test(text);
};
/** Control-plane lines retain only timestamp/state/known error code, never message/url/header. */
export function controlPlaneLog(line){
 if(!/control[-_]plane/i.test(line))return null;
 let value;try{value=JSON.parse(line);}catch{value={};}
 const fields=value.fields&&typeof value.fields==='object'?value.fields:value;
 const timestamp=value.timestamp??value.time??value.ts;
 const at=typeof timestamp==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(timestamp)?timestamp:null;
 const state=CLOUD_STATES.has(fields.state??fields.status)?fields.state??fields.status:'unknown';
 const raw=fields.error_code??fields.reason_code??fields.code,code=CLOUD_CODES.has(raw)?raw:authFailure(line)?(/(?:401|HTTP_401)/.test(line)?'HTTP_401':/(?:403|HTTP_403)/.test(line)?'HTTP_403':'AUTH_REQUIRED'):null;
 return {at,state,code};
}
export class TunnelManager {
  constructor(stateDir,mcpUrl,mcpToken,{events=null,clock=Date.now,spawnChild=spawn,timers={setTimeout,clearTimeout}}={}) {
    this.events=events;this.clock=clock;this.spawnChild=spawnChild;this.timers=timers;this.controlPlaneObservations=new WeakMap();
    this.dir=stateDir;this.mcpUrl=mcpUrl;this.mcpToken=mcpToken;this.status='off';this.log=[];this.controlPlaneLog=[];this.child=null;this.doctorChild=null;this.key='';this.healthUrl=null;this.healthFile=path.join(stateDir,'tunnel-health.url');this.profile=path.join(stateDir,'tunnel.yaml');this.doctorProfile=path.join(stateDir,'tunnel-doctor.yaml');this.doctorHealthFile=path.join(stateDir,'tunnel-doctor-health.url');this.exitCode=null;this.generation=0;
  }
  push(data,{role,child,generation}={}) {
    if(role&&(generation!==this.generation||child!==(role==='doctor'?this.doctorChild:this.child)))return;
    let s=String(data);if(authFailure(s)){if(role==='doctor')this.doctorAuthFailed=true;else if(role==='transport')this.runAuthFailed=true;}const cloud=controlPlaneLog(s);if(cloud){this.controlPlaneLog.push(cloud);this.controlPlaneLog=this.controlPlaneLog.slice(-40);s=JSON.stringify(cloud);}
    for(const secret of [this.key,this.mcpToken])if(secret)s=s.split(secret).join('[REDACTED]');
    this.log.push(redact(s).slice(0,4000));this.log=this.log.slice(-80);
  }
  attachLogs(child,role) {
    const context={child,role,generation:this.generation};
    for(const stream of [child.stdout,child.stderr]) {
      const decoder=new StringDecoder('utf8');let pending='',omitting=false;
      stream.on('data',chunk=>{
        pending+=decoder.write(chunk);let at;
        while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(!omitting)this.push(line,context);omitting=false;}
        if(pending.length>32768){if(!omitting)this.push('[超长连接日志已省略]',context);pending='';omitting=true;}
      });
      stream.on('end',()=>{pending+=decoder.end();if(pending&&!omitting)this.push(pending,context);});
    }
  }
  configure({tunnel_id,api_key,binary='tunnel-client'}) {
    if(this.child||this.doctorChild)fail('TUNNEL_RUNNING','先断开或等待现有检查停止。');
    if(typeof api_key!=='string'||!api_key.startsWith('sk-')||api_key.length<12||api_key.length>512||/\s/.test(api_key))fail('KEY_INVALID','填写仅有 Tunnels Read + Use 的运行密钥。');
    const executable=findExecutable(binary);const yaml=profileText({tunnelId:tunnel_id,mcpUrl:this.mcpUrl,healthFile:this.healthFile});
    fs.writeFileSync(this.profile,yaml,{mode:0o600});fs.chmodSync(this.profile,0o600);
    // Isolate all writable doctor health output, regardless of client-version behavior.
    fs.writeFileSync(this.doctorProfile,profileText({tunnelId:tunnel_id,mcpUrl:this.mcpUrl,healthFile:this.doctorHealthFile}),{mode:0o600});fs.chmodSync(this.doctorProfile,0o600);
    this.binary=executable;this.key=api_key;this.tunnelId=tunnel_id;this.healthUrl=null;this.status='configured';this.log=[];this.generation++;
  }
  environment() {
    const env=tunnelEnvironment();
    // Remember which proxy this process uses; a system proxy (not one inherited from our parent) is watched for changes.
    this.proxyUsed=env.CONTROL_PLANE_HTTP_PROXY||env.HTTPS_PROXY||env.https_proxy||env.ALL_PROXY||env.all_proxy||null;
    this.proxyWatchable=process.platform==='darwin'&&!['HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'].some(k=>process.env[k]);
    return {...env,CONTROL_PLANE_API_KEY:this.key,KEN_BRIDGE_MCP_TOKEN:this.mcpToken};
  }
  startup(stage,outcome,at=this.clock(),code='OK'){this.events?.record('conn.startup',{stage,outcome,ms:Math.max(0,Math.floor(this.clock()-at)),code,source:'tunnel'});}
  async doctor() {
    if(!this.key)fail('TUNNEL_UNCONFIGURED','先填写通道和运行密钥。');
    if(this.doctorChild)fail('TUNNEL_RUNNING','连接检查正在进行。');
    this.doctorStatus='checking';this.doctorAuthFailed=false;const generation=this.generation,at=this.clock();this.startup('doctor','begin');
    return new Promise(resolve=>{
      const c=this.spawnChild(this.binary,['doctor','--config',this.doctorProfile,'--explain'],{env:this.environment(),detached:true,stdio:['ignore','pipe','pipe']});this.doctorChild=c;
      this.attachLogs(c,'doctor');let timedOut=false,spawnCode=null;
      const timer=this.timers.setTimeout(()=>{timedOut=true;this.terminate(c);},30000);
      c.on('error',e=>{spawnCode=['ENOENT','EACCES'].includes(e.code)?e.code:'SPAWN_ERROR';});
      c.on('close',code=>{
        this.timers.clearTimeout(timer);const owns=this.doctorChild===c,cancelled=generation!==this.generation||!owns;
        const authFailed=owns&&this.doctorAuthFailed===true;if(owns)this.doctorChild=null;
        const status=cancelled?'off':code===0&&!timedOut&&!spawnCode?'checked':'doctor_failed';
        // Doctor has its own status; it must never overwrite the live run process.
        if(!cancelled){this.doctorStatus=status;if(!this.child&&!['starting','running','stopping','exited'].includes(this.status))this.status=status;}
        this.startup('doctor',cancelled?'cancelled':timedOut?'timeout':code===0&&!spawnCode?'ok':'failed',at,cancelled?'CANCELLED':timedOut?'DOCTOR_TIMEOUT':spawnCode|| (authFailed?'CONNECTION_AUTH_FAILED':code===0?'OK':'DOCTOR_FAILED'));
        resolve({ok:!cancelled&&!timedOut&&!spawnCode&&code===0,exit_code:code,status,auth_failed:!cancelled&&authFailed,timed_out:timedOut,cancelled});
      });
    });
  }

  start() {
    if(this.child)fail('TUNNEL_RUNNING','通道正在运行。');
    if(!this.key)fail('TUNNEL_UNCONFIGURED','缺少运行密钥。');
    try{fs.unlinkSync(this.healthFile);}catch{}
    this.status='starting';this.exitCode=null;this.runAuthFailed=false;const generation=this.generation,at=this.clock();this.startup('transport','begin');
    const env=this.environment();this.runningProxy=this.proxyUsed;this.cp={startedAt:Date.now(),lastOkAt:0,notOkSince:Date.now(),failures:0,status:'starting',reason:null};
    const c=this.spawnChild(this.binary,['run','--config',this.profile,'--control-plane.initial-poll-timeout','1s'],{env,detached:true,stdio:['ignore','pipe','pipe']});this.child=c;this.attachLogs(c,'transport');
    c.on('spawn',()=>{if(this.generation===generation){this.status='running';this.startup('transport','ok',at);}});
    c.on('error',e=>{if(this.child!==c||this.generation!==generation)return;this.startup('transport','failed',at,['ENOENT','EACCES'].includes(e.code)?e.code:'SPAWN_ERROR');this.push(`通道无法启动：${e.code||'SPAWN_ERROR'}`);});
    c.on('close',code=>{if(this.child!==c)return;this.exitCode=code;this.child=null;this.status=this.generation===generation?'exited':'off';this.healthUrl=null;});
    return {status:this.status};
  }
  terminate(c) {
    if(!c?.pid)return;
    try{process.kill(-c.pid,'SIGTERM');}catch{try{c.kill('SIGTERM');}catch{}}
    const timer=setTimeout(()=>{try{process.kill(-c.pid,'SIGKILL');}catch{try{c.kill('SIGKILL');}catch{}}},800);
    c.once('close',()=>clearTimeout(timer));timer.unref();
  }
  stop() {this.generation++;for(const c of [this.child,this.doctorChild])this.terminate(c);this.healthUrl=null;this.status=this.child||this.doctorChild?'stopping':'off';}
  async snapshot() {
    const context={generation:this.generation,child:this.child,cp:this.cp};
    let healthy=false,ready=false,details=null;
    if(this.child) {
      try{const st=fs.lstatSync(this.healthFile);if(st.isFile()&&!st.isSymbolicLink()&&st.size<1024){const url=fs.readFileSync(this.healthFile,'utf8').trim();if(/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url))this.healthUrl=url.replace(/\/$/,'');}}catch{}
      if(this.healthUrl){const url=this.healthUrl,get=async p=>{try{return(await fetch(url+p,{signal:AbortSignal.timeout(1200),redirect:'error'})).ok;}catch{return false;}};[healthy,ready,details]=await Promise.all([get('/healthz'),get('/readyz'),this.healthDetails(url)]);}
    }
    const current=context.generation===this.generation&&context.child===this.child&&context.cp===this.cp;
    return {status:this.status,process_running:!!this.child,healthy:current&&healthy,ready:current&&ready,control_plane:current?this.observeControlPlane(details,this.clock(),context):null,ui_url:this.healthUrl?this.healthUrl+'/ui':null,tunnel_id:this.tunnelId??null,exit_code:this.exitCode,log:this.log,control_plane_log:this.controlPlaneLog};
  }
  /** tunnel-client /health?details=true. null = not reachable; {unsupported:true} = this tunnel-client has no details endpoint. */
  async healthDetails(url=this.healthUrl) {
    if(!url)return null;
    try{
      const r=await fetch(url+'/health?details=true',{signal:AbortSignal.timeout(1500),redirect:'error'});
      if(r.status===404||!(r.headers.get('content-type')||'').includes('json'))return {unsupported:true};
      const body=await r.json();return body&&typeof body==='object'&&!Array.isArray(body)?body:null;
    }catch{return null;}
  }
  authenticatedCallSucceeded(now=this.clock()) {
    if(!this.child||!this.cp||this.runAuthFailed===true)return false;
    this.cp.lastOkAt=now;this.cp.notOkSince=0;this.cp.failures=0;this.cp.callOkAt=now;this.cp.reason=null;
    return true;
  }
  /** Real health and authenticated calls both provide cloud confirmation. */
  confirmsControlPlane(value){
    const proof=value&&this.controlPlaneObservations.get(value);
    return !!proof&&value.state==='up'&&value.status==='ok'&&proof.generation===this.generation&&proof.child===this.child&&proof.cp===this.cp&&!!this.child;
  }
  observeControlPlane(details,now=Date.now(),context={generation:this.generation,child:this.child,cp:this.cp}) {
    const proxy=this.runningProxy?redactProxy(this.runningProxy):'direct';
    if(!this.child||!this.cp||context.generation!==this.generation||context.child!==this.child||context.cp!==this.cp)return null;
    const cp=this.cp;
    if(!details||details?.unsupported)return {state:'unknown',status:details?.unsupported?'unsupported':'unreachable',supported:!details?.unsupported,last_success_at:cp.lastOkAt||null,last_call_success_at:cp.callOkAt||null,down_since:null,consecutive_failures:0,reason_code:null,proxy,checked_at:now};
    const comp=details?.components?.['control-plane']??details?.components?.control_plane??null;
    if(typeof comp?.status!=='string')return {state:'unknown',status:'unknown',supported:true,last_success_at:cp.lastOkAt||null,last_call_success_at:cp.callOkAt||null,down_since:null,consecutive_failures:0,reason_code:null,proxy,checked_at:now};
    const status=comp.status;
    if(status==='ok'){cp.lastOkAt=now;cp.notOkSince=0;cp.failures=0;}
    else if(status!=='disabled'){cp.notOkSince||=now;cp.failures++;}
    cp.status=status;cp.reason=typeof comp?.reason_code==='string'?comp.reason_code.slice(0,80):null;
    const state=status==='ok'?'up':status==='disabled'?'unknown':cp.notOkSince&&now-cp.notOkSince>=CONTROL_PLANE_DOWN_AFTER_MS?'down':'checking';
    const result={state,status,supported:true,last_success_at:cp.lastOkAt||null,last_call_success_at:cp.callOkAt||null,down_since:cp.notOkSince||null,consecutive_failures:cp.failures,reason_code:cp.reason,proxy,checked_at:now};
    if(status==='ok')this.controlPlaneObservations.set(result,context);
    return result;
  }
}
