// 1052 D1 / R04+R05（Claude 写，Codex 审和测）：一次调用的身份只从服务端上下文来；
// 没选中的路线只拿到提示、不碰任何东西；Site 的普通调用和 A 一样先过任务归属，
// 读不到、停不了别的连接的任务。只用系统临时目录和合成密钥，不碰真实 stateDir、钥匙串、Site。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
import {BSiteDispatch} from '../../app/v1/b-site-dispatch.mjs';
import {canonicalArguments,sha256,encodeUrl64,edSign,rawPublicFromKey} from '../../app/v1/b-site-wire.mjs';
import {callContext,principalTag} from '../../app/v1/call-context.mjs';
import {sessionHashOf} from '../../app/v1/resume.mjs';

const INS='11111111-1111-4111-8111-111111111111',SITE='site_fixture_1052',OWNER='owner_fixture_1052',
 BIND='33333333-3333-4333-8333-333333333333';
const SECRET_TITLE='A 通道里的私人任务标题';
const siteKey=crypto.generateKeyPairSync('ed25519'),sitePub=rawPublicFromKey(siteKey.publicKey);

async function desktop(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1052-d1-'))),stateDir=path.join(root,'state'),work=path.join(root,'work');
 fs.mkdirSync(stateDir,{mode:0o700});fs.mkdirSync(work);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey:'cd'.repeat(32),clientDeps:{
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic D1',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1050,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>app.close());
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 // Only the selection matters for the route gate; the real store stays untouched.
 const real=app.tools.bSiteLocalStore,route={selected:'openai'};
 app.tools.bSiteLocalStore={selection:()=>({installation:INS,selected:route.selected,revision:1})};
 t.after(()=>{app.tools.bSiteLocalStore=real;});
 return {app,route,work};
}
let n=0;
const call=(name,args={},session='session-a-1052')=>({jsonrpc:'2.0',id:'d1-'+(++n),method:'tools/call',
 params:{name,arguments:args,...(session?{_meta:{'openai/session':session}}:{})}});
const A_LOCAL={transport:'local_http',setupPrincipal:'tunnel:chatgpt'};
const sc=r=>r?.result?.structuredContent;
async function beginA(app){
 const r=await app.tools.rpc(call('begin_task',{request_id:'d1-req-'+crypto.randomUUID().slice(0,8),title:SECRET_TITLE}),'chatgpt',A_LOCAL);
 assert.equal(r.result.isError,false,JSON.stringify(sc(r)));return sc(r).task_id;
}
function siteDispatch(app){
 let stored=null;
 const local={admit:()=>({replayed:false}),start:()=>({execute:true}),
  complete:(op,work,value,opts)=>{stored={value,opts};return {state:opts.failed?'failed':'completed',result_digest:'a'.repeat(64)};},
  status:()=>({state:'completed',result_digest:'a'.repeat(64),result:stored?.value})};
 const creds={get:k=>k==='site_b'?{installation_id:INS,site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1,site_public_key:encodeUrl64(sitePub)}:null};
 const dispatch=new BSiteDispatch({local,credentials:creds,tools:app.tools,installationId:INS});
 const deliver=dispatch.bindTransportAuthority({});
 const channel={trusted_server:true,authenticated_device:true,site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1};
 return async(tool,tool_arguments,{session_tag='c'.repeat(64)}={})=>{
  const envelope={kind:'b_site_call_context_v2',version:2,request_id:'site-req-'+crypto.randomUUID().slice(0,12),session_tag,tool_arguments};
  const encoded=canonicalArguments(envelope).toString('utf8'),digest=sha256(Buffer.from(encoded));
  const op_id=crypto.randomUUID(),attempt_id=crypto.randomUUID(),time=Date.now();
  const fields=['chathand-site-job-v1','1',SITE,BIND,'1',INS,OWNER,op_id,tool,digest,String(time-2000),String(time+30000),attempt_id];
  const item={version:'1',site_id:SITE,binding_id:BIND,credential_generation:1,installation_id:INS,owner_subject:OWNER,op_id,tool_name:tool,
   arguments:encoded,request_digest:digest,created_at:time-2000,start_before:time+30000,attempt_id,
   site_signature:edSign(siteKey.privateKey,Buffer.from(JSON.stringify(fields)))};
  const out=await deliver(item,channel);
  return {out,value:stored.value,failed:stored.opts.failed};
 };
}

test('身份只认服务端上下文：请求体、_meta、参数里写的来源和主体都不算',()=>{
 const spoof={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_info',arguments:{transport:'site_b',connectionPrincipal:'x'},
  _meta:{'openai/session':'s',transport:'local_http','chathand/transportSource':'site_b','chathand/principal':'tunnel:chatgpt'}}};
 const none=callContext({},spoof);
 assert.equal(none.transportSource,'direct_rpc');assert.equal(none.connectionPrincipal,null);assert.equal(none.sessionBinding,null);
 assert.equal(callContext({transport:'2026-07-28'},spoof).transportSource,'direct_rpc','协议版本不是来源');
 const relay=callContext({transport:'relay',setupPrincipal:'["https://r","relay:u"]'},spoof);
 assert.equal(relay.transportSource,'relay');assert.equal(relay.connectionPrincipal,principalTag('["https://r","relay:u"]'));
 assert.equal(relay.sessionBinding,sessionHashOf('["https://r","relay:u"]','s'));assert.equal(relay.mcpProtocolVersion,'legacy');
 const site=callContext({transport:'site_b',setupPrincipal:'site-b:authenticated:o:b:1',connectionPrincipal:'site-b:b:1'},spoof,{invocationClass:'bogus'});
 assert.equal(site.connectionPrincipal,principalTag('site-b:b:1'));assert.equal(site.invocationClass,'ordinary');assert.equal(site.legacyTransport,'site_b');
 assert.notEqual(principalTag('site-b:b:1'),principalTag('site-b:b:2'));
 assert.equal(Object.isFrozen(site),true);
});

