import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
class ExtensionBrowser extends ProductionExtensionBrowser {constructor(state,store,policy){super(state,store,policy,{distribution:legacyChromeDistribution()});}}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {ExtensionBrowser as ProductionExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {text,setSystemLanguage,languageState} from '../../browser-extension/locale.js';

const background=fs.readFileSync(new URL('../../browser-extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const oldVersion='1.0.0.1080',newVersion='1.0.0.1081';
const helper=(version=oldVersion,extra={})=>({version,build:Number(version.split('.').at(-1)),features:['self_reload'],...extra});
const event=()=>{const listeners=[];return {addListener:f=>listeners.push(f),fire:(...args)=>listeners.map(f=>f(...args))};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

function fixture(t){
 let now=1800000;
 t.mock.method(Date,'now',()=>now);
 const ext=new ExtensionBrowser({data:{mode:'auto',browser_enabled:true},save(){}},{},{epoch:'epoch',check(){},emit(){},tasks:new Map()});
 ext.expected={version:newVersion,build:1081,folder:'/fixture/helper'};
 const session=crypto.randomUUID();ext.next(session);
 t.after(()=>ext.closeAll());
 return {ext,session,advance:ms=>{now+=ms;},now:()=>now};
}

test('an actual background cooldown can be followed by one late reload request for the same version pair',async t=>{
 const f=fixture(t),ports=[],store={enabled:true,helper_reload:{at:f.now()-60000,from:'1.0.0.1079',to:oldVersion}};
 let reloads=0;
 class Driver{constructor(){this.attached=new Set();}async detachAll(){}invalidate(){}noteDetached(){}}
 const chrome={runtime:{id:'fixture',lastError:null,getURL:n=>'chrome-extension://fixture/'+n,getManifest:()=>({version:oldVersion}),reload(){reloads++;},
  connectNative(){const p={posted:[],postMessage:m=>p.posted.push(m),onMessage:event(),onDisconnect:event(),disconnect(){}};ports.push(p);return p;},onInstalled:event(),onStartup:event(),onMessage:event()},
  storage:{local:{get:async keys=>typeof keys==='string'?{[keys]:structuredClone(store[keys])}:Object.fromEntries(keys.filter(k=>Object.hasOwn(store,k)).map(k=>[k,structuredClone(store[k])])),set:async value=>Object.assign(store,structuredClone(value))}},
  action:{setBadgeText:async()=>{}},alarms:{create(){},onAlarm:event()},tabs:{onRemoved:event(),onUpdated:event()},debugger:{onDetach:event(),onEvent:event()}};
 vm.runInNewContext(background,{chrome,BrowserDriver:Driver,text,setSystemLanguage,languageState,Date,setTimeout,clearTimeout,Promise,console},{filename:'actual-background.js'});
 await flush();assert.equal(ports.length,1);
 const port=ports[0],hello=port.posted.find(x=>x.kind==='hello').helper;
 const first=f.ext.next(f.session,hello);assert.equal(first.control,'reload');port.onMessage.fire(first);await flush();
 assert.equal(reloads,0);assert.equal(store.helper_reload.to,oldVersion);
 f.advance(119999);assert.notEqual(f.ext.next(f.session,hello).control,'reload');
 f.advance(1);const retry=f.ext.next(f.session,hello);assert.equal(retry.control,'reload');assert.equal(retry.expected_version,newVersion);
 port.onMessage.fire(retry);await flush();assert.equal(reloads,1);assert.equal(store.helper_reload.to,newVersion);assert.equal(store.helper_reload.at,f.now());
 f.ext.next(crypto.randomUUID(),helper(newVersion,{last_reload:store.helper_reload}));
 assert.equal(f.ext.helperStatus().state,'current');assert.equal(f.ext.reloadAsked.size,0);
});

test('late retry stays bounded and does not reset the original failure age',t=>{
 const f=fixture(t);f.ext.noteHelper(f.session,helper());assert.equal(f.ext.reloadControl()?.control,'reload');
 f.advance(120000);assert.equal(f.ext.helperStatus().state,'reload_failed');assert.equal(f.ext.reloadControl()?.control,'reload');
 assert.equal(f.ext.helperStatus().state,'reload_failed');assert.equal(f.ext.reloadControl(),null);
 f.advance(3600000);assert.equal(f.ext.reloadControl(),null);
});

test('pending browser work defers both first reload and the one late retry',t=>{
 const f=fixture(t);f.ext.noteHelper(f.session,helper());f.ext.pending.set('fixture-busy',{});
 assert.equal(f.ext.reloadControl(),null);assert.equal(f.ext.reloadAsked.size,0);f.ext.pending.clear();assert.equal(f.ext.reloadControl()?.control,'reload');
 f.advance(120000);f.ext.pending.set('fixture-busy',{});assert.equal(f.ext.reloadControl(),null);f.ext.pending.clear();
 assert.equal(f.ext.reloadControl()?.control,'reload');assert.equal(f.ext.reloadControl(),null);
});

test('a reconnect that still reports the old version remains wrong_folder without another reload',t=>{
 const f=fixture(t);f.ext.noteHelper(f.session,helper());assert.equal(f.ext.reloadControl()?.control,'reload');
 f.advance(120000);f.ext.noteHelper(crypto.randomUUID(),helper());assert.equal(f.ext.helperStatus().state,'wrong_folder');assert.equal(f.ext.reloadControl(),null);
});

test('persistent evidence that reload kept the old version prevents repeated retries',t=>{
 const f=fixture(t);
 f.ext.noteHelper(f.session,helper(oldVersion,{last_reload:{at:f.now(),from:oldVersion,to:newVersion}}));
 assert.equal(f.ext.helperStatus().state,'wrong_folder');assert.equal(f.ext.reloadControl(),null);
 f.advance(120000);assert.equal(f.ext.reloadControl(),null);
});

test('a new target version has an independent attempt and one independent late retry',t=>{
 const f=fixture(t);f.ext.noteHelper(f.session,helper());assert.equal(f.ext.reloadControl()?.control,'reload');
 f.advance(120000);assert.equal(f.ext.reloadControl()?.control,'reload');
 f.ext.expected={...f.ext.expected,version:'1.0.0.1082',build:1082};const next=f.ext.reloadControl();assert.equal(next.control,'reload');assert.equal(next.expected_build,1082);
 assert.equal(f.ext.reloadControl(),null);f.advance(120000);assert.equal(f.ext.reloadControl()?.expected_build,1082);assert.equal(f.ext.reloadControl(),null);
});

test('current and unsupported helpers still do not receive reload controls',t=>{
 const f=fixture(t);f.ext.noteHelper(f.session,helper(newVersion));assert.equal(f.ext.reloadControl(),null);
 f.ext.noteHelper(f.session,{version:oldVersion,build:1080,features:[]});assert.equal(f.ext.reloadControl(),null);
 f.advance(120000);assert.equal(f.ext.reloadControl(),null);assert.equal(f.ext.reloadAsked.size,0);
});
