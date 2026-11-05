import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';
import {inspectWorkspace} from '../../app/v1/workspace-recovery.mjs';
import {spawnWorkspaceProbe,inspectWorkspaceWithRetry} from '../../app/v1/workspace-inspector.mjs';
import {workspaceCheckFields} from '../../app/diagnostic-events.mjs';

const begin=app=>app.policy.begin({request_id:randomUUID(),title:'On-demand workspace'},'chatgpt').task_id;
const write=(app,id,name='result.txt')=>app.tools.invoke('write_text',{task_id:id,path:name,content:'SYNTHETIC_RESULT',expected_sha256:'MISSING',operation_id:randomUUID()});
const outcome=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,error}));
const persisted=f=>JSON.parse(fs.readFileSync(path.join(f.stateDir,'desktop.json'),'utf8'));
async function waitFor(condition){const until=Date.now()+2500;while(!condition()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(condition());}
const childWith=script=>spawn(process.execPath,['-e',script],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','ignore','ipc'],detached:true});

for(const code of ['WORKSPACE_TIMEOUT','WORKSPACE_PROBE_FAILED','WORKSPACE_PROBE_BUSY'])test(`${code} exhaustion preserves authority and the next operation recovers automatically`,async t=>{
 let remaining=0,attempts=0;
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeOverride=data=>{attempts++;return remaining-->0?{path:data.root,available:false,writable:false,status:'inaccessible',code}:undefined;};}}),{app}=f;
 await f.post('/api/workspace/check');const id=begin(app);await write(app,id,'before.txt');
 const epoch=app.store.workspaceEpoch,policyEpoch=app.policy.epoch,revision=app.policy.permissionRevision||0,identity=structuredClone(app.state.data.workspace_identities),before=attempts;
 remaining=3;await assert.rejects(write(app,id,'blocked.txt'),{code:'WORKSPACE_UNAVAILABLE'});
 assert.equal(attempts-before,3);assert.equal(fs.existsSync(path.join(f.work,'blocked.txt')),false);assert.equal(app.policy.get(id).status,'active');assert.equal(app.store.workspaceEpoch,epoch);assert.equal(app.policy.epoch,policyEpoch);assert.equal(app.policy.permissionRevision||0,revision);assert.equal(app.store.workspaceStatus().confirm_reason,null);assert.equal(persisted(f).projects.find(p=>p.id===f.selectedId).workspace_recovery_required,undefined);assert.deepEqual(app.state.data.workspace_identities,identity);
 await write(app,id);assert.equal(app.store.workspaceStatus().available,true);assert.equal(app.policy.get(id).status,'active');assert.equal(app.store.workspaceEpoch,epoch);assert.equal(fs.readFileSync(path.join(f.work,'result.txt'),'utf8'),'SYNTHETIC_RESULT');
 const events=fs.readFileSync(path.join(f.stateDir,'diagnostics/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.kind==='workspace.check');assert.ok(events.some(e=>e.code===code&&e.outcome==='retry'));assert.ok(events.some(e=>e.code===code&&e.outcome==='failed'));assert.ok(events.some(e=>e.outcome==='ok'));assert.ok(events.every(e=>!Object.hasOwn(e,'path')&&!Object.hasOwn(e,'identity')));
});

for(const failure of ['timeout','exit'])test(`one real probe ${failure} is retried within the operation without a confirmation lock`,async t=>{
 let count=0;const children=[];
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeTimeoutMs=200;f.probeFactory=()=>{const child=count++===0?childWith(failure==='timeout'?'process.once("message",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0))':'process.once("message",()=>process.exit(1))'):spawnWorkspaceProbe();children.push(child);return child;};}}),{app}=f,id=begin(app);
 await write(app,id);assert.ok(count>=2);assert.equal(app.store.workspaceStatus().available,true);assert.equal(app.store.workspaceStatus().confirm_reason,null);assert.equal(app.state.project().workspace_recovery_required,undefined);assert.equal(app.store.workspaceEpoch,0);assert.equal(app.policy.get(id).status,'active');await waitFor(()=>children.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('successful use leaves no monitor, and later use and the file-scope page each check again',async t=>{
 const children=[],calls=[];const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeFactory=data=>{calls.push(data);const child=spawnWorkspaceProbe();children.push(child);return child;};}});
 assert.equal(calls.length,0);await f.post('/api/workspace/check');await waitFor(()=>children.every(child=>child.exitCode!==null));const checked=calls.length;
 await new Promise(resolve=>setTimeout(resolve,650));assert.equal(calls.length,checked);assert.ok(calls.every(data=>data.monitor===undefined));
 await f.app.tools.invoke('read_file',{path:'original.txt'});assert.ok(calls.length>checked);const used=calls.length;await f.post('/api/workspace/check');assert.ok(calls.length>used);await waitFor(()=>children.every(child=>child.exitCode!==null));
});

