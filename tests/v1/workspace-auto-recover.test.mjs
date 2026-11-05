import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';
import {SandboxQueue} from '../../app/v06/terminal.mjs';

const begin=app=>app.policy.begin({request_id:randomUUID(),title:'Workspace recovery'},'chatgpt').task_id;
const args=(id,name)=>({task_id:id,path:name,content:'SYNTHETIC',expected_sha256:'MISSING',operation_id:randomUUID()});
const write=(app,id,name)=>app.tools.invoke('write_text',args(id,name));
const defaultWorkspace=f=>{f.freshDefaultRoot=f.work;};

test('full mode recreates the missing default folder and keeps the task and permissions',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;
 await f.post('/api/workspace/check');const id=begin(app);await write(app,id,'before.txt');
 const epoch=app.store.workspaceEpoch,permission=app.policy.epoch,revision=app.policy.permissionRevision,writes=app.store.writesEnabled;
 fs.renameSync(f.work,f.preserved);
 const result=await write(app,id,'after.txt');
 assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
 assert.equal(fs.readFileSync(path.join(f.work,'after.txt'),'utf8'),'SYNTHETIC');
 assert.equal(app.policy.get(id).status,'active');assert.equal(app.store.workspaceEpoch,epoch);assert.equal(app.policy.epoch,permission);assert.equal(app.policy.permissionRevision,revision);assert.equal(app.store.writesEnabled,writes);
 assert.equal(result.chathand_note.kind,'workspace_recreated');assert.match(result.chathand_note.zh,/空文件夹.*废纸篓/);assert.match(result.chathand_note.en,/empty folder.*Trash/);
 assert.doesNotMatch(result.chathand_note.zh,/命令已停止/);assert.doesNotMatch(result.chathand_note.en,/commands were stopped/i);
 assert.equal((await write(app,id,'later.txt')).chathand_note,undefined);
});

test('a missing default folder discovered after preflight is recreated in the same operation',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;
 await f.post('/api/workspace/check');const id=begin(app),original=app.tools.invokeBound.bind(app.tools);let moved=false;
 t.mock.method(app.tools,'invokeBound',async(...args)=>{if(args[0]==='write_text'&&!moved){moved=true;fs.renameSync(f.work,f.preserved);}return original(...args);});
 const result=await write(app,id,'sync.txt');assert.equal(result.chathand_note.kind,'workspace_recreated');assert.equal(app.policy.get(id).status,'active');assert.equal(fs.readFileSync(path.join(f.work,'sync.txt'),'utf8'),'SYNTHETIC');
});

test('a folder lost after preflight waits for commands and reports recovery without replaying the file operation',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.on("SIGTERM",()=>{});process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);
 const original=app.tools.invokeBound.bind(app.tools);let calls=0;
 t.mock.method(app.tools,'invokeBound',async(...input)=>{if(input[0]==='write_text'){calls++;if(calls===1)fs.renameSync(f.work,f.preserved);}return original(...input);});
 const response=await app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_text',arguments:args(id,'must-not-replay.txt')}},'chatgpt',{setupPrincipal:'synthetic-workspace'});
 assert.equal(response.result.isError,true);assert.equal(response.result.structuredContent.code,'WORKSPACE_UNAVAILABLE');assert.equal(calls,1);
 const note=response.result.structuredContent.chathand_note;assert.equal(note.kind,'workspace_recreated');assert.match(note.zh,/命令已停止/);assert.match(note.en,/Running commands were stopped/);
 assert.match(response.result.structuredContent.message,/工作文件夹已恢复/);assert.doesNotMatch(response.result.structuredContent.message,/正在停止/);
 assert.equal(app.queue.settled(app.queue.get(job.job_id)),true);assert.equal(fs.existsSync(f.work),true);assert.equal(fs.existsSync(path.join(f.work,'must-not-replay.txt')),false);
});

