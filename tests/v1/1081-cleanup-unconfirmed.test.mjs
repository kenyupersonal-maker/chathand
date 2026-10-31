// 1081 N053（Claude，Ken 10/27：不加门槛，任务能结束，但照实写「清理没确认」）：
// Windows 上命令的进程没确认清干净时，后台照样结束任务，结果里带 cleanup_warning（app/policy.mjs）。
// ChatHand 窗口的任务详情照实写一句「清理没确认」；错误次数照旧，但不说「都已处理」，改说「记录到」。
// 错误码、命令编号这些不写进界面文案；没有这个警告（清理确认了）时，任务详情跟原来一字不差。
// 对话里那张任务卡在 1060-ui-widget-locales 里测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {installUiTextContext} from '../support/ui-text-context.mjs';

const app=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
const between=(src,a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i,`${a} … ${b}`);return src.slice(i,j);};
const box={E:x=>String(x??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),loadChanges:()=>{},kind:()=>'ok',active:()=>false,changeCache:new Map(),
 btn:(name,action)=>`<button data-action="${action}">${name}</button>`,ibtn:(icon,name,action)=>`<button data-action="${action}">${name}</button>`,refreshToolsFigure:()=>'',
 when:()=>'今天 11:50',valueTaskDetail:()=>'USAGE',statusWords:()=>'成功完成',outputsOf:()=>[],stallRecords:()=>'',tl:()=>'<ol>TIMELINE</ol>',Map};
vm.createContext(box);const text=installUiTextContext(box);
for(const [a,b] of [['function isRefreshTask','function taskGroups'],['function conversationLink','function statusWords'],['function refreshTaskNeedsManual','/* 1027：停住记录']])vm.runInContext(between(app,a,b),box);
const render=(t,over={})=>vm.runInContext('pgTask(t)',Object.assign(box,{t},over));
const warning={code:'CLEANUP_UNCONFIRMED',message:'清理没确认',message_en:'Cleanup not confirmed',
 jobs:[{job_id:'job-7f3a',cleanup_confirmed:false,cleanup_state:'unconfirmed',reason_code:'WINDOWS_JOB_QUERY_FAILED'}]};
const task=over=>({task_id:'t-clean',status:'completed',created_at:1,summary:'整理好了。',user_action:'不用做什么。',group:null,intermediate_errors:1,...over});
const note='<p class="td-note">清理未确认：此任务运行的命令可能仍有进程未结束。</p>';

test('a finished task whose cleanup was not confirmed says so plainly, without codes or job ids',()=>{
 const done=render(task({cleanup_warning:warning}));
 assert.ok(done.includes('<p class="td-note">过程中记录到 1 次错误。</p>'+note),'the error count no longer says “all handled”, and the cleanup line follows it');
 assert.doesNotMatch(done,/都已处理|均已处理|CLEANUP_UNCONFIRMED|job-7f3a|WINDOWS_JOB_QUERY_FAILED|cleanup_state/);
 assert.doesNotMatch(done,/data-action="(retry|confirmCleanup|rerun)/,'no confirm button, gate or rerun');
 const failed=render(task({status:'failed',summary:'没做完。',user_action:'回到对话看看。',intermediate_errors:3,cleanup_warning:warning}),{kind:()=>'fail',statusWords:()=>'没完成'});
 assert.ok(failed.includes('<p class="td-note">过程中记录到 3 次错误。</p>'+note));
 // 历史结果重新打开时读的是保存下来的同一份结果，同样写这一句
 assert.ok(render(structuredClone(task({cleanup_warning:warning}))).includes(note));
});

test('without the warning, or while the task is still running, task details stay exactly as before',()=>{
 const plain=render(task({intermediate_errors:2}));
 assert.ok(plain.includes('<p class="td-note">过程中出现 2 次错误，均已处理。</p>'));
 assert.doesNotMatch(plain,/清理没确认|清理未确认/);
 assert.equal(render(task({intermediate_errors:2,cleanup_warning:{code:'SOMETHING_ELSE'}})),plain,'only CLEANUP_UNCONFIRMED counts');
 assert.equal(render(task({intermediate_errors:0})).includes('td-note'),false);
 const running=render(task({status:'active',summary:'',intermediate_errors:1,cleanup_warning:warning}),{active:()=>true,taskState:()=>({dot:'ok live',label:'运行中',line:'上一步在 8 秒前'})});
 assert.doesNotMatch(running,/清理没确认|清理未确认|中途|过程中/);
});

test('the cleanup line has its own short English and follows the interface language',()=>{
 const zh=JSON.parse(fs.readFileSync(new URL('../../locales/zh.json',import.meta.url),'utf8')),en=JSON.parse(fs.readFileSync(new URL('../../locales/en.json',import.meta.url),'utf8'));
 for(const key of ['ui.window.pgTask.cleanupUnconfirmed','ui.taskWidget.cleanupUnconfirmed']){
  assert.equal(zh[key],'清理未确认：此任务运行的命令可能仍有进程未结束。',key);
  assert.equal(en[key],'Cleanup not confirmed: some processes from this task’s commands may still be running.',key);
 }
 text.installCatalogs({locale:'en'});
 try{
  const html=render(task({cleanup_warning:warning}));
  assert.ok(html.includes('<p class="td-note">1 error(s) recorded along the way.</p><p class="td-note">Cleanup not confirmed: some processes from this task’s commands may still be running.</p>'));
 }finally{text.installCatalogs({locale:'zh'});}
});
