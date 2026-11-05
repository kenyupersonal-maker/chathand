import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {withFileTask} from '../../engine/src/core.mjs';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';
import {manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';
import {SandboxQueue} from '../../app/v06/terminal.mjs';

const begin=app=>app.policy.begin({request_id:randomUUID(),title:'Workspace isolation'},'chatgpt').task_id;
const outcome=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,error}));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function waitFor(condition){const until=Date.now()+2500;while(!condition()&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.ok(condition(),'temporary operation reaches its expected state');}
function extension(app){const ext=app.tools.automation.browser.extension,session=randomUUID(),helper=manifestStoreTestHelper();ext.heartbeat(session);ext.noteHelper(session,helper);ext.pauseRequested=false;return {ext,session,helper,next:()=>ext.next(session,helper)};}
async function write(app,id,name='mixed.txt'){return app.tools.invoke('write_text',{task_id:id,path:name,content:'TEMPORARY_TEST_DATA',expected_sha256:'MISSING',operation_id:randomUUID()});}

test('use-time loss detection and recovery preserve pure browser/desktop work while cancelling a mixed task',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f;await f.post('/api/settings',{desktop_enabled:true});
 const mixed=begin(app);await write(app,mixed);const browserTask=begin(app),desktopTask=begin(app),peer=extension(app),computer=app.tools.automation.computer;computer.heartbeat({accessibility:true,screen_recording:true});
 const browser=outcome(app.tools.invoke('browser_tabs',{task_id:browserTask,request_id:randomUUID(),action:'list'}));await waitFor(()=>peer.ext.pending.size===1);const request=peer.next();assert.equal(request.kind,'request');
 const desktop=outcome(app.tools.invoke('computer_applications',{task_id:desktopTask}));await waitFor(()=>computer.pending.size===1);const native=computer.next().request;
 const queued=outcome(app.tools.invoke('browser_tabs',{task_id:mixed,request_id:randomUUID(),action:'list'}));
 const globalEpoch=app.policy.epoch,revision=app.policy.permissionRevision||0,workspaceEpoch=app.store.workspaceEpoch;
 fs.renameSync(f.work,f.preserved);await f.post('/api/workspace/check');assert.equal(app.store.workspace.available,false);
 assert.equal(app.policy.get(browserTask).status,'active');assert.equal(app.policy.get(desktopTask).status,'active');assert.equal(app.policy.get(mixed).status,'workspace_changed');assert.equal(peer.ext.pending.size,1);assert.equal(computer.pending.size,1);assert.equal(peer.ext.pauseRequested,false);assert.equal(app.policy.epoch,globalEpoch);assert.equal(app.policy.permissionRevision||0,revision);assert.ok(app.store.workspaceEpoch>workspaceEpoch,JSON.stringify({before:workspaceEpoch,after:app.store.workspaceEpoch,flag:app.state.project().workspace_recovery_required}));
 assert.equal((await f.post('/api/workspace/recreate')).status,200);assert.equal(app.policy.epoch,globalEpoch);assert.equal(app.policy.permissionRevision||0,revision);
 assert.equal(peer.ext.complete(peer.session,request.id,{tabs:[{page_id:'7',title:'Uninterrupted Browser'}]}).accepted,true);assert.equal(computer.complete(native.id,{applications:[{name:'Uninterrupted Desktop'}]}).accepted,true);
 assert.equal((await browser).ok,true);assert.equal((await desktop).ok,true);assert.equal((await queued).error.code,'TASK_REVOKED');assert.equal(peer.ext.pending.size,0);
 await assert.rejects(write(app,browserTask,'old-browser-task.txt'),{code:'ROOT_CHANGED'});assert.equal(app.policy.get(browserTask).status,'active');assert.equal(fs.existsSync(path.join(f.work,'old-browser-task.txt')),false);
 await write(app,begin(app),'new-task.txt');assert.equal(fs.readFileSync(path.join(f.work,'new-task.txt'),'utf8'),'TEMPORARY_TEST_DATA');assert.equal(fs.readFileSync(path.join(f.preserved,'original.txt'),'utf8'),'ORIGINAL_PROJECT');
});

test('workspace loss closes in-flight uploads and cancels their mixed desktop and pending file approval only',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f;await f.post('/api/settings',{desktop_enabled:true});const peer=extension(app),computer=app.tools.automation.computer;computer.heartbeat({accessibility:true,screen_recording:true});
 const uploadTask=begin(app),pureTask=begin(app),upload=outcome(peer.ext.upload({task_id:uploadTask,request_id:randomUUID(),page_id:peer.ext.epoch+':7',snapshot_id:'snapshot',ref:'file-input',paths:['original.txt']},'chatgpt'));
 await waitFor(()=>peer.ext.pending.size===1);const pendingUpload=[...peer.ext.pending.values()][0],fd=pendingUpload.uploadFiles.files[0].fd;peer.next();
 const mixedDesktop=outcome(computer.request('applications',{},uploadTask,'chatgpt')),pureDesktop=outcome(computer.request('applications',{},pureTask,'chatgpt'));
 const approval=randomUUID();let applied=false;app.policy.approvals.set(approval,{id:approval,task_id:uploadTask,name:'write_text',status:'pending_approval',run(){applied=true;}});
 fs.renameSync(f.work,f.preserved);await f.post('/api/workspace/check');assert.equal(app.policy.get(uploadTask).status,'workspace_changed');
 assert.equal((await upload).error.code,'TASK_REVOKED');assert.equal((await mixedDesktop).error.code,'TASK_REVOKED');assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});assert.equal(pendingUpload.uploadFiles.closed,true);assert.equal(app.policy.approvals.get(approval).status,'cancelled');assert.throws(()=>app.policy.approveAction(approval),{code:'APPROVAL_STATE'});assert.equal(applied,false);
 assert.equal(app.policy.get(pureTask).status,'active');assert.equal(computer.pending.size,1);const native=computer.next().request;computer.complete(native.id,{applications:[]});assert.equal((await pureDesktop).ok,true);
});

