import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
import {TaskPolicy} from '../../app/policy.mjs';

function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ken-task-revocation-'));
  const stateDir=path.join(base,'state'),work=path.join(base,'work');
  fs.mkdirSync(work);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  return {stateDir,work};
}
const context={setupPrincipal:'fixture:task-revocation',session:'task-revocation-session'};

test('stopped task and its file changes remain readable after service restart',async t=>{
  const {stateDir,work}=fixture(t);
  let app=await createDesktop({stateDir,defaultRoot:work});
  const task=await app.tools.invoke('begin_task',{request_id:crypto.randomUUID(),title:'Cancelled history fixture'},'chatgpt',context);
  await app.tools.invoke('write_text',{task_id:task.task_id,path:'record.txt',content:'保留取消前的改动\n',expected_sha256:'MISSING',operation_id:crypto.randomUUID()},'chatgpt',context);
  await app.handle('/api/tasks/stop',{id:task.task_id});
  assert.equal(app.policy.get(task.task_id,'chatgpt').status,'cancelled');
  await app.close();

  app=await createDesktop({stateDir,defaultRoot:work});
  try{
    const status=await app.tools.invoke('task_status',{task_id:task.task_id},'chatgpt',context);
    assert.equal(status.status,'cancelled');
    assert.equal(status.terminal,true);
    assert.equal(status.execution_complete,false);
    assert.ok(Number.isSafeInteger(status.finished_at));
    const history=await app.tools.invoke('task_history',{limit:50},'chatgpt',context);
    assert.equal(history.tasks.find(item=>item.task_id===task.task_id)?.status,'cancelled');
    const changes=await app.tools.invoke('task_changes',{task_id:task.task_id},'chatgpt',context);
    assert.equal(changes.changes[0].path,'record.txt');
    assert.equal(fs.readFileSync(path.join(work,'record.txt'),'utf8'),'保留取消前的改动\n');
    assert.equal(app.policy.get(task.task_id,'another-client').status,'cancelled');
    const project=app.state.data.active;app.state.data.active='other-project';try{assert.throws(()=>app.policy.getBound(task.task_id,'another-client',null),{code:'ROOT_CHANGED'});}finally{app.state.data.active=project;}
    await assert.rejects(app.tools.invoke('finish_task',{task_id:task.task_id,success:false},'chatgpt',context),{code:'TASK_CANCELLED'});
    await app.handle('/api/tasks/stop',{id:task.task_id});
    assert.equal((await app.tools.invoke('task_status',{task_id:task.task_id},'chatgpt',context)).status,'cancelled');
  }finally{await app.close();}
});

test('shutdown revocation is retained as revoked (shown as 没收到结果) instead of disappearing',async t=>{
  const {stateDir,work}=fixture(t);
  let app=await createDesktop({stateDir,defaultRoot:work});
  const task=await app.tools.invoke('begin_task',{request_id:crypto.randomUUID(),title:'Paused history fixture'},'chatgpt',context);
  await app.close();
  app=await createDesktop({stateDir,defaultRoot:work});
  try{
    const status=await app.tools.invoke('task_status',{task_id:task.task_id},'chatgpt',context);
    assert.equal(status.status,'revoked');
    assert.equal(status.execution_complete,false);
    const history=await app.tools.invoke('task_history',{limit:50},'chatgpt',context);
    assert.equal(history.tasks.find(item=>item.task_id===task.task_id)?.status,'revoked');
  }finally{await app.close();}
});

