import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../app/server.mjs';
import {DesktopState} from '../app/state.mjs';
import {AccessPolicy} from '../app/v06/access.mjs';
import {AUTO_TASK_IDENTITY,AUTO_TASK_NOT_EXECUTED} from '../app/v1/auto-task-execution.mjs';

const base=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-auto-task-'));
const work=path.join(base,'work'),stateDir=path.join(base,'state');
fs.mkdirSync(work);fs.mkdirSync(stateDir);
const apps=[];
test.after(async()=>{for(const app of apps.reverse())try{await app.close();}catch{}fs.rmSync(base,{recursive:true,force:true});});
async function desktop(){const app=await createDesktop({stateDir,defaultRoot:work});apps.push(app);return app;}
const old='00000000-0000-4000-8000-000000000001';
test('unknown task creates one durable task and never repeats the write',async()=>{
 const app=await desktop(),args={task_id:old,path:'one.txt',content:'one',expected_sha256:'MISSING',operation_id:'auto-write-0001'};
 const [a,b]=await Promise.all([app.tools.invoke('write_text',args,'chatgpt'),app.tools.invoke('write_text',args,'chatgpt')]);
 assert.equal(a.task_created,true);assert.equal(a.new_task_id,b.new_task_id);assert.equal(fs.readFileSync(path.join(work,'one.txt'),'utf8'),'one');
 assert.equal([...app.policy.tasks.values()].filter(t=>t.id===a.new_task_id).length,1);
 await assert.rejects(()=>app.tools.invoke('write_text',{...args,content:'other'},'chatgpt'),{code:'OP_CONFLICT'});
 const again=await app.tools.invoke('write_text',args,'chatgpt');assert.equal(again.replayed,true);
 const resolved=await app.tools.invoke('write_text',{...args,task_id:a.new_task_id},'chatgpt');assert.equal(resolved.replayed,true);assert.equal(resolved.new_task_id,a.new_task_id);
 await app.close();apps.pop();
 const restarted=await desktop(),after=await restarted.tools.invoke('write_text',args,'chatgpt');assert.equal(after.new_task_id,a.new_task_id);assert.equal(after.replayed,true);
});
test('cross conversation reads the existing task and the no-ID recipe starts nothing',async()=>{
 const app=apps.at(-1),original=await app.tools.invoke('begin_task',{request_id:'auto-cross-0001',title:'跨对话'},'chatgpt',{setupPrincipal:'test:one',session:'a'});
 await app.tools.invoke('log_note',{task_id:original.task_id,event:'跨对话记录',summary:'可读取'},'chatgpt',{setupPrincipal:'test:one',session:'a'});
 const status=await app.tools.invoke('task_status',{task_id:original.task_id},'chatgpt',{setupPrincipal:'test:two',session:'b'});assert.equal(status.task_id,original.task_id);
 const rpc=await app.tools.rpc({jsonrpc:'2.0',id:'cross-rpc-0001',method:'tools/call',params:{name:'task_status',arguments:{task_id:original.task_id},_meta:{'openai/session':'b'}}},'chatgpt',{setupPrincipal:'test:two'});
 assert.equal(rpc.result.isError,false);assert.equal(rpc.result.structuredContent.task_id,original.task_id);
 const notes=await app.tools.invoke('task_status',{task_id:original.task_id,include_activity:true},'chatgpt',{setupPrincipal:'test:two',session:'b'});assert.equal(notes.activity_notes.state,'ok');
 const before=app.policy.tasks.size,recipe=await app.tools.invoke('log_note',{task_id:old,event:'测试',summary:'first'},'chatgpt');assert.equal(recipe.execution_state,'not_started');assert.equal(app.policy.tasks.size,before);
 const first=await app.tools.invoke('run_capability',{capability:recipe.capability,parameters:recipe.parameters},'chatgpt');assert.equal(first.task_created,true);assert.equal(app.policy.tasks.size,before+1);
 const replay=await app.tools.invoke('run_capability',{capability:recipe.capability,parameters:recipe.parameters},'chatgpt');assert.equal(replay.new_task_id,first.new_task_id);assert.equal(replay.replayed,true);
 const resolvedParameters={...recipe.parameters,task_id:first.new_task_id,arguments:{...recipe.parameters.arguments,task_id:first.new_task_id}};
 const resolvedReplay=await app.tools.invoke('run_capability',{capability:recipe.capability,parameters:resolvedParameters},'chatgpt');assert.equal(resolvedReplay.replayed,true);
});
test('same ID with concurrent differing contents conflicts before the in-flight result',async()=>{
 const app=apps.at(-1),common={task_id:old,expected_sha256:'MISSING',operation_id:'auto-race-0001'};
 const first=app.tools.invoke('write_text',{...common,path:'race.txt',content:'one'},'chatgpt');
 await assert.rejects(()=>app.tools.invoke('write_text',{...common,path:'race.txt',content:'two'},'chatgpt'),{code:'OP_CONFLICT'});
 const result=await first;assert.equal(result.task_created,true);assert.equal(fs.readFileSync(path.join(work,'race.txt'),'utf8'),'one');
});
test('existing business receipt is used before creating another task',async()=>{
 const app=apps.at(-1),original=await app.tools.invoke('begin_task',{request_id:'receipt-task-0001',title:'已有回执'},'chatgpt');
 const op={task_id:original.task_id,path:'receipt.txt',content:'already',expected_sha256:'MISSING',operation_id:'receipt-op-0001'};
 await app.tools.invoke('write_text',op,'chatgpt');await app.tools.invoke('finish_task',{task_id:original.task_id},'chatgpt');
 const before=app.policy.tasks.size,r=await app.tools.invoke('write_text',{...op,task_id:old},'chatgpt');
 assert.equal(r.replayed,true);assert.equal(r.task_created,false);assert.equal(app.policy.tasks.size,before);
});
test('durable reservation recovers the same UUID, and started after effect never replays',async()=>{
 const app=apps.at(-1),auto=app.tools.autoTasks,originalSave=auto.save.bind(auto);
 const reserveArgs={task_id:old,path:'reserve.txt',content:'reserved',expected_sha256:'MISSING',operation_id:'reserve-op-0001'};
 let trapped=false;auto.save=(file,record)=>{originalSave(file,record);if(record.state==='reserved'&&!trapped){trapped=true;throw Object.assign(Error('synthetic crash after reserve'),{code:'SYNTHETIC_CRASH'});}};
 await assert.rejects(()=>app.tools.invoke('write_text',reserveArgs,'chatgpt'),{code:'SYNTHETIC_CRASH'});auto.save=originalSave;
 const id=auto.identity('write_text',reserveArgs,{}),reserved=auto.read(auto.file(id),id.namespace+'\0'+id.id),continued=await app.tools.invoke('write_text',reserveArgs,'chatgpt');
 assert.equal(continued.new_task_id,reserved.task_id);assert.equal(fs.readFileSync(path.join(work,'reserve.txt'),'utf8'),'reserved');
 const unknownArgs={task_id:old,path:'unknown.txt',content:'effect',expected_sha256:'MISSING',operation_id:'unknown-op-0001'};
 trapped=false;auto.save=(file,record)=>{if(record.state==='completed'&&!trapped){trapped=true;throw Object.assign(Error('synthetic crash before completed receipt'),{code:'SYNTHETIC_CRASH'});}originalSave(file,record);};
 await assert.rejects(()=>app.tools.invoke('write_text',unknownArgs,'chatgpt'),{code:'SYNTHETIC_CRASH'});auto.save=originalSave;
 const replay=await app.tools.invoke('write_text',unknownArgs,'chatgpt');assert.equal(replay.execution_state,'unknown');assert.equal(replay.do_not_replay,true);assert.equal(fs.readFileSync(path.join(work,'unknown.txt'),'utf8'),'effect');
});
test('stored ask migrates to auto and unconfirmed full never creates a pending task',()=>{
 for(const mode of ['ask','full']){
  const dir=fs.mkdtempSync(path.join(base,'mode-')),state=new DesktopState(dir),store={stateDir:dir,root:work,paused:false};
  state.data.mode=mode;state.data.full_access_confirmed=false;state.save();
  const policy=new AccessPolicy(state,store,{jobs:new Map()});policy.enabled=true;
  const task=policy.begin({request_id:'mode-migrate-0001',title:'迁移任务'},'chatgpt');
  assert.equal(state.data.mode,'auto');assert.equal(store.accessMode,'auto');assert.equal(task.status,'active');assert.equal(task.expires_at,null);
 }
});
test('trusted Site delivery can bind a no-ID action; public metadata cannot forge it',async()=>{
 const app=apps.at(-1),args={task_id:old,event:'site-note',summary:'once'};
 const identity=Object.freeze({kind:'site',namespace:'synthetic-install:site:binding:1',id:'site-job-0001',requestDigest:'a'.repeat(64)});
 const before=app.policy.tasks.size,first=await app.tools.invoke('log_note',args,'chatgpt',{[AUTO_TASK_IDENTITY]:identity});
 assert.equal(first.task_created,true);assert.equal(app.policy.tasks.size,before+1);
 const replay=await app.tools.invoke('log_note',args,'chatgpt',{connectionPrincipal:'site:reconnected',[AUTO_TASK_IDENTITY]:identity});assert.equal(replay.replayed,true);assert.equal(app.policy.tasks.size,before+1);
 const forged=await app.tools.rpc({jsonrpc:'2.0',id:'forged-0001',method:'tools/call',params:{name:'log_note',arguments:{...args,summary:'forged'},_meta:{'chathand/auto_identity':identity}}},'chatgpt');
 assert.equal(forged.result.structuredContent.execution_state,'not_started');assert.equal(app.policy.tasks.size,before+1);
});
test('current file scope and invalid action IDs reject before task reservation',async()=>{
 const app=apps.at(-1),before=app.policy.tasks.size;
 await assert.rejects(()=>app.tools.invoke('write_text',{task_id:old,path:'../outside.txt',content:'x',expected_sha256:'MISSING',operation_id:'outside-op-0001'},'chatgpt'),{code:'SCOPE_REQUIRED'});
 await assert.rejects(()=>app.tools.invoke('write_text',{task_id:old,path:'invalid.txt',content:'x',expected_sha256:'MISSING',operation_id:'bad/id'},'chatgpt'),{code:'OP_INVALID'});
 assert.equal(app.policy.tasks.size,before);
});
test('existing UI receipt rejects conflicts before any replacement task is created',async()=>{
 const app=apps.at(-1),task=await app.tools.invoke('begin_task',{request_id:'ui-origin-0001',title:'原界面任务'}),args={task_id:task.task_id,request_id:'ui-receipt-0001',url:'https://example.com'};
 await app.tools.automation.ops.run('browser_open',args,'chatgpt',async()=>({opened:true}));
 await app.tools.invoke('finish_task',{task_id:task.task_id});const before=app.policy.tasks.size;
 app.state.data.browser_enabled=true;
 const result=await app.tools.invoke('browser_open',args);assert.equal(result.opened,true);assert.equal(app.policy.tasks.size,before);
 await assert.rejects(()=>app.tools.invoke('browser_open',{...args,url:'https://example.org'}),{code:'OP_CONFLICT'});assert.equal(app.policy.tasks.size,before);
});
test('artifact replay retains original fingerprint conflict and task-scoped ID namespace',async()=>{
 const app=apps.at(-1),task=await app.tools.invoke('begin_task',{request_id:'artifact-origin-0001',title:'原成果任务'});
 const args={task_id:task.task_id,request_id:'artifact-original-0001',file_name:'one.txt'};
 app.tools.artifacts.downloadsDir=path.join(base,'empty-downloads');fs.mkdirSync(app.tools.artifacts.downloadsDir,{recursive:true});
 const result=app.tools.artifacts.expect(args,'chatgpt',null);app.tools.artifacts.cancelTask?.(task.task_id);
 const record=app.tools.artifacts.records.get(app.tools.artifacts.key(args.task_id,args.request_id));record.status='failed';app.tools.artifacts.persist(record);
 app.tools.artifacts.waits.forEach(w=>{clearInterval(w.timer);w.controller.abort();});app.tools.artifacts.waits.clear();
 await app.tools.invoke('finish_task',{task_id:task.task_id});const before=app.policy.tasks.size;
 await assert.rejects(()=>app.tools.invoke('expect_download',{...args,file_name:'different.txt'}),{code:'ARTIFACT_INTENT_CONFLICT'});
 const replay=await app.tools.invoke('expect_download',args);assert.equal(replay.replayed,true);assert.equal(app.policy.tasks.size,before);
 assert.notEqual(app.tools.autoTasks.identity('expect_download',args,{}).namespace,app.tools.autoTasks.identity('expect_download',{...args,task_id:old},{}).namespace);
});
test('invalid schema and read/stop/finish never reserve an automatic task',async()=>{
 const app=apps.at(-1),before=app.policy.tasks.size;
 await assert.rejects(()=>app.tools.invoke('write_text',{task_id:old,operation_id:'schema-test-0001'}),{code:'ARG_INVALID'});
 for(const name of ['task_status','task_stop','finish_task'])await assert.rejects(()=>app.tools.invoke(name,{task_id:old}),{code:'TASK_MISSING'});
 assert.equal(app.policy.tasks.size,before);
});

