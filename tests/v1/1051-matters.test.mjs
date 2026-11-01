// 1051 one merged isolated regression group. Never reads private runtime or live browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {MatterStore} from '../../app/v1/matters.mjs';
import {MATTER_TOOLS,MATTER_DELTAS,validateMatterEntry} from '../../app/v1/matter-contract.mjs';
import {Tools,TOOLS} from '../../app/tools.mjs';
import {createDesktop,needsInterface} from '../../app/server.mjs';
import {manifest} from '../../app/product.mjs';
import {ToolsRefresher} from '../../app/v1/tools-refresh.mjs';
import {estimateTextTokens as tokens} from '../../app/v1/value-stats.mjs';

let seq=0;
const PROJECT='11111111-1111-4111-8111-111111111111';
const op=()=> 'matter-unit-'+(++seq).toString().padStart(8,'0');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1051-matter-unit-'))),stateDir=path.join(root,'state');
 const store=new MatterStore({stateDir});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,store,stateDir};
}
const raw=text=>({speaker:'Ken',text});
const create=(title='测试事项',text='完整原话',extra={})=>({operation_id:op(),action:'create',title,raw:raw(text),state:'deferred',...extra});
const write=(s,e)=>s.write({request_id:'matter-batch-'+op(),entries:[e]},{project_id:PROJECT,session_hash:'test-session'});
function first(r){assert.equal(r.items.length,1);return r.items[0];}

