import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {desktop} from './1052-a-fixture.mjs';
test('preinstall16 waiting full reader rechecks removed archive and returns clean fallback code',async t=>{
 const f=await desktop(t),task_id=await f.begin(),q=f.app.queue,j=f.ok(await f.rpc('propose_command',{task_id,request_id:crypto.randomUUID(),program:process.execPath,args:['-e',"setTimeout(()=>{},1000)"],wait_ms:0})),scope=q.fullScopes.get(j.job_id),first=await q.resultFull(j.job_id,{scope});assert.ok(first.next_full_cursor);const entry=q.fullOutputs.get(j.job_id);
 const pending=q.resultFull(j.job_id,{scope,full_cursor:first.next_full_cursor,wait_ms:500});setTimeout(()=>{entry.capture.abandon();entry.spool.dispose();entry.spool=null;entry.capture=null;q.get(j.job_id).capture_error='OUTPUT_SPOOL_CLEANED';},10);
 await assert.rejects(pending,{code:'FULL_OUTPUT_UNAVAILABLE'});assert.equal(q.get(j.job_id).status,'running');q.cancel(j.job_id);await q.result(j.job_id,2000);
});
