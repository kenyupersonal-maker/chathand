import {BrowserDriver} from './driver.js';
import {text, setSystemLanguage, languageState} from './locale.js';

const driver=new BrowserDriver(chrome,{experience:true});
const uploadChunks=new Map();
const authorizations=new Map(),installAuthorizations=new Map(),installProbeSeen=new Set();
const RECONNECT_BASE_MS=250,RECONNECT_MAX_MS=8000;
// 1029：助手报自己的版本（manifest 带构建号）、会做的动作；ChatHand 版本对不上时发 reload，助手从文件夹重新读一遍。
const MANIFEST=(()=>{try{return chrome.runtime.getManifest?.()||{};}catch{return {};}})();
const HELPER_ACTIONS=['tabs','new','select','close','navigate','snapshot','screenshot','click','double_click','fill','select_value','press','scroll','scroll_to','wait_for','read','find','batch','back','forward','reload','upload','detach'];
const HELPER_FEATURES=['self_reload','click_receipt','find_boxes','page_lang','system_language_v1','upload_payload_v1'];
let lastReload=null;
const helperInfo=()=>({version:typeof MANIFEST.version==='string'?MANIFEST.version:null,version_name:typeof MANIFEST.version_name==='string'?MANIFEST.version_name:null,build:Number(String(MANIFEST.version||'').split('.')[3])||null,actions:HELPER_ACTIONS,features:HELPER_FEATURES,...(lastReload?{last_reload:lastReload}:{})});
const hello=()=>({kind:'hello',version:1,enabled:true,helper:helperInfo()});
// 两分钟里最多重新加载一次，防止来回重载；记下从哪一版换、为了换成哪一版，下次连上时报给 ChatHand。
async function reloadSelf(current,message){
 if(current!==port)return;
 try{const saved=(await chrome.storage.local.get('helper_reload')).helper_reload;if(saved&&Date.now()-Number(saved.at||0)<120000)return;
  await chrome.storage.local.set({helper_reload:{at:Date.now(),from:MANIFEST.version||null,to:typeof message.expected_version==='string'?message.expected_version.slice(0,32):null}});}
 catch{return;}
 chrome.runtime.reload();
}
let port=null,enabled=false,generation=0,queue=Promise.resolve(),reconnectTimer=null,reconnectAttempt=0,preferenceRevision=0,preferenceReadyRevision=-1,preferenceWriteFailedRevision=-1,preferenceWriteFailedValue=null,preferenceQueue=Promise.resolve(),loadSavedEnabledPromise=null,userStopMarker=null;
let lastConnectionError=null,hostReady=false;

