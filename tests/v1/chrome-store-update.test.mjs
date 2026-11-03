import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {ChromeExtensionUpdate,cleanStoreUpdate,storeUpdateControlAllowed} from '../../app/v1/chrome-extension-update.mjs';
import {chromeStoreStatus} from '../../app/v1/chrome-store-status.mjs';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {cleanHelper,storeHostMessageAllowed,storeUpdateAuthorizeReply} from '../../app/v09/extension-host.mjs';
import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';
const distribution=storeTestDistribution(),session=crypto.randomUUID(),from='1.0.0.1090',target='1.0.0.1092';
const helper=(extra={})=>({...storeTestHelper(),version:from,features:[...storeTestHelper().features,'store_update_v1'],...extra});
const report=(id,state,extra={})=>({id,state,sequence:1,from_version:from,target_version:null,...extra});
function coordinator(){
 let now=1000,allowed=true,busy=false,authority='grant-1',changes=0;const timers=new Map();
 const current={store:true,connected:true,session,helper:helper()};
 const flow=new ChromeExtensionUpdate({current:()=>current,allowed:()=>allowed,busy:()=>busy,authority:()=>authority,changed:()=>changes++,now:()=>now,setTimer(fn,ms){const id={};timers.set(id,{fn,at:now+ms});return id;},clearTimer:id=>timers.delete(id)});
 return {flow,current,timers,get changes(){return changes;},set allowed(v){allowed=v;},set busy(v){busy=v;},set authority(v){authority=v;},advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}},observe(state,extra={}){flow.observe(session,helper({update:report(flow.value.id,state,extra)}));}};
}
function browser(t){
 const state={data:{browser_enabled:true,mode:'auto'},project:()=>({path:'/synthetic'}),save(){}},events=[];
 const policy={epoch:'grant',permissionRevision:0,check(){},require(){},emit:(...args)=>events.push(args),tasks:new Map()};
 const ext=new ExtensionBrowser(state,{},policy,{distribution});ext.updateAllowed=()=>state.data.browser_enabled===true;ext.updateBusy=()=>false;t.after(()=>ext.closeAll());return {ext,state,policy,events};
}
const event=()=>{const listeners=[];return {addListener(fn){listeners.push(fn);},fire(...args){for(const fn of listeners)fn(...args);}};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(r=>setImmediate(r));};
const bgSource=fs.readFileSync(new URL('../../browser-extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
async function background({check,execute=async()=>({ok:true}),onPost}={}){
 const timers=new Map(),ports=[];let reloads=0,checks=0;
 const chrome={runtime:{id:'fixture',lastError:null,getManifest:()=>({version:from}),getURL:n=>'chrome-extension://fixture/'+n,onInstalled:event(),onStartup:event(),onMessage:event(),onUpdateAvailable:event(),reload(){reloads++;},requestUpdateCheck(callback){checks++;return check?.(callback);},connectNative(){const port={posted:[],onMessage:event(),onDisconnect:event(),postMessage(m){this.posted.push(m);queueMicrotask(()=>onPost?.(m,port));},disconnect(){}};ports.push(port);return port;}},storage:{local:{get:async()=>({enabled:true}),set:async()=>{}}},action:{setBadgeText:async()=>{}},alarms:{create(){},onAlarm:event()},tabs:{onRemoved:event(),onUpdated:event()},debugger:{onDetach:event()}};
 class Driver{constructor(){this.attached=new Set();}async detachAll(){}cancel(){}invalidate(){}execute(...args){return execute(...args);}}
 vm.runInNewContext(bgSource,{chrome,BrowserDriver:Driver,text:k=>k,setSystemLanguage:()=>false,languageState:()=>({}),Date,Promise,crypto,URL,setTimeout(fn,ms){const id={};timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
 await flush();return {chrome,ports,timers,get reloads(){return reloads;},get checks(){return checks;},get port(){return ports.at(-1);},get metadata(){return ports.at(-1).posted.filter(m=>m.kind==='hello').at(-1).helper;},check(id=crypto.randomUUID()){const message={control:'store_update',operation:'check',session,id,from_version:from,target_version:null,deadline:Date.now()+30000};this.port.onMessage.fire(message);return message;},apply(check){this.port.onMessage.fire({...check,operation:'apply',target_version:target});},async stop(){chrome.runtime.onMessage.fire({action:'disable'},{id:'fixture',url:chrome.runtime.getURL('popup.html')},()=>{});await flush();}};
}

test('current installation requires a fresh same-session helper; history survives stale/removed extension',()=>{
 const observation={extension_id:distribution.extension_id,last_seen:100};
 const base={session,lastSeen:100,helper:helper({session,seen_at:100}),observation,now:101};
 const live=chromeStoreStatus(distribution,base);assert.equal(live.installed,true);assert.equal(live.connected,true);
 for(const change of [{now:7100},{session:crypto.randomUUID()},{helper:null},{helper:helper({session,seen_at:1}),now:7100},{now:99}]){
  const stale=chromeStoreStatus(distribution,{...base,...change});assert.equal(stale.connected,false);assert.equal(stale.installed,null);assert.equal(stale.installation_previously_observed,true);assert.equal(stale.compatibility.state,'unknown');
 }
});

test('idle connection expiry emits a UI change even with no active task or pending action',async t=>{
 const {ext,events}=browser(t);let changed=0;ext.onChange=()=>changed++;ext.next(session,helper());assert.equal(ext.status().helper.version,from);assert.equal(changed,1);
 ext.lastSeen=Date.now()-7001;ext.connectionLost();assert.equal(changed,2);assert.equal(events.length,0);assert.equal(ext.status().installed,null);assert.equal(ext.status().helper.version,null);assert.equal(ext.status().helper.version_name,null);assert.equal(ext.status().installation_previously_observed,true);
});

test('reconnect refuses busy work without cancelling or changing the session',async t=>{
 const {ext}=browser(t);ext.next(session,helper());const pending=ext.request('snapshot',{},'caller','task');pending.catch(()=>{});const id=[...ext.pending.keys()][0];
 assert.throws(()=>ext.reconnect(),{code:'BROWSER_BUSY'});assert.equal(ext.session,session);assert.ok(ext.pending.has(id));ext.cancelAll();await assert.rejects(pending,{code:'TASK_REVOKED'});
 ext.updateBusy=()=>true;assert.throws(()=>ext.reconnect(),{code:'BROWSER_BUSY'});assert.equal(ext.session,session);
});

test('old helper/disconnected update checks return explicit states and never send invalid controls',()=>{
 for(const state of ['old','disconnected','legacy']){
  const c=coordinator();if(state==='old')c.current.helper=storeTestHelper();if(state==='disconnected')c.current.connected=false;if(state==='legacy')c.current.store=false;
  assert.equal(c.flow.start().state,state==='disconnected'?'disconnected':'unsupported');assert.equal(c.flow.next(session),null);assert.equal(c.timers.size,0);
 }
});

test('check result no_update/throttled/failed is terminal, truthful and never loops',()=>{
 for(const state of ['no_update','throttled','failed']){const c=coordinator();const check=c.flow.start();assert.equal(check.state,'checking');assert.equal(c.flow.next(session).operation,'check');assert.equal(c.flow.next(session),null);c.observe(state);assert.equal(c.flow.status().state,state);assert.equal(c.flow.next(session),null);assert.equal(c.timers.size,0);c.flow.observe(session,helper({update:report(check.id,'update_available',{sequence:2,target_version:target})}));assert.equal(c.flow.status().state,state);}
});

test('check timeout and late/wrong-session/wrong-ID/version reports cannot complete a newer check',()=>{
 const c=coordinator();c.flow.start();const original=c.flow.status();
 c.flow.observe(crypto.randomUUID(),helper({update:report(original.id,'no_update')}));c.observe('no_update',{id:crypto.randomUUID()});c.observe('update_available',{target_version:'invalid'});assert.equal(c.flow.status().state,'checking');
 c.advance(30000);assert.equal(c.flow.status().code,'UPDATE_CHECK_TIMEOUT');c.flow.start();const current=c.flow.status();assert.notEqual(current.id,original.id);c.flow.observe(session,helper({update:report(original.id,'update_available',{sequence:2,target_version:target})}));assert.equal(c.flow.status().id,current.id);assert.equal(c.flow.status().state,'checking');c.flow.close();
});

test('available update waits for the task and local browser queues, rechecks authority immediately before reload',()=>{
 const c=coordinator();c.flow.start();c.observe('update_available',{target_version:target});c.busy=true;assert.equal(c.flow.next(session),null);assert.equal(c.flow.status().state,'waiting_idle');
 c.busy=false;const apply=c.flow.next(session);assert.equal(apply.operation,'apply');assert.equal(c.flow.status().state,'applying');
 c.busy=true;assert.equal(c.flow.authorize(session,apply).code,'BROWSER_BUSY');assert.equal(c.flow.status().state,'waiting_idle');c.busy=false;c.advance(1000);const second=c.flow.next(session);assert.equal(c.flow.authorize(crypto.randomUUID(),second).authorized,false);assert.equal(c.flow.authorize(session,{...second,target_version:from}).authorized,false);assert.equal(c.flow.authorize(session,second).authorized,true);
 c.authority='grant-2';assert.equal(c.flow.authorize(session,second).code,'ACCESS_CHANGED');assert.equal(c.flow.status().state,'failed');
});

test('updated requires a different session running the exact target version; apply timeout is bounded',()=>{
 const c=coordinator();c.flow.start();c.observe('update_available',{target_version:target});c.flow.next(session);c.flow.observe(session,helper({version:target}));assert.equal(c.flow.status().state,'applying');c.flow.observe(crypto.randomUUID(),helper({version:'1.0.0.1091'}));assert.equal(c.flow.status().state,'applying');c.flow.observe(crypto.randomUUID(),helper({version:target}));assert.equal(c.flow.status().state,'updated');assert.equal(c.timers.size,0);
 const timed=coordinator();timed.flow.start();timed.observe('update_available',{target_version:target});timed.flow.next(session);timed.advance(30000);assert.equal(timed.flow.status().code,'UPDATE_APPLY_TIMEOUT');timed.flow.observe(crypto.randomUUID(),helper({version:target}));assert.equal(timed.flow.status().state,'failed');
});

test('spontaneous available report waits for idle once and duplicate reports cannot force reload loops',()=>{
 const c=coordinator(),id=crypto.randomUUID(),metadata=helper({update:report(id,'update_available',{target_version:target})});c.busy=true;c.flow.observe(session,metadata);assert.equal(c.flow.status().state,'waiting_idle');assert.equal(c.flow.next(session),null);c.busy=false;const apply=c.flow.next(session);c.flow.observe(session,metadata);assert.equal(c.flow.status().state,'applying');c.flow.observe(crypto.randomUUID(),helper({version:target}));assert.equal(c.flow.status().state,'updated');c.flow.observe(session,metadata);assert.equal(c.flow.status().state,'updated');assert.equal(c.flow.authorize(session,apply).authorized,false);
});

test('native host sanitizes update reports and preserves all retired reload/probe gates',async()=>{
 const id=crypto.randomUUID(),control={control:'store_update',operation:'apply',id,session,from_version:from,target_version:target,deadline:Date.now()+30000};
 assert.equal(storeHostMessageAllowed({control:'reload'}),false);assert.equal(storeHostMessageAllowed({kind:'install_probe'}),false);assert.equal(storeHostMessageAllowed(control),true);
 for(const change of [{id:'bad'},{session:'bad'},{operation:'reload'},{target_version:from},{from_version:'bad'},{deadline:0}])assert.equal(storeHostMessageAllowed({...control,...change}),false);
 const clean=cleanHelper(helper({update:{...report(id,'no_update'),untrusted:'dropped'}}));assert.equal(clean.update.state,'no_update');assert.equal(clean.update.untrusted,undefined);assert.equal(cleanStoreUpdate({...report(id,'failed'),sequence:-1}),null);
 let requests=0;const request=async(route,body)=>{requests++;assert.equal(route,'/api/extension/update-authorize');assert.equal(body.id,id);return {authorized:true};};const message={...control,kind:'store_update_authorize'};
 assert.equal(await storeUpdateAuthorizeReply({...message,session:crypto.randomUUID()},session,request),null);assert.equal(requests,0);assert.equal((await storeUpdateAuthorizeReply(message,session,request)).allowed,true);assert.equal(requests,1);
});

for(const mode of ['no_update','throttled','exception','last_error','promise'])test('real background reports requestUpdateCheck '+mode,async()=>{
 const bg=await background({check:callback=>{if(mode==='exception')throw Error('failed');if(mode==='promise')return Promise.resolve({status:'no_update'});if(mode==='last_error'){bg.chrome.runtime.lastError={message:'failed'};callback('no_update');return;}callback(mode);}});
 try{bg.check();await flush();assert.equal(bg.checks,1);assert.equal(bg.metadata.features.includes('store_update_v1'),true);assert.equal(bg.metadata.update.state,['exception','last_error'].includes(mode)?'failed':mode==='promise'?'no_update':mode);assert.equal(bg.reloads,0);assert.equal(bg.timers.size,0);}finally{await bg.stop();}
});

test('real background check timeout ignores late callbacks and malformed control',async()=>{
 let callback;const bg=await background({check:cb=>{callback=cb;}});try{
 const check=bg.check();await flush();const timer=[...bg.timers.values()].find(t=>t.ms>29000);assert.ok(timer);timer.fn();await flush();assert.equal(bg.metadata.update.code,'UPDATE_CHECK_TIMEOUT');callback('update_available',{version:target});await flush();assert.equal(bg.metadata.update.state,'failed');bg.port.onMessage.fire({...check,id:'bad'});await flush();assert.equal(bg.checks,1);
 }finally{await bg.stop();}
});

test('real background ignores wrong-session authorization and pauses safely before a delayed authorization lands',async()=>{
 const bg=await background({check:cb=>cb('update_available',{version:target})});try{const check=bg.check();await flush();bg.apply(check);await flush();assert.ok(bg.port.posted.find(m=>m.kind==='store_update_authorize'));bg.port.onMessage.fire({kind:'store_update_authorization',id:check.id,session:crypto.randomUUID(),allowed:true});await flush();assert.equal(bg.reloads,0);bg.port.onMessage.fire({control:'pause'});bg.port.onMessage.fire({kind:'store_update_authorization',id:check.id,session,allowed:true});await flush();assert.equal(bg.reloads,0);}finally{await bg.stop();}
});

test('real background event and backend perform idle-only update; target helper reconnect is the sole success receipt',async t=>{
 const {ext}=browser(t);let busy=true;ext.updateBusy=()=>busy;const bg=await background({onPost:(m,p)=>{if(m.kind==='store_update_authorize'){const result=ext.authorizeUpdate(session,m);p.onMessage.fire({kind:'store_update_authorization',id:m.id,session,allowed:result.authorized});}}});t.after(()=>bg.stop());
 const pump=()=>{const result=ext.next(session,cleanHelper(bg.metadata));bg.port.onMessage.fire(result);return result;};pump();bg.chrome.runtime.onUpdateAvailable.fire({version:target});await flush();pump();assert.equal(ext.status().update.state,'waiting_idle');assert.equal(bg.reloads,0);busy=false;assert.equal(pump().operation,'apply');await flush();assert.equal(bg.reloads,1);assert.equal(ext.status().update.state,'applying');assert.throws(()=>ext.request('snapshot',{},'caller','task'),{code:'BROWSER_BUSY'});
 ext.next(crypto.randomUUID(),helper({version:target}));assert.equal(ext.status().update.state,'updated');assert.equal(ext.status().helper.version,target);// no further control is necessary to complete the update
});

test('real background local action queue blocks reload until its action has completed',async()=>{
 let finish;const bg=await background({check:cb=>cb('update_available',{version:target}),execute:()=>new Promise(resolve=>{finish=resolve;}),onPost:(m,p)=>{if(m.kind==='authorize')p.onMessage.fire({kind:'authorization',id:m.id,allowed:true});}});
 try{const check=bg.check();await flush();bg.port.onMessage.fire({kind:'request',id:'queued-action',action:'snapshot',args:{},deadline:Date.now()+10000});await flush();assert.equal(typeof finish,'function');bg.apply(check);await flush();assert.equal(bg.metadata.update.state,'waiting_idle');assert.equal(bg.port.posted.some(m=>m.kind==='store_update_authorize'),false);assert.equal(bg.reloads,0);finish({ok:true});await flush();bg.apply(check);await flush();assert.ok(bg.port.posted.some(m=>m.kind==='store_update_authorize'));}finally{await bg.stop();}
});

test('the actual seven-second heartbeat deadline notifies an idle window without another request', async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});const {ext}=browser(t);let changes=0;ext.onChange=()=>changes++;ext.next(session,helper());assert.equal(ext.status().connected,true);t.mock.timers.tick(7001);assert.equal(ext.status().connected,false);assert.equal(ext.status().installed,null);assert.equal(changes,2);
});

test('Chrome throttling enforces a cooldown without automatic retries',()=>{const c=coordinator();c.flow.start();c.observe('throttled');const id=c.flow.value.id;assert.equal(c.flow.value.retry_at,61000);assert.equal(c.flow.start().id,id);assert.equal(c.flow.next(session),null);c.advance(60000);assert.equal(c.flow.status().state,'throttled');assert.notEqual(c.flow.start().id,id);c.flow.close();});

test('busy waiting has a fixed upper bound and authorization failures never extend it',()=>{const c=coordinator();c.flow.start();c.observe('update_available',{target_version:target});c.busy=true;c.advance(300000);assert.equal(c.flow.status().state,'failed');assert.equal(c.flow.status().code,'UPDATE_WAIT_TIMEOUT');assert.equal(c.flow.next(session),null);});

test('real background apply authorization failures end the attempt instead of polling reload repeatedly',async()=>{const bg=await background({check:cb=>cb('update_available',{version:target}),onPost:(m,p)=>{if(m.kind==='store_update_authorize')p.onMessage.fire({kind:'store_update_authorization',id:m.id,session,allowed:false,code:'ACCESS_CHANGED'});}});try{const check=bg.check();await flush();bg.apply(check);await flush();assert.equal(bg.metadata.update.state,'failed');assert.equal(bg.metadata.update.code,'ACCESS_CHANGED');assert.equal(bg.reloads,0);}finally{await bg.stop();}});

for(const terminal of ['failed','unsupported','throttled','no_update'])test('a fresh usable newer helper clears '+terminal+' to idle without claiming updated',async t=>{
 const {ext}=browser(t);const oldSession=crypto.randomUUID();ext.next(oldSession,terminal==='unsupported'?{...helper(),features:storeTestHelper().features}:helper());
 const started=ext.checkUpdate();assert.equal(ext.updateFlow.session,oldSession);
 if(terminal!=='unsupported')ext.updateFlow.finish(terminal);
 const oldValue=ext.status().update;
 // Repeating the original session, even with a different reported version, cannot clear the failure.
 ext.next(oldSession,helper({version:target}));assert.equal(ext.status().update.state,terminal);
 // A new session at the same version is insufficient.
 ext.lastSeen=Date.now()-7001;ext.next(crypto.randomUUID(),helper());assert.equal(ext.status().update.state,terminal);
 // Advancing version without usable required capabilities is also insufficient.
 ext.lastSeen=Date.now()-7001;ext.next(crypto.randomUUID(),helper({version:target,actions:[]}));assert.equal(ext.status().update.state,terminal);
 // A genuine new connection at a higher usable version replaces the stale result with idle.
 ext.lastSeen=Date.now()-7001;ext.next(crypto.randomUUID(),helper({version:target}));const current=ext.status().update;
 assert.equal(current.state,'idle');assert.equal(current.from_version,target);assert.equal(current.target_version,null);assert.equal(current.code,null);assert.equal(current.id,undefined);assert.notEqual(current.state,'updated');assert.equal(ext.status().helper.version,target);
});

test('a new installation clears an offline check to idle on its first fresh usable connection',async t=>{
 const {ext}=browser(t);assert.equal(ext.checkUpdate().update.state,'disconnected');assert.equal(ext.status().update.from_version,null);ext.next(crypto.randomUUID(),helper({version:target,actions:[]}));assert.equal(ext.status().update.state,'disconnected');ext.lastSeen=Date.now()-7001;ext.next(crypto.randomUUID(),helper({version:target}));assert.equal(ext.status().update.state,'idle');assert.equal(ext.status().update.code,null);
});

test('disconnected recovery accepts a new usable session at the same version and never claims updated',async t=>{const {ext}=browser(t);const original=crypto.randomUUID();ext.next(original,helper());ext.checkUpdate();ext.updateFlow.disconnected();ext.next(original,helper());assert.equal(ext.status().update.state,'disconnected');ext.lastSeen=Date.now()-7001;ext.next(crypto.randomUUID(),helper());assert.equal(ext.status().update.state,'idle');assert.equal(ext.status().update.from_version,from);});
