import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ScopedStore,AccessPolicy} from '../../app/v06/access.mjs';
import {Changes,editFile} from '../../app/v06/changes.mjs';
import {undoTask} from '../../app/v1/undo.mjs';
import {saveJSON,digest} from '../../engine/src/core.mjs';
import {fixture as artifactFixture} from './1043-artifact-fixture.mjs';
import {createDesktop} from '../../app/server.mjs';
import {catalogs,validateCatalogs,t as translate} from '../../app/i18n.mjs';

function fixture(t){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-undo-ledger-'))),root=path.join(base,'work'),data=path.join(base,'data');
 fs.mkdirSync(root);fs.mkdirSync(data);fs.writeFileSync(path.join(root,'document.txt'),'version 0\n');
 const statePath=path.join(data,'state.json');saveJSON(statePath,{active:'fixture-project',mode:'auto',conversations:[]});
 const restart=()=>{const store=new ScopedStore(root,data);store.writesEnabled=true;const state={data:JSON.parse(fs.readFileSync(statePath)),save(){saveJSON(statePath,this.data);}},queue={jobs:new Map(),inputs:new Map(),list:()=>[],cancelAll(){}};const policy=new AccessPolicy(state,store,queue);policy.enabled=true;return {store,policy,changes:new Changes(store,policy)};};
 const f={base,root,data,restart};t.after(async()=>{await f.close?.();fs.rmSync(base,{recursive:true,force:true});});return f;
}
const begin=c=>c.policy.begin({request_id:crypto.randomUUID(),title:'普通撤销验证'},'fixture-caller').task_id;
function write(c,id,n){const args={path:'document.txt',content:'version '+n+'\n',expected_sha256:c.store.bytes('document.txt').sha256,operation_id:'fixture_write_'+n};const result=c.policy.fileAction(c.policy.require(id,'fixture-caller'),'write_text',args,()=>c.store.write(args.path,args.content,args.expected_sha256,args.operation_id));c.changes.record(id,'write_text',args,result);return result;}
const finish=(c,id)=>c.policy.finish(id,'fixture-caller',true);
const undo=(c,id,extra={})=>undoTask({taskId:id,...c,...extra});

test('301 writes survive finish and fresh object reload; undo restores version zero',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);for(let n=1;n<=301;n++)write(c,id,n);finish(c,id);c=f.restart();
 assert.equal(c.policy.get(id).archived,true);assert.equal(c.changes.read(id).length,301);assert.equal(undo(c,id,{dryRun:true}).summary.total,301);
 const result=undo(c,id);assert.equal(result.done.length,301);assert.equal(result.skipped.length,0);assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0\n');
 assert.throws(()=>undo(c,id),{code:'ALREADY_UNDONE'});
});

test('artifact registration after 300 writes preserves the entire earlier file undo chain',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);for(let n=1;n<=300;n++)write(c,id,n);
 c.changes.recordArtifacts(id,{operation_id:crypto.randomUUID(),directory:'outputs',files:[{path:'outputs/result.txt',bytes:1,sha256:digest('x')}]});finish(c,id);c=f.restart();
 assert.equal(c.changes.read(id).length,301);const r=undo(c,id);assert.equal(r.done.length,300);assert.equal(r.skipped.length,1);assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0\n');
});

test('aggregate artifact metadata over 2 MiB remains readable in individually bounded blocks',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);
 const prefix=Array.from({length:7},()=> 'ordinary-'.repeat(12)).join('/');
 for(let batch=0;batch<6;batch++)c.changes.recordArtifacts(id,{operation_id:crypto.randomUUID(),directory:'outputs',files:Array.from({length:500},(_,i)=>({path:prefix+'/result-'+batch+'-'+i+'.txt',bytes:1,sha256:digest('x')}))});
 const blockDir=path.join(c.changes.dir,id+'.blocks');const sizes=fs.readdirSync(blockDir).map(n=>fs.statSync(path.join(blockDir,n)).size);assert.ok(sizes.reduce((a,b)=>a+b,0)>2*1024*1024);assert.ok(sizes.every(n=>n<=2*1024*1024));finish(c,id);c=f.restart();
 assert.equal(c.changes.read(id).length,7);const r=undo(c,id);assert.equal(r.done.length,1);assert.equal(r.skipped.length,6);assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0\n');
});

