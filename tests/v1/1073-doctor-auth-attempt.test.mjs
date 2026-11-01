import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {pathToFileURL} from 'node:url';
const sourceRoot=process.env.CHATHAND_DOCTOR_AUTH_SOURCE_ROOT||path.resolve(new URL('../..',import.meta.url).pathname);
const {TunnelManager}=await import(pathToFileURL(path.join(sourceRoot,'engine/src/tunnel.mjs')));
const {ConnectionController}=await import(pathToFileURL(path.join(sourceRoot,'app/connection.mjs')));
const {fixture:serverFixture}=await import(pathToFileURL(path.join(sourceRoot,'tests/v1/1070-chrome-server-fixture.mjs')));
const authLine=JSON.stringify({target:'control_plane',fields:{state:'down',code:'HTTP_401'}})+'\n';
const details={components:{'control-plane':{status:'ok'}}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test.beforeEach(t=>t.mock.method(globalThis,'fetch',async()=>{throw Error('NETWORK_FORBIDDEN_IN_SYNTHETIC_TEST');}));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-doctor-auth-'));let now=1000000;
 const children=[],events=[];
 const m=new TunnelManager(dir,'http://127.0.0.1:1/mcp','synthetic-only',{clock:()=>now,events:{record:(kind,data)=>events.push({kind,...data})},timers:{setTimeout:fn=>({fn}),clearTimeout(){}},spawnChild:(_file,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.command=args[0];children.push(child);return child;}});
 m.environment=()=>({});m.key='sk-synthetic-fixture-only';m.binary='/synthetic-not-executed';m.tunnelId='tunnel_'+'0'.repeat(32);
 const c=new ConnectionController({tunnel:m,state:{data:{},save(){}},clock:()=>now,events:{record:(kind,data)=>events.push({kind,...data})}});
 const close=child=>{if(child&&!child.closed){child.closed=true;child.stdout.end();child.stderr.end();child.emit('close',1);}};
 t.after(()=>{c.stop({persist:false});for(const child of children){close(child);child.stdout.destroy();child.stderr.destroy();}fs.rmSync(dir,{recursive:true,force:true});});
 const f={m,c,dir,children,events,now:()=>now,advance:ms=>now+=ms,close,
  async begin(){c.configureAndConnect();m.child.emit('spawn');await c.busy;},
  async doctor({auth=false,code=0}={}){const d=m.doctorChild;assert.ok(d);if(auth)d.stdout.write(authLine);d.stdout.end();d.stderr.end();d.closed=true;d.emit('close',code);await c.doctorPending;},
  local(){c.observe({healthy:true,ready:true,control_plane:{state:'unknown',status:'unreachable'}});},
  cloud(){const cp=m.observeControlPlane(details,now);c.observe({healthy:true,ready:true,control_plane:cp});return cp;},
  outage(){for(const ms of [1000,5000,6000]){now+=ms;c.observe({healthy:false,ready:false});}close(m.child);},
  startupFailure(){close(m.child);now+=16000;c.observe({healthy:false,ready:false});},
  async next(){close(m.child);close(m.doctorChild);now=Math.max(now,c.nextAttempt);c.tick();await c.busy;},
 };
 return f;
}
const reconnecting=f=>{assert.equal(f.c.phase,'reconnecting');assert.equal(f.c.blocked,false);assert.ok(f.c.nextAttempt>f.now());assert.ok(Number.isFinite(f.c.nextDeadline()));};
const authBlocked=f=>{assert.equal(f.c.phase,'needs_login');assert.equal(f.c.blocked,true);assert.equal(f.c.errorCode,'CONNECTION_AUTH_FAILED');assert.equal(f.c.nextDeadline(),Infinity);assert.equal(f.c.retryOnce(),false);};

