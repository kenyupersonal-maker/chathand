import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {desktop} from './1052-a-fixture.mjs';
test('preinstall12 bounded history ingests latest 2000 random-named receipts and displays newest first',async t=>{
 const f=await desktop(t),a=f.app,r=a.policy.receipts,ids=[];
 for(let i=1;i<=2500;i++){const id=crypto.randomUUID(),file=path.join(r.dir,id+'.json');ids.push(id);fs.writeFileSync(file,JSON.stringify({format:1,task_id:id,owner_hash:r.owner('chatgpt'),success:true,result:{task_id:id,project_id:a.state.data.active,title:'synthetic '+i,status:'completed',created_at:i,finished_at:i,execution_complete:true,jobs:[]}}));fs.utimesSync(file,i,i);}
 const read=r.read,seen=[];r.read=function(id,...args){seen.push(id);return read.call(this,id,...args);};const s=await a.snapshot();r.read=read;
 assert.deepEqual(seen.slice(0,2000),ids.slice(-2000).reverse());assert.equal(new Set(seen).size,2500);assert.equal(s.history_meta.at_least,2000);assert.deepEqual(s.history.map(t=>t.task_id),ids.slice(-100).reverse());assert.equal(s.history_meta.source_receipt_entries,2500);
});