test('provably untruncated short ordinary legacy log remains undoable and migrates',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);write(c,id,2);saveJSON(c.changes.file(id),c.changes.read(id));finish(c,id);c=f.restart();
 const r=undo(c,id);assert.equal(r.done.length,2);assert.equal(r.skipped.length,0);assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0\n');assert.equal(JSON.parse(fs.readFileSync(c.changes.file(id))).version,2);
});
for(const name of ['exactly 300','short artifact log'])test('unproven legacy '+name+' is readable but cannot claim complete undo',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);let list=c.changes.read(id);
 if(name==='exactly 300')list=[...Array.from({length:299},(_,i)=>({tool:'create_directory',path:'dir-'+i,operation_id:'legacy_'+i,status:'applied'})),...list];
 else list.push({tool:'save_files',path:'outputs',files:[],operation_id:crypto.randomUUID(),status:'applied'});
 saveJSON(c.changes.file(id),list);finish(c,id);c=f.restart();assert.equal(c.changes.read(id).length,list.length);
 for(const dryRun of [true,false])assert.throws(()=>undo(c,id,{dryRun}),{code:'CHANGE_LOG_INCOMPLETE'});
 assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 1\n');
});

test('missing committed head or block refuses a partial undo plan before changing files',t=>{
 for(const missing of ['head','block']){
  const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);write(c,id,2);finish(c,id);
  const head=JSON.parse(fs.readFileSync(c.changes.file(id))),tail=JSON.parse(fs.readFileSync(path.join(c.changes.dir,id+'.blocks',head.tail+'.json')));
  fs.unlinkSync(missing==='head'?c.changes.file(id):path.join(c.changes.dir,id+'.blocks',tail.previous+'.json'));c=f.restart();
  assert.throws(()=>undo(c,id),{code:'CHANGE_LOG_INVALID'});assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 2\n');
 }
});

test('final head save failure leaves a durable same-task intent and blocks apparently complete old head',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);write(c,id,1);const args={path:'document.txt',content:'version 2\n',expected_sha256:c.store.bytes('document.txt').sha256,operation_id:'fixture_write_2'};
 const rename=fs.renameSync;const target=c.changes.file(id);t.mock.method(fs,'renameSync',(src,dest)=>{if(dest===target&&JSON.parse(fs.readFileSync(src)).count===2)throw Object.assign(Error('ordinary injected save failure'),{code:'EIO'});return rename(src,dest);});
 assert.throws(()=>c.changes.capture(id,'write_text',args,()=>c.store.write(args.path,args.content,args.expected_sha256,args.operation_id)),{code:'EIO'});t.mock.restoreAll();
 assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 2\n');finish(c,id);c=f.restart();assert.equal(c.changes.read(id).length,1);assert.throws(()=>undo(c,id),{code:'CHANGE_LOG_INCOMPLETE'});
});

for(const directory of [false,true])for(const laterChange of [false,true])test('restore_trash '+(directory?'directory':'file')+' has an undo snapshot; '+(laterChange?'later changes stay':'unchanged restore returns to recycle'),t=>{
 const f=fixture(t);let c=f.restart();if(directory){fs.mkdirSync(path.join(f.root,'tree'));fs.mkdirSync(path.join(f.root,'tree','empty'));fs.writeFileSync(path.join(f.root,'tree','child.txt'),'original');}
 const rel=directory?'tree':'document.txt';const trashTask=begin(c),trashArgs={path:rel,operation_id:'ordinary_trash_001',expected_sha256:c.store.pathInfo(rel).sha256};
 const trashed=c.store.trash(rel,trashArgs.expected_sha256,trashArgs.operation_id);c.changes.record(trashTask,'trash_path',trashArgs,trashed);finish(c,trashTask);
 const id=begin(c),args={trash_id:trashed.trash_id,operation_id:'ordinary_restore_001'},restored=c.store.restoreTrash(args.trash_id,args.operation_id);c.changes.record(id,'restore_trash',args,restored);finish(c,id);
 assert.equal(restored.receipt_id,args.operation_id);const receipt=JSON.parse(fs.readFileSync(c.store.operationFile(args.operation_id)));assert.equal(receipt.after_sha256,restored.sha256);assert.equal(receipt.path,rel);
 if(laterChange)fs.writeFileSync(path.join(f.root,directory?'tree/child.txt':rel),'later user content');c=f.restart();assert.equal(undo(c,id,{dryRun:true}).summary.remove,1);
 const r=undo(c,id);assert.equal(r.done.length,laterChange?0:1);assert.equal(r.skipped.length,laterChange?1:0);assert.equal(fs.existsSync(path.join(f.root,rel)),laterChange);
 if(laterChange)assert.equal(fs.readFileSync(path.join(f.root,directory?'tree/child.txt':rel),'utf8'),'later user content');
 else{const reversed=c.changes.read(id).find(x=>x.tool==='trash_path');c.store.restoreTrash(reversed.trash_id,'ordinary_recover_001');assert.equal(c.store.pathInfo(rel).sha256,restored.sha256);}
});

