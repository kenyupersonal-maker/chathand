import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';
const fixture=(t,options)=>productionFixture(t,{...options,chromeDistribution:storeTestDistribution()});
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {needsInterface,browserControlOptedIn} from '../../app/server.mjs';
import {DesktopState} from '../../app/state.mjs';
import {helperFolder} from '../../app/v1/chrome-helper-source.mjs';
import {applyPermissionTier} from '../../app/v1/permissions.mjs';
import {ChromeInstallProbe} from '../../app/v1/chrome-install-probe.mjs';
import {fixture as productionFixture,deferred,waitFor} from './1070-chrome-server-fixture.mjs';

for(const browser of [undefined,false])test('1070 no Chrome files or discovery before explicit opt-in='+browser,async t=>{
 const f=fixture(t,{browser,preference:'none'}),app=await f.building;await new Promise(r=>setTimeout(r,60));
 const folder=helperFolder(path.join(f.stateDir,'integration-home'));
 assert.equal(f.calls.registers,0);assert.equal(fs.existsSync(folder),false);
 assert.equal((await f.post('/api/browser/extension/prepare',{}, {owner:false})).status,401);
 const prepared=await f.post('/api/browser/extension/prepare',{}, {ui:false});assert.equal(prepared.body.error.code,'INSTALL_ACCESS_CHANGED');
 for(const route of ['profiles','start'])assert.equal((await f.post('/api/browser/extension/install/'+route,{discovery_only:true})).body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');
 assert.equal((await f.post('/api/browser/extension/reconnect',{}, {ui:false})).status,403);
 await f.post('/api/browser/extension/reconnect');assert.equal(f.calls.registers,0);assert.equal(fs.existsSync(folder),false);
 assert.equal((await f.post('/api/settings',{browser_enabled:true},{ui:false})).status,403);assert.equal(app.state.data.browser_enabled,browser);
 assert.equal((await f.post('/api/settings',{browser_enabled:true})).status,200);
 const result=await f.post('/api/browser/extension/prepare',{}, {ui:false});assert.equal(result.status,200);assert.equal(result.body.registered,true);assert.equal(f.calls.registers,1);assert.equal(fs.existsSync(folder),false);
});
test('1070 access denial does not retry through prepare/recheck; permission recovery retains owner and current UI authentication',async t=>{
 let denied=true;const f=fixture(t,{browser:true,optedIn:true,preference:'none',register:()=>{if(denied)throw Object.assign(Error('Synthetic denial'),{code:'CHROME_DATA_ACCESS_DENIED'});return {registered:true};}});await f.building;
 await waitFor(()=>f.calls.registers===1);
 assert.equal((await f.post('/api/browser/extension/prepare',{}, {ui:false})).body.error.code,'CHROME_DATA_ACCESS_DENIED');assert.equal(f.calls.registers,2);
 await f.post('/api/browser/extension/reconnect');assert.equal(f.calls.registers,2);
 assert.equal(needsInterface('/api/browser/extension/prepare',{}),false);
 assert.equal(needsInterface('/api/browser/extension/prepare',{retry_after_permission:true}),true);
 assert.equal((await f.post('/api/browser/extension/prepare',{retry_after_permission:true},{owner:false})).status,401);
 assert.equal((await f.post('/api/browser/extension/prepare',{retry_after_permission:true},{ui:false})).status,403);assert.equal(f.calls.registers,2);
 assert.equal((await f.post('/api/browser/extension/prepare',{retry_after_permission:true})).body.error.code,'ARG_INVALID');assert.equal(f.calls.registers,2);
 denied=false;const prepared=await f.post('/api/browser/extension/prepare',{}, {ui:false});assert.equal(prepared.body.registered,true);assert.equal(f.calls.registers,3);assert.equal(prepared.body.opened,undefined);
});

test('1070 default full setup keeps existing tier semantics without authorizing Chrome files; explicit native installation records opt-in',async t=>{
 const f=fixture(t,{preference:'none'}),app=await f.building;
 await applyPermissionTier({state:app.state,store:app.store,policy:app.policy,adminAccess:{supported:()=>false}},{tier:'full',defaultSetup:true});
 assert.equal(app.state.data.browser_enabled,true);assert.equal(app.state.data.mode,'full');assert.equal(app.state.data.permission_origins['capability:browser'].via,'tier');
 assert.equal(browserControlOptedIn(app.state.data),false);
 await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(f.calls.registers,0);
 const prepared=await f.post('/api/browser/extension/prepare',{}, {ui:false});assert.equal(prepared.body.registered,true);
 assert.equal((await f.post('/api/browser/extension/install/profiles',{discovery_only:true},{ui:false})).status,403);
 assert.equal(app.state.data.browser_control_opt_in,true);
 assert.equal((await f.post('/api/browser/extension/install/profiles',{discovery_only:true})).body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');
 assert.equal(app.state.data.browser_control_opt_in,true);assert.equal(f.calls.registers,1);
 const saved=new DesktopState(f.stateDir);assert.equal(saved.data.browser_control_opt_in,true);
 assert.equal((await f.post('/api/browser/extension/prepare')).body.registered,true);
 assert.equal((await f.post('/api/settings',{browser_control_opt_in:true},{ui:false})).status,400);
});
test('1070 legacy migration accepts only ChatHand evidence of explicit browser settings, never a tier default or helper sighting',()=>{
 const base={browser_enabled:true,extension_last_seen:Date.now(),chrome_install_profile:'Default'};
 assert.equal(browserControlOptedIn(base),false);
 assert.equal(browserControlOptedIn({...base,permission_origins:{'capability:browser':{via:'tier',since:Date.now()}}}),false);
 assert.equal(browserControlOptedIn({...base,permission_origins:{'capability:browser':{via:'settings',since:Date.now()}}}),true);
 assert.equal(browserControlOptedIn({...base,permission_origins:{'capability:browser':{via:'settings'}}}),false);
 assert.equal(browserControlOptedIn({...base,browser_enabled:false,browser_control_opt_in:true}),false);
});
test('1070 owner/UI-protected progress forwards no-lease choose_profile and attempt identity without changing or logging the payload',async t=>{
 const f=fixture(t,{preference:'none'}),app=await f.building,probe=app.tools.automation.browser.extension.installProbe;
 const attempt_id='00000000-0000-4000-8000-000000000001',payload={native_event:'choose_profile',choose_profile:true,profiles:[{id:'Default',name:'Default',installed:false,enabled:false},{id:'Profile 1',name:'Profile 1',installed:false,enabled:false}],selected_profile:'',repair:true,attempt_id};
 let forwarded=null,requested=null;
 t.mock.method(probe,'progress',(lease,stage,data)=>{forwarded={lease,stage,data};return {recorded:true};});
 t.mock.method(probe,'publicStatus',(lease,attempt)=>{requested={lease,attempt};return {...payload,phase:'choose_profile',active:true};});
 assert.equal((await f.post('/api/browser/extension/install/progress',payload,{owner:false})).status,401);
 assert.equal((await f.post('/api/browser/extension/install/progress',payload,{ui:false})).status,403);assert.equal(forwarded,null);
 assert.equal((await f.post('/api/browser/extension/install/progress',payload)).body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');
 assert.equal(forwarded,null);
 assert.equal((await f.post('/api/browser/extension/install/status',{attempt_id},{ui:false})).status,403);
 const result=await f.post('/api/browser/extension/install/status',{attempt_id});
 assert.equal(result.body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');assert.equal(result.body.attempt_id,undefined);assert.equal(result.body.profiles,undefined);assert.equal(requested,null);
 const timeline=app.tools.events.timelineSnapshot();assert.equal(JSON.stringify(timeline).includes(attempt_id),false);
});
test('1070 an explicit manual-install request from the current window records Browser Use opt-in; owner-only preparation cannot',async t=>{
 const f=fixture(t,{browser:true,preference:'none'}),app=await f.building;
 assert.equal((await f.post('/api/browser/extension/prepare',{}, {ui:false})).body.registered,true);assert.equal(app.state.data.browser_control_opt_in,true);
 assert.equal((await f.post('/api/browser/extension/prepare')).body.registered,true);assert.equal(app.state.data.browser_control_opt_in,true);
});
test('1070 integrated native waiting/choose-profile status and stale cancel preserve the new attempt', {skip:typeof ChromeInstallProbe.prototype.nativeProfileChoice!=='function'?'Chrome owner choose-profile module not integrated':false},async t=>{
 const f=fixture(t,{browser:true,preference:'none',statePatch:{desktop_enabled:true}}),app=await f.building;
 const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
 for(const attempt_id of [first,second])for(const suffix of ['progress','status','cancel']){
  const result=await f.post('/api/browser/extension/install/'+suffix,{attempt_id,native_event:'started',stage:'waiting_accessibility',elapsed_ms:0,target_is_default:null});assert.equal(result.body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');assert.equal(result.body.active,undefined);assert.equal(result.body.profiles,undefined);
 }
 assert.equal(app.tools.automation.browser.extension.installProbe.nativeProgress,null);
 const file=path.join(f.stateDir,'diagnostics/events.jsonl'),rows=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';assert.equal(rows.includes(first),false);assert.equal(rows.includes('Profile 1'),false);
});

test('1070 first explicit installation persists opt-in before the strict probe gate and rejects raw disabled desktop first',async t=>{
 const f=fixture(t,{browser:true,preference:'none',statePatch:{desktop_enabled:false}}),app=await f.building,probe=app.tools.automation.browser.extension.installProbe;
 const denied=await f.post('/api/browser/extension/install/profiles',{discovery_only:true});
 assert.equal(denied.body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');assert.equal(app.state.data.browser_control_opt_in,undefined);
 app.state.data.desktop_enabled=true;app.state.save();let checked=0;
 t.mock.method(probe,'allowed',()=>{checked++;assert.equal(browserControlOptedIn(app.state.data),true);assert.equal(new DesktopState(f.stateDir).data.browser_control_opt_in,true);});
 const allowed=await f.post('/api/browser/extension/install/profiles',{discovery_only:true});
 assert.equal(allowed.body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');assert.equal(checked,0);assert.equal(f.calls.registers,0);
});
test('1070 start/cancel bridge keeps the acknowledged native attempt identity', {skip:typeof ChromeInstallProbe.prototype.nativeProfileChoice!=='function'?'Chrome draft dependency is not integrated':false},async t=>{
 const f=fixture(t,{browser:true,preference:'none',statePatch:{desktop_enabled:true}});await f.building;
 const id='00000000-0000-4000-8000-000000000003',wrong='00000000-0000-4000-8000-000000000004';
 for(const attempt_id of [id,wrong]){const rejected=await f.post('/api/browser/extension/install/start',{profile_id:'Default',attempt_id});assert.equal(rejected.body.error.code,'CHROME_INSTALL_LEGACY_DISABLED');assert.equal(rejected.body.lease_id,undefined);}
 assert.equal(f.calls.registers,0);
 const prepared=(await f.post('/api/browser/extension/prepare',{}, {ui:false})).body;assert.equal(prepared.registered,true);assert.equal(prepared.lease_id,undefined);assert.equal(f.calls.registers,1);
 assert.equal((await f.post('/api/browser/extension/store/cancel',{attempt_id:id})).body.error.code,'ARG_INVALID');
 const stopped=(await f.post('/api/browser/extension/store/cancel',{})).body;assert.equal(stopped.cancelled,true);assert.equal(stopped.profile_verified,undefined);
});