test('选的是 Site 时，A 的真实 rpc（隧道和中转）只拿到提示：不执行、不碰接力和续接',async t=>{
 const {app,route}=await desktop(t);route.selected='site';
 let before=0,relayStart=0;const realBefore=app.tools.resume?.before;
 if(app.tools.resume)app.tools.resume.before=(...a)=>{before++;return realBefore.apply(app.tools.resume,a);};
 if(app.tools.relayKeeper){const real=app.tools.relayKeeper.noteToolStart.bind(app.tools.relayKeeper);app.tools.relayKeeper.noteToolStart=(...a)=>{relayStart++;return real(...a);};}
 for(const ctx of [A_LOCAL,{transport:'relay',setupPrincipal:JSON.stringify(['https://relay.example','relay:chatgpt'])}]){
  for(const body of [call('bridge_info'),call('list_directory',{path:'.'}),{...call('bridge_info'),params:{...call('bridge_info').params,_meta:{'openai/session':'s','io.modelcontextprotocol/protocolVersion':'2026-07-28'}}}]){
   const r=await app.tools.rpc(body,'chatgpt',ctx);
   assert.equal(sc(r).error_code,'ROUTE_NOT_SELECTED',ctx.transport+' '+body.params.name);
   assert.equal(sc(r).executed,false);assert.equal(sc(r).selected,'site');
  }
 }
 assert.equal(before,0,'续接观察没被碰');assert.equal(relayStart,0,'接力没登记');
 // 进程内直接调用（测试、内部刷新）不算 A 入口，照常执行。
 const direct=await app.tools.rpc(call('bridge_info'),'chatgpt',{setupPrincipal:'tunnel:chatgpt'});
 assert.notEqual(sc(direct).error_code,'ROUTE_NOT_SELECTED');
});

test('选的是 OpenAI 时，Site 的普通调用只拿到提示，不执行',async t=>{
 const {app}=await desktop(t),site=siteDispatch(app);
 const r=await site('bridge_info',{});
 assert.equal(r.value.error_code,'ROUTE_NOT_SELECTED');assert.equal(r.value.selected,'openai');assert.equal(r.value.executed,false);
});

