import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../app/server.mjs';
import {sessionHashOf} from '../app/v1/resume.mjs';

// R2-1: every object, principal, task and capability is a synthetic temporary
// fixture. This test never connects to the installed ChatHand's real state.
async function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-r2-1-')));
 const work=path.join(root,'work');fs.mkdirSync(work);
 const stateDir=path.join(root,'state');
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey:'a'.repeat(64),
  adminAccess:{supported:()=>false,ready:()=>false},
  clientDeps:{
   // This fixture isolates the RPC guard; scheduler samples must not race the spies.
   maintenanceClock:{now:Date.now,setTimeout:()=>({unref(){}}),clearTimeout(){},queueMicrotask(){}},
   currentAppPath:path.join(root,'ChatHand.app'),
   computerName:()=> 'Synthetic R2-1 Host',
   tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
   updaterFactory:()=>({currentBuild:1048,snapshot:()=>({status:'unknown',install:{state:'idle'}}),
    forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
  }
 });
 app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 let seq=0,clock=Date.now();app.tools.relayKeeper.now=()=>clock;app.tools.resume.now=()=>clock;app.tools.h8Cards.now=()=>clock;app.tools.resume.data.gaps=Array(200).fill(1000);
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const actors={
  A:{caller:'chatgpt',session:'session-A',principal:'synthetic-account-A'},
  Bsame:{caller:'chatgpt',session:'session-B',principal:'synthetic-account-A'},
  Bother:{caller:'unrelated-connector',session:'session-B',principal:'synthetic-account-B'}
 };
 const hash=actor=>sessionHashOf(actor.principal,actor.session);
 const relayCtx=actor=>({caller:actor.caller,session_hash:hash(actor),transport:'mcp_app'});
 async function rpc(actor,name,args={}){
  const reply=await app.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',
   params:{name,arguments:args,_meta:{
    'openai/session':actor.session,
    'io.modelcontextprotocol/protocolVersion':'2026-07-28'
   }}},actor.caller,{setupPrincipal:actor.principal});
  return reply.result;
 }
 function ok(r){
  assert.equal(r?.isError,false,JSON.stringify(r?.structuredContent||r));
  return r.structuredContent;
 }
 async function begin(actor,title){
  return ok(await rpc(actor,'begin_task',{request_id:'R2_1_'+crypto.randomUUID(),title})).task_id;
 }
 let optionNonce=null;
 async function checkpoint(actor,id,blocked=null){
  const r=await rpc(actor,'task_checkpoint',{task_id:id,done:'合成前一步完成',next:'接着做：R2-1 只读校验',...(blocked?{blocked}:{})});
  const result=ok(r);if(r._meta?.['chathand/card_nonce'])optionNonce=r._meta['chathand/card_nonce'];
  clock+=120001;const seen=await rpc(actor,'relay_card_control',{action:'view',task_id:id,card_token:r._meta['chathand/relay_card_token']});const witness=seen._meta['chathand/relay_interruption_token'];assert.match(witness,/^[a-f0-9]{64}$/);const interrupted=await rpc(actor,'relay_card_control',{action:'interruption',task_id:id,interruption_token:witness});ok(interrupted);const token=interrupted._meta['chathand/relay_card_token'];
  assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(result.checkpoint_seq>0,true);
  return token;
 }
 const state=()=>JSON.parse(app.tools.relayKeeper.db.prepare('SELECT value FROM relay_state WHERE id=1').get().value);
 return {root,stateDir,app,actors,hash,relayCtx,rpc,ok,begin,checkpoint,state,optionNonce:()=>optionNonce};
}

