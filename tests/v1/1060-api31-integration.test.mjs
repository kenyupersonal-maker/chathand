import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
import {TOOLS,api31ValidationArgs} from '../../app/tools.mjs';
import {modelTools,isPrivateTool,manifest} from '../../app/product.mjs';
import {WORKFLOW_INSTRUCTIONS} from '../../app/v1/workflow.mjs';
import {chathandGuide} from '../../app/v1/guide.mjs';
import {validateBrowserTool} from '../../app/v09/browser-experience-tools.mjs';
import {validateComputerToolArgs} from '../../app/v07/computer.mjs';

// Actual Tools/ScopedStore/AccessPolicy/relay with disposable fake-value state.
// No native process, browser, OS reveal, network, production state or host send.
async function fixture(t,{transport='local_http',modern=true}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-api31-'))),work=path.join(root,'work'),stateDir=path.join(root,'state');fs.mkdirSync(work);
 let app,seq=0,clock=Date.now();
 async function start(){
  app=await createDesktop({stateDir,defaultRoot:work,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{
   currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Fixture',
   tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})})
  }});
  app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
  app.tools.bSiteLocalStore={selection:()=>({selected:transport==='site_b'?'site':'openai'})};
  app.tools.resume.data.gaps=Array(200).fill(1000);
  for(const object of [app.tools.resume,app.tools.h8Cards,app.tools.relayKeeper])object.now=()=>clock;
 }
 await start();t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const f={root,work,stateDir,get app(){return app;},advance(ms){clock+=ms;},async restart(){await app.close();await start();},
  async rpc(name,args={},opt={}){
   const raw=await app.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':opt.session??'fixture-session',...((opt.modern??modern)?{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}:{})}}},'chatgpt',{transport:opt.transport??transport,setupPrincipal:opt.principal??'fixture-account',connectionPrincipal:opt.connection??'fixture-connection'});
   return raw.result;
  },ok(r){assert.equal(r.isError,false,JSON.stringify(r.structuredContent));return r.structuredContent;},
  async begin(opt={}){return f.ok(await f.rpc('begin_task',{request_id:crypto.randomUUID(),title:'Same title'},opt)).task_id;},
  async checkpoint(id,opt={}){const r=await f.rpc('task_checkpoint',{task_id:id,done:'First block',next:'接着做：next block',block:1,total:3},opt);f.ok(r);return r;}
 };return f;
}
const card=r=>r._meta?.['chathand/task_card'];
const nonce=r=>r._meta?.['chathand/task_control_nonce'];
const oldTask='00000000-0000-4000-8000-000000000001';

test('API31 registry exposes only approved schema removals and truthful effect hints',()=>{
 assert.equal(TOOLS.length,83);assert.equal(modelTools(TOOLS).length,77);assert.equal(TOOLS.filter(isPrivateTool).length,6);
 assert.equal(TOOLS.some(d=>d.name==='request_permission'),false);
 assert.deepEqual(TOOLS.find(d=>d.name==='run_capability').inputSchema.required,[]);
 for(const d of TOOLS){assert.equal(d.inputSchema.properties.allow_personal,undefined);assert.equal(d.inputSchema.properties.confirm,undefined);assert.equal(d.inputSchema.properties.steps?.items?.properties?.confirm,undefined);}
 assert.deepEqual(TOOLS.filter(isPrivateTool).map(d=>d.name).sort(),['card_answer','chathand_host_flow_commit','image_batch_claim','image_batch_control','relay_card_control','task_resume_claim']);
 for(const d of TOOLS.filter(isPrivateTool)){assert.equal(d._meta['openai/visibility'],'private');assert.equal(d._meta['openai/widgetAccessible'],true);assert.deepEqual(d._meta.ui.visibility,['app']);}
 for(const name of ['task_status','task_stop','desktop_action']){const d=TOOLS.find(d=>d.name===name);assert.equal(d._meta['openai/widgetAccessible'],true);assert.deepEqual(d._meta.ui.visibility,['model','app']);}
 for(const name of ['write_text','move_path','trash_path','run_capability','computer_action','card_answer'])assert.equal(TOOLS.find(d=>d.name===name).annotations.destructiveHint,true);
 assert.equal(TOOLS.find(d=>d.name==='run_capability').annotations.openWorldHint,true);
 assert.equal(TOOLS.find(d=>d.name==='task_status').annotations.readOnlyHint,true);
 assert.doesNotMatch(WORKFLOW_INSTRUCTIONS,/request_permission|six task_status|six times|最多等6次|TASK_OPEN_IN_CONVERSATION/);
 assert.match(WORKFLOW_INSTRUCTIONS,/ROUTE_NOT_SELECTED/);assert.match(chathandGuide('batch_files').text,/get_file_info/);assert.doesNotMatch(chathandGuide('browser').text,/confirm:true/);
});