test('automatic tasks obey disabled execution and active permission epochs before preparing',async()=>{
 const app=apps.at(-1),before=app.policy.tasks.size;app.policy.enabled=false;
 try{await assert.rejects(()=>app.tools.invoke('log_note',{task_id:old,event:'disabled',summary:'none'}),{code:'LOCAL_DISABLED'});}finally{app.policy.enabled=true;}
 assert.equal(app.policy.tasks.size,before);
 const t=await app.tools.invoke('begin_task',{request_id:'epoch-active-0001',title:'epoch'}),epoch=app.policy.epoch;app.policy.epoch++;
 try{await assert.rejects(()=>app.tools.invoke('log_note',{task_id:t.task_id,event:'stale',summary:'none'}),{code:'ROOT_CHANGED'});}finally{app.policy.epoch=epoch;}
 assert.equal(app.policy.tasks.size,before+1);
});
test('auto-created RPC task activity binds the resolved task and distinct wrapper IDs remain distinct actions',async()=>{
 const app=apps.at(-1),args={task_id:old,event:'resolved',summary:'once'},meta={'openai/session':'auto-resolved'};
 const rpc=await app.tools.rpc({jsonrpc:'2.0',id:'resolved-0001',method:'tools/call',params:{name:'log_note',arguments:args,_meta:meta}},'chatgpt',{setupPrincipal:'test:resolved'});
 const recipe=rpc.result.structuredContent,first=await app.tools.rpc({jsonrpc:'2.0',id:'resolved-0002',method:'tools/call',params:{name:'run_capability',arguments:{capability:recipe.capability,parameters:recipe.parameters},_meta:meta}},'chatgpt',{setupPrincipal:'test:resolved'});
 const id=first.result.structuredContent.new_task_id;assert.ok(app.tools.resume.lastActivity(id)>0);assert.ok(app.tools.resume.tasks.get(id).session_hash);
 const another=await app.tools.invoke('run_capability',{capability:recipe.capability,parameters:{...recipe.parameters,request_id:'different-wrapper-0001'}},'chatgpt');assert.notEqual(another.new_task_id,id);
});
test('reserved and started ledgers retain their semantics across actual isolated server restarts',async()=>{
 let app=apps.at(-1),auto=app.tools.autoTasks,save=auto.save.bind(auto);const args={task_id:old,path:'restart-reserved.txt',content:'one',expected_sha256:'MISSING',operation_id:'restart-reserved-0001'};
 auto.save=(file,record)=>{save(file,record);if(record.state==='reserved')throw Object.assign(Error('reserved crash'),{code:'SYNTHETIC_CRASH'});};
 await assert.rejects(()=>app.tools.invoke('write_text',args),{code:'SYNTHETIC_CRASH'});auto.save=save;const identity=auto.identity('write_text',args,{}),reserved=auto.read(auto.file(identity),identity.namespace+'\0'+identity.id);
 await app.close();apps.pop();app=await desktop();const result=await app.tools.invoke('write_text',args);assert.equal(result.new_task_id,reserved.task_id);
 auto=app.tools.autoTasks;save=auto.save.bind(auto);const unknown={...args,path:'restart-unknown.txt',operation_id:'restart-unknown-0001'};
 auto.save=(file,record)=>{if(record.state==='completed')throw Object.assign(Error('result crash'),{code:'SYNTHETIC_CRASH'});save(file,record);};await assert.rejects(()=>app.tools.invoke('write_text',unknown),{code:'SYNTHETIC_CRASH'});auto.save=save;
 await app.close();apps.pop();app=await desktop();const replay=await app.tools.invoke('write_text',unknown);assert.equal(replay.execution_state,'unknown');assert.equal(replay.do_not_replay,true);assert.equal(fs.readFileSync(path.join(work,'restart-unknown.txt'),'utf8'),'one');
});

