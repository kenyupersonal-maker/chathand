import {createLegacyChromeInstallSource} from '../support/legacy-chrome-install-source.mjs';
import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
class ChromeInstallProbe extends ProductionChromeInstallProbe {constructor(options){super({...options,distribution:legacyChromeDistribution()});}}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ChromeInstallProbe as ProductionChromeInstallProbe,installSource} from '../../app/v1/chrome-install-probe.mjs';
import {chromeInstallFields,DiagnosticEvents,readChromeInstallEvents} from '../../app/diagnostic-events.mjs';

const root=path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
function fixture(sourceRoot=root){
 let time=0;const events=[],state={data:{browser_enabled:true,desktop_enabled:true}},policy={epoch:1,permissionRevision:1,check(){}},extension={session:'old',pending:new Map(),status:()=>({connected:true})};
 const probe=new ChromeInstallProbe({root:sourceRoot,state,policy,extension,origin:()=> 'http://127.0.0.1:12345',now:()=>time,diagnostic:event=>events.push(event)});
 let id;
 const report=(native_event,stage,elapsed_ms,code,extra={})=>{if(native_event==='started')id=crypto.randomUUID();return probe.progress(undefined,stage,{native_event,elapsed_ms,target_is_default:null,attempt_id:id,...(code?{code}:{}),...extra});};
 return {probe,events,state,policy,extension,report,id:()=>id,time:value=>time=value};
}
test('pre-lease accessibility progress accepts started/running/stopped past 90 seconds and cannot revive after stopping',()=>{
 const f=fixture();f.report('started','waiting_accessibility',0);
 assert.deepEqual(f.probe.publicStatus(),{phase:'waiting_accessibility',active:true,stage:'waiting_accessibility',code:null,helper_seen:false,attempt_id:f.id(),repair:false});
 f.time(120000);f.report('running','waiting_accessibility',120000);
 assert.equal(f.probe.publicStatus().active,true);
 f.time(180000);f.report('stopped','waiting_accessibility',180000,'CHROME_INSTALL_ACCESSIBILITY_TIMEOUT');
 assert.equal(f.events.at(-1).ms,180000);assert.equal(f.probe.publicStatus().code,'CHROME_INSTALL_ACCESSIBILITY_TIMEOUT');
 f.report('running','waiting_accessibility',180001);assert.equal(f.probe.publicStatus().active,false);
 f.report('started','waiting_accessibility',0);assert.equal(f.probe.publicStatus().active,true);
 f.probe.cancel();f.report('running','waiting_accessibility',1);assert.equal(f.probe.publicStatus().code,'INSTALL_CANCELLED');
});

test('the diagnostic cap is phase-specific and fixed to five metadata fields',()=>{
 const base={stage:'waiting_accessibility',code:'CHROME_INSTALL_PROGRESS',ms:300000,target_is_default:null,outcome:'running',path:'private fixture',profile_name:'private fixture'};
 assert.deepEqual(Object.keys(chromeInstallFields(base)).sort(),['code','ms','outcome','stage','target_is_default']);
 assert.equal(chromeInstallFields({...base,ms:300001}),null);
 for(const stage of ['preparing','removing_copy','installed_verified','validating_helper']){
  assert.ok(chromeInstallFields({...base,stage,ms:90000}));
  assert.equal(chromeInstallFields({...base,stage,ms:90001}),null);
 }
 const f=fixture();
 assert.throws(()=>f.report('running','preparing',90001),{code:'INSTALL_STOPPED'});
 assert.throws(()=>f.report('running','waiting_accessibility',300001),{code:'INSTALL_STOPPED'});
 assert.throws(()=>f.report('anything','waiting_accessibility',1),{code:'INSTALL_STOPPED'});
 assert.throws(()=>f.report('stopped','waiting_accessibility',1,'PRIVATE_ERROR'),{code:'INSTALL_STOPPED'});
});

test('lost native replies and changed permissions stop waiting without extending the original deadline',()=>{
 const f=fixture();f.report('started','waiting_accessibility',0);f.time(299999);
 f.report('running','waiting_accessibility',0); // A stale elapsed value cannot renew the wait.
 f.time(300000);assert.equal(f.probe.publicStatus().code,'CHROME_INSTALL_ACCESSIBILITY_TIMEOUT');
 assert.equal(f.events.at(-1).ms,300000);
 const g=fixture();g.report('started','waiting_accessibility',0);g.policy.permissionRevision++;
 assert.equal(g.probe.publicStatus().code,'INSTALL_ACCESS_CHANGED');
});