test('bare and unknown capability discover real registry; known parameters remain strict',async t=>{
 const f=await fixture(t),before=f.app.policy.tasks.size;
 for(const args of [{},{capability:'not_registered'},{capability:'not_registered',parameters:{anything:'discovery only'}}]){
  const r=f.ok(await f.rpc('run_capability',args));assert.equal(r.executed,false);assert.deepEqual(r.extra_capabilities,f.app.tools.extraCapabilities.list());
 }
 assert.equal(f.app.policy.tasks.size,before);
 const known=f.ok(await f.rpc('run_capability',{capability:'contract_status'})),file=new URL('../../contracts/api31-freeze.json',import.meta.url),frozen=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,current=manifest(TOOLS);
 assert.equal(known.api31_frozen,current.connector_api===31&&frozen?.connector_api===31&&current.schema_sha256===frozen?.schema_sha256);assert.equal(known.freeze_status,frozen?'present':'not_generated');
 assert.equal((await f.rpc('run_capability',{capability:'contract_status',parameters:{extra:true}})).structuredContent.code,'CAPABILITY_ARGUMENT_INVALID');
 for(const args of [{parameters:[]},{capability:'Invalid Name'},{other:true}])assert.equal((await f.rpc('run_capability',args)).structuredContent.code,'ARG_INVALID');
});

test('only historical boolean flag locations normalize before strict validators; original args stay canonical',async t=>{
 const f=await fixture(t),id=await f.begin();f.app.state.data.browser_enabled=true;f.app.state.data.browser_backend='extension';
 let effects=0;f.app.tools.automation.browser.extension.batch=async()=>{effects++;return {completed:true};};
 const args={task_id:id,request_id:'legacy-batch-0001',page_id:'fake',allow_personal:true,steps:[{step_id:'one',action:'click',ref:'fixture',confirm:true}]},original=JSON.stringify(args);
 f.ok(await f.rpc('browser_batch',args));f.ok(await f.rpc('browser_batch',args));assert.equal(effects,1);assert.equal(JSON.stringify(args),original);
 assert.equal((await f.rpc('browser_batch',{...args,allow_personal:false})).structuredContent.code,'OP_CONFLICT','historical digest is not rewritten');
 assert.equal((await f.rpc('browser_batch',{...args,steps:[{...args.steps[0],unapproved:true}]})).structuredContent.code,'ARG_INVALID');
 assert.equal((await f.rpc('browser_batch',{...args,allow_personal:'yes'})).structuredContent.code,'ARG_INVALID');
 const computer={task_id:id,request_id:'legacy-computer-1',steps:[{step_id:'one',action:'type',text:'fake',confirm:false}]};
 validateComputerToolArgs(TOOLS.find(d=>d.name==='computer_batch'),api31ValidationArgs('computer_batch',computer));
 assert.equal(computer.steps[0].confirm,false);
 assert.throws(()=>validateComputerToolArgs(TOOLS.find(d=>d.name==='computer_batch'),api31ValidationArgs('computer_batch',{...computer,allow_personal:true})),{code:'ARG_INVALID'});
 const browser={task_id:id,request_id:'old-browser-0001',page_id:'fake',action:'click',ref:'r',allow_personal:false,confirm:true};
 validateBrowserTool(TOOLS.find(d=>d.name==='browser_action'),api31ValidationArgs('browser_action',browser));
 // Automatic-task and UI journals receive original old arguments on restart.
 const automatic={...args,task_id:oldTask,request_id:'legacy-auto-0001'};
 const first=f.ok(await f.rpc('browser_batch',automatic));assert.equal(first.task_created,true);assert.equal(effects,2);
 await f.restart();const replay=f.ok(await f.rpc('browser_batch',automatic));assert.equal(replay.new_task_id,first.new_task_id);assert.equal(replay.replayed,true);assert.equal(effects,2);
});

