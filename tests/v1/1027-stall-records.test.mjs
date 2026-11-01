// 1027：停住记全（Ken 10/7：要查得到为什么停）。停之前最后几次调用花了多久、回了多少字、成没成；平时间隔；预报命中的词。
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {ResumeKeeper} from '../../app/v1/resume.mjs';import {forecastHits} from '../../app/v1/check-forecast.mjs';import vm from 'node:vm';import {installUiTextContext} from '../support/ui-text-context.mjs';

test('forecast hits name the words that made a call look security-heavy',()=>{
 assert.deepEqual(forecastHits('read_text',{path:'notes.md'},{content:'今天的会议纪要'}),[]);
 const hits=forecastHits('propose_command',{program:'node',args:['--test','tests/v1/admin-sudo.test.mjs']},{content:'sudo helper 管理员 权限 拦截'});
 for(const w of ['sudo','管理员','权限','拦截'])assert.ok(hits.includes(w),w);assert.ok(hits.length<=8);
 assert.ok(forecastHits('read_text',{path:'app/v1/update.mjs'}).includes('app/v1/update.mjs'));
});

test('a stall records the last calls with time taken, size returned and outcome, the usual gaps and the forecast words',()=>{
 let now=1_000_000;const r=new ResumeKeeper({now:()=>now}),h='a'.repeat(64);
 const call=(name,args,result,{ms=200,gap=30000,error=false}={})=>{now+=gap;r.before(h,name,args);now+=ms;r.after(h,name,args,result,error);};
 call('begin_task',{title:'修管理员规则'},{task_id:'task_1'},{gap:0});
 call('task_checkpoint',{task_id:'task_1',done:'读完调查',block:1,total:3},{recorded:true});r.checkpoint('task_1',{done:'读完调查',block:1,total:3});
 call('read_text',{task_id:'task_1',path:'app/v1/admin-command.mjs'},{content:'sudo -n helper --uninstall 管理员 权限'.repeat(40)},{ms:300,gap:45000});
 call('propose_command',{task_id:'task_1',program:'node',args:['--test','tests/v1/admin-sudo.test.mjs']},{status:'running'},{ms:42000,gap:60000});
 call('command_result',{task_id:'task_1',job_id:'j1'},null,{ms:1500,gap:20000,error:true});
 now+=20*60000;
 const v=r.stall({task_id:'task_1',status:'active',title:'修管理员规则',session_hash:h});assert.equal(v.stalled,true);
 const s=r.diagnostics().recent_stalls.at(-1);
 assert.equal(s.task_id,'task_1');assert.ok(s.quiet_ms>=20*60000);assert.ok(s.threshold_ms>0);assert.equal(s.last_block,1);assert.equal(s.checkpoints,1);
 assert.deepEqual(s.last_calls.map(c=>c.tool),['read_text','propose_command','command_result']);
 assert.deepEqual(s.last_calls.map(c=>c.ms),[300,42000,1500]);assert.deepEqual(s.last_calls.map(c=>c.ok),[true,true,false]);
 assert.ok(s.last_calls[0].bytes>1000,'size of what went back to ChatGPT');assert.equal(s.last_calls[2].bytes,0);
 assert.ok(s.gap_median_ms>0&&s.gap_longest_ms>=s.gap_median_ms);assert.ok(s.gap_count>=3);
 assert.ok(['maybe','likely'].includes(s.forecast));assert.ok(s.forecast_hits.includes('sudo'));
 assert.ok(s.last_steps.length>=1);assert.equal(s.resumed_at,null);
});

test('the forecast note asks for a purpose sentence and a narrow scope, never hiding content',()=>{
 let now=0;const r=new ResumeKeeper({now:()=>now}),h='b'.repeat(64);r.before(h,'begin_task',{});
 const note=r.after(h,'begin_task',{title:'修改 app/v06/sandbox.mjs 的超时'},{task_id:'task_2'});
 assert.equal(note.level,'maybe');assert.ok(note.zh.includes('为了防什么'));assert.ok(note.zh.includes('先 search_text 再读'));assert.ok(note.zh.includes('不要为了躲检查改写、拆开或藏起内容'));
 assert.ok(note.en.includes('purpose'));assert.ok(note.tell_user.includes('请发送「继续」，不要点击「重试」'));
});

test('task details show the stall log in plain words',()=>{
 const ui=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),start=ui.indexOf('let STALL_TOOL_WORDS='),end=ui.indexOf('\n/* 1026',start);
 assert.ok(ui.includes('+(stallRecords(t));'),'task details render stall records');assert.ok(start>=0&&end>start,'current stall renderer exists');
 const box={S:{resume:{recent_stalls:[{task_id:'task',at:1_000_000,last_calls:[{tool:'read_text',ok:false,ms:42000,bytes:1234}],gap_median_ms:30000,gap_longest_ms:60000,quiet_ms:120000,resumed_at:null,forecast:'likely',forecast_hits:['sudo']}] }},E:x=>String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),when:()=> 'fixture time'};
 vm.createContext(box);installUiTextContext(box);vm.runInContext(ui.slice(start,end),box);
 const html=vm.runInContext('stallRecords({task_id:"task"})',box);
 assert.match(html,/中断记录 · 1/);assert.match(html,/中断前：/);assert.match(html,/此对话中两次调用通常间隔/);assert.match(html,/sudo/);
});
