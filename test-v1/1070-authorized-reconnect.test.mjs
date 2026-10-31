import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import {registerBrowserHost} from '../app/v09/local-setup.mjs';
import {fixture as serverFixture,deferred,waitFor} from './1070-chrome-server-fixture.mjs';
const fixture=(t,options={})=>serverFixture(t,{chromeDistribution:storeTestDistribution(),seedChromeProfiles:options.optedIn===true,...options});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await new Promise(r=>setImmediate(r));};
const event=()=>{const listeners=[];return {addListener:fn=>listeners.push(fn),fire:(...args)=>listeners.forEach(fn=>fn(...args))};};
async function background({enabled=true,available=()=>true}={}){
 const timers=new Map(),ports=[],saved={enabled};let attempts=0;
 class Driver{constructor(){this.attached=new Set();}async detachAll(){}invalidate(){}}
 const chrome={runtime:{id:'fixture',getURL:n=>'chrome-extension://fixture/'+n,getManifest:()=>({version:'1.0.0.1070'}),onInstalled:event(),onStartup:event(),onMessage:event(),connectNative(name){assert.equal(name,'com.kenyu.chathand.browser');attempts++;if(!available())throw Error('HOST_UNAVAILABLE');const p={onDisconnect:event(),onMessage:event(),posted:[],postMessage(m){this.posted.push(m);},disconnect(){}};ports.push(p);return p;}},storage:{local:{async get(){return saved;},async set(v){Object.assign(saved,v);}}},action:{async setBadgeText(){}},alarms:{create(){},onAlarm:event()},tabs:{onRemoved:event(),onUpdated:event()},debugger:{onDetach:event(),onEvent:event()}};
 const source=fs.readFileSync(new URL('../browser-extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.runInNewContext(source,{chrome,BrowserDriver:Driver,text:key=>key,languageState:()=>({}),setSystemLanguage:()=>false,Date,Promise,URL,setTimeout(fn,ms){const id={};timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
 await flush();
 return {chrome,ports,saved,timers,get attempts(){return attempts;},async retry(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();await flush();},async status(){let status;chrome.runtime.onMessage.fire({action:'status'},{id:'fixture',url:'chrome-extension://fixture/popup.html'},s=>status=s);await flush();return status;}};
}
function watchChromeIO(t){const touched=[];for(const name of ['existsSync','statSync','lstatSync','readFileSync','mkdirSync','writeFileSync','copyFileSync','renameSync','readdirSync','realpathSync']){const original=fs[name];t.mock.method(fs,name,function(...args){if(args.some(p=>typeof p==='string'&&(/Google\/Chrome|chrome-helper/.test(p))))touched.push({name,path:args[0]});return original.apply(this,args);});}return touched;}

test('real extension background retries lost native ports automatically, independently of Check Again',async()=>{
 const bg=await background();assert.equal(bg.attempts,1);bg.ports[0].onMessage.fire({kind:'status',ready:true});assert.equal((await bg.status()).connected,true);
 bg.ports[0].onDisconnect.fire();assert.equal((await bg.status()).connected,false);assert.equal([...bg.timers.values()][0].ms,250);
 await bg.retry();assert.equal(bg.attempts,2);bg.ports[1].onMessage.fire({kind:'status',ready:true});assert.equal((await bg.status()).connected,true);
 const disabled=await background({enabled:false});disabled.chrome.alarms.onAlarm.fire({name:'ken-reconnect'});await flush();assert.equal(disabled.attempts,0);assert.equal(disabled.saved.enabled,false);
});

test('actual Check Again repairs missing registration, dispatches reconnect to the real background, and never enables a disabled extension',async t=>{
 let pkg,home;const f=fixture(t,{browser:true,optedIn:true,preference:'none',register:()=>registerBrowserHost({root:pkg,home,distribution:storeTestDistribution()})});
 pkg=path.join(f.root,'package');home=path.join(f.root,'synthetic-chrome-home');fs.mkdirSync(path.join(pkg,'bin'),{recursive:true});fs.mkdirSync(path.join(pkg,'connectors'));fs.writeFileSync(path.join(pkg,'bin/ken-browser-host'),'fixture only, never executed');fs.copyFileSync(new URL('../connectors/browser-extension.json',import.meta.url),path.join(pkg,'connectors/browser-extension.json'));
 const manifest=path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kenyu.chathand.browser.json');
 const app=await f.building;await waitFor(()=>f.calls.registers===1);assert.equal(JSON.parse(fs.readFileSync(manifest)).path,path.join(pkg,'bin/ken-browser-host'));
 const available=()=>fs.existsSync(manifest);
 const ext=app.tools.automation.browser.extension,bg=await background({available});bg.ports[0].onMessage.fire({kind:'status',ready:false});assert.equal((await bg.status()).connected,false);
 fs.unlinkSync(manifest);bg.ports[0].onDisconnect.fire();await bg.retry();assert.equal(bg.attempts,2);assert.equal(bg.ports.length,1,'automatic retries cannot recreate a missing host registration');
 const epoch=ext.epoch;assert.equal((await f.post('/api/browser/extension/reconnect',{}, {owner:false})).status,401);assert.equal((await f.post('/api/browser/extension/reconnect',{}, {ui:false})).status,403);assert.equal(f.calls.registers,1);const result=await f.post('/api/browser/extension/reconnect');assert.equal(result.status,200);assert.equal(result.body.reconnecting,true);assert.equal(f.calls.registers,2);assert.equal(JSON.parse(fs.readFileSync(manifest)).path,path.join(pkg,'bin/ken-browser-host'));assert.notEqual(ext.epoch,epoch);
 // The next host poll carries the real server control into the real background.
 const disabled=await background({enabled:false});await bg.retry();const port=bg.ports.at(-1);port.onMessage.fire(ext.next(crypto.randomUUID()));await flush();assert.equal(bg.ports.length,3);
 const current=bg.ports.at(-1),session=crypto.randomUUID();const cancelled=ext.next(session);assert.equal(cancelled.control,'pause');current.onMessage.fire(cancelled);current.onMessage.fire(ext.next(session));assert.equal((await bg.status()).connected,true);assert.equal(disabled.attempts,0);assert.equal(disabled.saved.enabled,false);
 // A still-open but unready native port also receives the forced reconnect.
 await f.post('/api/browser/extension/reconnect');current.onMessage.fire(ext.next(crypto.randomUUID()));await flush();assert.equal(bg.ports.length,4);
 // A valid but stale registration is replaced with a preserved backup.
 const stale=JSON.parse(fs.readFileSync(manifest));stale.path=path.join(pkg,'old-host');fs.writeFileSync(manifest,JSON.stringify(stale));
 assert.equal((await f.post('/api/browser/extension/reconnect')).body.reconnecting,true);assert.equal(JSON.parse(fs.readFileSync(manifest)).path,path.join(pkg,'bin/ken-browser-host'));assert.equal(fs.readdirSync(path.dirname(manifest)).filter(n=>n.startsWith(path.basename(manifest)+'.backup-')).length,1);
 // Invalid existing data remains diagnostic; never overwrite an unsafe file.
 fs.writeFileSync(manifest,'not json');const before=ext.epoch;const invalid=await f.post('/api/browser/extension/reconnect');assert.equal(invalid.status,400);assert.equal(invalid.body.error.code,'HOST_REGISTRATION_INVALID');assert.equal(fs.readFileSync(manifest,'utf8'),'not json');assert.equal(ext.epoch,before);
});

for(const browser of [undefined,false,true])test('no prior opt-in is read-only with zero Chrome IO; raw enabled='+browser,async t=>{
 const io=watchChromeIO(t),f=fixture(t,{browser,preference:'none'}),app=await f.building;const ext=app.tools.automation.browser.extension,epoch=ext.epoch;
 assert.equal((await f.post('/api/browser/extension/reconnect',{}, {owner:false})).status,401);assert.equal((await f.post('/api/browser/extension/reconnect',{}, {ui:false})).status,403);
 const result=await f.post('/api/browser/extension/reconnect',{retry_after_permission:true,browser_control_opt_in:true});assert.equal(result.body.rechecked,true);assert.equal(result.body.reconnecting,false);assert.equal(f.calls.registers,0);assert.equal(ext.epoch,epoch);assert.equal(ext.reconnectRequested,false);assert.equal(app.state.data.browser_control_opt_in,undefined);assert.deepEqual(io,[]);
});

test('denied latch cannot be bypassed by Check Again payload or later automatic prepare',async t=>{
 // The public UI retry flag belongs to the retained legacy installer contract.
 let denied=true;const f=fixture(t,{chromeDistribution:legacyChromeDistribution(),browser:true,optedIn:true,preference:'none',register:()=>{if(denied)throw Object.assign(Error('denied'),{code:'CHROME_DATA_ACCESS_DENIED'});return {registered:true};}}),app=await f.building;await waitFor(()=>f.calls.registers===1);denied=false;
 const io=watchChromeIO(t),epoch=app.tools.automation.browser.extension.epoch;
 for(const body of [{},{retry_after_permission:true}])assert.equal((await f.post('/api/browser/extension/reconnect',body)).body.error.code,'CHROME_DATA_ACCESS_DENIED');
 assert.equal((await f.post('/api/browser/extension/prepare',{}, {ui:false})).body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(f.calls.registers,1);assert.deepEqual(io,[]);assert.equal(app.tools.automation.browser.extension.epoch,epoch);
 assert.equal((await f.post('/api/browser/extension/prepare',{retry_after_permission:true},{ui:false})).status,403);
 assert.equal((await f.post('/api/browser/extension/prepare',{retry_after_permission:true})).body.registered,true);assert.equal((await f.post('/api/browser/extension/reconnect')).body.reconnecting,true);assert.equal(f.calls.registers,3);
});

for(const gate of ['pause','transition','upgrade'])test('Check Again respects '+gate+' without host IO or dispatch',async t=>{
 const f=fixture(t,{browser:true,optedIn:true,preference:'none',...(gate==='upgrade'?{reconcile:async()=>({pending:true,code:'UPGRADE_STILL_RUNNING'})}:{})}),app=await f.building;
 if(gate==='pause')await f.post('/api/access',{enabled:false});if(gate==='transition')app.policy.transitioning=true;
 const count=f.calls.registers,io=watchChromeIO(t),epoch=app.tools.automation.browser.extension.epoch;
 const result=await f.post('/api/browser/extension/reconnect');assert.equal(result.status,400);assert.equal(result.body.error.code,gate==='pause'?'LOCAL_DISABLED':gate==='upgrade'?'UPGRADE_VERIFYING':'PERMISSION_TRANSITION');assert.equal(f.calls.registers,count);assert.deepEqual(io,[]);assert.equal(app.tools.automation.browser.extension.epoch,epoch);

});

test('permission change during registration fences late reconnect even if Browser Use is enabled again',async t=>{
 const pending=deferred();let wait=false;const f=fixture(t,{browser:true,optedIn:true,preference:'none',register:()=>wait?pending.promise:{registered:true}}),app=await f.building;await waitFor(()=>f.calls.registers===1);wait=true;const ext=app.tools.automation.browser.extension,epoch=ext.epoch;
 const request=f.post('/api/browser/extension/reconnect');await waitFor(()=>f.calls.registers===2);
 assert.equal((await f.post('/api/settings',{browser_enabled:false})).status,200);assert.equal((await f.post('/api/settings',{browser_enabled:true})).status,200);
 pending.resolve({registered:true});const result=await request;assert.equal(result.body.error.code,'INSTALL_ACCESS_CHANGED');assert.equal(ext.epoch,epoch);assert.equal(ext.reconnectRequested,false);
});

test('persisted opt-in cannot override raw disabled Browser Use or a completed browser revocation',async t=>{
 const f=fixture(t,{browser:true,optedIn:true,preference:'none'}),app=await f.building;await waitFor(()=>f.calls.registers===1);
 assert.equal((await f.post('/api/permissions/revoke',{gate:'capability',id:'browser'})).status,200);assert.equal(app.state.data.browser_enabled,false);
 const count=f.calls.registers,io=watchChromeIO(t),ext=app.tools.automation.browser.extension,epoch=ext.epoch;
 assert.equal((await f.post('/api/browser/extension/reconnect')).body.reconnecting,false);assert.equal(f.calls.registers,count);assert.deepEqual(io,[]);assert.equal(ext.epoch,epoch);assert.equal(app.state.data.browser_enabled,false);
});

test('unfinished desktop revocation blocks reconnect despite Browser Use remaining opted in',async t=>{
 const f=fixture(t,{browser:true,optedIn:true,preference:'none',statePatch:{desktop_enabled:true}}),app=await f.building;await waitFor(()=>f.calls.registers===1);
 const stop=t.mock.method(app.tools.automation.computer,'cancelAll',async()=>{throw Object.assign(Error('synthetic cleanup unconfirmed'),{code:'CAPABILITY_STOP_UNAVAILABLE'});});
 const revoked=await f.post('/api/permissions/revoke',{gate:'capability',id:'desktop'});stop.mock.restore();assert.equal(revoked.status,400);assert.equal(app.state.data.browser_enabled,true);assert.equal(app.policy.transitioning,true);
 const count=f.calls.registers,io=watchChromeIO(t),ext=app.tools.automation.browser.extension,epoch=ext.epoch;
 const result=await f.post('/api/browser/extension/reconnect');assert.equal(result.status,400);assert.equal(result.body.error.code,'PERMISSION_TRANSITION');assert.equal(f.calls.registers,count);assert.deepEqual(io,[]);assert.equal(ext.epoch,epoch);
});