test('get_file_info streams large binary and exact directory hashes into live and restart move/trash replay',async t=>{
 const f=await fixture(t),id=await f.begin();
 fs.mkdirSync(path.join(f.work,'tree'));fs.writeFileSync(path.join(f.work,'tree','blob.bin'),Buffer.alloc(9*1024*1024,0));
 const binary=f.ok(await f.rpc('get_file_info',{path:'tree/blob.bin'}));assert.equal(binary.hash_kind,'sha256');assert.match(binary.sha256,/^[a-f0-9]{64}$/);
 const info=f.ok(await f.rpc('get_file_info',{path:'tree'}));assert.equal(info.hash_kind,'chathand-directory-v1');assert.equal(info.path_entries,2);assert.equal(info.sha256,f.app.store.pathInfo('tree').sha256);
 const move={task_id:id,from:'tree',to:'moved',expected_sha256:info.sha256,operation_id:'api31-move-0001'};
 f.ok(await f.rpc('move_path',move));assert.equal(fs.existsSync(path.join(f.work,'tree')),false);assert.equal(f.ok(await f.rpc('move_path',move)).replayed,true);
 assert.equal((await f.rpc('move_path',{...move,to:'different'})).structuredContent.code,'OP_CONFLICT');
 const trash={task_id:oldTask,path:'moved',expected_sha256:info.sha256,operation_id:'api31-trash-0001'};
 const trashed=f.ok(await f.rpc('trash_path',trash));assert.equal(trashed.task_created,true);assert.equal(fs.existsSync(path.join(f.work,'moved')),false);
 assert.equal(f.ok(await f.rpc('trash_path',trash)).replayed,true);
 await f.restart();assert.equal(f.ok(await f.rpc('move_path',move)).replayed,true);assert.equal(f.ok(await f.rpc('trash_path',trash)).new_task_id,trashed.new_task_id);
 assert.equal(f.app.policy.tasks.size,0,'applied replay after restart creates no replacement task');
});

for(const status of ['prepared','unknown'])test('original '+status+' operation refuses mutation even when source has gone',async t=>{
 const f=await fixture(t),id=await f.begin();fs.writeFileSync(path.join(f.work,'file.bin'),Buffer.from([0,1]));
 const args={task_id:id,path:'file.bin',expected_sha256:f.app.store.pathInfo('file.bin').sha256,operation_id:'incomplete-'+status};
 f.ok(await f.rpc('trash_path',args));const file=f.app.store.operationFile(args.operation_id),record=JSON.parse(fs.readFileSync(file));record.status=status;fs.writeFileSync(file,JSON.stringify(record));
 const first=await f.rpc('trash_path',args);assert.equal(first.structuredContent.code,'OP_INCOMPLETE');
 await f.restart();assert.equal((await f.rpc('trash_path',args)).structuredContent.code,'OP_INCOMPLETE');assert.equal(f.app.policy.tasks.size,0);assert.equal(JSON.parse(fs.readFileSync(file)).status,status);
});

test('receipt replay still enforces current scope and self protection',async t=>{
 const f=await fixture(t),id=await f.begin(),outside=path.join(f.root,'outside.bin');fs.writeFileSync(outside,Buffer.from([0,1]));f.app.store.accessMode='full';
 const args={task_id:id,path:outside,expected_sha256:f.app.store.pathInfo(outside).sha256,operation_id:'scope-trash-0001'};f.ok(await f.rpc('trash_path',args));f.app.store.accessMode='auto';
 assert.equal((await f.rpc('trash_path',args)).structuredContent.code,'SCOPE_REQUIRED');
 assert.throws(()=>f.app.store.checkReplayPath(f.stateDir),{code:'BRIDGE_STATE_PROTECTED'});assert.throws(()=>f.app.store.checkReplayPath(f.app.store.runtimeRoot),{code:'RUNTIME_PROTECTED'});
});