test('API31 frozen matter definitions do not grow; checkpoint stays unchanged',()=>{
 // Ken 2026-10-27: API31 is frozen. Preserve its definitions, including the
 // approved 1203-token estimate, instead of changing tool text for an old cap.
 const bytes=fs.readFileSync(new URL('../../contracts/tools-v31.json',import.meta.url));
 assert.equal(sha(bytes),'5b0132117d19bdda1ef4c6c6515aa00bdffa4041efc01b3e8ce94a30b27dcfe0');
 const frozen=JSON.parse(bytes),byName=name=>frozen.find(t=>t.name===name);
 assert.deepEqual(MATTER_TOOLS,MATTER_TOOLS.map(t=>byName(t.name)));
 for(const [tool,key,delta] of [['begin_task','matter_ids',MATTER_DELTAS.begin],['finish_task','matter_updates',MATTER_DELTAS.finish]]){
  assert.deepEqual(delta.field,byName(tool).inputSchema.properties[key]);
  assert.ok(byName(tool).description.includes(delta.description),tool+' keeps its frozen matter guidance');
 }
 const each=[...MATTER_TOOLS,MATTER_DELTAS.begin,MATTER_DELTAS.finish].map(v=>tokens(JSON.stringify(v))),limits=[665,248,48,242];
 each.forEach((value,i)=>assert.ok(value<=limits[i],JSON.stringify({each,limits})));
 const defs=manifest(TOOLS);assert.equal(defs.connector_api,31);assert.equal(defs.tool_count,83);
 assert.equal(defs.schema_sha256,manifest(frozen).schema_sha256);
 for(const name of ['matter_write','matter_query'])assert.ok(TOOLS.some(t=>t.name===name));
 assert.ok('matter_ids'in TOOLS.find(t=>t.name==='begin_task').inputSchema.properties);
 assert.ok('matter_updates'in TOOLS.find(t=>t.name==='finish_task').inputSchema.properties);
 assert.equal('matter_updates'in TOOLS.find(t=>t.name==='task_checkpoint').inputSchema.properties,false);
});
test('write survives restart; stable operation idempotence, conflicts, versions and current query revision',async t=>{
 const {store,stateDir}=fixture(t),e=create('同一事项','保留原话'),one=first(await write(store,e));
 assert.equal(one.saved,true);assert.equal(one.revision,1);
 const again=first(await store.write({request_id:'matter-another-batch',entries:[e]}));assert.equal(again.replayed,true);assert.equal(again.id,one.id);
 const bad=first(await write(store,{...e,title:'偷偷覆盖'}));assert.equal(bad.saved,false);assert.equal(bad.error_code,'OP_CONFLICT');
 const old={operation_id:op(),action:'append',id:one.id,base_revision:1,answer:'第一次答复',state:'waiting_user',waiting_for:'用户回答'};
 const second=first(await write(store,old));assert.equal(second.revision,2);assert.equal(second.state,'waiting_user');
 const stale=first(await write(store,{...old,operation_id:op(),answer:'并发变更'}));assert.equal(stale.error_code,'MATTER_REVISION_CONFLICT');
 const q=store.query({ids:[one.id],view:'summary'});assert.equal(q.items[0].revision,2);assert.equal(q.items[0].answer,'第一次答复');
 const reopened=new MatterStore({stateDir});
 assert.equal(reopened.query({ids:[one.id]}).items[0].revision,2);
 assert.equal(first(await reopened.write({request_id:'matter-new-batch',entries:[e]})).replayed,true);
});
test('no secret persisted, no model specified local owner, source/understanding/answer remain separate',async t=>{
 const {store}=fixture(t),e=create('安全记录','密码 token=anExampleSecretOf123456',{source:{kind:'forwarded',label:'另一对话'},understanding:'这是来源意见',answer:'等待复核'});
 const r=first(await write(store,e)),content=fs.readFileSync(store.file(r.id),'utf8');
 assert.doesNotMatch(content,/anExampleSecretOf123456/);assert.match(content,/\[REDACTED\]/);
 const detail=store.query({ids:[r.id],view:'detail'}).items[0];assert.ok(detail.chunk.includes('另一对话'));assert.ok(detail.chunk.includes('这是来源意见'));
 assert.throws(()=>validateMatterEntry({...e,owner:'evil'}),e=>e.code==='MATTER_INVALID');
});
test('soft delete, immediate undo, recent deletion and only explicit purge confirmation',async t=>{
 const {store}=fixture(t),made=first(await write(store,create('删除恢复','请记录')));
 const del=first(await write(store,{operation_id:op(),action:'delete',id:made.id,base_revision:1}));assert.equal(del.saved,true);assert.equal(store.query().items.length,0);
 assert.equal(store.query({ids:[made.id],view:'detail'}).items[0].id,made.id);
 const restore=first(await write(store,{operation_id:op(),action:'restore',id:made.id,base_revision:2}));assert.equal(restore.revision,3);assert.equal(store.query().items.length,1);
 await assert.rejects(store.purge({confirmed:false}),e=>e.code==='MATTER_CONFIRM_REQUIRED');
 const delAgain=first(await write(store,{operation_id:op(),action:'delete',id:made.id,base_revision:3}));assert.equal(delAgain.revision,4);
 assert.deepEqual(await store.purge({confirmed:true}),{purged:1});assert.equal(fs.existsSync(store.file(made.id)),false);
});
test('partial trailing journal preserved as evidence; next append repairs without inventing records',async t=>{
 const {store,stateDir}=fixture(t),firstOne=first(await write(store,create('尾行恢复','本机记录')));
 fs.appendFileSync(store.file(firstOne.id),'{"bad":');
 const loaded=new MatterStore({stateDir});assert.equal(loaded.query().items[0].revision,1);
 assert.ok(loaded.reports.some(x=>x.code==='MATTER_TRAILING_DAMAGE'));
 const saved=first(await write(loaded,{operation_id:op(),action:'append',id:firstOne.id,base_revision:1,answer:'损坏后恢复'}));
 assert.equal(saved.saved,true);assert.equal(saved.revision,2);
 assert.ok(fs.readdirSync(loaded.dir).some(x=>x.startsWith(firstOne.id+'.jsonl.damage-')));
});
test('selection is frozen, versioned and expires; current conversation cannot be guessed',async t=>{
 const {store}=fixture(t),made=first(await write(store,create('选择记录','以后处理')));
 const selection=store.selection([made.id]);assert.deepEqual(store.resolveSelection(selection.selection_id),[made.id]);
 assert.equal(store.query({selection_id:selection.selection_id}).items.length,1);
 assert.equal(store.query({scope:'current_conversation'}).error_code,'MATTER_CONVERSATION_UNVERIFIED');
});
test('refresh list correlation uses service manifest, not old 23/78 lock; host proof remains mandatory',()=>{
 const m=manifest(TOOLS),ref='test-page',url='https://chatgpt.com/settings/plugins-settings/plugin_test',expected={build:1051,instance_id:'inst',connector_api:m.connector_api,tool_count:m.tool_count,schema_sha256:m.schema_sha256,connection_tag:'tag',principal_tag:'principal',route:'relay',plugin_url:url};
 const event={kind:'tools_list',at:500,source:'trusted_server',authenticated:true,caller:'chatgpt',route:'relay',installation:{build:1051,instance_id:'inst'},connection_tag:'tag',principal_tag:'principal',contract:{connector_api:m.connector_api,tool_count:m.tool_count,schema_sha256:m.schema_sha256},host_binding:null};
 const x=new ToolsRefresher({now:()=>600,seen:()=>[event]});const absent=x.listCorrelation(499,ref,expected);assert.equal(absent.match,null);assert.ok(absent.missing.includes('target_chatgpt_page_not_attested'));
 const y=new ToolsRefresher({now:()=>600,seen:()=>[{...event,host_binding:{attested_by:'trusted_host',page_id:ref,plugin_url:url}}]});assert.ok(y.listCorrelation(499,ref,expected).match);
});