test('legacy restore_trash entries without receipt_id undo using their confirmed saved snapshot hash',t=>{
 const f=fixture(t);let c=f.restart();const id=begin(c);const hash=c.store.pathInfo('document.txt').sha256;
 saveJSON(c.changes.file(id),[{tool:'restore_trash',path:'document.txt',operation_id:'legacy_restore_001',receipt_id:null,sha256:hash,status:'applied'}]);finish(c,id);c=f.restart();assert.equal(undo(c,id).done.length,1);assert.equal(fs.existsSync(path.join(f.root,'document.txt')),false);
});

test('artifact commit is not reached when the existing ledger cannot be read',async t=>{
 const f=artifactFixture(t);fs.writeFileSync(f.changes.file(f.task.id),'x'.repeat(2*1024*1024+1));const r=await f.save({files:[{file_name:'result.txt',file_id:'synthetic',download_url:'https://fixture.invalid/result'}]});
 assert.equal(r.status,'failed');assert.equal(r.code,'CHANGE_LOG_INVALID');assert.equal(f.native.calls.some(x=>x.action==='commit'),false);assert.equal(fs.existsSync(path.join(f.root,'成果')),false);
});

test('artifact final ledger failure remains unconfirmed until status reconciles the applied commit',async t=>{
 const f=artifactFixture(t),rename=fs.renameSync,head=f.changes.file(f.task.id);
 t.mock.method(fs,'renameSync',(src,dest)=>{if(dest===head&&JSON.parse(fs.readFileSync(src)).count===1)throw Object.assign(Error('ordinary injected ledger failure'),{code:'EIO'});return rename(src,dest);});
 const r=await f.save({files:[{file_name:'result.txt',file_id:'synthetic',download_url:'https://fixture.invalid/result'}]});assert.equal(r.status,'unconfirmed');assert.equal(f.native.calls.filter(x=>x.action==='commit').length,1);assert.equal(f.changes.read(f.task.id).length,0);assert.throws(()=>f.changes.readForUndo(f.task.id),{code:'CHANGE_LOG_INCOMPLETE'});
 t.mock.restoreAll();assert.equal((await f.status()).status,'applied');assert.equal(f.changes.readForUndo(f.task.id).length,1);assert.equal(f.native.calls.filter(x=>x.action==='commit').length,1);
});

test('artifact single-record capacity is checked before commit, preserving earlier records',async t=>{
 const f=artifactFixture(t);f.changes.record(f.task.id,'write_text',{path:'existing.txt',operation_id:'existing_write_001'},{sha256:digest('x')});
 // A narrow capacity fault in the real prepareArtifacts step, not a commit mock.
 const original=f.changes.prepareArtifacts.bind(f.changes);f.changes.prepareArtifacts=(id,r)=>original(id,{...r,files:Array.from({length:500},()=>({path:'x'.repeat(4096),bytes:1,sha256:digest('x')}))});
 const r=await f.save({files:[{file_name:'result.txt',file_id:'synthetic',download_url:'https://fixture.invalid/result'}]});assert.equal(r.status,'failed');assert.equal(r.code,'CHANGE_LOG_LIMIT');assert.equal(f.native.calls.some(x=>x.action==='commit'),false);assert.equal(f.changes.read(f.task.id).length,1);
});

test('actual Tools write and edit dispatch preflight the ledger before the file mutation',async t=>{
 const f=fixture(t);const app=await createDesktop({stateDir:path.join(f.base,'desktop-state'),defaultRoot:f.root,uiKey:'b'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(f.base,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1073,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});f.close=()=>app.close();
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;const call=(name,args)=>app.tools.invoke(name,args,'fixture-caller');const id=(await call('begin_task',{request_id:'dispatch_preflight',title:'普通写入'})).task_id;
 fs.writeFileSync(app.tools.features.changes.file(id),'x'.repeat(2*1024*1024+1));
 for(const [name,args] of [['write_text',{content:'changed',expected_sha256:digest('version 0\n')}],['edit_file',{old_text:'version 0',new_text:'changed',expected_sha256:digest('version 0\n')}]]){
  await assert.rejects(()=>call(name,{task_id:id,path:'document.txt',operation_id:'dispatch_'+name,...args}),{code:'CHANGE_LOG_INVALID'});assert.equal(fs.readFileSync(path.join(f.root,'document.txt'),'utf8'),'version 0\n');assert.equal(fs.existsSync(app.store.operationFile('dispatch_'+name)),false);
 }
});

test('new integrity and capacity errors have Chinese and English catalog entries',()=>{
 const keys=['ui.server.undo.invalidLedger','ui.server.undo.ledgerLimit','ui.server.undo.incompleteLedger'];assert.equal(validateCatalogs(catalogs,keys),true);for(const key of keys){assert.notEqual(translate(key,{},'zh'),key);assert.notEqual(translate(key,{},'en'),translate(key,{},'zh'));}
});
