import {storeTestDistribution,manifestStoreTestHelper} from '../support/chrome-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ChromeTransport} from '../../app/v08/chrome-transport.mjs';
import {fixture,waitFor} from './1070-chrome-server-fixture.mjs';

const diskFull=()=>{throw Object.assign(Error('Synthetic disk full'),{code:'ENOSPC'});};
const diskSettings=app=>JSON.parse(fs.readFileSync(path.join(app.state.dir,'desktop.json'),'utf8'));
async function isolated(t,options={}){
 const f=fixture(t,{chromeDistribution:storeTestDistribution(),preference:'none',browser:true,statePatch:{mode:'full',full_access_confirmed:true,terminal_enabled:true,desktop_enabled:true},...options});
 const app=await f.building;
 t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 return {...f,app};
}
function pendingTerminal(app,task){
 // Only propose a command; never approve or spawn it.
 const {job_id}=app.queue.propose({request_id:randomUUID(),program:process.execPath,args:['-e',''],cwd:'.'});
 const job=app.queue.get(job_id);assert.equal(job.status,'pending_approval');assert.equal(job.child,undefined);
 task.jobs.push(job_id);app.policy.jobOwners.set(job_id,task.id);
 const input={id:randomUUID(),job_id,status:'pending_approval'};app.queue.inputs.set(input.id,input);
 return {job,input};
}
function begin(app){const view=app.policy.begin({request_id:randomUUID(),title:'Isolated persistence revocation'},'chatgpt');return app.policy.get(view.task_id);}
function pendingBrowser(app,root,backend,task){
 const browser=app.tools.automation.browser;app.state.data.browser_backend=backend;
 if(backend==='extension'){
  const ext=browser.extension,session=randomUUID();
  // The fake native peer includes its packaged hello on every poll, just like background.js.
  const next=ext.next.bind(ext);ext.next=(id,helper,...rest)=>next(id,helper??manifestStoreTestHelper(),...rest);
  ext.heartbeat(session);ext.noteHelper(session,manifestStoreTestHelper());ext.pauseRequested=false;
  const pending=ext.request('tabs',{},'chatgpt',task.id);assert.equal(ext.next(session).kind,'request');
  return {pending,count:()=>ext.pending.size};
 }
 const personal=browser.personal,transport=new ChromeTransport({workspace:path.join(root,'fake-transport')});
 personal.chromeInfo=()=>({installed:true,supported:true,major:144});transport.start=async()=>transport;transport.isRunning=()=>true;transport.send=()=>{};transport.tools=[{name:'list_pages'}];personal.t=transport;personal.phase='connected';
 return {pending:personal.tabs({task_id:task.id,action:'list'},'chatgpt'),count:()=>transport.pending.size};
}

for(const route of ['/api/access','/api/automation/stop'])test(`${route} stops runtime authority and in-flight work before a failed save`,async t=>{
 const f=await isolated(t,{preference:'tunnel'}),{app}=f;
 await waitFor(()=>f.calls.starts===1);f.calls.cloud='up';await app.snapshot();
 assert.equal(app.policy.enabled,true);
 const task=begin(app),{job,input}=pendingTerminal(app,task),browser=pendingBrowser(app,f.root,'extension',task),computer=app.tools.automation.computer;
 computer.heartbeat({accessibility:true,screen_recording:true});
 const desktop=computer.request('applications',{},task.id,'chatgpt');
 const outcomes=Promise.allSettled([browser.pending,desktop]);
 const save=app.state.save.bind(app.state);t.after(()=>{app.state.save=save;});app.state.save=diskFull;
 const result=await f.post(route,route==='/api/access'?{enabled:false}:{});
 assert.equal(result.status,400);assert.equal(result.body.error.code,'ENOSPC');
 assert.equal(app.state.data.access_enabled,false);assert.equal(app.policy.enabled,false);assert.equal(app.policy.fullArmed,false);assert.equal(app.store.paused,true);assert.equal(app.store.writesEnabled,false);
 assert.throws(()=>app.policy.check(),{code:'LOCAL_DISABLED'});
 assert.equal(task.status,'paused');assert.equal(job.status,'cancelled');assert.equal(input.status,'cancelled');
 for(const outcome of await outcomes){assert.equal(outcome.status,'rejected');assert.equal(outcome.reason.code,'TASK_REVOKED');}
 assert.equal(browser.count(),0);assert.equal(computer.pending.size,0);
 app.state.save=save;
 assert.equal(diskSettings(app).access_enabled,true,'the injected save failure must really leave old disk state');
 // The existing connection becoming healthy and a trusted upgrade callback
 // must both respect the explicit runtime pause, even when its save failed.
 f.calls.cloud='checking';await app.snapshot();f.calls.cloud='up';await app.snapshot();f.updateDeps.finishUpgrade();
 assert.equal(app.policy.enabled,false);assert.equal(app.store.paused,true);
 assert.equal((await f.post('/api/access',{enabled:false})).status,200);
 assert.equal(diskSettings(app).access_enabled,false,'retry must save despite the already-false in-memory flag');
 assert.equal((await f.post('/api/access',{enabled:true})).status,200);
 assert.equal(app.policy.enabled,true);assert.equal(app.store.paused,false);assert.equal(diskSettings(app).access_enabled,true);
});

