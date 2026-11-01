import test from 'node:test';
import assert from 'node:assert/strict';
import {consolidatedTaskCard} from '../../app/v1/card-task-view.mjs';
import {desktop} from './1052-a-fixture.mjs';

test('rich card remaps moved-directory children and removes every recycled descendant',()=>{
 const full={task_id:'root',title:'files',status:'active'},changes=[{tool:'write_text',path:'before/one.txt',status:'applied'},{tool:'write_text',path:'before/nested/two.txt',status:'applied'},{tool:'move_path',path:'before',destination:'after',status:'applied'}];
 const moved=consolidatedTaskCard(full,{changes});assert.deepEqual(moved.files.map(f=>f.path).sort(),['after','after/nested/two.txt','after/one.txt']);
 for(const file of moved.files)assert.equal(file.reveal.arguments.path,file.path);
 changes.push({tool:'trash_path',path:'after',status:'recycled'});assert.deepEqual(consolidatedTaskCard(full,{changes}).files,[]);
 changes.push({tool:'restore_trash',path:'after',status:'applied'});assert.deepEqual(consolidatedTaskCard(full,{changes}).files.map(f=>f.path),['after']);
});
test('one root contains its authoritative blocks and reports already-pruned checkpoint history',()=>{
 const full={task_id:'root',status:'active',checkpoint_seq:100},history=Array.from({length:20},(_,i)=>({at:i,block:i+81,total:100,done:'block '+(i+81)}));
 const c=consolidatedTaskCard(full,{checkpoints:history});
 assert.deepEqual(c.grouping,{kind:'single_root_checkpoints',root_task_id:'root',independent_task_ids_merged:false});
 assert.equal(c.coverage.omitted_checkpoints,80);assert.equal(c.timeline.length,20);assert.equal(c.timeline[0].id,'root:checkpoint:81');assert.equal(c.timeline.at(-1).id,'root:checkpoint:100');
});
test('actual trash and restore change records update the exact private task file list',async t=>{
 const f=await desktop(t),id=await f.begin(),write=f.ok(await f.rpc('write_text',{task_id:id,path:'file.txt',content:'fake',expected_sha256:'MISSING',operation_id:'lifecycle-write-01'}));
 const trashed=f.ok(await f.rpc('trash_path',{task_id:id,path:'file.txt',expected_sha256:write.sha256,operation_id:'lifecycle-trash-01'}));
 const card=r=>r._meta['chathand/task_card'];
 assert.deepEqual(card(await f.rpc('task_status',{task_id:id})).files,[]);
 f.ok(await f.rpc('restore_trash',{task_id:id,trash_id:trashed.trash_id,operation_id:'lifecycle-restore-01'}));
 const restored=card(await f.rpc('task_status',{task_id:id}));assert.equal(restored.files.length,1);assert.equal(restored.files[0].path,'file.txt');assert.equal(restored.files[0].source_tool,'restore_trash');
 const records=f.app.tools.features.changes.read(id);assert.equal(records.find(c=>c.tool==='restore_trash').path,'file.txt');
});
