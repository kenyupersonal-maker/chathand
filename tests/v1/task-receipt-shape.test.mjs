import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {TaskReceipts} from '../../app/task-receipts.mjs';

for (const [name,value] of [['null',null],['array',[]],['boolean',true],['number',0],['string','receipt'],['missing result',{}]]) {
  test('invalid receipt document '+name+' gives a stable error and keeps the original file',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-receipt-shape-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const receipts=new TaskReceipts(root),id=crypto.randomUUID(),file=path.join(receipts.dir,id+'.json'),original=JSON.stringify(value);
    fs.writeFileSync(file,original,{mode:0o600});
    assert.throws(()=>receipts.read(id),{code:'TASK_RECEIPT_INVALID'});
    assert.equal(fs.readFileSync(file,'utf8'),original);
    assert.equal(receipts.cache.has(id),false);
  });
}

test('valid completed and revoked receipts keep their existing cache and cloning behavior',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-receipt-shape-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const receipts=new TaskReceipts(root),completed=crypto.randomUUID(),revoked=crypto.randomUUID();
  receipts.save(completed,'fixture',true,{task_id:completed,status:'completed',execution_complete:true,terminal:true,finished_at:1,jobs:[]});
  receipts.saveRevocation(revoked,'fixture',{task_id:revoked,status:'cancelled',execution_complete:false,terminal:true,finished_at:2,jobs:[]});
  const copy=receipts.read(completed);copy.result.status='changed';
  assert.equal(receipts.read(completed).result.status,'completed');
  assert.equal(receipts.read(revoked).result.status,'cancelled');
  assert.equal(receipts.cachedStatus(completed),'completed');
});
