import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';import {undoTask,planUndo} from '../../app/v1/undo.mjs';

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1025-undo-')),work=path.join(root,'work');fs.mkdirSync(work);
 fs.writeFileSync(path.join(work,'notes.md'),'原来的\n');fs.writeFileSync(path.join(work,'old.txt'),'要挪的\n');fs.writeFileSync(path.join(work,'drop.txt'),'要删的\n');
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'b'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1025,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const call=(name,args)=>app.tools.invoke(name,args,'chatgpt');
 return {app,work,call};
}
const ctx=app=>({policy:app.tools.policy,store:app.store,changes:app.tools.features.changes});

test('undo puts a finished task back: edits reverted, new file recycled, move reversed, trash restored',async t=>{
 const {app,work,call}=await fixture(t);const b=await call('begin_task',{request_id:'undo_case_1',title:'整理'});const id=b.task_id;
 await call('write_text',{task_id:id,path:'notes.md',content:'改了一次\n',expected_sha256:sha('原来的\n'),operation_id:'op_undo_1'});
 await call('write_text',{task_id:id,path:'notes.md',content:'又改一次\n',expected_sha256:sha('改了一次\n'),operation_id:'op_undo_2'});
 await call('write_text',{task_id:id,path:'new.md',content:'新建的\n',expected_sha256:'MISSING',operation_id:'op_undo_3'});
 await call('move_path',{task_id:id,from:'old.txt',to:'moved.txt',expected_sha256:sha('要挪的\n'),operation_id:'op_undo_4'});
 await call('trash_path',{task_id:id,path:'drop.txt',expected_sha256:sha('要删的\n'),operation_id:'op_undo_5'});
 await assert.rejects(async()=>undoTask({taskId:id,...ctx(app)}),{code:'TASK_BUSY'});
 await call('finish_task',{task_id:id,summary:'整理好了'});
 const plan=undoTask({taskId:id,...ctx(app),dryRun:true}).summary;assert.deepEqual([plan.revert,plan.remove,plan.move_back,plan.untrash,plan.total],[2,1,1,1,5]);
 app.store.paused=true; // AI 暂停着也能撤：这是用户自己点的
 const r=undoTask({taskId:id,...ctx(app)});
 assert.equal(r.done.length,5);assert.deepEqual(r.skipped,[]);assert.equal(app.store.paused,true);
 assert.equal(fs.readFileSync(path.join(work,'notes.md'),'utf8'),'原来的\n');
 assert.equal(fs.existsSync(path.join(work,'new.md')),false);
 assert.equal(fs.readFileSync(path.join(work,'old.txt'),'utf8'),'要挪的\n');assert.equal(fs.existsSync(path.join(work,'moved.txt')),false);
 assert.equal(fs.readFileSync(path.join(work,'drop.txt'),'utf8'),'要删的\n');
 assert.throws(()=>undoTask({taskId:id,...ctx(app)}),{code:'ALREADY_UNDONE'});
});

test('a file changed afterwards is left alone and reported',async t=>{
 const {app,work,call}=await fixture(t);const b=await call('begin_task',{request_id:'undo_case_2',title:'改笔记'});const id=b.task_id;
 await call('write_text',{task_id:id,path:'notes.md',content:'AI 改的\n',expected_sha256:sha('原来的\n'),operation_id:'op_undo_21'});
 await call('finish_task',{task_id:id,summary:'改好了'});
 fs.writeFileSync(path.join(work,'notes.md'),'我后来自己又改了\n');
 const r=undoTask({taskId:id,...ctx(app)});
 assert.equal(r.done.length,0);assert.equal(r.skipped[0].reason,'之后又被改过，没动它');
 assert.equal(fs.readFileSync(path.join(work,'notes.md'),'utf8'),'我后来自己又改了\n');
});

test('nothing to undo and the window-only route',async t=>{
 const {app,call}=await fixture(t);const b=await call('begin_task',{request_id:'undo_case_3',title:'只看看'});await call('finish_task',{task_id:b.task_id,summary:'看完了'});
 assert.equal(undoTask({taskId:b.task_id,...ctx(app),dryRun:true}).summary.total,0);
 assert.throws(()=>undoTask({taskId:b.task_id,...ctx(app)}),{code:'NOTHING_TO_UNDO'});
 assert.deepEqual(planUndo([{tool:'create_directory',path:'x',status:'applied'}],app.store).map(x=>x.kind),['skip']);
 const server=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8');assert.ok(server.includes("const UI_ONLY=new Set([")&&server.includes("'/api/task/undo'")&&server.includes("'/api/confirm/answer'"));
 const ui=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),zh=JSON.parse(fs.readFileSync(new URL('../../locales/zh.json',import.meta.url),'utf8'));assert.ok(ui.includes("tbtn(T(\"ui.window.undoButton.text2\"),'undoTask',t.task_id)"));assert.equal(zh['ui.window.undoButton.text2'],'撤销改动');
});
