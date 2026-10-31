import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ToolsRefresher,PLUGINS_URL} from '../app/v1/tools-refresh.mjs';
import {Updater} from '../app/v1/update.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';
const sha='a'.repeat(64),other='b'.repeat(64);
test('server-bound refresh identity ignores saved names; current proof cannot clear an identity blocker',async()=>{
 let names={__app_identity:{detail_url:PLUGINS_URL+'/main'}},observed=[];
 const entries=[{role:'link',name:'ChatHand',ref:'exact',href:PLUGINS_URL+'/main'},{role:'link',name:'ChatHand Test',ref:'own',href:PLUGINS_URL+'/own'}];
 const r=new ToolsRefresher({targetIdentity:()=>({app_id:'own',detail_url:PLUGINS_URL+'/own'}),onIdentityObserved:async d=>observed.push(d),names:{load:()=>names,save:v=>names=v},invoke:async()=>({elements:entries})});assert.equal((await r.findEntry('t','p')).element.ref,'own');
 names={};assert.equal((await r.findEntry('t','p')).element.ref,'own','names.__app_identity cannot override the server-bound target');
 await r.rememberIdentity(PLUGINS_URL+'/own',{app_id:'own',detail_url:PLUGINS_URL+'/own'},'ChatHand');await r.rememberIdentity(PLUGINS_URL+'/bad?token=fake',{app_id:'own',detail_url:PLUGINS_URL+'/own'});assert.deepEqual(observed,[{app_id:'own',detail_url:PLUGINS_URL+'/own',app_name:'ChatHand'}]);
 r.listStatus=()=>({state:'current',observed:true,persisted:true});for(const state of ['identity_required','ambiguous','not_found']){r.value={state,message:'old failure'};assert.equal(r.snapshot().state,state,'a current global list cannot clear a blocked target identity');}
 r.value={state:'helper_broken',message:'old failure'};assert.equal(r.snapshot().state,'refreshed');assert.doesNotMatch(r.snapshot().message,/old failure/);
});
test('only the bound installed app is refreshed among same-name candidates, with no permission/delete/consent clicks',async()=>{
 let now=100,pageURL=PLUGINS_URL,seen=[],clicks=[];
 const entries=[1,2,3].map(i=>({role:'link',name:'ChatHand Test '+i,ref:'entry'+i,app_id:'id'+i,href:PLUGINS_URL+'/id'+i}));
 const expected={build:1058,instance_id:'test-instance',connector_api:30,tool_count:84,schema_sha256:sha,connection_tag:'connection',principal_tag:'principal',route:'local_http'};
 const r=new ToolsRefresher({distribution:storeTestDistribution(),targetIdentity:()=>({app_id:'id2',detail_url:PLUGINS_URL+'/id2'}),now:()=>now,sleep:async ms=>now+=ms,seen:()=>seen,expected:()=>expected,invoke:async(name,args)=>{
  if(name==='browser_status')return {selected_backend:'extension',extension:{connected:true,compatibility:{state:'compatible'},helper:{state:'current'}}};
  if(name==='begin_task')return {task_id:'t'};
  if(name==='browser_open'){pageURL=args.url;return {page_id:'p',url:pageURL};}
  if(name==='browser_find')return {url:pageURL,lang:'zh',total_elements:pageURL===PLUGINS_URL?entries.length:1,elements:args.role==='button'?(pageURL===PLUGINS_URL?[]:[{role:'button',name:'刷新工具',ref:'refresh'},{role:'button',name:'权限',ref:'permission'},{role:'button',name:'删除',ref:'delete'}]):pageURL===PLUGINS_URL?entries:[{role:'heading',name:'ChatHand',ref:'heading'}]};
  if(name==='browser_action'){clicks.push(args.ref);if(args.ref.startsWith('entry'))pageURL=PLUGINS_URL+'/id'+args.ref.slice(-1);else if(args.ref==='refresh')seen.push({kind:'tools_list',at:now,source:'trusted_server',authenticated:true,caller:'chatgpt',route:'local_http',installation:{build:1058,instance_id:'test-instance'},contract:{connector_api:30,tool_count:84,schema_sha256:sha},connection_tag:'connection',principal_tag:'principal',host_binding:{attested_by:'trusted_host',page_id:'p',plugin_url:pageURL}});else assert.fail('Unexpected click '+args.ref);return {status:'completed',url:pageURL};}
  return {};
 }});
 const result=await r.run();assert.equal(result.state,'refreshed');assert.equal(result.url,PLUGINS_URL+'/id2');assert.equal(result.target_attested,true);assert.deepEqual(clicks,['entry2','refresh']);assert.ok(result.steps.some(step=>step.step==='tools_list'&&step.list_correlation==='host_attested'));assert.equal(clicks.some(ref=>['permission','delete'].includes(ref)),false);
});
function updater(t,{build=1057,version='1.0.0-beta.8',currentProof=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1058-update-'))),stateDir=path.join(root,'state');fs.mkdirSync(stateDir);
 const options={stateDir,upgradeHome:path.join(root,'upgrades'),downloadsDir:path.join(root,'Downloads'),currentAppPath:path.join(root,'ChatHand.app'),build,version,schemaSha:sha,toolListCurrent:()=>currentProof,exec:async()=>({stdout:''}),spawn(){assert.fail('No real installer may start');}};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {u:new Updater(options),options,root,stateDir};
}
test('1058 native install creates the same independent task; only matching verified startup completes it and records actual installed build',async t=>{
 const f=updater(t),u=f.u;u.value.status='available';u.latest={source:'local',build:1058,version:'1.0.0-beta.9',task_id:'source-task'};u._install=async()=>{};
 u.install('local:1058');await u.run?.promise;assert.equal(u.ai.origin,'native_ui');assert.equal(u.ai.schema_from,sha);const id=u.ai.install_task.view.task_id;
 const put=(file,v)=>fs.writeFileSync(path.join(f.stateDir,file),JSON.stringify(v));
 put('update-pending.json',{from:u.current,to:'1.0.0-beta.9',schema_from:sha,build_from:1057,build_to:1058});put('update-result.json',{status:'COMMITTED',from:u.current,to:'1.0.0-beta.9',schema_from:sha,schema_to:sha,time:new Date(Date.now()+1000).toISOString()});
 const next=new Updater({...f.options,build:1058,version:'1.0.0-beta.9'});next._readResult();assert.equal(next.ai.install_task.result.status,'completed');assert.equal(next.ai.install_task.result.task_id,id);assert.deepEqual(next.ai.install_task.result.installed,{version:'1.0.0-beta.9',build:1058});assert.equal(next.value.just_updated.tool_schema_changed,false);
 const original=JSON.stringify(next.ai.install_task.result);next.currentBuild=1059;next._finishInstallTask(true);assert.equal(JSON.stringify(next.ai.install_task.result),original,'terminal receipt is never rewritten');
});
test('1058 schema comparison is source-independent, unknown is explicit and old targets no longer claim to be pending',t=>{
 const {u}=updater(t,{build:1058,version:'1.0.0-beta.9'});assert.equal(u._schemaChanged(sha),false);assert.equal(u._schemaChanged(other),true);assert.equal(u._schemaChanged(null),null);u.toolListCurrent=()=>true;assert.equal(u._schemaChanged(null),false);
 u.toolListCurrent=()=>false;u.toolListStatus=()=>({state:'stale',observed:true,persisted:true,schema_sha256:other});assert.equal(u._schemaChanged(null),true);
 u.toolListStatus=()=>({state:'current',observed:true,persisted:true,schema_sha256:sha});assert.equal(u._schemaChanged(null),false);u.toolListStatus=()=>({state:'unknown',observed:false});assert.equal(u._schemaChanged(null),null);
 u.value.just_updated={from:'1.0.0-beta.8',to:'1.0.0-beta.9',tool_schema_changed:u._schemaChanged(null)};assert.equal(u.aiStatus().tools_changed,null);assert.equal(u.snapshot().refresh_tools,false);
 u.ai={to:{version:'1.0.0-beta.5',build:1054},from:{build:1053}};assert.deepEqual(u.aiStatus().target,{version:'1.0.0-beta.9',build:1058});
});
test('1058 startup accepts the legacy 1057 UI install with a terminal old AI marker and never rewrites its receipt',t=>{
 const f=updater(t,{build:1058,version:'1.0.0-beta.9'}),u=f.u;
 const old={task_id:'old-install-task',status:'failed',terminal:true,summary:'original failure'};
 u.ai={at:1,from:{version:'1.0.0-beta.4',build:1053},to:{version:'1.0.0-beta.5',build:1054},install_task:{caller:'chatgpt',view:{task_id:old.task_id},result:old}};
 fs.writeFileSync(u.aiFile,JSON.stringify(u.ai));const bytes=fs.readFileSync(u.aiFile,'utf8');
 fs.writeFileSync(u.pendingFile,JSON.stringify({from:'1.0.0-beta.8',to:'1.0.0-beta.9',schema_from:other,build_from:1057,build_to:1058}));
 fs.writeFileSync(u.resultFile,JSON.stringify({status:'COMMITTED',from:'1.0.0-beta.8',to:'1.0.0-beta.9',schema_from:other,schema_to:sha,time:new Date().toISOString()}));
 assert.equal(u._readResult(),false);assert.equal(u.value.install.state,'idle');assert.equal(u.value.just_updated.build_to,1058);assert.equal(u.value.just_updated.tool_schema_changed,true);assert.deepEqual(u.ai.install_task.result,old);assert.equal(fs.readFileSync(u.aiFile,'utf8'),bytes);
});
test('1058 automatic failure and native cancellation close only their own newly created installation task',async t=>{
 const {u}=updater(t);u.automaticAllowed=true;u.value.status='available';u.latest={source:'remote',version:'9.0.0',build:9999,dmg:{size:1}};
 u._install=async()=>{throw Object.assign(Error('synthetic'),{updateMessage:'合成自动失败'});};u.install('9.0.0',{automatic:true});await u.run.promise;
 assert.equal(u.ai.origin,'automatic');assert.equal(u.ai.install_task.result.status,'failed');assert.equal(u.ai.install_task.result.failure_reason,'合成自动失败');const priorId=u.ai.install_task.view.task_id;
 u.value.status='available';u.value.install={state:'idle'};u._install=async run=>{u._set(run,'waiting_tasks');await u._pause(run,100000);};u.install('9.0.0');const op=u.run;await new Promise(r=>setImmediate(r));u.cancel();await op.promise;
 assert.notEqual(u.ai.install_task.view.task_id,priorId);assert.equal(u.ai.origin,'native_ui');assert.equal(u.ai.install_task.result.status,'failed');assert.equal(u.ai.install_task.result.failure_reason,'安装已取消');
});