test('all task branches carry one exact root timeline/files privately; unavailable metadata preserves completion',async t=>{
 const f=await fixture(t),id=await f.begin(),other=await f.begin({session:'other'});
 f.ok(await f.rpc('write_text',{task_id:id,path:'private-output.txt',content:'fixture',expected_sha256:'MISSING',operation_id:'card-write-0001'}));
 f.ok(await f.rpc('write_text',{task_id:other,path:'other-output.txt',content:'other',expected_sha256:'MISSING',operation_id:'card-write-0002'},{session:'other'}));
 const seen=[];for(const [o,m] of [[f.app.tools.resume,'before'],[f.app.tools.resume,'after'],[f.app.tools.trace,'handled'],[f.app.tools.valueStats,'enqueue']]){const original=o[m];o[m]=function(...a){seen.push(JSON.stringify(a));return original.apply(this,a);};}
 const first=await f.checkpoint(id),second=await f.rpc('task_checkpoint',{task_id:id,done:'Second block',next:'接着做：review',block:2,total:3});f.ok(second);
 for(const r of [first,second,await f.rpc('show_task',{task_id:id}),await f.rpc('task_status',{task_id:id})]){
  f.ok(r);assert.equal(card(r).card_id,id);assert.deepEqual(card(r).files.map(x=>x.path),['private-output.txt']);assert.equal(card(r).timeline.every(x=>x.task_id===id),true);assert.equal(card(r).file_capabilities.attachment,'unverified');assert.equal(JSON.stringify(r.structuredContent).includes('"chathand/task_card":'),false);
 }
 assert.equal(card(second).timeline.filter(x=>x.kind==='checkpoint').length,2);
 assert.equal(seen.join('\n').includes(nonce(second)),false);assert.equal(seen.join('\n').includes('"chathand/task_card":'),false);
 // Use the current observation capability; repeated polls do not supersede it.
 // Later public renders above superseded it, so obtain one current capability.
 const status=await f.rpc('task_status',{task_id:id}),poll=status._meta['chathand/observation_nonce'];
 for(let i=0;i<2;i++){const r=await f.rpc('card_answer',{nonce:poll,choice:'status'});f.ok(r);assert.equal(card(r).task_id,id);}
 const info=f.app.store.pathInfo('private-output.txt');f.ok(await f.rpc('trash_path',{task_id:id,path:'private-output.txt',expected_sha256:info.sha256,operation_id:'card-trash-0001'}));assert.deepEqual(card(await f.rpc('task_status',{task_id:id})).files,[]);
 f.app.tools.features.changes.read=()=>{throw Object.assign(Error('fixture unavailable'),{code:'CHANGE_LOG_INVALID'});};
 const checkpoint=await f.checkpoint(id);f.ok(checkpoint);assert.equal(card(checkpoint).coverage.files,'not_provided');
 const done=await f.rpc('finish_task',{task_id:id,success:true,summary:'Completed'});assert.equal(f.ok(done).status,'completed');assert.equal(card(done).terminal,true);assert.equal(card(done).controls.stop.enabled,false);
 assert.equal(f.app.policy.tasks.get(other).status,'active');
});

for(const route of [{transport:'local_http',modern:true},{transport:'site_b',modern:true},{transport:'local_http',modern:false}])test('one-use exact task stop and context proof: '+JSON.stringify(route),async t=>{
 const f=await fixture(t,route),id=await f.begin(),other=await f.begin({session:'other'}),r=await f.checkpoint(id),control=nonce(r),cancelled=[];
 assert.equal(card(r).controls.stop.enabled,true);assert.equal(card(r).controls.continue.enabled,false);
 f.app.policy.tasks.get(id).jobs.push('fixture-job-a');f.app.policy.tasks.get(other).jobs.push('fixture-job-b');f.app.queue.cancel=id=>{cancelled.push(id);return {status:'cancelled'};};
 for(const opt of [{session:'foreign'},{principal:'foreign'},{connection:'foreign'},{modern:!route.modern,transport:route.transport==='site_b'?'local_http':route.transport}]){const denied=await f.rpc('card_answer',{nonce:control,choice:'stop'},opt);assert.ok(denied.isError||denied.structuredContent.executed===false);assert.equal(f.app.policy.tasks.get(id).status,'active');}
 const malformed=await f.rpc('card_answer',{nonce:control,choice:'stop',task_id:other});assert.equal(malformed.isError,true);
 const stopped=await f.rpc('card_answer',{nonce:control,choice:'stop'});assert.equal(f.ok(stopped).task_id,id);assert.equal(card(stopped).status,'stopped');assert.equal(card(stopped).stopped_at.step,'接着做：next block');
 assert.equal(f.app.policy.tasks.get(other).status,'active');assert.deepEqual(cancelled,['fixture-job-a']);
 const replay=await f.rpc('card_answer',{nonce:control,choice:'stop'});assert.equal(replay.structuredContent.code,'RELAY_CARD_SUPERSEDED');assert.deepEqual(cancelled,['fixture-job-a']);
});

