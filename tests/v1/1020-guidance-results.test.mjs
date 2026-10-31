import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskPolicy} from '../../app/policy.mjs';
import {createDesktop} from '../../app/server.mjs';
import {modelTools} from '../../app/product.mjs';
import {TOOLS} from '../../app/tools.mjs';
import {t as translate} from '../../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');

function policyFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1020-policy-')),stateDir=path.join(root,'state');fs.mkdirSync(stateDir);
 const state={data:{mode:'auto',active:'p',auto_approve_tasks:true,conversations:[]},save(){}},store={stateDir,root,paused:false,audit(){}},jobs=new Map();
 const queue={jobs,inputs:new Map(),cancel(){},cancelAll(){},get(id){return jobs.get(id);}},policy=new TaskPolicy(state,store,queue);policy.enabled=true;
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {policy,jobs};
}

test('finish_task trusts final reported success and preserves intermediate error count and summary',t=>{
 const {policy,jobs}=policyFixture(t),task=policy.begin({request_id:'result_success_1020',title:'1020 result'},'chatgpt'),live=policy.tasks.get(task.task_id);
 const job={job_id:'failed-once',status:'completed',exit_code:1,child:null,cleanupPending:false,containment:'none'};jobs.set(job.job_id,job);live.jobs.push(job.job_id);
 const done=policy.finish(task.task_id,'chatgpt',true,'完成，成果在工作区/report.md');
 assert.equal(done.status,'completed');assert.equal(done.success,true);assert.equal(done.intermediate_errors,1);assert.equal(done.summary,'完成，成果在工作区/report.md');
 const saved=policy.receipts.read(task.task_id,'chatgpt').result;assert.equal(saved.intermediate_errors,1);assert.equal(saved.summary,done.summary);
 const replay=policy.finish(task.task_id,'chatgpt',true,'这句不能覆盖原回执');assert.equal(replay.replayed,true);assert.equal(replay.summary,done.summary);
});

test('success false alone means incomplete and summary stays bounded',t=>{
 const {policy}=policyFixture(t),failed=policy.begin({request_id:'result_failed_1020',title:'1020 failed'},'chatgpt');
 const result=policy.finish(failed.task_id,'chatgpt',false,'没完成：缺少输入文件');assert.equal(result.status,'failed');assert.equal(result.success,false);assert.equal(result.intermediate_errors,0);
 const another=policy.begin({request_id:'result_summary_1020',title:'1020 summary'},'chatgpt');assert.throws(()=>policy.finish(another.task_id,'chatgpt',true,'长'.repeat(81)),{code:'ARG_INVALID'});
});

async function desktopFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1020-tools-')),work=path.join(root,'work'),uiKey='d'.repeat(64);fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1019,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});return {app,work};
}

test('begin_task bridge_info and tool descriptions expose 1020 operating rules',async t=>{
 const {app,work}=await desktopFixture(t),begin=await app.tools.invoke('begin_task',{request_id:'guidance_1020',title:'Guidance'},'chatgpt');
 assert.ok(begin.guidance.completion_standard.zh.includes('中途出错但修好也算成功'));assert.equal(begin.guidance.workflow.length,3);assert.ok(begin.guidance.output_default.includes(work));
 const info=await app.tools.invoke('bridge_info',{},'chatgpt');assert.equal(info.known_limits.length,4);assert.ok(info.output_default.includes('默认放进当前工作区'));assert.ok(info.known_limits.some(x=>x.zh.includes('发「继续」')));
 const grouped=Object.values(info.tools_by_category).flat().sort();assert.deepEqual(grouped,modelTools(TOOLS).map(x=>x.name).sort());assert.deepEqual(Object.keys(info.tools_by_category),['读','写','命令','浏览器','桌面','其它']);
 for(const name of ['read_file','read_text','list_directory'])assert.ok(TOOLS.find(x=>x.name===name).description.includes('write_text'));
 for(const name of ['write_text','create_directory'])assert.ok(TOOLS.find(x=>x.name===name).description.includes('工作区'));
 const finish=TOOLS.find(x=>x.name==='finish_task');assert.equal(finish.inputSchema.properties.summary.maxLength,80);assert.ok(finish.description.includes('中途出错但已修好仍算成功'));
 const done=await app.tools.invoke('finish_task',{task_id:begin.task_id,success:true,summary:'完成，成果在工作区'},'chatgpt');assert.equal(done.summary,'完成，成果在工作区');
});

test('main UI and task widget use reported result wording neutral no-result state and conservative workload note',()=>{
 const app=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8'),widget=fs.readFileSync(new URL('../../ui/task-widget.html',import.meta.url),'utf8');
 assert.ok(app.includes("if(t.status==='failed')return 'fail';return 'stop'"));assert.ok(app.includes('T("ui.window.statusWords.stop.text4")'));assert.equal(T('ui.window.statusWords.stop.text4'),'未收到结果');assert.ok(app.includes('T("ui.window.pgTask.text2",'));assert.equal(T('ui.window.pgTask.text2',{intermediate_errors:2}),'过程中出现 2 次错误，均已处理。');assert.ok(!app.includes('宁低勿高'));assert.ok(app.includes("['fail',T("));
 const widgetCatalog=JSON.parse(widget.match(/globalThis\.__CHATHAND_TEXT_CATALOGS__=(\{.*?\});/s)[1]);for(const [key,value] of [['ui.taskWidget.completed','成功完成'],['ui.taskWidget.failed','未完成'],['ui.taskWidget.expired','任务已过期'],['ui.taskWidget.superseded','已被新任务取代'],['ui.taskWidget.revoked','未收到结果']]){assert.equal(widgetCatalog.zh[key],T(key));assert.equal(T(key),value);}
 assert.ok(widget.includes("t.end_reason==='superseded'&&t.status==='expired'"));assert.ok(app.includes("t.status==='expired'"));assert.ok(app.includes("t.status==='superseded'||t.end_reason==='superseded'"));assert.ok(widget.includes('t.summary'));
});
