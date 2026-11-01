import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {ValueStats,estimateTextTokens,sampledTextTokens,countIO,imageSize,imageTokens,apiUSD,apiUSDExact,ioUSD,stepApiUSD,BASE_SYSTEM_TOKENS,REASON,COMPACT_TRIGGER,COMPACT_SUMMARY,CACHE_WEIGHT,workInputTokens,nextContextTokens,TOOL_CATEGORIES,toolCategory,WEEK_TOKENS,VALUE_ESTIMATORS,localDate} from '../../app/v1/value-stats.mjs';
import {Tools,TOOLS} from '../../app/tools.mjs';
import {TaskPolicy} from '../../app/policy.mjs';
import {sessionHashOf} from '../../app/v1/resume.mjs';
import {createDesktop} from '../../app/server.mjs';
import {t as translate} from '../../app/i18n.mjs';
import {createStateEvents,STATE_FIELD_GROUPS} from '../../app/v1/events.mjs';

// Fixed counts: tiktoken 0.14.0 / o200k_base, encode(text) on exactly these raw strings.
// Keep the original samples, o200k_base references and 10% threshold across formula changes.
const calibration = [
  {
    "name": "中文文档",
    "text": "工作量只在这台电脑上统计，只记录数字和日期，不记录对话内容、文件名、路径、命令、网址或窗口标题。每次调用先交回结果，再在后台数经过连接的内容，因此统计失败不会影响任务。实际往返内容与工作模式估算分开记录；前者包括发来的参数、交回的文字与截图，后者按同一个对话中已经完成的步骤累计。任务完成时保存数字回执，重复读取同一回执不会重复计入完成任务。取消、失败和等待批准都不能当作成功完成。\n设置页提供显示开关、订阅选择和清零入口。显示开关只影响顶部读数，关闭后仍保留统计。自动认不出订阅时按默认档位估算，也可以手动选择。清零只从现在重新累计，旧任务记录和已完成回执保持原样。近七天窗口按本机日期计算，跨月和跨年时连续取七天。每天的数据最多保存四百天，旧天数移除后累计仍然保留。\n界面始终写“约”，不能把估算说成实际消耗，也不能把本地检查当作真机验收。异常文件应当从零开始，写入采用临时文件再改名，保存失败只影响统计。事件流独立限制到每秒一次，任务输出仍按原速度更新。",
    "reference": 313
  },
  {
    "name": "英文文档",
    "text": "The local workload counter records numbers and dates without saving conversation content. A completed tool response is returned before token estimation starts. Errors in estimation or persistence must not change the response, the permission decision, or the operation receipt. The caller can continue working even when the optional statistics file is unavailable.\nA conversation accumulates the input and output from earlier tool steps. The estimated context is bounded before it is added to the next step, and reasoning is represented by a documented constant. Conversation identifiers remain in memory and expire after inactivity. Restarting the service preserves numeric totals while starting a fresh context estimate.\nTask ownership follows an explicit task identifier when present. Otherwise, the most recent ongoing task in the same conversation receives the numbers. Calls without an ongoing task still contribute to daily and lifetime totals. Finishing a task flushes completed observations before writing its receipt; reading the saved receipt again does not increase the completed task count.\nThe interface settings are persisted behind the existing owner and window credentials. Resetting the counter preserves old task receipts and subscription observations. A slow statistics update must never reduce the update frequency of command output. Tests use temporary state directories, synthetic account responses, bounded fake clocks, and fixed reference token counts.",
    "reference": 241
  },
  {
    "name": "JavaScript",
    "text": "export function summariseDaily(days, today) {\n  const totals = { input: 0, output: 0, calls: 0, tasks: 0 };\n  const dates = [];\n  for (let offset = -6; offset <= 0; offset++) {\n    const day = new Date(today);\n    day.setDate(day.getDate() + offset);\n    const key = day.toISOString().slice(0, 10);\n    const entry = days[key];\n    dates.push(key);\n    if (!entry) continue;\n    for (const field of Object.keys(totals)) {\n      totals[field] += Number.isFinite(entry[field]) ? entry[field] : 0;\n    }\n  }\n  return { dates, totals };\n}\n\nexport async function readOptionalStatus(server) {\n  try {\n    const response = await server.request('account/read', { refreshToken: false });\n    const plan = response.account?.planType;\n    return typeof plan === 'string' ? { plan } : { plan: null };\n  } catch {\n    return { plan: null };\n  } finally {\n    server.close();\n  }\n}\n\nexport function saveNumbers(file, totals) {\n  const temporary = file + '.tmp';\n  try {\n    writeFileSync(temporary, JSON.stringify(totals), { mode: 0o600 });\n    renameSync(temporary, file);\n  } finally {\n    try { unlinkSync(temporary); } catch { /* Optional cleanup. */ }\n  }\n}",
    "reference": 307
  },
  {
    "name": "JSON",
    "text": "{\n  \"format\": 4,\n  \"since\": 1790900000000,\n  \"lifetime\": {\n    \"io_in\": 123456,\n    \"io_out\": 23456,\n    \"work_in\": 7654321,\n    \"work_out\": 54321,\n    \"tasks\": 12,\n    \"calls\": {\n      \"all\": 96,\n      \"read\": 30,\n      \"write\": 12,\n      \"command\": 18,\n      \"browser\": 20,\n      \"desktop\": 8,\n      \"other\": 8\n    }\n  },\n  \"daily\": {\n    \"2026-09-21\": {\n      \"io_in\": 25914,\n      \"io_out\": 4914,\n      \"work_in\": 907410,\n      \"work_out\": 16569,\n      \"tasks\": 0,\n      \"calls\": {\n        \"all\": 42,\n        \"read\": 21,\n        \"write\": 1,\n        \"command\": 1,\n        \"browser\": 3,\n        \"desktop\": 1,\n        \"other\": 2\n      }\n    },\n    \"2026-09-22\": {\n      \"io_in\": 27148,\n      \"io_out\": 5148,\n      \"work_in\": 950620,\n      \"work_out\": 17358,\n      \"tasks\": 1,\n      \"calls\": {\n        \"all\": 44,\n        \"read\": 22,\n        \"write\": 2,\n        \"command\": 2,\n        \"browser\": 4,\n        \"desktop\": 0,\n        \"other\": 2\n      }\n    },\n    \"2026-09-23\": {\n      \"io_in\": 28382,\n      \"io_out\": 5382,\n      \"work_in\": 993830,\n      \"work_out\": 18147,\n      \"tasks\": 2,\n      \"calls\": {\n        \"all\": 46,\n        \"read\": 23,\n        \"write\": 3,\n        \"command\": 3,\n        \"browser\": 5,\n        \"desktop\": 1,\n        \"other\": 2\n      }\n    },\n    \"2026-09-24\": {\n      \"io_in\": 29616,\n      \"io_out\": 5616,\n      \"work_in\": 1037040,\n      \"work_out\": 18936,\n      \"tasks\": 0,\n      \"calls\": {\n        \"all\": 48,\n        \"read\": 24,\n        \"write\": 4,\n        \"command\": 0,\n        \"browser\": 0,\n        \"desktop\": 0,\n        \"other\": 2\n      }\n    },\n    \"2026-09-25\": {\n      \"io_in\": 30850,\n      \"io_out\": 5850,\n      \"work_in\": 1080250,\n      \"work_out\": 19725,\n      \"tasks\": 1,\n      \"calls\": {\n        \"all\": 50,\n        \"read\": 25,\n        \"write\": 0,\n        \"command\": 1,\n        \"browser\": 1,\n        \"desktop\": 1,\n        \"other\": 2\n      }\n    },\n    \"2026-09-26\": {\n      \"io_in\": 32084,\n      \"io_out\": 6084,\n      \"work_in\": 1123460,\n      \"work_out\": 20514,\n      \"tasks\": 2,\n      \"calls\": {\n        \"all\": 52,\n        \"read\": 26,\n        \"write\": 1,\n        \"command\": 2,\n        \"browser\": 2,\n        \"desktop\": 0,\n        \"other\": 2\n      }\n    },\n    \"2026-09-27\": {\n      \"io_in\": 33318,\n      \"io_out\": 6318,\n      \"work_in\": 1166670,\n      \"work_out\": 21303,\n      \"tasks\": 0,\n      \"calls\": {\n        \"all\": 54,\n        \"read\": 27,\n        \"write\": 2,\n        \"command\": 3,\n        \"browser\": 3,\n        \"desktop\": 1,\n        \"other\": 2\n      }\n    },\n    \"2026-09-28\": {\n      \"io_in\": 34552,\n      \"io_out\": 6552,\n      \"work_in\": 1209880,\n      \"work_out\": 22092,\n      \"tasks\": 1,\n      \"calls\": {\n        \"all\": 56,\n        \"read\": 28,\n        \"write\": 3,\n        \"command\": 0,\n        \"browser\": 4,\n        \"desktop\": 0,\n        \"other\": 2\n      }\n    },\n    \"2026-09-29\": {\n      \"io_in\": 35786,\n      \"io_out\": 6786,\n      \"work_in\": 1253090,\n      \"work_out\": 22881,\n      \"tasks\": 2,\n      \"calls\": {\n        \"all\": 58,\n        \"read\": 29,\n        \"write\": 4,\n        \"command\": 1,\n        \"browser\": 5,\n        \"desktop\": 1,\n        \"other\": 2\n      }\n    }\n  },\n  \"probe\": {\n    \"plan\": \"plus\",\n    \"week_tokens\": 120000000,\n    \"calibrated_at\": 1790900000000\n  }\n}",
    "reference": 1178
  },
  {
    "name": "命令输出",
    "text": "TAP version 13\n# Subtest: completed observations are saved before a task receipt\nok 1 - completed observations are saved before a task receipt\n  ---\n  duration_ms: 32.142\n  type: test\n  ...\n# Subtest: a replayed receipt does not increase successful tasks\nok 2 - a replayed receipt does not increase successful tasks\n  ---\n  duration_ms: 18.907\n  type: test\n  ...\n# Subtest: unknown tools count as other and failed calls retain token totals\nok 3 - unknown tools count as other and failed calls retain token totals\n  ---\n  duration_ms: 6.055\n  type: test\n  ...\n# Subtest: owner credentials are required for reset and settings\nok 4 - owner credentials are required for reset and settings\n  ---\n  duration_ms: 1065.913\n  type: test\n  ...\n# Subtest: writing a statistics file cannot delay the original response\nok 5 - writing a statistics file cannot delay the original response\n  ---\n  duration_ms: 8.105\n  type: test\n  ...\n1..5\n# tests 5\n# suites 0\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1201.122",
    "reference": 284
  }
];
for (const sample of calibration) test(`o200k_base ±10%: ${sample.name}`,()=>{
  const estimated=estimateTextTokens(sample.text),error=Math.abs(estimated/sample.reference-1);
  assert.ok(error<=0.10,`reference=${sample.reference}, estimate=${estimated}, deviation=${((estimated/sample.reference-1)*100).toFixed(2)}%`);
});

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-value-'));const stats=new ValueStats({stateDir:dir,tools:TOOLS,...options});t.after(()=>{stats.close();fs.rmSync(dir,{recursive:true,force:true});});return {stats,dir};}
const result=text=>({content:[{type:'text',text}],structuredContent:{text},isError:false});
function call(stats,name='read_text',options={}){stats.enqueue({name,args:{},result:result('text'),session:'synthetic-session',...options});stats.drain();}
function png(width,height){const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IHDR',12);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b.toString('base64');}

test('tool category table covers the complete current manifest; unknown prefix tools stay other',()=>{
 assert.deepEqual(Object.keys(TOOL_CATEGORIES).sort(),TOOLS.map(tool=>tool.name).sort());
 assert.equal(TOOL_CATEGORIES.command_result,'other');assert.equal(TOOL_CATEGORIES.command_input,'command');
 assert.equal(TOOL_CATEGORIES.run_capability,'other','generic entry uses its actual operation when known');
 assert.equal(Object.hasOwn(TOOL_CATEGORIES,'request_permission'),false);
 assert.equal(TOOL_CATEGORIES.task_stop,'other','task lifecycle is not a shell command');
 assert.equal(TOOL_CATEGORIES.relay_card_control,'other','card control is not a normal command');
 assert.equal(TOOLS.find(tool=>tool.name==='relay_card_control')?._meta?.['openai/visibility'],'private','classification does not expose the app-only tool');
});
test('text content and structuredContent are counted once, with structured fallback',()=>{
 const structured={payload:'alpha beta 123'};const text=JSON.stringify(structured);
 assert.equal(countIO({}, {content:[{type:'text',text}],structuredContent:structured}).io_in,estimateTextTokens(text));
 assert.equal(countIO({}, {content:[],structuredContent:structured}).io_in,estimateTextTokens(text));
 assert.equal(countIO({}, {content:[{type:'text',text:''}],structuredContent:structured}).io_in,estimateTextTokens(text));
});
test('extra capability calls count once in the category of the executed operation',t=>{
 const {stats}=fixture(t);
 const step=tool=>({capability:'execute_task_step',parameters:{tool}});
 for(const [tool,category] of [['read_text','read'],['write_text','write'],['propose_command','command'],['browser_action','browser'],['computer_action','desktop']]){
  assert.equal(toolCategory('run_capability',step(tool),result('completed')),category);
  call(stats,'run_capability',{args:step(tool)});
  assert.equal(stats.snapshot().last7.calls[category],1);
 }
 call(stats,'run_capability',{args:{capability:'contract_status'}});
 assert.equal(stats.snapshot().last7.calls.read,2);
 for(const args of [{capability:'unregistered'},{capability:'read_unregistered'},{capability:'execute_task_step',parameters:{tool:'unregistered'}}]){
  assert.equal(toolCategory('run_capability',args,result('completed')),'other');
 }
 call(stats,'run_capability',{args:step('write_text'),result:{...result('discovery'),structuredContent:{discovery:true,executed:false}}});
 call(stats,'run_capability',{args:step('write_text'),result:{...result('failed'),isError:true}});
 assert.equal(stats.snapshot().last7.calls.write,1,'discovery and failed calls cannot claim an executed write');
 const calls=stats.snapshot().last7.calls;assert.equal(calls.other,1);assert.equal(calls.all,7);
 assert.equal(Object.entries(calls).filter(([key])=>key!=='all').reduce((sum,[,n])=>sum+n,0),calls.all);
});
test('PNG and JPEG dimensions, unknown image fallback and text-plus-image counting',()=>{
 assert.deepEqual(imageSize(png(1280,800)),{width:1280,height:800});assert.equal(imageTokens({data:png(1280,800)}),1105);
 assert.equal(imageTokens({data:png(100,100)}),255);assert.equal(imageTokens({data:'invalid'}),1105);
 const jpeg=Buffer.from([255,216,255,192,0,11,8,3,32,5,0,1,1,17,0,255,217]).toString('base64');
 assert.deepEqual(imageSize(jpeg),{width:1280,height:800});assert.equal(imageTokens({data:jpeg}),1105);
 assert.equal(countIO({}, {content:[{type:'text',text:'hello'},{type:'image',data:png(1280,800)}]}).io_in,1105+estimateTextTokens('hello'));
 assert.equal(imageTokens({data:png(4096,4096)}),765);
});
test('large text sampling and single-call input/output limits',()=>{
 const text='a_long_word 123456789 '.repeat(100_000);const short='a_long_word 123456789 '.repeat(1000);
 assert.ok(Math.abs(sampledTextTokens(text)/estimateTextTokens(short)/100-1)<0.01);
 const counts=countIO({payload:text},{content:[{type:'text',text}]});assert.deepEqual(counts,{io_in:100_000,io_out:20_000});
});
test('successful and erroneous calls both count tokens; only successes count calls',t=>{
 const {stats}=fixture(t);call(stats);const first=stats.snapshot().last7;call(stats,'write_text',{result:{...result('failure'),isError:true}});const after=stats.snapshot().last7;
 assert.equal(after.calls.all,1);assert.equal(after.calls.read,1);assert.equal(after.calls.write,0);assert.ok(after.work>first.work);assert.ok(after.io.in>first.io.in);
 call(stats,'browser_future');assert.equal(stats.snapshot().last7.calls.other,1);
});
test('Work input discounts re-read context and separates different conversations',t=>{
 const {stats}=fixture(t),io=countIO({},result('text')),added=io.io_in+io.io_out,first=workInputTokens(stats.base,0,io.io_in),second=workInputTokens(stats.base,nextContextTokens(0,added),io.io_in);call(stats);call(stats);call(stats,'read_text',{session:'other-session'});
 assert.equal(stats.data.lifetime.work_in,first+second+first);assert.equal(stats.data.lifetime.work_out,3*(io.io_out+REASON));
 assert.equal(stats.base,estimateTextTokens(JSON.stringify(TOOLS))+BASE_SYSTEM_TOKENS);assert.equal(CACHE_WEIGHT,.25);
});
test('500-call task compacts past 258k, resumes from 25k, and is materially smaller than the 1019 formula',t=>{
 const {stats}=fixture(t),payload=result('alphabet '.repeat(700)),io=countIO({},payload),added=io.io_in+io.io_out,deltas=[],id=crypto.randomUUID();let oldContext=0,oldWork=0;
 call(stats,'begin_task',{result:{...result('created'),structuredContent:{task_id:id}}});const baseline=stats.snapshot().lifetime.legacy_work;
 for(let n=0;n<500;n++){const before=stats.snapshot().lifetime.legacy_work;call(stats,'read_text',{result:payload});deltas.push(stats.snapshot().lifetime.legacy_work-before);oldWork+=stats.base+Math.min(oldContext,200_000)+io.io_out+REASON;oldContext+=added;}
 const newer=stats.snapshot().lifetime.legacy_work-baseline;assert.ok(newer<oldWork*.6,`legacy=${newer}, old=${oldWork}`);assert.ok(deltas.some((v,i)=>i>0&&v<deltas[i-1]*.7),'expected a visible compaction drop');
 const context=stats.taskContexts.get(id);assert.ok(context>=COMPACT_SUMMARY&&context<=COMPACT_TRIGGER);assert.equal(nextContextTokens(COMPACT_TRIGGER,1),COMPACT_SUMMARY);assert.ok(new Set(deltas.slice(-30)).size>3,'context should keep growing after compaction instead of staying capped');
});
test('missing sessions reuse the last conversation within 30 minutes and start again afterwards',t=>{
 let now=Date.now();const {stats}=fixture(t,{now:()=>now});call(stats,'read_text',{session:'known'});const firstIO=stats.data.lifetime.io_in+stats.data.lifetime.io_out;
 const io=countIO({},result('text'));now+=29*60_000;const before=stats.data.lifetime.work_in;call(stats,'read_text',{session:undefined});assert.equal(stats.data.lifetime.work_in-before,workInputTokens(stats.base,firstIO,io.io_in));
 now+=30*60_000+1;const later=stats.data.lifetime.work_in;call(stats,'read_text',{session:undefined});assert.equal(stats.data.lifetime.work_in-later,workInputTokens(stats.base,0,io.io_in));
});
test('conversation memory is limited to 200 entries and expires after 24 hours',t=>{
 let now=Date.now();const {stats}=fixture(t,{now:()=>now});for(let i=0;i<210;i++)call(stats,'read_text',{session:'session-'+i});assert.equal(stats.contexts.size,200);
 now+=24*60*60_000+1;call(stats,'read_text',{session:'new'});assert.equal(stats.contexts.size,1);
});
test('Work context estimate and API cached pricing remain the main display basis',t=>{
 assert.equal(apiUSD({io_in:1_000_000,work_in:11_000_000,work_out:2_000_000}),23);
 const {stats}=fixture(t),io=countIO({},result('text')),discounted=workInputTokens(stats.base,0,io.io_in);call(stats);const snap=stats.snapshot(),legacy=Number(stepApiUSD(stats.base,0,io).toFixed(2));assert.equal(snap.last7.usd,legacy);assert.equal(snap.last7.work,discounted+io.io_out+REASON);assert.equal(snap.last7.legacy_work,discounted+io.io_out+REASON);assert.equal(snap.last7.legacy_usd,legacy);assert.ok(stepApiUSD(stats.base,0,io)>=apiUSD({io_in:io.io_in,work_in:discounted,work_out:io.io_out+REASON}));
});
test('format-4 IO-era labels restore original work/API display without rewriting numeric history',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-value-legacy-')),now=Date.now(),date=localDate(now),calls={all:2,read:2,write:0,command:0,browser:0,desktop:0,other:0},old={io_in:10_000,io_out:1_000,work_in:100_000,work_out:5_000,tasks:1,calls};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'value-stats.json'),JSON.stringify({format:4,since:now-1000,lifetime:old,daily:{[date]:old},probe:{plan:null,calibrated_at:null}}));
 let stats=new ValueStats({stateDir:dir,tools:TOOLS,now:()=>now});const before=stats.snapshot();assert.equal(before.lifetime.work,105_000);assert.equal(before.lifetime.legacy_work,105_000);assert.equal(before.lifetime.usd,apiUSD(old));assert.equal(before.lifetime.legacy_usd,apiUSD(old));assert.deepEqual(before.estimators,VALUE_ESTIMATORS);assert.equal(stats.data.lifetime.work_in,old.work_in);assert.equal(stats.data.lifetime.work_out,old.work_out);
 const io=countIO({},result('text')),legacyInput=workInputTokens(stats.base,0,io.io_in);call(stats);const after=stats.snapshot();assert.equal(after.lifetime.work,old.work_in+old.work_out+legacyInput+io.io_out+REASON);assert.equal(after.lifetime.legacy_work,old.work_in+old.work_out+legacyInput+io.io_out+REASON);assert.equal(after.lifetime.legacy_usd,Number((apiUSDExact(old)+stepApiUSD(stats.base,0,io)).toFixed(2)));
 stats.close();stats=new ValueStats({stateDir:dir,tools:TOOLS,now:()=>now});assert.equal(stats.snapshot().lifetime.work,after.lifetime.work);assert.equal(stats.snapshot().lifetime.legacy_work,after.lifetime.legacy_work);assert.equal(stats.snapshot().lifetime.usd,after.lifetime.usd);assert.equal(stats.snapshot().lifetime.legacy_usd,after.lifetime.legacy_usd);const saved=JSON.parse(fs.readFileSync(path.join(dir,'value-stats.json')));assert.equal(saved.format,4);assert.deepEqual(saved.estimators,VALUE_ESTIMATORS);assert.ok(saved.api);stats.close();fs.rmSync(dir,{recursive:true,force:true});
});
test('restoring IO-era format 4/5 labels keeps work, IO, API and every summary without reset',t=>{
 const now=Date.now(),date=localDate(now),calls={all:2,read:2,write:0,command:0,browser:0,desktop:0,other:0};
 const old={io_in:10000,io_out:1000,work_in:100000,work_out:5000,tasks:1,calls};
 const oldLabels={main:'tool-io-v1',legacy_work:'work-v4',main_usd:'tool-io-price-v1',legacy_usd:'api-v4'};
 for(const format of [4,5]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-restore-work-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'value-stats.json'),saved={format,since:now-1000,lifetime:old,daily:{[date]:old},api:{lifetime:1,daily:{[date]:1}},probe:{plan:'pro_5x',calibrated_at:null},estimators:oldLabels};
  fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600});const stats=new ValueStats({stateDir:dir,now:()=>now});
  stats.active.set('fixture-task',{...old,calls:2});const snap=stats.snapshot();
  assert.equal(snap.last7.work,105000);assert.equal(snap.lifetime.work,105000);assert.equal(snap.last7.share,105000/600000000*100);assert.equal(snap.last7.usd,1);
  assert.equal(snap.daily.find(d=>d.date===date).work,105000);assert.equal(snap.active['fixture-task'].work,105000);assert.equal(stats.receiptValue('fixture-task').work,105000);
  assert.deepEqual(snap.last7.io,{in:10000,out:1000});assert.equal(snap.estimators.main,'work-v4');assert.equal(snap.estimators.main_usd,'api-v4');assert.equal(snap.since,saved.since);
  stats.close();const restored=JSON.parse(fs.readFileSync(file));assert.equal(restored.format,4);assert.deepEqual(restored.lifetime,old);assert.deepEqual(restored.daily,saved.daily);assert.deepEqual(restored.api,saved.api);assert.equal(restored.since,saved.since);assert.deepEqual(restored.estimators,VALUE_ESTIMATORS);
 }
});
test('quota table follows automatic plans, defaults unknown plans to Plus, and manual choice wins',t=>{
 const {stats}=fixture(t);call(stats);assert.equal(stats.snapshot().plan.source,'default');assert.equal(stats.snapshot().plan.id,'plus');
 assert.equal(stats.snapshot().quota.source,'table');assert.equal(stats.snapshot().quota.week_tokens,WEEK_TOKENS.plus);
 stats.setProbe({plan:'pro_5x',week_tokens:1,calibrated_at:Date.now()});assert.deepEqual(stats.snapshot().plan,{id:'pro_5x',name:'Pro 5x',source:'auto'});assert.equal(stats.snapshot().quota.week_tokens,WEEK_TOKENS.pro_5x);
 stats.setProbe({plan:'pro_20x',week_tokens:1,calibrated_at:Date.now()});assert.equal(stats.snapshot().quota.week_tokens,WEEK_TOKENS.pro_20x);
 const state=stats.snapshot({value_plan:'pro_5x',show_value:false});assert.equal(state.show,false);assert.equal(state.plan.source,'setting');assert.equal(state.plan.id,'pro_5x');assert.equal(state.quota.source,'table');assert.equal(state.quota.week_tokens,WEEK_TOKENS.pro_5x);assert.equal(state.last7.share,state.last7.work/WEEK_TOKENS.pro_5x*100);assert.deepEqual(state.quota.week_tokens_by_plan,WEEK_TOKENS);
 stats.setProbe({plan:null,week_tokens:999_000_000,calibrated_at:Date.now()});assert.equal(stats.snapshot().quota.week_tokens,WEEK_TOKENS.plus);assert.equal(stats.snapshot().quota.source,'table');
});
test('legacy calibrated quota is ignored and its saved field is cleared on flush without new calls',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-value-quota-migrate-')),now=Date.now(),date=localDate(now),calls={all:2,read:2,write:0,command:0,browser:0,desktop:0,other:0},old={io_in:10_000,io_out:1_000,work_in:100_000,work_out:5_000,tasks:1,calls};fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'value-stats.json'),JSON.stringify({format:4,since:now-1000,lifetime:old,daily:{[date]:old},api:{lifetime:1,daily:{[date]:1}},probe:{plan:'pro_5x',week_tokens:900_000_000,calibrated_at:now-1000}}));
 const stats=new ValueStats({stateDir:dir,tools:TOOLS,now:()=>now});assert.equal(stats.dirty,true);assert.equal(stats.snapshot().lifetime.work,105_000);assert.equal(stats.snapshot().lifetime.legacy_work,105_000);assert.equal(stats.snapshot().quota.week_tokens,WEEK_TOKENS.pro_5x);assert.equal(stats.snapshot().quota.source,'table');assert.equal(stats.snapshot().last7.share,105_000/WEEK_TOKENS.pro_5x*100);assert.equal(stats.snapshot().lifetime.legacy_usd,1);
 assert.equal(stats.flush(),true);const saved=JSON.parse(fs.readFileSync(path.join(dir,'value-stats.json'),'utf8'));assert.equal(saved.format,4);assert.deepEqual(saved.estimators,VALUE_ESTIMATORS);assert.equal(Object.hasOwn(saved.probe,'week_tokens'),false);assert.equal(saved.lifetime.work_in,old.work_in);assert.equal(saved.lifetime.work_out,old.work_out);assert.equal(saved.api.lifetime,1);stats.close();fs.rmSync(dir,{recursive:true,force:true});
});
test('home card and workload summary show quota basis and follow plan changes',()=>{
 const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),helpers=source.slice(source.indexOf('const valueNumber='),source.indexOf('function valueSettings(')),pg=source.slice(source.indexOf('function pgUsage(){'),source.indexOf('/* 1030：数字动画'));
 const ctx={T:(key,params)=>translate(key,params,'zh'),TH:(key,params)=>translate(key,params,'zh'),S:{value:null},E:x=>String(x),icon:()=>'',formatTokens:n=>Math.round(n/1e8*10)/10+' 亿',formatValueUSD:()=>'',pad:n=>String(n).padStart(2,'0'),valueHeatHTML:()=>'',valueSettings:()=>''};vm.createContext(ctx);vm.runInContext(helpers+'\n'+pg,ctx);
 for(const [plan,name,sourceType,quota,note] of [['pro_5x','Pro 5x','auto',600_000_000,'按 Pro 5x 计算，100% ≈ 6 亿 token'],['pro_20x','Pro 20x','auto',2_400_000_000,'按 Pro 20x 计算，100% ≈ 24 亿 token'],['plus','Plus','default',120_000_000,'未识别订阅，按 Plus 计算，100% ≈ 1.2 亿 token']]){
  ctx.S.value={show:true,plan:{id:plan,name,source:sourceType},quota:{week_tokens:quota},last7:{work:1_000_000,share:1,calls:{}},lifetime:{work:1_000_000,tasks:0},daily:[],since:0};
  assert.ok(vm.runInContext('valueHeaderHTML()',ctx).includes(note),`home card: ${note}`);assert.ok(vm.runInContext('pgUsage()',ctx).includes(note),`workload summary: ${note}`);
 }
});
test('explicit task_id wins; calls without it follow the most recent task of that conversation',t=>{
 const {stats}=fixture(t),a=crypto.randomUUID(),b=crypto.randomUUID();call(stats,'begin_task',{result:{...result('created'),structuredContent:{task_id:a}}});call(stats);call(stats,'begin_task',{result:{...result('created'),structuredContent:{task_id:b}}});call(stats);call(stats,'read_text',{args:{task_id:a}});
 assert.equal(stats.snapshot().active[a].calls,3);assert.equal(stats.snapshot().active[b].calls,2);
 call(stats,'read_text',{session:'not-a-task'});assert.equal(Object.keys(stats.snapshot().active).length,2);assert.equal(stats.snapshot().last7.calls.all,6);
});
test('reset keeps ongoing conversation ownership while resetting context and active counters; begin replay does not replace the newest task',t=>{
 const {stats}=fixture(t),a=crypto.randomUUID(),b=crypto.randomUUID();call(stats,'begin_task',{result:{...result('created'),structuredContent:{task_id:a}}});call(stats,'begin_task',{result:{...result('created'),structuredContent:{task_id:b}}});call(stats,'begin_task',{result:{...result('replayed'),structuredContent:{task_id:a,replayed:true}}});call(stats);
 assert.equal(stats.snapshot().active[b].calls,3);assert.equal(stats.snapshot().active[a].calls,1);stats.reset();assert.deepEqual(stats.snapshot().active,{});call(stats);assert.equal(stats.snapshot().active[b].calls,1);{const io=countIO({},result('text'));assert.equal(stats.snapshot().active[b].work,workInputTokens(stats.base,0,io.io_in)+io.io_out+REASON);assert.equal(stats.snapshot().active[b].legacy_work,workInputTokens(stats.base,0,io.io_in)+io.io_out+REASON);}assert.equal(stats.snapshot().active[a],undefined);
});
for(const boundary of [new Date(2027,0,3).getTime(),new Date(2026,9,3).getTime()])test(`last7 crosses calendar boundaries ${localDate(boundary)}`,t=>{
 let now=boundary-8*86_400_000;const {stats}=fixture(t,{now:()=>now});for(let i=0;i<9;i++){call(stats);now+=86_400_000;}now=boundary;
 assert.equal(stats.snapshot().last7.calls.all,7);assert.equal(stats.snapshot().lifetime.work,stats.data.lifetime.work_in+stats.data.lifetime.work_out);assert.equal(stats.snapshot().lifetime.legacy_work,stats.data.lifetime.work_in+stats.data.lifetime.work_out);
 assert.equal(stats.snapshot().daily.length,182);assert.equal(stats.snapshot().daily.at(-1).date,localDate(boundary));
});
test('daily retains at most 400 local days without reducing lifetime',t=>{
 let now=new Date(2025,0,1).getTime();const {stats}=fixture(t,{now:()=>now});for(let i=0;i<410;i++){call(stats);now+=86_400_000;}
 assert.equal(Object.keys(stats.data.daily).length,400);assert.equal(stats.data.lifetime.calls.all,410);assert.equal(stats.snapshot().last7.calls.all,6);
});
test('saved numeric file contains no payloads, sessions, meta/header values or account details',t=>{
 const {stats,dir}=fixture(t);call(stats,'propose_command',{args:{task_id:crypto.randomUUID(),path:'/sensitive/filename-secret',command:'secret-command',url:'https://secret.invalid',text:'secret-task-title'},result:result('secret-window-title secret@example.invalid'),session:'secret-session-id',metaKeys:['openai/session','model'],headerNames:['authorization','x-secret-header']});
 stats.setProbe({plan:'plus',week_tokens:120_000_000,calibrated_at:Date.now(),email:'secret@example.invalid'});stats.flush();const file=fs.readFileSync(path.join(dir,'value-stats.json'),'utf8');
 assert.doesNotMatch(file,/sensitive|secret|https:|authorization|openai\/session|email/);assert.equal(fs.statSync(path.join(dir,'value-stats.json')).mode&0o777,0o600);const saved=JSON.parse(file);assert.deepEqual(Object.keys(saved),['format','since','lifetime','daily','api','probe','estimators']);assert.equal(saved.format,4);assert.deepEqual(saved.estimators,VALUE_ESTIMATORS);assert.ok(Number.isFinite(saved.api.lifetime));assert.ok(Object.values(saved.api.daily).every(Number.isFinite));
 assert.deepEqual(stats.snapshot().probe,{meta_keys:['openai/session','model'],header_names:['authorization','x-secret-header']});
});
test('probe name sets are capped at 50 and not persisted',t=>{
 const {stats}=fixture(t);call(stats,'read_text',{metaKeys:Array.from({length:90},(_,i)=>'key'+i),headerNames:Array.from({length:90},(_,i)=>'x-key-'+i)});assert.equal(stats.snapshot().probe.meta_keys.length,50);assert.equal(stats.snapshot().probe.header_names.length,50);
});
test('restart persists totals; deleting the numeric file starts from zero',t=>{
 const {stats,dir}=fixture(t);call(stats);stats.close();const restored=new ValueStats({stateDir:dir,tools:TOOLS});assert.equal(restored.snapshot().last7.calls.all,1);assert.equal(restored.contexts.size,0);restored.close();fs.unlinkSync(path.join(dir,'value-stats.json'));const fresh=new ValueStats({stateDir:dir});assert.equal(fresh.snapshot().lifetime.work,0);fresh.close();
});
for(const content of ['invalid json','{"format":3,"since":123}','{"format":99,"since":123}'])test(`unrecognised/broken statistics never throw: ${content}`,t=>{
 const {dir}=fixture(t);fs.writeFileSync(path.join(dir,'value-stats.json'),content);const stats=new ValueStats({stateDir:dir});assert.equal(stats.snapshot().lifetime.work,0);call(stats);stats.close();
});
test('writing failures never change calls; reset failure keeps numeric totals',t=>{
 const {stats}=fixture(t,{writeFile:()=>{throw Error('write failed');}});call(stats);const before=stats.snapshot().lifetime.work;assert.equal(stats.flush(),false);assert.throws(()=>stats.reset(),{code:'VALUE_RESET_FAILED'});assert.equal(stats.snapshot().lifetime.work,before);call(stats);assert.ok(stats.snapshot().lifetime.work>before);
});
test('numeric writes merge for five seconds and close flushes once',t=>{
 let now=100_000,scheduled,cleared=0,writes=0;const {stats}=fixture(t,{now:()=>now,setTimer:(fn,delay)=>{scheduled={fn,delay};return 1;},clearTimer:()=>cleared++,writeFile:()=>writes++});
 call(stats);call(stats);assert.equal(scheduled.delay,5000);assert.equal(writes,0);now+=5000;scheduled.fn();assert.equal(writes,1);call(stats);assert.equal(scheduled.delay,5000);stats.close();assert.equal(writes,2);assert.equal(cleared,1);
});

