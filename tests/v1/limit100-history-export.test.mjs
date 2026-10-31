// 1052 candidate pre-integration: synthetic records only. No real ChatGPT/private history.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
import {sessionHashOf} from '../../app/v1/resume.mjs';
import {taskHistory,ownedTaskHistory} from '../../app/v06/changes.mjs';
import {memoryActivity} from '../../app/v1/events.mjs';
import {TOOLS} from '../../app/tools.mjs';
import {manifest} from '../../app/product.mjs';

const seq=()=>crypto.randomUUID();
const caller='chatgpt',context={setupPrincipal:'synthetic:verified',session:'owned-session'},hash=sessionHashOf(context.setupPrincipal,context.session);
const otherContext={...context,session:'foreign-session'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function idFor(i){return 'a0000000-0000-4000-8000-'+String(i).padStart(12,'0');}
function receipt(app,i,{by=caller,session=hash,project=app.state.data.active,root=app.store.root}={}){
 const id=idFor(i),result={task_id:id,project_id:project,root,session_hash:session,created_at:100000+i,finished_at:200000+i,
  status:'completed',terminal:true,execution_complete:true,summary:'Bearer synthetic-hidden-password',
  jobs:[],value:{work:3,io_in:1,io_out:2,calls:1,estimators:{note:'synthetic-only'}}};
 app.policy.receipts.save(id,by,true,result);return id;
}
async function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'limit100-synthetic-'))),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'f1'.repeat(32),clientDeps:{
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic history Mac',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1050,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});
 const invoke=(name,args={},ctx=context,who=caller)=>app.tools.invoke(name,args,who,ctx);
 return {app,root,work,invoke};
}
test('task_history pages >3k same-project/root receipts without duplicates and rejects stale pages', {timeout:120000},async t=>{
  const f=await fixture(t),{app,invoke}=f,visible=new Set();
  for(let i=1;i<=3105;i++)visible.add(receipt(app,i));
 for(let i=3106;i<=3135;i++)receipt(app,i,{by:'another-caller'});
 for(let i=3136;i<=3165;i++)receipt(app,i,{session:sessionHashOf(context.setupPrincipal,'unrelated-session')});
 for(let i=3166;i<=3190;i++)receipt(app,i,{project:'different-project'});
 for(let i=3191;i<=3195;i++)receipt(app,i,{session:null});
  for(let i=3106;i<=3135;i++)visible.add(idFor(i));
  for(let i=3136;i<=3165;i++)visible.add(idFor(i));
  for(let i=3191;i<=3195;i++)visible.add(idFor(i));
 receipt(app,3198,{root:path.join(f.root,'other-root')});receipt(app,3199,{root:null});
  assert.equal(ownedTaskHistory(app.policy,caller,hash).items.length,3170);
 const seen=[],first=await invoke('task_history',{limit:100});
  assert.equal(first.total,3170);assert.equal(first.total_exact,true);assert.equal(first.tasks.length,100);
 assert.equal(first.truncated,true);assert.equal(first.offset,0);assert.ok(first.next_cursor);
 let page=first;
 for(let n=0;n<100;n++){
  seen.push(...page.tasks.map(x=>x.task_id));
  if(page.next_offset===null)break;
  page=await invoke('task_history',{limit:100,offset:page.next_offset,cursor:page.next_cursor});
 }
  assert.equal(seen.length,3170);assert.equal(new Set(seen).size,3170);
  assert.ok(seen.every(x=>visible.has(x)),'project/root boundaries exclude foreign projects; sessions and connectors can continue tasks');
 assert.equal(page.next_cursor,null);assert.equal(page.truncated,false);
 await assert.rejects(invoke('task_history',{limit:100,offset:100}),e=>e.code==='HISTORY_CURSOR_REQUIRED');
  const anotherSession=await invoke('task_history',{limit:100},otherContext);
  assert.equal(anotherSession.total,3170);
  const anotherCaller=await invoke('task_history',{limit:100},context,'other-model-caller');
  assert.equal(anotherCaller.total,3170);
 await assert.rejects(invoke('task_history',{limit:1},{setupPrincipal:context.setupPrincipal}),e=>e.code==='HISTORY_SESSION_REQUIRED');
 await assert.rejects(invoke('task_history',{limit:1,owner:caller}),e=>e.code==='ARG_INVALID');
 const previous=await invoke('task_history',{limit:20});
 receipt(app,3196);visible.add(idFor(3196));
 await assert.rejects(invoke('task_history',{limit:20,offset:previous.next_offset,cursor:previous.next_cursor}),e=>e.code==='HISTORY_CHANGED');
 const corrupt=idFor(3197);
 fs.writeFileSync(path.join(app.policy.receipts.dir,corrupt+'.json'),'{invalid-json');
 const partial=await invoke('task_history',{limit:10});
 assert.equal(partial.total,null);assert.equal(partial.total_exact,false);assert.equal(partial.incomplete,true);assert.equal(partial.at_least,3171);
 const groups=memoryActivity([...visible].slice(0,160).map((id,i)=>({task_id:id,session_hash:hash,created_at:i,finished_at:i+1,title:'fixture-'+i})),{activity_links:{},session_groups:{},conversations:[]},3);
 assert.equal(groups.preview_only,true);assert.ok(Number.isInteger(groups.total));assert.ok('truncated' in groups);
 // A metadata-only generated export is bounded as a tool receipt and cannot carry a raw task summary.
  const e=await invoke('records_export',{kind:'tasks'});
  assert.equal(e.exported,true);assert.equal(e.task_count,3171);assert.equal(e.incomplete,true);
 assert.ok(JSON.stringify(e).length<4000);assert.equal(e.path.startsWith('chathand-exports/'),true);
 const file=path.join(f.work,e.path),body=fs.readFileSync(file,'utf8');
 assert.ok(!body.includes('synthetic-hidden-password'));assert.ok(!body.includes('another-caller'));
 const rows=body.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(x=>x.type==='task').length,3171);
  assert.equal(new Set(rows.filter(x=>x.type==='task').map(x=>x.task_id)).size,3171);
  assert.ok(rows.every(x=>x.type!=='task'||visible.has(x.task_id)));
});
test('export stays in current allowed workspace and includes only owned activity event metadata / workload', {timeout:20000},async t=>{
 const f=await fixture(t),{app,invoke}=f;
 const id=receipt(app,1),foreign=receipt(app,2,{session:sessionHashOf(context.setupPrincipal,'other')});
 const notes=path.join(app.store.stateDir,'activity-records');fs.mkdirSync(notes,{recursive:true});
 for(const x of [id,foreign])fs.writeFileSync(path.join(notes,x+'.jsonl'),JSON.stringify({event:'note_added',summary:'Bearer synthetic-secret-not-exportable',reference:'password=another-secret',at:'2026-10-12T01:00:00Z'})+'\n');
 const r=await invoke('records_export',{kind:'all'});
  assert.equal(r.task_count,2);assert.equal(r.truncated,false);assert.equal(r.incomplete,false);assert.equal(r.can_resume_execution,false);
 const file=path.join(f.work,r.path),body=fs.readFileSync(file,'utf8'),lines=body.trim().split('\n').map(JSON.parse);
  assert.ok(lines.some(x=>x.type==='task'&&x.task_id===id));assert.ok(lines.some(x=>x.type==='task'&&x.task_id===foreign));
 assert.ok(lines.some(x=>x.type==='workload'&&x.task_id===id&&x.work===3));
 assert.ok(lines.some(x=>x.type==='activity'&&x.task_id===id&&x.event==='note_added'));
  assert.ok(body.includes(foreign),'same-project/root receipt metadata remains available across session contexts');assert.ok(!body.includes('synthetic-secret-not-exportable'));assert.ok(!body.includes('another-secret'));
 assert.ok(!body.includes('estimators'));assert.equal(app.state.data.terminal_enabled??false,false,'export did not switch on command execution');
 assert.ok(JSON.stringify(r).length<4000);
});
test('unknown ownership, model-supplied ID/path and cross-project do not leak records or change file grants',async t=>{
 const {app,invoke,work}=await fixture(t);
 const id=receipt(app,1);
 await assert.rejects(invoke('records_export',{kind:'tasks'},{setupPrincipal:context.setupPrincipal}),e=>e.code==='EXPORT_SESSION_REQUIRED');
 assert.equal(fs.existsSync(path.join(work,'chathand-exports')),false,'unverified requester created no files');
 for(const payload of [{task_id:id},{kind:'all',output_path:'../../private/state.json'},{kind:'all',caller},{kind:'all',session_hash:hash},{kind:'all',owner:'another'}])
  await assert.rejects(invoke('records_export',payload),e=>e.code==='ARG_INVALID');
  const other=await invoke('records_export',{kind:'tasks'},otherContext);assert.equal(other.task_count,1);
  const otherCaller=await invoke('records_export',{kind:'tasks'},context,'other-caller');assert.equal(otherCaller.task_count,1);
 const before=app.state.data.active;app.state.data.active='synthetic-other-project';
 try{const project=await invoke('records_export',{kind:'tasks'});assert.equal(project.task_count,0);}finally{app.state.data.active=before;}
});
test('protected state paths and symlinked export directory fail closed, without writing outside workspace',async t=>{
 const {app,invoke,work}=await fixture(t),dest=path.join(work,'chathand-exports');
 // Source cannot choose a destination: the only path is server-controlled.
 fs.symlinkSync(app.store.stateDir,dest);
 await assert.rejects(invoke('records_export',{kind:'all'}),e=>['LINK_BLOCKED','BRIDGE_STATE_PROTECTED'].includes(e.code));
 assert.equal(fs.readdirSync(app.store.stateDir).some(x=>x.startsWith('history-')),false);
 fs.unlinkSync(dest);const internal=path.join(work,'allowed-target');fs.mkdirSync(internal);
 fs.symlinkSync(internal,dest);
 await assert.rejects(invoke('records_export',{kind:'tasks'}),e=>e.code==='LINK_BLOCKED');
 assert.equal(fs.readdirSync(internal).length,0);
 fs.unlinkSync(dest);
});
test('directory/search caps are explicit, stable after completion and session-bound; tool definitions stay dynamic', {timeout:25000},async t=>{
 const {app,invoke,work}=await fixture(t);
 for(let i=0;i<340;i++)fs.writeFileSync(path.join(work,'test-'+String(i).padStart(4,'0')+'.txt'),'needle\n');
 const first=await invoke('list_directory',{path:'.',limit:83});
 assert.equal(first.total,340);assert.equal(first.entries.length,83);assert.equal(first.truncated,true);
 let cursor=first.next_cursor,offset=first.next_offset,ids=first.entries.map(x=>x.name);
 while(cursor){const page=await invoke('list_directory',{path:'.',limit:83,offset,cursor});ids.push(...page.entries.map(x=>x.name));cursor=page.next_cursor;offset=page.next_offset;}
 assert.equal(ids.length,340);assert.equal(new Set(ids).size,340);
 await assert.rejects(invoke('list_directory',{path:'.',offset:83,limit:83}),e=>e.code==='LIST_CURSOR_REQUIRED');
 const snapshot=await invoke('list_directory',{path:'.',limit:20});
 fs.writeFileSync(path.join(work,'later-0001.txt'),'needle\n');
 await assert.rejects(invoke('list_directory',{path:'.',offset:snapshot.next_offset,limit:20,cursor:snapshot.next_cursor}),e=>e.code==='LIST_CHANGED');
 const link=path.join(work,'visible-link.txt');fs.symlinkSync(path.join(work,'test-0001.txt'),link);
 const page=await invoke('list_directory',{path:'.',limit:300});assert.equal(page.hidden_or_skipped,true);assert.ok(!page.entries.some(x=>x.name==='visible-link.txt'));fs.unlinkSync(link);
 const quick=await invoke('search_text',{query:'needle',path:'.'});
 assert.equal(quick.truncated,true);assert.equal(quick.total,null);assert.equal(quick.at_least,100);assert.match(quick.continuation,/start_search/);
 const begun=await invoke('start_search',{query:'needle',path:'.',type:'content',max_results:1000});
 let status;
 for(let i=0;i<200;i++){status=await invoke('search_results',{search_id:begun.search_id,limit:50});if(status.status==='completed')break;await sleep(20);}
 assert.equal(status.status,'completed');
 assert.equal(status.stable,true);assert.equal(status.total,341);
 await assert.rejects(invoke('search_results',{search_id:begun.search_id,limit:1},otherContext),e=>e.code==='SEARCH_OWNER');
 let seen=[],next=status;
 for(let i=0;i<100;i++){seen.push(...next.results.map(x=>x.path+':'+x.line));if(next.next_offset===null)break;
  next=await invoke('search_results',{search_id:begun.search_id,limit:50,offset:next.next_offset,cursor:next.next_cursor});}
 assert.equal(seen.length,341);assert.equal(new Set(seen).size,341);
 assert.ok(TOOLS.some(t=>t.name==='records_export'));
 const mf=manifest(TOOLS);assert.equal(mf.tool_count,TOOLS.length);assert.equal(typeof mf.schema_sha256,'string');
});
