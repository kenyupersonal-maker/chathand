import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {needsInterface,browserControlOptedIn} from '../app/server.mjs';
import {DesktopState} from '../app/state.mjs';
import {helperFolder} from '../app/v1/chrome-helper-source.mjs';
import {applyPermissionTier} from '../app/v1/permissions.mjs';
import {ChromeInstallProbe} from '../app/v1/chrome-install-probe.mjs';
import {fixture,deferred,waitFor} from './1070-startup-fixture.mjs';

for(const enabled of [true,false])test('1070 transport starts during deferred reconciliation and Chrome registration, preserving access intent='+enabled,async t=>{
 const gate=deferred(),chrome=deferred(),f=fixture(t,{enabled,browser:true,optedIn:true,reconcile:()=>gate.promise,register:()=>chrome.promise});
 t.after(()=>{gate.resolve({reconciled:false});chrome.resolve({registered:true});});
 await waitFor(()=>f.calls.starts===1);assert.equal(f.calls.registers,0);assert.equal(f.app,undefined);
 await f.advance(1000);
 const blocked=await f.rpc('begin_task');assert.equal(blocked.body.result.isError,true);
 gate.resolve({reconciled:false});const app=await f.building;await waitFor(()=>f.calls.registers===1);await app.snapshot();
 assert.equal(app.tools.upgradePending,false);assert.equal(app.policy.enabled,enabled);assert.equal(app.state.data.access_enabled,enabled);
 assert.equal(f.calls.starts,1);assert.equal(f.calls.registers,1);
 chrome.resolve({registered:true});
});
test('1070 failed reconciliation never releases execution or persisted user intent',async t=>{
 const f=fixture(t,{reconcile:async()=>{throw Object.assign(Error('PRIVATE_EXCEPTION'),{code:'PRIVATE_EXCEPTION'});}}),app=await f.building;
 await waitFor(()=>f.calls.starts===1);await app.snapshot();
 assert.equal(app.tools.upgradePending,true);assert.equal(app.policy.enabled,false);assert.equal(app.state.data.access_enabled,true);
 await assert.rejects(app.handle('/api/access',{enabled:true}),{code:'UPGRADE_VERIFYING'});
 const view=await app.snapshot();assert.equal(view.upgrade_pending,true);assert.deepEqual(view.connection.startup_reconciliation,{state:'blocked',reason_code:'UPGRADE_CURRENT_INVALID'});
 assert.equal(JSON.stringify(view.connection.startup_reconciliation).includes('PRIVATE'),false);
});
test('1070 local ready with cloud pending keeps 1s observation; confirmed idle cloud returns to 5s',async t=>{
 const f=fixture(t),app=await f.building;await waitFor(()=>f.calls.starts===1);await app.snapshot();
 const source=app.maintenance.sources.get('connection');
 const checking=source.next();assert.equal(app.controller.phase,'ready');
 f.calls.cloud='up';await app.snapshot();assert.equal(source.next()-checking,4000);
 f.calls.cloud='unknown';await app.snapshot();assert.equal(source.next(),checking);f.elapse(60000);assert.equal(source.next()-checking,4000);
});
test('1070 successful authenticated HTTP call records a first-call event after health is up',async t=>{
 const f=fixture(t);const app=await f.building;f.calls.cloud='up';await waitFor(()=>f.calls.starts===1);await app.snapshot();
 const count=()=>app.tools.events.timelineSnapshot().filter(row=>row.kind==='conn.cloud'&&row.reason==='call_ok').length;
 assert.equal(count(),0);const result=await f.rpc('connection_check');assert.equal(result.body.result.isError,false);assert.equal(count(),1);
 await f.rpc('connection_check');assert.equal(count(),1);
});
test('1070 pending reconciliation cannot release execution merely because the persisted guard is absent',async t=>{
 const f=fixture(t,{reconcile:async()=>({pending:true,code:'UPGRADE_STILL_RUNNING'})}),app=await f.building;
 assert.equal(app.tools.upgradePending,true);assert.equal(app.policy.enabled,false);assert.equal(f.updateDeps.guard.inspect().active,false);
 await assert.rejects(app.handle('/api/access',{enabled:true}),{code:'UPGRADE_VERIFYING'});
});
