import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop,needsInterface,interfaceAuthorized} from '../../app/server.mjs';
import {InstallationPilot} from '../../app/v1/installation-pilot.mjs';
import {sessionHashOf} from '../../app/v1/resume.mjs';
import {TOOLS} from '../../app/tools.mjs';

const UUID=()=>crypto.randomUUID();
import crypto from 'node:crypto';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1049-production-rpc-'));
 const work=path.join(root,'work');fs.mkdirSync(work);
 const stateDir=path.join(root,'state'),uiKey='a'.repeat(64);
 const app=await createDesktop({stateDir,defaultRoot:work,uiKey,
  adminAccess:{supported:()=>false,ready:()=>false},
  clientDeps:{
   currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic Mac',
   tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
   updaterFactory:()=>({currentBuild:1048,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
  }
 });
 app.tools.resume.data.gaps=Array(200).fill(1000);app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 let requestSeq=0,clock=Date.now();
 for(const o of [app.tools.relayKeeper,app.tools.resume,app.tools.h8Cards])o.now=()=>clock;
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 async function rpc(name,args={},opt={}){
  const meta={'openai/session':opt.session??'conv-A','io.modelcontextprotocol/protocolVersion':opt.modern===false?'2025-11-25':'2026-07-28'};
  const raw=await app.tools.rpc({jsonrpc:'2.0',id:++requestSeq,method:'tools/call',params:{name,arguments:args,_meta:meta}},opt.caller??'chatgpt',{setupPrincipal:opt.principal??'account-A'});
  return raw.result;
 }
 const ok=out=>{assert.equal(out?.isError,false,JSON.stringify(out?.structuredContent??out));return out.structuredContent;};
 const advance=ms=>{clock+=ms;};
 const begin=async(tag='normal')=>ok(await rpc('begin_task',{request_id:'prod1049_'+tag+'_'+UUID(),title:'1049 真实入口隔离测试'})).task_id;
 const checkpoint=async id=>{
  const recorded=await rpc('task_checkpoint',{task_id:id,done:'第 1 块完整',next:'接着做：读取检查原任务'}),saved=ok(recorded),viewToken=recorded._meta['chathand/relay_card_token'];
  assert.equal(saved.relay.state,'cancelled');assert.equal(saved.relay_instruction,undefined);
  clock+=600001;
  const observed=await rpc('relay_card_control',{action:'view',task_id:id,card_token:viewToken}),witness=observed._meta['chathand/relay_interruption_token'];assert.match(witness,/^[a-f0-9]{64}$/);
  const out=await rpc('relay_card_control',{action:'interruption',task_id:id,interruption_token:witness}),data={...saved,...ok(out)},token=out._meta['chathand/relay_card_token'];
  assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(data).includes(token),false);
  assert.equal(JSON.stringify(out.content).includes(token),false);
  return {out,data,token};
 };
 const view=async(id,token)=>ok(await rpc('relay_card_control',{action:'view',task_id:id,card_token:token})).relay;
 const viewLocal=(id,token)=>app.tools.relayKeeper.view({task_id:id,card_token:token},{caller:'chatgpt',session_hash:sessionHashOf('account-A','conv-A'),transport:'mcp_app'});
 const activate=async()=>{await app.handle('/api/settings',{relay_pilot_enable:true});assert.equal(app.tools.relayKeeper.installationEligible,true);};
 return {root,work,stateDir,uiKey,app,rpc,ok,advance,begin,checkpoint,view,viewLocal,activate};
}

