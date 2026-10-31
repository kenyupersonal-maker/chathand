import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../app/server.mjs';

// End-to-end through the registered product RPC route, never a standalone parser-only assertion.
// All activity records, clients and connection identities are synthetic and isolated.
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-activity-status-'));
 const work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({
  stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'a'.repeat(64),
  adminAccess:{supported:()=>false,ready:()=>false},
  clientDeps:{
   currentAppPath:path.join(root,'ChatHand.app'),
   computerName:()=> 'Isolated Test Mac',
   tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
   updaterFactory:()=>({currentBuild:1048,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
  }
 });
 app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 let seq=0;
 async function call(name,args={},session='session-A',principal='account-A',caller='connected-owner'){
  const out=await app.tools.rpc({
   jsonrpc:'2.0',id:++seq,method:'tools/call',
   params:{name,arguments:args,_meta:{'openai/session':session}}
  },caller,{setupPrincipal:principal});
  return out.result;
 }
 return {root,app,call};
}
function good(response){
 assert.equal(response?.isError,false,JSON.stringify(response?.structuredContent??response));
 return response.structuredContent;
}
const fingerprint=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('1049 actual task_status product path safely reads 1048 legacy notes for exact task and connected conversation',async t=>{
 const {app,call}=await fixture(t);
 const begin=good(await call('begin_task',{request_id:'legacy_route_task_01',title:'旧活动读取真实路径'}));
 const id=begin.task_id;
 const wrote=good(await call('log_note',{task_id:id,event:'fresh',summary:'真实新行记录',reference:'synthetic-ref'}));
 assert.equal(wrote.recorded,true);

 const file=path.join(app.store.stateDir,'activity-records',id+'.jsonl');
 const oldA={event:'old-A',kind:'decision',summary:'旧正文含字面 \\n 不可替换',reference:'mock',at:'2026-10-10T10:00:00.000Z'};
 const oldB={event:'old-B',kind:'activity',summary:'旧正文第一行\n旧正文第二行',reference:null,at:'2026-10-10T11:00:00.000Z',_card_meta:{secret:'PRIVATE-META-FIXTURE'}};
 // Mixed old literal separators and new real-line separator; no real user state is touched.
 fs.appendFileSync(file,JSON.stringify(oldA)+'\\n'+JSON.stringify(oldB)+'\n');
 const untouched=fingerprint(file),originalBytes=fs.readFileSync(file);
 const normal=good(await call('task_status',{task_id:id}));
 assert.equal(Object.hasOwn(normal,'activity_notes'),false);

 const result=good(await call('task_status',{task_id:id,include_activity:true,activity_limit:2}));
 assert.equal(result.activity_notes.state,'ok');
 assert.equal(result.activity_notes.total,3);
 assert.equal(result.activity_notes.offset,0);
 assert.equal(result.activity_notes.items[0].event,'fresh');
 assert.equal(result.activity_notes.items[1].event,'old-A');
 assert.equal(result.activity_notes.items[1].summary,oldA.summary);
 assert.equal(result.activity_notes.next_offset,2);
 const continued=good(await call('task_status',{task_id:id,include_activity:true,activity_offset:2,activity_limit:2}));
 assert.equal(continued.activity_notes.items[0].event,'old-B');
 assert.equal(continued.activity_notes.items[0].summary,oldB.summary);
 assert.equal(continued.activity_notes.next_offset,null);
 assert.equal(Object.hasOwn(continued.activity_notes.items[0],'_card_meta'),false);
 assert.ok(!JSON.stringify(continued).includes('PRIVATE-META-FIXTURE'));
 assert.equal(fingerprint(file),untouched);
 assert.deepEqual(fs.readFileSync(file),originalBytes);

 // A finished receipt remains readable when the live task has left memory.
 good(await call('finish_task',{task_id:id,success:true,summary:'测试任务已结束'}));
 app.policy.tasks.delete(id);
 const archived=good(await call('task_status',{task_id:id,include_activity:true,activity_offset:1,activity_limit:1}));
 assert.equal(archived.status,'completed');
 assert.equal(archived.activity_notes.items[0].event,'old-A');

 // Authenticated callers may continue the same task across connector/session
 // bindings in the same project and root. The status envelope still redacts
 // private card metadata and the historical file remains read-only.
 for(const [session,principal,caller] of [
  ['session-A','account-A','other-owner'],
  ['session-B','account-A','connected-owner'],
  ['session-A','account-B','connected-owner'],
  ['','account-A','connected-owner'],
 ]){
  const continued=good(await call('task_status',{task_id:id,include_activity:true},session,principal,caller));
  assert.equal(continued.status,'completed');
  assert.equal(continued.activity_notes.items.length,3);
  assert.ok(!JSON.stringify(continued).includes('PRIVATE-META-FIXTURE'));
  assert.equal(fingerprint(file),untouched);
 }
 const firstProject=app.state.data.active;
 app.state.data.active='other-project-fixture';
 try{
  const otherProject=await call('task_status',{task_id:id,include_activity:true});
  assert.equal(otherProject.isError,true);
  assert.equal(otherProject.structuredContent.code,'ROOT_CHANGED');
 }finally{app.state.data.active=firstProject;}

 // A second real task in the same session does not inherit the first task's notes.
 const second=good(await call('begin_task',{request_id:'legacy_route_task_02',title:'另一个隔离任务'}));
 const secondState=good(await call('task_status',{task_id:second.task_id,include_activity:true}));
 assert.equal(secondState.activity_notes.state,'missing');
 good(await call('finish_task',{task_id:second.task_id,success:true,summary:'隔离任务完成'}));
 assert.equal(fingerprint(file),untouched);
});

test('1049 task_status reports damaged, truncated, oversized and unsafe legacy activity without repair writes',async t=>{
 const {app,call,root}=await fixture(t);
 const id=good(await call('begin_task',{request_id:'legacy_route_task_03',title:'旧活动异常只读'})).task_id;
 const folder=path.join(app.store.stateDir,'activity-records');fs.mkdirSync(folder,{recursive:true});
 const file=path.join(folder,id+'.jsonl');
 const valid={event:'old-valid',kind:'activity',summary:'保留原文',reference:null,at:'2026-10-10T10:00:00.000Z'};
 async function readExpected(expected,code){
  const before=fingerprint(file);
  const r=good(await call('task_status',{task_id:id,include_activity:true}));
  assert.equal(r.activity_notes.state,expected);
  assert.equal(r.activity_notes.code,code);
  assert.equal(r.activity_notes.items.length,0);
  assert.equal(fingerprint(file),before,'status must not rewrite even a broken file');
 }
 fs.writeFileSync(file,JSON.stringify(valid)+'\\n'+'{"event":"unfinished"');
 await readExpected('truncated','ACTIVITY_LOG_TRUNCATED');
 fs.writeFileSync(file,JSON.stringify(valid)+'BROKEN'+JSON.stringify(valid));
 await readExpected('corrupt','ACTIVITY_LOG_CORRUPT');
 fs.writeFileSync(file,'X'.repeat(2*1024*1024+1));
 await readExpected('too_large','ACTIVITY_LOG_TOO_LARGE');
 fs.unlinkSync(file);
 const other=path.join(root,'synthetic-other.txt');fs.writeFileSync(other,'SYNTHETIC-NOT-FOR-READ');
 fs.symlinkSync(other,file);
 const unsafe=good(await call('task_status',{task_id:id,include_activity:true}));
 assert.equal(unsafe.activity_notes.state,'unreadable');
 assert.equal(unsafe.activity_notes.code,'ACTIVITY_LOG_UNSAFE');
 assert.ok(!JSON.stringify(unsafe.activity_notes).includes('SYNTHETIC-NOT-FOR-READ'));
 fs.unlinkSync(file);
 const missing=good(await call('task_status',{task_id:id,include_activity:true}));
 assert.equal(missing.activity_notes.state,'missing');
 good(await call('finish_task',{task_id:id,success:true,summary:'异常路径测试完成'}));
});
