import {createLegacyChromeInstallSource} from '../support/legacy-chrome-install-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createDesktop} from '../../app/server.mjs';
import {DesktopState} from '../../app/state.mjs';

export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
export const waitFor=async condition=>{const until=Date.now()+1500;while(!condition()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(condition(),'isolated startup must progress without resolving the deferred dependency');};

// No socket, real App, Chrome or external process is used. The HTTP handlers
// themselves run, with an in-memory listener replacing only the OS socket.
export function fixture(t,{enabled=true,browser,optedIn=false,preference='tunnel',reconcile,register,existingRoot=null,statePatch={},chromeDistribution,seedChromeProfiles=true,siteNetworkFetch=async()=>new Response(null,{status:200})}={}){
 const root=existingRoot||fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1070-startup-'))),stateDir=path.join(root,'state'),work=path.join(root,'work');
 const legacyChromeInstallRoot=chromeDistribution?.distribution==='legacy_unpacked'?createLegacyChromeInstallSource(t):null;
 const state=new DesktopState(stateDir,{defaultRoot:work});Object.assign(state.data,{access_enabled:enabled,auto_connect:true,connection_preference:preference});
 if(chromeDistribution&&seedChromeProfiles){const localState=path.join(stateDir,'integration-home/Library/Application Support/Google/Chrome/Local State');fs.mkdirSync(path.dirname(localState),{recursive:true});fs.writeFileSync(localState,JSON.stringify({profile:{info_cache:{Default:{name:'Synthetic store profile'}}}}));}
 if(browser!==undefined)state.data.browser_enabled=browser;if(optedIn)state.data.browser_control_opt_in=true;Object.assign(state.data,statePatch);state.save();
 t.mock.method(os,'uptime',()=>3600);
 const servers=[];
 t.mock.method(http,'createServer',handler=>{
  const server=new EventEmitter();server.handler=handler;server.port=18000+servers.length;
  server.listen=(_port,_host,ready)=>{queueMicrotask(ready);return server;};server.address=()=>({port:server.port});server.closeAllConnections=()=>{};server.close=done=>done();
  servers.push(server);return server;
 });
 let now=Date.now(),seq=0;const timers=new Map(),values=new Map(),calls={starts:0,registers:0,cloud:'checking'};
 const clock={now:()=>now,setTimeout(fn,ms){const timer={id:++seq,at:now+ms,fn,unref(){}};timers.set(timer.id,timer);return timer;},clearTimeout(timer){timers.delete(timer?.id);}};
 const tunnel={child:null,doctorChild:null,log:[],status:'configured',configure(config){Object.assign(this,{key:config.api_key,tunnelId:config.tunnel_id});},start(){calls.starts++;this.child=new EventEmitter();this.status='running';},stop(){this.child=null;},doctor:async()=>({ok:true}),snapshot:async()=>({status:'running',healthy:!!tunnel.child,ready:!!tunnel.child,process_running:!!tunnel.child,control_plane:{state:calls.cloud,status:calls.cloud==='up'?'ok':'starting'}})};
 values.set('tunnel',{api_key:'synthetic-fixture-only',tunnel_id:'synthetic-channel'});
 const credentials={get:key=>values.get(key)||null,set:(key,value)=>values.set(key,value),remove:key=>values.delete(key),status:()=>({}),publicStatus:()=>({}),readAll:()=>Object.fromEntries(values),writeAll:data=>{values.clear();for(const [key,value]of Object.entries(data))values.set(key,value);}};
 const transport={epoch:1,running:false,setRpcDelivery(fn){this.deliver=fn;},setRuntimeFactory(fn){this.runtime=fn;},setHostFlow(){},start(){this.running=true;this.epoch++;},stop(){this.running=false;},close(){this.stop();},revokeCurrent:async()=>({remote_revocation:'confirmed'}),stageStatus(){return {running:this.running,ready:false,authenticated:false,transport_epoch:this.epoch};},status(){return this.stageStatus();}};
 const f={root,stateDir,servers,tunnel,calls,transport,values};
 f.building=createDesktop({stateDir,defaultRoot:work,uiKey:'ab'.repeat(32),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{siteNetworkFetch,...(legacyChromeInstallRoot?{legacyChromeInstallRoot}:{}),...(chromeDistribution?{chromeDistribution}:{}),maintenanceClock:clock,credentials,bSiteTransport:transport,currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic Mac',tunnelFactory:(_dir,_url,token)=>{f.mcpToken=token;return tunnel;},browserHost:{expectedBinary:path.join(root,'host'),manifestPath:[path.join(root,'native-host.json')],register:options=>{calls.registers++;return register?register(options):{registered:true};}},updaterFactory:deps=>{f.updateDeps=deps;return {reconcileStartup:()=>reconcile?reconcile(deps):Promise.resolve({reconciled:false}),snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})};}}}).then(app=>{f.app=app;return app;});
 f.elapse=ms=>{now+=ms;};
 f.advance=async ms=>{now+=ms;for(let i=0;i<10;i++){const due=[...timers.values()].filter(v=>v.at<=now);if(!due.length)break;for(const timer of due){timers.delete(timer.id);timer.fn();}await flush();}};
 f.post=async(route,body={}, {owner=true,ui=true}={})=>request(servers[1],route,body,{...(owner?{authorization:'Bearer '+f.app.adminToken}:{}),...(ui?{'x-chathand-ui':f.app.uiKey}:{})});
 f.rpc=async (name,args=name==='begin_task'?{request_id:'synthetic-startup-request',title:'Startup isolation'}:{})=>request(servers[0],'/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':'synthetic-startup-session'}}},{'x-ken-bridge-token':f.mcpToken,accept:'application/json, text/event-stream'});
 t.after(async()=>{if(f.app)await f.app.close();});
 return f;
}
async function request(server,url,body,headers={}){
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url,method:'POST',headers:{host:'127.0.0.1:'+server.port,'content-type':'application/json',...headers}});
 const res=new EventEmitter();res.setHeader=()=>{};res.writeHead=status=>{res.statusCode=status;};res.end=value=>{res.body=value;res.emit('finish');};
 await server.handler(req,res);return {status:res.statusCode,body:JSON.parse(res.body)};
}

