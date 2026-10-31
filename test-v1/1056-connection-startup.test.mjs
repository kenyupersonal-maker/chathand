import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ConnectionController} from '../app/connection.mjs';
import {DiagnosticEvents,connectionStartupCode} from '../app/diagnostic-events.mjs';
import {TunnelManager} from '../engine/src/tunnel.mjs';
import {CredentialStore} from '../app/credentials.mjs';
import {FILE_WRITE_LOCK,REVISION_FILE} from '../app/credential-revision.mjs';
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ch1056-connection-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t){
 const dir=temp(t),checks=[],calls={starts:0,stops:0,ready:0};let now=0;
 const events=new DiagnosticEvents(dir,{salt:Buffer.alloc(32),now:()=>now});
 const tunnel={key:'synthetic-fixture',child:null,doctorChild:null,configure(){},start(){calls.starts++;this.child={pid:0};},stop(){calls.stops++;this.child=null;this.doctorChild=null;},doctor(){const d=deferred();checks.push(d);return d.promise;}};
 const c=new ConnectionController({tunnel,state:{data:{},save(){}},events,clock:()=>now,onReady:()=>calls.ready++});
 return {c,tunnel,events,calls,checks,at:v=>now=v};
}
test('1056 synthetic: run starts while doctor is pending; ready arrives at 800ms and 30s timeout cannot remove it',async t=>{
 const f=fixture(t);f.c.configureAndConnect();await f.c.busy;assert.equal(f.calls.starts,1);assert.equal(f.checks.length,1);assert.equal(f.c.phase,'running');
 f.at(800);f.c.observe({healthy:true,ready:true});assert.equal(f.c.phase,'ready');assert.equal(f.calls.ready,1);
 f.at(30000);f.checks[0].resolve({ok:false,timed_out:true});await f.c.doctorPending;assert.equal(f.c.phase,'ready');assert.equal(f.calls.stops,0);assert.equal(f.c.attempts,0);
 assert.ok(f.events.startupSnapshot().some(e=>e.stage==='healthy'&&e.ms===800));assert.ok(f.events.startupSnapshot().some(e=>e.stage==='doctor'&&e.outcome==='timeout'&&e.ms===30000));
});
test('1056 doctor authentication result only explains a failed connection and cannot retract a healthy one',async t=>{
 for(const healthy of [true,false]){
  const f=fixture(t);f.c.configureAndConnect();await f.c.busy;if(healthy)f.c.observe({healthy:true,ready:true});f.checks[0].resolve({ok:false,auth_failed:true});await f.c.doctorPending;
  assert.equal(f.calls.stops,0);assert.equal(f.c.phase,healthy?'ready':'running');
  if(!healthy){f.at(15001);f.c.observe({healthy:false,ready:false});assert.equal(f.c.phase,'needs_login');assert.equal(f.c.errorCode,'CONNECTION_AUTH_FAILED');assert.equal(f.calls.stops,1);f.c.healthy();assert.equal(f.c.phase,'needs_login');}
 }
});
test('1056 restart and stop invalidate late doctor results; parallel diagnostic never blocks a restart',async t=>{
 const f=fixture(t);f.c.configureAndConnect();await f.c.busy;const first=f.c.doctorPending;f.tunnel.doctorChild={pid:0};assert.equal(f.c.restart('user'),true);
 f.at(1500);f.c.tick();await f.c.busy;assert.equal(f.calls.starts,2);f.c.observe({healthy:true,ready:true});f.checks[0].resolve({ok:false,auth_failed:true});await first;assert.equal(f.c.phase,'ready');assert.equal(f.calls.stops,1);
 f.c.stop({persist:false});f.checks[1].resolve({ok:true});await f.c.doctorPending;assert.equal(f.c.phase,'idle');assert.equal(f.tunnel.child,null);assert.equal(f.calls.starts,2);
});
test('1056 exited run cancels pending doctor promptly and uses normal retry backoff',async t=>{
 const f=fixture(t);f.c.configureAndConnect();await f.c.busy;f.tunnel.child=null;f.tunnel.doctorChild={pid:0};f.at(100);f.c.tick();assert.equal(f.c.phase,'reconnecting');assert.equal(f.c.nextAttempt,2100);assert.equal(f.calls.stops,1);
 f.at(2099);f.c.tick();assert.equal(f.calls.starts,1);f.at(2100);f.c.tick();await f.c.busy;assert.equal(f.calls.starts,2);
 for(const d of f.checks)d.resolve({ok:false});await flush();
});
function manager(t){
 const dir=temp(t),children=[],timers=[];let now=0;
 const m=new TunnelManager(dir,'http://127.0.0.1:1/mcp','synthetic-token',{clock:()=>now,spawnChild:(_file,args)=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.args=args;children.push(c);return c;},timers:{setTimeout(fn,ms){const v={fn,ms};timers.push(v);return v;},clearTimeout(timer){timer.cleared=true;}}});
 m.key='sk-synthetic-fixture';m.binary='synthetic';m.status='configured';m.environment=()=>({});const killed=[];m.terminate=c=>{if(c)killed.push(c);};
 return {m,children,timers,killed,at:v=>now=v};
}
test('1056 TunnelManager starts configured run without DOCTOR_REQUIRED and runs doctor concurrently',async t=>{
 const f=manager(t),{m}=f;m.start();const run=m.child;run.emit('spawn');const checking=m.doctor();const doctor=m.doctorChild;
 assert.ok(run&&doctor);assert.equal(m.status,'running');await assert.rejects(()=>m.doctor(),{code:'TUNNEL_RUNNING'});
 doctor.emit('close',1);assert.equal((await checking).ok,false);assert.equal(m.status,'running');assert.equal(m.child,run);
});
test('1056 TunnelManager also allows run during an existing doctor; doctor timeout leaves run intact',async t=>{
 const {m,timers,killed}=manager(t),checking=m.doctor(),doctor=m.doctorChild;m.start();const run=m.child;run.emit('spawn');assert.equal(timers[0].ms,30000);timers[0].fn();assert.deepEqual(killed,[doctor]);doctor.emit('close',null);const r=await checking;assert.equal(r.timed_out,true);assert.equal(m.child,run);assert.equal(m.status,'running');assert.equal(timers[0].cleared,true);
});
test('1056 current run 401/403 remains an authentication failure regardless of doctor result',async t=>{
 for(const status of [401,403]){
  const f=manager(t),c=new ConnectionController({tunnel:f.m,state:{data:{},save(){}}});c.configureAndConnect();await c.busy;
  f.m.child.stdout.write(JSON.stringify({target:'control_plane',fields:{state:'down',code:'HTTP_'+status,message:'PRIVATE_SENTINEL'}})+'\n');
  c.observe({healthy:true,ready:true});assert.equal(c.phase,'needs_login');assert.equal(c.errorCode,'CONNECTION_AUTH_FAILED');assert.equal(c.blocked,true);assert.equal(f.killed.length,2);assert.equal(JSON.stringify(f.m.log).includes('PRIVATE_SENTINEL'),false);
  f.m.doctorChild.emit('close',0);await c.doctorPending;
 }
});
test('1056 stop terminates both children; late old output/close cannot clobber replacement generation',async t=>{
 const {m,killed}=manager(t);m.start();const oldRun=m.child;const check=m.doctor(),oldDoctor=m.doctorChild;m.stop();assert.deepEqual(killed,[oldRun,oldDoctor]);
 // Simulate the old process handles being reaped before delayed close delivery.
 m.child=null;m.doctorChild=null;m.start();const run=m.child;run.emit('spawn');m.healthUrl='synthetic-current';
 oldDoctor.stdout.write('HTTP_403 forbidden PRIVATE_SENTINEL\n');oldRun.stdout.write('HTTP_401 PRIVATE_SENTINEL\n');oldRun.emit('close',1);oldDoctor.emit('close',1);
 assert.equal((await check).cancelled,true);assert.equal(m.child,run);assert.equal(m.status,'running');assert.equal(m.healthUrl,'synthetic-current');assert.equal(m.runAuthFailed,false);assert.equal(m.doctorAuthFailed,false);assert.equal(m.log.length,0);
});
test('1056 strict startup events expose only fixed enums, nonnegative integers and sanitized bounded memory',t=>{
 const dir=temp(t),events=new DiagnosticEvents(dir,{salt:Buffer.alloc(32)});
 events.record('conn.startup',{stage:'doctor',outcome:'timeout',source:'tunnel',code:'DOCTOR_TIMEOUT',ms:30000,n:1,error:'PRIVATE_SENTINEL',url:'https://PRIVATE_SENTINEL',key:'PRIVATE_SENTINEL'});
 events.record('conn.startup',{stage:'PRIVATE_SENTINEL',outcome:'PRIVATE_SENTINEL',source:'PRIVATE_SENTINEL',code:'PRIVATE_SENTINEL',ms:-1,n:1.5});
 assert.equal(connectionStartupCode('PRIVATE_SENTINEL'),'UNKNOWN');let rows=events.startupSnapshot();assert.equal(rows[0].code,'DOCTOR_TIMEOUT');assert.deepEqual(Object.keys(rows[1]).sort(),['at','kind']);rows[0].code='PRIVATE_SENTINEL';assert.equal(events.startupSnapshot()[0].code,'DOCTOR_TIMEOUT');
 const c=new ConnectionController({tunnel:{},state:{data:{}},events});assert.ok(c.snapshot().startup_timing.length);assert.equal(JSON.stringify(c.snapshot()).includes('PRIVATE_SENTINEL'),false);
 assert.equal(fs.readFileSync(path.join(dir,'diagnostics/events.jsonl'),'utf8').includes('PRIVATE_SENTINEL'),false);
 for(let i=0;i<110;i++)events.record('conn.startup',{stage:'attempt',outcome:'begin',ms:i});assert.equal(events.startupSnapshot().length,100);
});
test('1056 synthetic credential committed reads bypass writer lock; missing revision may wait and fail CREDENTIAL_BUSY',t=>{
 const dir=temp(t),store=new CredentialStore(dir,{lockTimeoutMs:20});store.set('tunnel',{synthetic:true});store.invalidate();
 const lock=path.join(dir,FILE_WRITE_LOCK),token=crypto.randomUUID();fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,`${process.pid}-${token}`),JSON.stringify({pid:process.pid,token}),{mode:0o600});
 const underLock=store._underLock;store._underLock=()=>assert.fail('committed cold read must not acquire writer lock');assert.deepEqual(store.get('tunnel'),{synthetic:true});
 store._underLock=underLock;fs.unlinkSync(path.join(dir,REVISION_FILE));store.invalidate();const at=Date.now();assert.throws(()=>store.get('tunnel'),{code:'CREDENTIAL_BUSY'});assert.ok(Date.now()-at>=20);assert.ok(fs.existsSync(lock),'live writer is never displaced by age');
});
test('1056 real isolated child fixture: doctor health output cannot replace run readiness; stop reaps both groups',async t=>{
 const dir=temp(t),binary=path.join(dir,'fixture-tunnel.mjs');
 fs.writeFileSync(binary,'#!'+process.execPath+'\n'+`import fs from 'node:fs';import http from 'node:http';
const args=process.argv.slice(2),profile=fs.readFileSync(args[args.indexOf('--config')+1],'utf8');const file=JSON.parse(profile.match(/url_file: (.+)/)[1]);
if(args[0]==='doctor'){fs.writeFileSync(file,'http://127.0.0.1:1');setInterval(()=>{},1000);}
else{const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({components:{'control-plane':{status:'ok'}}}));});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(file,'http://127.0.0.1:'+server.address().port));}
`,{mode:0o700});
 const m=new TunnelManager(dir,'http://127.0.0.1:1/mcp','synthetic-token'),c=new ConnectionController({tunnel:m,state:{data:{},save(){}}});
 c.configureAndConnect({tunnel_id:'tunnel_'+'a'.repeat(32),api_key:'sk-synthetic-fixture-only',binary});await c.busy;const children=[m.child,m.doctorChild];
 t.after(()=>m.stop());assert.notEqual(m.profile,m.doctorProfile);assert.notEqual(m.healthFile,m.doctorHealthFile);
 const deadline=Date.now()+3000;while((!fs.existsSync(m.healthFile)||!fs.existsSync(m.doctorHealthFile))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.ok(fs.existsSync(m.doctorHealthFile));const health=await m.snapshot();assert.equal(health.healthy,true);assert.equal(health.ready,true);c.observe(health);assert.equal(c.phase,'ready');assert.ok(m.doctorChild,'doctor is still pending after readiness');
 const closed=children.map(child=>new Promise(resolve=>child.once('close',resolve)));c.stop({persist:false});await Promise.all(closed);await c.doctorPending;assert.equal(m.child,null);assert.equal(m.doctorChild,null);for(const child of children)assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});
test('1056 real isolated stdout 401/403/unauthorized rejects failed transport and never retries authorization',async t=>{
 for(const message of ['HTTP 401','HTTP 403','unauthorized']){
  const dir=temp(t),binary=path.join(dir,'fixture-auth.mjs'),counter=path.join(dir,'attempts');
  fs.writeFileSync(binary,'#!'+process.execPath+'\n'+`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(counter)},'x');console.log(${JSON.stringify(JSON.stringify({target:'control_plane',fields:{message:message+' PRIVATE_SENTINEL'}}))});process.exit(1);\n`,{mode:0o700});
  const m=new TunnelManager(dir,'http://127.0.0.1:1/mcp','synthetic-token');let now=0;const c=new ConnectionController({tunnel:m,state:{data:{},save(){}},clock:()=>now});c.configureAndConnect({tunnel_id:'tunnel_'+'a'.repeat(32),api_key:'sk-synthetic-fixture-only',binary});await c.busy;
  const run=m.child;await new Promise(resolve=>run.once('close',resolve));await c.doctorPending;c.monitor();assert.equal(c.phase,'needs_login',message);assert.equal(c.errorCode,'CONNECTION_AUTH_FAILED');assert.equal(c.blocked,true);assert.equal(m.runAuthFailed,true);assert.equal(JSON.stringify(m.log).includes('PRIVATE_SENTINEL'),false);
  c.watchCloud({state:'down',down_since:now});now=1_000_000;c.monitor();assert.equal(fs.readFileSync(counter,'utf8'),'xx','one run and one doctor; no automatic authorization retry');c.stop({persist:false});
 }
});
