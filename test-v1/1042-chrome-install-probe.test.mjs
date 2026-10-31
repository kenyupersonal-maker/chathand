import {createLegacyChromeInstallSource} from '../test-support/legacy-chrome-install-source.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';
import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
class ChromeInstallProbe extends ProductionChromeInstallProbe {constructor(options){super({...options,distribution:legacyChromeDistribution()});}}
class ExtensionBrowser extends ProductionExtensionBrowser {constructor(state,store,policy){super(state,store,policy,{distribution:legacyChromeDistribution()});}}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ChromeInstallProbe as ProductionChromeInstallProbe,installSource} from '../app/v1/chrome-install-probe.mjs';
import {ExtensionBrowser as ProductionExtensionBrowser} from '../app/v09/extension-browser.mjs';
import {createDesktop,needsInterface} from '../app/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1042-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 createLegacyChromeInstallSource(t,{sourceRoot:root,targetRoot:temp});
 let clock=1000;const state={data:{browser_enabled:true,desktop_enabled:true},save(){}},policy={epoch:3,permissionRevision:1,enabled:true,check(){if(!this.enabled)throw Object.assign(Error(),{code:'LOCAL_DISABLED'});}},extension={pending:new Map(),session:'old',status:()=>({connected:true})};
 const probe=new ChromeInstallProbe({root:temp,state,policy,extension,origin:()=> 'http://127.0.0.1:12345',now:()=>clock,ttl:1000});
 const begin=()=>probe.begin(),connect=lease=>{extension.session='new';probe.verify(lease.lease_id);const source=installSource(temp);return probe.next('new',{version:source.version,build:source.build},source.host);};
 const success=()=>{const lease=begin(),request=connect(lease),html=probe.page(new URL(lease.probe_url).pathname),title=/<title>([^<]+)<\/title>/.exec(html)[1];return {lease,request,title};};
 return {temp,state,policy,extension,probe,begin,connect,success,time:x=>clock=x};
}
test('private lease requires native finish and independent actual page title, never an AI task',t=>{
 const f=fixture(t),{lease,request,title}=f.success();assert.equal('title'in request,false);assert.equal(f.probe.authorize('new',request.id).authorized,true);
 assert.throws(()=>f.probe.finish({lease_id:lease.lease_id,native_verified:true,source_fingerprint:lease.source_fingerprint}),{code:'INSTALL_NOT_VERIFIED'});
 assert.deepEqual(f.probe.complete('new',request.id,{title,tab_id:2,window_id:4}),{accepted:true});
 assert.equal(f.probe.verify(lease.lease_id).phase,'probe_verified');
 assert.equal(f.probe.finish({...lease,native_verified:true}).phase,'installed_verified');assert.equal(f.policy.tasks,undefined);
 assert.deepEqual(f.probe.complete('new',request.id,{title,tab_id:2,window_id:4}),{discarded:true});
 assert.deepEqual(Object.keys(f.probe.publicStatus()).sort(),['active','code','helper_seen','phase','stage']);assert.equal(JSON.stringify(f.probe.publicStatus()).includes(title),false);
});
for(const change of ['expiry','epoch','revision','browser','desktop','pause','source','host'])test('lease stops without replay after '+change,t=>{
 const f=fixture(t),{lease,request,title}=f.success();
 if(change==='expiry')f.time(2001);if(change==='epoch')f.policy.epoch++;if(change==='revision')f.policy.permissionRevision++;
 if(change==='browser')f.state.data.browser_enabled=false;if(change==='desktop')f.state.data.desktop_enabled=false;if(change==='pause')f.policy.enabled=false;
 if(change==='source')fs.appendFileSync(path.join(f.temp,'browser-extension/background.js'),'\n//changed');if(change==='host')fs.appendFileSync(path.join(f.temp,'app/v09/extension-host.mjs'),'\n//changed');
 assert.equal(f.probe.publicStatus(lease.lease_id).active,false);assert.equal(f.probe.authorize('new',request.id).authorized,false);
 assert.deepEqual(f.probe.complete('new',request.id,{title,tab_id:2,window_id:4}),{discarded:true});assert.equal(f.probe.next('new',{},{}),null);
});
test('baseline/selfreported host/version and unknown title cannot certify an install',t=>{
 const f=fixture(t),lease=f.begin(),source=installSource(f.temp);f.probe.verify(lease.lease_id);
 assert.equal(f.probe.next('old',source,source.host),null);assert.equal(f.probe.next('new',{version:source.version,build:source.build},{...source.host,entry_sha256:'wrong'}),null);
 assert.equal(f.probe.next('new',{version:'0',build:0},source.host),null);const request=f.connect(lease);
 assert.equal(f.probe.authorize('wrong',request.id).authorized,false);assert.deepEqual(f.probe.complete('wrong',request.id,{}),{discarded:true});
 f.probe.complete('new',request.id,{title:'claimed',tab_id:2,window_id:4});assert.equal(f.probe.publicStatus().phase,'stopped');
});
test('cancel, duplicate start and disconnected fresh session do not replay',t=>{
 const f=fixture(t),{lease,request,title}=f.success();assert.throws(()=>f.begin(),{code:'INSTALL_BUSY'});
 f.probe.cancel(lease.lease_id);assert.equal(f.probe.page(new URL(lease.probe_url).pathname),null);
 assert.deepEqual(f.probe.complete('new',request.id,{title,tab_id:2,window_id:4}),{discarded:true});
 const next=f.begin(),source=installSource(f.temp);f.extension.session='other';f.probe.verify(next.lease_id);f.probe.next('other',{version:source.version,build:source.build},source.host);f.extension.status=()=>({connected:false});assert.equal(f.probe.verify(next.lease_id).active,false);
});
test('source rejects linked files and version disagreement before work',t=>{
 const f=fixture(t),file=path.join(f.temp,'browser-extension/popup.css');fs.renameSync(file,file+'.old');fs.symlinkSync(file+'.old',file);
 assert.throws(()=>f.begin(),{code:'INSTALL_SOURCE_CHANGED'});fs.unlinkSync(file);fs.renameSync(file+'.old',file);
 const manifest=path.join(f.temp,'browser-extension/manifest.json'),data=JSON.parse(fs.readFileSync(manifest));data.version='1.0.0.1';fs.writeFileSync(manifest,JSON.stringify(data));assert.throws(()=>f.begin(),{code:'INSTALL_SOURCE_CHANGED'});
});
test('normal browser requests cannot race installer; a fresh heartbeat preserves native lease',t=>{
 const f=fixture(t),ext=new ExtensionBrowser(f.state,{},f.policy);t.after(()=>ext.closeAll());f.probe.extension=ext;ext.installProbe=f.probe;f.begin();
 assert.throws(()=>ext.request('tabs',{},'chatgpt','unused'),{code:'BROWSER_BUSY'});const session=crypto.randomUUID();ext.heartbeat(session);assert.equal(f.probe.publicStatus().active,true);ext.cancelAll();assert.equal(f.probe.publicStatus().active,false);
});
test('installer routes are window-only; MCP/admin and extension token cannot begin, page has no scripts',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1042-http-')),work=path.join(temp,'work');fs.mkdirSync(work);let registrations=0;
 const app=await createDesktop({stateDir:path.join(temp,'state'),defaultRoot:work,adminAccess:{supported:()=>false,ready:()=>false},uiKey:'a'.repeat(64),clientDeps:{chromeDistribution:storeTestDistribution(),computerName:()=> 'Fixture',browserHost:{expectedBinary:path.join(temp,'bin/host'),manifestPath:[path.join(temp,'manifest')],register:()=>{registrations++;return {registered:true};}},tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({}),start(){},close(){},settingsChanged(){}})}});
 t.after(async()=>{await app.close();fs.rmSync(temp,{recursive:true,force:true});});
 const route='/api/browser/extension/install/start';assert.equal(needsInterface(route,{}),true);
 const post=async(headers,body={},target=route)=>fetch('http://127.0.0.1:'+app.apiPort+target,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post({Authorization:'Bearer '+app.mcpToken})).status,401);assert.equal((await post({Authorization:'Bearer '+app.adminToken})).status,403);assert.equal((await post({'X-Ken-Extension':'untrusted'})).status,401);
 const windowHeaders={Authorization:'Bearer '+app.adminToken,'X-ChatHand-UI':app.uiKey};
 for(const suffix of ['profiles','start','status','progress','verify','finish','cancel','evidence']){
  const target='/api/browser/extension/install/'+suffix;
  const denied=await post(windowHeaders,{profile_id:'Profile 7'},target);assert.equal(denied.status,400);const body=await denied.json();assert.equal(body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');assert.equal(body.lease_id,undefined);assert.equal(body.probe_url,undefined);
 }
 assert.equal(app.tools.automation.browser.extension.installProbe.lease,null);assert.equal(registrations,0);
});

