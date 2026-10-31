import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';
class ExtensionBrowser extends ProductionExtensionBrowser {constructor(state,store,policy){super(state,store,policy,{distribution:storeTestDistribution()});this.noteHelper('fixture',storeTestHelper());}next(session,helper,...rest){return super.next(session,helper??storeTestHelper(),...rest);}}
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {ExtensionBrowser as ProductionExtensionBrowser} from '../../app/v09/extension-browser.mjs';

function fixture() {const state = {data: {mode: 'auto', browser_enabled: true}, project: () => ({path: '/tmp/测试工作区'}), save() {}}, events = [], policy = {epoch: 'epoch', fullArmed: false, check() {}, tasks: new Map([['task', {status: 'active'}]]), require(task) {if (task !== 'task') throw Object.assign(Error('revoked'), {code: 'TASK_REVOKED'});}, emit: (...args) => events.push(args)}, ext = new ExtensionBrowser(state, {}, policy);return {state, policy, ext, events};}
test('missing store configuration stays pending and old installation observation cannot satisfy a new ID', async t => {
  const f=fixture(),ext=new ProductionExtensionBrowser(f.state,{},f.policy);t.after(()=>ext.closeAll());t.after(()=>f.ext.closeAll());
  assert.equal(ext.status().configuration_state,'pending');assert.equal(ext.status().installation_state,'unknown');assert.equal(ext.status().installed,null);assert.equal(ext.status().connected,false);
  assert.throws(()=>ext.request('snapshot',{},'caller','task'),{code:'CHROME_STORE_CONFIGURATION_PENDING'});
  f.state.data.extension_last_seen=Date.now()-20000;assert.equal(ext.status().installation_state,'unknown');assert.throws(()=>ext.heartbeat(crypto.randomUUID()),{code:'CHROME_STORE_CONFIGURATION_PENDING'});
});
test('extension reauthorization rejects a disabled browser and revoked task', async t => {
  const f = fixture();t.after(() => f.ext.closeAll());const session = crypto.randomUUID();f.ext.heartbeat(session);f.ext.pauseRequested = false;const pending = f.ext.request('batch', {steps: []}, 'caller', 'task');pending.catch(() => {});const request = f.ext.next(session);assert.equal(request.kind, 'request');assert.equal(f.ext.authorize(session, request.id).authorized, true);
  f.state.data.browser_enabled = false;assert.throws(() => f.ext.authorize(session, request.id), {code: 'CAPABILITY_OFF'});f.ext.cancelAll();await assert.rejects(pending, {code: 'TASK_REVOKED'});
});
test('encoded nested snapshots carry fresh page ids, cache hints and folder scope note', async t => {
  const f = fixture();t.after(() => f.ext.closeAll());const result = f.ext.encode({page_id: '1', snapshot: {page_id: '1'}, tabs: [{page_id: '2'}]});assert.equal(result.snapshot.page_id, f.ext.epoch + ':1');assert.equal(result.tabs[0].page_id, f.ext.epoch + ':2');assert.equal(result.cacheScope, 'private');assert.match(result.details.scope_note, /测试工作区/);
});
test('reconnect sends one control message and task-time disconnect emits one notification', async t => {
  const f = fixture();t.after(() => f.ext.closeAll());const session = crypto.randomUUID();f.ext.heartbeat(session);f.ext.lastTask = 'task';f.ext.lastSeen = Date.now() - 8000;f.ext.connectionLost();f.ext.connectionLost();assert.equal(f.events.length, 1);assert.equal(f.events[0][0], 'browser_connection_lost');
  f.ext.reconnect();assert.deepEqual(f.ext.next(session), {control: 'reconnect'});f.ext.next(crypto.randomUUID());assert.equal(f.ext.status().connected, true);
});