test('Site 的已认证普通调用可在同一项目和工作区继续 A 的任务',async t=>{
 const {app,route}=await desktop(t),site=siteDispatch(app);let taskId;
 for(const [tool,args] of [['task_status',{task_id:'pending-task-id'}],['show_task',{task_id:'pending-task-id'}],['task_stop',{task_id:'pending-task-id'}],['task_checkpoint',{task_id:'pending-task-id',done:'x',next:'接着做：继续'}]]){
  route.selected='openai';taskId=await beginA(app);assert.equal(typeof taskId,'string');route.selected='site';
  const r=await site(tool,{...args,task_id:taskId});
  if(tool==='show_task'){
   assert.equal(r.failed,true,tool);assert.equal(r.value.error.code,'CONFIRM_NONCE_INVALID','session-bound observation capability stays private');
   continue;
  }
  assert.equal(r.failed,false,tool+' '+JSON.stringify(r.value));
  if(tool==='task_status')assert.equal(JSON.stringify(r.value).includes(SECRET_TITLE),true,tool+' 返回同一任务内容');
  if(tool==='task_stop')assert.ok(['cancelled','revoked'].includes(r.value.status),JSON.stringify(r.value));
  if(tool==='task_checkpoint')assert.equal(r.value.task_id,taskId);
 }
 // Missing session metadata alone does not revoke this authenticated connector context.
 route.selected='openai';taskId=await beginA(app);route.selected='site';
 const bare=await site('task_status',{task_id:taskId},{session_tag:null});
 assert.equal(bare.failed,false,JSON.stringify(bare.value));assert.equal(bare.value.title,SECRET_TITLE);
 const taskBefore=JSON.stringify(app.tools.policy.view(app.tools.policy.tasks.get(taskId)));
 for(const mismatch of ['project','root']){
  const project=app.state.data.active,root=app.store.root;
  if(mismatch==='project')app.state.data.active='foreign-project';else app.store.root=path.join(root,'foreign');
  try{for(const tool of ['task_status','task_stop','task_checkpoint']){
   const denied=await site(tool,{task_id:taskId,...(tool==='task_checkpoint'?{done:'must not apply',next:'接着做：拒绝'}:{})});
   assert.equal(denied.failed,true);assert.equal(denied.value.error.code,'ROOT_CHANGED',tool+' '+mismatch);
   assert.equal(JSON.stringify(denied.value).includes(SECRET_TITLE),false);
  }}finally{app.state.data.active=project;app.store.root=root;}
  assert.equal(JSON.stringify(app.tools.policy.view(app.tools.policy.tasks.get(taskId))),taskBefore);
 }
 const epoch=app.tools.policy.epoch;app.tools.policy.epoch++;
 try{const denied=await site('task_checkpoint',{task_id:taskId,done:'stale epoch'});assert.equal(denied.failed,true);assert.equal(denied.value.error.code,'ROOT_CHANGED');}
 finally{app.tools.policy.epoch=epoch;}

 route.selected='openai';
 const own=await app.tools.rpc(call('task_status',{task_id:taskId}),'chatgpt',A_LOCAL);
 assert.equal(sc(own).status!=='revoked'&&sc(own).status!=='cancelled',true,'A 自己的任务没被停掉');assert.equal(sc(own).title,SECRET_TITLE);
});

test('Site 自己开的任务可由同项目工作区内的其他 Site 绑定继续',async t=>{
 const {app,route}=await desktop(t),site=siteDispatch(app);route.selected='site';
 const begun=await site('begin_task',{request_id:'site-own-0001',title:'Site 自己的任务'});
 assert.equal(begun.failed,false,JSON.stringify(begun.value));
 const id=begun.value.task_id,task=app.tools.policy.tasks.get(id);
 assert.equal(task.connection_principal,principalTag('site-b:'+BIND+':1'));
 const mine=await site('task_status',{task_id:id});assert.equal(mine.failed,false);assert.equal(mine.value.title,'Site 自己的任务');
 assert.equal(app.tools.policy.getBound(id,'chatgpt',task.session_hash,principalTag('site-b:'+BIND+':2')).id,id);
 assert.equal(app.tools.policy.getBound(id,'chatgpt',task.session_hash,null).id,id);
 assert.equal(app.tools.policy.getBound(id,'chatgpt',task.session_hash,task.connection_principal).id,id);
});