test('1049 production: private installation binding requires authenticated UI and is not transferable',async t=>{
 const f=await fixture(t),p=new InstallationPilot(f.stateDir);
 assert.equal(p.eligible(),true);
 assert.equal(f.app.tools.relayKeeper.installationEligible,true);
 assert.equal(needsInterface('/api/settings',{relay_pilot_enable:true}),true);
 assert.equal(interfaceAuthorized('/api/settings',{relay_pilot_enable:true},null,f.uiKey),false);
 assert.equal(interfaceAuthorized('/api/settings',{relay_pilot_enable:true},f.uiKey,f.uiKey),true);
 await assert.rejects(f.app.handle('/api/settings',{installation_uuid:'client-chosen'}),e=>e.code==='PILOT_IDENTITY_PROTECTED');
 assert.equal(new InstallationPilot(f.stateDir).eligible(),true);
 await f.activate();
 const restart=new InstallationPilot(f.stateDir);
 assert.equal(restart.eligible(),true,'same installation private state survives new process');
 const foreign=fs.mkdtempSync(path.join(f.root,'foreign-state-'));
 fs.copyFileSync(path.join(f.stateDir,'installation-1049.json'),path.join(foreign,'installation-1049.json'));
 fs.chmodSync(path.join(foreign,'installation-1049.json'),0o600);
 assert.equal(new InstallationPilot(foreign).eligible(),false,'copied identity cannot enable another installation');
 const exposed=JSON.stringify(await f.app.snapshot());
 assert.equal(exposed.includes(restart.data.installation_uuid),false);
 assert.equal(exposed.includes(restart.data.installation_scope),false);
 const mcp=await f.rpc('bridge_info');
 assert.equal(JSON.stringify(mcp).includes(restart.data.installation_uuid),false);
 assert.equal(JSON.stringify(mcp).includes('pilot_installation_uuid'),false);
 assert.equal(f.app.tools.relayKeeper.stats().real_trials,0);
});

test('1049 production: checkpoint private tokens, 20-second one-use permit and real model resumption',async t=>{
 const f=await fixture(t);await f.activate();
 const id=await f.begin('card');
 const cp=await f.checkpoint(id);
 assert.equal(cp.data.relay.state,'armed');
 assert.equal(cp.data.relay.auto_enabled,true);
 const short=await f.rpc('relay_card_control',{action:'claim',task_id:id,card_token:cp.token,mode:'auto'});
 assert.equal(f.ok(short).granted,false);
 assert.equal(f.ok(short).reason,'too_early');
 f.advance(20_001);
 const claimed=await f.rpc('relay_card_control',{action:'claim',task_id:id,card_token:cp.token,mode:'auto'});
 const grant=f.ok(claimed),permit=claimed._meta?.['chathand/relay_permit_token'];
 assert.equal(grant.granted,true);
 assert.match(permit,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(grant).includes(permit),false);
 assert.equal(JSON.stringify(claimed.content).includes(permit),false);
 const started=f.ok(await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit}));
 assert.equal(started.send,true);
 assert.equal(f.ok(await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit})).send,false);
 const reported=f.ok(await f.rpc('relay_card_control',{action:'report',task_id:id,attempt_id:started.attempt_id,report_token:permit,outcome:'accepted'}));
 assert.equal(reported.relay.state,'awaiting');
 const before=f.app.tools.relayKeeper.stats();
 assert.equal(before.real_trials,0,'unit dispatch is not a real-host trial');
 assert.equal(before.eligible_for_release,false);
 const status=f.ok(await f.rpc('task_status',{task_id:id}));
 assert.equal(status.task_id,id);
 assert.equal((await f.view(id,cp.token)).state,'resumed','only subsequent model tool carrying same task id is a resumption');
 const log=fs.readFileSync(f.app.tools.trace.file,'utf8');
 assert.equal(log.includes(cp.token),false);
 assert.equal(log.includes(permit),false);
 assert.equal(JSON.stringify(f.app.tools.valueStats.queue).includes(cp.token),false);
 assert.equal(JSON.stringify(f.app.tools.valueStats.queue).includes(permit),false);
 assert.equal(fs.readFileSync(path.join(f.stateDir,'relay-1049.sqlite')).includes(Buffer.from(permit)),false);
 assert.deepEqual(Object.keys(JSON.parse(f.app.tools.relayKeeper.db.prepare('SELECT value FROM relay_state WHERE id=1').get().value).active_calls),[]);
});

