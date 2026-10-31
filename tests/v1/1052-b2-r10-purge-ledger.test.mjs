// 1052 B2 / R10（Claude 写，Codex 审和测）：永久删除账本。只用系统临时目录，不碰真实 stateDir。
// 查：清空后崩溃再恢复，清掉的不回来；同一个 op 重放第二次没有效果；recoverFinished 不重建清掉的编号；
// 账本和收尾意图里不留正文；旧的收尾意图缺证就拒绝；账本坏了就停，不猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {MatterStore} from '../../app/v1/matters.mjs';

let seq=0;
const op=()=>'b2-r10-'+(++seq).toString().padStart(8,'0');
const SECRETISH='这句原话清空以后不能再出现在磁盘上';
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1052-b2-r10-'))),stateDir=path.join(root,'state');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {stateDir,store:new MatterStore({stateDir})};
}
const create=(title='清空测试',text=SECRETISH)=>({operation_id:op(),action:'create',title,raw:{speaker:'Ken',text},state:'deferred',create_anyway:true});
const write=(s,e)=>s.write({request_id:'b2-batch-'+op(),entries:[e]},{project_id:'p',session_hash:'h'}).then(r=>r.items[0]);
async function made(store,text=SECRETISH){const one=await write(store,create('清空测试',text));assert.equal(one.saved,true);return one;}
async function softDelete(store,id){const cur=store.items.get(id);const r=await write(store,{operation_id:op(),action:'delete',id,base_revision:cur.revision});assert.equal(r.saved,true);}
function filesUnder(dir){const out=[];for(const n of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,n.name);if(n.isDirectory())out.push(...filesUnder(f));else out.push(f);}return out;}
const anyFileContains=(dir,text)=>filesUnder(dir).some(f=>fs.readFileSync(f,'utf8').includes(text));
const receipt=(owner)=>({format:1,result:{execution_complete:true},owner_hash:owner});

test('清空：账本先落，正文和损坏备份都清掉，账本里只有编号和摘要',async t=>{
 const {store,stateDir}=fixture(t),one=await made(store);
 fs.appendFileSync(store.file(one.id),'{"bad":');await write(store,{operation_id:op(),action:'append',id:one.id,base_revision:1,answer:'修复后追加'});
 assert.ok(fs.readdirSync(store.dir).some(n=>n.startsWith(one.id+'.jsonl.damage-')),'前提：有损坏备份');
 await softDelete(store,one.id);
 assert.deepEqual(await store.purge({confirmed:true}),{purged:1});
 assert.equal(fs.existsSync(store.file(one.id)),false);
 assert.equal(fs.readdirSync(store.dir).some(n=>n.startsWith(one.id+'.jsonl')),false,'损坏备份也清掉');
 const ledger=JSON.parse(fs.readFileSync(path.join(store.dir,'purge-ledger.json'),'utf8'));
 assert.equal(ledger.format,1);assert.ok(ledger.purged[one.id]);assert.equal(Object.keys(ledger.consumed).length,3);
 assert.equal(anyFileContains(stateDir,SECRETISH),false,'磁盘上不再有原话');
 assert.equal(anyFileContains(stateDir,'修复后追加'),false);
});

test('清空后崩溃（账本落了、正文没删），再打开：清掉的不回来，并把没删完的删完',async t=>{
 const {store,stateDir}=fixture(t),one=await made(store),keep=await made(store,'这条留着');
 await softDelete(store,one.id);
 const original=store.removeBodies.bind(store);store.removeBodies=()=>{throw Object.assign(Error('synthetic crash'),{code:'TEST_CRASH'});};
 await assert.rejects(store.purge({confirmed:true}),e=>e.code==='TEST_CRASH');
 store.removeBodies=original;
 assert.equal(fs.existsSync(store.file(one.id)),true,'前提：崩溃时正文还在');
 const reopened=new MatterStore({stateDir});
 assert.equal(reopened.items.has(one.id),false);assert.equal(fs.existsSync(reopened.file(one.id)),false);
 assert.ok(reopened.reports.some(x=>x.code==='MATTER_PURGE_COMPLETED'&&x.id===one.id));
 assert.equal(reopened.items.has(keep.id),true,'没删的不受影响');
 assert.equal(reopened.query({ids:[one.id],view:'detail'}).items.length,0);
 assert.equal(anyFileContains(stateDir,SECRETISH),false);
});

test('清空前崩溃（账本没落）：什么都没变，还在「最近删除」里，可以再清',async t=>{
 const {store,stateDir}=fixture(t),one=await made(store);await softDelete(store,one.id);
 const original=store.writeLedger.bind(store);store.writeLedger=()=>{throw Object.assign(Error('synthetic crash'),{code:'TEST_CRASH'});};
 await assert.rejects(store.purge({confirmed:true}),e=>e.code==='TEST_CRASH');store.writeLedger=original;
 const reopened=new MatterStore({stateDir});
 assert.equal(reopened.items.get(one.id)?.deleted,true);
 assert.deepEqual(await reopened.purge({confirmed:true}),{purged:1});assert.equal(reopened.items.has(one.id),false);
});

test('同一个 op 重放：第二次没有效果，换了内容就冲突；重启以后一样',async t=>{
 const {store,stateDir}=fixture(t),e=create(),one=await write(store,e);
 const appendOp={operation_id:op(),action:'append',id:one.id,base_revision:1,answer:'第一次答复'};
 assert.equal((await write(store,appendOp)).saved,true);
 await softDelete(store,one.id);await store.purge({confirmed:true});
 for(const s of [store,new MatterStore({stateDir})]){
  const again=await write(s,e);
  assert.equal(again.saved,true);assert.equal(again.replayed,true);assert.equal(again.purged,true);assert.equal(again.id,one.id);
  assert.equal(s.items.size,0,'没有重建');assert.equal(fs.existsSync(s.file(one.id)),false);
  assert.equal((await write(s,appendOp)).replayed,true);
  const changed=await write(s,{...e,title:'换了内容'});assert.equal(changed.saved,false);assert.equal(changed.error_code,'OP_CONFLICT');
  const fresh=await write(s,create('新的一条','新原话'));assert.ok(Number(fresh.id.slice(3))>Number(one.id.slice(3)),'编号不复用');
 }
});

