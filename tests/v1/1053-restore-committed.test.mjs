import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {CredentialStore} from '../../app/credentials.mjs';
import {fixture,waitReady,waitAuthRejected} from '../support/oneclick-helpers.mjs';

// Only isolated fake transport/state. Assertions compare booleans so failure
// output cannot print either fixture credential value.
test('restore discards a rejected candidate and reconnects only the saved identity',async t=>{
 const f=await fixture(t);await f.connect();await f.b.handle('/api/tunnel/stop',{});
 const mode=path.join(f.stateDir,'test-tunnel-mode');
 fs.writeFileSync(mode,'auth-fail');
 const edited={...f.config,api_key:f.config.api_key+'-rejected-edit'};
 await f.b.handle('/api/connect',edited);await waitAuthRejected(f.b);
 assert.equal(f.b.controller.phase,'needs_login');
 assert.equal(new CredentialStore(f.stateDir,{adapter:null}).get('tunnel').api_key===f.config.api_key,true);
 fs.writeFileSync(mode,'ok');
 await f.b.handle('/api/connect/restore',{});await waitReady(f.b);
 const saved=new CredentialStore(f.stateDir,{adapter:null}).get('tunnel');
 assert.equal(saved.api_key===f.config.api_key,true);
 assert.equal(f.b.tunnel.key===f.config.api_key,true);
 assert.equal(saved.api_key===edited.api_key,false);
 assert.equal(f.b.controller.phase,'ready');
});

test('committed healthy identity still performs a real user reconnect after pause',async t=>{
 const f=await fixture(t);await f.connect();const oldPid=f.b.tunnel.child.pid;
 await f.b.handle('/api/access',{enabled:false});
 await f.b.handle('/api/connect/restore',{});await waitReady(f.b);
 assert.equal(f.b.tunnel.child.pid===oldPid,false);
 assert.equal(f.b.controller.lastRestart.reason,'user');
 assert.equal(f.b.policy.enabled,true);
 assert.equal(f.b.tunnel.key===f.config.api_key,true);
});
