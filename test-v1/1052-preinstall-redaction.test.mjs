import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {redact} from '../engine/src/commands.mjs';import {desktop} from './1052-a-fixture.mjs';import {redactionCorpus,differential} from './1052-preinstall-redaction-corpus.mjs';
test('preinstall1 every 1049-hidden fake value stays hidden in the linear scanner',()=>{
 const report=differential(redact);assert.equal(report.count,80);assert.deepEqual(report.regressions,[]);
 for(const r of report.rows)assert.equal(r.new_hidden,r.expected_hidden,`corpus ${r.id}`);
});
test('preinstall1 actual command memory and full archive hide prefixed split values',async t=>{
 const f=await desktop(t),task_id=await f.begin(),rows=redactionCorpus.filter(r=>r.kind!=='long-line'&&r.hidden),value=rows.map(r=>r.input.endsWith('\n')?r.input:r.input+'\n').join('');
 const encoded=Buffer.from(value).toString('base64');
 const code=`const s=Buffer.from('${encoded}','base64').toString();let p=0;function send(){if(p>=s.length)return;const n=Math.min(s.length,p+7);process.stdout.write(s.slice(p,n));p=n;setTimeout(send,1);}send();`;
 const j=f.ok(await f.rpc('propose_command',{task_id,request_id:crypto.randomUUID(),program:process.execPath,args:['-e',code],wait_ms:2000}));
 await f.app.queue.result(j.job_id,3000);const ordinary=f.ok(await f.rpc('command_result',{job_id:j.job_id}));
 assert.equal(ordinary.status,'completed');assert.equal(ordinary.stdout,redact(value));
 let full='',cursor=null;do{const r=f.ok(await f.rpc('command_result',{job_id:j.job_id,full:true,...(cursor?{full_cursor:cursor}:{})}));full+=r.segments.map(s=>s.text).join('');cursor=r.next_full_cursor;}while(cursor);
 assert.equal(full,redact(value));for(const r of rows){assert.equal(ordinary.stdout.includes(r.value),false,`memory ${r.id}`);assert.equal(full.includes(r.value),false,`full ${r.id}`);}
});