test('a nested workspace action recovers a late folder loss without replay',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.on("SIGTERM",()=>{});process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);
 t.mock.method(app.tools,'revealPath',()=>assert.fail('The failed operation must not be replayed'));
 const original=app.tools.invokeBound.bind(app.tools);let calls=0;
 t.mock.method(app.tools,'invokeBound',async(...input)=>{if(input[0]==='desktop_action'){calls++;if(calls===1)fs.renameSync(f.work,f.preserved);}return original(...input);});
 const response=await app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_capability',arguments:{capability:'execute_task_step',parameters:{request_id:randomUUID(),task_id:id,tool:'desktop_action',arguments:{task_id:id,action:'reveal',path:'original.txt'}}}}},'chatgpt',{setupPrincipal:'synthetic-nested-recovery'});
 assert.equal(response.result.isError,true);assert.equal(response.result.structuredContent.code,'WORKSPACE_UNAVAILABLE');assert.equal(calls,1);
 assert.equal(app.queue.settled(app.queue.get(job.job_id)),true);assert.equal(fs.existsSync(f.work),true);
 assert.equal(response.result.structuredContent.chathand_note?.kind,'workspace_recreated');assert.match(response.result.structuredContent.chathand_note.zh,/命令已停止/);
});

test('full mode accepts an ordinary replacement at the same path without revoking the task',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f;await f.post('/api/workspace/check');const id=begin(app),epoch=app.store.workspaceEpoch;
 fs.renameSync(f.work,f.preserved);fs.mkdirSync(f.work);fs.writeFileSync(path.join(f.work,'existing.txt'),'NEW');
 const result=await write(app,id,'replacement.txt');assert.equal(result.chathand_note,undefined);assert.equal(app.policy.get(id).status,'active');assert.equal(app.store.workspaceEpoch,epoch);
 await assert.rejects(app.tools.invoke('write_text',{...args(id,'existing.txt'),expected_sha256:'MISSING'}),{code:'HASH_CONFLICT'});
 assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

test('a missing selected folder offers two choices and only the local recreate action resumes it',async t=>{
 const f=await workspaceFixture(t,{missing:false}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);await write(app,id,'before.txt');fs.renameSync(f.work,f.preserved);
 const result=await app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_text',arguments:args(id,'blocked.txt')}},'chatgpt',{setupPrincipal:'synthetic-workspace'});
 assert.equal(result.result.isError,true);const error=result.result.structuredContent;assert.equal(error.code,'WORKSPACE_UNAVAILABLE');
 const blocked=error.details.blocked;assert.equal(blocked.where.link,'chathand://settings/scope');assert.deepEqual(blocked.options.map(x=>x.label),['重新建','先不建']);assert.equal(blocked.options[0].link,'chathand://settings/scope');
 assert.equal(app.tools.confirmations.items.size,0);assert.equal(fs.existsSync(f.work),false);assert.equal(app.store.workspaceStatus().available,false);
 // With no recovery action, the folder stays blocked. A real ChatGPT choice is not exercised here.
 assert.equal(fs.existsSync(f.work),false);assert.equal(app.store.workspaceStatus().available,false);
 assert.equal((await f.post('/api/workspace/recreate')).status,200);assert.equal(app.store.workspaceStatus().available,true);assert.equal(fs.readdirSync(f.work).length,0);
 await write(app,begin(app),'resumed.txt');assert.equal(fs.readFileSync(path.join(f.work,'resumed.txt'),'utf8'),'SYNTHETIC');assert.equal(app.policy.get(id).status,'workspace_changed');
});

test('failed recreation leaves the workspace blocked and preserves the original files',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);fs.renameSync(f.work,f.preserved);
 const mkdir=fs.mkdirSync;t.mock.method(fs,'mkdirSync',(p,...rest)=>{if(p===f.work)throw Object.assign(Error('synthetic denied'),{code:'EACCES'});return mkdir(p,...rest);});
 await assert.rejects(write(app,id,'blocked.txt'),{code:'WORKSPACE_UNAVAILABLE'});assert.equal(fs.existsSync(f.work),false);assert.equal(app.store.workspaceStatus().available,false);assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

test('a failed replacement recovery preserves the accepted root and identity',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;
 await f.post('/api/workspace/check');const root=app.store.root,identity={...app.store.workspaceIdentity};
 fs.renameSync(f.work,f.preserved);fs.mkdirSync(f.work);
 t.mock.method(app.store,'onWorkspaceAutoRecover',()=>({workspace:{path:f.work,available:false,writable:false,status:'inaccessible',code:'WORKSPACE_RECOVERY_FAILED'},commandsStopped:true}));
 const status=app.store.checkWorkspace();
 assert.equal(status.available,false);assert.equal(status.code,'WORKSPACE_RECOVERY_FAILED');
 assert.equal(app.store.root,root);assert.deepEqual(app.store.workspaceIdentity,identity);assert.equal(app.store.workspaceRecoveryRequired,true);
});

