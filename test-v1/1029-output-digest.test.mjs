import test from 'node:test';
import assert from 'node:assert/strict';
import {digestJob} from '../app/v1/output-digest.mjs';
import {Tools,TOOLS} from '../app/tools.mjs';

const job=stdout=>({job_id:'j1',status:'completed',exit_code:0,stdout,stderr:'',next_cursor:9,oldest_cursor:0,truncated:false});

test('短输出原样',()=>{
 const x=job('OUT\n'),r=digestJob(x);assert.notEqual(r,x);assert.deepEqual(r,x);assert.equal(r.output_digest,undefined);
});

test('2000 行成功输出只留最后 40 行并给统计',()=>{
 const text=Array.from({length:2000},(_,i)=>'ok line '+(i+1)).join('\n');
 const r=digestJob(job(text));assert.ok(r.output_digest?.trimmed);assert.equal(r.output_digest.total_lines,2000);
 assert.doesNotMatch(r.stdout,/ok line 1\n/);assert.match(r.stdout,/ok line 1961/);assert.match(r.stdout,/ok line 2000/);
 assert.match(r.stdout,/中间省略 1960 行/);assert.equal(r.output_digest.kept_lines,40);
});

test('node:test spec 的两个失败块、统计行、尾巴都保留',()=>{
 const lines=Array.from({length:300},(_,i)=>'✔ passing test '+i+' '+'.'.repeat(30));
 lines.splice(120,0,'✖ first broken','  AssertionError: FIRST_ASSERT','    expected 1','    actual 2','    stack a','    stack b','    code ERR_ASSERTION');
 lines.splice(220,0,'✖ second broken','  Error: SECOND_ORIGINAL','    at x','    at y','    detail a','    detail b','    detail c');
 lines.push('ℹ tests 302','ℹ pass 300','ℹ fail 2',...Array.from({length:45},(_,i)=>'tail '+i));
 const r=digestJob(job(lines.join('\n')));assert.ok(r.output_digest.trimmed);assert.equal(r.output_digest.failure_blocks,2);
 for(const s of ['first broken','FIRST_ASSERT','second broken','SECOND_ORIGINAL','ℹ tests 302','ℹ fail 2','tail 44'])assert.match(r.stdout,new RegExp(s));
});

test('TAP not ok + YAML 块认得出',()=>{
 const lines=Array.from({length:160},(_,i)=>'ok '+i);lines.splice(60,0,'not ok 3 - x','  ---','  message: TAP_ORIGINAL','  code: ERR_TEST_FAILURE','  stack: |','    where','  ...');lines.push(...Array.from({length:50},(_,i)=>'tail '+i));
 const r=digestJob(job(lines.join('\n')));assert.equal(r.output_digest.failure_blocks,1);assert.match(r.stdout,/not ok 3 - x/);assert.match(r.stdout,/TAP_ORIGINAL/);assert.match(r.stdout,/ERR_TEST_FAILURE/);
});

test('dot 报告 Failed tests 段认得出',()=>{
 const lines=Array.from({length:170},(_,i)=>'. filler '+i);lines.push('Failed tests:','','✖ dot broken (12ms)','  AssertionError [ERR_ASSERTION]: DOT_ORIGINAL','    at test.mjs:1:1',...Array.from({length:50},(_,i)=>'end '+i));
 const r=digestJob(job(lines.join('\n')));assert.ok(r.output_digest.failure_blocks>=1);assert.match(r.stdout,/Failed tests:/);assert.match(r.stdout,/dot broken/);assert.match(r.stdout,/DOT_ORIGINAL/);
});

test('full:true 原样返回全文',()=>{
 const x=job(Array.from({length:400},(_,i)=>'line '+i).join('\n')),r=digestJob(x,{full:true});assert.deepEqual(r,x);assert.equal(r.output_digest,undefined);
});

test('Tools command_result default excerpt and full original pages preserve all text; schema accepts full_cursor',async t=>{
 const {desktop}=await import('./1052-a-fixture.mjs'),f=await desktop(t),task_id=await f.begin();
 const expected=Array.from({length:300},(_,i)=>'queue '+i+' '+'.'.repeat(30)).join('\n');
 const j=f.ok(await f.rpc('propose_command',{task_id,request_id:'old-full-assertion',program:process.execPath,args:['-e',"process.stdout.write(Array.from({length:300},(_,i)=>'queue '+i+' '+'.'.repeat(30)).join('\\n'))"],wait_ms:1000}));
 const excerpt=f.ok(await f.rpc('command_result',{job_id:j.job_id}));assert.ok(excerpt.output_digest?.trimmed);assert.match(excerpt.stdout,/queue 299/);
 let cursor=null,all='',n=0;do{const raw=await f.rpc('command_result',{job_id:j.job_id,full:true,...(cursor?{full_cursor:cursor}:{})}),page=f.ok(raw);assert.ok(JSON.stringify(raw).length+70<=12000);all+=page.segments.map(x=>x.text).join('');cursor=page.next_full_cursor;n++;}while(cursor);
 assert.equal(all,expected);assert.ok(n>1);const def=TOOLS.find(x=>x.name==='command_result');assert.equal(def.inputSchema.properties.full.type,'boolean');assert.equal(def.inputSchema.properties.full_cursor.type,'string');assert.match(def.description,/full:true/);
});
