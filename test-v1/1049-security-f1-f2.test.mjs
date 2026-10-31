import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../app/server.mjs';
import {sessionHashOf} from '../app/v1/resume.mjs';
import {TOOLS} from '../app/tools.mjs';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-r2-bound-'));
 const work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({
  stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'a'.repeat(64),
  adminAccess:{supported:()=>false,ready:()=>false},
  clientDeps:{
   currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic F1/F2 Mac',
   tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
   updaterFactory:()=>({currentBuild:1048,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
  }
 });
 app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 let id=0,clock=Date.now();app.tools.relayKeeper.now=()=>clock;app.tools.resume.now=()=>clock;app.tools.h8Cards.now=()=>clock;app.tools.resume.data.gaps=Array(200).fill(1000);
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 async function rpc(name,args={},o={}){
  const session=o.session??'conv-A',principal=o.principal??'account-A',caller=o.caller??'chatgpt';
  const body={jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,
   _meta:{'openai/session':session,'io.modelcontextprotocol/protocolVersion':o.modern===false?'2025-11-25':'2026-07-28'}}};
  return (await app.tools.rpc(body,caller,{setupPrincipal:principal})).result;
 }
 const success=r=>{assert.equal(r?.isError,false,JSON.stringify(r?.structuredContent));return r.structuredContent;};
 const fail=(r,code)=>{assert.equal(r?.isError,true);assert.equal(r.structuredContent?.code,code);return r.structuredContent;};
 const session=(v='conv-A',principal='account-A')=>sessionHashOf(principal,v);
 const ctx=(v='conv-A',principal='account-A',caller='chatgpt')=>({caller,session_hash:session(v,principal),transport:'mcp_app'});
 async function begin(label,opts={}){
  return success(await rpc('begin_task',{request_id:'f1f2_'+label+'_'+crypto.randomUUID(),title:'Test F1/F2 '+label},opts)).task_id;
 }
 async function arm(task_id,o={}){
  const r=await rpc('task_checkpoint',{task_id,done:'已经完成安全块',next:'接着做：核对任务归属'},o);
  success(r);clock+=600001;const seen=await rpc('relay_card_control',{action:'view',task_id,card_token:r._meta['chathand/relay_card_token']},o);const witness=seen._meta['chathand/relay_interruption_token'];assert.match(witness,/^[a-f0-9]{64}$/);const interrupted=await rpc('relay_card_control',{action:'interruption',task_id,interruption_token:witness},o);const data=success(interrupted),token=interrupted._meta['chathand/relay_card_token'];
  assert.match(token,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(data).includes(token),false);
  return {token,data};
 }
 const view=(id,token,o={})=>app.tools.relayKeeper.view({task_id:id,card_token:token},ctx(o.session,o.principal,o.caller));
 const activate=async()=>{await app.handle('/api/settings',{relay_pilot_enable:true});assert.equal(app.tools.relayKeeper.installationEligible,true);};
 const activeCalls=()=>Object.keys(JSON.parse(app.tools.relayKeeper.db.prepare('SELECT value FROM relay_state WHERE id=1').get().value).active_calls);
 return {root,app,rpc,success,fail,session,ctx,begin,arm,view,activate,activeCalls,advance:ms=>{clock+=ms;}};
}
const fingerprint=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('F1 production RPC: authenticated session continuation works while project/root/epoch still fence effects',async t=>{
 const f=await fixture(t);await f.activate();
 const id=await f.begin('owner');
 const wrote=f.success(await f.rpc('log_note',{task_id:id,event:'owner',summary:'synthetic local note'}));
 assert.equal(wrote.recorded,true);
 const first=await f.arm(id);
 const file=path.join(f.app.store.stateDir,'activity-records',id+'.jsonl');
 const original=fingerprint(file),progress=f.app.tools.resume.tasks.get(id);
 const seq=progress.checkpoint_seq;
 const trusted=f.app.tools.h8Cards.context(id,'chatgpt',f.session(),'2026-07-28');
 const marker=f.app.tools.h8Cards.issue('option:'+id,trusted,Date.now()+60_000);
 const digest=crypto.createHash('sha256').update(marker).digest('hex');
 assert.equal(f.app.tools.h8Cards.tokens.has(digest),true);

 const wrong={session:'conv-B'};
 const crossStatus=f.success(await f.rpc('task_status',{task_id:id,include_activity:true},wrong));
 assert.equal(crossStatus.task_id,id);assert.equal(crossStatus.activity_notes.items[0].summary,'synthetic local note');
 assert.ok(!JSON.stringify(crossStatus).includes(marker),'status never exposes private option capability');
 const badCapability=await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:first.token},wrong);
 f.fail(badCapability,'RELAY_CARD_INVALID');
 assert.equal(f.view(id,first.token).state,'armed','private card nonce stays session-bound');
 const crossNote=f.success(await f.rpc('log_note',{task_id:id,event:'continuation',summary:'synthetic cross-session note'},wrong));
 assert.equal(crossNote.recorded,true);
 const crossCheckpoint=f.success(await f.rpc('task_checkpoint',{task_id:id,done:'跨会话安全检查',next:'接着做：继续同一任务'},wrong));
 assert.equal(crossCheckpoint.task_id,id);
 assert.equal(progress.checkpoint_seq,seq+1);
 assert.equal(JSON.stringify(progress.checkpoints).includes('跨会话安全检查'),true);
 assert.equal(fingerprint(file)!==original,true);
 // A bad task ID must not prime session B for a later victim checkpoint note.
 f.advance(11*60_000);
 const resumedWrong=f.success(await f.rpc('bridge_info',{},wrong));
 assert.equal(JSON.stringify(resumedWrong).includes('已经完成安全块'),false,'wrong session cannot receive a deferred checkpoint note');
 const cardPresent=f.app.tools.h8Cards.tokens.has(digest);
 const stableSeq=progress.checkpoint_seq,stableSteps=JSON.stringify(progress.steps),stableCheckpoints=JSON.stringify(progress.checkpoints),stableFile=fingerprint(file);
 for(const mismatch of ['project','root','epoch']){
  const ownProject=f.app.state.data.active,ownRoot=f.app.store.root,ownEpoch=f.app.policy.epoch;
  if(mismatch==='project')f.app.state.data.active='foreign-project-test';
  if(mismatch==='root')f.app.store.root=path.join(f.root,'other-root');
  if(mismatch==='epoch')f.app.policy.epoch++;
  try{
   if(mismatch!=='epoch')f.fail(await f.rpc('task_status',{task_id:id}),'ROOT_CHANGED');
   for(const [name,args] of [
    ['log_note',{task_id:id,event:'wrong-scope',summary:'not logged'}],
    ['task_checkpoint',{task_id:id,done:'foreign',next:'接着做：foreign'}],
   ])f.fail(await f.rpc(name,args),'ROOT_CHANGED');
  }finally{f.app.state.data.active=ownProject;f.app.store.root=ownRoot;f.app.policy.epoch=ownEpoch;}
  assert.equal(progress.checkpoint_seq,stableSeq,mismatch);
  assert.equal(JSON.stringify(progress.steps),stableSteps,mismatch);
  assert.equal(JSON.stringify(progress.checkpoints),stableCheckpoints,mismatch);
  assert.equal(fingerprint(file),stableFile,mismatch);
 }
 assert.equal(f.app.tools.h8Cards.tokens.has(digest),cardPresent);
 assert.deepEqual(f.activeCalls(),[]);
 const legal=f.success(await f.rpc('task_status',{task_id:id,include_activity:true}));
 assert.equal(legal.activity_notes.items.length,2);
 assert.equal(legal.task_id,id);
});