test('a replacement that disappears during cancellation cannot corrupt the accepted identity',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;
 await f.post('/api/workspace/check');const id=begin(app),root=app.store.root,identity={...app.store.workspaceIdentity};
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);
 fs.renameSync(f.work,f.preserved);fs.mkdirSync(f.work);
 const cancel=app.queue.cancelAll.bind(app.queue);let moved=false;
 t.mock.method(app.queue,'cancelAll',()=>{cancel();if(!moved){moved=true;fs.renameSync(f.work,path.join(f.root,'replacement-moved'));}});
 const mkdir=fs.mkdirSync;t.mock.method(fs,'mkdirSync',(p,...rest)=>{if(p===f.work)throw Object.assign(Error('synthetic denied'),{code:'EACCES'});return mkdir(p,...rest);});
 const error=await write(app,id,'blocked.txt').then(()=>null,e=>e);
 assert.equal(error?.code,'WORKSPACE_UNAVAILABLE');assert.equal(error.workspaceCommandsStopped,true);
 assert.equal(app.store.root,root);assert.deepEqual(app.store.workspaceIdentity,identity);assert.equal(app.store.workspaceStatus().available,false);
 assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

test('shared preflight reports recreation only to participating calls',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);fs.renameSync(f.work,f.preserved);
 const [a,b]=await Promise.all([write(app,id,'one.txt'),write(app,id,'two.txt')]);assert.equal(a.chathand_note.kind,'workspace_recreated');assert.equal(b.chathand_note.kind,'workspace_recreated');
 assert.equal((await write(app,id,'three.txt')).chathand_note,undefined);
});

test('a running command stops when the default folder is recreated',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>{job.sandbox={backend:'none',scope:'full'};return {program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}};});
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.on("SIGTERM",()=>{});process.stdout.write("READY\\n");process.stdin.resume()'],cwd:'.',stdin_mode:'pipe'});app.queue.approve(job.job_id);
 const wait=async predicate=>{const deadline=Date.now()+3000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};
 await wait(()=>app.queue.get(job.job_id).events.some(e=>e.text.includes('READY')));const epoch=app.store.workspaceEpoch,permission=app.policy.epoch;
 fs.renameSync(f.work,f.preserved);const first=write(app,id,'new.txt');
 await wait(()=>app.queue.get(job.job_id).status==='cancelled');
 assert.equal(fs.existsSync(f.work),false);assert.equal(app.store.checkWorkspace().available,false);
 const second=write(app,id,'concurrent.txt');const [result,other]=await Promise.all([first,second]);
 assert.equal(app.queue.get(job.job_id).status,'cancelled');assert.equal(app.policy.get(id).status,'active');assert.equal(app.store.workspaceEpoch,epoch);assert.equal(app.policy.epoch,permission);
 assert.equal(app.queue.settled(app.queue.get(job.job_id)),true);assert.equal(app.queue.get(job.job_id).child,null);
 assert.match(result.chathand_note.zh,/空文件夹.*正在运行的命令已停止.*废纸篓/);assert.match(result.chathand_note.en,/empty one.*Running commands were stopped.*Trash/);
 assert.equal(other.chathand_note.kind,'workspace_recreated');assert.equal(fs.readFileSync(path.join(f.work,'new.txt'),'utf8'),'SYNTHETIC');assert.equal(fs.readFileSync(path.join(f.work,'concurrent.txt'),'utf8'),'SYNTHETIC');
});

test('a running command stops when a replacement folder is accepted',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);fs.renameSync(f.work,f.preserved);fs.mkdirSync(f.work);
 const result=await write(app,id,'replacement.txt');assert.equal(app.queue.get(job.job_id).status,'cancelled');assert.equal(app.policy.get(id).status,'active');
 assert.equal(result.chathand_note.kind,'workspace_commands_stopped');assert.match(result.chathand_note.zh,/命令已停止/);assert.doesNotMatch(result.chathand_note.zh,/空文件夹/);
});

test('a previously cancelled command is still awaited while its process is alive',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.on("SIGTERM",()=>{});process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);app.queue.cancel(job.job_id);
 assert.equal(app.queue.get(job.job_id).status,'cancelled');assert.ok(app.queue.get(job.job_id).child);
 fs.renameSync(f.work,f.preserved);const pending=write(app,id,'after-cancel.txt');
 while(app.store.workspaceStatus().status!=='stopping'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(fs.existsSync(f.work),false);assert.ok(app.queue.get(job.job_id).child);
 const result=await pending;assert.equal(app.queue.settled(app.queue.get(job.job_id)),true);
 assert.match(result.chathand_note.zh,/命令已停止/);assert.equal(fs.readFileSync(path.join(f.work,'after-cancel.txt'),'utf8'),'SYNTHETIC');
});

