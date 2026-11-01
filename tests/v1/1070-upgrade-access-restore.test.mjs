import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VERSION} from '../../app/product.mjs';
import {armUpgradeGuard} from '../../app/v08/upgrade-guard.mjs';
import {fixture,deferred,waitFor} from './1070-startup-fixture.mjs';

function guarded(t,options={}){
 const f=fixture(t,{preference:'none',...options,reconcile:deps=>{
  armUpgradeGuard(deps.stateDir,VERSION,'synthetic-upgrade');
  return {reconciled:false};
 }});
 t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 return f;
}
async function blocked(app,code='LOCAL_DISABLED'){
 const before=app.policy.tasks.size;
 await assert.rejects(()=>app.tools.invoke('begin_task',{request_id:randomUUID(),title:'Must remain blocked'}),{code});
 assert.equal(app.policy.tasks.size,before);
}

test('1070 actual owner HTTP commit restores saved execution only after the upgrade guard clears',async t=>{
 const f=guarded(t),app=await f.building;
 assert.equal(app.policy.enabled,false);assert.equal(app.state.data.access_enabled,true);
 await blocked(app,'UPGRADE_VERIFYING');
 const denied=await f.post('/api/upgrade/commit',{}, {owner:false});assert.equal(denied.status,401);
 assert.equal(app.tools.upgradePending,true);assert.equal(app.policy.enabled,false);
 const result=await f.post('/api/upgrade/commit');assert.equal(result.status,200);assert.equal(result.body.committed,true);
 assert.equal(app.tools.upgradePending,false);assert.equal(app.policy.enabled,true);assert.equal(app.store.paused,false);
 const task=await app.tools.invoke('begin_task',{request_id:randomUUID(),title:'After trusted commit'});
 assert.equal(task.status,'active');
});
for(const marker of ['corrupt','wrong-version'])test('1070 '+marker+' commit cannot restore execution',async t=>{
 const f=guarded(t),app=await f.building;
 if(marker==='corrupt')fs.writeFileSync(path.join(f.stateDir,'upgrade-guard.json'),'{broken');
 else armUpgradeGuard(f.stateDir,'0.0.0-invalid','synthetic-other-candidate');
 const result=await f.post('/api/upgrade/commit');assert.equal(result.body.error.code,'UPGRADE_GUARD_INVALID');
 assert.equal(app.tools.upgradePending,true);assert.equal(app.policy.enabled,false);assert.equal(app.state.data.access_enabled,true);
 await blocked(app,'UPGRADE_VERIFYING');
});
for(const pause of ['saved','access','automation-stop'])test('1070 trusted commit preserves '+pause+' pause',async t=>{
 const f=guarded(t,{enabled:pause!=='saved'}),app=await f.building;
 if(pause==='access')assert.equal((await f.post('/api/access',{enabled:false})).status,200);
 if(pause==='automation-stop')assert.equal((await f.post('/api/automation/stop')).status,200);
 assert.equal((await f.post('/api/upgrade/commit')).body.committed,true);
 assert.equal(app.tools.upgradePending,false);assert.equal(app.state.data.access_enabled,false);assert.equal(app.policy.enabled,false);assert.equal(app.store.paused,true);
 await blocked(app);
});
for(const mode of ['pending','recovery'])test('1070 trusted commit does not restore execution during permission '+mode,async t=>{
 const f=guarded(t,{browser:true}),app=await f.building,entered=deferred(),release=deferred();
 const browser=app.tools.automation.browser,original=browser.closeAll;
 browser.closeAll=async()=>{entered.resolve();await release.promise;if(mode==='recovery')throw Object.assign(Error('Synthetic unconfirmed browser stop'),{code:'SYNTHETIC_STOP_UNCONFIRMED'});return original.call(browser);};
 const revoke=app.handle('/api/permissions/revoke',{gate:'capability',id:'browser'}).then(value=>({value}),error=>({error}));
 try{
  await entered.promise;
  if(mode==='recovery'){release.resolve();assert.equal((await revoke).error.code,'SYNTHETIC_STOP_UNCONFIRMED');}
  assert.equal(app.policy.transitioning,true);
  assert.equal((await f.post('/api/upgrade/commit')).body.committed,true);
  assert.equal(app.tools.upgradePending,false);assert.equal(app.state.data.access_enabled,true);assert.equal(app.state.data.browser_enabled,false);assert.equal(app.policy.enabled,false);
  await blocked(app);
 }finally{release.resolve();await revoke;browser.closeAll=original;}
});
for(const route of ['unready-tunnel','stopped-openai','stale-site','stopped-relay'])test('1070 trusted commit preserves unhealthy '+route+' gate',async t=>{
 const f=guarded(t,{preference:route==='unready-tunnel'?'tunnel':route==='stopped-relay'?'relay':'none'}),app=await f.building;
 if(route==='unready-tunnel'){
  await waitFor(()=>f.calls.starts===1);app.controller.phase='running';f.tunnel.child=null;
 }else if(route==='stopped-openai')app.state.data.connection_preference='tunnel';
 else if(route==='stale-site'){
  const local=app.tools.bSiteLocalStore;
  local.configureSite({site_id:'synthetic-site',owner_subject:'synthetic-owner',binding_id:randomUUID(),generation:1},{authenticated:true});
  local.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
  local.switchUser('site',{windowGesture:true});
  t.mock.method(local,'now',()=>Date.now()+31000);
 }
 assert.equal((await f.post('/api/upgrade/commit')).body.committed,true);
 assert.equal(app.tools.upgradePending,false);assert.equal(app.policy.enabled,false);assert.equal(app.state.data.access_enabled,true);
 await blocked(app);
});
test('1070 trusted commit restores a current healthy Site through the ordinary route gate',async t=>{
 const f=guarded(t),app=await f.building,local=app.tools.bSiteLocalStore;
 local.configureSite({site_id:'synthetic-site',owner_subject:'synthetic-owner',binding_id:randomUUID(),generation:1},{authenticated:true});
 local.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
 f.transport.running=true;f.transport.stageStatus=()=>({running:true,ready:true,authenticated:true,transport_epoch:f.transport.epoch,runtime_manifest:{state:'accepted',transport_epoch:f.transport.epoch}});
 local.switchUser('site',{windowGesture:true});assert.equal(app.policy.enabled,false);
 assert.equal((await f.post('/api/upgrade/commit')).body.committed,true);assert.equal(app.policy.enabled,true);assert.equal(app.state.data.access_enabled,true);
});
test('1070 a trusted completion callback cannot enable execution while startup reconciliation is still pending',async t=>{
 const gate=deferred(),f=fixture(t,{preference:'none',reconcile:deps=>{armUpgradeGuard(deps.stateDir,VERSION,'synthetic-pending');return gate.promise;}});
 t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));t.after(()=>gate.resolve({reconciled:true}));
 await waitFor(()=>!!f.updateDeps);
 assert.equal(f.updateDeps.finishUpgrade().committed,true);
 const before=await f.rpc('begin_task');assert.equal(before.body.result.structuredContent.code,'UPGRADE_VERIFYING');
 gate.resolve({reconciled:true});const app=await f.building;
 assert.equal(app.tools.upgradePending,false);assert.equal(app.policy.enabled,true);
});
test('1070 trusted completion after close does not reopen execution',async t=>{
 const f=guarded(t),app=await f.building;await app.close();
 assert.equal(f.updateDeps.finishUpgrade().committed,true);
 assert.equal(app.tools.upgradePending,false);assert.equal(app.policy.enabled,false);assert.equal(app.store.paused,true);assert.equal(app.state.data.access_enabled,true);
 assert.throws(()=>app.policy.check(),{code:'LOCAL_DISABLED'});
});