test('F1 another authenticated caller can continue the same task; unknown tasks and tools remain isolated',async t=>{
 const f=await fixture(t);await f.activate();
 const victim=await f.begin('victim');const cp=await f.arm(victim);
 const progress=f.app.tools.resume.tasks.get(victim);
 f.app.tools.valueStats.drain();
 const initial=f.success(await f.rpc('log_note',{task_id:victim,event:'owner',summary:'owner fixture note'}));assert.equal(initial.recorded,true);
 const sessions=f.app.tools.resume.sessions.size;
 const caller={caller:'other-connector'},notesFile=path.join(f.app.store.stateDir,'activity-records',victim+'.jsonl');
 const status=f.success(await f.rpc('task_status',{task_id:victim},caller));assert.equal(status.task_id,victim);
 const original=fingerprint(notesFile);
 const wrote=f.success(await f.rpc('log_note',{task_id:victim,event:'other-connector',summary:'authenticated continuation'},caller));assert.equal(wrote.recorded,true);
 assert.notEqual(fingerprint(notesFile),original,'authorized continuation records the requested note exactly once');
 f.app.tools.valueStats.drain();const contextBeforeUnknown=f.app.tools.valueStats.taskContexts.get(victim),progressBeforeUnknown=JSON.stringify(progress),notesBeforeUnknown=fingerprint(notesFile);
 const missing=f.fail(await f.rpc('task_status',{task_id:crypto.randomUUID()},{caller:'other-connector'}),'TASK_MISSING');
 assert.ok(!JSON.stringify(missing).includes('Test F1/F2 victim'));
 f.fail(await f.rpc('nonexistent-model-tool-1049',{task_id:victim}),'TOOL_UNKNOWN');
 assert.equal(f.app.tools.resume.tasks.get(victim),progress);
 assert.equal(JSON.stringify(progress),progressBeforeUnknown,'unknown calls cannot alter task progress');
 assert.equal(fingerprint(notesFile),notesBeforeUnknown,'unknown calls cannot append task notes');
 assert.equal(f.app.tools.resume.sessions.size>=sessions,true);
 assert.equal(f.app.policy.tasks.get(victim).status,'active');
 f.app.tools.valueStats.drain();
 assert.equal(f.app.tools.valueStats.taskContexts.get(victim),contextBeforeUnknown,'invalid/unknown observer cannot attribute numeric work to victim');
 const unsafe=JSON.stringify(f.app.tools.valueStats.active.get(victim)||{});
 assert.ok(!unsafe.includes('other-connector'));
 assert.deepEqual(f.activeCalls(),[]);
 assert.equal(f.view(victim,cp.token).state,'cancelled','unknown model call from owning session cancels armed relay, never resumes it');
});