test('stage reports are fixed, private and cannot revive a cancelled install',t=>{
 const f=fixture(t),lease=f.begin();assert.equal(f.probe.progress(lease.lease_id,'opening_chrome').stage,'opening_chrome');assert.throws(()=>f.probe.progress(lease.lease_id,'arbitrary private text'),{code:'INSTALL_STOPPED'});
 f.probe.cancel(lease.lease_id,'CHROME_INSTALL_MANAGED_POLICY_BLOCKED');assert.equal(f.probe.publicStatus().code,'CHROME_INSTALL_MANAGED_POLICY_BLOCKED');assert.throws(()=>f.probe.progress(lease.lease_id,'extensions'),{code:'INSTALL_STOPPED'});assert.equal(f.probe.publicStatus().active,false);
 for(const action of ['profiles','progress'])assert.equal(needsInterface('/api/browser/extension/install/'+action,{}),true);
});
test('sanitized install audit and failure evidence are single-use and bound to the stopped lease',t=>{
 const f=fixture(t),events=[];f.probe.audit=e=>events.push(e);const lease=f.begin();f.probe.progress(lease.lease_id,'extensions');f.probe.cancel(lease.lease_id,'CHROME_INSTALL_CONTROLS_UNKNOWN');
 assert.deepEqual(f.probe.evidence({lease_id:lease.lease_id,evidence_code:'CHROME_INSTALL_EVIDENCE_UNAVAILABLE'},f.temp),{recorded:true,content_masked:false});assert.throws(()=>f.probe.evidence({lease_id:lease.lease_id,evidence_code:'CHROME_INSTALL_EVIDENCE_UNAVAILABLE'},f.temp),{code:'INSTALL_STOPPED'});
 const later=f.begin();assert.throws(()=>f.probe.evidence({lease_id:lease.lease_id,evidence_code:'CHROME_INSTALL_EVIDENCE_UNAVAILABLE'},f.temp),{code:'INSTALL_LEASE_INVALID'});assert.equal(f.probe.publicStatus(later.lease_id).active,true);
 const serialized=JSON.stringify(events);assert.equal(serialized.includes(lease.lease_id),false);assert.equal(serialized.includes(lease.probe_url),false);assert.equal(serialized.includes(lease.extension_folder),false);assert.equal(serialized.includes('Chrome controls unknown'),false);assert.equal(needsInterface('/api/browser/extension/install/evidence',{}),true);
});
