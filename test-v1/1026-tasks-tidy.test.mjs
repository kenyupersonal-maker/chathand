import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {t as translate} from '../app/i18n.mjs';
const T=(key,params={})=>translate(key,params,'zh');
import {createDesktop} from '../app/server.mjs';
import {Updater} from '../app/v1/update.mjs';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1026-tidy-')),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'a'.repeat(64),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1026,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.tools.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 let id=0;const call=async(name,args={},session='conv-x')=>(await app.tools.rpc({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':session}}},'chatgpt',{setupPrincipal:'acct-1'})).result;
 return {app,call};
}

test('new_task:true retires the unfinished task of the same conversation as superseded',async t=>{
 const {app,call}=await fixture(t);const a=(await call('begin_task',{request_id:'tidy_old_1',title:'旧的'})).structuredContent;
 const b=(await call('begin_task',{request_id:'tidy_new_1',title:'新的',new_task:true})).structuredContent;
 const old=app.tools.policy.view(app.tools.policy.get(a.task_id));assert.equal(old.status,'superseded');assert.equal(old.end_reason,'superseded');
 assert.equal(app.tools.policy.get(b.task_id).status,'active');
 const other=(await call('begin_task',{request_id:'tidy_other_1',title:'别的对话'},'conv-y')).structuredContent;assert.equal(app.tools.policy.get(other.task_id).status,'active');
});

test('a task with no activity for hours is put away; one with recent activity stays',async t=>{
 const {app,call}=await fixture(t);const a=(await call('begin_task',{request_id:'tidy_idle_1',title:'放着没动'})).structuredContent;
 const b=(await call('begin_task',{request_id:'tidy_busy_1',title:'还在做'},'conv-z')).structuredContent;
 const p=app.tools.policy,now=Date.now()+4*3600000;
 const n=p.expireIdle(task=>task.id===b.task_id?now-60000:0,3*3600000,now);
 assert.equal(n,1);assert.equal(p.view(p.get(a.task_id)).end_reason,'idle');assert.equal(p.get(b.task_id).status,'active');
});

test('UI words, accordion card, stall notification and refresh-tools only when tools changed',()=>{
 const ui=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8'),swift=fs.readFileSync(new URL('../native/main.swift',import.meta.url),'utf8'),upd=fs.readFileSync(new URL('../app/v1/update.mjs',import.meta.url),'utf8'),w=fs.readFileSync(new URL('../ui/task-widget.html',import.meta.url),'utf8');
 assert.ok(ui.includes('T("ui.window.statusWords.stop.text")')&&ui.includes('T("ui.window.statusWords.stop.text2")'));assert.equal(T('ui.window.statusWords.stop.text'),'已被新任务取代');assert.equal(T('ui.window.statusWords.stop.text2'),'超时已结束');
 // 折叠卡：样式不变（大卡 / 小条），只换动效：先量完再动，标题平移缩放，高度过渡；展开后整条标题区可点收起
 assert.ok(ui.includes('function taskBoxes()')&&ui.includes("tp-hit")&&!ui.includes('function accCard'));assert.ok(!ui.includes('startViewTransition'));
 assert.ok(ui.includes('data-k="others-${E(t.task_id)}"')&&ui.includes("anchor?.closest?.('.tp,.orow')")&&ui.includes('performance.now()-swapAt<500'));
 assert.ok(ui.includes("const clip=a.panel?el.querySelector('.tp-in'):el")&&ui.includes('swapPendingState')&&css.includes('.tp.swapping .tp-ring,.tp.swapping .tp-glow{opacity:0}'));
 assert.ok(ui.includes('function shortCommand(j)')&&ui.includes('T("ui.window.stepsOf.title.text2"')&&ui.includes('T("ui.window.stepsOf.tip.text"'));assert.equal(T('ui.window.stepsOf.title.text2',{shortCommand:'node test.js'}),'运行命令 node test.js');assert.equal(T('ui.window.stepsOf.tip.text',{code:2}),'运行命令 2');
 assert.match(css,/\.tp-h\.tp-hit::before\{content:"";position:absolute;inset:-32px -32px -16px/);
 assert.ok(ui.includes("case 'cancelDoneSearch'")&&css.includes('.done-clear{'));
 assert.ok(swift.includes('"task_stalled"')&&swift.includes('.contains(kind)'));assert.equal(T('native.notification.stalled.title'),'ChatGPT 的回复已中断'); // 断言跟着 Ken 10/28 改：标准说法
 for(const changed of [true,false,null,undefined]){const snapshot=Updater.prototype.snapshot.call({value:{install:{state:'idle'},just_updated:{tool_schema_changed:changed}},currentBuild:1081,state:{data:{}},request:null});assert.equal(snapshot.refresh_tools,changed===true,'only proven schema changes ask to refresh tools');}
 assert.ok(w.includes('function groupChanges(list)'),'task card still groups changed files');
 assert.ok(w.includes('function renderAlert(')&&w.includes('ui.taskWidget.bridgeUnavailable'),'current card provides an actionable manual fallback');assert.equal(T('ui.taskWidget.bridgeUnavailable'),'无法自动发送，请在下方输入框发送「继续」');
 assert.ok(w.includes('function relayCancel(')&&w.includes('paintText(b,()=>T("cancel"))')&&w.includes('b.onclick=()=>relayCancel(t.task_id)'),'20-second countdown can be cancelled');assert.equal(T('ui.taskWidget.cancel'),'取消');
 assert.ok(!w.includes('function autoSend(')&&!w.includes("send('ui/message'"),'retired parallel sender cannot silently send twice');
});
