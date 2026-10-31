import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshFixture,ownURL,otherURL} from '../support/1063-refresh-fixture.mjs';

test('unknown/untrusted saved/name-only identity stops before any browser call',async()=>{
 for(const identity of [null,{}, {app_name:'ChatHand'}, {detail_url:otherURL,app_id:'plugin_fixture_own'}, {detail_url:'https://example.test/plugin_fixture_own'}]){
  const p=refreshFixture({identity,saved:{__app_identity:{detail_url:ownURL}}});const r=await p.refresher.run();
  assert.equal(r.state,'identity_required');assert.equal(r.code,'TOOLS_REFRESH_IDENTITY_REQUIRED');assert.equal(r.message_key,'refresh.message.identity_required.unbound');assert.equal(r.summary_key,'refresh.summary.identityRequired');assert.match(r.message,/已停止刷新/);assert.deepEqual(p.calls,[]);
 }
});
test('stable ID chooses renamed installation app instead of exact generic ChatHand',async()=>{
 const p=refreshFixture({attest:true}),r=await p.refresher.run();
 assert.equal(r.state,'refreshed');assert.equal(r.target_attested,true);assert.deepEqual(p.clicks,['own','refresh']);
 assert.equal(p.observed[0].app_name,'Renamed app');assert.equal(p.observed[0].detail_url,ownURL);
 assert.equal(p.finished[0].summary_key,'refresh.message.refreshed.bound');assert.equal(p.finished[0].summary,r.message);
 assert.equal(p.calls.find(([n])=>n==='begin_task')[1].title_key,'refresh.task.title');
});
test('URL-only target matches same installation and never iterates unrelated candidates',async()=>{
 const p=refreshFixture({identity:{detail_url:ownURL},attest:true}),r=await p.refresher.run();assert.equal(r.state,'refreshed');assert.deepEqual(p.clicks,['own','refresh']);
 const q=refreshFixture({entries:[{ref:'other',role:'link',name:'ChatHand',href:otherURL}]});assert.equal((await q.refresher.run()).code,'TOOLS_REFRESH_IDENTITY_NOT_FOUND');assert.deepEqual(q.clicks,[]);
});
test('multiple distinct matched targets/incomplete list stop with zero clicks',async()=>{
 const p=refreshFixture({entries:[{ref:'a',role:'button',name:'A',app_id:'plugin_fixture_own'},{ref:'b',role:'button',name:'B',app_id:'plugin_fixture_own'}]});
 assert.equal((await p.refresher.run()).code,'TOOLS_REFRESH_IDENTITY_AMBIGUOUS');assert.deepEqual(p.clicks,[]);
 const q=refreshFixture({incomplete:true});assert.equal((await q.refresher.run()).state,'ambiguous');assert.deepEqual(q.clicks,[]);
});
test('wrong landed detail never receives refresh click',async()=>{
 const p=refreshFixture({landURL:otherURL});const r=await p.refresher.run();assert.equal(r.state,'not_found');assert.deepEqual(p.clicks,['own']);assert.deepEqual(p.observed,[]);
});
test('binding change during observation stops before refresh',async()=>{
 const p=refreshFixture({onObserved:p=>{p.identity={detail_url:otherURL};}}),r=await p.refresher.run();assert.equal(r.code,'TOOLS_REFRESH_IDENTITY_MISMATCH');assert.deepEqual(p.clicks,['own']);
});
test('AI continuation revalidates installation and current detail; never clicks other app',async()=>{
 const p=refreshFixture({button:'Actualiser les outils',lang:'fr'}),r=await p.refresher.run();assert.equal(r.state,'needs_ai');
 assert.equal(p.finished[0].summary_key,'refresh.summary.needsAi');assert.equal(p.finished[0].summary,'等待 ChatGPT 识别刷新按钮');
 p.url=otherURL;const stopped=await p.refresher.clickByNumber({number:1,meaning:'Refresh tools'});assert.equal(stopped.code,'TOOLS_REFRESH_IDENTITY_MISMATCH');assert.deepEqual(p.clicks,['own']);
 const q=refreshFixture({button:'Actualiser les outils',lang:'fr',attest:true});await q.refresher.run();const done=await q.refresher.clickByNumber({number:1,meaning:'Refresh tools'});assert.equal(done.state,'refreshed');assert.deepEqual(q.clicks,['own','refresh']);
});
test('raw Chinese error stays intact while params use code or nested unknown reason',async()=>{
 for(const errorCode of [null,'MOCK_STEP_FAILED','错误代码']){
  const p=refreshFixture({throwAt:'begin_task',errorCode,errorMessage:'原始错误保留'}),r=await p.refresher.run();
  assert.equal(r.message,'创建 ChatHand 任务时出错：原始错误保留');assert.equal(r.message_key,'refresh.message.failed.stepError');
  assert.deepEqual(r.message_params.step,{key:'refresh.step.task.title'});assert.deepEqual(r.message_params.reason,errorCode==='MOCK_STEP_FAILED'?errorCode:{key:'refresh.reason.unknown'});
  assert.doesNotMatch(JSON.stringify(r.message_params),/\p{Script=Han}/u);
 }
});
test('post-click consent/unverified states carry metadata without retrying',async()=>{
 for(const [options,state,key] of [[{confirm:true},'needs_user','refresh.message.needs_user.confirm'],[{hostError:true},'host_error','refresh.message.host_error.reported'],[{},'unverified','refresh.message.unverified.noBoundList']]){
  const p=refreshFixture(options),r=await p.refresher.run();assert.equal(r.state,state);assert.equal(r.message_key,key);assert.deepEqual(p.clicks,['own','refresh']);assert.equal(p.finished[0].summary_key,key);
 }
});

test('identity observer exceptions are best effort; mismatched URL/ID candidates never click',async()=>{
 const p=refreshFixture({attest:true,onObserved:()=>{throw Error('fixture observer failed');}});assert.equal((await p.refresher.run()).state,'refreshed');assert.deepEqual(p.clicks,['own','refresh']);
 const q=refreshFixture({entries:[{ref:'other',role:'link',name:'ChatHand',href:otherURL,app_id:'plugin_fixture_own'}]});await q.refresher.run();assert.deepEqual(q.clicks,[]);
 const r=refreshFixture({identity:{detail_url:'https://fixture@chatgpt.com/settings/plugins-settings/plugin_fixture_own'}});assert.equal((await r.refresher.run()).state,'identity_required');assert.deepEqual(r.calls,[]);
});
test('Chinese display-only app name never enters params or controls selection',async()=>{
 const p=refreshFixture({appName:'我的应用',entries:[{ref:'other',role:'link',name:'我的应用',href:otherURL}]});const r=await p.refresher.run();assert.match(r.message,/我的应用/);assert.deepEqual(r.message_params,{seconds:1,appName:'ChatHand'});assert.deepEqual(p.clicks,[]);
});