test('F2 every public old, ordinary, unknown, and failed tool cancels candidate; claimed from_card cannot exempt',async t=>{
 const f=await fixture(t);await f.activate();
 const id=await f.begin('public');
 let c=await f.arm(id);
 const old=f.success(await f.rpc('task_resume_claim',{task_id:id}));
 assert.equal(old.granted,false);assert.equal(old.reason,'old_parallel_sender_disabled');
 assert.equal(f.view(id,c.token).state,'cancelled');
 assert.ok(f.app.tools.resume.tasks.get(id).steps.some(s=>s.tool==='task_resume_claim'&&s.ok===true),'public retired tool participates in model observer');
 assert.deepEqual(f.activeCalls(),[]);

 c=await f.arm(id);
 f.fail(await f.rpc('task_resume_claim',{task_id:id,from_card:true}),'ARG_INVALID');
 assert.equal(f.view(id,c.token).state,'cancelled','public from_card flag must never exempt a failed call');
 assert.deepEqual(f.activeCalls(),[]);

 c=await f.arm(id);
 f.fail(await f.rpc('unknown-public-failure-1049',{task_id:id,from_card:true}),'TOOL_UNKNOWN');
 assert.equal(f.view(id,c.token).state,'cancelled');
 assert.ok(!f.app.tools.resume.tasks.get(id).steps.some(s=>s.tool==='unknown-public-failure-1049'));
 assert.deepEqual(f.activeCalls(),[]);

 c=await f.arm(id);
 f.fail(await f.rpc('log_note',{task_id:id,event:'missing summary'}),'ARG_INVALID');
 assert.equal(f.view(id,c.token).state,'cancelled');
 assert.deepEqual(f.activeCalls(),[]);

 c=await f.arm(id);
 f.success(await f.rpc('bridge_info'));
 assert.equal(f.view(id,c.token).state,'cancelled','ordinary model tool without task id still cancels its session');
 assert.deepEqual(f.activeCalls(),[]);
});

