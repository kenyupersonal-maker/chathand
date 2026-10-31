import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fixture} from './1070-chrome-server-fixture.mjs';
import {BSitePairing} from '../../app/v1/b-site-pairing.mjs';

test('1070 server reads, handoffs and client-declared progress cannot activate setup',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const a=f.app,before=(await a.snapshot()).setup_activity;
 await a.handle('/api/setup/activity',{command:'doctor'});await a.handle('/api/setup/activity',{command:'site-start'});
 await a.handle('/api/setup/skill');await a.snapshot();
 assert.deepEqual((await a.snapshot()).setup_activity,before);
 await a.handle('/api/setup/route',{route:'openai'});
 await assert.rejects(a.handle('/api/setup/key',{api_key:'invalid',tunnel_id:'invalid'}),{code:'KEY_INVALID'});
 await assert.rejects(a.handle('/api/setup/chatgpt-app',{detail_url:'https://invalid.example/plugin'}),{code:'CHATGPT_APP_IDENTITY_INVALID'});
 assert.deepEqual((await a.snapshot()).setup_activity,before);
});
test('1070 actual app binding is attributed once; duplicate binding cannot renew progress',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const a=f.app;
 await a.handle('/api/setup/route',{route:'openai'});await a.handle('/api/setup/chatgpt-app',{application_id:'synthetic-activity-app'});
 const first=(await a.snapshot()).setup_activity;assert.equal(first.active,true);assert.equal(first.last_command,'bind-app');assert.equal(first.route,'openai');
 f.elapse(1000);await a.handle('/api/setup/chatgpt-app',{application_id:'synthetic-activity-app'});
 assert.deepEqual((await a.snapshot()).setup_activity,first);
});
test('1070 test activity starts only after a session exists and targets the configured standby',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const a=f.app;
 await a.handle('/api/setup/route',{route:'site'});const before=(await a.snapshot()).setup_activity;
 const start=crypto.randomBytes;t.mock.method(crypto,'randomBytes',(size,...args)=>{if(size===6)throw Object.assign(Error('synthetic session failure'),{code:'SYNTHETIC_START_FAILED'});return start(size,...args);});
 await assert.rejects(a.handle('/api/setup/test/start',{}),{code:'SYNTHETIC_START_FAILED'});assert.deepEqual((await a.snapshot()).setup_activity,before);
 crypto.randomBytes=start;const result=await a.handle('/api/setup/test/start',{});assert.equal(typeof result.nonce,'string');
 const active=(await a.snapshot()).setup_activity;assert.equal(active.active,true);assert.equal(active.last_command,'test-start');assert.equal(active.route,'site');assert.equal(a.tools.bSiteLocalStore.selection().selected,'openai');
});
test('1070 Site import records only accepted progress, after validation and persistence',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const a=f.app,p=a.tools.bSitePairing,before=(await a.snapshot()).setup_activity;
 let accepted=false;t.mock.method(p,'importGrant',async()=>{if(!accepted)throw Object.assign(Error('synthetic rejected import'),{code:'B_PAIRING_INPUT'});return {phase:'credential_updated'};});
 await assert.rejects(a.handle('/api/site-b/enrollment/import',{}),{code:'B_PAIRING_INPUT'});assert.deepEqual((await a.snapshot()).setup_activity,before);
 accepted=true;await a.handle('/api/site-b/enrollment/import',{});const active=(await a.snapshot()).setup_activity;assert.equal(active.active,true);assert.equal(active.last_command,'site');assert.equal(active.route,'site');
});
test('1070 shared Site pair wrapper attributes only an authenticated paired receipt',async t=>{
 let paired=false;t.mock.method(BSitePairing.prototype,'pairV2',async()=>({paired}));
 const f=fixture(t,{preference:'none'});await f.building;const a=f.app,p=a.tools.bSitePairing,before=(await a.snapshot()).setup_activity;p.pending={protocol_version:'2'};
 await a.handle('/api/site-b/pair',{});assert.deepEqual((await a.snapshot()).setup_activity,before);
 paired=true;await a.handle('/api/site-b/pair',{});const active=(await a.snapshot()).setup_activity;assert.equal(active.last_command,'site-pair');assert.equal(active.route,'site');
});