test('an automatic write uses one preflight and an exhausted preflight can retry the same operation later',async t=>{
 let failed=0,calls=0;
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeOverride=data=>{calls++;return failed-->0?{path:data.root,available:false,writable:false,status:'inaccessible',code:'WORKSPACE_TIMEOUT'}:undefined;};}}),args={task_id:randomUUID(),path:'automatic.txt',content:'ONCE',expected_sha256:'MISSING',operation_id:randomUUID()};
 failed=3;await assert.rejects(f.app.tools.invoke('write_text',args),{code:'WORKSPACE_UNAVAILABLE'});assert.equal(f.app.policy.tasks.size,0);assert.equal(fs.existsSync(path.join(f.work,args.path)),false);
 const before=calls,result=await f.app.tools.invoke('write_text',args);assert.equal(result.execution_state,'completed');assert.equal(result.task_created,true);assert.equal(calls-before,1);assert.equal(fs.readFileSync(path.join(f.work,args.path),'utf8'),'ONCE');
 const replay=await f.app.tools.invoke('write_text',args);assert.equal(replay.execution_state,'completed');assert.equal(replay.replayed,true);assert.equal(fs.readFileSync(path.join(f.work,args.path),'utf8'),'ONCE');
});

test('a device-number-only change preserves the folder and pending command authority',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f;await f.post('/api/workspace/check');const id=begin(app),epoch=app.store.workspaceEpoch,original=fs.statSync;let devOffset=1;
 t.mock.method(fs,'statSync',(file,...args)=>{const st=original(file,...args);return file===f.work?Object.assign(Object.create(Object.getPrototypeOf(st)),st,{dev:st.dev+devOffset}):st;});
 assert.equal(app.store.read('original.txt').content,'ORIGINAL_PROJECT');assert.equal(app.store.workspaceStatus().confirm_reason,null);
 t.mock.method(app.queue,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("SAFE")'],cwd:'.'});devOffset=2;app.queue.approve(job.job_id);await waitFor(()=>app.queue.get(job.job_id).status==='completed');
 assert.equal(app.queue.publicJob(app.queue.get(job.job_id)).stdout,'SAFE');assert.equal(app.store.workspaceEpoch,epoch);assert.equal(app.policy.get(id).status,'active');assert.equal(app.state.project().workspace_recovery_required,undefined);assert.equal(persisted(f).workspace_identities[f.selectedId].ino,original(f.work).ino);
});

for(const change of ['inode','real_path'])test(`a real ${change} replacement still requires confirmation and invalidates old tasks`,async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'auto'}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);await write(app,id,'original-task.txt');const identity=structuredClone(app.state.data.workspace_identities[f.selectedId]),epoch=app.store.workspaceEpoch;
 fs.renameSync(f.work,f.preserved);if(change==='inode')fs.mkdirSync(f.work);else fs.symlinkSync(f.other,f.work);
 await assert.rejects(write(app,id,'forbidden.txt'),{code:'WORKSPACE_UNAVAILABLE'});assert.equal(app.store.workspaceStatus().confirm_reason,'replaced');assert.equal(app.state.project().workspace_recovery_required,true);assert.ok(app.store.workspaceEpoch>epoch);assert.equal(app.policy.get(id).status,'workspace_changed');assert.deepEqual(app.state.data.workspace_identities[f.selectedId],identity);assert.equal(fs.existsSync(path.join(change==='inode'?f.work:f.other,'forbidden.txt')),false);
 if(change==='inode'){assert.equal((await f.post('/api/workspace/recreate')).status,200);await write(app,begin(app),'new-task.txt');await assert.rejects(write(app,id,'old-task.txt'));assert.equal(fs.existsSync(path.join(f.work,'old-task.txt')),false);}
 assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