test('清掉的编号：追加、恢复、开工认领都拒绝，错误码是 MATTER_PURGED',async t=>{
 const {store}=fixture(t),one=await made(store);await softDelete(store,one.id);await store.purge({confirmed:true});
 const a=await write(store,{operation_id:op(),action:'append',id:one.id,base_revision:2,answer:'想追加'});assert.equal(a.error_code,'MATTER_PURGED');
 const r=await write(store,{operation_id:op(),action:'restore',id:one.id,base_revision:2});assert.equal(r.error_code,'MATTER_PURGED');
 const c=await store.claim({id:crypto.randomUUID()},[one.id]);assert.equal(c.matters_saved,false);assert.equal(c.matters[0].error_code,'MATTER_PURGED');
 assert.equal(store.items.size,0);
});

test('recoverFinished 永远不重建已经清掉的编号；收尾意图里的正文也清掉',async t=>{
 const {store,stateDir}=fixture(t),task={id:crypto.randomUUID()},caller='caller-a';
 const createEntry={operation_id:op(),action:'create',title:'收尾时新建',raw:{speaker:'Ken',text:SECRETISH},state:'deferred',create_anyway:true};
 const prepared=store.prepareFinish(task,caller,[createEntry],{project_id:'p',session_hash:'h',receipt_owner_hash:'owner-1'});
 assert.equal(prepared.purge_ledger,1);
 const applied=await store.applyFinish(task.id,caller,{project_id:'p',session_hash:'h'});
 const id=applied.matters[0].id;assert.equal(applied.matters_saved,true);assert.ok(store.items.has(id));
 await softDelete(store,id);await store.purge({confirmed:true});
 const intent=fs.readFileSync(path.join(store.pendingDir,task.id+'.json'),'utf8');
 assert.equal(intent.includes(SECRETISH),false,'收尾意图里不留原话');assert.equal(JSON.parse(intent).entries[0].entry.purged,true);
 for(const s of [store,new MatterStore({stateDir})]){
  const results=await s.recoverFinished(()=>receipt('owner-1'));
  assert.equal(results.length,1);assert.equal(results[0].matters_saved,true,'这条当时做成了，算已做');
  assert.equal(s.items.has(id),false,'没有重建');assert.equal(fs.existsSync(s.file(id)),false);
 }
 const again=await store.applyFinish(task.id,caller,{project_id:'p',session_hash:'h'});
 assert.equal(again.matters[0].purged,true);assert.equal(store.items.has(id),false);
 assert.equal(anyFileContains(stateDir,SECRETISH),false);
});

test('收尾意图里没做成的那条碰到清掉的编号：报 MATTER_PURGED，不写',async t=>{
 const {store,stateDir}=fixture(t),one=await made(store),task={id:crypto.randomUUID()};
 store.prepareFinish(task,'c',[{operation_id:op(),action:'append',id:one.id,base_revision:1,answer:'收尾答复'}],{receipt_owner_hash:'o'});
 await softDelete(store,one.id);await store.purge({confirmed:true});
 const reopened=new MatterStore({stateDir}),results=await reopened.recoverFinished(()=>receipt('o'));
 assert.equal(results[0].matters_saved,false);assert.equal(reopened.items.size,0);
 const r=await reopened.applyFinish(task.id,'c');assert.equal(r.matters[0].error_code,'MATTER_PURGED');
 assert.equal(fs.readFileSync(path.join(reopened.pendingDir,task.id+'.json'),'utf8').includes('收尾答复'),false);
});

test('首迁移：账本之前写的收尾意图，新建的编号不在了就缺证拒绝，不新建',async t=>{
 const {store,stateDir}=fixture(t),task={id:crypto.randomUUID()};
 // 模拟旧版写的意图：没有 purge_ledger，预分配的 CH-7 已经不在（可能被旧版清掉了，也可能从没建过，分不清）。
 const legacy={format:1,task_id:task.id,owner_hash:'x',receipt_owner_hash:'o',explicit_sig:'s',sig:'s',at:1,project_id:null,session_hash:null,
  entries:[{entry:{operation_id:op(),action:'create',title:'旧意图',raw:{speaker:'Ken',text:'旧原话'},state:'deferred',create_anyway:true},reservedId:'CH-7'}]};
 fs.writeFileSync(path.join(store.pendingDir,task.id+'.json'),JSON.stringify(legacy),{mode:0o600});
 const reopened=new MatterStore({stateDir}),results=await reopened.recoverFinished(()=>receipt('o'));
 assert.equal(results[0].matters_saved,false);assert.equal(reopened.items.has('CH-7'),false);
 const fresh=await write(reopened,create('之后新建','新'));assert.ok(Number(fresh.id.slice(3))>7,'预分配过的编号也不复用');
});

test('账本坏了：事项库不打开（不猜哪些可以回来）',async t=>{
 const {store,stateDir}=fixture(t),one=await made(store);await softDelete(store,one.id);await store.purge({confirmed:true});
 fs.writeFileSync(path.join(store.dir,'purge-ledger.json'),'{"format":1,');
 assert.throws(()=>new MatterStore({stateDir}),e=>e.code==='MATTER_LEDGER_CORRUPT');
});
