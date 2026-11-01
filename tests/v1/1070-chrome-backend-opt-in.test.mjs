import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerBrowserHost} from '../../app/v09/local-setup.mjs';
import {Repair,ensureBrowserHost} from '../../app/v1/repair.mjs';
import {ChromeInstallProbe} from '../../app/v1/chrome-install-probe.mjs';

const notEnabled=[undefined,null,false,0,1,'true',{},new Boolean(true)];
test('default-enabled capability is insufficient: registration requires independent strict opt-in',()=>{
 const untouched=new Proxy({},{get(){assert.fail('file access before Browser Use opt-in');}});
 for(const [browserEnabled,browserOptIn] of [...notEnabled.map(value=>[value,true]),...notEnabled.map(value=>[true,value])]){
  assert.deepEqual(registerBrowserHost({root:untouched,home:untouched,io:untouched,registrationOnlyAfterOptIn:true,browserEnabled,browserOptIn}),{registered:false,skipped:true,reason:'browser_not_opted_in'});
 }
});

test('explicit opt-in registers only the current native host in an isolated home',t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1070-opt-in-')));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const root=path.join(temp,'bundle'),home=path.join(temp,'home');
 fs.mkdirSync(path.join(root,'connectors'),{recursive:true});fs.mkdirSync(path.join(root,'bin'));
 fs.writeFileSync(path.join(root,'connectors/browser-extension.json'),JSON.stringify({extension_id:'a'.repeat(32)}));
 fs.writeFileSync(path.join(root,'bin/ChatHandBrowserHost'),'fixture');
 const visited=[],io=new Proxy(fs,{get(target,key){const value=target[key];return typeof value==='function'?(...args)=>{visited.push(String(args[0]));return value(...args);}:value;}});
 const registered=registerBrowserHost({distribution:storeTestDistribution(),root,home,platform:'darwin',io,registrationOnlyAfterOptIn:true,browserEnabled:true,browserOptIn:true});
 assert.equal(registered.registered,true);
 assert.ok(visited.every(file=>file.startsWith(path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts'))));
 assert.ok(visited.every(file=>!/Local State|Preferences|Containers/.test(file)));
});

function repairDeps(browserEnabled,browserOptIn=()=>true){
 return {registrationOnlyAfterOptIn:true,browserOptIn,snapshot:()=>({enabled:true,settings:{connection_preference:'relay',browser_enabled:browserEnabled,desktop_enabled:false},permissions:{capabilities:{browser:{enabled:true}}},relay:{online:true}}),systemProxy:()=>null,cleanupUpgrade:()=>({cleaned:0}),openChromeInBackground:()=>assert.fail('opened Chrome without opt-in'),browserHost:{expectedBinary:'/synthetic/host',manifestPath:'/synthetic/com.kenyu.chathand.browser.json',register:()=>assert.fail('registered without opt-in')},io:new Proxy({},{get:()=>assert.fail('read Chrome without opt-in')})};
}
test('repair does not treat a default-on permission projection as Browser Use opt-in',async()=>{
 for(const value of notEnabled)assert.equal(await ensureBrowserHost(repairDeps(value)),'skipped');
 for(const value of notEnabled)assert.equal(await ensureBrowserHost(repairDeps(true,()=>value)),'skipped');
 const repair=new Repair(repairDeps(true,()=>false)),result=repair.start();
 for(let i=0;i<100&&result.status==='running';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(result.status,'done');
 for(const id of ['browser_host','browser_helper'])assert.equal(result.items.find(item=>item.id===id).status,'skipped');
 assert.equal(result.items.at(-1).status,'ok');
});

test('a denied repair records categories once, stops browser follow-up and continues unrelated work',async()=>{
 let accesses=0;const events=[],deps=repairDeps(true);deps.distribution=storeTestDistribution();
 deps.io={lstatSync(){accesses++;throw Object.assign(Error('synthetic private path'),{code:'EPERM'});}};
 deps.chromeDataDiagnostic=event=>events.push(event);
 const result=new Repair(deps).start();
 for(let i=0;i<100&&result.status==='running';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(result.status,'done');assert.equal(accesses,1);assert.equal(events.length,1);
 for(const id of ['browser_host','browser_helper'])assert.equal(result.items.find(item=>item.id===id).code,'CHROME_DATA_ACCESS_DENIED');
 assert.equal(events[0].operation,'read');assert.equal(events[0].path_kind,'native_host');assert.equal(events[0].os_attribution,'unknown');
 assert.equal(JSON.stringify(events).includes('synthetic'),false);assert.equal(result.items.at(-1).status,'ok');
});

test('gated installer profile observation requires opt-in but does not read profile files',()=>{
 for(const browser_enabled of notEnabled){
  const probe=new ChromeInstallProbe({distribution:legacyChromeDistribution(),registrationOnlyAfterOptIn:true,browserOptIn:true,state:{data:{browser_enabled,desktop_enabled:true}},policy:{check(){}},extension:{}});
  assert.throws(()=>probe.observeProfiles(['Default']),{code:'INSTALL_ACCESS_CHANGED'});
 }
 let optedIn=false;
 const probe=new ChromeInstallProbe({distribution:legacyChromeDistribution(),registrationOnlyAfterOptIn:true,browserOptIn:()=>optedIn,state:{data:{browser_enabled:true,desktop_enabled:true}},policy:{check(){}},extension:{}});
 assert.throws(()=>probe.observeProfiles(['Profile 2']),{code:'INSTALL_ACCESS_CHANGED'});
 optedIn=true;
 assert.equal(probe.observeProfiles(['Profile 2']).selected_profile,'Profile 2');
 optedIn=false;assert.throws(()=>probe.chooseObservedProfile('Profile 2'),{code:'INSTALL_ACCESS_CHANGED'});
});