const fault=code=>Object.assign(new Error(code),{code});
function clearReconnect(reset=true){if(reconnectTimer!==null){clearTimeout(reconnectTimer);reconnectTimer=null;}if(reset)reconnectAttempt=0;}
function clearUploadChunks(tabId){for(const [key,chunk] of uploadChunks)if(tabId===undefined||chunk.tabId===tabId){clearTimeout(chunk.timer);uploadChunks.delete(key);chunk.reject(fault('TASK_REVOKED'));}}
function clearAuthorizations(){clearUploadChunks();for(const a of authorizations.values()){clearTimeout(a.timer);a.resolve(false);}authorizations.clear();for(const a of installAuthorizations.values()){clearTimeout(a.timer);a.resolve(false);}installAuthorizations.clear();}
function scheduleReconnect(){
 if(!canConnect()||port||reconnectTimer!==null)return;
 const delay=Math.min(RECONNECT_MAX_MS,RECONNECT_BASE_MS*2**reconnectAttempt++);
 reconnectTimer=setTimeout(()=>{reconnectTimer=null;if(canConnect()&&!port)connect();},delay);
}
function portLost(current){
 if(port!==current)return;
 port=null;hostReady=false;lastConnectionError='NATIVE_HOST_DISCONNECTED';generation++;clearAuthorizations();void driver.detachAll();void chrome.action.setBadgeText({text:text('chrome.offlineBadge')});scheduleReconnect();
}
function safePost(current,message){if(current!==port)return false;try{current.postMessage(message);return true;}catch{portLost(current);return false;}}
async function disconnect(){
 generation++;clearReconnect();
 clearAuthorizations();
 const old=port;port=null;hostReady=false;
 await driver.detachAll();try{old?.disconnect();}catch{}
 await chrome.action.setBadgeText({text:enabled?'':text('chrome.disabledBadge')});
}
function connect(){
 if(!canConnect()||port)return;
 let current;
 try{current=chrome.runtime.connectNative('com.kenyu.chathand.browser');}catch{lastConnectionError='NATIVE_HOST_UNAVAILABLE';scheduleReconnect();return;}
 port=current;chrome.action.setBadgeText({text:'…'});
 current.onDisconnect.addListener(()=>{void chrome.runtime.lastError;portLost(current);});
 if(!safePost(current,hello()))return;
 current.onMessage.addListener(message=>{
  if(current!==port)return;
  if(message.control==='pause'){generation++;clearAuthorizations();void driver.detachAll();return;}
  if(message.control==='reconnect'){void disconnect().then(()=>connect());return;}
  if(message.control==='reload'){void reloadSelf(current,message);return;}
  if(message.kind==='upload_chunk'){const chunk=uploadChunks.get(message.chunk_id);if(chunk&&chunk.current===current&&chunk.id===message.id){clearTimeout(chunk.timer);uploadChunks.delete(message.chunk_id);if(message.error)chunk.reject(fault(['TASK_REVOKED','TASK_EXPIRED','ACTION_CANCELLED','UPLOAD_CHUNK_INVALID','UPLOAD_FILE_CHANGED'].includes(message.error.code)?message.error.code:'UPLOAD_CHUNK_INVALID'));else chunk.resolve(message);}return;}
  if(message.kind==='authorization'){const a=authorizations.get(message.id);if(a){clearTimeout(a.timer);authorizations.delete(message.id);a.resolve(message.allowed===true);}return;}
  if(message.kind==='install_authorization'){const a=installAuthorizations.get(message.id);if(a){clearTimeout(a.timer);installAuthorizations.delete(message.id);a.resolve(message.allowed===true);}return;}
  if(message.kind==='system_language'){if(setSystemLanguage(message))void chrome.action.setBadgeText({text:!enabled?text('chrome.disabledBadge'):hostReady?'':text('chrome.offlineBadge')});return;}
  if(message.kind==='status'){hostReady=message.ready===true;lastConnectionError=hostReady?null:(message.code||'CHATHAND_OFFLINE');if(message.ready)reconnectAttempt=0;void chrome.action.setBadgeText({text:message.ready?'':text('chrome.offlineBadge')});return;}
  if(message.kind==='install_probe'){void runInstallProbe(current,message,generation);return;}
  if(message.kind!=='request'||typeof message.id!=='string'||!message.args||Date.now()>message.deadline)return;
  const epoch=generation;
  const run=async()=>{
   if(!enabled||current!==port||epoch!==generation||Date.now()>message.deadline)return;
   try{
    const authorize=()=>new Promise(resolve=>{const timer=setTimeout(()=>{authorizations.delete(message.id);resolve(false);},4500);authorizations.set(message.id,{resolve,timer});if(!safePost(current,{kind:'authorize',id:message.id})){clearTimeout(timer);authorizations.delete(message.id);resolve(false);}});
    const authorized=await authorize();
    if(!authorized||!enabled||current!==port||epoch!==generation||Date.now()>message.deadline)throw fault('TASK_REVOKED');
    const remaining=Number(message.deadline)-Date.now();if(!Number.isFinite(remaining)||remaining<=0)throw fault('TASK_EXPIRED');
    const authorizeStep=async()=>{if(!enabled||current!==port||epoch!==generation||Date.now()>message.deadline)throw fault('TASK_REVOKED');if(!await authorize())throw fault('TASK_REVOKED');if(!enabled||current!==port||epoch!==generation||Date.now()>message.deadline)throw fault('TASK_REVOKED');};
    let active=true;
    const readUploadChunk=async(index,offset)=>{await authorizeStep();if(!active||message.action!=='upload'||!Number.isSafeInteger(index)||index<0||index>=message.args.files?.length||!Number.isSafeInteger(offset)||offset<0)throw fault('UPLOAD_CHUNK_INVALID');return new Promise((resolve,reject)=>{const chunk_id=crypto.randomUUID(),timer=setTimeout(()=>{uploadChunks.delete(chunk_id);reject(fault('TASK_EXPIRED'));},Math.min(4500,Math.max(0,message.deadline-Date.now())));uploadChunks.set(chunk_id,{id:message.id,tabId:Number(message.args.page_id),current,resolve,reject,timer});if(!safePost(current,{kind:'upload_chunk',id:message.id,chunk_id,index,offset})){clearTimeout(timer);uploadChunks.delete(chunk_id);reject(fault('TASK_REVOKED'));}});};
    let timer;const pending=(async()=>{const result=await driver.execute(message.action,message.args,{authorize:authorizeStep,chatgptSelfAllowed:message.options?.chatgptSelfAllowed===true,...(message.action==='upload'?{readUploadChunk}:{})});return result;})();const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('TASK_EXPIRED')),remaining);});
    let result;try{result=await Promise.race([pending,timeout]);}catch(error){if(error.code==='TASK_EXPIRED'){driver.cancel();void driver.detachAll();}throw error;}finally{active=false;clearTimeout(timer);for(const [key,chunk] of uploadChunks)if(chunk.id===message.id){clearTimeout(chunk.timer);uploadChunks.delete(key);chunk.reject(fault('TASK_REVOKED'));}}
    if(epoch===generation&&current===port)safePost(current,{kind:'result',id:message.id,result});
   }catch(e){safePost(current,{kind:'result',id:message.id,error:{code:String(e.code||'BROWSER_ACTION_FAILED').slice(0,80),message:message.action==='upload'?String(e.code||'BROWSER_ACTION_FAILED').slice(0,80):String(e.message||text('chrome.actionStopped')).slice(0,800),details:message.action==='upload'?undefined:e.details}});}
  };
  queue=queue.then(run,run).catch(()=>{});
 });
}