test('doctor exit 0 auth finding is retained diagnostically but superseded by this run cloud success',async t=>{
 const f=fixture(t);await f.begin();await f.doctor({auth:true});assert.equal(f.c.doctorResult.ok,true);assert.equal(f.c.doctorResult.auth_failed,true);
 f.local();f.advance(30000);f.cloud();f.outage();reconnecting(f);
 assert.ok(f.events.some(x=>x.stage==='doctor'&&x.source==='controller'&&x.outcome==='ok'&&x.code==='CONNECTION_AUTH_FAILED'));
});
test('late nonzero doctor auth finding cannot reactivate after this attempt authenticated call',async t=>{
 const f=fixture(t);await f.begin();f.local();assert.equal(f.c.authenticatedCallSucceeded(f.now(),{generation:f.c.generation,child:f.m.child}),true);
 await f.doctor({auth:true,code:1});assert.equal(f.c.doctorResult.auth_failed,true);f.outage();reconnecting(f);
});
test('current cloud up/ok confirms authentication independently of local readiness',async t=>{
 const f=fixture(t);await f.begin();await f.doctor({auth:true,code:1});
 f.c.observe({healthy:false,ready:false,control_plane:f.m.observeControlPlane(details,f.now())});
 assert.equal(f.c.phase,'running');f.startupFailure();reconnecting(f);
});
test('late doctor cannot upgrade an ordinary failure after independent success even outside ready phase',async t=>{
 const f=fixture(t);await f.begin();const d=deferred();f.m.doctor=()=>d.promise;
 await f.doctor();f.c.restart('fixture');await f.next();f.local();f.cloud();f.outage();reconnecting(f);
 d.resolve({ok:false,auth_failed:true});await f.c.doctorPending;assert.equal(f.c.doctorResult.auth_failed,true);reconnecting(f);
});
test('current run auth rejection wins over prior cloud success and a later authenticated callback',async t=>{
 for(const signal of ['HTTP_401','HTTP_403']){
  const f=fixture(t);await f.begin();await f.doctor();f.cloud();const proof={generation:f.c.generation,child:f.m.child};
  f.m.child.stdout.write(authLine.replace('HTTP_401',signal));f.c.observe({healthy:true,ready:true});authBlocked(f);
  assert.equal(f.m.runAuthFailed,true);assert.equal(f.m.authenticatedCallSucceeded(f.now()),false);assert.equal(f.c.authenticatedCallSucceeded(f.now(),proof),false);authBlocked(f);
 }
});
test('doctor auth still blocks a failed startup with no independent authentication',async t=>{
 const f=fixture(t);await f.begin();await f.doctor({auth:true,code:1});f.startupFailure();authBlocked(f);
});
test('late doctor still explains a failed unconfirmed attempt',async t=>{
 const f=fixture(t),d=deferred();f.m.doctor=()=>d.promise;await f.begin();f.startupFailure();reconnecting(f);
 d.resolve({ok:false,auth_failed:true});await f.c.doctorPending;authBlocked(f);
});
test('local readiness, reachable display or copied cloud JSON cannot retire doctor auth',async t=>{
 for(const kind of ['local','display','copied']){
  const f=fixture(t);await f.begin();await f.doctor({auth:true,code:1});
  if(kind==='local')f.local();
  else if(kind==='display'){f.c.recordCloud({state:'up',status:'ok'});f.local();}
  else f.c.observe({healthy:true,ready:true,control_plane:structuredClone(f.m.observeControlPlane(details,f.now()))});
  f.outage();if(f.c.phase==='running')f.startupFailure();authBlocked(f);
 }
});
test('old controller generation and exact old child call proofs cannot retire doctor auth',async t=>{
 for(const stale of ['generation','child']){
  const f=fixture(t);await f.begin();await f.doctor({auth:true,code:1});
  assert.equal(f.c.authenticatedCallSucceeded(f.now(),{generation:f.c.generation-(stale==='generation'?1:0),child:stale==='child'?{}:f.m.child}),false);
  f.startupFailure();authBlocked(f);
 }
});
test('successful authentication does not extend to the next attempt and old health objects stay old',async t=>{
 const f=fixture(t);await f.begin();await f.doctor({auth:true});const oldCP=f.cloud(),old={generation:f.c.generation,child:f.m.child};f.outage();reconnecting(f);
 await f.next();await f.doctor({auth:true,code:1});
 assert.equal(f.c.authenticatedCallSucceeded(f.now(),old),false);f.c.observe({healthy:true,ready:true,control_plane:oldCP});f.outage();authBlocked(f);
});
test('old child doctor completion and stdout cannot contaminate the replacement attempt',async t=>{
 const f=fixture(t);await f.begin();const oldDoctor=f.m.doctorChild,oldPending=f.c.doctorPending;
 f.c.restart('fixture');f.close(f.m.child);f.m.doctorChild=null;f.advance(1500);f.c.tick();await f.c.busy;
 oldDoctor.stdout.write(authLine);f.close(oldDoctor);await oldPending;assert.equal(f.c.doctorResult,null);assert.equal(f.m.doctorAuthFailed,false);
 await f.doctor();f.cloud();f.outage();reconnecting(f);
});
test('ordinary transport failure without authentication evidence keeps existing retry backoff',async t=>{
 const f=fixture(t);await f.begin();await f.doctor();f.cloud();f.outage();reconnecting(f);assert.equal(f.c.nextAttempt-f.now(),2000);
});
test('late health await cannot mutate or confirm a replacement TunnelManager child or generation',async t=>{
 for(const changed of ['child','generation']){
  const f=fixture(t);await f.begin();await f.doctor();f.m.healthUrl='http://127.0.0.1:1';const gate=deferred(),entered=deferred();
  t.mock.method(globalThis,'fetch',async()=>({ok:true}));f.m.healthDetails=async()=>{entered.resolve();return gate.promise;};
  const pending=f.m.snapshot();await entered.promise;
  if(changed==='child'){f.close(f.m.child);f.m.start();}else f.m.generation++;
  const current=f.m.cp;gate.resolve(details);const result=await pending;
  assert.equal(result.healthy,false);assert.equal(result.ready,false);assert.equal(result.control_plane,null);assert.equal(current.lastOkAt,0);
 }
});
async function server(t){
 const f=serverFixture(t,{preference:'none'}),a=await f.building;
 t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
 a.controller.configureAndConnect({tunnel_id:'synthetic-channel',api_key:'synthetic-only'});await a.controller.busy;await a.controller.doctorPending;
 return {f,a,c:a.controller};
}
test('real server health await fences controller generation and exact child before applying health',async t=>{
 for(const changed of ['generation','child'])await t.test(changed,async t=>{
  const {f,a,c}=await server(t),gate=deferred(),entered=deferred();
  f.tunnel.snapshot=async()=>{entered.resolve();return gate.promise;};
  const waiting=a.snapshot();await entered.promise;
  if(changed==='generation')c.generation++;else f.tunnel.child=new EventEmitter();
  gate.resolve({process_running:true,healthy:true,ready:true,control_plane:{state:'up',status:'ok'}});
  await waiting;assert.equal(c.phase,'running');assert.notEqual(c.attempt?.authenticated,true);assert.equal(c.lastCallSucceededAt,0);
 });
});
test('real server RPC await fences controller generation and exact child before accepting authentication',async t=>{
 for(const changed of ['generation','child'])await t.test(changed,async t=>{
  const {f,a,c}=await server(t),gate=deferred(),entered=deferred();let confirmations=0;
  f.tunnel.authenticatedCallSucceeded=()=>{confirmations++;return true;};
  a.tools.rpc=async()=>{entered.resolve();await gate.promise;return {jsonrpc:'2.0',id:1,result:{content:[],isError:false}};};
  const waiting=f.rpc('connection_check');await entered.promise;
  if(changed==='generation')c.generation++;else f.tunnel.child=new EventEmitter();
  gate.resolve();assert.equal((await waiting).status,200);assert.equal(confirmations,0);assert.equal(c.lastCallSucceededAt,0);assert.notEqual(c.attempt?.authenticated,true);
 });
});