for(const transport of ['local_http','site_b'])test('manual continue obtains existing relay lease; send/unknown never replay: '+transport,async t=>{
 const f=await fixture(t,{transport}),id=await f.begin(),cp=await f.checkpoint(id);
 assert.equal(card(cp).controls.continue.enabled,false);f.advance(600001);
 const view=await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:cp._meta['chathand/relay_card_token']});f.ok(view);
 const interruption=await f.rpc('relay_card_control',{action:'interruption',task_id:id,interruption_token:view._meta['chathand/relay_interruption_token']});f.ok(interruption);
 assert.equal(card(interruption).controls.continue.enabled,true);
 const control=nonce(interruption),claim=await f.rpc('card_answer',{nonce:control,choice:'continue'});assert.equal(f.ok(claim).granted,true);assert.equal(claim._meta['chathand/task_continue'].host_send_verified,false);
 assert.equal((await f.rpc('card_answer',{nonce:control,choice:'continue'})).structuredContent.code,'RELAY_CARD_SUPERSEDED');
 const permit=claim._meta['chathand/relay_permit_token'];assert.equal(JSON.stringify(claim.structuredContent).includes(permit),false);
 const sent=await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit});assert.equal(f.ok(sent).send,true);assert.equal(card(sent).controls.continue.enabled,false);
 assert.equal(f.ok(await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit})).send,false);
 const report=await f.rpc('relay_card_control',{action:'report',task_id:id,attempt_id:sent.structuredContent.attempt_id,report_token:permit,outcome:'unknown'});f.ok(report);assert.equal(card(report).status,'unknown');assert.equal(card(report).controls.continue.enabled,false);assert.equal(card(report).controls.stop.enabled,false);
 const poll=sent._meta['chathand/observation_nonce'],observed=await f.rpc('card_answer',{nonce:poll,choice:'status'});f.ok(observed);assert.equal(card(observed).status,'unknown');
 assert.equal(f.ok(await f.rpc('task_resume_claim',{task_id:id})).granted,false);
});

test('terminal reveal validates task, current scope and existence without creating a task',async t=>{
 const f=await fixture(t),id=await f.begin();fs.writeFileSync(path.join(f.work,'output.txt'),'fixture');f.ok(await f.rpc('finish_task',{task_id:id,success:true,summary:'done'}));
 let reveals=0;f.app.tools.revealPath=async args=>{reveals++;return {action:args.action,requested:true};};const before=f.app.policy.tasks.size;
 assert.equal(f.ok(await f.rpc('desktop_action',{task_id:id,action:'reveal',path:'output.txt'})).requested,true);
 for(const args of [{task_id:id,path:'missing'},{task_id:id,path:'../outside'},{task_id:oldTask,path:'output.txt'}])assert.equal((await f.rpc('desktop_action',{...args,action:'reveal'})).isError,true);
 assert.equal(reveals,1);assert.equal(f.app.policy.tasks.size,before);
});

test('lost automatic move receipt remains unknown across restart; source is never required back',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.work,'source'));fs.writeFileSync(path.join(f.work,'source','binary'),Buffer.from([0,1]));
 const args={task_id:oldTask,from:'source',to:'destination',expected_sha256:f.app.store.pathInfo('source').sha256,operation_id:'lost-auto-move-0001'};
 const ledger=f.app.tools.autoTasks,save=ledger.save.bind(ledger);ledger.save=(file,record)=>{if(record.state==='completed')throw Object.assign(Error('synthetic receipt loss'),{code:'SYNTHETIC_RECEIPT_LOSS'});save(file,record);};
 const failed=await f.rpc('move_path',args);assert.equal(failed.structuredContent.code,'SYNTHETIC_RECEIPT_LOSS');ledger.save=save;
 assert.equal(fs.existsSync(path.join(f.work,'source')),false);const bytes=fs.readFileSync(path.join(f.work,'destination','binary'));
 const live=f.ok(await f.rpc('move_path',args));assert.equal(live.execution_state,'unknown');assert.equal(live.do_not_replay,true);
 await f.restart();const replay=f.ok(await f.rpc('move_path',args));assert.equal(replay.execution_state,'unknown');assert.equal(replay.do_not_replay,true);assert.deepEqual(fs.readFileSync(path.join(f.work,'destination','binary')),bytes);assert.equal(f.app.policy.tasks.size,0);
});

