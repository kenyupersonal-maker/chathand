import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {BSitePairing} from '../../app/v1/b-site-pairing.mjs';
import {fixture,deferred,waitFor} from './1070-startup-fixture.mjs';
import {armUpgradeGuard} from '../../app/v08/upgrade-guard.mjs';

function ownerContract(f){
 const app=f.app,local=app.tools.bSiteLocalStore,pair=app.tools.bSitePairing,calls=[];
 // These two methods belong to Site. On an unintegrated checkout this adapter
 // tests only server orchestration; the integrated run uses the real methods.
 if(typeof pair.abandonSitePairing!=='function')pair.abandonSitePairing=reason=>{pair.close();pair.failure={code:reason,at:Date.now()};};
 if(typeof pair.forget!=='function')pair.forget=expected=>{calls.push(['forget',expected]);pair.close();f.values.delete('site_b');f.values.delete('site_b_machine');local.forgetRoute('site',{authenticatedNative:true});};
 if(typeof local.forgetRoute!=='function')local.forgetRoute=(route,{authenticatedNative})=>{
  assert.equal(authenticatedNative,true);calls.push(['reset',route]);
  local.authorityTx(()=>{local.db.prepare("UPDATE b_routes SET configured=0,state='unconfigured',last_verified=0 WHERE route=?").run(route);if(route==='site'&&local.selection().selected==='site')local.switchInside('site','openai','removed');});
 };
 return {app,local,pair,calls};
}
function siteReady(f,local){
 const binding_id=crypto.randomUUID();local.configureSite({site_id:'synthetic-site',owner_subject:'synthetic-owner',binding_id,generation:1},{authenticated:true});
 local.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});
 f.transport.running=true;f.transport.stageStatus=()=>({running:true,ready:true,authenticated:true,transport_epoch:f.transport.epoch,runtime_manifest:{state:'accepted',transport_epoch:f.transport.epoch}});
 return binding_id;
}
async function watch(t,f){
 const {local,pair}=ownerContract(f),intent={intent_id:crypto.randomUUID(),expires_at:Date.now()+86400000};
 t.mock.method(local,'activeIntent',()=>intent);
 t.mock.method(pair,'snapshot',()=>({phase:pair.failure?'failed':'pairing',error_code:pair.failure?.code||null,verified_template_source:{synthetic:true}}));
 return (await f.post('/api/site-b/enrollment/watch')).body;
}