async function desktop(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1051-matter-integrated-'))),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'ab'.repeat(32),clientDeps:{
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'synthetic matter Mac',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1050,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});
 const caller='chatgpt',context={setupPrincipal:'test:verified-user',session:'session-a'};
 const invoke=(name,args)=>app.tools.invoke(name,args,caller,context);
 return {app,invoke,context,caller,root};
}
test('real isolated tool routing: matter_write needs no task, begin gives new revision, finish preserves task/matter separation',async t=>{
 const {app,invoke}=await desktop(t);
 const entry=create('联动任务','必须独立记录');const w=await invoke('matter_write',{request_id:'matter-direct-00001',entries:[entry]});
 assert.equal(w.items[0].saved,true);
 const id=w.items[0].id;
 const t1=await invoke('begin_task',{request_id:'matter-begin-00001',title:'事项处理',matter_ids:[id]});
 assert.equal(t1.matters_saved,true);assert.equal(t1.matters[0].revision,2);
 assert.equal(t1.matters[0].state,'waiting_ai');
 const done=await invoke('finish_task',{task_id:t1.task_id,success:true,summary:'登记答复完成',matter_updates:[{operation_id:op(),action:'append',id,base_revision:2,answer:'实际答复记录',state:'deferred',waiting_for:'下次再查'}]});
 assert.equal(done.execution_complete,true);assert.equal(done.task_terminal,true);assert.equal(done.matters_saved,true);assert.equal(done.matters[0].revision,3);assert.equal(done.matters[0].state,'deferred');
 assert.equal(app.matterStore,undefined);
 assert.equal(app.tools.matterStore.query({ids:[id]}).items[0].answer,'实际答复记录');
});
test('finish replay after saved terminal fills failed matter append without task replay and prevents changed intent',async t=>{
 const {app,invoke}=await desktop(t);
 const entry=create('收尾半写','写入失败后恢复'),w=await invoke('matter_write',{request_id:'matter-direct-00002',entries:[entry]}),id=w.items[0].id;
 const task=await invoke('begin_task',{request_id:'matter-begin-00002',title:'收尾测试',matter_ids:[id]});
 const updates=[{operation_id:op(),action:'append',id,base_revision:2,state:'deferred',answer:'收尾后的记录'}];
 const store=app.tools.matterStore,original=store.append.bind(store);
 let once=true;
 store.append=function(...args){if(once&&args[1]?.operation_id===updates[0].operation_id){once=false;throw Object.assign(Error('synthetic disk write failed'),{code:'TEST_DISK_FAILURE'});}return original(...args);};
 const firstDone=await invoke('finish_task',{task_id:task.task_id,success:true,summary:'事项记完',matter_updates:updates});
 assert.equal(firstDone.terminal,true);assert.equal(firstDone.matters_saved,false);assert.equal(firstDone.matters[0].error_code,'TEST_DISK_FAILURE');
 store.append=original;
 const again=await invoke('finish_task',{task_id:task.task_id,success:true,summary:'事项记完',matter_updates:updates});
 assert.equal(again.replayed,true);assert.equal(again.task_terminal,true);assert.equal(again.matters_saved,true);assert.equal(again.matters[0].revision,3);
 await assert.rejects(invoke('finish_task',{task_id:task.task_id,success:true,summary:'事项记完',matter_updates:[{...updates[0],answer:'不同结果'}]}),e=>e.code==='OP_CONFLICT');
});
test('UI-only management cannot be reached without native key; no additional execution authority',async t=>{
 const {app}=await desktop(t),root='http://127.0.0.1:'+app.apiPort,headers={authorization:'Bearer '+app.adminToken,'content-type':'application/json'};
 for(const route of ['/api/matters/write','/api/matters/purge','/api/matters/selection']){
  assert.equal(needsInterface(route,{}),true);const res=await fetch(root+route,{method:'POST',headers,body:'{}'});assert.equal(res.status,403);
 }
 assert.equal(app.tools.matterStore.items.size,0);
});
test('three-tab UI, historical answers and soft deletion entry have no checkpoint matter wiring',()=>{
 const ui=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
 const header=ui.slice(ui.indexOf('function colHead()'),ui.indexOf('function matterRows()'));
 for(const locale of ['zh','en']){
  const text=JSON.parse(fs.readFileSync(new URL("../../locales/"+locale+'.json',import.meta.url),'utf8'));
  const html=vm.runInNewContext(header+';colHead()',{T:k=>text[k],TH:k=>text[k],matterOpenCount:()=>0,tab:'run',tabBadge:()=>''});
  assert.deepEqual([...html.matchAll(/data-tab="([^"]+)"/g)].map(m=>m[1]),['run','done','matters']);
  for(const key of ['ui.window.colHead.text','ui.window.colHead.text2','ui.window.colHead.text3'])assert.ok(text[key]&&html.includes(text[key]),locale+': '+key);
 }
 for(const s of ["case'matterOpen'","case'matterPurge'","case'matterUndoLast'"])assert.ok(ui.includes(s),s);
 assert.ok(!ui.includes("case'task_checkpoint'"));
 assert.ok(ui.includes('if(await ask({title:T("ui.window.action.matterPurge.title.text")'));
 assert.ok(ui.includes("api('/api/matters/purge',{confirmed:true})"));assert.ok(ui.includes('matterSearch'));
});
test('permanently purged CH numbers are never reused, and linked journal writes fail closed',async t=>{
 const {store,stateDir,root}=fixture(t);
 const one=first(await write(store,create('第一条','不要复用编号')));
 await write(store,{operation_id:op(),action:'delete',id:one.id,base_revision:1});
 await store.purge({confirmed:true});
 const reopened=new MatterStore({stateDir}),two=first(await write(reopened,create('第二条','新编号')));
 assert.ok(Number(two.id.slice(3))>Number(one.id.slice(3)),'monotonic id across purge and restart');
 const external=path.join(root,'unsafe-hardlink');fs.linkSync(reopened.file(two.id),external);
 const denied=first(await write(reopened,{operation_id:op(),action:'append',id:two.id,base_revision:1,answer:'不得修改多重链接'}));
 assert.equal(denied.saved,false);assert.equal(denied.error_code,'MATTER_UNSAFE_FILE');
 fs.unlinkSync(external);
});
