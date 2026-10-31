import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDesktop} from '../app/server.mjs';
import {DesktopState} from '../app/state.mjs';
import {OwnedJobCleanupEvidence} from '../app/v1/permission-cleanup-evidence.mjs';
import {applyPermissionTier} from '../app/v1/permissions.mjs';

async function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'admin-settings-revoke-'))),work=path.join(root,'work'),stateDir=path.join(root,'state');
 const state=new DesktopState(stateDir,{defaultRoot:work});Object.assign(state.data,{auto_connect:false,access_enabled:true,connection_preference:'none',mode:'full',full_access_confirmed:true,high_risk:{admin:true}});state.save();
 const admin={present:true,confirmed:true,removals:0,legacy:0,supported:()=>true,ready(){return this.present;},
  uninstall(){this.legacy++;this.present=false;return {status:'not_installed'};},
  async uninstallForRevocation(){this.removals++;if(!this.confirmed)return {status:'unconfirmed',absence_confirmed:false};this.present=false;return {status:'removed',absence_confirmed:true};}};
 const evidence=new OwnedJobCleanupEvidence({platform:'darwin',probeGroup:()=> 'absent'}),uiKey='bc'.repeat(32);
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey,adminAccess:admin,clientDeps:{permissionCleanupEvidence:evidence,computerName:()=> 'Synthetic admin settings'}});
 await app.handle('/api/access',{enabled:true});
 const synthetic=new Set(),cancelled=[],oldCancel=app.queue.cancel.bind(app.queue);
 app.queue.cancel=(id,reason)=>{if(!synthetic.has(id))return oldCancel(id,reason);cancelled.push(id);const j=app.queue.get(id);if(j.child)j.child.exitCode=0;j.child=null;j.status=reason||'cancelled';return app.queue.publicJob(j);};
 t.after(async()=>{for(const id of synthetic){const j=app.queue.get(id);j.child=null;clearTimeout(j.cleanupTimer);}await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const job=admin=>{const {job_id}=app.queue.propose({request_id:randomUUID(),program:'/usr/bin/true',args:[],cwd:work}),j=app.queue.get(job_id),pid=910000+synthetic.size;
  synthetic.add(j.id);Object.assign(j,{admin:admin?{display:['sudo','/usr/bin/true']}:null,started_at:Date.now(),status:'running',pid,child:{pid,exitCode:null,signalCode:null,synthetic:true},sandbox:{backend:'none',scope:'full'}});assert.equal(evidence.capture(j),true);return j;};
 const post=async(body,ui=true)=>{const r=await fetch('http://127.0.0.1:'+app.apiPort+'/api/settings',{method:'POST',headers:{authorization:'Bearer '+app.adminToken,'content-type':'application/json',...(ui?{'x-chathand-ui':uiKey}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {app,admin,job,cancelled,post,work,root};
}

test('settings admin off stops only owned admin jobs and requires confirmed system-rule removal',async t=>{
 const f=await fixture(t),adminJob=f.job(true),ordinary=f.job(false),epoch=f.app.policy.epoch;
 const r=await f.post({high_risk:{admin:false}});assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.admin.present,false);assert.equal(f.admin.removals,1);assert.equal(f.admin.legacy,0);
 assert.deepEqual(f.cancelled,[adminJob.id]);assert.notEqual(ordinary.child,null);assert.equal(f.app.policy.epoch,epoch);assert.equal(f.app.policy.transitioning,false);
});

test('failed settings removal keeps execution blocked and the same off request can complete recovery',async t=>{
 const f=await fixture(t);f.admin.confirmed=false;const j=f.job(true);
 const r=await f.post({high_risk:{admin:false}});assert.equal(r.body.error.code,'ADMIN_REVOKE_UNCONFIRMED');
 assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.admin.present,true);assert.equal(j.child,null);assert.equal(f.app.policy.transitioning,true);
 assert.throws(()=>f.app.queue.propose({request_id:randomUUID(),program:'/usr/bin/true',args:[],cwd:f.work}),{code:'PERMISSION_TRANSITION'});
 assert.equal((await f.post({high_risk:{admin:true}})).body.error.code,'PERMISSION_TRANSITION');
 f.admin.confirmed=true;const retry=await f.post({high_risk:{admin:false}});assert.equal(retry.status,200);assert.equal(f.admin.present,false);assert.equal(f.app.policy.transitioning,false);
});

test('settings revoke starts cancellation before persistence failure and retries without restoring admin',async t=>{
 const f=await fixture(t),j=f.job(true),save=f.app.state.save.bind(f.app.state);t.after(()=>{f.app.state.save=save;});
 f.app.state.save=()=>{assert.equal(j.child,null);throw Error('synthetic save failure');};
 const r=await f.post({high_risk:{admin:false}});assert.equal(r.body.error.code,'REVOCATION_PERSISTENCE_FAILED');
 assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.app.policy.transitioning,true);
 f.app.state.save=save;assert.equal((await f.post({high_risk:{admin:false}})).status,200);assert.equal(f.admin.present,false);
});

test('mixed settings keep the outer transition through admin removal and apply remaining valid settings',async t=>{
 const f=await fixture(t),j=f.job(true);let release,entered;
 const waiting=new Promise(resolve=>entered=resolve),original=f.admin.uninstallForRevocation.bind(f.admin);
 f.admin.uninstallForRevocation=async()=>{entered();await new Promise(resolve=>release=resolve);return original();};
 const pending=f.post({high_risk:{admin:false},notifications:false});await waiting;
 assert.equal(j.child,null);assert.equal((await f.post({browser_enabled:true})).body.error.code,'PERMISSION_TRANSITION');
 release();const r=await pending;assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(f.app.state.data.notifications,false);assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.app.policy.transitioning,false);
});

test('invalid mixed settings and missing window authorization cannot start a revocation',async t=>{
 const f=await fixture(t);
 for(const body of [{high_risk:{admin:false,invalid:true}},{high_risk:{admin:false},terminal_enabled:'invalid'}])assert.equal((await f.post(body)).body.error.code,'ARG_INVALID');
 assert.equal((await f.post({high_risk:{admin:false}},false)).status,403);assert.equal(f.admin.removals,0);assert.equal(f.app.state.data.high_risk.admin,true);
});

test('light tier completes confirmed admin revocation before changing scope',async t=>{
 const f=await fixture(t);f.job(true);const folder=path.join(f.root,'light-work');
 const r=await f.app.handle('/api/permissions/tier',{tier:'light',folder});assert.equal(r.ok,true);assert.equal(f.admin.removals,1);assert.equal(f.admin.legacy,0);
 assert.equal(f.app.state.data.mode,'auto');assert.equal(f.app.store.root,folder);assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.app.policy.transitioning,false);
});

test('failed light-tier removal leaves the old scope, lowers admin and retains the recovery fence',async t=>{
 const f=await fixture(t);f.admin.confirmed=false;
 await assert.rejects(f.app.handle('/api/permissions/tier',{tier:'light',folder:path.join(f.root,'light-work')}),{code:'ADMIN_REVOKE_UNCONFIRMED'});
 assert.equal(f.app.state.data.mode,'full');assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.app.policy.transitioning,true);
 f.admin.confirmed=true;assert.equal((await f.post({high_risk:{admin:false}})).status,200);
 assert.equal((await f.app.handle('/api/permissions/tier',{tier:'light',folder:path.join(f.root,'light-work')})).ok,true);
});

test('standalone light-tier calls without a revocation coordinator fail before changing authority',async t=>{
 const f=await fixture(t);
 await assert.rejects(applyPermissionTier({state:f.app.state,store:f.app.store,policy:f.app.policy,adminAccess:f.admin},{tier:'light',folder:path.join(f.root,'unused')}),{code:'ADMIN_REVOKE_COORDINATOR_REQUIRED'});
 assert.equal(f.app.state.data.mode,'full');assert.equal(f.app.state.data.high_risk.admin,true);assert.equal(f.admin.removals,0);
});
