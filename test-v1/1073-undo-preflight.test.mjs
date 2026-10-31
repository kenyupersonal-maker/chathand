import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ScopedStore,AccessPolicy} from '../app/v06/access.mjs';
import {Changes} from '../app/v06/changes.mjs';
import {undoTask} from '../app/v1/undo.mjs';
import {ArtifactImportManager} from '../app/v1/artifact-import.mjs';
import {fakeNative} from './1043-artifact-fixture.mjs';
import {digest,saveJSON} from '../engine/src/core.mjs';
function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-undo-preflight-'))),root=path.join(base,'work'),data=path.join(base,'data');fs.mkdirSync(root);fs.mkdirSync(data);fs.writeFileSync(path.join(root,'document.txt'),'version 0');
 const restart=()=>{const store=new ScopedStore(root,data);store.writesEnabled=true;const state={data:{active:'fixture',mode:'auto',conversations:[]},save(){}},queue={jobs:new Map(),inputs:new Map(),list:()=>[],cancelAll(){}};const policy=new AccessPolicy(state,store,queue);policy.enabled=true;return {store,policy,changes:new Changes(store,policy)};};t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,root,data,restart};
}
const begin=c=>c.policy.begin({request_id:crypto.randomUUID(),title:'普通输入拒绝后的撤销'},'fixture').task_id;
function run(c,id,name,args,action){const perform=()=>c.policy.fileAction(c.policy.require(id,'fixture'),name,args,action);if(c.changes.capture)return c.changes.capture(id,name,args,perform);const result=perform();c.changes.record(id,name,args,result);return result;}
const write=(c,id,n)=>{const args={path:'document.txt',content:'version '+n,expected_sha256:c.store.bytes('document.txt').sha256,operation_id:'ordinary_write_'+n};return run(c,id,'write_text',args,()=>c.store.write(args.path,args.content,args.expected_sha256,args.operation_id));};
const finish=(c,id)=>c.policy.finish(id,'fixture',true);
const undo=(c,id)=>undoTask({taskId:id,...c});

for(const kind of ['mkdir exists','move stale hash','trash stale hash','move destination exists','restore destination occupied'])test('pure preflight '+kind+' preserves the earlier and later successful undo chain',t=>{
 const f=fixture(t);let c=f.restart();fs.mkdirSync(path.join(f.root,'already-there'));fs.writeFileSync(path.join(f.root,'already-there','sentinel'),'untouched');
 let recycled;
 if(kind==='restore destination occupied'){fs.writeFileSync(path.join(f.root,'other.txt'),'recycled');recycled=c.store.trash('other.txt',c.store.pathInfo('other.txt').sha256,'setup_trash_001');fs.writeFileSync(path.join(f.root,'other.txt'),'later occupant');}
 const id=begin(c);write(c,id,1);const operation_id='ordinary_refused_001';let name,args,action,code;
 if(kind==='mkdir exists'){name='create_directory';args={path:'already-there',operation_id};action=()=>c.store.mkdir(args.path,operation_id);code='EEXIST';}
 if(kind==='move stale hash'){name='move_path';args={from:'document.txt',to:'moved.txt',expected_sha256:'0'.repeat(64),operation_id};action=()=>c.store.move(args.from,args.to,args.expected_sha256,operation_id);code='HASH_CONFLICT';}
 if(kind==='trash stale hash'){name='trash_path';args={path:'document.txt',expected_sha256:'0'.repeat(64),operation_id};action=()=>c.store.trash(args.path,args.expected_sha256,operation_id);code='HASH_CONFLICT';}
 if(kind==='move destination exists'){name='move_path';args={from:'document.txt',to:'already-there',expected_sha256:c.store.pathInfo('document.txt').sha256,operation_id};action=()=>c.store.move(args.from,args.to,args.expected_sha256,operation_id);code='EEXIST';}
 if(kind==='restore destination occupied'){name='restore_trash';args={trash_id:recycled.trash_id,operation_id};action=()=>c.store.restoreTrash(args.trash_id,operation_id);code='HASH_CONFLICT';}
 assert.throws(()=>run(c,id,name,args,action),{code});assert.equal(JSON.parse(fs.readFileSync(c.store.operationFile(operation_id))).status,'prepared');assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 1');assert.equal(fs.readFileSync(path.join(f.root,'already-there','sentinel'),'utf8'),'untouched');
 write(c,id,2);finish(c,id);c=f.restart();const result=undo(c,id);assert.equal(result.done.length,2);assert.equal(result.skipped.length,0);assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0');if(recycled)assert.equal(fs.readFileSync(path.join(f.root,'other.txt'),'utf8'),'later occupant');
});