test('waiting creates no lease; removing_copy uses the original bounded lease and only verified finish yields installed_verified',t=>{
 const root=createLegacyChromeInstallSource(t);
 const f=fixture(root);f.report('started','waiting_accessibility',0);f.time(180000);
 assert.equal(f.probe.lease,null);const lease=f.probe.begin('Default');
 assert.equal(f.probe.publicStatus().stage,'preparing');assert.equal(f.probe.lease.deadline,270000);
 f.probe.progress(lease.lease_id,'removing_copy');assert.equal(f.probe.publicStatus().stage,'removing_copy');
 f.report('running','installed_verified',0);assert.notEqual(f.probe.publicStatus().phase,'installed_verified');
 assert.throws(()=>f.probe.progress(lease.lease_id,'installed_verified'),{code:'INSTALL_STOPPED'});
 assert.throws(()=>f.probe.finish({...lease,native_verified:true}),{code:'INSTALL_NOT_VERIFIED'});
 const source=installSource(root);f.extension.session='new';f.probe.verify(lease.lease_id);
 const request=f.probe.next('new',{version:source.version,build:source.build},source.host);
 const title=/<title>([^<]+)<\/title>/.exec(f.probe.page(new URL(lease.probe_url).pathname))[1];
 f.probe.complete('new',request.id,{title,tab_id:1,window_id:1});
 assert.equal(f.probe.finish({...lease,native_verified:true}).phase,'installed_verified');
 assert.equal(f.events.at(-1).stage,'installed_verified');assert.equal(f.events.at(-1).outcome,'completed');
 f.report('stopped','preparing',1,'CHROME_INSTALL_CANCELLED');assert.equal(f.probe.publicStatus().phase,'installed_verified');
 const g=fixture(root),expired=g.probe.begin();g.probe.progress(expired.lease_id,'removing_copy');g.time(90001);
 assert.equal(g.probe.publicStatus().code,'INSTALL_EXPIRED');
});

test('writer and reader preserve new stages and long accessibility waits without exporting private extras',t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1070-chrome-events-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const writer=new DiagnosticEvents(temp,{salt:Buffer.alloc(32)});
 for(const [stage,code,ms,outcome] of [['waiting_accessibility','CHROME_INSTALL_ACCESSIBILITY_TIMEOUT',180000,'stopped'],['removing_copy','CHROME_INSTALL_PROGRESS',90000,'running'],['installed_verified','CHROME_INSTALL_OK',1,'completed']]){
  assert.equal(writer.record('chrome.install',{stage,code,ms,outcome,target_is_default:null,path:'private fixture'}),true);
 }
 assert.equal(writer.record('chrome.install',{stage:'validating_helper',code:'CHROME_INSTALL_PROGRESS',ms:90001,outcome:'running',target_is_default:null}),false);
 const result=readChromeInstallEvents(temp);assert.equal(result.events.length,3);assert.equal(result.events[0].ms,180000);
 assert.equal(JSON.stringify(result).includes('private fixture'),false);
});

const profiles=[{id:'Default',name:'Transient profile A',installed:false,enabled:false},{id:'Profile 1',name:'Transient profile B',installed:null,enabled:null}];
const choice=(id,patch={})=>({native_event:'choose_profile',attempt_id:id,choose_profile:true,profiles:profiles.map(p=>({...p})),selected_profile:'',repair:true,...patch});
test('choose_profile is a copied, attempt-bound UI projection with repair context and no audit or diagnostic payload',()=>{
 const f=fixture(),audit=[];f.probe.audit=event=>audit.push(event);
 f.report('started','waiting_accessibility',0);const id=f.id(),eventCount=f.events.length,auditCount=audit.length;
 assert.deepEqual(f.probe.progress(undefined,undefined,choice(id)),{recorded:false,accepted:true});
 const status=f.probe.publicStatus(undefined,id);
 assert.equal(status.phase,'choose_profile');assert.equal(status.choose_profile,true);assert.equal(status.repair,true);assert.equal(status.selected_profile,'');
 assert.deepEqual(status.profiles,profiles);status.profiles[0].name='changed by caller';assert.equal(f.probe.publicStatus().profiles[0].name,profiles[0].name);
 assert.equal(f.events.length,eventCount);assert.equal(audit.length,auditCount);
 assert.throws(()=>f.probe.chooseObservedProfile('Default'),{code:'CHROME_INSTALL_PROFILE_UNKNOWN'});
 assert.equal(f.probe.publicStatus(undefined,crypto.randomUUID()).phase,'idle');
 f.probe.cancel(undefined,undefined,id);assert.equal(f.probe.publicStatus().choose_profile,undefined);assert.equal(f.probe.publicStatus().profiles,undefined);
 const serialized=JSON.stringify({audit,events:f.events});for(const privateValue of [id,...profiles.map(p=>p.name)])assert.equal(serialized.includes(privateValue),false);
 assert.equal(f.probe.publicStatus().phase,'stopped');
});