test('cancelling a UI check does not cancel a file operation sharing automatic recovery',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);
 const settled=app.queue.settled.bind(app.queue);let confirm=false;t.mock.method(app.queue,'settled',j=>confirm&&settled(j));
 fs.renameSync(f.work,f.preserved);const ui=f.post('/api/workspace/check');
 while(app.queue.get(job.job_id).status!=='cancelled'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(app.queue.get(job.job_id).status,'cancelled');const file=write(app,id,'file-survives-ui-cancel.txt');
 await new Promise(resolve=>setTimeout(resolve,250));await f.post('/api/workspace/check/cancel');confirm=true;
 const [uiResult,result]=await Promise.all([ui,file]);assert.equal(uiResult.status,200);
 assert.match(result.chathand_note.zh,/命令已停止/);assert.equal(fs.readFileSync(path.join(f.work,'file-survives-ui-cancel.txt'),'utf8'),'SYNTHETIC');
});

test('an unconfirmed stop keeps the folder closed until a later check confirms it',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);
 const settled=app.queue.settled.bind(app.queue);let confirm=false;t.mock.method(app.queue,'settled',j=>confirm&&settled(j));
 const ensure=app.tools.ensureWorkspace.bind(app.tools);let checks=0;t.mock.method(app.tools,'ensureWorkspace',(...input)=>{checks++;return ensure(...input);});
 fs.renameSync(f.work,f.preserved);const error=await write(app,id,'blocked.txt').then(()=>null,e=>e);
 assert.equal(error?.code,'WORKSPACE_UNAVAILABLE');assert.equal(error.workspaceCommandsStopped,undefined);assert.equal(fs.existsSync(f.work),false);assert.equal(checks,1);
 assert.equal(app.store.checkWorkspace().available,false);confirm=true;
 const resumed=await write(app,id,'resumed.txt');assert.equal(resumed.chathand_note.kind,'workspace_recreated');assert.match(resumed.chathand_note.zh,/命令已停止/);
 assert.equal(fs.readFileSync(path.join(f.work,'resumed.txt'),'utf8'),'SYNTHETIC');
});

test('changing mode while commands stop cannot recreate the former default folder',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.on("SIGTERM",()=>{});process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);
 fs.renameSync(f.work,f.preserved);const waiting=write(app,id,'old-scope.txt').then(()=>null,e=>e);
 while(app.queue.get(job.job_id).status!=='cancelled'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(app.queue.get(job.job_id).status,'cancelled');
 const changed=await f.post('/api/mode',{mode:'auto'});assert.equal(changed.status,200);
 const error=await waiting;assert.ok(error);assert.equal(fs.existsSync(f.work),false);assert.equal(fs.existsSync(path.join(f.preserved,'original.txt')),true);
});

test('one transient probe timeout does not stop a running command or add a notice',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);let first=true;f.probeOverride=()=>first?(first=false,{available:false,writable:false,status:'inaccessible',code:'WORKSPACE_TIMEOUT'}):undefined;
 const result=await write(app,id,'after-timeout.txt');assert.equal(app.queue.get(job.job_id).status,'running');assert.equal(result.chathand_note,undefined);
});

test('a stale missing observation does not stop a running command when the folder is present again',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);let first=true;f.probeOverride=()=>first?(first=false,{available:false,writable:false,status:'missing',code:'ENOENT'}):undefined;
 const result=await write(app,id,'after-stale-check.txt');assert.equal(app.queue.get(job.job_id).status,'running');assert.equal(result.chathand_note,undefined);assert.equal(app.policy.get(id).status,'active');
});

test('a device number change alone does not stop a running command',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);const st=fs.statSync(f.work);let first=true;
 f.probeOverride=()=>first?(first=false,{available:true,writable:true,status:'available',code:null,real_path:f.work,identity:{dev:st.dev+1,ino:st.ino}}):undefined;
 const result=await write(app,id,'device-only.txt');assert.equal(app.queue.get(job.job_id).status,'running');assert.equal(result.chathand_note,undefined);assert.equal(app.policy.get(id).status,'active');
});