test('same-session explicit independent roots retain their work and private stop capability',async t=>{
 const f=await fixture(t),a=await f.begin(),original=f.app.policy.get(a),b=f.app.policy.begin({request_id:crypto.randomUUID(),title:'Same title'},'chatgpt',{session_hash:original.session_hash,connection_principal:original.connection_principal}).task_id;
 await f.checkpoint(a);await f.checkpoint(b);
 const aa=await f.rpc('task_status',{task_id:a}),bb=await f.rpc('task_status',{task_id:b});const stopped=f.ok(await f.rpc('card_answer',{nonce:nonce(aa),choice:'stop'}));
 assert.equal(stopped.task_id,a);assert.equal(f.app.policy.tasks.get(b).status,'active');assert.equal(f.app.tools.h8Cards.provePrivateNonce(nonce(bb),'chatgpt',original.session_hash,'2026-07-28'),true);
 assert.equal(f.ok(await f.rpc('card_answer',{nonce:nonce(bb),choice:'stop'})).task_id,b);
});

test('stale checkpoint/project/epoch controls refuse before effects and missing relay exposes no continue',async t=>{
 const f=await fixture(t),id=await f.begin(),before=await f.checkpoint(id);await f.checkpoint(id);
 assert.equal((await f.rpc('card_answer',{nonce:nonce(before),choice:'stop'})).isError,true);assert.equal(f.app.policy.get(id).status,'active');
 const current=await f.rpc('task_status',{task_id:id}),project=f.app.state.data.active;f.app.state.data.active='other-project';
 assert.equal((await f.rpc('card_answer',{nonce:nonce(current),choice:'stop'})).isError,true);f.app.state.data.active=project;
 f.app.policy.epoch++;assert.equal((await f.rpc('card_answer',{nonce:nonce(current),choice:'stop'})).isError,true);f.app.policy.epoch--;
 const relay=f.app.tools.relayKeeper;f.app.tools.relayKeeper=null;const without=await f.rpc('task_status',{task_id:id});assert.equal(card(without).controls.continue.enabled,false);f.app.tools.relayKeeper=relay;
});

test('card enrichment cannot turn a saved finish into failure or leak its new private fields to observers',async t=>{
 const f=await fixture(t),id=await f.begin();f.app.tools.resume.view=()=>{throw Object.assign(Error('synthetic unavailable projection'),{code:'PROJECTION_UNAVAILABLE'});};
 const result=await f.rpc('finish_task',{task_id:id,success:true,summary:'Saved outcome'});assert.equal(f.ok(result).status,'completed');assert.equal(result._meta?.['chathand/task_card'],undefined);assert.equal(f.app.policy.receipts.read(id).result.summary,'Saved outcome');
});

for(const transport of ['local_http','site_b'])test('private option polling and consumed answers retain their exact task card: '+transport,async t=>{
 const f=await fixture(t,{transport}),id=await f.begin();let effects=0,unknown=false;
 f.app.tools.registerCardAction('skip_step',async()=>{effects++;return unknown?{state:'unknown',do_not_replay:true}:{ok:true};});
 const checkpoint=async()=>{const r=await f.rpc('task_checkpoint',{task_id:id,done:'Waiting',waiting_user:true,blocked:{step:'Inspect output',error:'Fixture',options:[{label:'Skip',cost:'None',action:'skip_step'},{label:'Explain',cost:'Wait'}]}});f.ok(r);return r;};
 const cp=await checkpoint(),choice=cp._meta['chathand/card_nonce'];
 const observed=await f.rpc('card_answer',{nonce:choice,choice:'status'});assert.deepEqual(f.ok(observed),{state:'waiting'});assert.equal(card(observed)?.task_id,id);assert.equal(effects,0);
 const answered=await f.rpc('card_answer',{nonce:choice,choice:'1'});assert.equal(f.ok(answered).state,'allowed');assert.equal(card(answered)?.task_id,id);assert.equal(card(answered).progress.checkpoint_seq,card(cp).progress.checkpoint_seq+1);assert.equal(effects,1);
 assert.equal((await f.rpc('card_answer',{nonce:choice,choice:'1'})).isError,true);assert.equal(effects,1);
 unknown=true;const next=await checkpoint(),uncertain=await f.rpc('card_answer',{nonce:next._meta['chathand/card_nonce'],choice:'1'});
 assert.equal(f.ok(uncertain).do_not_replay,true);assert.equal(card(uncertain)?.task_id,id);assert.equal(card(uncertain).status,'unknown');assert.equal(card(uncertain).controls.continue.enabled,false);assert.equal(card(uncertain).controls.stop.enabled,false);assert.equal(effects,2);
 assert.equal((await f.rpc('card_answer',{nonce:next._meta['chathand/card_nonce'],choice:'1'})).isError,true);assert.equal(effects,2);
});
