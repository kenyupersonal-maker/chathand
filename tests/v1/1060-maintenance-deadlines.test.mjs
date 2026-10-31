import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DeadlineScheduler} from '../../app/v1/deadline-scheduler.mjs';
import {createDesktop} from '../../app/server.mjs';
import {ResumeKeeper} from '../../app/v1/resume.mjs';
import {ConnectionController} from '../../app/connection.mjs';
import {EventEmitter} from 'node:events';
import {blockedReceipt} from '../../app/v1/blocked.mjs';
class Clock{
 constructor(at=Date.now()){this.time=at;this.seq=0;this.timers=new Map();}
 now=()=>this.time;monotonicNow=()=>this.time;
 setTimeout=(fn,ms)=>{const id=++this.seq;this.timers.set(id,{at:this.time+ms,fn});return id;};clearTimeout=id=>this.timers.delete(id);
 async flush(){for(let i=0;i<12;i++)await Promise.resolve();}
 async advance(ms,{sleep=false}={}){const end=this.time+ms;let n=0;await this.flush();if(sleep)this.time=end;for(;;){const pair=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!pair)break;if(++n>300)throw Error('TIMER_STORM');const [id,t]=pair;this.timers.delete(id);if(!sleep)this.time=t.at;t.fn();await this.flush();}this.time=end;await this.flush();return n;}
}
test('one nearest timer, merged event rearrangement, cancellation and isolated source errors',async()=>{
 const clock=new Clock(0),errors=[],scheduler=new DeadlineScheduler({clock,onError:(_,name)=>errors.push(name)});let a=50,b=100;const calls=[];
 scheduler.add('a',{next:()=>a,run:()=>{calls.push('a');a=Infinity;}});scheduler.add('b',{next:()=>b,run:()=>{calls.push('b');b=Infinity;}});
 await clock.flush();assert.equal(clock.timers.size,1);b=20;scheduler.changed('b');scheduler.changed('b');await clock.advance(20);assert.deepEqual(calls,['b']);assert.equal(clock.timers.size,1);
 scheduler.add('bad',{next:()=>{throw Error('fixture');},run:()=>{}});await clock.advance(30);assert.deepEqual(calls,['b','a']);assert.deepEqual(errors,['bad']);assert.equal(clock.timers.size,0);scheduler.close();
});
test('sleep performs one due run and async work stays single-flight; close fences its late completion',async()=>{
 const clock=new Clock(0),scheduler=new DeadlineScheduler({clock});let due=100,n=0,release;
 scheduler.add('periodic',{next:()=>due,run:()=>{n++;due=clock.now()+100;}});await clock.advance(10000,{sleep:true});assert.equal(n,1);
 scheduler.add('probe',{next:()=>0,run:()=>new Promise(r=>{n++;release=r;})});await clock.advance(0);scheduler.changed('probe');await clock.advance(20);assert.equal(n,2);
 scheduler.close();release();await clock.flush();assert.equal(clock.timers.size,0);await clock.advance(10000);assert.equal(n,2);
});
test('controller deadlines preserve original 45 second episode through process replacement',async()=>{
 const clock=new Clock(1000),scheduler=new DeadlineScheduler({clock});let stops=0;const tunnel={child:{},key:'synthetic',stop(){this.child=null;stops++;},start(){this.child={};},doctor:async()=>({ok:true})};
 const controller=new ConnectionController({tunnel,state:{data:{},save(){}},clock:clock.now});controller.desired=true;controller.phase='ready';controller.watchCloud({state:'checking',down_since:1000});
 scheduler.add('controller',{next:()=>scheduler.wallAt(controller.nextDeadline()),run:()=>controller.monitor()});controller.onDeadlineChange=()=>scheduler.changed('controller');
 await clock.advance(29999);tunnel.child={};controller.watchCloud({state:'checking',down_since:clock.now()});scheduler.changed('controller');await clock.advance(15000);assert.equal(stops,0);await clock.advance(1);assert.equal(stops,1);assert.equal(controller.cloudEpisode.since,1000);assert.equal(controller.cloudEpisode.next,106000);
 scheduler.close();controller.stop({persist:false});
});
test('stall deadline is strict, pending/normal-end cancel it and notification is once',()=>{
 let now=1000;const notices=[],resume=new ResumeKeeper({now:()=>now,emit:(kind,data)=>notices.push({kind,...data})});const task={task_id:'task',status:'active',session_hash:'session',model:'unknown'};
 resume.before('session','begin_task',{});resume.after('session','begin_task',{},task);assert.equal(resume.nextStallAt(task),601001);now=601000;assert.equal(resume.stall(task).stalled,false);now++;assert.equal(resume.stall(task).stalled,true);assert.equal(resume.nextStallAt(task),Infinity);resume.stall(task);assert.equal(notices.length,1);
 resume.before('session','write_text',{task_id:'task'});assert.equal(resume.nextStallAt(task),Infinity);resume.after('session','finish_task',{task_id:'task'},{});assert.equal(resume.nextStallAt(task),Infinity);
});
test('desktop idle has no maintenance timer; completed jobs notify once and retention arms only until due',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1060-deadlines-')),clock=new Clock(),realNow=Date.now;let app;
 try{Date.now=clock.now;app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),clientDeps:{maintenanceClock:clock}});}finally{Date.now=realNow;}
 t.after(async()=>{await app?.close();fs.rmSync(root,{recursive:true,force:true});});
 app.tools.resume.now=clock.now;app.tools.relayKeeper.now=clock.now;app.queue.retentionClock={...app.queue.retentionClock,now:clock.now};
 await clock.advance(0);assert.equal(app.queue.retentionTimer,null);assert.equal(clock.timers.size,0);
 const j={id:'finished-fixture',request_id:'finished-fixture',stamp:'fixture',status:'completed',created_at:clock.now(),finished_at:clock.now(),exit_code:0,args:[],events:[{cursor:0,stream:'stdout',text:Array(100).fill('fixture line\n').join('')}],next_cursor:1,base_cursor:0,kept_bytes:1300};
 app.queue.jobs.set(j.id,j);app.queue.record(j);app.queue.record(j);await clock.advance(0);assert.equal(app.policy.events.filter(e=>e.kind==='command_finished').length,1);assert.equal(clock.timers.size,1);
 await clock.advance(600001);assert.equal(j.output_retention.applied,true);assert.equal(app.policy.events.filter(e=>e.kind==='command_finished').length,1);assert.equal(clock.timers.size,0);
});
test('disabled feature receipts point to App settings without creating an approval flow',()=>{const r=blockedReceipt({kind:'can_enable',id:'browser',path:'设置 > 浏览器'});assert.equal(r.answer_in_chat,false);assert.equal(r.confirm,null);assert.equal(r.next.includes('request_permission'),false);assert.ok(r.say_to_user[2].includes('设置 > 浏览器'));});
async function connectionDesktop(t,{pending=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1060-health-')),clock=new Clock(),start=clock.now();let probes=0,resolveProbe,stops=0;
 const child=new EventEmitter();child.pid=0;const tunnel={child,doctorChild:null,key:'fixture',tunnelId:'fixture',log:[],status:'running',configure(){},doctor:async()=>({ok:true}),start(){this.child={pid:0};},stop(){stops++;this.child=null;},snapshot:async()=>{probes++;if(pending)await new Promise(r=>resolveProbe=r);return {healthy:true,ready:true,process_running:true,control_plane:{state:'checking',down_since:start,checked_at:clock.now()}};}};
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),clientDeps:{maintenanceClock:clock,tunnelFactory:()=>tunnel,credentials:{get:()=>null,set(){},remove(){},status:()=>({}),publicStatus:()=>({})}}});
 t.after(async()=>{resolveProbe?.();await app.close();fs.rmSync(root,{recursive:true,force:true});});app.controller.desired=true;app.controller.phase='ready';app.controller.watchCloud({state:'checking',down_since:start});
 return {app,clock,start,tunnel,probes:()=>probes,stops:()=>stops,release:()=>{pending=false;resolveProbe?.();}};
}
test('server schedules display 15/120 and restart 45 independently of 5s idle health observations',async t=>{
 const f=await connectionDesktop(t),{app,clock,start}=f;await clock.advance(5000);assert.equal(f.probes(),1);
 assert.equal(app.maintenance.sources.get('display').at,start+15000);assert.equal(app.maintenance.sources.get('controller').at,start+45000);
 await clock.advance(9999);assert.equal(f.stops(),0);await clock.advance(1);assert.equal(app.maintenance.sources.get('display').at,start+120000);
 await clock.advance(29999);assert.equal(f.stops(),0);await clock.advance(1);assert.equal(f.stops(),1);assert.equal(app.controller.cloudEpisode.since,start);assert.equal(app.controller.cloudEpisode.next,start+105000);
 // A fresh process/health sample does not shift the 120s display boundary.
 await clock.advance(5000);assert.equal(app.maintenance.sources.get('display').at,start+120000);
});
test('server health is single-flight and a close fences the pending observation',async t=>{
 const f=await connectionDesktop(t,{pending:true}),{app,clock}=f;let observed=0;const original=app.controller.observe.bind(app.controller);app.controller.observe=value=>{observed++;return original(value);};
 await clock.advance(5000);assert.equal(f.probes(),1);await clock.advance(20000);assert.equal(f.probes(),1);const closing=app.close();f.release();await clock.flush();await closing;assert.equal(observed,0);assert.equal(clock.timers.size,0);
});
test('queue overdue approvals and task idle expiry remain exact and live work prevents idle closure',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1060-idle-')),clock=new Clock(),app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),clientDeps:{maintenanceClock:clock}});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});app.tools.resume.now=clock.now;app.tools.relayKeeper.now=clock.now;
 const task=await app.tools.invoke('begin_task',{request_id:'idle-task-0001',title:'idle'}),record=app.policy.get(task.task_id);record.created_at=clock.now();
 const j={id:'approval-fixture',request_id:'approval-fixture',stamp:'fixture',status:'pending_approval',created_at:clock.now(),args:[],events:[],next_cursor:0,base_cursor:0};app.queue.jobs.set(j.id,j);record.jobs.push(j.id);app.queue.record(j);
 const originalNow=Date.now;try{Date.now=clock.now;await clock.advance(600000);assert.equal(j.status,'pending_approval');await clock.advance(1);assert.equal(j.status,'expired');
  j.status='running';app.queue.record(j);await clock.advance(3*3600000);assert.equal(record.status,'active');
  j.status='completed';j.finished_at=clock.now();j.exit_code=0;app.queue.record(j);await clock.advance(0);assert.equal(record.status,'expired');
 }finally{Date.now=originalNow;}
});
test('legacy owner polling remains PID-only at 1s and owner exit closes the scheduler once',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch1060-owner-')),clock=new Clock(),oldPid=process.env.KEN_BRIDGE_OWNER_PID,kill=process.kill;let app,checks=0;
 try{process.env.KEN_BRIDGE_OWNER_PID='2147483000';app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:path.join(root,'work'),clientDeps:{maintenanceClock:clock}});}finally{if(oldPid===undefined)delete process.env.KEN_BRIDGE_OWNER_PID;else process.env.KEN_BRIDGE_OWNER_PID=oldPid;}
 t.after(async()=>{process.kill=kill;await app.close();fs.rmSync(root,{recursive:true,force:true});});
 process.kill=(pid,signal)=>{if(pid===2147483000){checks++;throw Object.assign(Error('fixture exited'),{code:'ESRCH'});}return kill(pid,signal);};
 try{await clock.advance(999);assert.equal(checks,0);await clock.advance(1);assert.equal(checks,1);assert.equal(app.maintenance.closed,true);await app.close();assert.equal(clock.timers.size,0);}finally{process.kill=kill;}
});

test('child-close event starts bounded degraded observation without a zero-delay controller loop',async t=>{
 const f=await connectionDesktop(t),{app,clock,tunnel}=f;await clock.advance(0);const child=tunnel.child;tunnel.child=null;child.emit('close',1);
 const ticks=await clock.advance(10000);assert.ok(ticks<40);assert.ok(f.probes()>=3);assert.equal(f.stops(),1);assert.equal(app.controller.phase,'reconnecting');
});