for(const match of [true,false])test(`restart with a saved identity ${match?'clears a matching recovery flag automatically':'keeps a replacement blocked'}`,async t=>{
 const f=await workspaceFixture(t,{missing:false});await f.post('/api/workspace/check');const original=f.app,identity=structuredClone(original.state.data.workspace_identities[f.selectedId]);original.state.project().workspace_recovery_required=true;original.state.save();await f.close();
 if(!match){fs.renameSync(f.work,f.preserved);fs.mkdirSync(f.work);}await f.boot();await waitFor(()=>f.app.store.workspace.status!=='recovery_required'||f.app.store.workspace.code==='WORKSPACE_CHANGED');
 if(match){assert.equal(f.app.store.workspaceStatus().available,true);assert.equal(f.app.state.project().workspace_recovery_required,undefined);assert.equal(persisted(f).projects.find(p=>p.id===f.selectedId).workspace_recovery_required,undefined);assert.equal(f.app.store.workspaceEpoch,original.store.workspaceEpoch);}
 else{assert.equal(f.app.store.workspaceStatus().available,false);assert.equal(f.app.store.workspaceStatus().confirm_reason,'replaced');assert.deepEqual(f.app.state.data.workspace_identities[f.selectedId],identity);}
});

test('legacy recovery flags without an accepted identity explain the one-time confirmation',async t=>{
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{const file=path.join(f.stateDir,'desktop.json'),data=JSON.parse(fs.readFileSync(file));data.projects.find(p=>p.id===f.selectedId).workspace_recovery_required=true;fs.writeFileSync(file,JSON.stringify(data));}});
 const checked=await f.post('/api/workspace/check');assert.equal(checked.body.project.workspace.confirm_reason,'legacy_identity_unknown');assert.equal(checked.body.project.workspace.available,false);assert.equal(f.app.state.data.workspace_identities,undefined);
 assert.equal((await f.post('/api/workspace/recreate')).status,200);assert.equal(f.app.store.workspaceStatus().available,true);assert.equal(f.app.state.project().workspace_recovery_required,undefined);assert.equal(persisted(f).workspace_identities[f.selectedId].ino,fs.statSync(f.work).ino);
});

test('an identity save failure does not masquerade as a persisted baseline on the next use',async t=>{
 const f=await workspaceFixture(t,{missing:false}),save=f.app.state.save.bind(f.app.state);let failOnce=true;
 t.mock.method(f.app.state,'save',()=>{if(failOnce){failOnce=false;throw Object.assign(Error('Synthetic identity save failure'),{code:'SYNTHETIC_SAVE_FAILURE'});}return save();});
 const first=await f.post('/api/workspace/check');assert.equal(first.status,400);assert.equal(first.body.error.code,'SYNTHETIC_SAVE_FAILURE');assert.equal(f.app.state.data.workspace_identities,undefined);assert.equal(persisted(f).workspace_identities,undefined);
 assert.equal((await f.post('/api/workspace/check')).status,200);assert.equal(persisted(f).workspace_identities[f.selectedId].ino,fs.statSync(f.work).ino);
});

test('cancelling a file-scope UI check leaves an independent file operation running',async t=>{
 const children=[];let index=0;
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeTimeoutMs=1500;f.probeFactory=data=>{const n=index++,result=inspectWorkspace(data.root,data.stateDir),child=n===0?childWith('process.once("message",()=>setTimeout(()=>process.send('+JSON.stringify(result)+',()=>process.exit(0)),350))'):n===1?childWith('process.once("message",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0))'):spawnWorkspaceProbe();children.push(child);return child;};}});
 const file=outcome(f.app.tools.invoke('read_file',{path:'original.txt'}));await waitFor(()=>children.length===1);const ui=outcome(f.post('/api/workspace/check'));await waitFor(()=>children.length===2);await f.post('/api/workspace/check/cancel');assert.equal((await ui).ok,true);const result=await file;assert.equal(result.ok,true);assert.equal(result.value.content,'ORIGINAL_PROJECT');assert.equal(f.app.store.workspaceStatus().available,true);assert.equal(f.app.state.project().workspace_recovery_required,undefined);await waitFor(()=>children.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('a project switch while an automatic file check waits never moves the operation to the new project',async t=>{
 const children=[];const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeTimeoutMs=1500;f.probeFactory=()=>{const child=childWith('process.once("message",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0))');children.push(child);return child;};}});
 const pending=outcome(write(f.app,randomUUID(),'must-not-exist.txt'));await waitFor(()=>children.length===1);assert.equal((await f.post('/api/projects/select',{id:f.secondId})).status,200);assert.equal((await pending).error.code,'ROOT_CHANGED');assert.equal(fs.existsSync(path.join(f.work,'must-not-exist.txt')),false);assert.equal(fs.existsSync(path.join(f.other,'must-not-exist.txt')),false);assert.equal(f.app.policy.tasks.size,0);
});