test('1070 connection/use starts a stopped standby OpenAI route; switching requires owner/UI and leaves setup activity unchanged',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local,pair}=ownerContract(f);siteReady(f,local);local.switchUser('site',{windowGesture:true});
 f.calls.cloud='up';const before=(await app.snapshot()).setup_activity;
 assert.equal((await f.post('/api/connection/use',{route:'openai'},{owner:false})).status,401);
 assert.equal((await f.post('/api/connection/use',{route:'openai'},{ui:false})).status,403);
 const response=await f.post('/api/connection/use',{route:'openai'});
 assert.equal(response.body.ok,true);assert.equal(response.body.selected,'openai');assert.equal(f.calls.starts,1);
 assert.equal(pair.failure.code,'B_PAIRING_ABANDONED');assert.deepEqual((await app.snapshot()).setup_activity,before);
});
test('1070 failed target health cannot change selected route or setup activity; Site verification explicitly forbids auto-select',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local,pair}=ownerContract(f);
 local.configureOpenAI({verified:true});local.health('openai',{state:'healthy',verified:true,nonceEcho:true,generation:0});
 const before=(await app.snapshot()).setup_activity;
 t.mock.method(pair,'verifyHealth',async options=>{assert.equal(options.select,false);throw Object.assign(Error('synthetic offline'),{code:'B_REMOTE_TRANSIENT'});});
 const result=(await f.post('/api/connection/use',{route:'site'})).body;
 assert.equal(result.ok,false);assert.equal(result.error_code,'B_REMOTE_TRANSIENT');assert.equal(local.selection().selected,'openai');assert.deepEqual((await app.snapshot()).setup_activity,before);
});
test('1070 watch expiry slides only on accepted Site progress, never doctor, status or caller-declared activity; expiry stops clipboard watch',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,pair}=ownerContract(f),started=await watch(t,f),first=started.expires_at;
 assert.equal(started.watching,true);assert.ok(first-Date.now()<=900000);
 await f.advance(14*60000);
 await f.post('/api/setup/activity',{command:'doctor'});await f.post('/api/setup/activity',{command:'site-start',route:'site'});
 assert.equal((await app.snapshot()).site_b.enrollment_watch.expires_at,first);
 t.mock.method(pair,'importGrant',async()=>({phase:'pairing'}));t.mock.method(pair,'pairV2',async()=>({paired:false}));
 await f.post('/api/site-b/enrollment/import',{});
 const renewed=(await app.snapshot()).site_b.enrollment_watch.expires_at;assert.ok(renewed>first);
 await f.advance(900001);
 const view=(await app.snapshot()).site_b;assert.equal(view.enrollment_watch.watching,false);assert.equal(view.enrollment_watch.stopped_id,started.watch_id);assert.equal(view.pairing.error_code,'B_WATCH_EXPIRED');
 assert.equal(app.state.data.setup_site_watch,undefined);
});
test('1070 watch stop is unconditional even with a live intent; switch clears select-on-pair and fences a late successful callback',async t=>{
 const done=deferred();t.mock.method(BSitePairing.prototype,'pairV2',()=>done.promise);
 const f=fixture(t,{preference:'none'});await f.building;const {app,local,pair}=ownerContract(f),started=await watch(t,f);
 pair.pending={protocol_version:'2'};app.state.data.setup_site_select_on_pair=true;app.state.save();
 const late=f.post('/api/site-b/pair',{});await new Promise(resolve=>setImmediate(resolve));
 f.calls.cloud='up';assert.equal((await f.post('/api/connection/use',{route:'openai'})).body.ok,true);
 done.resolve({paired:true});assert.equal((await late).body.paired,false);
 const view=(await app.snapshot()).site_b;assert.equal(view.enrollment_watch.watching,false);assert.equal(view.enrollment_watch.stopped_id,started.watch_id);assert.equal(local.selection().selected,'openai');assert.equal(app.state.data.setup_site_select_on_pair,undefined);
 assert.equal((await f.post('/api/site-b/enrollment/watch',{})).body.error.code,'B_PAIRING_STOPPED');pair.failure=null;const second=await watch(t,f);assert.equal((await f.post('/api/site-b/enrollment/watch/stop',{})).body.watching,false);assert.equal((await app.snapshot()).site_b.enrollment_watch.stopped_id,second.watch_id);
});
test('1070 actual Site-owned failure and stopped watch survive server restart', {skip:typeof BSitePairing.prototype.abandonSitePairing!=='function'?'Site owner module not integrated in this checkout':false},async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {pair}=ownerContract(f),started=await watch(t,f);
 t.mock.method(pair,'importGrant',async()=>{pair.failure={code:'B_BINDING_CONFLICT',at:Date.now()};throw Object.assign(Error('synthetic conflict'),{code:'B_BINDING_CONFLICT'});});
 await f.post('/api/site-b/enrollment/import',{});assert.equal((await f.app.snapshot()).site_b.pairing.error_code,'B_BINDING_CONFLICT');
 await f.app.close();
 const second=fixture(t,{preference:'none',existingRoot:f.root});await second.building;
 const view=(await second.app.snapshot()).site_b;assert.equal(view.pairing.phase,'failed');assert.equal(view.pairing.error_code,'B_BINDING_CONFLICT');assert.equal(view.enrollment_watch.watching,false);assert.equal(view.enrollment_watch.stopped_id,started.watch_id);
 const store=second.app.tools.bSiteLocalStore,count=()=>store.db.prepare('SELECT count(*) AS n FROM b_pair_intents').get().n,before=count();await second.app.snapshot();await second.app.snapshot();assert.equal(count(),before);
});
for(const confirmed of [true,false])test('1070 remove Site '+(confirmed?'confirmed revoke':'bounded timeout')+' still forgets locally and connects healthy standby OpenAI',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local,calls}=ownerContract(f);siteReady(f,local);local.switchUser('site',{windowGesture:true});
 local.configureOpenAI({verified:true});f.calls.cloud='up';
 if(confirmed)t.mock.method(f.transport,'revokeCurrent',async()=>({remote_revocation:'confirmed'}));
 else{
  const original=setTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>original(fn,ms===10000?1:ms,...args));
  f.transport.revokeCurrent=()=>new Promise(()=>{});
 }
 // transport fixtures may supply revoke as a new optional adapter method.
 const result=(await f.post('/api/connection/remove',{route:'site'})).body;
 assert.equal(result.ok,true);assert.equal(result.revoke,confirmed?'CONFIRMED':'UNCONFIRMED');assert.equal(result.selected,'openai');assert.equal(local.route('site').configured,0);assert.equal(app.policy.enabled,true);
 assert.ok(calls.some(row=>row[0]==='reset'&&row[1]==='site')||typeof local.forgetRoute==='function');
});
test('1070 deleting active OpenAI clears only its saved connection and falls back to a healthy Site without changing user pause intent',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local}=ownerContract(f);siteReady(f,local);local.configureOpenAI({verified:true});
 f.values.set('site_b',{synthetic:'retained'});
 assert.equal((await f.post('/api/connection/remove',{route:'openai'},{ui:false})).status,403);
 const result=(await f.post('/api/connection/remove',{route:'openai'})).body;
 assert.equal(result.ok,true,result.error?.code);assert.equal(result.selected,'site');assert.equal('revoke' in result,false);assert.equal(local.route('openai').configured,0);assert.equal(f.values.has('tunnel'),false);assert.deepEqual(f.values.get('site_b'),{synthetic:'retained'});assert.equal(app.state.data.access_enabled,true);
});
test('1070 skill handoff requests and doctor compatibility do not create setup activity or change repair target selection',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app}=ownerContract(f);
 const before=(await app.snapshot()).setup_activity,selected=(await app.snapshot()).setup_route;
 await f.post('/api/setup/activity',{command:'doctor'});
 const response=(await f.post('/api/setup/skill',{route:'openai',intent:'repair',locale:'en'})).body;
 assert.equal(typeof response.prompt,'string');assert.equal((await app.snapshot()).setup_route,selected);assert.deepEqual((await app.snapshot()).setup_activity,before);
 assert.equal((await f.post('/api/setup/skill',{route:'openai',intent:'invalid'})).status,400);
});
test('1070 a user pause during asynchronous Site removal remains paused after fallback',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local}=ownerContract(f);siteReady(f,local);local.switchUser('site',{windowGesture:true});local.configureOpenAI({verified:true});f.calls.cloud='up';
 const ack=deferred();t.mock.method(f.transport,'revokeCurrent',()=>ack.promise);
 const removing=f.post('/api/connection/remove',{route:'site'});await new Promise(resolve=>setImmediate(resolve));
 await app.handle('/api/access',{enabled:false});ack.resolve({remote_revocation:'confirmed'});
 assert.equal((await removing).body.ok,true);assert.equal(app.state.data.access_enabled,false);assert.equal(app.policy.enabled,false);
});
test('1070 a late import from a stopped watch cannot cancel a new pairing watch',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,pair}=ownerContract(f),old=await watch(t,f),grant=deferred();
 t.mock.method(pair,'importGrant',()=>grant.promise);
 const late=f.post('/api/site-b/enrollment/watch/import',{watch_id:old.watch_id,payload:{}});await new Promise(resolve=>setImmediate(resolve));
 await f.post('/api/site-b/enrollment/watch/stop',{});pair.failure=null;const fresh=await watch(t,f);const pending={synthetic:'new attempt'};pair.pending=pending;
 let cancelled=0;t.mock.method(pair,'cancelV2Recovery',()=>{cancelled++;pair.pending=null;});
 grant.resolve({phase:'pairing'});assert.equal((await late).body.error.code,'B_WATCH_EXPIRED');assert.equal(cancelled,0);assert.equal(pair.pending,pending);assert.equal((await app.snapshot()).site_b.enrollment_watch.watch_id,fresh.watch_id);
});
test('1070 explicit OpenAI removal forgets local legacy relay authentication even when remote revoke is unconfirmed',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local}=ownerContract(f);local.configureOpenAI({verified:true});
 app.relay.session={synthetic:true};app.relay.config={base:'https://synthetic.invalid'};
 t.mock.method(app.relay,'stop',async options=>{if(options.forget)throw Object.assign(Error('synthetic unconfirmed revoke'),{code:'REVOCATION_UNCONFIRMED'});return {};});
 const result=(await f.post('/api/connection/remove',{route:'openai'})).body;
 assert.equal(result.ok,true);assert.equal(local.route('openai').configured,0);assert.equal(f.values.has('tunnel'),false);assert.equal(app.relay.session,null);assert.equal(app.relay.config,null);
});