test('an inconclusive second check does not stop a running command',async t=>{
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>({program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}}));
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);
 const job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");setInterval(()=>{},1000)'],cwd:'.'});app.queue.approve(job.job_id);
 const deadline=Date.now()+3000;while(!app.queue.get(job.job_id).events.some(e=>e.text.includes('READY'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(app.queue.publicJob(app.queue.get(job.job_id)).stdout,/READY/);let first=true;f.probeOverride=()=>first?(first=false,{available:false,writable:false,status:'missing',code:'ENOENT'}):undefined;
 const realpath=fs.realpathSync;let failed=false;t.mock.method(fs,'realpathSync',(p,...rest)=>{if(p===f.work&&!failed){failed=true;throw Object.assign(Error('temporary check failure'),{code:'EIO'});}return realpath(p,...rest);});
 const error=await write(app,id,'not-written.txt').then(()=>null,e=>e);assert.equal(error?.code,'WORKSPACE_UNAVAILABLE');assert.equal(error.workspaceCommandsStopped,undefined);assert.equal(app.queue.get(job.job_id).status,'running');assert.equal(app.policy.get(id).status,'active');
});

test('putting the original selected folder back restores access on the next use',async t=>{
 const f=await workspaceFixture(t,{missing:false}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);await write(app,id,'before.txt');
 const identity=fs.statSync(f.work).ino;fs.renameSync(f.work,f.preserved);await assert.rejects(write(app,id,'blocked.txt'),{code:'WORKSPACE_UNAVAILABLE'});
 assert.equal(app.store.workspaceStatus().available,false);assert.equal(app.store.checkWorkspace().available,false);assert.equal(fs.existsSync(f.work),false);
 fs.renameSync(f.preserved,f.work);assert.equal(fs.statSync(f.work).ino,identity);assert.equal(app.store.checkWorkspace().available,true);
 assert.equal(app.state.project().workspace_recovery_required,undefined);await write(app,begin(app),'restored.txt');assert.equal(fs.readFileSync(path.join(f.work,'restored.txt'),'utf8'),'SYNTHETIC');
});

test('a paused service does not recreate the default workspace',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');fs.renameSync(f.work,f.preserved);await f.post('/api/access',{enabled:false});
 await assert.rejects(app.tools.invoke('read_file',{path:'original.txt'}),{code:'LOCAL_DISABLED'});assert.equal(fs.existsSync(f.work),false);
});

test('a replacement symlink is not silently accepted in full mode',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f;await f.post('/api/workspace/check');const id=begin(app);await write(app,id,'before.txt');
 fs.renameSync(f.work,f.preserved);fs.symlinkSync(f.other,f.work);
 await assert.rejects(write(app,id,'blocked.txt'),{code:'WORKSPACE_UNAVAILABLE'});assert.equal(app.store.workspaceStatus().confirm_reason,'replaced');assert.equal(fs.existsSync(path.join(f.other,'blocked.txt')),false);assert.equal(app.policy.get(id).status,'workspace_changed');
});

test('the recreation notice survives a failed file operation without implying success',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:defaultWorkspace}),{app}=f;await f.post('/api/workspace/check');fs.renameSync(f.work,f.preserved);
 const result=await app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_file',arguments:{path:'original.txt'}}},'chatgpt',{setupPrincipal:'synthetic-workspace'});
 assert.equal(result.result.isError,true);assert.equal(result.result.structuredContent.code,'ENOENT');assert.equal(result.result.structuredContent.chathand_note.kind,'workspace_recreated');assert.equal(fs.existsSync(path.join(f.work,'original.txt')),false);
});

test('switching away from full access during a pending check cannot recreate the folder',async t=>{
 const children=[];const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:f=>{defaultWorkspace(f);f.probeFactory=()=>{const child=spawn(process.execPath,['-e','process.once("message",m=>setTimeout(()=>process.send({path:m.root,available:false,writable:false,status:"missing",code:"ENOENT"},()=>process.exit(0)),350))'],{stdio:['ignore','ignore','ignore','ipc'],detached:true});children.push(child);return child;};}}),{app}=f;
 app.store.checkWorkspace();const id=begin(app);fs.renameSync(f.work,f.preserved);const pending=write(app,id,'blocked.txt').then(()=>null,e=>e);
 while(!children.length)await new Promise(resolve=>setTimeout(resolve,5));assert.equal((await f.post('/api/mode',{mode:'auto'})).status,200);
 const error=await pending;assert.ok(error);assert.equal(fs.existsSync(f.work),false);assert.equal(fs.existsSync(path.join(f.preserved,'original.txt')),true);
});