test('all revocation reasons keep their original terminal status and owner',t=>{
  const {stateDir,work}=fixture(t);
  const state={data:{mode:'auto',auto_approve_tasks:true,active:'fixture',conversations:[]}};
  const queue={cancel(){},cancelAll(){},inputs:new Map()};
  const policy=new TaskPolicy(state,{stateDir,root:work,paused:false},queue);
  policy.enabled=true;
  for(const reason of ['rejected','expired','permission_changed','workspace_changed']){
    const task=policy.begin({request_id:crypto.randomUUID(),title:`Reason ${reason}`},'owner');
    policy.revokeTask(policy.get(task.task_id,'owner'),reason);
    const restored=new TaskPolicy(state,{stateDir,root:work,paused:false},queue);
    assert.equal(restored.get(task.task_id,'owner').status,reason);
    assert.equal(restored.get(task.task_id,'other').status,reason);
    const prior=state.data.active;state.data.active='other-project';try{assert.throws(()=>restored.getBound(task.task_id,'other',null),{code:'ROOT_CHANGED'});}finally{state.data.active=prior;}
    assert.throws(()=>restored.finish(task.task_id,'owner',false));
  }
});

test('receipt write failure reports error after cancelling jobs and permits same stop retry',t=>{
  const {stateDir,work}=fixture(t);
  const cancelled=[];
  const state={data:{mode:'auto',auto_approve_tasks:true,active:'fixture',conversations:[]}};
  const queue={cancel(id){cancelled.push(id);},cancelAll(){cancelled.push('all');},inputs:new Map()};
  const policy=new TaskPolicy(state,{stateDir,root:work,paused:false},queue);
  policy.enabled=true;
  const task=policy.begin({request_id:crypto.randomUUID(),title:'Receipt failure'},'owner');
  const record=policy.tasks.get(task.task_id);
  record.jobs.push('fixture-job');
  const save=policy.receipts.saveRevocation.bind(policy.receipts);
  policy.receipts.saveRevocation=()=>{throw Object.assign(Error('disk failed'),{code:'TASK_RECEIPT_WRITE_FAILED'});};
  assert.throws(()=>policy.revokeTask(record,'cancelled'),{code:'TASK_RECEIPT_WRITE_FAILED'});
  assert.deepEqual(cancelled,['fixture-job']);
  assert.equal(record.status,'cancelled');
  policy.receipts.saveRevocation=save;
  assert.equal(policy.revokeTask(record,'cancelled').status,'cancelled');
  assert.equal(policy.receipts.read(task.task_id,'owner').result.status,'cancelled');
  assert.equal(policy.revokeTask(record,'rejected').status,'cancelled');
});

test('bulk stop still cancels the queue after a receipt failure and can persist on retry',t=>{
  const {stateDir,work}=fixture(t);
  const calls=[];
  const state={data:{mode:'auto',auto_approve_tasks:true,active:'fixture',conversations:[]}};
  const queue={cancel(id){calls.push(id);},cancelAll(){calls.push('all');},inputs:new Map()};
  const policy=new TaskPolicy(state,{stateDir,root:work,paused:false},queue);
  policy.enabled=true;
  const task=policy.begin({request_id:crypto.randomUUID(),title:'Bulk stop fixture'},'owner');
  policy.tasks.get(task.task_id).jobs.push('job');
  const save=policy.receipts.saveRevocation.bind(policy.receipts);
  policy.receipts.saveRevocation=()=>{throw Object.assign(Error('disk failed'),{code:'TASK_RECEIPT_WRITE_FAILED'});};
  assert.throws(()=>policy.revokeAll('paused'),{code:'TASK_RECEIPT_WRITE_FAILED'});
  assert.deepEqual(calls,['job','all']);
  assert.equal(policy.tasks.get(task.task_id).status,'paused');
  policy.receipts.saveRevocation=save;
  policy.revokeAll('paused');
  assert.equal(policy.receipts.read(task.task_id,'owner').result.status,'paused');
});

function failRevocationWrites(app){
  const original=app.policy.receipts.saveRevocation;
  app.policy.receipts.saveRevocation=()=>{throw Object.assign(Error('injected receipt write failure'),{code:'TASK_RECEIPT_WRITE_FAILED'});};
  return ()=>{app.policy.receipts.saveRevocation=original;};
}