test('F2 valid private card capability is exempt; fake from_card or source fails and triggers model cancellation',async t=>{
 const f=await fixture(t);await f.activate();const id=await f.begin('private');
 let c=await f.arm(id);
 const s=f.app.tools.resume.sessions.get(f.session()),originalLast=s?.last_tool;
 const valid=f.success(await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:c.token}));
 assert.equal(valid.relay.state,'armed');
 assert.equal(f.view(id,c.token).state,'armed');
 assert.equal(f.app.tools.resume.sessions.get(f.session())?.last_tool,originalLast,'valid widget does not enter model observer');
 assert.deepEqual(f.activeCalls(),[]);

 f.fail(await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:'0'.repeat(64),from_card:true}),'ARG_INVALID');
 assert.equal(f.view(id,c.token).state,'cancelled','fake widget is treated as model-origin call');
 assert.deepEqual(f.activeCalls(),[]);
 const trace=fs.readFileSync(f.app.tools.trace.file,'utf8');
 assert.match(trace,/relay_card_control/);assert.match(trace,/handler_error/);assert.equal(f.app.tools.trace.write_failures,0);
 assert.equal(trace.includes('0'.repeat(64)),false,'invalid private capability must be scrubbed from local trace');

 c=await f.arm(id);
 f.fail(await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:c.token,source:'widget'}),'ARG_INVALID');
 assert.equal(f.view(id,c.token).state,'cancelled','source string is not authority');
 assert.deepEqual(f.activeCalls(),[]);

 c=await f.arm(id);
 f.fail(await f.rpc('card_answer',{nonce:'0'.repeat(64),choice:'deny',from_card:true}),'CONFIRM_NONCE_INVALID');
 assert.equal(f.view(id,c.token).state,'cancelled','fake card_answer cannot bypass model wrapper');
 assert.deepEqual(f.activeCalls(),[]);

 c=await f.arm(id);
 const before=f.view(id,c.token);
 f.fail(await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:c.token},{session:'conv-B'}),'RELAY_CARD_INVALID');
 assert.equal(f.view(id,c.token).state,before.state,'wrong-session forged widget cannot cancel other session');
 f.advance(20_001);
 const claim=await f.rpc('relay_card_control',{action:'claim',task_id:id,card_token:c.token,mode:'auto'});
 const permit=claim._meta?.['chathand/relay_permit_token'];
 assert.equal(f.success(claim).granted,true);
 assert.match(permit,/^[a-f0-9]{64}$/);
 const dispatched=f.success(await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit}));
 assert.equal(dispatched.send,true);
 assert.equal(f.success(await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit})).send,false);
 assert.equal(f.success(await f.rpc('relay_card_control',{action:'report',task_id:id,attempt_id:dispatched.attempt_id,report_token:permit,outcome:'accepted'})).relay.state,'awaiting');
 assert.equal(f.view(id,c.token).state,'awaiting','valid private traffic never marks model resumption');
 assert.deepEqual(f.activeCalls(),[]);
 assert.equal(f.app.tools.relayKeeper.stats().real_trials,0,'mock integration does not count as real host');
 assert.equal(TOOLS.find(x=>x.name==='relay_card_control')._meta['openai/visibility'],'private');
});
