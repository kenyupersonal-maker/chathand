import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';
import {authFailure,TunnelManager} from '../../engine/src/tunnel.mjs';
import {connectionDisplay} from '../../app/v1/connection-display.mjs';
const local={process_running:true,healthy:true,ready:true};
test('1058 healthy local transport is connected without missing cloud observations becoming failures',()=>{
 for(const cp of [null,{state:'unknown'},{state:'checking',status:'connecting',down_since:1000}])assert.equal(connectionDisplay({...local,control_plane:cp},{now:16000}).connected,true);
 const warning=connectionDisplay({...local,control_plane:{state:'checking',status:'degraded',reason_code:'HTTP_503',down_since:1000}},{now:16000});assert.equal(warning.tone,'green');assert.equal(warning.settings_warning.tone,'yellow');assert.equal(warning.last_confirmed_at,null);
 assert.equal(connectionDisplay({...local,control_plane:{state:'checking',status:'connecting',down_since:1000}},{now:121000}).tone,'red');
 assert.equal(connectionDisplay({...local,control_plane:{state:'down'}}).connected,false);
 assert.equal(connectionDisplay({...local,healthy:false,automatic:{phase:'needs_login'}}).connected,false);
});
test('1058 doctor authentication requires actual status/authentication evidence, not a bare timing or identifier',()=>{
 for(const line of ['request 401 completed in 403 ms','{"duration_ms":401,"port":403}','control_plane request_id=403 ready'])assert.equal(authFailure(line),false,line);
 for(const line of ['HTTP 401','HTTP_403','{"fields":{"http_status":401}}','{"fields":{"status_code":"403"}}','unauthorized','invalid_api_key'])assert.equal(authFailure(line),true,line);
});
test('1058 authenticated successful call updates cloud last_success even without health details',()=>{
 const m=new TunnelManager('/tmp/1058-synthetic','http://127.0.0.1:1/mcp','synthetic',{clock:()=>500});m.child={};m.cp={lastOkAt:0,notOkSince:1,failures:3};
 assert.equal(m.authenticatedCallSucceeded(),true);assert.equal(m.observeControlPlane(null,600).last_success_at,500);assert.equal(m.cp.failures,0);
 m.child=null;assert.equal(m.authenticatedCallSucceeded(700),false);assert.equal(m.cp.lastOkAt,500);
});
test('1058 matter association follows authenticated project/root scope while conversation queries and begin reuse stay bounded',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1058-owner-'))),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'ab'.repeat(32),clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'synthetic',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1058,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});
 const context={setupPrincipal:'test:verified-user',session:'session-a',connectionPrincipal:'tunnel:principal-a'},call=(name,args,ctx=context)=>app.tools.invoke(name,args,'chatgpt',ctx);
 const task=await call('begin_task',{request_id:'1058-owner-begin',title:'关联事项'});assert.equal(task.status,'active');
 const entry={operation_id:'1058-matter-create',action:'create',title:'测试事项',raw:{speaker:'Ken',text:'隔离测试'},state:'deferred',task_id:task.task_id};
 const good=await call('matter_write',{request_id:'1058-write-good',entries:[entry]});assert.equal(good.items[0].saved,true);
 let continuation=0;
 for(const ctx of [{...context,session:'session-b'},{...context,connectionPrincipal:'tunnel:principal-b'}]){
  const next=++continuation,r=await call('matter_write',{request_id:'1058-write-continued-'+next,entries:[{...entry,operation_id:'1058-owner-continued-'+next,title:'测试事项 '+next}]},ctx);
  assert.equal(r.items[0].saved,true);assert.equal(r.items[0].replayed,false);
 }
 const current=await call('matter_query',{scope:'current_conversation'}),other=await call('matter_query',{scope:'current_conversation'},{...context,session:'session-b'});
 assert.equal(current.items.length,2);assert.equal(other.items.length,1);assert.ok(!current.items.some(a=>other.items.some(b=>a.id===b.id)));
 const origin=app.policy.tasks.get(task.task_id);assert.equal(origin.connection_principal,context.connectionPrincipal);
 const before=JSON.stringify([...app.tools.matterStore.items]);
 for(const mismatch of ['project','root']){
  const project=app.state.data.active,root=app.store.root;
  if(mismatch==='project')app.state.data.active='another-project';else app.store.root=path.join(root,'foreign');
  try{await assert.rejects(()=>call('matter_write',{request_id:'1058-write-scope-'+mismatch,entries:[{...entry,operation_id:'1058-owner-scope-'+mismatch}]}),{code:'ROOT_CHANGED'});}
  finally{app.state.data.active=project;app.store.root=root;}
  assert.equal(JSON.stringify([...app.tools.matterStore.items]),before);
 }
 const reused=await call('begin_task',{request_id:'1058-owner-reuse',title:'继续同事'});assert.equal(reused.task_id,task.task_id);assert.equal(reused.reused_open_task,true);
 const tasksBeforeRebind=app.policy.tasks.size;
 const rebound=await call('begin_task',{request_id:'1058-owner-cross-binding',title:'继续同事'}, {...context,connectionPrincipal:'tunnel:principal-b'});
 assert.equal(rebound.task_id,task.task_id);assert.equal(rebound.reused_open_task,true);assert.equal(app.policy.tasks.size,tasksBeforeRebind);
 assert.equal(origin.connection_principal,context.connectionPrincipal,'continuation never overwrites original provenance');
 await assert.rejects(()=>call('begin_task',{request_id:'1058-owner-cross-binding',title:'different request contents'}),{code:'OP_CONFLICT'});
 await call('finish_task',{task_id:task.task_id,success:true,summary:'隔离测试结束'});
 const replay=await call('begin_task',{request_id:'1058-owner-reuse',title:'继续同事'});assert.equal(replay.task_id,task.task_id);assert.equal(replay.replayed,true);assert.equal(replay.status,'completed');
});