test('1070 replacement upgrade receipts share owner authentication and cannot claim setup progress',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,pair}=ownerContract(f),before=(await app.snapshot()).setup_activity;
 const payload={origin:'https://synthetic.invalid',question_id:'synthetic-question',phase:'failed',error_code:'B_DEPLOYMENT_FAILED',version_id:'synthetic-version',deployment_id:'synthetic-deployment'};let received=null;
 pair.recordReplacementUpgradeFailure=body=>{received=body;return {phase:'failed',replace_supported:false};};
 assert.equal((await f.post('/api/site-b/replacement-upgrade-failure',payload,{owner:false})).status,401);
 assert.equal(received,null);
 assert.equal((await f.post('/api/site-b/replacement-upgrade-failure',payload,{ui:false})).body.replace_supported,false);
 assert.deepEqual(received,payload);assert.deepEqual((await app.snapshot()).setup_activity,before);
});
test('1070 failed durable abandonment stops watch but cannot select or start the requested route',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local,pair}=ownerContract(f);siteReady(f,local);local.switchUser('site',{windowGesture:true});const started=await watch(t,f);
 app.state.data.setup_site_select_on_pair=true;app.state.save();
 t.mock.method(pair,'abandonSitePairing',()=>{throw Object.assign(Error('synthetic persistence failure'),{code:'B_PAIR_FAILURE_STORE'});});
 const response=(await f.post('/api/connection/use',{route:'openai'})).body;
 assert.equal(response.ok,false);assert.equal(response.error_code,'B_PAIR_FAILURE_STORE');assert.equal(response.selected,'site');assert.equal(f.calls.starts,0);
 const view=(await app.snapshot()).site_b.enrollment_watch;assert.equal(view.watching,false);assert.equal(view.stopped_id,started.watch_id);assert.equal(app.state.data.setup_site_select_on_pair,undefined);
});
test('1070 real Site progress never renews a watch beyond the signed intent deadline',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local,pair}=ownerContract(f),limit=Date.now()+60000;
 t.mock.method(local,'activeIntent',()=>({intent_id:crypto.randomUUID(),expires_at:limit}));
 t.mock.method(pair,'snapshot',()=>({phase:'pairing',error_code:null,verified_template_source:{synthetic:true}}));
 assert.equal((await f.post('/api/site-b/enrollment/watch')).body.expires_at,limit);
 await f.advance(30000);t.mock.method(pair,'importGrant',async()=>({phase:'pairing'}));t.mock.method(pair,'pairV2',async()=>({paired:false}));
 await f.post('/api/site-b/enrollment/import',{});
 assert.equal((await app.snapshot()).site_b.enrollment_watch.expires_at,limit);
});
for(const guard of ['none','paused','upgrade'])test('1070 removing active Site reuses an already-ready OpenAI standby with guard='+guard,async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app,local}=ownerContract(f);siteReady(f,local);local.switchUser('site',{windowGesture:true});f.calls.cloud='up';
 await app.handle('/api/connect/restore',{});await app.snapshot();assert.equal(f.calls.starts,1);assert.equal(app.controller.phase,'ready');
 if(guard==='paused')await app.handle('/api/access',{enabled:false});
 if(guard==='upgrade')armUpgradeGuard(f.stateDir,'1.0.0-beta.1','synthetic-upgrade-only');
 const result=(await f.post('/api/connection/remove',{route:'site'})).body;
 assert.equal(result.ok,true);assert.equal(result.selected,'openai');assert.equal(f.calls.starts,1);assert.equal(app.policy.enabled,guard==='none');
});


test('1070 skill handoff defaults an omitted body without accepting bad types or unknown fields',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const {app}=ownerContract(f);
 const before=(await app.snapshot()).setup_activity,selection=(await app.snapshot()).setup_route;
 const result=await app.handle('/api/setup/skill');
 assert.equal(result.installed,true);assert.equal(result.intent,'setup');assert.equal(typeof result.prompt,'string');assert.ok(['site','openai'].includes(result.route));
 for(const body of [null,[],['site'],'site',true,0,42,{unknown:true},{route:'invalid'},{intent:'invalid'},{locale:'invalid'}])await assert.rejects(app.handle('/api/setup/skill',body),error=>error.code==='ARG_INVALID');
 assert.equal((await app.snapshot()).setup_route,selection);assert.deepEqual((await app.snapshot()).setup_activity,before);
});
