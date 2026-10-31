import {localText} from '../i18n.mjs';
import {verifyChromeScreenshotPatch} from '../../scripts/patch-chrome-screenshot.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {safeEnvironment} from '../../engine/src/commands.mjs';
const ROOT=path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const err=(code,message)=>Object.assign(new Error(message),{code});
export const BACKEND_VERSION='1.9.0';
export function backendArguments({workspace,endpoint}={}){
 const args=[path.join(ROOT,'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),'--channel=stable','--no-usage-statistics','--no-performance-crux','--no-category-performance','--no-category-network','--no-category-emulation','--no-category-extensions','--no-category-experimental-third-party','--no-javascript-evaluation','--no-source-maps','--experimental-structured-content','--page-id-routing','--screenshot-format=jpeg','--screenshot-quality=65','--screenshot-max-width=1440','--screenshot-max-height=1000','--workspace='+workspace];
 // endpoint exists only for disposable development fixtures, never in a public tool schema or user setting.
 if(endpoint){const u=new URL(endpoint);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/')throw err('TEST_ENDPOINT_INVALID','Only an explicit loopback fixture is accepted.');args.push('--browser-url='+endpoint);}else args.push('--auto-connect');return args;
}
export class ChromeTransport {
 constructor({workspace,endpoint}={}){this.workspace=workspace;this.endpoint=endpoint;this.pending=new Map();this.child=null;this.buffer='';this.ready=null;this.closing=null;this.generation=0;this.tools=[];this.stderr='';}
 isRunning(){return !!this.child&&this.child.exitCode===null&&this.child.signalCode===null;}
 async start(){if(this.ready)return this.ready;const generation=++this.generation;
  this.ready=(async()=>{
   try{this.screenshotAdapterHash=verifyChromeScreenshotPatch(ROOT).helper_sha256;}catch{this.screenshotAdapterHash=null;}
   fs.mkdirSync(this.workspace,{recursive:true,mode:0o700});const args=backendArguments({workspace:this.workspace,endpoint:this.endpoint});
   if(!fs.existsSync(args[0]))throw err('CHROME_BACKEND_MISSING','安装包缺少 Chrome 连接组件。');
   const env={...safeEnvironment(),HOME:os.homedir(),CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS:'1',CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:'1'};
   const child=spawn(process.execPath,args,{cwd:ROOT,env,stdio:['pipe','pipe','pipe'],windowsHide:true});this.child=child;this.buffer='';this.stderr='';
   const died=()=>{if(this.child!==child)return;this.child=null;this.ready=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(err('CHROME_CONNECTION_CLOSED','Chrome 连接已断开，请在应用内重新连接。'));}this.pending.clear();};
   child.on('error',died);child.on('exit',died);child.stderr.on('data',b=>{this.stderr=(this.stderr+b.toString('utf8')).slice(-3000);});
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>8*1024*1024){void this.stop();return;}
    let index;while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line.trim())continue;let message;try{message=JSON.parse(line);}catch{void this.stop();return;}
     if(message.id!==undefined&&message.method){this.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported client method'}});continue;}
     const p=this.pending.get(message.id);if(!p)continue;this.pending.delete(message.id);clearTimeout(p.timer);if(message.error)p.reject(err('CHROME_PROTOCOL_ERROR','Chrome 连接协议返回错误。'));else p.resolve(message.result);
    }
   });
   await this.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'ChatHand',version:'0.8.0-beta.1'}},10000);this.send({jsonrpc:'2.0',method:'notifications/initialized'});
   const list=await this.rpc('tools/list',{},10000);this.tools=list.tools||[];if(generation!==this.generation)throw err('CHROME_CONNECTION_CLOSED','连接已取消。');return this;
  })().catch(async e=>{await this.stop();throw e;});return this.ready;
 }
 send(message){if(!this.child?.stdin.writable)throw err('CHROME_CONNECTION_CLOSED','Chrome 连接未启动。');this.child.stdin.write(JSON.stringify(message)+'\n');}
 rpc(method,params,timeout=15000){const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(err('CHROME_REQUEST_TIMEOUT','Chrome 未及时响应。请查看浏览器是否正在等待本人授权；不会自动重试动作。'));void this.stop();},timeout);this.pending.set(id,{resolve,reject,timer});try{this.send({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 async call(name,args={},timeout=15000){const screenshotAdapter=name==='take_screenshot'?verifyChromeScreenshotPatch(ROOT):null;await this.start();if(screenshotAdapter&&this.screenshotAdapterHash!==screenshotAdapter.helper_sha256)throw err('CHROME_SCREENSHOT_ADAPTER_RESTART_REQUIRED',localText('browser.screenshot.adapterRestartRequired'));if(!this.tools.some(t=>t.name===name))throw err('CHROME_TOOL_UNSUPPORTED','当前连接组件不支持该操作。');const result=await this.rpc('tools/call',{name,arguments:args},timeout);if(result?.isError){const raw=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');let code='CHROME_ACTION_FAILED';if(/remote debugging|connect to|browser.*running|DevToolsActivePort|Could not find|permission|rejected|cancelled/i.test(raw))code='CHROME_PERMISSION_OR_CONNECTION_REQUIRED';throw err(code,code==='CHROME_PERMISSION_OR_CONNECTION_REQUIRED'?'请打开平时的 Chrome，在 ChatHand 首页右边「权限与能力」→ 浏览器控制里点「重新连接」，并亲自允许 Chrome 的授权提示。':'Chrome 未完成此操作，请先重新观察页面。');}return result;}
 async stop(){if(this.closing)return this.closing;this.generation++;const child=this.child;this.ready=null;this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(err('CHROME_CONNECTION_CLOSED','连接已停止。'));}this.pending.clear();this.buffer='';
  if(!child)return;this.closing=(async()=>{try{child.stdin.end();}catch{}await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,500))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,1200))]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}})().finally(()=>{this.closing=null;});return this.closing;
 }
}