function installProbeValid(current,epoch,deadline){return enabled&&current===port&&epoch===generation&&Number.isFinite(deadline)&&Date.now()<deadline;}
function installProbeError(current,id,epoch,deadline,code){if(installProbeValid(current,epoch,deadline))safePost(current,{kind:'install_result',id,error:code});}
function askInstallAuthorization(current,id,deadline){return new Promise(resolve=>{const timer=setTimeout(()=>{installAuthorizations.delete(id);resolve(false);},Math.min(4500,Math.max(0,deadline-Date.now())));installAuthorizations.set(id,{resolve,timer});if(!safePost(current,{kind:'install_authorize',id})){clearTimeout(timer);installAuthorizations.delete(id);resolve(false);}});}
async function runInstallProbe(current,message,epoch){
 const id=typeof message.id==='string'?message.id:'';const deadline=message.deadline;const url=typeof message.url==='string'?message.url:'';
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+120000||!url||url.length>2048||installProbeSeen.has(id))return;
 let parsed;try{parsed=new URL(url);}catch{return;}const portNumber=Number(parsed.port);if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||!Number.isInteger(portNumber)||portNumber<1||portNumber>65535||parsed.username||parsed.password||parsed.search||parsed.hash||url.includes('?')||url.includes('#')||!/^\/api\/browser\/extension\/install\/probe\/[a-f0-9]{64}$/.test(parsed.pathname))return;
 installProbeSeen.add(id);if(installProbeSeen.size>128)installProbeSeen.delete(installProbeSeen.values().next().value);
 if(!installProbeValid(current,epoch,deadline))return;
 let allowed=false;try{allowed=await askInstallAuthorization(current,id,deadline);}catch{}
 if(!installProbeValid(current,epoch,deadline))return;
 if(!allowed){installProbeError(current,id,epoch,deadline,'INSTALL_AUTHORIZATION_DENIED');return;}
 let tabs;try{tabs=await chrome.tabs.query({});}catch{installProbeError(current,id,epoch,deadline,'INSTALL_TAB_QUERY_FAILED');return;}
 if(!installProbeValid(current,epoch,deadline)||!allowed)return;
 const matches=Array.isArray(tabs)?tabs.filter(tab=>tab&&tab.url===url):[];
 let result=null,error=null;
 if(matches.some(tab=>tab.incognito!==false))error='INSTALL_TAB_INCOGNITO';
 else if(matches.length===0)error='INSTALL_TAB_NOT_FOUND';
 else if(matches.length!==1)error='INSTALL_TAB_NOT_UNIQUE';
 else {const tab=matches[0];if(typeof tab.title!=='string'||tab.title.length>512||!Number.isSafeInteger(tab.id)||tab.id<0||!Number.isSafeInteger(tab.windowId)||tab.windowId<0)error='INSTALL_TAB_INVALID';else result={title:tab.title,tab_id:tab.id,window_id:tab.windowId};}
 if(!installProbeValid(current,epoch,deadline)||!allowed)return;
 safePost(current,error?{kind:'install_result',id,error}:{kind:'install_result',id,result});
}