for(const capability of ['terminal','browser-extension','browser-personal','desktop'])test(`settings ${capability} disable cancels in-flight work despite a failed save`,async t=>{
 const f=await isolated(t),{app}=f,task=begin(app),key=capability.startsWith('browser')?'browser_enabled':capability+'_enabled';
 let checkStopped,outcome;
 if(capability==='terminal'){
  const {job,input}=pendingTerminal(app,task);checkStopped=()=>{assert.equal(job.status,'cancelled');assert.equal(input.status,'cancelled');};
 }else if(capability.startsWith('browser')){
  const browser=pendingBrowser(app,f.root,capability.split('-')[1],task);
  outcome=browser.pending.then(()=>assert.fail('disabled browser operation resolved'),error=>{assert.equal(error.code,'TASK_REVOKED');assert.equal(error.message,'浏览器控制已关闭');assert.equal(error.details.do_not_replay,true);assert.equal(error.details.replay_safe,false);});
  await waitFor(()=>browser.count()===1);checkStopped=()=>assert.equal(browser.count(),0);
 }else{
  const computer=app.tools.automation.computer;computer.heartbeat({accessibility:true,screen_recording:true});
  outcome=computer.request('applications',{},task.id,'chatgpt').then(()=>assert.fail('disabled desktop operation resolved'),error=>assert.equal(error.code,'TASK_REVOKED'));
  checkStopped=()=>assert.equal(computer.pending.size,0);
 }
 const grants=[];const revoke=app.tools.confirmations.revoke.bind(app.tools.confirmations);t.mock.method(app.tools.confirmations,'revoke',(...args)=>{grants.push(args);return revoke(...args);});
 const save=app.state.save.bind(app.state);t.after(()=>{app.state.save=save;});
 app.state.save=()=>{checkStopped();assert.ok(grants.some(([gate,id])=>gate==='capability'&&id===key.split('_')[0]));diskFull();};
 const result=await f.post('/api/settings',{[key]:false});
 assert.equal(result.status,400);assert.equal(result.body.error.code,'ENOSPC');assert.equal(app.state.data[key],false);checkStopped();await outcome;
 app.state.save=save;
 assert.equal(diskSettings(app)[key],true);
 f.updateDeps.finishUpgrade();assert.equal(app.state.data[key],false,'connection reconciliation cannot reopen a disabled capability');
 assert.equal((await f.post('/api/settings',{[key]:false})).status,200);
 assert.equal(diskSettings(app)[key],false);
 assert.equal(task.status,'active','category disable keeps the existing task identity');
});

for(const capability of ['browser-extension','browser-personal','desktop'])test(`permission revoke ${capability} starts cancellation before a failed save and keeps recovery fenced`,async t=>{
 const f=await isolated(t),{app}=f,task=begin(app),id=capability.startsWith('browser')?'browser':'desktop',key=id+'_enabled';
 let checkStopped,outcome;
 if(id==='browser'){
  const browser=pendingBrowser(app,f.root,capability.split('-')[1],task);
  outcome=browser.pending.then(()=>assert.fail('revoked browser operation resolved'),error=>assert.equal(error.code,capability==='browser-personal'?'CHROME_CONNECTION_CLOSED':'TASK_REVOKED'));
  await waitFor(()=>browser.count()===1);checkStopped=()=>assert.equal(browser.count(),0);
 }else{
  const computer=app.tools.automation.computer;computer.heartbeat({accessibility:true,screen_recording:true});
  outcome=computer.request('applications',{},task.id,'chatgpt').then(()=>assert.fail('revoked desktop operation resolved'),error=>assert.equal(error.code,'TASK_REVOKED'));
  checkStopped=()=>assert.equal(computer.pending.size,0);
 }
 const save=app.state.save.bind(app.state);t.after(()=>{app.state.save=save;});
 let stoppedBeforeSave=false;
 app.state.save=()=>{try{checkStopped();stoppedBeforeSave=true;}catch{}diskFull();};
 const result=await f.post('/api/permissions/revoke',{gate:'capability',id});
 assert.equal(result.status,400);assert.equal(result.body.error.code,'REVOCATION_PERSISTENCE_FAILED');
 assert.equal(stoppedBeforeSave,true);checkStopped();await outcome;
 assert.equal(app.state.data[key],false);assert.equal(app.policy.transitioning,true);assert.equal(task.status,'active');
 assert.throws(()=>app.policy.check(),{code:'PERMISSION_TRANSITION'});
 app.state.save=save;assert.equal(diskSettings(app)[key],true);
 f.updateDeps.finishUpgrade();assert.equal(app.state.data[key],false);assert.equal(app.policy.transitioning,true);
 const denied=await f.post('/api/settings',{[key]:true});assert.equal(denied.body.error.code,'PERMISSION_TRANSITION');
 const retry=await f.post('/api/permissions/revoke',{gate:'capability',id});
 assert.equal(retry.status,200);assert.equal(retry.body.ok,true);assert.equal(retry.body.undo,null);assert.equal(app.policy.transitioning,false);assert.equal(diskSettings(app)[key],false);
});
