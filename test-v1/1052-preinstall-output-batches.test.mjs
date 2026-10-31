import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CommandQueue,redact} from '../engine/src/commands.mjs';import {FullOutputSpool,FullOutputCapture} from '../engine/src/full-output-spool.mjs';
import {FileStore} from '../engine/src/core.mjs';import crypto from 'node:crypto';
function fixture(t,options={}){const parent=fs.mkdtempSync(path.join(os.tmpdir(),'ch-preinstall-batch-'));fs.chmodSync(parent,0o700);const scope={job:'synthetic'},spool=new FullOutputSpool({parent,jobId:'synthetic',scope,...options}),capture=new FullOutputCapture(spool,redact);t.after(()=>{spool.dispose();fs.rmSync(parent,{recursive:true,force:true});});return {spool,capture,scope};}
const all=s=>[...s.spool.segments(0,s.spool.textBytes,s.spool.committedFileBytes)].map(v=>v.text).join('');
test('preinstall14 many short lines commit per input batch with two bounded file writes',t=>{
 const f=fixture(t),input='y\n'.repeat(32768),counts={write:0,stat:0},write=fs.writeSync,stat=fs.fstatSync;
 fs.writeSync=function(fd,...args){if(fd===f.spool.fdText||fd===f.spool.fdIndex)counts.write++;return write.call(this,fd,...args);};fs.fstatSync=function(fd,...args){if(fd===f.spool.fdText||fd===f.spool.fdIndex)counts.stat++;return stat.call(this,fd,...args);};
 try{f.capture.accept('stdout',Buffer.from(input));}finally{fs.writeSync=write;fs.fstatSync=stat;}
 assert.deepEqual(counts,{write:2,stat:2});assert.equal(f.spool.batchCount,1);assert.equal(f.spool.indexCount,2);assert.equal(all(f),input);assert.equal(f.spool.diskBytes(),f.spool.archiveBytes);assert.equal(f.spool.archiveBytes,Buffer.byteLength(input)+2*32);
});
test('preinstall14 physical frame and index bytes cap one final accepted batch; late data only drain',t=>{
 const f=fixture(t,{archiveLimitBytes:100});f.capture.accept('stdout',Buffer.from('y\n'.repeat(20)));assert.equal(f.spool.archiveBytes,72);f.capture.accept('stderr',Buffer.from('z\n'.repeat(20)));assert.equal(f.capture.limited,true);assert.equal(f.spool.outputLimited,true);assert.equal(f.spool.sealed,true);const n=f.spool.diskBytes();assert.equal(n,144);assert.ok(n<=100+f.spool.lastBatchBytes);f.capture.accept('stdout',Buffer.from('late ignored\n'));f.capture.endStream('stderr');assert.equal(f.spool.diskBytes(),n);assert.ok(f.capture.channels.every(c=>c.pendingBytes===0));assert.equal(all(f),'y\n'.repeat(20)+'z\n'.repeat(20));
});
test('preinstall14 line-wise redaction, split Unicode and EOF are unchanged by batch writes',t=>{
 const f=fixture(t),a=Buffer.from('DB_PASSWORD=FAKE-SECRET-0991\n🙂first\ntoken\n =not_an_assignment\ntail🙂');for(let i=0;i<a.length;i+=3)f.capture.accept('stdout',a.subarray(i,i+3));f.capture.accept('stderr',Buffer.from('GITHUB_TOKEN=FAKE-SECRET-0992\nerr'));f.capture.endStream('stdout');f.capture.endStream('stderr');const text=all(f);assert.equal(text,'DB_PASSWORD=[REDACTED]\n🙂first\ntoken\n =not_an_assignment\nGITHUB_TOKEN=[REDACTED]\ntail🙂err');assert.equal(text.includes('FAKE-SECRET-099'),false);assert.equal(f.spool.sealed,true);f.capture.endStream('stdout');assert.equal(all(f),text);
});
test('preinstall14 index write failure publishes no partial batch bookkeeping',t=>{
 const f=fixture(t),old=fs.writeSync;fs.writeSync=(fd,...args)=>{if(fd===f.spool.fdIndex)throw Error('fake-only');return old(fd,...args);};try{assert.throws(()=>f.capture.accept('stdout',Buffer.from('visible\n')),{code:'OUTPUT_SPOOL_WRITE_FAILED'});}finally{fs.writeSync=old;}assert.equal(f.spool.textBytes,0);assert.equal(f.spool.indexCount,0);assert.throws(()=>f.spool.read({scope:f.scope}),{code:'OUTPUT_SPOOL_WRITE_FAILED'});
});
test('preinstall14 amortized trim preserves original cursors and exact final byte limit',()=>{
 const q=Object.create(CommandQueue.prototype);q.outputLimit=10;const j={events:[],next_cursor:0,base_cursor:0,kept_bytes:0,truncated:false};const original=[];for(let n=0;n<100;n++){const text=n%3?'y\n':'🙂\n';original.push({cursor:n,stream:'stdout',text});q.appendOutput(j,'stdout',text);assert.ok(j.kept_bytes<=13);}
 q.trimOutput(j);let bytes=original.reduce((n,e)=>n+Buffer.byteLength(e.text),0);while(bytes>10)bytes-=Buffer.byteLength(original.shift().text);assert.deepEqual(j.events,original);assert.equal(j.kept_bytes,bytes);assert.equal(j.base_cursor,original[0].cursor);assert.equal(j.next_cursor,100);
});
for(const action of ['cancel','close'])test(`preinstall14 ${action} inside paused data callback still drains EOF Unicode tail`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch-preinstall-pause-')),work=path.join(root,'work');fs.mkdirSync(work);const q=new CommandQueue(new FileStore(work,path.join(root,'state')));t.after(async()=>{await q.close();fs.rmSync(root,{recursive:true,force:true});});
 const j=q.propose({request_id:crypto.randomUUID(),program:process.execPath,args:['-e',"process.stdout.write('final🙂');setInterval(()=>{},1000)"]}),scope={job:j.job_id};q.bindFullOutput(j.job_id,scope);let hit=false,closing;
 q.inspectChunk=job=>{if(hit)return;hit=true;if(action==='close')closing=q.close();else q.cancel(job.id);};q.approve(j.job_id);
 const end=Date.now()+3000;while(!hit&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.equal(hit,true);if(closing)await closing;else await q.result(j.job_id,2000);
 const job=q.get(j.job_id);assert.equal(job.child,null);assert.equal(job.cleanupPending??false,false);assert.equal(job.events.map(e=>e.text).join(''),'final🙂');if(action==='cancel'){const p=await q.resultFull(j.job_id,{scope});assert.equal(p.segments.map(s=>s.text).join(''),'final🙂');assert.equal(p.final_total,true);}
});
