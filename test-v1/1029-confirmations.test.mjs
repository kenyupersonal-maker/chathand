// 1029 I：纯内存授权 + 临时目录 HTTP 服务。不会点击真实确认、执行危险命令或改本机管理员规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Confirmations,CONFIRM_TTL,bindConfirmations,commandHash,confirmationScopes} from '../app/v1/confirmations.mjs';
import {gateCommand,Blocks,capabilityError,capabilityAllowed} from '../app/v1/permissions.mjs';
import {highRiskError} from '../app/v1/high-risk.mjs';
import {scopeReceipt} from '../app/v1/blocked.mjs';
import {cleanError} from '../engine/src/core.mjs';
import {createDesktop,needsInterface} from '../app/server.mjs';
import {DesktopState} from '../app/state.mjs';
import {TOOLS,mergeNotes} from '../app/tools.mjs';
import {ExtensionBrowser} from '../app/v09/extension-browser.mjs';
import {PersonalChrome} from '../app/v08/personal-chrome.mjs';
import {NativeComputer} from '../app/v07/computer.mjs';
import {STATE_FIELD_GROUPS} from '../app/v1/events.mjs';
const caught=f=>{try{f();}catch(e){return e;}assert.fail('expected rejection');};
const fakeSpec={program:'xattr',args:['-d','com.apple.quarantine','/tmp/fixture-app']};
const scopeWords=['always'];
function unit(t){
 let now=10000;const events=[],audit=[],c=new Confirmations({now:()=>now,emit:(kind,data)=>events.push({kind,...data}),audit:e=>audit.push(e)});t.after(()=>c.close());
 const state={data:{mode:'full',high_risk:{}}};bindConfirmations(state,c);
 const gate=(spec=fakeSpec,task='task-1',cwd='/tmp')=>gateCommand({spec,state,blocks:new Blocks(),confirmations:c,task:{id:task,session_hash:'a'.repeat(64),conversation_title:'确认测试'},self:{home:'/tmp'},cwd});
 return {c,events,audit,state,gate,advance:ms=>{now+=ms;},get now(){return now;}};
}
let request=0;
async function httpFixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1029-confirm-'))),work=path.join(root,'work');fs.mkdirSync(work);fs.writeFileSync(path.join(root,'outside.txt'),'scope fixture');const uiKey='cd'.repeat(32);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey,adminAccess:{supported:()=>false,ready:()=>false}});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});await app.handle('/api/settings',{high_risk:{}});
 const rpc=async(name,args={},session='A')=>{const raw=await app.tools.rpc({jsonrpc:'2.0',id:++request,method:'tools/call',params:{name,arguments:args,...(session!==null?{_meta:{'openai/session':session}}:{})}},'chatgpt',{setupPrincipal:'fixture'});return raw.result;};
 const task=async(session='A')=>{const r=await rpc('begin_task',{request_id:'confirm-task-'+(++request),title:'确认测试',conversation_title:'确认测试',new_task:true},session);assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent.task_id;};
 const owner=async(route,body,{ui=true,authorized=true,origin}={})=>{const r=await fetch(`http://127.0.0.1:${app.apiPort}${route}`,{method:'POST',headers:{Authorization:'Bearer '+(authorized?app.adminToken:'synthetic-wrong-owner'),'Content-Type':'application/json',...(ui?{'X-ChatHand-UI':uiKey}:{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const answer=(id,scope,opts={})=>owner('/api/confirm/answer',{id,scope,via:opts.via||'window',input:opts.input||{human:true,window_age_s:0.1,hid_click_s:0.1,hid_key_s:100,source_pid:0}},opts);
 const block=async(task_id,session='A')=>{const r=await rpc('propose_command',{task_id,request_id:'blocked-command-'+(++request),...fakeSpec,cwd:work},session);assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'HIGH_RISK_DISABLED');const b=r.structuredContent.details.blocked;assert.equal(b.confirm,null);assert.equal(b.answer_in_chat,false);return b;};
 return {app,root,work,rpc,task,owner,answer,block};
}

test('create binds task, session and complete command; same gate reuses one 10-minute confirmation',t=>{
 const u=unit(t),e=caught(()=>u.gate()),b=e.details.blocked,c=u.c.get(b.confirm.id);assert.match(c.id,/^cf_[a-f0-9]{16}$/);assert.equal(c.expires_at-c.created_at,CONFIRM_TTL);assert.deepEqual(c.scopes,scopeWords);assert.equal(c.hash,commandHash({...fakeSpec,cwd:'/tmp'}));assert.equal(c.task_id,'task-1');assert.equal(c.session_hash,'a'.repeat(64));
 assert.equal(caught(()=>u.gate()).details.blocked.confirm.id,c.id);assert.equal(u.events.filter(e=>e.kind==='confirmation_required').length,1);
});
test('temporary scopes are rejected; only the persistent setting can allow a command',t=>{
 const u=unit(t),id=caught(()=>u.gate()).details.blocked.confirm.id;
 assert.equal(caught(()=>u.c.answer(id,'once')).code,'CONFIRMATION_SCOPE');
 const applying=u.c.answer(id,'always');assert.deepEqual(applying.apply.body,{high_risk:{gatekeeper:true}});
 u.state.data.high_risk.gatekeeper=true;u.c.completeApply(id);
 assert.doesNotThrow(()=>u.gate());assert.doesNotThrow(()=>u.gate(fakeSpec,'task-2'));
 assert.equal(u.c.grants.length,0);
});
test('command hash does not conflate joined arguments, long suffixes or credentials redaction',()=>{
 const h=args=>commandHash({program:'fixture',args,cwd:'/tmp'});assert.notEqual(h(['a b','c']),h(['a','b c']));assert.notEqual(h(['x'.repeat(1000)+'a']),h(['x'.repeat(1000)+'b']));assert.notEqual(h(['password=first']),h(['password=second']));
});
test('persistent settings survive task end and a new confirmation manager; revoke restores the gate',t=>{
 const u=unit(t),id=caught(()=>u.gate()).details.blocked.confirm.id;u.c.answer(id,'always');u.state.data.high_risk.gatekeeper=true;u.c.completeApply(id);u.c.endTask('task-1');
 const restarted=new Confirmations();t.after(()=>restarted.close());bindConfirmations(u.state,restarted);
 assert.doesNotThrow(()=>gateCommand({spec:fakeSpec,state:u.state,confirmations:restarted,task:{id:'task-next'},self:{home:'/tmp'},cwd:'/tmp'}));
 u.state.data.high_risk.gatekeeper=false;assert.equal(caught(()=>u.gate(fakeSpec,'task-3')).code,'HIGH_RISK_DISABLED');
});
test('deny does not ask again within the task',t=>{
 const u=unit(t),id=caught(()=>u.gate()).details.blocked.confirm.id;u.c.answer(id,'deny');const count=u.events.length;
 const b=caught(()=>u.gate()).details.blocked;assert.equal(b.answer,'denied');assert.equal(b.confirm,null);assert.equal(u.events.length,count);assert.equal(u.c.snapshot().length,1);assert.ok(u.audit.some(x=>x.event==='confirmation'&&x.scope==='deny'));
});
test('expired, answered and withdrawn identifiers cannot be answered; closure events are emitted',t=>{
 const u=unit(t);let id=caught(()=>u.gate()).details.blocked.confirm.id;assert.equal(caught(()=>u.c.answer(id,'invalid')).code,'CONFIRMATION_SCOPE');u.advance(CONFIRM_TTL);assert.equal(caught(()=>u.c.answer(id,'once')).code,'CONFIRMATION_STATE');
 id=caught(()=>u.gate()).details.blocked.confirm.id;u.c.answer(id,'deny');assert.equal(caught(()=>u.c.answer(id,'once')).code,'CONFIRMATION_STATE');
 id=caught(()=>u.gate(fakeSpec,'task-2')).details.blocked.confirm.id;assert.equal(caught(()=>u.c.withdraw(id,'task-1')).code,'CONFIRMATION_OWNER');u.c.withdraw(id,'task-2');assert.equal(caught(()=>u.c.answer(id,'once')).code,'CONFIRMATION_STATE');
 assert.deepEqual(u.events.filter(x=>x.kind==='confirmation_closed').map(x=>x.state),['expired','denied','withdrawn']);
});
test('scope and capabilities restrict ranges, administrator and never cannot create grants',t=>{
 const u=unit(t),cap=capabilityError('browser').details.blocked,scope=scopeReceipt();assert.deepEqual(confirmationScopes(cap),['always']);assert.deepEqual(confirmationScopes(scope),['always']);assert.deepEqual(confirmationScopes(highRiskError('admin').details.blocked),['always']);
 const c=u.c.create({blocked:scope,task_id:'task'});assert.equal(caught(()=>u.c.answer(c.id,'once')).code,'CONFIRMATION_SCOPE');const r=u.c.answer(c.id,'always');assert.deepEqual(r.apply,{route:'/api/mode',body:{mode:'full',confirm:true}});assert.equal(u.c.get(c.id).state,'applying');u.c.completeApply(c.id);assert.equal(u.c.get(c.id).state,'allowed');assert.equal(u.c.grants.length,0);
});
test('unknown always-apply closes permanently and never emits an allowed answer',t=>{
 const u=unit(t),id=caught(()=>u.gate()).details.blocked.confirm.id,r=u.c.answer(id,'always');assert.deepEqual(r.apply,{route:'/api/settings',body:{high_risk:{gatekeeper:true}}});assert.equal(caught(()=>u.c.answer(id,'always')).code,'CONFIRMATION_STATE');u.c.failApply(id);assert.equal(u.c.get(id).state,'unknown');assert.equal(u.events.some(x=>x.kind==='confirmation_answered'),false);
});
test('capability confirmation has only persistent scope; no silent temporary grant',t=>{
 const u=unit(t);u.state.data.browser_enabled=false;u.state.data.desktop_enabled=false;
 for(const cap of ['browser','desktop']){const c=u.c.create({blocked:capabilityError(cap).details.blocked,task_id:'task'});assert.equal(caught(()=>u.c.answer(c.id,'once')).code,'CONFIRMATION_SCOPE');assert.equal(caught(()=>u.c.answer(c.id,'task')).code,'CONFIRMATION_SCOPE');assert.equal(capabilityAllowed(u.state,cap,{task_id:'task'}),false);const r=u.c.answer(c.id,'always');assert.equal(r.apply.route,'/api/settings');u.state.data[cap+'_enabled']=true;u.c.completeApply(c.id);assert.equal(capabilityAllowed(u.state,cap,{task_id:'task'}),true);assert.equal(capabilityAllowed(u.state,cap,{task_id:'other'}),true);}
});
test('HTTP settings require owner, window and same-origin proof; MCP cannot grant permissions',async t=>{
 const f=await httpFixture(t),task=await f.task();await f.block(task);const route='/api/settings',patch={high_risk:{gatekeeper:true}};
 assert.equal(needsInterface(route,patch),true);
 for(const options of [{ui:false},{authorized:false},{origin:'https://synthetic.invalid'}]){const denied=await f.owner(route,patch,options);assert.ok([401,403].includes(denied.status));assert.equal(f.app.state.data.high_risk.gatekeeper,false);}
 assert.equal((await f.owner(route,patch)).status,200);assert.equal(f.app.state.data.high_risk.gatekeeper,true);
 assert.equal(TOOLS.some(x=>x.name==='request_permission'||/confirm.*answer|answer.*confirm/.test(x.name)),false);
 const old=await f.rpc('request_permission',{task_id:task,confirm_id:'cf_'+'a'.repeat(16)});assert.equal(old.isError,true);assert.equal(f.app.tools.confirmations.items.size,0);
});
test('HTTP setting persists only the selected switch across tasks and restart; revoke restores the gate',async t=>{
 const f=await httpFixture(t),task=await f.task();await f.block(task);assert.equal((await f.owner('/api/settings',{high_risk:{gatekeeper:true}})).status,200);
 assert.equal(f.app.state.data.high_risk.gatekeeper,true);assert.equal(f.app.state.data.high_risk.admin,false);assert.equal(f.app.state.data.high_risk.autostart,false);
 const persisted=new DesktopState(path.join(f.root,'state')).data;assert.equal(persisted.high_risk.gatekeeper,true);
 assert.equal((await f.rpc('finish_task',{task_id:task,success:true,summary:'fixture'})).isError,false);
 assert.doesNotThrow(()=>gateCommand({spec:fakeSpec,state:{data:persisted},task:{id:'restarted'},self:{home:'/tmp'},cwd:'/tmp'}));
 assert.equal((await f.owner('/api/permissions/revoke',{gate:'high_risk',id:'gatekeeper'})).status,200);
 assert.equal(f.app.state.data.high_risk.gatekeeper,false);assert.equal(f.app.state.data.high_risk.autostart,false);await f.block(await f.task());
});
test('blocked commands give settings guidance without pending cards or forged-answer authority',async t=>{
 const f=await httpFixture(t),task=await f.task();
 for(let i=0;i<2;i++){const b=await f.block(task);assert.equal(b.where.link,'chathand://settings/commands/gatekeeper');assert.ok(b.next);}
 const forged=await f.answer('cf_'+'a'.repeat(16),'always');assert.notEqual(forged.status,200);assert.equal(f.app.state.data.high_risk.gatekeeper,false);
 assert.equal(f.app.tools.confirmations.items.size,0);assert.equal(f.app.queue.jobs.size,0);assert.equal(f.app.policy.events.some(e=>e.kind==='confirmation_required'),false);
});
test('task_status does not invent a permission waiter for a disabled setting',async t=>{
 const f=await httpFixture(t),task=await f.task();await f.block(task);
 const result=await f.rpc('task_status',{task_id:task,wait_ms:2000});assert.equal(result.isError,false);assert.equal(result.structuredContent.status,'active');assert.deepEqual(result.structuredContent.confirmations,[]);
 assert.equal(f.app.tools.confirmations.isWaiting(task),false);assert.deepEqual((await f.app.snapshot()).confirmations,[]);
});
test('disabled capabilities block their effects while independent reads and other tasks remain available',async t=>{
 const f=await httpFixture(t),task=await f.task(),other=await f.task('B');fs.writeFileSync(path.join(f.work,'read-only.txt'),'independent');
 await f.owner('/api/settings',{terminal_enabled:false,browser_enabled:false,desktop_enabled:false});
 for(const [name,args] of [['propose_command',{task_id:task,request_id:'disabled-terminal',program:'/usr/bin/true'}],['computer_action',{task_id:task,request_id:'disabled-desktop',action:'click'}],['browser_open',{task_id:task,request_id:'disabled-browser',url:'https://fixture.invalid/'}]]){const r=await f.rpc(name,args);assert.equal(r.isError,true,name);assert.equal(r.structuredContent.code,'CAPABILITY_OFF',JSON.stringify(r));assert.equal(r.structuredContent.details.blocked.confirm,null);}
 assert.equal(f.app.queue.jobs.size,0);assert.equal(f.app.tools.automation.computer.pending.size,0);assert.equal(f.app.tools.automation.browser.extension.pending.size,0);
 assert.equal((await f.rpc('read_text',{path:'read-only.txt'})).isError,false);assert.equal((await f.rpc('task_status',{task_id:task})).isError,false);
 assert.equal((await f.rpc('task_checkpoint',{task_id:other,done:'independent task'},'B')).isError,false);assert.ok(await f.task('B'));assert.ok(await f.task(null));
 assert.notEqual((await f.rpc('cancel_command',{job_id:'missing-job'})).structuredContent?.code,'CONFIRMATION_PENDING');
});
test('finish and stop leave no implicit permission grants after a blocked command',async t=>{
 const f=await httpFixture(t);const finished=await f.task();await f.block(finished);assert.equal((await f.rpc('finish_task',{task_id:finished,success:true})).isError,false);assert.throws(()=>f.app.policy.require(finished),{code:'TASK_COMPLETED'});
 const stopped=await f.task();await f.block(stopped);await f.app.handle('/api/tasks/stop',{id:stopped});assert.throws(()=>f.app.policy.require(stopped));
 assert.equal(f.app.state.data.high_risk.gatekeeper,false);assert.equal(f.app.tools.confirmations.grants.length,0);assert.equal(f.app.tools.confirmations.items.size,0);await f.block(await f.task());
});
test('scope expansion uses the local mode setting and revokes old task authority',async t=>{
 const f=await httpFixture(t);await f.app.handle('/api/mode',{mode:'auto'});const task=await f.task(),r=await f.rpc('read_text',{path:path.join(f.root,'outside.txt')});assert.equal(r.structuredContent.code,'SCOPE_REQUIRED');assert.equal(r.structuredContent.details.blocked.confirm,null);
 assert.notEqual((await f.owner('/api/mode',{mode:'full'})).status,200);assert.equal(f.app.state.data.mode,'auto');
 assert.equal((await f.owner('/api/mode',{mode:'full',confirm:true})).status,200);assert.equal(f.app.state.data.mode,'full');assert.notEqual(f.app.policy.get(task).status,'active');
 assert.notEqual(f.app.state.data.high_risk.autostart,true);assert.notEqual(f.app.state.data.high_risk.admin,true);assert.equal((await f.rpc('read_text',{path:path.join(f.root,'outside.txt')})).isError,false);
});
test('local capability setting opens the real switch and UI revoke disables both gates',async t=>{
 const f=await httpFixture(t),task=await f.task();await f.owner('/api/settings',{browser_enabled:false});const result=await f.rpc('browser_open',{task_id:task,request_id:'capability-block',url:'https://fixture.invalid/'});assert.equal(result.structuredContent.code,'CAPABILITY_OFF');assert.equal(result.structuredContent.details.blocked.confirm,null);
 assert.equal((await f.owner('/api/settings',{browser_enabled:true})).status,200);assert.equal(capabilityAllowed(f.app.state,'browser',{task_id:task}),true);assert.doesNotThrow(()=>f.app.tools.automation.browser.extension.full(task));
 await f.owner('/api/permissions/revoke',{gate:'capability',id:'browser'});assert.equal(capabilityAllowed(f.app.state,'browser',{task_id:task}),false);assert.equal(caught(()=>f.app.tools.automation.browser.extension.full(task)).code,'CAPABILITY_OFF');
});
test('confirmation notes merge with an existing resume note without dropping either',()=>{
 const n=mergeNotes({zh:'继续原任务',also:[{zh:'之前提醒'}]},{zh:'已允许'});assert.equal(n.zh,'继续原任务');assert.deepEqual(n.also.map(x=>x.zh),['之前提醒','已允许']);
});

test('disk erase is never allowed even with the legacy switch set and creates no card',t=>{
 const u=unit(t);u.state.data.high_risk.erase=true;
 const err=caught(()=>u.gate({program:'/usr/sbin/diskutil',args:['eraseDisk','APFS','fixture','/dev/disk99']}));
 assert.equal(err.code,'NEVER_ALLOWED');assert.equal(err.details.blocked.kind,'never');assert.equal(u.c.snapshot().length,0);
});

test('all 13 persistent card kinds map to only their own revocable setting',()=>{
 const c=new Confirmations();try{for(const [gate,ids]of [['high_risk',['bulk_delete','keychain','pipe_run','gatekeeper','bulk_perm','power','chatgpt_self']],['common',['admin','autostart']],['capability',['terminal','browser','desktop']],['scope',['full']]])for(const id of ids){const card=c.create({task_id:'matrix-'+id,blocked:{kind:'can_enable',gate,item:{id,name:id}}});assert.deepEqual(card.scopes,['always']);assert.throws(()=>c.answer(card.id,'once'),{code:'CONFIRMATION_SCOPE'});const a=c.answer(card.id,'always');if(gate==='scope')assert.deepEqual(a.apply,{route:'/api/mode',body:{mode:'full',confirm:true}});else if(gate==='capability')assert.deepEqual(a.apply,{route:'/api/settings',body:{[{terminal:'terminal_enabled',browser:'browser_enabled',desktop:'desktop_enabled'}[id]]:true}});else assert.deepEqual(a.apply,{route:'/api/settings',body:{high_risk:{[id]:true}}});}}finally{c.close();}
});
