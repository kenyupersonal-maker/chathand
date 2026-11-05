import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';
import {manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';

const outcome=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,error}));
const begin=app=>app.policy.begin({request_id:randomUUID(),title:'Lazy workspace startup'},'chatgpt').task_id;
async function waitFor(condition){const until=Date.now()+1500;while(!condition()&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.ok(condition());}

test('blocked workspace probes are never called by startup, home snapshots, browser or desktop work',async t=>{
 const calls=[];let blocked=true;const children=[];
 const f=await workspaceFixture(t,{missing:false,mode:'full',beforeBoot:f=>{
  f.probeTimeoutMs=100;f.probeFactory=()=>{const child=spawn(process.execPath,['-e','process.once("message",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0))'],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','ignore','ipc'],detached:true});children.push(child);return child;};
  const isWorkspace=file=>typeof file==='string'&&(path.resolve(file)===f.work||path.resolve(file).startsWith(f.work+path.sep));
  for(const method of ['lstatSync','statSync','realpathSync','accessSync','existsSync','mkdirSync']){const original=fs[method];t.mock.method(fs,method,(file,...args)=>{if(isWorkspace(file)){calls.push(method);if(blocked)throw Object.assign(Error('Workspace I/O is unavailable'),{code:'EACCES'});}return original.call(fs,file,...args);});}
  const watch=fs.watch;t.mock.method(fs,'watch',(file,...args)=>{if(file===path.dirname(f.work)){calls.push('watch');if(blocked)throw Object.assign(Error('Workspace watcher unavailable'),{code:'EACCES'});}return watch.call(fs,file,...args);});
  // These asynchronous workspace probes would remain pending indefinitely.
  // Readiness must complete without starting or awaiting any of them.
  for(const method of ['lstat','stat','realpath','access']){const original=fs.promises[method];t.mock.method(fs.promises,method,(file,...args)=>{if(isWorkspace(file)){calls.push('async.'+method);return new Promise(()=>{});}return original.call(fs.promises,file,...args);});}
 }}),{app}=f;
 assert.equal((await f.read('/api/state')).body.project.workspace.status,'unchecked');assert.equal((await f.read('/api/native/state')).body.project.workspace.status,'unchecked');assert.equal((await app.tools.invoke('bridge_info',{})).workspace.status,'unchecked');assert.deepEqual(calls,[]);assert.equal(app.state.project().workspace_recovery_required,undefined);
 await f.post('/api/settings',{desktop_enabled:true});const browserTask=begin(app),desktopTask=begin(app),ext=app.tools.automation.browser.extension,session=randomUUID(),helper=manifestStoreTestHelper();ext.heartbeat(session);ext.noteHelper(session,helper);ext.pauseRequested=false;const computer=app.tools.automation.computer;computer.heartbeat({accessibility:true,screen_recording:true});
 const browser=outcome(app.tools.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_tabs',arguments:{task_id:browserTask,request_id:randomUUID(),action:'list'}}},'chatgpt',{setupPrincipal:'synthetic-workspace-probe'})),desktop=outcome(app.tools.invoke('computer_applications',{task_id:desktopTask}));await waitFor(()=>ext.pending.size===1&&computer.pending.size===1);const request=ext.next(session,helper),native=computer.next().request;assert.equal(request.kind,'request');assert.deepEqual(calls,[]);
 fs.renameSync(f.work,f.preserved);await new Promise(r=>setImmediate(r));assert.equal(app.store.workspace.status,'unchecked');assert.deepEqual(calls,[],'unused workspace has no startup watcher or probe');
 const checked=await f.post('/api/workspace/check');assert.equal(checked.status,200);assert.equal(checked.body.project.workspace.status,'inaccessible');assert.equal(checked.body.project.workspace.code,'WORKSPACE_TIMEOUT');assert.equal(children.length,3);assert.equal(checked.body.project.workspace.confirm_reason,null);assert.equal(app.state.project().workspace_recovery_required,undefined);assert.deepEqual(calls,[]);assert.equal(app.policy.get(browserTask).status,'active');assert.equal(app.policy.get(desktopTask).status,'active');
 ext.complete(session,request.id,{tabs:Array.from({length:400},(_,i)=>({page_id:String(i+1),title:'Synthetic browser title '.repeat(15)}))});computer.complete(native.id,{applications:[]});const result=await browser;assert.equal(result.ok,true);assert.equal(result.value.result.isError,false);assert.equal(result.value.result.structuredContent.output_summary.saved,false);assert.equal((await desktop).ok,true);assert.deepEqual(calls,[]);await assert.rejects(app.tools.invoke('read_file',{path:'original.txt'}),{code:'WORKSPACE_UNAVAILABLE'});assert.deepEqual(calls,[]);await waitFor(()=>children[0].exitCode!==null||children[0].signalCode!==null);assert.throws(()=>process.kill(children[0].pid,0),{code:'ESRCH'});blocked=false;
});

test('first explicit check canonicalizes the configured root without invalidating an ongoing browser task',async t=>{
 let configured;
 const f=await workspaceFixture(t,{missing:false,pathValue:({root,work})=>{fs.mkdirSync(path.join(root,'Alias'));configured=root+'/Alias/../'+path.basename(work);return configured;}}),{app}=f,task=begin(app),ext=app.tools.automation.browser.extension,session=randomUUID(),helper=manifestStoreTestHelper();
 assert.equal(app.store.root,configured);ext.heartbeat(session);ext.noteHelper(session,helper);ext.pauseRequested=false;
 const pending=outcome(app.tools.invoke('browser_tabs',{task_id:task,request_id:randomUUID(),action:'list'}));await waitFor(()=>ext.pending.size===1);const request=ext.next(session,helper),epoch=app.policy.epoch,revision=app.policy.permissionRevision||0,workspaceEpoch=app.store.workspaceEpoch;
 const checked=await f.post('/api/workspace/check');assert.equal(checked.body.project.workspace.available,true);assert.equal(app.store.root,f.work);assert.equal(app.state.project().path,configured);assert.equal(app.policy.epoch,epoch);assert.equal(app.policy.permissionRevision||0,revision);assert.equal(app.store.workspaceEpoch,workspaceEpoch);assert.equal(app.policy.require(task).status,'active');
 ext.complete(session,request.id,{tabs:[]});assert.equal((await pending).ok,true);
 await app.tools.invoke('write_text',{task_id:task,path:'same-workspace.txt',content:'SAME_FOLDER',expected_sha256:'MISSING',operation_id:randomUUID()});assert.equal(fs.readFileSync(path.join(f.work,'same-workspace.txt'),'utf8'),'SAME_FOLDER');
});

test('a fresh desktop does not create or inspect its default workspace until a file entry is used',async t=>{
 const calls=[];const f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{
  fs.unlinkSync(path.join(f.stateDir,'desktop.json'));fs.renameSync(f.work,f.preserved);f.freshDefaultRoot=f.work;f.probeOverride=data=>{calls.push('isolated-probe');assert.equal(data.create,true);return {path:data.root,available:false,writable:false,status:'inaccessible',code:'EACCES'};};
  for(const method of ['mkdirSync','realpathSync','statSync','lstatSync','accessSync']){const original=fs[method];t.mock.method(fs,method,(file,...args)=>{if(file===f.work){calls.push(method);throw Object.assign(Error('Unavailable initial workspace'),{code:'EACCES'});}return original.call(fs,file,...args);});}
 }});
 assert.equal((await f.read('/api/state')).body.project.workspace.status,'unchecked');assert.deepEqual(calls,[]);assert.equal(f.app.state.project().workspace_create_pending,true);const checked=await f.post('/api/workspace/check');assert.equal(checked.body.project.workspace.available,false);assert.deepEqual(calls,['isolated-probe']);
});

test('cancelling and closing a service with a synchronously stuck probe never waits for that probe',async t=>{
 const children=[],f=await workspaceFixture(t,{missing:false,beforeBoot:f=>{f.probeTimeoutMs=10000;f.probeFactory=()=>{const child=spawn(process.execPath,['-e','process.once("message",()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0))'],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','ignore','ipc'],detached:true});children.push(child);return child;};}}),first=outcome(f.post('/api/workspace/check'));
 await waitFor(()=>children.length===1);const start=Date.now();assert.equal((await f.read('/api/state')).body.project.workspace.status,'unchecked');assert.ok(Date.now()-start<500);assert.equal((await f.post('/api/workspace/check/cancel')).body.cancelled,true);assert.equal((await first).ok,true);assert.equal(f.app.state.project().workspace_recovery_required,undefined);await waitFor(()=>children[0].signalCode!==null);assert.throws(()=>process.kill(children[0].pid,0),{code:'ESRCH'});
 const second=outcome(f.post('/api/workspace/check'));await waitFor(()=>children.length===2);const closing=Date.now();await f.close();assert.ok(Date.now()-closing<1800,'service close keeps its existing one-second grace, not the ten-second probe timeout');await second;await waitFor(()=>children[1].signalCode!==null);assert.throws(()=>process.kill(children[1].pid,0),{code:'ESRCH'});
});