test('1049 production: failed model calls and unattributed calls revoke before execution, finally clears own inflight',async t=>{
 const f=await fixture(t);await f.activate();
 const id=await f.begin('badtool'),first=await f.checkpoint(id);
 const bad=await f.rpc('definitely_missing_tool_1049',{task_id:id});
 assert.equal(bad.isError,true);assert.equal(bad.structuredContent.code,'TOOL_UNKNOWN');
 assert.equal((await f.view(id,first.token)).state,'cancelled');
 assert.deepEqual(Object.keys(JSON.parse(f.app.tools.relayKeeper.db.prepare('SELECT value FROM relay_state WHERE id=1').get().value).active_calls),[]);
 const second=await f.checkpoint(id);
 assert.equal(second.data.checkpoint_seq,2);
 const noTask=await f.rpc('bridge_info');
 assert.equal(noTask.isError,false);
 assert.equal((await f.view(id,second.token)).state,'cancelled','same-session model call without task id still revokes');
 const third=await f.checkpoint(id);
 // Private view/claim must not be counted as model tools or revoke this candidate.
 const checked=await f.view(id,third.token);assert.equal(checked.state,'armed');
 const attempted=await f.rpc('relay_card_control',{action:'view',task_id:id,card_token:third.token},{modern:false});
 assert.equal(attempted.isError,true);assert.equal(attempted.structuredContent.code,'RELAY_CARD_INVALID');
 // F2: a legacy-format fake private call is model-origin and MUST cancel.
 assert.equal((await f.view(id,third.token)).state,'cancelled','unproved private transport triggers model wrapper');
});

test('1049 production: stop_task, window stop, finish, permission, pause, quit all synchronously cancel',async t=>{
 const f=await fixture(t);await f.activate();
 async function armed(tag){const id=await f.begin(tag);const cp=await f.checkpoint(id);return {id,token:cp.token};}
 // One server fixture uses distinct sessions to avoid retiring active work while checking each stop.
 const a=await armed('model_stop');
 const stopped=f.ok(await f.rpc('task_stop',{task_id:a.id}));
 assert.equal(stopped.stopped,true);assert.equal(stopped.status,'cancelled');assert.equal((await f.view(a.id,a.token)).state,'cancelled');
 const wrongStop=await f.rpc('task_stop',{task_id:a.id},{session:'wrong-conversation'});
 assert.equal(wrongStop.isError,false);assert.equal(wrongStop.structuredContent.stopped,false);assert.equal(wrongStop.structuredContent.reason,'already_terminal');

 const b=await armed('window_stop');
 assert.equal((await f.app.handle('/api/tasks/stop',{id:b.id})).ok,true);
 assert.equal((await f.view(b.id,b.token)).state,'cancelled');

 const c=await armed('finish');
 assert.equal(f.ok(await f.rpc('finish_task',{task_id:c.id,success:true,summary:'结束'})).status,'completed');
 assert.equal((await f.view(c.id,c.token)).state,'cancelled');

 const d=await armed('permission');
 await f.app.handle('/api/settings',{desktop_enabled:false});
 assert.equal((await f.view(d.id,d.token)).state,'cancelled');

 f.ok(await f.rpc('task_stop',{task_id:d.id}));
 const e=await armed('permission_epoch');
 f.app.policy.revokeAll('permission_changed');
 assert.equal((await f.view(e.id,e.token)).state,'cancelled');

 const g=await armed('pause');
 await f.app.handle('/api/access',{enabled:false});
 assert.equal(f.viewLocal(g.id,g.token).state,'cancelled');
 f.app.tools.resume.data.gaps=Array(200).fill(1000);f.app.policy.enabled=true;f.app.store.paused=false;f.app.store.writesEnabled=true;

 const h=await armed('quit');
 await f.app.handle('/api/lifecycle/quit');
 assert.equal(f.viewLocal(h.id,h.token).state,'cancelled');
 assert.equal(f.app.tools.relayKeeper.stats().real_trials,0);
});