test('normal-return unknown and partial failure remain unknown, while only private zero-effect proof is definite',async()=>{
 const app=apps.at(-1),auto=app.tools.autoTasks;let calls=0;
 for(const [index,value] of [
  {status:'posted_unconfirmed',delivery_unconfirmed:true,do_not_replay:true,completed:false},
  {status:'failed',receipts:[{status:'completed'},{status:'failed',error:{code:'LOCAL_USER_REQUIRED'}}]},
  {status:'failed',error:{details:{foreground_input_events:2,do_not_replay:true}}}
 ].entries()){
  const args={task_id:old,event:'receipt',summary:'test'},context={[AUTO_TASK_IDENTITY]:{kind:'wrapper',id:'outcome-test-'+index}};
  const first=await auto.execute('log_note',args,'chatgpt',context,async()=>{calls++;return value;});assert.equal(first.execution_state,'unknown');assert.equal(first.do_not_replay,true);
  const replay=await auto.execute('log_note',args,'chatgpt',context,async()=>{calls++;return {};});assert.equal(replay.execution_state,'unknown');assert.equal(replay.do_not_replay,true);
 }
 assert.equal(calls,3);
 const args={task_id:old,event:'proof',summary:'test'},context={[AUTO_TASK_IDENTITY]:{kind:'wrapper',id:'definite-proof-0001'}},error=Object.assign(Error('pre-effect rejection'),{code:'SYNTHETIC_GUARD',[AUTO_TASK_NOT_EXECUTED]:true});
 await assert.rejects(()=>auto.execute('log_note',args,'chatgpt',context,async()=>{throw error;}),e=>e.auto_task.execution_state==='failed_definite');
 assert.equal((await auto.execute('log_note',args,'chatgpt',context,async()=>assert.fail('must not replay'))).execution_state,'failed_definite');
});