test('cancelled and lease-consumed IDs cannot revive or interrupt a newer attempt or its lease',t=>{
 const f=fixture(createLegacyChromeInstallSource(t));f.report('started','waiting_accessibility',0);const old=f.id();
 f.probe.cancel(undefined,undefined,old);
 assert.equal(f.report('started','waiting_accessibility',0,undefined,{attempt_id:old}).discarded,true);
 assert.throws(()=>f.probe.begin(),{code:'INSTALL_STOPPED'});
 f.report('started','preparing',0);const current=f.id();
 assert.equal(f.report('stopped','preparing',1,'CHROME_INSTALL_CANCELLED',{attempt_id:old}).discarded,true);
 f.probe.cancel(undefined,undefined,old);assert.equal(f.probe.publicStatus().attempt_id,current);assert.equal(f.probe.publicStatus().active,true);
 const lease=f.probe.begin('Default',{attempt_id:current});
 assert.equal(f.probe.publicStatus(undefined,current).phase,'loading');
 assert.equal(f.report('started','waiting_accessibility',0,undefined,{attempt_id:current}).discarded,true);
 assert.equal(f.report('running','installed_verified',0,undefined,{attempt_id:current}).discarded,true);
 assert.equal(f.probe.progress(undefined,undefined,choice(current)).discarded,true);
 assert.equal(f.probe.publicStatus(lease.lease_id).phase,'loading');assert.equal(f.probe.publicStatus().choose_profile,undefined);
});

test('new profile selection intent supersedes the transient choice but stale callbacks cannot overwrite it',()=>{
 const f=fixture();f.report('started','preparing',0,undefined,{repair:true});const old=f.id();
 f.probe.progress(undefined,undefined,choice(old));
 f.report('started','preparing',0,undefined,{repair:true});const fresh=f.id();
 assert.equal(f.probe.publicStatus().attempt_id,fresh);assert.equal(f.probe.publicStatus().profiles,undefined);
 assert.equal(f.probe.progress(undefined,undefined,choice(old)).discarded,true);
 assert.equal(f.report('running','preparing',1,undefined,{attempt_id:old}).discarded,true);
 assert.equal(f.probe.publicStatus().attempt_id,fresh);
});

test('invalid profile choices cannot affect status; legacy metadata cannot create UI state or certify success',()=>{
 const f=fixture();f.report('started','preparing',0,undefined,{repair:true});const id=f.id();
 for(const patch of [{profiles:[]},{profiles:[profiles[0],profiles[0]]},{selected_profile:'Profile 9'},{profiles:[{...profiles[0],id:'../profile'}]},{profiles:[{...profiles[0],name:'bad\nname'}]},{repair:'true'},{attempt_id:'invalid'}]){
  assert.throws(()=>f.probe.progress(undefined,undefined,choice(id,patch)),{code:'INSTALL_STOPPED'});
  assert.equal(f.probe.publicStatus().choose_profile,undefined);
 }
 const g=fixture();g.probe.progress(undefined,'preparing',{native_event:'started',elapsed_ms:0,target_is_default:null});
 assert.equal(g.probe.publicStatus().phase,'idle');
 g.report('started','installed_verified',0);assert.equal(g.probe.publicStatus().phase,'idle');
 const unknown=crypto.randomUUID();g.probe.cancel(undefined,undefined,unknown);
 assert.equal(g.report('started','preparing',0,undefined,{attempt_id:unknown}).discarded,true);
});


test('cancelling the current consumed attempt stops its bound lease while old attempt IDs cannot stop a newer lease',t=>{
 const f=fixture(createLegacyChromeInstallSource(t));f.report('started','preparing',0);const first=f.id(),lease=f.probe.begin('Default',{attempt_id:first});
 assert.equal(f.probe.cancel(lease.lease_id,'CHROME_INSTALL_CANCELLED',first).phase,'stopped');
 f.report('started','preparing',0);const fresh=f.id(),next=f.probe.begin('Default',{attempt_id:fresh});
 assert.equal(f.probe.cancel(undefined,undefined,first).phase,'loading');
 assert.equal(f.probe.publicStatus(next.lease_id).active,true);
 assert.equal(f.probe.cancel(undefined,'CHROME_INSTALL_CANCELLED',fresh).phase,'stopped');
});


test('status for a retired lease attempt cannot expose a newer profile choice',t=>{
 const f=fixture(createLegacyChromeInstallSource(t));f.report('started','preparing',0);const old=f.id(),lease=f.probe.begin('Default',{attempt_id:old});
 f.probe.cancel(lease.lease_id);
 f.report('started','preparing',0);const fresh=f.id();f.probe.progress(undefined,undefined,choice(fresh));
 const previous=f.probe.publicStatus(undefined,old);
 assert.equal(previous.phase,'stopped');assert.equal(previous.choose_profile,undefined);assert.equal(previous.profiles,undefined);
 assert.equal(f.probe.publicStatus(undefined,fresh).choose_profile,true);
 assert.equal(f.probe.cancel(undefined,undefined,old).choose_profile,true);
 assert.equal(f.probe.publicStatus(undefined,fresh).choose_profile,true);
 assert.equal(f.probe.publicStatus(undefined,crypto.randomUUID()).phase,'idle');
});
