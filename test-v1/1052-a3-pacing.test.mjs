import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {PACING,stallBudget} from '../app/v1/pacing.mjs';
import {ResumeKeeper} from '../app/v1/resume.mjs';
import {RELAY,RelayKeeper} from '../app/v1/relay-keeper.mjs';
import {RETURN_LIMIT_CHARS,compactToolReturn} from '../app/v1/return-archive.mjs';
import {CommandQueue} from '../engine/src/commands.mjs';
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'ch1052-a3-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('agreed pacing values stay exact and immutable; classified Pro floor is ready but not wired early',()=>{
 assert.deepEqual(PACING,{block:{fine:{calls:10,ms:150000},medium:{calls:20,ms:270000},coarse:{calls:40,ms:540000}},wait:{poll_ms:20000,note_ms:300000,ready_after_end_ms:5000},return_limit_chars:12000,stall:{cap_ms:600000,floor_pro_ms:360000},auto:{per_task:5,per_block:2,countdown_ms:20000}});
 assert.throws(()=>{PACING.block.medium.calls=1;},TypeError);assert.equal(stallBudget(164000,'pro'),360000);assert.equal(stallBudget(900000,'pro'),600000);assert.equal(stallBudget(164000,'thinking'),164000);
});
test('stall cap bounds longest-gap inflation in both data and provisional paths and keeps ordinary 164s',()=>{
 const r=new ResumeKeeper();r.sessions.set('h',{longest_gap:540000});assert.equal(r.threshold('h').ms,600000);r.data.gaps=Array(250).fill(82000);assert.equal(r.threshold('h').ms,600000);r.sessions.get('h').longest_gap=0;assert.equal(r.threshold('h').ms,164000);assert.equal(r.threshold(null).ms,164000);r.data.gaps=Array(200).fill(900000);assert.equal(r.threshold(null).ms,600000);
});
test('engine independently accepts the pacing wait maximum and refuses one millisecond more',async()=>{
 const j={status:'completed'},fake={get:()=>j,maintainOutputs(){},publicJob:x=>x};assert.equal(await CommandQueue.prototype.result.call(fake,'synthetic',PACING.wait.poll_ms),j);await assert.rejects(CommandQueue.prototype.result.call(fake,'synthetic',PACING.wait.poll_ms+1),{code:'ARG_INVALID'});
});
test('real relay consumes five logical auto sends only, then preserves manual continuation',t=>{
 const root=temp(t),ctx={caller:'synthetic',session_hash:'a'.repeat(64),transport:'mcp_app'};let now=100000,seq=0;
 const r=new RelayKeeper({file:path.join(root,'relay.sqlite'),now:()=>now,installationEligible:true,readTask:()=>({status:'active',enabled:true,stopped:false,paused:false,session_hash:ctx.session_hash,epoch:0,revision:0,checkpoint_seq:seq,manual_resume_allowed:true,auto_allowed:true})});t.after(()=>r.close());assert.equal(RELAY.max_auto_rounds,5);assert.equal(RELAY.countdown_ms,20000);
 for(let n=1;n<=5;n++){seq=n;r.checkpoint({task_id:'task',checkpoint_seq:seq,continuing:true},ctx);const c=r.interruption({task_id:'task'},ctx),args={task_id:'task',card_token:c._relay_meta.card_token,mode:'auto'};assert.equal(r.claim(args,ctx).reason,'too_early');now+=PACING.auto.countdown_ms;const claim=r.claim(args,ctx);assert.equal(claim.granted,true);const dispatch=r.beginDispatch({task_id:'task',permit_token:claim.permit_token},ctx);assert.equal(dispatch.send,true);assert.equal(r.beginDispatch({task_id:'task',permit_token:claim.permit_token},ctx).send,false);r.report({attempt_id:dispatch.attempt_id,report_token:claim.permit_token,outcome:'accepted'},ctx);const start=r.noteToolStart({task_id:'task',call_id:'call-'+n},ctx);r.noteToolEnd({call_key:start.call_key});}
 seq++;r.checkpoint({task_id:'task',checkpoint_seq:seq,continuing:true},ctx);const c=r.interruption({task_id:'task'},ctx);assert.equal(c.relay.auto_rounds,5);assert.equal(c.relay.state,'limit');assert.equal(r.claim({task_id:'task',card_token:c._relay_meta.card_token,mode:'auto'},ctx).granted,false);assert.equal(r.claim({task_id:'task',card_token:c._relay_meta.card_token,mode:'manual',request_id:'manual-after-limit'},ctx).granted,true);
});
test('return budget comes directly from pacing; eager archive and 12k projected guard retain old boundaries',t=>{
 const root=temp(t),store={root,checkActive(){},writable:rel=>path.join(root,rel)};assert.equal(RETURN_LIMIT_CHARS,PACING.return_limit_chars);
 const privateSource={content:'中'.repeat(5000),nonce:'CONTROL'},unchanged=compactToolReturn(privateSource,{store,tool:'read_text'});assert.equal(unchanged,privateSource);assert.equal(unchanged.nonce,'CONTROL');assert.equal(fs.existsSync(path.join(root,'ChatHand-工具返回.noindex')),false);
 const compact=compactToolReturn({content:privateSource.content,receipt_id:'CONTROL'}, {store,tool:'read_text'});assert.equal(compact.output_summary.compacted,true);assert.equal(compact.receipt_id,'CONTROL');assert.equal(fs.readFileSync(compact.output_summary.file_path,'utf8'),'中'.repeat(5000));
 const many={items:Array.from({length:35},()=>({content:'中'.repeat(1000)}))};const array=compactToolReturn(many,{store,tool:'read_text'});assert.equal(array.output_summary.compacted,true);assert.equal(array.output_summary.saved,true);assert.deepEqual(JSON.parse(fs.readFileSync(array.output_summary.file_path,'utf8')),many);assert.ok(JSON.stringify(array).length<=12000);
});
test('existing widget scheduling matches agreed clocks without changing UI or Site transport',()=>{
 const source=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');const functions=['cardAge','pollBudgetLeft','pollGap'].map(name=>source.match(new RegExp('function '+name+'\\([^]*?\\n?\\}'))?.[0]);assert.ok(functions.every(Boolean));
 const c=vm.createContext({Date:{now:()=>10000000},cardBorn:10000000,relayToken:'synthetic',observationNonce:null,current:{task:{relay:{state:'armed',auto_enabled:true}}}});vm.runInContext(functions.join('\n'),c);assert.equal(vm.runInContext('pollGap()',c),2000);c.current.task.relay={wait:{state:'running'}};assert.equal(vm.runInContext('pollGap()',c),30000);c.current.task.relay={};assert.equal(vm.runInContext('pollGap()',c),15000);c.cardBorn=10000000-1200000;assert.equal(vm.runInContext('pollGap()',c),60000);c.relayToken=null;c.cardBorn=10000000-600000;assert.equal(vm.runInContext('pollGap()',c),30000);assert.equal(vm.runInContext('pollBudgetLeft()',c),true);c.cardBorn--;assert.equal(vm.runInContext('pollBudgetLeft()',c),false);c.relayToken='synthetic';c.cardBorn=10000000-7200000;assert.equal(vm.runInContext('pollBudgetLeft()',c),true);c.cardBorn--;assert.equal(vm.runInContext('pollBudgetLeft()',c),false);
});
