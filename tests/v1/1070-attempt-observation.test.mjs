import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,waitFor} from './1070-startup-fixture.mjs';

for(const kind of ['delayed first connection','reconnect'])test('1070 '+kind+' gets its own bounded fast cloud observation window',async t=>{
 const f=fixture(t,{preference:kind==='reconnect'?'tunnel':'none'});
 t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 const app=await f.building;
 if(kind==='reconnect'){
  await waitFor(()=>f.calls.starts===1);f.calls.cloud='up';await app.snapshot();
  assert.equal(app.controller.phase,'ready');
 }
 f.elapse(60000);f.calls.cloud='checking';
 await app.handle('/api/connect/restore',{});
 if(kind==='reconnect')await f.advance(1500);
 await waitFor(()=>f.calls.starts===(kind==='reconnect'?2:1));await app.controller.busy;
 await app.snapshot();await f.advance(0);
 assert.equal(app.controller.phase,'ready');assert.ok(Number.isFinite(app.controller.attemptStartedAt));
 const source=app.maintenance.sources.get('connection'),fast=source.next();
 f.elapse(44999);assert.equal(source.next(),fast);
 f.elapse(1);assert.equal(source.next()-fast,4000,'an idle attempt returns to 5s after its own 45s window');
});
test('1070 ready state without a transport attempt retains idle observation cadence',async t=>{
 const f=fixture(t,{preference:'none'});t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));const app=await f.building;
 assert.equal(app.controller.attemptStartedAt,undefined);assert.equal(app.controller.startedAt,0);
 app.controller.desired=true;app.controller.phase='ready';f.tunnel.child={pid:0};
 const source=app.maintenance.sources.get('connection'),idle=source.next();
 await f.advance(1000);assert.equal(f.calls.starts,0);assert.equal(source.next(),idle);
 f.elapse(45000);assert.equal(source.next(),idle,'process age never creates an attempt window');
});
