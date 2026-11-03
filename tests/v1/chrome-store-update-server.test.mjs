import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fixture,waitFor} from './1070-chrome-server-fixture.mjs';
import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';
const helper={...storeTestHelper(),version:'1.0.0.1090',features:[...storeTestHelper().features,'store_update_v1']};
test('actual update route requires owner/window authentication and an empty body, then returns the extension state',async t=>{
 const f=fixture(t,{chromeDistribution:storeTestDistribution(),browser:true,optedIn:true}),app=await f.building,ext=app.tools.automation.browser.extension;
 f.calls.cloud='up';await waitFor(()=>f.calls.starts===1);await app.snapshot();ext.next(crypto.randomUUID(),helper);
 assert.equal((await f.post('/api/browser/extension/update',{}, {owner:false})).status,401);
 assert.equal((await f.post('/api/browser/extension/update',{}, {ui:false})).status,403);
 assert.equal((await f.post('/api/browser/extension/update',{force:true})).body.error.code,'ARG_INVALID');
 const out=await f.post('/api/browser/extension/update');assert.equal(out.status,200);assert.equal(out.body.update.state,'checking');assert.equal(out.body.helper.version,helper.version);assert.equal(out.body.connected,true);
 const status=await f.post('/api/browser/extension/store/status');assert.equal(status.body.update.id,out.body.update.id);
});
test('actual reconnect route returns BROWSER_BUSY before registration and leaves a browser action intact',async t=>{
 const f=fixture(t,{chromeDistribution:storeTestDistribution(),browser:true,optedIn:true}),app=await f.building,ext=app.tools.automation.browser.extension;
 f.calls.cloud='up';await waitFor(()=>f.calls.starts===1);await app.snapshot();const session=crypto.randomUUID();ext.next(session,helper);ext.pauseRequested=false;
 // The real updateBusy callback observes task work as well as queued browser actions.
 const task=app.policy.begin({request_id:'synthetic-live-browser-task',title:'Synthetic browser work'},'chatgpt');
 const pending=ext.request('snapshot',{},'chatgpt',task.task_id);pending.catch(()=>{});
 const before=f.calls.registers,out=await f.post('/api/browser/extension/reconnect');assert.equal(out.body.error.code,'BROWSER_BUSY');assert.equal(f.calls.registers,before);assert.equal(ext.session,session);assert.equal(ext.reconnectRequested,false);assert.equal(ext.pending.size,1);ext.cancelAll();await assert.rejects(pending,{code:'TASK_REVOKED'});
});

test('a no-update store result retains incompatible capability status and never claims a successful update',async t=>{
 const f=fixture(t,{chromeDistribution:storeTestDistribution(),browser:true,optedIn:true}),app=await f.building,ext=app.tools.automation.browser.extension;f.calls.cloud='up';await waitFor(()=>f.calls.starts===1);await app.snapshot();const session=crypto.randomUUID(),old={...helper,actions:[]};ext.next(session,old);const out=await f.post('/api/browser/extension/update');ext.next(session,{...old,update:{id:out.body.update.id,state:'no_update',from_version:old.version,target_version:null,sequence:1}});const state=await f.post('/api/browser/extension/store/status');assert.equal(state.body.update.state,'no_update');assert.equal(state.body.compatibility.state,'incompatible');assert.equal(state.body.helper.state,'incompatible');
});