test('a project switch after the check but before dispatch cannot create an automatic task in the new project',async t=>{
 const f=await workspaceFixture(t,{missing:false}),{app}=f,invoke=app.tools.invokeBound.bind(app.tools);let entered=false,release;const gate=new Promise(resolve=>release=resolve);
 t.mock.method(app.tools,'invokeBound',async(...args)=>{if(args[0]==='write_text'&&!entered){entered=true;await gate;}return invoke(...args);});
 const pending=outcome(write(app,randomUUID(),'must-not-exist.txt'));await waitFor(()=>entered);assert.equal((await f.post('/api/projects/select',{id:f.secondId})).status,200);release();assert.equal((await pending).error.code,'ROOT_CHANGED');assert.equal(fs.existsSync(path.join(f.other,'must-not-exist.txt')),false);assert.equal(app.policy.tasks.size,0);
});

test('confirmation cannot accept another replacement during the command-cleanup wait',async t=>{
 const f=await workspaceFixture(t,{missing:false}),{app}=f;await f.post('/api/workspace/check');fs.renameSync(f.work,f.preserved);fs.mkdirSync(f.work);await f.post('/api/workspace/check');
 const list=app.queue.list.bind(app.queue);let waiting=true;t.mock.method(app.queue,'list',(...args)=>waiting?[{cleanup_pending:true}]:list(...args));
 const pending=f.post('/api/workspace/recreate');await waitFor(()=>app.store.workspaceTransitioning);fs.renameSync(f.work,path.join(f.root,'second-preserved'));fs.mkdirSync(f.work);waiting=false;
 assert.equal((await pending).status,400);assert.equal(app.store.workspaceStatus().available,false);assert.equal(app.store.workspaceStatus().confirm_reason,'replaced');assert.equal(app.state.project().workspace_recovery_required,true);
});

test('workspace diagnostics retain categories and omit unrelated payload fields',()=>{
 assert.deepEqual(workspaceCheckFields({source:'use',outcome:'retry',code:'WORKSPACE_TIMEOUT',confirm_reason:null,n:1,path:'/private/example',details:'private payload'}),{source:'use',outcome:'retry',code:'WORKSPACE_TIMEOUT',confirm_reason:null,n:1});assert.equal(workspaceCheckFields({source:'use',outcome:'failed',code:'private text',confirm_reason:null}),null);assert.equal(workspaceCheckFields({source:'use',outcome:'failed',code:'WORKSPACE_CHANGED',confirm_reason:'arbitrary reason'}),null);
});

test('a filesystem I/O failure is not reported as a permission denial',async t=>{
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeOverride=data=>({path:data.root,available:false,writable:false,status:'inaccessible',code:'EIO'});}}),result=await f.post('/api/workspace/check');assert.equal(result.body.project.workspace.code,'EIO');assert.equal(result.body.project.workspace.confirm_reason,'inaccessible');
});

test('all retry attempts share one deadline instead of multiplying the timeout budget',async()=>{
 let attempts=0;const inspector={timeoutMs:80,inspect:async(_root,_state,{timeoutMs})=>{attempts++;await new Promise(resolve=>setTimeout(resolve,Math.min(80,timeoutMs)));return {available:false,status:'inaccessible',code:'WORKSPACE_TIMEOUT'};}};
 const start=Date.now(),result=await inspectWorkspaceWithRetry(inspector,'/synthetic/workspace','/synthetic/state');assert.equal(result.code,'WORKSPACE_TIMEOUT');assert.ok(attempts>=2&&attempts<=3);assert.ok(Date.now()-start<550);
});
