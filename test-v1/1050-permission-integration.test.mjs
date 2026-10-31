// Real isolated createDesktop, HTTP authorization, state, policy, queue proposal,
// and range checks. No command is spawned; process cancellation is a test adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {createDesktop, needsInterface} from '../app/server.mjs';
import {permissionUndoProofMessage} from '../app/v1/native-owner-proof.mjs';
import {sessionHashOf} from '../app/v1/resume.mjs';
import {OwnedJobCleanupEvidence} from '../app/v1/permission-cleanup-evidence.mjs';

const uiKey = 'af'.repeat(32), nativeKey = 'b7'.repeat(32);
let sequence = 0;
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1050-transaction-'))), work = path.join(root, 'work'); fs.mkdirSync(work);
  const admin = {installed: false, installs: 0, removals: 0, supported: () => true, ready() { return this.installed; },
    async install() { this.installs++; this.installed = true; return {status: 'installed'}; },
    uninstall() { this.removals++; this.installed = false; return {status: 'removed'}; },
    removalEvidence() { return {status: this.installed ? 'present' : 'absent'}; },
    uninstallForRevocation() { this.uninstall(); return {status: this.installed ? 'unconfirmed' : 'removed', absence_confirmed: !this.installed}; }};
  const cleanupEvidence = new OwnedJobCleanupEvidence({platform: 'darwin', probeGroup: () => 'absent'});
  const app = await createDesktop({stateDir: path.join(root, 'state'), defaultRoot: work, uiKey, nativeOwnerKey: nativeKey, adminAccess: admin,
    clientDeps: {
      permissionCleanupEvidence: cleanupEvidence,
      currentAppPath: path.join(root, 'ChatHand.app'), computerName: () => '1050 Synthetic Mac',
      tunnelFactory: () => ({child: null, doctorChild: null, log: [], status: 'off', stop() {}, snapshot: async () => ({status: 'off', ready: false, healthy: false, process_running: false})}),
      updaterFactory: () => ({currentBuild: 1050, snapshot: () => ({status: 'unknown', install: {state: 'idle'}}), forAI: () => ({status: 'unknown', request: null, just_updated: null}), start() {}, close() {}, settingsChanged() {}, cleanupLeftovers: async () => ({cleaned: 0})})
    }
  });
  t.after(async () => { await app.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await app.handle('/api/access', {enabled: true});
  await app.handle('/api/mode', {mode: 'full', confirm: true});
  await app.handle('/api/settings', {terminal_enabled: true, browser_enabled: true, desktop_enabled: true,
    high_risk: {admin: true, autostart: true, erase: true, bulk_delete: false, keychain: false, pipe_run: false, gatekeeper: false, bulk_perm: false, power: false, chatgpt_self: true}});
  const rpc = async (name, args = {}) => (await app.tools.rpc({jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: {name, arguments: args, _meta: {'openai/session': '1050-test-session', 'io.modelcontextprotocol/protocolVersion': '2026-07-28'}}}, 'test-caller', {setupPrincipal: 'test-principal'})).result;
  const taskResult = await rpc('begin_task', {request_id: '1050-task-' + (++sequence), title: '1050 isolated permission test', new_task: true});
  assert.equal(taskResult.isError, false); const task = app.policy.get(taskResult.structuredContent.task_id);
  const post = async (route, body, includeUI = true) => {
    const response = await fetch(`http://127.0.0.1:${app.apiPort}${route}`, {method: 'POST', headers: {authorization: `Bearer ${app.adminToken}`, 'content-type': 'application/json', ...(includeUI ? {'x-chathand-ui': uiKey} : {})}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  };
  const sign = id => { const now = Date.now(), nonce = (++sequence).toString(16).padStart(32, '0'); return {v: 1, issued_at: now, nonce, signature: createHmac('sha256', Buffer.from(nativeKey, 'hex')).update(permissionUndoProofMessage(id, now, nonce)).digest('hex')}; };
  return {app, root, work, admin, task, post, sign, rpc, cleanupEvidence};
}

test('real server scope revoke retains task and switches, stops only matched jobs, and narrows file resolution', async t => {
  const {app, root, work, task, admin, post, sign, cleanupEvidence} = await fixture(t), epoch = app.policy.epoch;
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'isolated test');
  assert.equal(app.store.resolve(outside), outside, 'full scope permits this temporary sibling before revoke');
  const old = app.queue.propose({program: '/usr/bin/true', args: [], cwd: work, request_id: '1050-old-pending-' + (++sequence)});
  const simulatedFull = app.queue.propose({program: '/usr/bin/true', args: [], cwd: work, request_id: '1050-running-full-' + (++sequence)});
  const simulatedFolder = app.queue.propose({program: '/usr/bin/true', args: [], cwd: work, request_id: '1050-running-folder-' + (++sequence)});
  const full = app.queue.get(simulatedFull.job_id), folder = app.queue.get(simulatedFolder.job_id);
  Object.assign(full, {started_at: Date.now(), status: 'running', pid: 410501, child: {synthetic: true, pid: 410501, exitCode: null, signalCode: null}, sandbox: {backend: 'none', scope: 'full'}});
  cleanupEvidence.capture(full); // Synthetic spawn ownership; no real process or signal.
  Object.assign(folder, {started_at: Date.now(), status: 'running', child: {synthetic: true}, sandbox: {backend: 'macOS Seatbelt', scope: 'auto'}});
  const engineCancel = app.queue.cancel.bind(app.queue), cancelled = [];
  app.queue.cancel = (id, reason) => { if ([full.id, folder.id].includes(id)) { const job = app.queue.get(id); cancelled.push(id); if (job.child) job.child.exitCode = 0; job.child = null; job.status = reason || 'cancelled'; return app.queue.publicJob(job); } return engineCancel(id, reason); };
  t.after(() => { full.child = null; folder.child = null; });
  const response = await post('/api/permissions/revoke', {gate: 'scope', id: 'full'});
  assert.equal(response.status, 200); assert.equal(response.body.ok, true); assert.equal(response.body.revoked_high_risk_count, 3);
  assert.equal(app.state.data.mode, 'auto'); assert.equal(app.store.root, work); assert.equal(app.policy.epoch, epoch);
  assert.equal(app.policy.require(task.id, 'test-caller'), task); assert.equal(task.status, 'active');
  for (const id of ['terminal', 'browser', 'desktop']) assert.equal(app.state.data[id + '_enabled'], true);
  assert.equal(app.state.data.high_risk.chatgpt_self, true); assert.equal(admin.installed, false);
  assert.deepEqual(cancelled, [full.id]); assert.ok(folder.child);
  assert.throws(() => app.store.resolve(outside));
  assert.throws(() => app.queue.approve(old.job_id), error => error.code === 'PERMISSION_CHANGED');
  const restored = await post('/api/permissions/undo', {receipt_id: response.body.undo.receipt_id, proof: sign(response.body.undo.receipt_id)});
  assert.equal(restored.body.restored, true); assert.equal(app.state.data.mode, 'full'); assert.equal(admin.installed, true);
  assert.equal(app.policy.require(task.id, 'test-caller'), task); assert.equal(full.child, null);
  assert.equal(app.store.resolve(outside), outside);
});

test('real HTTP rejects renderer-only authority, validates native undo once, and never returns the owner key', async t => {
  const {app, post, sign} = await fixture(t);
  assert.equal(needsInterface('/api/permissions/undo', {}), true); assert.equal(needsInterface('/api/permissions/undo-info', {}), true);
  const denied = await post('/api/permissions/revoke', {gate: 'scope', id: 'full'}, false);
  assert.equal(denied.status, 403); assert.equal(app.state.data.mode, 'full');
  const revoked = (await post('/api/permissions/revoke', {gate: 'scope', id: 'full'})).body;
  const fake = await post('/api/permissions/undo', {receipt_id: revoked.undo.receipt_id, human: true, input: {human: true}, proof: {human: true}});
  assert.equal(fake.body.error.code, 'NATIVE_OWNER_PROOF_INVALID'); assert.equal(app.state.data.mode, 'auto');
  const info = await post('/api/permissions/undo-info', {receipt_id: revoked.undo.receipt_id});
  assert.equal(info.body.message, '已撤回整台电脑和 3 项高危权限'); assert.equal('before' in info.body, false);
  const proof = sign(revoked.undo.receipt_id), restored = await post('/api/permissions/undo', {receipt_id: revoked.undo.receipt_id, proof});
  assert.equal(restored.body.restored, true);
  const repeat = await post('/api/permissions/undo', {receipt_id: revoked.undo.receipt_id, proof});
  assert.equal(repeat.body.error.code, 'UNDO_USED');
  assert.equal(app.ui.includes(nativeKey), false); assert.equal(app.nativeOwnerKey, undefined);
  assert.equal(JSON.stringify(await app.snapshot()).includes(nativeKey), false);
  assert.equal(fs.readFileSync(path.join(app.state.dir, 'runtime.json'), 'utf8').includes(nativeKey), false);
});

test('explicit preset intent and manual customization persist through a matching switch pattern', async t => {
  const {app, post} = await fixture(t);
  await app.handle('/api/permissions/tier', {tier: 'full'});
  assert.equal(app.state.data.permission_tier_intent, 'full');
  await app.handle('/api/settings', {browser_enabled: false});
  await app.handle('/api/settings', {browser_enabled: true});
  assert.equal(app.state.data.permission_tier_intent, 'custom');
  assert.equal((await app.snapshot()).permissions.tier, 'custom');
  const first = (await post('/api/permissions/revoke', {gate: 'capability', id: 'browser'})).body;
  await app.handle('/api/settings', {terminal_enabled: false});
  const stale = await post('/api/permissions/undo-info', {receipt_id: first.undo.receipt_id});
  assert.equal(stale.body.error.code, 'UNDO_STALE'); assert.equal(app.state.data.browser_enabled, false);
});

// The 1049 relay remains task/session bound. Both new authority transactions
// must cancel prior cards without terminating the active task itself.
test('1050 merged authority changes cancel 1049 relay on revoke and undo while retaining task identity', async t => {
  const {app, work, task, post, sign, rpc} = await fixture(t), epoch = app.policy.epoch;
  await app.handle('/api/settings', {relay_pilot_enable: true});
  const view = token => app.tools.relayKeeper.view({task_id: task.id, card_token: token},
    {caller: 'test-caller', session_hash: sessionHashOf('test-principal', '1050-test-session'), transport: 'mcp_app'});
  let relayClock=Date.now();for(const o of [app.tools.resume,app.tools.h8Cards,app.tools.relayKeeper])o.now=()=>relayClock;app.tools.resume.data.gaps=Array(200).fill(1000);
  const checkpoint = async () => {
    const out=await rpc('task_checkpoint',{task_id:task.id,done:'已完成当前检查',next:'接着做：检查当前权限'});assert.equal(out.isError,false,JSON.stringify(out));assert.equal(out.structuredContent.relay.state,'cancelled');
    relayClock+=600001;const seen=await rpc('relay_card_control',{action:'view',task_id:task.id,card_token:out._meta['chathand/relay_card_token']});const witness=seen._meta['chathand/relay_interruption_token'];assert.match(witness,/^[a-f0-9]{64}$/);
    const interrupted=await rpc('relay_card_control',{action:'interruption',task_id:task.id,interruption_token:witness});assert.equal(interrupted.isError,false,JSON.stringify(interrupted));const token=interrupted._meta['chathand/relay_card_token'];assert.equal(view(token).state,'armed');return token;
  };
  const first = await checkpoint();
  const revoked = await post('/api/permissions/revoke', {gate: 'scope', id: 'full'});
  assert.equal(revoked.body.ok, true, JSON.stringify(revoked));
  assert.equal(view(first).state, 'cancelled'); assert.equal(app.policy.require(task.id, 'test-caller'), task);
  assert.equal(task.status, 'active'); assert.equal(app.policy.epoch, epoch); assert.equal(app.store.root, work);
  const second = await checkpoint();
  const restored = await post('/api/permissions/undo', {receipt_id: revoked.body.undo.receipt_id, proof: sign(revoked.body.undo.receipt_id)});
  assert.equal(restored.body.restored, true, JSON.stringify(restored));
  assert.equal(view(second).state, 'cancelled'); assert.equal(app.policy.require(task.id, 'test-caller'), task);
  assert.equal(task.status, 'active'); assert.equal(app.policy.epoch, epoch); assert.equal(app.store.root, work);
  assert.equal(app.tools.relayKeeper.stats().real_trials, 0, 'a local fixture is not real host acceptance');
});

test('1050 real HTTP leaves authority lowered and execution fenced until failed admin cleanup is retried', async t => {
  const {app, admin, task, work, post} = await fixture(t);
  const uninstall = admin.uninstall;
  admin.uninstall = () => { admin.removals++; return {status: 'unconfirmed'}; };
  const revoked = await post('/api/permissions/revoke', {gate: 'scope', id: 'full'});
  assert.equal(revoked.body.error.code, 'ADMIN_REVOKE_UNCONFIRMED');
  assert.equal(app.state.data.mode, 'auto'); assert.equal(app.state.data.high_risk.admin, false);
  assert.equal(task.status, 'active'); assert.equal(admin.installed, true); assert.equal(app.policy.transitioning, true);
  assert.throws(() => app.queue.propose({program: '/usr/bin/true', args: [], cwd: work, request_id: 'blocked-' + (++sequence)}), error => error.code === 'PERMISSION_TRANSITION');
  const grant = await post('/api/settings', {browser_enabled: true});
  assert.equal(grant.body.error.code, 'PERMISSION_TRANSITION');
  admin.uninstall = uninstall;
  const retried = await post('/api/permissions/revoke', {gate: 'scope', id: 'full'});
  assert.equal(retried.body.ok, true, JSON.stringify(retried)); assert.equal(retried.body.undo, null);
  assert.equal(admin.installed, false); assert.equal(app.policy.transitioning, false);
  assert.equal(app.state.data.mode, 'auto'); assert.equal(app.policy.require(task.id, 'test-caller'), task);
});