for(const [label,which] of [['same caller, different session','Bsame'],['different caller and session','Bother']]){
 test('R2-1 invalid relay private capability cannot read another session pending checkpoint option: '+label,async t=>{
  const f=await fixture(t),A=f.actors.A,B=f.actors[which];
  const a=await f.begin(A,'Synthetic pending owner A');

  // A has a real current checkpoint option, with a recognizable private marker.
  const marker='R2_1_'+crypto.randomBytes(8).toString('hex'),optionId='option:'+a;
  const aCardToken=await f.checkpoint(A,a,{step:marker,error:'synthetic blocker',options:[{label:'skip',cost:'none',action:'skip_step'},{label:marker,cost:'none'}]});
  const nonce=f.optionNonce();assert.match(nonce,/^[a-f0-9]{64}$/);
  const nonceDigest=crypto.createHash('sha256').update(nonce).digest('hex');
  assert.equal(f.app.tools.h8Cards.options.get(optionId).state,'waiting');

  const b=await f.begin(B,'Synthetic unprivileged B');
  const bCardToken=await f.checkpoint(B,b);
  const legalB=f.ok(await f.rpc(B,'relay_card_control',{action:'view',task_id:b,card_token:bCardToken}));
  assert.equal(legalB.relay.state,'armed','legitimate private widget view is not treated as a model call');

  // All before-values are taken AFTER setup; the attack alone must not
  // alter A's option, capability, task status/progress or numeric stats.
  f.app.tools.valueStats.drain();
  const prior=f.state(),priorOption=structuredClone(f.app.tools.h8Cards.options.get(optionId));
  const priorState=structuredClone(f.app.state.data);
  const policyBefore={enabled:f.app.policy.enabled,epoch:f.app.policy.epoch,revision:f.app.policy.permissionRevision,
   status:f.app.policy.tasks.get(a).status};
  const aProgress=f.app.tools.resume.tasks.get(a);
  const cpBefore={seq:aProgress.checkpoint_seq,records:structuredClone(aProgress.checkpoints),
   steps:structuredClone(aProgress.steps)};
  const statBefore=structuredClone(f.app.tools.valueStats.active.get(a)||null);
  const contextBefore=f.app.tools.valueStats.taskContexts.get(a);
  assert.equal(prior.tasks[a].card.state,'manual_ready','current checkpoint blocker permits manual continuation only');
  assert.equal(prior.tasks[b].card.state,'armed');
  assert.equal(f.app.tools.h8Cards.tokens.has(nonceDigest),true);

  const originalPending=f.app.tools.confirmations.pending.bind(f.app.tools.confirmations);
  const originalOptionGet=f.app.tools.h8Cards.options.get.bind(f.app.tools.h8Cards.options);
  const originalInvoke=f.app.tools.invoke.bind(f.app.tools);
  const originalGet=f.app.policy.get.bind(f.app.policy);
  const originalEnqueue=f.app.tools.valueStats.enqueue.bind(f.app.tools.valueStats);
  const originalTrace=f.app.tools.trace.receiveRPC.bind(f.app.tools.trace);
  let pendingReads=0,optionReads=0,relayInvokes=0,aGets=0,statEnqueues=0;
  const observed=[];
  f.app.tools.confirmations.pending=(...args)=>{pendingReads++;return originalPending(...args);};
  f.app.tools.h8Cards.options.get=(id)=>{if(id===optionId)optionReads++;return originalOptionGet(id);};
  f.app.tools.invoke=(name,...args)=>{if(name==='relay_card_control')relayInvokes++;return originalInvoke(name,...args);};
  f.app.policy.get=(id,...args)=>{if(id===a)aGets++;return originalGet(id,...args);};
  f.app.tools.valueStats.enqueue=(...args)=>{statEnqueues++;return originalEnqueue(...args);};
  f.app.tools.trace.receiveRPC=(...args)=>{observed.push(args[0]);return originalTrace(...args);};

  const fakeToken=crypto.randomBytes(32).toString('hex');
  assert.notEqual(fakeToken,aCardToken);
  assert.notEqual(fakeToken,bCardToken);
  const bad=await f.rpc(B,'relay_card_control',{action:'view',task_id:a,card_token:fakeToken});
  assert.equal(bad.isError,true,'unproven private call must be denied');
  assert.equal(bad.structuredContent.code,'RELAY_CARD_INVALID');
  const publicEnvelope=JSON.stringify({content:bad.content,structuredContent:bad.structuredContent});
  for(const privateValue of [optionId,marker,nonce,aCardToken,fakeToken]){
   assert.equal(publicEnvelope.includes(privateValue),false,'no private item, card or control token enters ordinary error response');
  }
  assert.equal(Object.hasOwn(bad.structuredContent,'details'),false);
  assert.equal(Object.hasOwn(bad.structuredContent,'confirm'),false);
  assert.equal(pendingReads,0,'unverified call must not read legacy pending state');
  assert.equal(optionReads,0,'unverified call must not read A checkpoint option');
  assert.equal(relayInvokes,0,'unverified call must never enter invoke');
  assert.equal(aGets,0,'unproved model-origin private call must not read target task via Policy.get');
  assert.equal(statEnqueues,0,'unauthenticated private call must not pollute ValueStats');
  assert.equal(JSON.stringify(observed).includes(fakeToken),false,'cardObserverBody still scrubs failed private token');

  const after=f.state();
  assert.deepEqual(after.tasks[a].card,prior.tasks[a].card,'A relay capability remains untouched');
  assert.equal(after.tasks[b].card.state,'cancelled','B active candidate revoked by model-origin failed call');
  assert.equal(after.tasks[b].card.reason,'new_tool');
  assert.deepEqual(Object.keys(after.active_calls),[],'finally releases B inflight');
  assert.deepEqual(f.app.tools.h8Cards.options.get(optionId),priorOption);
  assert.deepEqual(f.app.state.data,priorState);
  assert.deepEqual({enabled:f.app.policy.enabled,epoch:f.app.policy.epoch,revision:f.app.policy.permissionRevision,
   status:f.app.policy.tasks.get(a).status},policyBefore);
  assert.deepEqual({seq:aProgress.checkpoint_seq,records:aProgress.checkpoints,steps:aProgress.steps},cpBefore);
  assert.equal(f.app.tools.h8Cards.tokens.has(nonceDigest),true);
  f.app.tools.valueStats.drain();
  assert.deepEqual(f.app.tools.valueStats.active.get(a)||null,statBefore);
  assert.equal(f.app.tools.valueStats.taskContexts.get(a),contextBefore);
  assert.equal(f.app.tools.relayKeeper.stats().real_trials,0,'synthetic test is not real host evidence');

  const traceFile=f.app.tools.trace.file;assert.equal(f.app.tools.trace.write_failures,0);
  assert.equal(fs.existsSync(traceFile),true);
  assert.equal(fs.readFileSync(traceFile,'utf8').includes(fakeToken),false,'failed private token never enters local trace');

  // Keep the old public tool wrapping behavior: after B arms a fresh card,
  // calling task_resume_claim as a model tool revokes the B candidate.
  if(which==='Bsame'){
   const fresh=await f.checkpoint(B,b);
   const legacy=f.ok(await f.rpc(B,'task_resume_claim',{task_id:b}));
   assert.equal(legacy.granted,false);
   assert.equal(legacy.reason,'old_parallel_sender_disabled');
   const last=f.state();
   assert.equal(last.tasks[b].card.state,'cancelled');
   assert.deepEqual(Object.keys(last.active_calls),[]);
   assert.equal(f.app.tools.relayKeeper.provePrivateCapability(
    {action:'view',task_id:a,card_token:aCardToken},f.relayCtx(A)),true,'A remains a valid private card');
  }
 });
}