test('the final input check discovers loss and stops pending commands and a live unowned process',async t=>{
 // Only replace environment selection. The real command queue spawns and
 // cancels a temporary Node process group; no login shell or user setup runs.
 t.mock.method(SandboxQueue.prototype,'prepareSpawn',job=>{job.sandbox={backend:'none',scope:'full'};return {program:job.program,args:job.args,env:{PATH:'/usr/bin:/bin',HOME:f.root,LANG:'en_US.UTF-8'}};});
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f;
 const running=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e','process.stdout.write("READY\\n");process.stdin.resume();setInterval(()=>{},100);'],cwd:'.',stdin_mode:'pipe'});app.queue.approve(running.job_id);await waitFor(()=>app.queue.get(running.job_id).events.some(e=>e.text.includes('READY')));const pid=app.queue.get(running.job_id).pid;
 const input=app.queue.proposeInput({job_id:running.job_id,text:'never-send',request_id:randomUUID()}),task=begin(app),pending=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e',''],cwd:'.'});app.policy.jobOwners.set(pending.job_id,task);app.policy.get(task).jobs.push(pending.job_id);
 const epoch=app.policy.epoch;fs.renameSync(f.work,f.preserved);assert.equal(app.queue.get(running.job_id).status,'running');assert.throws(()=>app.queue.approveInput(input.input_id),{code:'WORKSPACE_UNAVAILABLE'});await waitFor(()=>!app.queue.get(running.job_id).child&&!app.queue.get(running.job_id).cleanupPending);
 assert.equal(app.queue.get(pending.job_id).status,'cancelled');assert.equal(app.queue.inputs.get(input.input_id).status,'cancelled');assert.equal(app.policy.get(task).status,'workspace_changed');assert.equal(app.policy.epoch,epoch);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.equal((await f.post('/api/workspace/recreate')).status,200);assert.throws(()=>app.queue.approve(pending.job_id));assert.throws(()=>app.queue.approveInput(input.input_id));assert.deepEqual(fs.readdirSync(f.work),[]);
});

test('loss aborts a live artifact download and clears a suspended search before either can resume into the restored folder',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f,artifactTask=begin(app),searchTask=begin(app),gate=deferred(),open=fs.promises.opendir.bind(fs.promises);let downloading=false,aborted=false,searchStarted=false;
 t.mock.method(fs.promises,'opendir',async dir=>{if(dir===f.work){searchStarted=true;await gate.promise;}return open(dir);});
 app.tools.artifacts.download=(_url,{signal})=>{downloading=true;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(Error('Temporary download stopped'),{code:'ARTIFACT_DOWNLOAD_STOPPED'}));},{once:true});});};app.tools.artifacts.native=async()=>({status:'cancelled'});
 const artifact=app.tools.artifacts.save({task_id:artifactTask,request_id:randomUUID(),files:[{file_name:'result.txt',download_url:'https://files.example.test/result'}]},'chatgpt',null);await waitFor(()=>downloading);
 const search=withFileTask(app.store,app.policy.get(searchTask),()=>app.tools.features.search.start({query:'ORIGINAL',path:'.',type:'content'},'chatgpt','a'.repeat(64)));await waitFor(()=>searchStarted);
 fs.renameSync(f.work,f.preserved);await f.post('/api/workspace/check');assert.equal(aborted,true);assert.equal((await artifact).status,'failed');assert.equal(app.tools.artifacts.active.size,0);assert.equal(app.tools.features.search.jobs.get(search.search_id).status,'cancelled');assert.equal(app.policy.get(artifactTask).status,'workspace_changed');assert.equal(app.policy.get(searchTask).status,'workspace_changed');
 assert.equal((await f.post('/api/workspace/recreate')).status,200);gate.resolve();await waitFor(()=>app.tools.features.search.jobs.get(search.search_id).finished_at);assert.deepEqual(fs.readdirSync(f.work),[]);assert.throws(()=>app.tools.features.search.results(search.search_id,'chatgpt','a'.repeat(64)),{code:'SEARCH_REVOKED'});
});

test('cross-project selection retains its existing task revocation while old file scopes cannot resume',async t=>{
 const f=await workspaceFixture(t,{missing:false,mode:'full'}),{app}=f,fileTask=begin(app),pureTask=begin(app);await write(app,fileTask);const before=app.store.workspaceEpoch;
 assert.equal((await f.post('/api/projects/select',{id:f.secondId})).status,200);assert.ok(app.store.workspaceEpoch>before);assert.equal(app.policy.get(fileTask).status,'workspace_changed');assert.equal(app.policy.get(pureTask).status,'workspace_changed');await assert.rejects(write(app,fileTask,'old.txt'));assert.equal(fs.existsSync(path.join(f.other,'old.txt')),false);await write(app,begin(app),'new.txt');assert.equal(app.state.data.mode,'full');
});