function taskRPC(t){
 const {stats,dir}=fixture(t),state={data:{mode:'auto',active:'synthetic-project',auto_approve_tasks:true,conversations:[]},save(){}},store={stateDir:dir,root:dir,paused:false,audit(){}};
 const queue={jobs:new Map(),inputs:new Map(),cancel(){},cancelAll(){},get(){throw Error('unexpected job');}},policy=new TaskPolicy(state,store,queue);policy.enabled=true;policy.valueStats=stats;stats.getTask=id=>policy.tasks.get(id);
 const tools=Object.assign(Object.create(Tools.prototype),{store,policy,trace:null,valueStats:stats,invoke:async(name,args,caller,context)=>{if(name==='begin_task')return policy.begin(args,caller,{session_hash:sessionHashOf(context.setupPrincipal,context.session)});if(name==='finish_task')return policy.finish(args.task_id,caller,args.success??true);if(name==='read_text'&&args.path==='synthetic_failure')throw Object.assign(Error('synthetic failure'),{code:'SYNTHETIC'});return {payload:'synthetic completed text'};}});
 let serial=0;const rpc=(name,args={})=>tools.rpc({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':'synthetic-session'}}},'chatgpt',{setupPrincipal:'synthetic-task-principal'});return {stats,dir,policy,rpc};
}
test('tools/call estimation starts after response, including the error return path',async t=>{
 const {stats,rpc}=taskRPC(t);await rpc('read_text');assert.equal(stats.data.lifetime.calls.all,0);await turn();assert.equal(stats.data.lifetime.calls.all,1);const before=stats.snapshot().lifetime.work;const failure=await rpc('read_text',{path:'synthetic_failure'});assert.equal(failure.result.isError,true);assert.equal(stats.snapshot().lifetime.work,before);await turn();assert.ok(stats.snapshot().lifetime.work>before);assert.equal(stats.data.lifetime.calls.all,1);
});
test('finish receipt flushes all prior completed calls, while replay never increments completed tasks',async t=>{
 const {stats,rpc,policy}=taskRPC(t);const begin=await rpc('begin_task',{request_id:'synthetic_begin',title:'synthetic task'}),id=begin.result.structuredContent.task_id;await rpc('read_text');
 const finished=await rpc('finish_task',{task_id:id});assert.equal(finished.result.structuredContent.value.calls,2);assert.ok(finished.result.structuredContent.value.work>0);const receipt=policy.receipts.read(id,'chatgpt').result;assert.deepEqual(receipt.value,finished.result.structuredContent.value);
 stats.drain();assert.equal(stats.data.lifetime.tasks,1);const replay=await rpc('finish_task',{task_id:id});assert.equal(replay.result.structuredContent.replayed,true);stats.drain();assert.equal(stats.data.lifetime.tasks,1);assert.equal(stats.active.size,0);
 const before=structuredClone(receipt.value);stats.setProbe({plan:'pro_5x',week_tokens:600_000_000,calibrated_at:Date.now()});stats.reset();assert.deepEqual(policy.receipts.read(id,'chatgpt').result.value,before);assert.equal(stats.data.probe.plan,'pro_5x');assert.equal(stats.snapshot().lifetime.work,0);
});
test('failed and cancelled tasks do not count completed tasks; cancellation keeps prior numeric receipt',async t=>{
 const {stats,rpc,policy}=taskRPC(t);const first=await rpc('begin_task',{request_id:'synthetic_fail',title:'failed task'});await rpc('finish_task',{task_id:first.result.structuredContent.task_id,success:false});stats.drain();assert.equal(stats.data.lifetime.tasks,0);
 const next=await rpc('begin_task',{request_id:'synthetic_cancel',title:'cancelled task'}),id=next.result.structuredContent.task_id;await rpc('read_text');const receipt=policy.revokeTask(policy.get(id),'cancelled');assert.equal(receipt.value.calls,2);assert.equal(stats.data.lifetime.tasks,0);assert.equal(stats.active.size,0);assert.throws(()=>policy.finish(id,'chatgpt',true),{code:'TASK_CANCELLED'});
});
test('notifications, initialize, tools/list and ping never count',async t=>{
 const {stats,rpc}=taskRPC(t);const tools=Object.assign(Object.create(Tools.prototype),{trace:null,valueStats:stats});for(const method of ['initialize','tools/list','ping'])await tools.rpc({jsonrpc:'2.0',id:method,method});await tools.rpc({jsonrpc:'2.0',method:'tools/call',params:{name:'read_text'}});await turn();assert.equal(stats.snapshot().lifetime.work,0);
});

class Clock{time=0;serial=0;timers=new Map();now=()=>this.time;setTimeout=(fn,ms)=>this.add(fn,ms,false);setInterval=(fn,ms)=>this.add(fn,ms,true);clearTimeout=id=>this.timers.delete(id);clearInterval=id=>this.timers.delete(id);add(fn,ms,repeat){const id=++this.serial;this.timers.set(id,{fn,at:this.time+ms,ms,repeat});return id;}async advance(ms){const end=this.time+ms;for(;;){const found=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!found)break;const [id,t]=found;this.time=t.at;if(t.repeat)t.at+=t.ms;else this.timers.delete(id);await t.fn();}this.time=end;}}
test('value SSE patches are at most 1Hz while jobs retain 4Hz, with latest values and cleanup',async t=>{
 assert.ok(STATE_FIELD_GROUPS.jobs.includes('value'));const clock=new Clock(),frames=[];const state={jobs:0,value:{work:0}};const events=createStateEvents({snapshot:()=>state,clock,pollMs:0});t.after(()=>events.close());
 const req=new EventEmitter(),res=Object.assign(new EventEmitter(),{writeHead(){},write(frame){frames.push({time:clock.now(),...{event:/event: (\w+)/.exec(frame)[1],data:JSON.parse(/data: (.*)/.exec(frame)[1])}});return true;},end(){},writableLength:0});await events.accept(req,res);
 for(let i=1;i<=20;i++){state.jobs=i;state.value={work:i};events.publish(state);await clock.advance(100);}await clock.advance(1200);
 const values=frames.filter(frame=>frame.event==='patch'&&Object.hasOwn(frame.data,'value')),jobs=frames.filter(frame=>frame.event==='patch'&&Object.hasOwn(frame.data,'jobs'));
 for(let i=1;i<values.length;i++)assert.ok(values[i].time-values[i-1].time>=1000);for(let i=1;i<jobs.length;i++)assert.ok(jobs[i].time-jobs[i-1].time>=250);
 assert.ok(jobs.length>=7);assert.equal(values.at(-1).data.value.work,20);assert.equal(jobs.at(-1).data.jobs,20);events.close();assert.equal(clock.timers.size,0);
});
test('actual isolated HTTP owner/window auth, persistent settings, numeric reset and header names only',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-value-http-')),uiKey='b'.repeat(64),stateDir=path.join(root,'state'),work=path.join(root,'work');let app;
 const create=()=>createDesktop({stateDir,defaultRoot:work,uiKey,adminAccess:{supported:()=>false,ready:()=>false}});app=await create();t.after(async()=>{await app?.close();fs.rmSync(root,{recursive:true,force:true});});
 const post=(route,body,headers={})=>fetch(`http://127.0.0.1:${app.apiPort}${route}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),owner={Authorization:`Bearer ${app.adminToken}`},window={...owner,'X-ChatHand-UI':uiKey};
 for(const route of ['/api/value/reset','/api/settings']){const body=route.endsWith('settings')?{show_value:false,value_plan:'pro_5x'}:{};assert.equal((await post(route,body)).status,401);assert.equal((await post(route,body,owner)).status,403);assert.equal((await post(route,body,{...owner,'X-ChatHand-UI':'bad'})).status,403);}
 assert.equal((await post('/api/settings',{show_value:false,value_plan:'pro_5x'},window)).status,200);assert.equal((await post('/api/settings',{show_value:'bad'},window)).status,400);assert.equal((await post('/api/settings',{value_plan:'pro'},window)).status,400);
 const response=await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json,text/event-stream','X-Ken-Bridge-Token':app.mcpToken,'X-Secret-Probe':'secret-header-value'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'connection_check',arguments:{},_meta:{'openai/session':'secret-session-value',model:'secret-model-value'}}})});assert.equal(response.status,200);await response.json();await turn();
 const value=(await app.snapshot()).value;assert.ok(value.probe.header_names.includes('x-secret-probe'));assert.deepEqual(value.probe.meta_keys,['openai/session','model']);assert.equal(value.show,false);assert.equal(value.plan.source,'setting');assert.ok(value.lifetime.work>0);
 assert.equal((await post('/api/value/reset',{},window)).status,200);assert.equal((await app.snapshot()).value.lifetime.work,0);await app.close();app=await create();assert.equal(app.state.data.show_value,false);assert.equal(app.state.data.value_plan,'pro_5x');assert.equal((await app.snapshot()).value.lifetime.work,0);
 const saved=fs.readFileSync(path.join(stateDir,'value-stats.json'),'utf8');assert.doesNotMatch(saved,/secret-header-value|secret-session-value|secret-model-value|x-secret-probe|openai\/session/);assert.deepEqual(JSON.parse(saved).estimators,VALUE_ESTIMATORS);
});
test('isolated real file read/write and sandbox command; fake browser/screenshot; independent Work arithmetic',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-value-tools-')),stateDir=path.join(root,'state'),work=path.join(root,'work');fs.mkdirSync(work);fs.writeFileSync(path.join(work,'numeric_fixture.txt'),'Synthetic text for isolated read validation.\n中文内容只在临时测试目录里。\n');
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey:'c'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false}});t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 app.state.data.mode='auto';app.state.data.auto_approve_tasks=true;app.state.data.terminal_enabled=true;app.state.data.browser_enabled=true;app.state.data.desktop_enabled=true;app.state.save();app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;app.store.accessMode='auto';app.queue.enabled=true;
 const automation=app.tools.automation,invoke=automation.invoke.bind(automation);automation.invoke=async(name,args,caller)=>name==='browser_snapshot'?{text:'Synthetic webpage content with three links.'}:name==='computer_screenshot'?{observation:{mimeType:'image/png',image_base64:png(1280,800),window_title:'synthetic window'}}:invoke(name,args,caller);
 const stats=app.tools.valueStats,measures=[],rawSamples=[];let serial=0,context=0,expectedIO=0,expectedLegacyWork=0;
 const rpc=async(name,args={})=>{const reply=await app.tools.rpc({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':'synthetic-integration-session'}}},'chatgpt',{setupPrincipal:'synthetic-integration-principal'});assert.equal(reply.result.isError,false,`${name}: ${reply.result.structuredContent?.code||'failed'}`);const io=countIO(args,reply.result);if(name==='begin_task'&&reply.result.structuredContent?.replayed!==true)context=0;const legacyStep=workInputTokens(stats.base,context,io.io_in)+io.io_out+REASON;expectedIO+=io.io_in+io.io_out;expectedLegacyWork+=legacyStep;context=nextContextTokens(context,io.io_in+io.io_out);stats.drain();measures.push({tool:name,...io,work:legacyStep,legacy_work:legacyStep});rawSamples.push({out:JSON.stringify(args),text:reply.result.content.filter(part=>part.type==='text').map(part=>part.text),images:reply.result.content.filter(part=>part.type==='image').reduce((sum,part)=>sum+imageTokens(part),0)});return reply.result.structuredContent;};
 const task=await rpc('begin_task',{request_id:'value_integration_task',title:'synthetic integration'}),id=task.task_id;
 const read=await rpc('read_text',{path:'numeric_fixture.txt'});assert.match(read.content,/Synthetic text/);
 await rpc('write_text',{task_id:id,path:'numeric_fixture.txt',expected_sha256:read.sha256,operation_id:'value_write_op',content:'Updated synthetic text.\n'});assert.equal(fs.readFileSync(path.join(work,'numeric_fixture.txt'),'utf8'),'Updated synthetic text.\n');
 const command=await rpc('propose_command',{task_id:id,request_id:'value_command_op',program:'/usr/bin/printf',args:['synthetic command output\n'],cwd:'.',mode:'task',timeout_ms:1000,wait_ms:1000});assert.equal(command.status,'completed');assert.equal(command.exit_code,0);
 await rpc('browser_snapshot',{task_id:id,page_id:'synthetic-page'});await rpc('computer_screenshot',{task_id:id});const beforeFinish=expectedLegacyWork,beforeFinishLegacy=expectedLegacyWork;const finished=await rpc('finish_task',{task_id:id});assert.equal(finished.value.work,beforeFinish);assert.equal(finished.value.legacy_work,beforeFinishLegacy);assert.equal(finished.value.calls,6);assert.equal(stats.snapshot().lifetime.work,expectedLegacyWork);assert.equal(stats.snapshot().lifetime.legacy_work,expectedLegacyWork);assert.deepEqual(stats.snapshot().last7.calls,{all:7,read:1,write:1,command:1,browser:1,desktop:1,other:2});
 stats.flush();assert.doesNotMatch(fs.readFileSync(path.join(stateDir,'value-stats.json'),'utf8'),/numeric_fixture|synthetic window|synthetic-integration-session|Updated synthetic|command output/);
 const python=process.env.CHATHAND_VALUE_TOKENIZER_PYTHON,artifact=process.env.CHATHAND_VALUE_CHECK_OUTPUT;if(python&&artifact){const reference=JSON.parse(execFileSync(python,['-c',"import sys,json,tiktoken; s=json.load(sys.stdin); e=tiktoken.get_encoding('o200k_base'); print(json.dumps([{'io_out':len(e.encode(x['out'])),'io_in':sum(len(e.encode(t)) for t in x['text'])+x['images']} for x in s]))"],{input:JSON.stringify(rawSamples),encoding:'utf8',timeout:10_000}));const numeric=measures.map((row,i)=>({...row,reference_io_in:reference[i].io_in,reference_io_out:reference[i].io_out,io_error_percent:(row.io_in+row.io_out)/(reference[i].io_in+reference[i].io_out)*100-100}));fs.mkdirSync(artifact,{recursive:true});fs.writeFileSync(path.join(artifact,'isolated-tool-numbers.json'),JSON.stringify({physical_browser_desktop:false,base_io:expectedIO,main_work_v4:expectedLegacyWork,observed_main_work:stats.snapshot().lifetime.work,tools:numeric},null,2));}
});
