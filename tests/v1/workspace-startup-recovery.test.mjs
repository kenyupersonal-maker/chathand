import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';
import {manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';
import {inspectWorkspace} from '../../app/v1/workspace-recovery.mjs';
import {desktopAction} from '../../app/v06/diagnostics.mjs';

const unavailable=fn=>assert.throws(fn,{code:'WORKSPACE_UNAVAILABLE'});
const begin=app=>app.policy.begin({request_id:randomUUID(),title:'Synthetic recovery task'},'chatgpt');

for(const [name,pathValue,status]of [
 ['missing',undefined,'missing'],['null',null,'invalid'],['non-string',{broken:'workspace'},'invalid'],['relative','relative/Portfolio','invalid'],['NUL','/invalid\0folder','invalid'],['file',({work})=>path.join(work,'original.txt'),'invalid'],['state overlap',({stateDir})=>stateDir,'invalid']
])test(`complete service starts with ${name} workspace and keeps its configured identity`,async t=>{
 const f=await workspaceFixture(t,{missing:pathValue===undefined,pathValue}),{app}=f;
 assert.equal((await f.read('/api/state')).body.project.workspace.status,'unchecked');assert.equal((await f.post('/api/workspace/check')).status,200);const {status:http,body:s}=await f.read('/api/state');assert.equal(http,200);assert.equal(s.project.id,f.selectedId);assert.equal(s.project.name,'Portfolio Workspace');assert.deepEqual(s.project.path,app.state.project().path);assert.equal(s.project.workspace.available,false);assert.equal(s.project.workspace.status,status);
 assert.equal((await fetch(f.origin+'/')).status,200);
 assert.equal((await f.read('/api/native/state')).body.project.workspace.available,false);
 unavailable(()=>app.store.list());unavailable(()=>app.store.resolve(f.other));unavailable(()=>app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e',''],cwd:'.'}));
 const browser=await app.tools.invoke('browser_status',{});assert.equal(browser.selected_backend,'extension');assert.equal(app.state.data.mode,'auto');assert.equal(fs.readFileSync(path.join(f.other,'other.txt'),'utf8'),'OTHER_PROJECT');
 const info=await app.tools.invoke('bridge_info',{});assert.equal(info.workspace.available,false);assert.equal(info.writes_enabled,false);assert.equal(info.terminal.available,false);
 if(name==='missing')assert.equal(fs.existsSync(f.work),false);
});

test('permission-denied workspace starts closed without substituting a different folder',async t=>{
 const original=fs.accessSync;
 t.mock.method(fs,'accessSync',(file,...args)=>{if(typeof file==='string'&&file.endsWith('/Portfolio'))throw Object.assign(Error('Synthetic permission denial'),{code:'EACCES'});return original(file,...args);});
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeOverride=data=>inspectWorkspace(data.root,data.stateDir);}});await f.post('/api/workspace/check');const s=(await f.read('/api/state')).body;
 assert.equal(s.project.path,f.work);assert.equal(s.project.workspace.status,'inaccessible');assert.equal(s.project.workspace.code,'EACCES');unavailable(()=>f.app.store.read('original.txt'));assert.equal(fs.readFileSync(path.join(f.work,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

test('read-only workspace keeps reading and independently stops file writes',async t=>{
 const original=fs.accessSync;
 t.mock.method(fs,'accessSync',(file,mode,...args)=>{if(typeof file==='string'&&file.endsWith('/Portfolio')&&mode===fs.constants.W_OK)throw Object.assign(Error('Synthetic read-only permission'),{code:'EACCES'});return original(file,mode,...args);});
 const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeOverride=data=>inspectWorkspace(data.root,data.stateDir);}}),{app}=f;await f.post('/api/workspace/check');const status=(await f.read('/api/state')).body.project.workspace;
 assert.equal(status.available,true);assert.equal(status.writable,false);assert.equal(status.status,'read_only');assert.equal(app.store.read('original.txt').content,'ORIGINAL_PROJECT');assert.equal((await app.tools.invoke('read_file',{path:'original.txt'})).content,'ORIGINAL_PROJECT');
 assert.throws(()=>app.store.write('blocked.txt','BLOCKED','MISSING',randomUUID()),{code:'WORKSPACE_READ_ONLY'});assert.equal(fs.existsSync(path.join(f.work,'blocked.txt')),false);assert.equal((await f.post('/api/workspace/recreate')).body.error.code,'WORKSPACE_READ_ONLY');assert.equal((await app.tools.invoke('bridge_info',{})).writes_enabled,false);
 assert.equal((await f.post('/api/projects/select',{id:f.secondId})).status,200);assert.equal(app.store.read('other.txt').content,'OTHER_PROJECT');
});

test('missing folder remains closed across restart and an external return until explicit local recreation',async t=>{
 const f=await workspaceFixture(t);const epoch=f.app.store.workspaceEpoch;
 assert.equal((await f.post('/api/workspace/recreate',{},false)).status,403);assert.equal(fs.existsSync(f.work),false);
 assert.equal((await f.post('/api/permissions/tier',{tier:'light'})).body.error.code,'WORKSPACE_UNAVAILABLE');assert.equal(fs.existsSync(f.work),false);
 await f.close();fs.renameSync(f.preserved,f.work);await f.boot();
 assert.equal((await f.read('/api/state')).body.project.workspace.status,'recovery_required');unavailable(()=>f.app.store.read('original.txt'));
 const old=begin(f.app);const recovered=await f.post('/api/workspace/recreate');assert.equal(recovered.status,200);assert.equal(recovered.body.project.workspace.available,true);assert.equal(f.app.policy.get(old.task_id).status,'active');assert.ok(f.app.store.workspaceEpoch>epoch);assert.equal(f.app.store.read('original.txt').content,'ORIGINAL_PROJECT');
 await f.close();await f.boot();assert.equal((await f.read('/api/state')).body.project.workspace.status,'unchecked');assert.equal(f.app.store.read('original.txt').content,'ORIGINAL_PROJECT');
});

for(const mode of ['auto','full'])test(`recreate preserves ${mode} settings, original moved data, and other projects`,async t=>{
 const f=await workspaceFixture(t,{mode});const old=begin(f.app),intent=f.app.state.data.permission_tier_intent,switches={terminal:f.app.state.data.terminal_enabled,browser:f.app.state.data.browser_enabled,desktop:f.app.state.data.desktop_enabled};
 const r=await f.post('/api/workspace/recreate');assert.equal(r.status,200);assert.equal(r.body.project.id,f.selectedId);assert.equal(r.body.project.path,f.work);assert.equal(f.app.state.data.mode,mode);assert.equal(f.app.state.data.permission_tier_intent,intent);assert.equal(f.app.policy.get(old.task_id).status,'active');await assert.rejects(f.app.tools.invoke('write_text',{task_id:old.task_id,path:'old.txt',content:'blocked',expected_sha256:'MISSING',operation_id:randomUUID()}),{code:'ROOT_CHANGED'});
 assert.deepEqual({terminal:f.app.state.data.terminal_enabled,browser:f.app.state.data.browser_enabled,desktop:f.app.state.data.desktop_enabled},switches);
 assert.deepEqual(fs.readdirSync(f.work),[]);assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');assert.equal(fs.readFileSync(path.join(f.other,'other.txt'),'utf8'),'OTHER_PROJECT');assert.equal(f.app.state.data.projects.length,2);
 assert.equal(f.app.store.write('new.txt','RECOVERED','MISSING',randomUUID()).created,true);assert.equal(f.app.store.read('new.txt').content,'RECOVERED');
});

test('recreate never creates missing parent folders or replaces a file',async t=>{
 const f=await workspaceFixture(t,{pathValue:({root})=>path.join(root,'Disconnected-volume','Portfolio')});
 const r=await f.post('/api/workspace/recreate');assert.equal(r.status,400);assert.equal(fs.existsSync(path.join(f.root,'Disconnected-volume')),false);assert.equal(f.app.store.workspaceStatus().available,false);
 fs.mkdirSync(path.join(f.root,'Disconnected-volume'));fs.writeFileSync(f.app.state.project().path,'DO_NOT_REPLACE');
 const again=await f.post('/api/workspace/recreate');assert.equal(again.status,400);assert.equal(fs.readFileSync(f.app.state.project().path,'utf8'),'DO_NOT_REPLACE');
});

test('choosing another existing folder keeps all original projects and permits the new scope',async t=>{
 const f=await workspaceFixture(t,{mode:'full'}),old=begin(f.app),before=structuredClone(f.app.state.data.projects);
 const added=await f.post('/api/projects/add',{name:'Other Project',folder:f.other,scope:'folder'});assert.equal(added.status,200);assert.equal(added.body.id,f.secondId);
 const selected=await f.post('/api/projects/select',{id:added.body.id});assert.equal(selected.status,200);assert.equal(selected.body.project.path,f.other);assert.equal(f.app.state.data.mode,'full');assert.equal(f.app.policy.get(old.task_id).status,'workspace_changed');
 assert.equal(f.app.store.read('other.txt').content,'OTHER_PROJECT');assert.equal(fs.existsSync(f.work),false);assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');assert.equal(f.app.state.data.projects.length,2);for(const p of before)assert.deepEqual(f.app.state.data.projects.find(x=>x.id===p.id),p);
});

test('a live disappearance revokes tasks and pending commands; a replacement cannot inherit their authority',async t=>{
 const f=await workspaceFixture(t,{missing:false}),{app}=f,old=begin(app),job=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e',''],cwd:'.'});
 app.policy.get(old.task_id).jobs.push(job.job_id);app.policy.jobOwners.set(job.job_id,old.task_id);fs.renameSync(f.work,f.preserved);
 unavailable(()=>app.store.list());assert.equal(app.policy.get(old.task_id).status,'workspace_changed');assert.equal(app.queue.get(job.job_id).status,'cancelled');
 fs.mkdirSync(f.work);unavailable(()=>app.store.list());assert.equal((await f.post('/api/workspace/recreate')).status,200);assert.throws(()=>app.policy.require(old.task_id),{code:'TASK_REVOKED'});assert.notEqual(app.queue.get(job.job_id).status,'running');assert.deepEqual(fs.readdirSync(f.work),[]);
});

test('real browser dispatch works while workspace is missing; recovery invalidates saved automatic file grants',async t=>{
 const f=await workspaceFixture(t),{app}=f,ext=app.tools.automation.browser.extension,session=randomUUID(),helper=manifestStoreTestHelper();ext.heartbeat(session);ext.noteHelper(session,helper);ext.pauseRequested=false;
 const task=begin(app),pending=app.tools.invoke('browser_tabs',{task_id:task.task_id,request_id:randomUUID(),action:'list'});
 let request;for(let n=0;n<30;n++){request=ext.next(session,helper);if(request.kind==='request')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(request.kind,'request');assert.equal(request.action,'tabs');assert.equal(ext.complete(session,request.id,{tabs:[{page_id:'7',title:'Synthetic Browser'}]}).accepted,true);assert.equal((await pending).tabs[0].title,'Synthetic Browser');assert.equal(fs.existsSync(f.work),false);
 const args={task_id:randomUUID(),operation_id:randomUUID(),path:'file.txt',content:'test',expected_sha256:'MISSING'};await app.tools.autoTasks.execute('write_text',args,'chatgpt',{},async()=>({created:false}));
 await f.post('/api/workspace/recreate');await f.close();await f.boot();
 await assert.rejects(f.app.tools.autoTasks.execute('write_text',args,'chatgpt',{},async()=>{throw Error('OLD_GRANT_REUSED');}),{code:'ROOT_CHANGED'});
});

test('workspace failure leaves system summary, desktop dispatch, and URL opening independent',async t=>{
 const f=await workspaceFixture(t,{mode:'full'}),{app}=f;
 const summary=await app.tools.invoke('system_inspect',{section:'summary'});assert.equal(summary.platform,process.platform);assert.equal(summary.workspace,f.work);
 await assert.rejects(app.tools.invoke('system_inspect',{section:'disk'}),{code:'WORKSPACE_UNAVAILABLE'});
 await f.post('/api/settings',{desktop_enabled:true});const task=begin(app),computer=app.tools.automation.computer;computer.heartbeat({accessibility:true,screen_recording:true});
 const pending=app.tools.invoke('computer_applications',{task_id:task.task_id});
 let request;for(let n=0;n<30;n++){request=computer.next().request;if(request)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(request.action,'applications');computer.authorize(request.id);computer.complete(request.id,{applications:[{name:'Synthetic Application',bundle_id:'test.synthetic.app'}]});assert.equal((await pending).applications[0].name,'Synthetic Application');
 if(process.platform==='darwin'){
  const calls=[];const opened=await desktopAction(app.store,{action:'open_url',url:'https://example.test/'},{execImpl:async(program,args)=>{calls.push({program,args});return {stdout:''};}});assert.equal(opened.requested,true);assert.deepEqual(calls,[{program:'/usr/bin/open',args:['https://example.test/']}]);
  await assert.rejects(desktopAction(app.store,{action:'reveal',path:'original.txt'},{execImpl:()=>assert.fail('No file reveal without a workspace')}),{code:'WORKSPACE_UNAVAILABLE'});
 }
 assert.equal(fs.existsSync(f.work),false);assert.equal(app.state.data.desktop_enabled,true);assert.equal(app.state.data.browser_enabled,true);assert.equal(app.state.data.mode,'full');
});

for(const pathValue of [null,42,{invalid:'path'}])test(`browser automatic receipts support invalid ${typeof pathValue} roots without granting file access`,async t=>{
 const f=await workspaceFixture(t,{pathValue,missing:false}),args={task_id:randomUUID(),request_id:randomUUID(),action:'list'};
 const result=await f.app.tools.autoTasks.execute('browser_tabs',args,'chatgpt',{},async()=>({tabs:[]}));assert.equal(result.execution_state,'completed');const replay=await f.app.tools.autoTasks.execute('browser_tabs',args,'chatgpt',{},async()=>assert.fail('Completed browser action must not repeat'));assert.equal(replay.replayed,true);unavailable(()=>f.app.store.resolve('.'));
});
