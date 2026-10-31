import {t as translate} from '../app/i18n.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';
// 1029 H：只测解释回执、错误过滤和假后端，绝不修改本机权限。
import test from 'node:test';
import assert from 'node:assert/strict';
import {blockedReceipt,blockedForError,scopeReceipt,SCOPE_EFFECT} from '../app/v1/blocked.mjs';
import {highRiskError,neverError,HIGH_RISK} from '../app/v1/high-risk.mjs';
import {capabilityError,needsFullAccessError,Blocks,gateCommand} from '../app/v1/permissions.mjs';
import {adminSetupError} from '../app/v1/admin-command.mjs';
import {cleanError,redactErrorText} from '../engine/src/core.mjs';
import {controlErrorDetails,blockedDetails,DESKTOP_ERROR_CODES} from '../engine/src/control-errors.mjs';
import {NativeComputer} from '../app/v07/computer.mjs';
import {ExtensionBrowser} from '../app/v09/extension-browser.mjs';
import {Tools} from '../app/tools.mjs';
import {errorRecovery,WORKFLOW_INSTRUCTIONS} from '../app/v1/workflow.mjs';
const capture=f=>{try{f();}catch(e){return e;}assert.fail('expected error');};
function shape(b,kind,gate,lines=4){assert.equal(b.version,1);assert.equal(b.kind,kind);assert.equal(b.gate,gate);assert.equal(b.confirm,null);assert.equal(b.say_to_user.length,lines);assert.equal(b.answer_in_chat,false);assert.ok(b.cause&&b.effect.can_do&&b.effect.risk&&b.alternative&&b.next);assert.ok(b.cause.length<=160);if(kind==='never')assert.equal(b.where,null);else assert.match(b.where.link,/^chathand:\/\/settings\//);}

test('all high-risk items retain settings wording and legacy fields',()=>{
 for(const r of HIGH_RISK){const e=highRiskError(r.id,{command:'fixture command',times:3}),b=cleanError(e).details.blocked;
  shape(b,'can_enable',r.group==='common'?'common':'high_risk',1);assert.deepEqual(b.effect,{can_do:r.what,risk:r.harm});assert.equal(b.item.id,r.id);assert.equal(e.details.blocked_times,3);assert.equal(b.where.link,'chathand://settings/commands/'+r.id);assert.ok(b.say_to_user[0].includes(r.name));assert.equal(b.next,translate('permissions.ai.switchOff',{},'zh'));
 }
});
test('capability receipts survive both control-error paths without widening the desktop error contract',()=>{
 for(const id of ['terminal','browser','desktop']){const e=capabilityError(id,{command:'fixture_tool'}),r=cleanError(e);shape(r.details.blocked,'can_enable','capability');assert.equal(r.details.capability,id);assert.match(r.details.blocked.cause,/fixture_tool/);assert.deepEqual(controlErrorDetails(e.code,e.details,redactErrorText).blocked,r.details.blocked);}
 assert.equal(DESKTOP_ERROR_CODES.length,43);
});
test('scope errors contain exact scope transition warning and four sentences',()=>{
 const e=needsFullAccessError('fixture scope',{command:'fixture command'}),r=cleanError(e);shape(r.details.blocked,'can_enable','scope');assert.deepEqual(r.details.blocked.effect,SCOPE_EFFECT);assert.equal(r.details.blocked.effect.risk,'改为整台电脑后，其他正在进行的任务将停止，当前任务继续执行。');
 const file=Object.assign(Error('工作区以外'),{code:'SCOPE_REQUIRED'});file.details={blocked:blockedForError(file,{tool:'read_text'})};shape(cleanError(file).details.blocked,'can_enable','scope');assert.match(file.details.blocked.cause,/read_text/);assert.equal(errorRecovery(file.code).next_action,'explain_to_user_and_wait');
});
test('administrator setup source preserves needs-user action, never offers a grant',()=>{
 const e=adminSetupError(),r=cleanError(e);shape(r.details.blocked,'needs_user','admin_setup',1);assert.equal(r.details.requires_local_user,true);assert.deepEqual(r.details.blocked.say_to_user,[r.details.blocked.cause]);
 const blocks=new Blocks();blocks.adminAccess={supported:()=>true,ready:()=>false};const g=capture(()=>gateCommand({spec:{program:'sudo',args:['echo','fixture']},state:{data:{mode:'full',high_risk:{admin:true}}},blocks,task:{id:'task'},self:{home:'/tmp'},cwd:'/tmp'}));shape(cleanError(g).details.blocked,'needs_user','admin_setup');
});
test('never operations have no enable link; self modification points only to the update request',()=>{
 for(const id of ['self','password','switch_user']){const r=cleanError(neverError(id,'fixture operation'));shape(r.details.blocked,'never','never');if(id==='self')assert.match(r.details.blocked.alternative,/request_update/);}
});
test('native permission failures carry the same receipt through a fake native reply',async()=>{
 for(const code of ['ACCESSIBILITY_REQUIRED','SCREEN_RECORDING_REQUIRED']){
  const c=new NativeComputer({data:{mode:'full',desktop_enabled:true}},{epoch:1,require(){}});c.heartbeat({accessibility:false,screen_recording:false});
  const pending=c.applications({task_id:'fixture'},'fixture'),request=c.next().request;c.complete(request.id,{error:{code,message:'系统权限没开'}});
  await assert.rejects(pending,e=>{const d=cleanError(e).details;shape(d.blocked,'needs_user','system_permission');assert.match(d.blocked.where.path,/隐私与安全性/);return true;});c.cancelAll();
 }
});
test('extension missing/disconnected receipts retain connection evidence',()=>{
 const distribution=storeTestDistribution(),state={data:{mode:'full',browser_enabled:true}},policy={check(){},require(){},emit(){},tasks:new Map()};const e=new ExtensionBrowser(state,{},policy,{distribution});
 for(const code of ['EXTENSION_NOT_CONNECTED','EXTENSION_DISCONNECTED']){if(code==='EXTENSION_DISCONNECTED'){state.data.extension_last_seen=Date.now()-20000;state.data.chrome_store_observation={extension_id:distribution.extension_id,last_seen:state.data.extension_last_seen};}const err=capture(()=>e.request('snapshot',{},'fixture','task')),r=cleanError(err);assert.equal(r.code,code);shape(r.details.blocked,'needs_user','browser_helper');assert.equal(r.details.retry_after_user_action_only,true);assert.ok(r.details.connection_state);}
 e.closeAll();
});
test('bounded control receipt removes unknown fields and secret text; never cannot carry confirmation',()=>{
 const b=blockedReceipt({kind:'can_enable',gate:'capability',id:'browser',name:'浏览器',cause:'fixture',can_do:'读网页',risk:'修改页面',path:'settings',link:'chathand://settings/browser'});
 Object.assign(b,{untrusted:'omit',cause:'x'.repeat(2000),say_to_user:Array(10).fill('x'.repeat(1000)),effect:{can_do:'Bearer fixtureSecret00001',risk:'r'.repeat(2000),unknown:'omit'}});
 const d=blockedDetails(b,redactErrorText);assert.equal(d.cause.length,160);assert.equal(d.effect.risk.length,600);assert.equal(d.say_to_user.length,4);assert.equal(d.say_to_user[0].length,600);assert.equal(d.effect.unknown,undefined);assert.equal(d.untrusted,undefined);assert.match(d.effect.can_do,/REDACTED/);
 b.kind='never';b.confirm={id:'cf_'+'a'.repeat(16),expires_at:30000,scopes:['always']};assert.equal(blockedDetails(b).confirm,null);assert.equal(blockedDetails(b).where,null);
});
test('Tools outer catch fills and records a FileStore scope rejection once',async()=>{
 const blocks=new Blocks(),error=Object.assign(Error('文件不在工作区'),{code:'SCOPE_REQUIRED'});
 const fake={state:{data:{}},store:{read(){throw error;}},queue:{},policy:{check(){},tasks:new Map([['task',{id:'task'}]])},lastCalls:{},blocks,imageBatch:{has:()=>false},features:{has:()=>false},automation:{has:()=>false}};
 await assert.rejects(Tools.prototype.invoke.call(fake,'read_text',{path:'fixture'},'fixture'),e=>e.code==='SCOPE_REQUIRED');
 shape(cleanError(error).details.blocked,'can_enable','scope');assert.equal(blocks.list().length,1);assert.equal(blocks.list()[0].blocked.gate,'scope');
 Tools.prototype.recordBlocked.call(fake,error,'read_text');assert.equal(blocks.list()[0].times,1);
});
test('Blocks stores newly covered scope/system/helper receipts and still deduplicates by task and gate',()=>{
 const blocks=new Blocks();for(const [gate,id] of [['scope','full'],['system_permission','accessibility'],['browser_helper','connect']]){const b=blockedReceipt({kind:'needs_user',gate,id,name:id,cause:'fixture',can_do:'fixture',risk:'fixture',path:'fixture',link:'chathand://settings/desktop'});for(let i=0;i<2;i++)blocks.record({kind:gate,id,name:id,task_id:'task',blocked:b});}
 assert.equal(blocks.list().length,3);for(const item of blocks.list()){assert.equal(item.times,2);assert.equal(item.blocked.gate,item.kind);}
});
test('user instructions retain original protocol while disabled scope points to App settings',()=>{
 assert.match(WORKFLOW_INSTRUCTIONS.slice(0,512),/report its receipt once and STOP/);assert.match(WORKFLOW_INSTRUCTIONS,/details.blocked/);assert.match(WORKFLOW_INSTRUCTIONS,/do not show permission cards/);assert.match(WORKFLOW_INSTRUCTIONS,/Never retry an unknown setup result/);const receipt=scopeReceipt();assert.equal(receipt.answer_in_chat,false);assert.equal(receipt.confirm,null);assert.match(receipt.next,/ChatHand.*设置/);assert.doesNotMatch(receipt.next,/request_permission|task_status|finish_task/);
});
