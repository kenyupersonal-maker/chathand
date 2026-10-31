// ONE1052 isolated current-binding probe outcome observer only.
// No Site, ChatGPT, Keychain, user-file mutation, or app-only widget assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BSiteLocalStore} from '../app/v1/b-site-store.mjs';
import {BSiteHostProbes,B_HOST_PROBE_ENVELOPE} from '../app/v1/b-site-host-probes.mjs';

const INS='11111111-1111-4111-8111-111111111111',
 SITE='site_fixture_1052',OWNER='synthetic_owner_1052',
 BIND='22222222-2222-4222-8222-222222222222',NOW=1_800_000_100_000;
const NONCE='synthetic_nonce_20261012';
function local(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'one1052-b-probe-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stateDir=path.join(root,'state');fs.mkdirSync(stateDir,{mode:0o700});
 let current=NOW;
 const store=new BSiteLocalStore({stateDir,installationId:INS,existingA:false,now:()=>current,resultKey:()=>Buffer.alloc(32,1)});
 t.after(()=>store.close());
 store.configureSite({site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1},{authenticated:true});
 store.health('site',{state:'healthy',verified:true,nonceEcho:true,generation:1});store.switchUser('site',{windowGesture:true});
 return {store,advance:n=>{current+=n},now:()=>current};
}
const channel={trusted_server:true,authenticated_device:true,site_id:SITE,owner_subject:OWNER,binding_id:BIND,generation:1,transport_epoch:1,authenticated_session:'site:'+BIND};
const work=tool_name=>({route:'site',principal:'site:'+OWNER,binding_id:BIND,generation:1,tool_name,op_id:crypto.randomUUID(),args:{kind:B_HOST_PROBE_ENVELOPE,session_tag:'a'.repeat(64),tool_arguments:{nonce:NONCE}}});
const read=()=>({nonce:NONCE,caller:'chatgpt',access_enabled:true,tool_count:81,instance_id:'synthetic_nonsecret_instance'});
const write=()=>({nonce:NONCE,read:true,write:true,recorded:true});
const terminal={state:'completed',result_digest:'a'.repeat(64)};

test('verified device dispatch read+write capability remains pending host app flow',t=>{
 const f=local(t),observer=new BSiteHostProbes({local:f.store,installationId:INS,now:f.now,transportEpoch:()=>1,receiptWriter:()=>{throw Error('unconsumed test capability must not write receipt');}});
 assert.deepEqual(observer.snapshot(),{state:'unverified',read_observed:false,write_capability_observed:false,host_app_bridge:'app_only_source_wired',expires_at:null,verified:false});
 assert.equal(observer.observe({work:work('connection_check'),outcome:read(),channel,terminal}).observed,true);
 assert.equal(observer.snapshot().state,'read_observed');
 const w=observer.observe({work:work('setup_write_probe'),outcome:write(),channel,terminal});
 assert.equal(w.write_capability,true);assert.equal(w.verified,false);
 assert.equal(observer.snapshot().state,'awaiting_app_only_commit');
 assert.equal(observer.snapshot().verified,false);
 assert.equal(f.store.currentHostReceipt(),null);
 assert.equal(f.store.snapshot().host_attestation,'not_verified');
 assert.equal(JSON.stringify(observer.snapshot()).includes(NONCE),false);
});
test('unauthenticated, out-of-order, fake nonce or failed probe cannot create host progress',t=>{
 const f=local(t),v=new BSiteHostProbes({local:f.store,installationId:INS,now:f.now,transportEpoch:()=>1,receiptWriter:()=>{throw Error('unconsumed test capability must not write receipt');}});
 assert.equal(v.observe({work:work('setup_write_probe'),outcome:write(),channel,terminal}).observed,false);
 assert.equal(v.observe({work:work('connection_check'),outcome:read(),channel,terminal:{state:'failed'}}).observed,false);
 assert.equal(v.observe({work:work('connection_check'),outcome:read(),failed:true,channel,terminal}).observed,false);
 assert.equal(v.observe({work:work('connection_check'),outcome:read(),channel:{...channel,binding_id:crypto.randomUUID()},terminal}).observed,false);
 assert.equal(v.observe({work:work('connection_check'),outcome:read(),channel,terminal}).observed,true);
 assert.equal(v.observe({work:{...work('setup_write_probe'),args:{...work('setup_write_probe').args,tool_arguments:{nonce:'wrong_nonce_001'}}},outcome:write(),channel,terminal}).observed,false);
 assert.equal(v.observe({work:work('setup_write_probe'),outcome:{...write(),recorded:false},channel,terminal}).observed,false);
 assert.equal(v.snapshot().write_capability_observed,false);
 assert.equal(f.store.currentHostReceipt(),null);
});
test('binding lifecycle, expiry and explicit invalidation prevent stale capability replay',t=>{
 const f=local(t),v=new BSiteHostProbes({local:f.store,installationId:INS,now:f.now,transportEpoch:()=>1,receiptWriter:()=>{throw Error('unconsumed test capability must not write receipt');}});
 v.observe({work:work('connection_check'),outcome:read(),channel,terminal});
 v.observe({work:work('setup_write_probe'),outcome:write(),channel,terminal});
 f.advance(130000);
 assert.equal(v.snapshot().state,'unverified');
 assert.equal(v.observe({work:work('setup_write_probe'),outcome:write(),channel,terminal}).observed,false);
 v.observe({work:work('connection_check'),outcome:read(),channel,terminal});
 v.invalidate();assert.equal(v.snapshot().state,'unverified');
 f.store.health('site',{state:'failed',verified:true,generation:1});
 assert.equal(v.observe({work:work('connection_check'),outcome:read(),channel,terminal}).observed,false);
});