test('a previous prepared receipt has no current preflight proof and retains its new pending intent',t=>{
 const f=fixture(t);let c=f.restart();fs.mkdirSync(path.join(f.root,'existing'));const id=begin(c);write(c,id,1);const args={path:'existing',operation_id:'historical_prepared_001'};
 assert.throws(()=>c.store.mkdir(args.path,args.operation_id),{code:'EEXIST'});assert.throws(()=>run(c,id,'create_directory',args,()=>c.store.mkdir(args.path,args.operation_id)),{code:'OP_INCOMPLETE'});finish(c,id);c=f.restart();assert.throws(()=>undo(c,id),{code:'CHANGE_LOG_INCOMPLETE'});
});

test('an already pending intent without a receipt is not cleared by a later validation failure',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);const args={path:'document.txt',content:'bad\0content',expected_sha256:digest('version 1'),operation_id:'previous_intent_001'};
 c.changes.prepare(id,'write_text',args);assert.throws(()=>run(c,id,'write_text',args,()=>c.store.write(args.path,args.content,args.expected_sha256,args.operation_id)),{code:'CONTENT_INVALID'});finish(c,id);c=f.restart();assert.throws(()=>undo(c,id),{code:'CHANGE_LOG_INCOMPLETE'});
});

test('EEXIST thrown after the mutation callback actually creates a directory cannot clear pending',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);const args={path:'created',operation_id:'post_effect_error_001'},mkdir=fs.mkdirSync,target=path.join(f.root,'created');
 t.mock.method(fs,'mkdirSync',(p,...rest)=>{const result=mkdir(p,...rest);if(p===target)throw Object.assign(Error('ordinary injected error after creation'),{code:'EEXIST'});return result;});
 assert.throws(()=>run(c,id,'create_directory',args,()=>c.store.mkdir(args.path,args.operation_id)),{code:'EEXIST'});t.mock.restoreAll();assert.equal(fs.statSync(target).isDirectory(),true);finish(c,id);c=f.restart();assert.throws(()=>undo(c,id),{code:'CHANGE_LOG_INCOMPLETE'});
});

for(const previousPending of [false,true])test('artifact precommit persistence failure '+(previousPending?'preserves a prior pending intent':'clears only its own new intent and permits undo'),async t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);const native=fakeNative(),manager=new ArtifactImportManager({store:c.store,policy:c.policy,changes:c.changes,runtimeRoot:f.base,native:native.invoke,downloadsDir:path.join(f.base,'downloads')});t.after(()=>manager.close());
 const intent=manager.newIntent({task_id:id,request_id:'artifact_precommit'},'fixture',null,null).record;
 if(previousPending)c.changes.prepareArtifacts(id,{operation_id:intent.operation_id,directory:intent.destination,task_folder:intent.task_folder,files:[{path:intent.destination+'/result.txt',bytes:1,sha256:digest('x')}]});
 const persist=manager.persist.bind(manager);let failed=false;manager.persist=r=>{if(r.status==='commit_intent'&&!failed){failed=true;throw Object.assign(Error('ordinary injected precommit save failure'),{code:'EIO'});}return persist(r);};
 const result=await manager.receive(intent,[{data:Buffer.from('x'),file_name:'result.txt'}]);assert.equal(result.status,'failed');assert.equal(result.code,'EIO');assert.equal(native.calls.filter(x=>x.action==='commit').length,0);assert.equal(native.calls.filter(x=>x.action==='cancel').length,1);assert.equal(fs.existsSync(path.join(f.root,intent.destination)),false);write(c,id,2);finish(c,id);c=f.restart();
 if(previousPending)assert.throws(()=>undo(c,id),{code:'CHANGE_LOG_INCOMPLETE'});else{const r=undo(c,id);assert.equal(r.done.length,2);assert.equal(r.skipped.length,0);assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0');}
});