function enqueuePreference(operation){const run=preferenceQueue.then(operation,operation);preferenceQueue=run.catch(()=>{});return run;}
function preferenceError(){return preferenceWriteFailedRevision===preferenceRevision?'PREFERENCE_SAVE_FAILED':null;}
function preferenceReady(){return preferenceReadyRevision===preferenceRevision&&preferenceError()===null;}
function canConnect(){return enabled&&preferenceReady();}
function loadSavedEnabled(){if(loadSavedEnabledPromise)return loadSavedEnabledPromise;const revision=preferenceRevision;const run=enqueuePreference(async()=>{const s=await chrome.storage.local.get(['enabled','helper_reload']);const rr=s?.helper_reload;lastReload=rr&&Number.isFinite(Number(rr.at))?{at:Number(rr.at),from:typeof rr.from==='string'?rr.from.slice(0,32):null,to:typeof rr.to==='string'?rr.to.slice(0,32):null}:null;if(revision!==preferenceRevision||preferenceWriteFailedRevision===revision)return;if(Object.hasOwn(s,'enabled'))enabled=s.enabled===true;else{enabled=true;try{await chrome.storage.local.set({enabled:true});}catch(error){if(revision===preferenceRevision){preferenceWriteFailedRevision=revision;preferenceWriteFailedValue=true;enabled=false;preferenceReadyRevision=-1;}throw error;}}if(revision===preferenceRevision){preferenceReadyRevision=revision;connect();}});const promise=run.finally(()=>{if(loadSavedEnabledPromise===promise)loadSavedEnabledPromise=null;});loadSavedEnabledPromise=promise;return promise;}
async function setUserEnabled(next){const revision=++preferenceRevision;preferenceReadyRevision=-1;preferenceWriteFailedRevision=-1;preferenceWriteFailedValue=null;enabled=next;if(next)clearReconnect();let stopped=null,stopMarker=null;if(!next){stopMarker={};userStopMarker=stopMarker;stopped=disconnect(false);}try{await enqueuePreference(async()=>{if(stopped)await stopped;await chrome.storage.local.set({enabled:next});});}catch(error){if(revision===preferenceRevision){preferenceWriteFailedRevision=revision;preferenceWriteFailedValue=next;enabled=next;preferenceReadyRevision=-1;clearReconnect();}throw error;}finally{if(stopMarker&&userStopMarker===stopMarker)userStopMarker=null;}if(revision===preferenceRevision){preferenceReadyRevision=revision;if(next)connect();}return {enabled:next};}
chrome.runtime.onInstalled.addListener(()=>{void loadSavedEnabled().catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>{void loadSavedEnabled().catch(()=>{});});
chrome.alarms.create('ken-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='ken-reconnect'&&canConnect()&&!port&&!reconnectTimer)connect();});
chrome.tabs.onRemoved.addListener(id=>{clearUploadChunks(id);driver.attached.delete(id);driver.invalidate(id);});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url||change.status==='loading'){clearUploadChunks(id);driver.invalidate(id);}});
chrome.debugger.onDetach.addListener((source,reason)=>{clearUploadChunks(source.tabId);driver.attached.delete(source.tabId);driver.invalidate(source.tabId);driver.noteDetached?.(source.tabId);if(reason==='canceled_by_user'&&!userStopMarker)void setUserEnabled(false).catch(()=>{});});
chrome.debugger.onEvent?.addListener((source,method,params)=>{void driver.onEvent?.(source,method,params).catch(()=>{});});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('popup.html')))return false;if(m.action==='status'){reply({language:languageState(),enabled,connected:!!port&&hostReady,connection_state:!enabled?'disabled':port&&hostReady?'connected':'disconnected',connection_error:lastConnectionError,preference_revision:preferenceRevision,preference_ready:preferenceReady(),preference_error:preferenceError(),preference_error_enabled:preferenceError()?preferenceWriteFailedValue:null});return false;}if(m.action==='reconnect'){void disconnect().then(()=>{connect();reply({reconnecting:canConnect()});});return true;}if(m.action==='enable'||m.action==='disable'){const next=m.action==='enable';void setUserEnabled(next).then(result=>reply(result),()=>reply({enabled:next,error:'PREFERENCE_SAVE_FAILED'}));return true;}return false;});
void loadSavedEnabled().catch(()=>{});
