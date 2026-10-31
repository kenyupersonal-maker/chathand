import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
const err=code=>Object.assign(Error(code),{code});
const siteNetworkMessages=Object.freeze({
 SITE_NETWORK_CHALLENGED:{zh:'这台 Mac 当前的网络会被 Site 的网络验证（Cloudflare）拦截，多半是在用代理或 VPN。请改用 OpenAI 通道，或关闭代理或 VPN 后重试。',en:'Cloudflare’s network check blocks this Mac’s current network, often because of a proxy or VPN. Use the OpenAI Tunnel, or turn off the proxy or VPN and try again.'},
 SITE_NETWORK_UNREACHABLE:{zh:'无法连接 ChatGPT Site，请检查网络后重试，或改用 OpenAI 通道。',en:'Can’t reach ChatGPT Site. Check your network and try again, or use the OpenAI Tunnel.'}
});


const safeCode=(value,fallback='LOCAL_SETUP_FAILED')=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:fallback;
const safePairingMismatch=value=>['claim', 'protocol_version', 'site_id', 'site_origin', 'owner_subject', 'installation_id', 'device_public_key_id', 'public_key_id', 'client_nonce', 'server_nonce', 'template_version', 'manifest_sha256', 'pairing_intent', 'device_name', 'generation', 'binding_id', 'pairing_id', 'pairing_hash'].includes(value)?value:null;
const validKey=key=>typeof key==='string'&&key.length<=8192&&/^sk-[A-Za-z0-9_-]{17,}$/.test(key);
export function locateRuntime({home=os.homedir(),platform=process.platform,probe=process.kill,stateDir=process.env.CHATHAND_STATE_DIR}={}){if(stateDir!==undefined&&(typeof stateDir!=='string'||!path.isAbsolute(stateDir)))throw err('STATE_DIR_INVALID');const base=path.join(home,'Library/Application Support/ChatHand');for(const dir of stateDir?[path.resolve(stateDir)]:[path.join(base,'data')]){const file=path.join(dir,'runtime.json');if(!fs.existsSync(file))continue;const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)throw err('RUNTIME_UNSAFE');const r=JSON.parse(fs.readFileSync(file));if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(r.ui_origin)||!/^\w{64}$/.test(r.admin_token)||!Number.isSafeInteger(r.pid)||r.pid<2)throw err('RUNTIME_INVALID');try{probe(r.pid,0);}catch(e){if(e.code!=='EPERM')throw err('APP_NOT_RUNNING');}Object.defineProperty(r,'diagnosticStateDir',{value:dir});return r;}throw err('APP_NOT_RUNNING');}
export function validatePublicID(id){if(typeof id!=='string'||!/^tunnel_[A-Za-z0-9_-]{8,100}$/.test(id))throw err('TUNNEL_ID_INVALID');return id;}
function readClipboard({platform=process.platform,run=spawnSync}={}){let r;if(platform==='darwin')r=run('/usr/bin/pbpaste',[],{encoding:'utf8',timeout:3000,maxBuffer:16384});else throw err('PLATFORM_UNSUPPORTED');if(r.status!==0)throw err('CLIPBOARD_UNAVAILABLE');return String(r.stdout||'');}
export function clipboardCheck(id,{clipboard=readClipboard}={}){validatePublicID(id);return {matches:clipboard().trim()===id};}
export function readKey(options={}){const raw=readClipboard(options),key=raw.trim();if(!validKey(key))throw err('CLIPBOARD_NOT_A_KEY');options.capture?.(raw);return key;}
export function clearKeyClipboard(key,{platform=process.platform,run=spawnSync,expected=key}={}){
 // A changed clipboard is the user's new content, including short text or whitespace.
 let current;try{current=readClipboard({platform,run});}catch{return false;}
 if(current!==expected)return false;
 const r=run('/usr/bin/pbcopy',[],{input:'',timeout:3000});
 return r.status===0;
}
export async function callOwner(r,route,body,fetcher=fetch){let response;try{response=await fetcher(r.ui_origin+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+r.admin_token},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});}catch{throw err('OWNER_UNREACHABLE');}const failure=code=>Object.assign(err(code),Number.isInteger(response.status)?{status:response.status}:{});let data;try{data=await response.json();}catch{throw failure('OWNER_RESPONSE_INVALID');}if(!response.ok||data.error){const error=failure(safeCode(data.error?.code||data.error,'OWNER_REQUEST_FAILED')),mismatch=error.code==='B_PAIRING_BINDING'?safePairingMismatch(data.error?.mismatch||data.error?.details?.mismatch):null;if(mismatch)error.mismatch=mismatch;throw error;}return data;}
// A bundled helper must talk to the backend from that same physical App.
// Another copy could otherwise find the global runtime and appear healthy.
export async function verifySetupOwner(runtime,{call=callOwner,executable=process.execPath,realpath=fs.realpathSync}={}){
 if(typeof executable!=='string'||!/\.app\/Contents\/Resources\/runtime\/bin\/(?:node|ChatHandNode)$/.test(executable))return null;
 const state=await call(runtime,'/api/state');
 try{if(typeof state?.node!=='string'||realpath(state.node)!==realpath(executable))throw Error();}
 catch{throw err('APP_PATH_MISMATCH');}
 return state;
}
// Quit observes only pinned PID/path/start-time identities. No signal except kill(pid,0).
export function inspectQuitProcess(pid,{run=spawnSync,probe=process.kill,timeoutMs=1000}={}){
 if(!Number.isSafeInteger(pid)||pid<2)throw err('QUIT_IDENTITY_UNVERIFIED');
 try{probe(pid,0);}catch(e){if(e.code==='ESRCH')return null;throw err('QUIT_IDENTITY_UNVERIFIED');}
 const r=run('/bin/ps',['-ww','-p',String(pid),'-o','pid=','-o','ppid=','-o','lstart=','-o','comm='],{encoding:'utf8',timeout:Math.max(1,Math.min(1000,timeoutMs)),maxBuffer:16384,env:{...process.env,LC_ALL:'C'}});
 if(r.status!==0){try{probe(pid,0);}catch(e){if(e.code==='ESRCH')return null;}throw err('QUIT_IDENTITY_UNVERIFIED');}
 const m=/^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(r.stdout||'');
 if(!m||Number(m[1])!==pid||!path.isAbsolute(m[4]))throw err('QUIT_IDENTITY_UNVERIFIED');
 return {pid,ppid:Number(m[2]),path:fs.realpathSync(m[4]),started:m[3].replace(/\s+/g,' ')};
}
// lsof txt is OS program-text mapping evidence, not a claim of unique execpath.
export function quitProgramText(pid,expected,{run=spawnSync,timeoutMs=1000}={}){
 const r=run('/usr/sbin/lsof',['-n','-P','-a','-p',String(pid),'-d','txt','-Fn'],{encoding:'utf8',timeout:Math.max(1,Math.min(1000,timeoutMs)),maxBuffer:262144});
 if(r.status!==0)return false;
 const rows=String(r.stdout||'').split('\n');
 return rows[0]==='p'+pid&&rows.some(row=>row==='n'+expected||row==='n'+expected.replace(/^\/private\/var\//,'/var/'));
}
// These programs come only from the installed Node's physical App, never the incoming disc.
function installedQuitProgram(file){
 const st=fs.lstatSync(file),uid=process.getuid?.();
 if(!st.isFile()||st.isSymbolicLink()||fs.realpathSync(file)!==file||(st.mode&0o022)!==0||(st.mode&0o111)===0||uid!==undefined&&st.uid!==uid&&st.uid!==0)throw err('QUIT_IDENTITY_UNVERIFIED');
}
export function stopInstalledQuitHelper(helper,app,{timeoutMs,signal,launch=spawn}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000||signal?.aborted)throw err('QUIT_TIMEOUT');
 // The original helper's stop uses NSRunningApplication.terminate(), never forceTerminate.
 // Only our own newly-created helper child may be killed at the common deadline.
 return new Promise((resolve,reject)=>{
  let child,timer,done=false,timedOut=false,overflow=false,output='';
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
  const cancel=()=>{timedOut=true;if(child?.pid)child.kill('SIGKILL');};
  try{child=launch(helper,['stop',app],{stdio:['ignore','pipe','ignore']});}catch{finish(err('QUIT_HELPER_FAILED'));return;}
  child.stdout.on('data',chunk=>{if(output.length+chunk.length>8192){overflow=true;child.kill('SIGKILL');}else output+=chunk;});
  child.on('error',()=>finish(err(timedOut?'QUIT_TIMEOUT':'QUIT_HELPER_FAILED')));
  child.on('close',(code,exitSignal)=>{if(timedOut||signal?.aborted){finish(err('QUIT_TIMEOUT'));return;}let result;try{result=JSON.parse(output);}catch{}if(overflow||code!==0||exitSignal||result?.stopped!==true)finish(err('QUIT_HELPER_FAILED'));else finish(null,{stopped:true});});
  signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,timeoutMs);if(signal?.aborted)cancel();
 });
}
export function quitContext({executable=process.execPath,run=spawnSync,stop=stopInstalledQuitHelper}={}){
 const node=fs.realpathSync(executable),marker='/Contents/Resources/runtime/bin/',offset=node.lastIndexOf(marker);
 if(offset<1||!['node','ChatHandNode'].includes(path.basename(node)))throw err('QUIT_APP_NODE_REQUIRED');
 const app=node.slice(0,offset),helper=path.join(app,marker.slice(1),'ken-upgrade-control');
 if(!app.endsWith('.app')||fs.realpathSync(app)!==app)throw err('QUIT_IDENTITY_UNVERIFIED');
 const verifyHelper=()=>{installedQuitProgram(helper);installedQuitProgram(path.join(path.dirname(helper),'ChatHandUpgradeControl'));};verifyHelper();
 return {app,node,helper,nativePaths:['ChatHand','KenBridge'].map(name=>path.join(app,'Contents/MacOS',name)),normalStop:(budget,signal)=>{
  verifyHelper();let pkg;try{pkg=JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/runtime/package.json'),'utf8'));}catch{throw err('QUIT_IDENTITY_UNVERIFIED');}
  if(pkg?.kenBridge?.build_number!==1065||pkg.version!=='1.0.0-beta.15')throw err('QUIT_IDENTITY_UNVERIFIED');
  return stop(helper,app,{timeoutMs:budget,signal});
 },nativeInfo:(budget=1500)=>{
  verifyHelper();
  const r=run(helper,['info',app],{encoding:'utf8',timeout:Math.max(1,Math.min(1500,budget)),maxBuffer:32768});
  let info;try{info=JSON.parse(r.stdout);}catch{throw err('QUIT_IDENTITY_UNVERIFIED');}
  if(r.status!==0||info.kernel_scan!==true||!Array.isArray(info.pids)||!info.pids.length||info.pids.length>32||!Array.isArray(info.identities)||info.identities.length!==info.pids.length)throw err('QUIT_IDENTITY_UNVERIFIED');
  return info;
 }};
}
export async function quitOwner(runtime,{call=callOwner,context=quitContext,inspect=inspectQuitProcess,probe=process.kill,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=12000,realpath=fs.realpathSync,programText=quitProgramText}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000)throw err('QUIT_BUDGET_INVALID');
 const abort=new AbortController(),request=(runtime,route,body)=>call(runtime,route,body,(url,init)=>fetch(url,{...init,signal:AbortSignal.any([init.signal,abort.signal])}));
 const started=now(),deadline=started+timeoutMs,remaining=()=>deadline-now();let identities=[],accepted=false,requested=false,method='owner_api',helperProgram;const gone=new Set();
 const receipt=()=>({requested,accepted,method,...(helperProgram?{helper_program:helperProgram}:{}),native_exited:identities.some(i=>i.role==='native')&&identities.filter(i=>i.role==='native').every(i=>gone.has(i.pid)),backend_exited:identities.some(i=>i.role==='backend')&&identities.filter(i=>i.role==='backend').every(i=>gone.has(i.pid)),processes:identities.map(({pid,path,role})=>({pid,path,role})),secrets_printed:false});
 async function bounded(work){const left=remaining();if(left<=0)throw err('QUIT_TIMEOUT');let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(err('QUIT_TIMEOUT'));},left);})]);}finally{clearTimeout(timer);}}
 try{
  const target=context(),before=await bounded(()=>request(runtime,'/api/state'));
  if(before?.lifecycle?.protocol!==1||typeof before.node!=='string'||realpath(before.node)!==target.node)throw err('QUIT_IDENTITY_UNVERIFIED');
  const identity=pid=>{if(remaining()<=0)throw err('QUIT_TIMEOUT');let value;try{value=inspect(pid,{timeoutMs:remaining()});}catch(e){if(remaining()<=0)throw err('QUIT_TIMEOUT');throw e;}if(remaining()<=0)throw err('QUIT_TIMEOUT');return value;};
  const mapped=pid=>{if(remaining()<=0)throw err('QUIT_TIMEOUT');const value=programText(pid,target.node,{timeoutMs:remaining()});if(remaining()<=0)throw err('QUIT_TIMEOUT');return value;};
  const backend=identity(runtime.pid);if(!backend||![target.node,path.join(path.dirname(target.node),'node'),path.join(path.dirname(target.node),'ChatHandNode')].includes(backend.path)||!mapped(runtime.pid))throw err('QUIT_IDENTITY_UNVERIFIED');
  backend.commPath=backend.path;backend.path=target.node;
  const info=target.nativeInfo(remaining()),native=info.pids.map(pid=>identity(pid));
  if(native.some((item,index)=>!item||!target.nativePaths.includes(item.path)||!info.identities.some(i=>i.pid===item.pid&&realpath(i.executable)===item.path))||!native.some(i=>i.pid===backend.ppid))throw err('QUIT_IDENTITY_UNVERIFIED');
  identities=[...native.map(i=>({...i,role:'native'})),{...backend,role:'backend'}];
  const stillSame=observed=>{
   const current=identity(observed.pid);if(current===null){gone.add(observed.pid);return false;}
   if(observed.role==='backend'&&current.path===observed.commPath){if(!mapped(observed.pid))throw err('QUIT_IDENTITY_UNVERIFIED');current.path=observed.path;}
   if(current.path!==observed.path||current.started!==observed.started)throw err('QUIT_IDENTITY_CHANGED');return true;
  };
  if(remaining()<=0)throw err('QUIT_TIMEOUT');
  requested=true;
  try{const response=await bounded(()=>request(runtime,'/api/lifecycle/quit',{}));if(response?.accepted!==true)throw err('QUIT_NOT_ACCEPTED');accepted=true;}
  catch(error){
   if(before?.about?.build!==1065||before.about.version!=='1.0.0-beta.15'||error?.status!==403||error.code!=='UI_CONFIRM_REQUIRED'||typeof target.normalStop!=='function')throw error;
   if(identities.map(stillSame).some(alive=>!alive))throw err('QUIT_IDENTITY_CHANGED');
   method='installed_1065_helper_stop';helperProgram=target.helper;
   const response=await bounded(()=>target.normalStop(remaining(),abort.signal));if(response?.stopped!==true)throw err('QUIT_NOT_ACCEPTED');accepted=true;
  }
  while(remaining()>0){
   let alive=false;
   for(const observed of identities){
    try{probe(observed.pid,0);}catch(e){if(e.code==='ESRCH'){gone.add(observed.pid);continue;}throw err('QUIT_IDENTITY_UNVERIFIED');}
    if(stillSame(observed))alive=true;
   }
   if(!alive)return {...receipt(),native_exited:true,backend_exited:true,elapsed_ms:Math.max(0,now()-started)};
   await bounded(()=>wait(Math.min(100,remaining())));
  }
  throw err('QUIT_TIMEOUT');
 }catch(error){const code=safeCode(error?.code,'QUIT_FAILED'),failure=err(code);failure.quit_receipt=receipt();throw failure;}finally{abort.abort();}
}
const cloudDown=s=>s?.connection?.control_plane?.state==='down';
// 1052 C6（Claude）：Site 路线的状态只给布尔和公开的 origin，不给凭据。
const siteRoute=s=>s?.site_b?.routes?.site||{};
const siteHealthy=s=>siteRoute(s).configured===true&&siteRoute(s).state==='healthy'&&siteRoute(s).health_fresh===true;
const siteSelectedHealthy=s=>s?.site_b?.selected==='site'&&siteHealthy(s);
const routeConnected=s=>s.site_b?.selected==='site'?siteSelectedHealthy(s):!!((s.connection?.display?s.connection.display.connected===true:s.connection?.ready&&s.connection?.healthy&&!cloudDown(s))||s.relay?.online);
const publicDisplay=d=>!d?null:{state:d.state,tone:d.tone,title:d.title,detail:d.detail,connected:d.connected===true,last_confirmed_at:d.last_confirmed_at||null,...(d.settings_warning?{settings_warning:{tone:d.settings_warning.tone,title:d.settings_warning.title,detail:d.settings_warning.detail}}:{}),...(d.probe?{probe:{reachable:d.probe.reachable===true,elapsed_ms:d.probe.elapsed_ms,code:d.probe.code,target:d.probe.target,via_system_proxy:d.probe.via_system_proxy===true}}:{})};
export function sanitized(s){const cp=s.connection?.control_plane;return {version:s.version,instance_id:s.instance_id||null,installation_id:s.installation_id||null,chatgpt_tools:s.tools_list_status?{state:s.tools_list_status.state,message:s.tools_list_status.message,last_seen_at:s.tools_list_status.last_seen_at,schema_sha256:s.tools_list_status.schema_sha256,persisted:s.tools_list_status.persisted===true,error_code:['TOOLS_LIST_PROOF_UNAVAILABLE','TOOLS_LIST_PROOF_SAVE_FAILED'].includes(s.tools_list_status.error_code)?s.tools_list_status.error_code:null,execution_gate:false}:null,connection_display:publicDisplay(s.connection?.display),cloud_log:(s.connection?.control_plane_log||[]).slice(-40).map(({at,state,code})=>({at,state,code})),connected:routeConnected(s),execution_route:s.site_b?.selected==='site'?'site':'openai',setup_route:['none','site','openai'].includes(s.setup_route)?s.setup_route:null,selected_route:['site','openai'].includes(s.site_b?.selected)?s.site_b.selected:['none','site','openai'].includes(s.setup_route)?s.setup_route:'openai',site_configured:siteRoute(s).configured===true,site_healthy:siteHealthy(s),site_origin:publicSiteOrigin(siteRoute(s).origin),site_state:typeof siteRoute(s).state==='string'?siteRoute(s).state:null,site_template_ready:s.site_b?.verified_template_source?.verified_source===true,local_service:!!(s.connection?.ready&&s.connection?.healthy),cloud:cp?.state||'unknown',cloud_last_success_at:cp?.last_success_at||null,proxy:cp?.proxy||null,workspace_selected:!!s.project?.path,workspace_count:s.settings?.projects?.length||0,has_saved_connection:s.credentials?.tunnel===true||!!s.settings?.tunnel,browser_connected:s.automation?.browser?.extension?.connected===true,tool_count:s.manifest?.tool_count,chatgpt_app_retest_required:s.settings?.chatgpt_app_retest_required===true,chatgpt_app_missing:s.settings?.chatgpt_app_missing||null,chatgpt_app_name:s.settings?.chatgpt_app_name||null,chatgpt_app_name_suggested:s.settings?.chatgpt_app_name_suggested||null,chatgpt_app_identity:s.settings?.chatgpt_app_identity||null,secret_values_omitted:true};}
// 1052 C6（Claude）：Site 那一行只从 stdin 进来（C4 第 1 步的格式），只在本机核形状，交给 /api/setup/site。
// 不放参数、不打印、不写文件；出错只报代码，不带原文（JSON.parse 的报错里会带一段原文，所以自己报）。
export function publicSiteOrigin(o){try{const u=new URL(o);return u.protocol==='https:'&&!u.username&&!u.password&&u.origin===o&&u.hostname.endsWith('.chatgpt.site')?u.origin:null;}catch{return null;}}
export function parseSiteLine(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>8192)throw err('SITE_LINE_INVALID');
 let v;try{v=JSON.parse(raw.trim());}catch{throw err('SITE_LINE_INVALID');}
 const keys=['format','site_origin','site_id','service_credential'];
 if(!v||typeof v!=='object'||Array.isArray(v)||!Object.keys(v).every(k=>keys.includes(k)||v.format==='chathand-site-v3'&&k==='replacement_grant')||!keys.every(k=>typeof v[k]==='string'))throw err('SITE_LINE_INVALID');
 if(!['chathand-site-v2','chathand-site-v3'].includes(v.format)||v.replacement_grant!==undefined&&(typeof v.replacement_grant!=='string'||v.replacement_grant.length<32||v.replacement_grant.length>4096||/\s/.test(v.replacement_grant))||!publicSiteOrigin(v.site_origin)||
    !/^[A-Za-z0-9_-]{4,128}$/.test(v.site_id)||
    v.service_credential.length<32||v.service_credential.length>4096||/\s/.test(v.service_credential))throw err('SITE_LINE_INVALID');
 return {format:v.format,site_origin:v.site_origin,site_id:v.site_id,service_credential:v.service_credential,...(v.replacement_grant?{replacement_grant:v.replacement_grant}:{})};
}
async function readStdin(stream=process.stdin,limit=8192){
 if(stream.isTTY)throw err('SITE_LINE_STDIN_REQUIRED');
 const chunks=[];let size=0;
 for await(const c of stream){size+=c.length;if(size>limit+2)throw err('SITE_LINE_INVALID');chunks.push(c);}
 return Buffer.concat(chunks).toString('utf8');
}
function siteTemplateUpdateRequired(origin){
 return {phase:'template_update_required',configured:false,connected:false,
  error_code:'B_REBIND_UNSUPPORTED',reason_code:'B_REBIND_UNSUPPORTED',next_action:'update_site_template',origin,
  recovery:{state:'update_site_template',confirmed_failure_required:true,on_unconfirmed:'resume_current_action',
   transitions:{update_site_template:{succeeded:'retry_pairing',failed:'create_new_site'},
    create_new_site:{succeeded:'retry_pairing',failed:'offer_openai_fallback'}},
   fallback_requires_user_choice:true},secrets_printed:false};
}
function siteBindingConflict(pairing,origin,now){
 const c=pairing.conflict||{},deviceName=typeof c.device_name==='string'?c.device_name.replace(/[\p{Cc}\p{Cf}]/gu,'').trim().slice(0,80)||null:null;
 const lastUsed=Number.isSafeInteger(c.last_used)&&c.last_used>0&&Number.isFinite(new Date(c.last_used).getTime())?c.last_used:null;
 const time=lastUsed===null?null:new Date(lastUsed).toISOString();
 const expires=pairing.question_expires_at;
 if(!Number.isSafeInteger(expires)||expires<=now||typeof pairing.question_id!=='string')throw err('B_PAIRING_ATTEMPT_EXPIRED');
 return {phase:'conflict',configured:false,connected:false,error_code:'B_BINDING_CONFLICT',next_action:'choose_connection',origin,
  conflict:{device_name:deviceName,last_used:lastUsed,...Object.fromEntries(['installation_id','pairing_hash','expected_bindings'].filter(key=>typeof c[key]==='string').map(key=>[key,c[key]]))},
  replace_supported:pairing.replace_supported===true,replacement:pairing.replacement,fresh_answer_required:true,previous_answers_valid:false,answer_scope:'current_question_only',
  question_id:pairing.question_id,question_expires_at:expires,
  prompt:{zh:{question:`你的账号已连着另一台电脑${deviceName?`「${deviceName}」`:''}${time?`（最后使用：${time}）`:''}。一个连接通道（Site）只能连一台电脑，这台 Mac 要怎么连？`,
   options:[{id:'create_new_site',label:'新建一个 Site（推荐）'},...(pairing.replace_supported===true?[{id:'replace_current',label:`改连这台 Mac：${deviceName?`「${deviceName}」`:'原来那台电脑'}将断开连接（本地资料不会丢）`}]:[]),{id:'switch_openai',label:'改用 OpenAI 通道'}]},
   en:{question:`Your account is linked to another computer${deviceName?` “${deviceName}”`:''}${time?` (last used: ${time})`:''}. A Site connects one computer. How should this Mac connect?`,
    options:[{id:'create_new_site',label:'Create a new Site (recommended)'},...(pairing.replace_supported===true?[{id:'replace_current',label:`Connect this Mac: ${deviceName?`“${deviceName}”`:'the previous computer'} will disconnect (local files stay)`}]:[]),{id:'switch_openai',label:'Use OpenAI'}]}},
  secrets_printed:false};
}
async function site(r,{stdin,call,now,wait,before}){
 let line=await stdin();let body;
 try{body=parseSiteLine(line);}finally{line='';}
 if(body.replacement_grant){body=null;throw err('B_REBIND_AUTHORIZATION_UNAVAILABLE');}
 const startedAt=now(),siteId=body.site_id,expectedOrigin=body.site_origin,
  baselineRevision=Number(siteRoute(before).revision);
 let result;try{result=await call(r,'/api/setup/site',body);}
 catch(error){if(error?.code==='B_REBIND_UNSUPPORTED')return siteTemplateUpdateRequired(expectedOrigin);throw error;}
 finally{body=null;}
 const origin=publicSiteOrigin(result?.origin);
 if(origin!==expectedOrigin||!['pairing','credential_updated'].includes(result?.phase))throw err('SITE_SETUP_UNCONFIRMED');
 // 本次请求必须让同一 Site 的路由版本前进；旧 healthy 不算本次成功。
 const end=now()+60000;
 while(now()<end){
  const s=await call(r,'/api/state'),p=s.site_b?.pairing||{},route=siteRoute(s);
  const notice=s.site_b?.paired_notice;
  const current=siteHealthy(s)&&route.site_id===siteId&&publicSiteOrigin(route.origin)===origin&&
   p.phase==='configured'&&p.target_site===siteId&&p.pending_until==null&&
   Number.isSafeInteger(route.revision)&&route.revision>baselineRevision;
  if(current&&result.phase==='credential_updated')
   return {phase:'credential_updated',origin,secrets_printed:false};
  if(current&&notice?.origin===origin&&Number.isSafeInteger(notice.paired_at)&&notice.paired_at>=startedAt)
   return {phase:'paired',origin,selected_route:s.site_b?.selected==='site'?'site':'openai',secrets_printed:false};
  if(p.phase==='failed'&&p.error_code==='B_BINDING_CONFLICT')return siteBindingConflict(p,origin,now());
  if(p.phase==='failed'&&p.error_code==='B_REBIND_UNSUPPORTED')return siteTemplateUpdateRequired(origin);
  if(p.phase==='failed'){const error=err(/^[A-Z0-9_]{1,80}$/.test(p.error_code||'')?p.error_code:'SITE_PAIRING_FAILED'),mismatch=error.code==='B_PAIRING_BINDING'?safePairingMismatch(p.mismatch):null;if(mismatch)error.mismatch=mismatch;throw error;}
  await wait(1000);
 }
 return {phase:result.phase==='pairing'?'pairing':'credential_update_pending',origin,status:'SITE_PAIRING_PENDING',secrets_printed:false};
}
// A saved credential receipt is independent of whether the tunnel is online.
// Clipboard bytes stay inside this process and the authenticated loopback POST.
async function receiveClipboardKey(runtime,{id,read,clear,call}){
 let key='',original='',saved,clipboardCleared=false;
 try{
  key=read({capture:raw=>{original=raw;}});if(!validKey(key)||key===id)throw err('CLIPBOARD_NOT_A_KEY');
  saved=await call(runtime,'/api/setup/key',{tunnel_id:id,api_key:key});if(saved?.saved!==true||saved?.received!==true||saved?.storage_verified!==true)throw err('KEY_SAVE_UNCONFIRMED');
  try{clipboardCleared=clear(key,{expected:original||key})===true;}catch{clipboardCleared=false;}
 }finally{key='';original='';}
 const connected=saved.connected===true,configured=saved.configured===true;
 const phase=['idle','starting','connecting','reconnecting','running','ready','needs_login','needs_retry','offline','stopped'].includes(saved.phase)?saved.phase:'connecting';
 return {saved:true,received:true,storage_verified:true,clipboard_cleared:clipboardCleared,configured,connected,status:connected?'CONNECTED':'CONNECTION_PENDING',reason_code:connected?'KEY_SAVED':'KEY_SAVED_CONNECTION_PENDING',clipboard_reason_code:clipboardCleared?'CLIPBOARD_CLEARED':'CLIPBOARD_NOT_CLEARED',phase,...(saved.connection_error_code?{connection_error_code:safeCode(saved.connection_error_code,'CONNECTION_START_FAILED')}:{}),do_not_recreate_tunnel:true,secrets_printed:false};
}
async function runObserved(args,{locate=locateRuntime,call=callOwner,read=readKey,clear=clearKeyClipboard,clipboard=readClipboard,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),stdin=()=>readStdin(),executable=process.execPath,realpath=fs.realpathSync}={}){const command=args[0];if(command==='clipboard-check'){const n=args.indexOf('--tunnel-id');return clipboardCheck(n>=0?args[n+1]:null,{clipboard});}if(!['doctor','connect','site','site-start','bind-app','prepare-browser','test-start','test-status','switch','site-replace'].includes(command))throw err('USAGE_DOCTOR_CONNECT_SITE_PREPARE_BROWSER');if(command==='site'&&args.length!==1)throw err('SITE_LINE_STDIN_ONLY');const r=locate(),ownerState=await verifySetupOwner(r,{call,executable,realpath});if(command==='site-replace'){if(args.length!==2||args[1]!=='--grant-from-clipboard')throw err('ARG_INVALID');const state=await call(r,'/api/state'),pairing=state.site_b?.pairing;if(pairing?.replacement?.next_action==='resume_pairing'){const resumed=await call(r,'/api/site-b/pair',{});if(resumed?.paired!==true)throw err('SITE_REPLACEMENT_UNCONFIRMED');return {paired:true,replacement_accepted:true,resumed:true,clipboard_cleared:false,secrets_printed:false};}if(pairing?.error_code!=='B_BINDING_CONFLICT'||!pairing.question_id)throw err('B_REBIND_CONFLICT_REQUIRED');if(!Number.isSafeInteger(pairing.question_expires_at)||pairing.question_expires_at<=now())throw err('B_GRANT_EXPIRED');if(pairing.replacement?.next_action!=='authorize_replacement')throw err('B_REBIND_UNSUPPORTED');let grant='',original='',receipt,clipboard_cleared=false;try{original=clipboard();grant=original.trim();if(grant.length<32||grant.length>4096||!/^[-_A-Za-z0-9]+$/.test(grant))throw err('CLIPBOARD_NOT_A_GRANT');receipt=await call(r,'/api/site-b/replacement',{replacement_grant:grant});if(receipt?.paired!==true||receipt?.replacement_accepted!==true)throw err('SITE_REPLACEMENT_UNCONFIRMED');try{clipboard_cleared=clear(grant,{expected:original})===true;}catch{}}finally{grant='';original='';}return {paired:true,replacement_accepted:true,clipboard_cleared,secrets_printed:false};}if(command==='switch'){if(args.length!==3||args[1]!=='--route'||!['site','openai'].includes(args[2]))throw err('ARG_INVALID');return call(r,'/api/setup/switch',{route:args[2]});}if(command==='connect'&&args.includes('--key-from-clipboard')){const n=args.indexOf('--tunnel-id'),id=validatePublicID(n>=0?args[n+1]:null);return receiveClipboardKey(r,{id,read,clear,call});}const before=ownerState||await call(r,'/api/state');if(command==='doctor')return sanitized(before);if(command==='site')return site(r,{stdin,call,now,wait,before});if(command==='site-start'){if(args.length!==1)throw err('SITE_START_NO_ARGUMENTS');return call(r,'/api/setup/site/start',{});}if(command==='bind-app'){const body={};for(const [flag,key] of [['--application-id','application_id'],['--detail-url','detail_url'],['--app-name','app_name']]){const i=args.indexOf(flag);if(i>=0)body[key]=args[i+1];}return call(r,'/api/setup/chatgpt-app',body);}if(command==='test-status')return before.setup_test?.verified===true?call(r,'/api/setup/test/complete',{}):before.setup_test;if(command==='test-start'){const restart=args.length===2&&args[1]==='--restart';if(args.length!==1&&!restart)throw err('ARG_INVALID');if(!restart&&before.settings?.setup_complete===true&&before.setup_test?.verified===true&&before.settings?.chatgpt_app_retest_required!==true&&before.settings?.chatgpt_app_missing?.reason!=='refresh_not_found')return {...before.setup_test,preserved_existing_setup:true};const t=await call(r,'/api/setup/test/start',restart?{restart:true}:{});return {...t,prompt:`用 ${before.settings?.chatgpt_app_name||'ChatHand'} 做连接测试，暗号 ${t.nonce}。先调用 connection_check，再调用 setup_write_probe，两次都用这个暗号。`};}if(command==='prepare-browser'){const result=await call(r,'/api/browser/extension/prepare',{});return {registered:result.registered,extension_id:result.extension_id,extension_folder:result.extension_folder,store_url:result.store_url||null,user_confirmation_required:true};}if(!args.includes('--key-from-clipboard')&&(sanitized(before).connected||before.connection?.ready&&before.connection?.healthy||before.relay?.online))return {...sanitized(before),preserved_existing_connection:true,...(cloudDown(before)?{network_problem:'网络连不上 OpenAI 时先检查网络或代理；保留已有通道和凭据。'}:{})};const n=args.indexOf('--tunnel-id'),id=validatePublicID(n>=0?args[n+1]:null);if(!args.includes('--key-from-clipboard'))throw err('CLIPBOARD_SOURCE_REQUIRED');return receiveClipboardKey(r,{id,read,clear,call});}
// Canonical handoff uses the signed runtime's bundled node. Installed skill copies
// can therefore share the product writer without duplicating its privacy schema.
// System-node/locate failures remain explicitly unobservable, never block setup.
async function runtimeTelemetry(runtime){
 if(!runtime?.diagnosticStateDir)return null;
 try{
  const root=path.resolve(path.dirname(process.execPath),'..');
  const [{DiagnosticEvents},{OnboardingTelemetry}]=await Promise.all([
   import(pathToFileURL(path.join(root,'app/diagnostic-events.mjs')).href),
   import(pathToFileURL(path.join(root,'app/onboarding-telemetry.mjs')).href)]);
  return new OnboardingTelemetry(new DiagnosticEvents(runtime.diagnosticStateDir));
 }catch{return null;}
}
// A private per-process capability reports only that this helper began a command.
// It never carries arguments, clipboard content, or a client-supplied timestamp.
async function announceHelperSeen(runtime,fetcher=globalThis.fetch){
 if(!runtime||!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.ui_origin||'')||!/^\w{64}$/.test(runtime.admin_token||'')||!/^[a-f0-9]{64}$/.test(runtime.setup_helper_token||''))return;
 const controller=new AbortController();let timer;
 try{
  const request=Promise.resolve().then(async()=>{
   const response=await fetcher(runtime.ui_origin+'/api/setup/assistant-seen',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+runtime.admin_token,'X-ChatHand-Setup-Helper':runtime.setup_helper_token},body:'{}',redirect:'error',cache:'no-store',credentials:'omit',signal:controller.signal});
   if(!response?.ok||typeof response.json!=='function'){try{if(response?.body?.cancel)Promise.resolve(response.body.cancel()).catch(()=>{});}catch{}return 'zh';}
   const value=await response.json();return value?.locale==='en'?'en':'zh';
  });
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},1000);});
  return await Promise.race([request,deadline]);
 }catch{}finally{clearTimeout(timer);}
}
const helperCommands=new Set(['doctor','connect','site','site-start','bind-app','prepare-browser','test-start','test-status','switch','site-replace','clipboard-check','quit']);
export async function run(args,options={}){
 const command=args?.[0],observe=helperCommands.has(command)&&!(command==='quit'&&args.length!==1)&&!(command==='site'&&args.length!==1);
 let runtime,locateError,located=false;
 if(observe)try{runtime=(options.locate||locateRuntime)();located=true;}catch(error){locateError=error;}
 const note=located?announceHelperSeen(runtime,options.seenFetch||globalThis.fetch):Promise.resolve();
 // Quit stops the service, so give its observation a bounded chance first.
 if(command==='quit')await note;
 const nextOptions=located?{...options,locate:()=>runtime}:locateError&&command!=='clipboard-check'?{...options,locate:()=>{throw locateError;}}:options;
 try{return await runWithTelemetry(args,nextOptions);}catch(error){
 if(['B_REBIND_CONFLICT_REQUIRED','B_GRANT_EXPIRED','B_PAIRING_ATTEMPT_EXPIRED','B_BINDING_CHANGED'].includes(error?.code))return {configured:false,connected:false,error_code:error.code,next_action:'retry_pairing',fresh_answer_required:true,previous_answers_valid:false,message:{zh:'请重新配对，并原文展示新问题；本次必须重新回答，旧授权不能再用。',en:'Pair again and show the new question exactly. Ask for a fresh answer; discard the old authorization.'},secrets_printed:false};if(Object.hasOwn(siteNetworkMessages,error?.code))error.siteNetworkLocale=await note;throw error;
 }finally{await note;}
}
async function runWithTelemetry(args,options={}){
 if(args[0]==='quit'){if(args.length!==1)throw err('QUIT_NO_ARGUMENTS');return quitOwner((options.locate||locateRuntime)(),{...options.quitDependencies,call:options.call||callOwner});}
 const step={doctor:'setup_doctor',connect:'setup_connect',site:'setup_site'}[args[0]];
 if(!step)return runObserved(args,options);
 const runtime=(options.locate||locateRuntime)();
 const observer=options.telemetry||await runtimeTelemetry(runtime);
 const work=()=>runObserved(args,{...options,locate:()=>runtime});
 if(!observer)return work();
 return observer.run(step,work,{source:'setup_skill',classify:value=>value?.configured===false||value?.status==='SITE_PAIRING_PENDING'?{result:'pending',error_code:value?.status==='SITE_PAIRING_PENDING'?'PAIRING_PENDING':'HOST_UNCONFIRMED'}:{result:'ok',error_code:'NONE'}});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run(process.argv.slice(2)).then(r=>{console.log(JSON.stringify(r));if(r.saved!==true&&(r.configured===false||r.matches===false||r.status==='SITE_PAIRING_PENDING'))process.exitCode=2;}).catch(e=>{const code=safeCode(e?.code);console.error(JSON.stringify(process.argv[2]==='quit'?{status:'STOPPED',code,...(e?.quit_receipt?{quit:e.quit_receipt}:{}),secrets_printed:false}:{saved:false,received:false,storage_verified:false,clipboard_cleared:false,configured:false,connected:false,status:'STOPPED',code,reason_code:code,...(Object.hasOwn(siteNetworkMessages,code)?{message:siteNetworkMessages[code][e?.siteNetworkLocale==='en'?'en':'zh']} :{}),...(safePairingMismatch(e?.mismatch)?{mismatch:e.mismatch}:{}),secrets_printed:false}));process.exitCode=1;});