test('1049 production: no legacy parallel sender, app-only private schema and unknown results cannot retry',async t=>{
 const f=await fixture(t);await f.activate();
 // Both official MCP App controls are app-only in the current contract;
 // legacy OpenAI fields remain for older host compatibility.
 for(const name of ['relay_card_control','card_answer']){
  const descriptor=TOOLS.find(tool=>tool.name===name);
  assert.ok(descriptor,name);
  assert.deepEqual(descriptor._meta?.ui?.visibility,['app'],name+' modern app-only audience');
  assert.equal(descriptor._meta['openai/visibility'],'private',name+' legacy private visibility');
  assert.equal(descriptor._meta['openai/widgetAccessible'],true,name+' legacy widget access');
 }
 const stop=TOOLS.find(tool=>tool.name==='task_stop');
 assert.ok(stop&&!stop._meta?.['openai/visibility']);
 const widget=fs.readFileSync(new URL('../../ui/task-widget.html',import.meta.url),'utf8');
 assert.equal(widget.includes("task_resume_claim"),false);
 assert.equal(widget.includes("ui/message"),true,'only explanatory comment remains, no send invocation');
 assert.equal(widget.includes("send('ui/message'"),false);
 assert.equal(widget.includes('function autoSend('),false);
 assert.equal(widget.includes('function post('),false);
 assert.ok(widget.includes('window.openai.sendFollowUpMessage')&&widget.includes('relay_card_control'));
 const id=await f.begin('unknown'),cp=await f.checkpoint(id);
 f.advance(20_050);
 const response=await f.rpc('relay_card_control',{action:'claim',task_id:id,card_token:cp.token,mode:'auto'});
 const permit=response._meta?.['chathand/relay_permit_token'];
 assert.equal(f.ok(response).granted,true);
 const dispatch=f.ok(await f.rpc('relay_card_control',{action:'begin_dispatch',task_id:id,permit_token:permit}));
 const report=f.ok(await f.rpc('relay_card_control',{action:'report',task_id:id,attempt_id:dispatch.attempt_id,report_token:permit,outcome:'unknown'}));
 assert.equal(report.relay.state,'unknown');
 f.advance(60_100);
 assert.equal((await f.view(id,cp.token)).state,'manual_ready');
 const replay=f.ok(await f.rpc('relay_card_control',{action:'claim',task_id:id,card_token:cp.token,mode:'auto'}));
 assert.equal(replay.granted,false,'uncertain delivery cannot create a second auto attempt');
 assert.equal(f.app.tools.relayKeeper.stats().real_trials,0);
});


test('1049 production: native rejection, pilot disabling and global automation stop all remove pending permits',async t=>{
 const f=await fixture(t);await f.activate();
 const a=await f.begin('reject'),x=await f.checkpoint(a);
 assert.equal((await f.app.handle('/api/tasks/reject',{id:a})).ok,true);
 assert.equal(f.viewLocal(a,x.token).state,'cancelled');

 const b=await f.begin('pilot_off'),y=await f.checkpoint(b);
 await f.app.handle('/api/settings',{relay_pilot_enable:false});
 assert.equal(f.app.tools.relayKeeper.installationEligible,false);
 assert.equal(f.viewLocal(b,y.token).state,'cancelled');
 f.ok(await f.rpc('task_stop',{task_id:b}));

 await f.activate();
 const c=await f.begin('global_stop'),z=await f.checkpoint(c);
 assert.equal((await f.app.handle('/api/automation/stop',{})).stopped,true);
 assert.equal(f.viewLocal(c,z.token).state,'cancelled');
 assert.equal(f.app.tools.relayKeeper.stats().real_trials,0);
});