test('automation_stop cancels native and browser work even when receipt persistence fails',async t=>{
  const {stateDir,work}=fixture(t),app=await createDesktop({stateDir,defaultRoot:work});
  let restore=()=>{};
  try{
    const task=await app.tools.invoke('begin_task',{request_id:crypto.randomUUID(),title:'Automation stop failure fixture'},'chatgpt');
    const calls=[];
    app.tools.automation.computer.cancelAll=()=>{calls.push('native');};
    app.tools.automation.browser.close=async caller=>{calls.push(`browser:${caller}`);};
    restore=failRevocationWrites(app);
    await assert.rejects(app.tools.invoke('automation_stop',{task_id:task.task_id},'chatgpt'),{code:'TASK_RECEIPT_WRITE_FAILED'});
    assert.deepEqual(calls,['native','browser:chatgpt']);
  }finally{restore();await app.close();}
});

for(const route of ['/api/relay/stop','/api/relay/forget'])test(`${route} stops relay and persists preference none after receipt failure`,async t=>{
  const {stateDir,work}=fixture(t),app=await createDesktop({stateDir,defaultRoot:work});
  let restore=()=>{};
  try{
    const task=await app.tools.invoke('begin_task',{request_id:crypto.randomUUID(),title:`${route} failure fixture`},'chatgpt');
    app.state.data.connection_preference='relay';app.state.save();
    const calls=[];
    app.relay.stop=async options=>{calls.push(options?.forget?'forget':'stop');return {status:'off'};};
    restore=failRevocationWrites(app);
    await assert.rejects(app.handle(route,{}),{code:'TASK_RECEIPT_WRITE_FAILED'});
    assert.deepEqual(calls,[route.endsWith('/forget')?'forget':'stop']);
    assert.equal(app.state.data.connection_preference,'none');
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir,'desktop.json'),'utf8')).connection_preference,'none');
    assert.equal(app.policy.get(task.task_id,'chatgpt').status,'revoked');
  }finally{restore();await app.close();}
});

test('/api/tunnel/stop stops locally and persists preference none after receipt failure',async t=>{
  const {stateDir,work}=fixture(t),app=await createDesktop({stateDir,defaultRoot:work});
  let restore=()=>{};
  try{
    const task=await app.tools.invoke('begin_task',{request_id:crypto.randomUUID(),title:'Tunnel stop failure fixture'},'chatgpt');
    app.state.data.connection_preference='tunnel';app.state.save();
    let stopped=0;app.tunnel.stop=()=>{stopped++;};
    restore=failRevocationWrites(app);
    await assert.rejects(app.handle('/api/tunnel/stop',{}),{code:'TASK_RECEIPT_WRITE_FAILED'});
    assert.equal(stopped,1);
    assert.equal(app.state.data.connection_preference,'none');
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir,'desktop.json'),'utf8')).connection_preference,'none');
    assert.equal(app.policy.get(task.task_id,'chatgpt').status,'revoked');
  }finally{restore();await app.close();}
});

test('close releases service resources after receipt persistence fails',async t=>{
  const {stateDir,work}=fixture(t),app=await createDesktop({stateDir,defaultRoot:work});
  const task=await app.tools.invoke('begin_task',{request_id:crypto.randomUUID(),title:'Close failure fixture'},'chatgpt');
  const restore=failRevocationWrites(app);
  try{
    await app.close();
    await assert.rejects(fetch(`http://127.0.0.1:${app.apiPort}/api/state`));
    await assert.rejects(fetch(`http://127.0.0.1:${app.mcpPort}/mcp`));
    assert.equal(fs.existsSync(path.join(stateDir,'app.lock')),false);
    assert.equal(fs.existsSync(path.join(stateDir,'runtime.json')),false);
    assert.equal(app.policy.get(task.task_id,'chatgpt').status,'revoked');
  }finally{restore();}
});
