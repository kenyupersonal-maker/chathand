import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startupFixture} from '../support/startup-five-fixture.mjs';
import {workspaceFixture} from '../support/workspace-recovery-fixture.mjs';

let request=0;
async function call(f,name,args){
 const runtime=JSON.parse(fs.readFileSync(path.join(f.stateDir,'runtime.json')));
 const response=await fetch(runtime.mcp_url,{method:'POST',headers:{'Content-Type':'application/json','X-Ken-Bridge-Token':runtime.mcp_token,Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++request,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':'synthetic-workspace-restart'}}})});
 assert.equal(response.status,200);return (await response.json()).result;
}
const write=(task_id,path,operation_id=randomUUID())=>({task_id,path,content:'SYNTHETIC_WORKSPACE_FILE',expected_sha256:'MISSING',operation_id});

test('real CLI rejects the same old task/operation before and after restart following explicit workspace recreation',async t=>{
 const first=await startupFixture(t);assert.equal((await first.request('/api/access',{enabled:true})).status,200);
 const started=await call(first,'begin_task',{request_id:randomUUID(),title:'Original workspace task'}),id=started.structuredContent.task_id;
 assert.equal((await call(first,'write_text',write(id,'original.txt'))).isError,false);
 const preserved=first.work+'-preserved';fs.renameSync(first.work,preserved);
 assert.equal((await first.request('/api/workspace/check',{})).status,200);assert.equal((await first.request('/api/workspace/recreate',{})).status,200);
 assert.equal((await call(first,'task_status',{task_id:id})).structuredContent.status,'workspace_changed');
 const args=write(id,'must-not-appear.txt');
 async function reject(f){const result=await call(f,'write_text',args);assert.equal(result.isError,true);assert.equal(result.structuredContent.code,'ROOT_CHANGED');assert.equal(result.structuredContent.task_created,undefined);assert.equal(fs.existsSync(path.join(f.work,args.path)),false);}
 await reject(first);await first.close();
 const restarted=await startupFixture(t,{existingRoot:first.root});await reject(restarted);
 assert.equal(fs.readFileSync(path.join(preserved,'original.txt'),'utf8'),'SYNTHETIC_WORKSPACE_FILE');
});

test('an in-memory task that has not used files cannot acquire the recreated workspace generation',async t=>{
 const f=await workspaceFixture(t,{missing:false});await f.post('/api/workspace/check');
 const task=f.app.policy.begin({request_id:randomUUID(),title:'Pure browser task'},'chatgpt');
 fs.renameSync(f.work,f.preserved);await f.post('/api/workspace/check');await f.post('/api/workspace/recreate');
 assert.equal(f.app.policy.get(task.task_id).status,'active');
 await assert.rejects(f.app.tools.autoTasks.execute('write_text',write(task.task_id,'must-not-appear.txt'),'chatgpt',{},()=>assert.fail('Old task must not reach the new workspace')),{code:'ROOT_CHANGED'});
 assert.equal(fs.existsSync(path.join(f.work,'must-not-appear.txt')),false);
});

test('same-project same-generation receipts and genuinely unknown task IDs keep existing automatic creation after restart',async t=>{
 const first=await startupFixture(t);await first.request('/api/access',{enabled:true});
 const started=await call(first,'begin_task',{request_id:randomUUID(),title:'Same generation task'}),id=started.structuredContent.task_id;
 assert.equal((await call(first,'write_text',write(id,'original.txt'))).isError,false);assert.equal((await call(first,'finish_task',{task_id:id})).isError,false);await first.close();
 const restarted=await startupFixture(t,{existingRoot:first.root});
 for(const [task,name]of [[id,'same-generation.txt'],[randomUUID(),'unknown-task.txt']]){
  const result=await call(restarted,'write_text',write(task,name));assert.equal(result.isError,false);assert.equal(result.structuredContent.task_created,true);assert.equal(fs.readFileSync(path.join(restarted.work,name),'utf8'),'SYNTHETIC_WORKSPACE_FILE');
 }
});
