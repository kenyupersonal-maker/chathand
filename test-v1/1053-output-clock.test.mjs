import test from 'node:test';import assert from 'node:assert/strict';import {desktop} from './1052-a-fixture.mjs';import {diffState} from '../app/v1/events.mjs';
test('maintenance clock is global and does not make every unchanged job differ',async t=>{
 const f=await desktop(t),q=f.app.queue;let now=10000;q.retentionClock={...q.retentionClock,now:()=>now};
 const j={id:'synthetic-job',request_id:'synthetic-request',status:'completed',program:'fixture',args:[],events:[],next_cursor:0,base_cursor:0,kept_bytes:0,created_at:100,finished_at:100,exit_code:0};q.jobs.set(j.id,j);
 q.maintainOutputs();const first=q.publicJob(j),a={jobs:[first],output_retention_status:q.outputStatus()};now+=1000;q.maintainOutputs();const second=q.publicJob(j),b={jobs:[second],output_retention_status:q.outputStatus()};
 assert.deepEqual(first,second);assert.equal('checked_at' in second.output_retention_status,false);assert.equal(b.output_retention_status.checked_at,11000);assert.deepEqual(diffState(a,b),{});
 q.appendOutput(j,'stdout','new line\n');assert.ok(diffState(b,{...b,jobs:[q.publicJob(j)]}).jobs);
 q.list=()=>assert.fail('maintenance tick must not build public jobs through list');f.tick();
});