test('归档任务回执在同项目工作区内可跨绑定读取且相同 request_id 仍保持幂等',async t=>{
 const {app,route}=await desktop(t),site=siteDispatch(app);route.selected='site';
 const begun=await site('begin_task',{request_id:'site-archived-0001',title:'归档 Site 任务'});
 assert.equal(begun.failed,false,JSON.stringify(begun.value));
 const id=begun.value.task_id,task=app.tools.policy.tasks.get(id),principal=task.connection_principal;
 const replay=app.tools.policy.begin({request_id:'site-archived-0001',title:'归档 Site 任务'},'chatgpt',{
  session_hash:task.session_hash,connection_principal:principalTag('site-b:'+BIND+':2')
 });
 assert.equal(replay.task_id,id);assert.equal(replay.replayed,true,'跨绑定重试复用原任务，不创建新任务');
 app.tools.policy.revokeTask(task,'cancelled');
 app.tools.policy.tasks.delete(id);
 assert.equal(app.tools.policy.getBound(id,'chatgpt',task.session_hash,principal).archived,true);
 assert.equal(app.tools.policy.getBound(id,'chatgpt',task.session_hash,principalTag('site-b:'+BIND+':2')).archived,true);
 assert.equal(app.tools.policy.getBound(id,'chatgpt','0'.repeat(64),principal).archived,true);
 const completed=await site('begin_task',{request_id:'site-archived-0002',title:'完成 Site 任务'});
 assert.equal(completed.failed,false,JSON.stringify(completed.value));
 const doneId=completed.value.task_id,done=app.tools.policy.tasks.get(doneId);
 done.status='active';done.expires_at=null;
 app.tools.policy.finish(doneId,'chatgpt',true,'已完成');
 app.tools.policy.tasks.delete(doneId);
 assert.equal(app.tools.policy.getBound(doneId,'chatgpt',done.session_hash,principal).archived,true);
 assert.equal(app.tools.policy.getBound(doneId,'chatgpt',done.session_hash,principalTag('site-b:'+BIND+':2')).archived,true);
 // Older receipts may omit the principal tag; project/root remain mandatory.
 const oldId=crypto.randomUUID(),oldSession=sessionHashOf('tunnel:chatgpt','archived-old-session');
 app.tools.policy.receipts.saveRevocation(oldId,'chatgpt',{
  task_id:oldId,status:'cancelled',session_hash:oldSession,project_id:app.state.data.active,root:app.store.root,
  title:'旧回执',jobs:[],finished_at:Date.now(),execution_complete:false,terminal:true
 });
 assert.equal(app.tools.policy.getBound(oldId,'chatgpt',oldSession,principal).archived,true);
 assert.equal(app.tools.policy.getBound(oldId,'chatgpt',task.session_hash,principal).archived,true);
 assert.equal(app.tools.policy.getBound(oldId,'chatgpt',null,principal).archived,true);
 const priorRoot=app.store.root;app.store.root=path.join(priorRoot,'foreign');
 try{for(const archivedId of [id,doneId,oldId])assert.throws(()=>app.tools.policy.getBound(archivedId,'chatgpt',null,principal),{code:'ROOT_CHANGED'});}finally{app.store.root=priorRoot;}
 const badFile=path.join(app.tools.policy.receipts.dir,oldId+'.json'),bad=JSON.parse(fs.readFileSync(badFile,'utf8'));
 bad.connection_principal=17;fs.writeFileSync(badFile,JSON.stringify(bad));
 assert.throws(()=>app.tools.policy.getBound(oldId,'chatgpt',oldSession,principal),e=>e.code==='TASK_RECEIPT_INVALID','显式损坏的 tag 不能降格成旧回执');
});

test('Site 的普通调用走共用入口：先过续接观察，任务归属在业务读取之前',async t=>{
 const {app,route}=await desktop(t),site=siteDispatch(app);route.selected='site';
 let before=0;const realBefore=app.tools.resume.before;
 app.tools.resume.before=(...a)=>{before++;return realBefore.apply(app.tools.resume,a);};
 const r=await site('bridge_info',{});
 assert.equal(r.failed,false,JSON.stringify(r.value));assert.equal(before,1);
 const missing=await site('task_status',{task_id:crypto.randomUUID()});
 assert.equal(missing.failed,true);assert.equal(missing.value.error.code,'TASK_MISSING');assert.equal(before,1,'归属没过就不碰续接观察');
});
