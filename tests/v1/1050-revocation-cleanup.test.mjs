// Real 1050 createDesktop/HTTP/transaction paths. Every OS admin, process,
// group-probe and cancellation effect below is synthetic and stays in /tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
import {AdminAccess, NoopAdminAccess, HELPER_PATH, SUDOERS_PATH, HELPER_OK} from '../../app/v1/admin-command.mjs';
import {OwnedJobCleanupEvidence} from '../../app/v1/permission-cleanup-evidence.mjs';
import {installQueuePermissionFence} from '../../app/v1/queue-permission-fence.mjs';
import {permissionUndoProofMessage} from '../../app/v1/native-owner-proof.mjs';

let sequence = 0;
const uiKey = 'd1'.repeat(32), nativeKey = 'e2'.repeat(32);
const missing = () => Object.assign(new Error('synthetic missing'), {code: 'ENOENT'});
function adminRig() {
  const h = {files: new Set(), visibility: 'known', helper: 'trusted', check: 'ok', remove: 'receipt', install: 'ok', installs: 0, removers: [], checks: 0};
  const stat = file => { assert.equal(file, HELPER_PATH); if (!h.files.has(file)) throw missing(); return {uid: 0, mode: 0o100755}; };
  const lstat = file => {
    assert.ok([HELPER_PATH, SUDOERS_PATH].includes(file));
    if ((file === SUDOERS_PATH && h.visibility === 'unknown') || (file === HELPER_PATH && h.helper === 'unknown')) throw Object.assign(new Error('synthetic permission denied'), {code: 'EACCES'});
    if (!h.files.has(file)) throw missing();
    if (file === HELPER_PATH) return {uid: h.helper === 'user_owned' ? 501 : 0, mode: h.helper === 'symlink' ? 0o120777 : h.helper === 'writable' ? 0o100775 : 0o100755};
    return {uid: 0, mode: 0o100440};
  };
  const run = async (program, args) => {
    assert.equal(program, '/usr/bin/osascript'); assert.equal(args[0], '-e'); h.installs++;
    h.files.add(HELPER_PATH); h.files.add(SUDOERS_PATH);
    if (h.install === 'failed_partial') { h.check = 'timeout'; h.visibility = 'unknown'; return {status: null, stdout: '', stderr: ''}; }
    h.check = 'ok'; h.visibility = 'known'; return {status: 0, stdout: 'chathand-admin-installed\n', stderr: ''};
  };
  const runSync = (program, args, options) => {
    assert.equal(program, '/usr/bin/sudo'); assert.equal(args[0], '-n'); assert.equal(args[1], HELPER_PATH);
    if (args[2] === '--check') { h.checks++; return h.check === 'ok' ? {status: 0, stdout: HELPER_OK} : {status: null, stdout: ''}; }
    if (args[2] === '--uninstall') {
      if (h.remove !== 'receipt') return {status: null, stdout: ''};
      h.files.clear(); return {status: 0, stdout: ''};
    }
    assert.deepEqual(args.slice(2, 7), ['--cd', '/', '--', '/bin/sh', '-c']);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4096);
    const script = args[7], nonce = script.match(/chathand-admin-removed-[a-f0-9]{64}/)?.[0];
    assert.ok(nonce); assert.equal((script.match(/\|\| exit 1/g) || []).length, 2);
    for (const file of [HELPER_PATH, SUDOERS_PATH]) { assert.ok(script.includes(`[ ! -e '${file}' ]`)); assert.ok(script.includes(`[ ! -L '${file}' ]`)); }
    h.removers.push({script, nonce});
    if (h.remove === 'exception') throw new Error('synthetic execution failure');
    if (h.remove === 'timeout') return {status: null, stdout: ''};
    if (h.remove === 'wrong_nonce') return {status: 0, stdout: 'chathand-admin-removed-' + '0'.repeat(64)};
    if (h.remove === 'partial') { h.files.delete(HELPER_PATH); return {status: 1, stdout: ''}; }
    h.files.clear(); return {status: 0, stdout: nonce + '\n'};
  };
  const admin = new AdminAccess({platform: 'darwin', user: 'synthetic-user', run, runSync, stat, lstat});
  return {admin, host: h};
}

async function fixture(t, {adminEnabled = false, platform = 'darwin', probe} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chathand-1050-f2-'))), work = path.join(root, 'work'); fs.mkdirSync(work);
  const rig = adminEnabled ? adminRig() : {admin: new NoopAdminAccess('1050_f2_fixture'), host: null};
  const groups = new Map(), probes = [];
  const evidence = new OwnedJobCleanupEvidence({platform, probeGroup: pid => { probes.push(pid); return probe ? probe(pid) : groups.get(pid) || 'unknown'; }});
  const app = await createDesktop({stateDir: path.join(root, 'state'), defaultRoot: work, uiKey, nativeOwnerKey: nativeKey, adminAccess: rig.admin,
    clientDeps: {
      permissionCleanupEvidence: evidence, currentAppPath: path.join(root, 'ChatHand.app'), computerName: () => '1050 F2 Synthetic Mac',
      tunnelFactory: () => ({child: null, doctorChild: null, log: [], status: 'off', stop() {}, snapshot: async () => ({status: 'off', ready: false, healthy: false, process_running: false})}),
      updaterFactory: () => ({currentBuild: 1050, snapshot: () => ({status: 'unknown', install: {state: 'idle'}}), forAI: () => ({status: 'unknown', request: null, just_updated: null}), start() {}, close() {}, settingsChanged() {}, cleanupLeftovers: async () => ({cleaned: 0})})
    }
  });
  const synthetic = new Set(), cancelled = [], originalCancel = app.queue.cancel.bind(app.queue);
  app.queue.cancel = (id, reason) => {
    if (!synthetic.has(id)) return originalCancel(id, reason);
    cancelled.push(id); const job = app.queue.jobs.get(id);
    if (job.child) job.child.exitCode = 0;
    job.child = null; job.cleanupPending = false; job.status = reason || 'cancelled';
    return app.queue.publicJob(job);
  };
  t.after(async () => {
    for (const id of synthetic) { const job = app.queue.jobs.get(id); job.child = null; job.cleanupPending = false; clearTimeout(job.cleanupTimer); }
    await app.close(); fs.rmSync(root, {recursive: true, force: true});
  });
  await app.handle('/api/access', {enabled: true}); await app.handle('/api/mode', {mode: 'full', confirm: true});
  await app.handle('/api/settings', {terminal_enabled: true, browser_enabled: true, desktop_enabled: true, high_risk: {admin: adminEnabled, autostart: false, erase: false, chatgpt_self: false}});
  const taskResult = (await app.tools.rpc({jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: {name: 'begin_task', arguments: {request_id: 'f2-task-' + sequence, title: '1050 F2 temporary fixture', new_task: true}, _meta: {'openai/session': 'f2-session', 'io.modelcontextprotocol/protocolVersion': '2026-07-28'}}}, 'f2-caller', {setupPrincipal: 'f2-principal'})).result;
  assert.equal(taskResult.isError, false); const task = app.policy.get(taskResult.structuredContent.task_id);
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${app.apiPort}${route}`, {method: 'POST', headers: {authorization: `Bearer ${app.adminToken}`, 'x-chathand-ui': uiKey, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  };
  const sign = id => { const now = Date.now(), nonce = (++sequence).toString(16).padStart(32, '0'); return {v: 1, issued_at: now, nonce, signature: createHmac('sha256', Buffer.from(nativeKey, 'hex')).update(permissionUndoProofMessage(id, now, nonce)).digest('hex')}; };
  const job = ({bound = true, ended = false} = {}) => {
    const proposed = app.queue.propose({program: '/usr/bin/true', args: [], cwd: work, request_id: 'f2-synthetic-' + (++sequence)}), j = app.queue.get(proposed.job_id), pid = 410600 + sequence;
    synthetic.add(j.id);
    Object.assign(j, {started_at: Date.now(), status: 'running', pid, child: {pid, exitCode: null, signalCode: null, synthetic: true}, sandbox: {backend: 'none', scope: 'full'}});
    if (bound) assert.equal(evidence.capture(j), true); // Synthetic current spawn, never a persisted PID.
    if (ended) { j.child.exitCode = 0; j.child = null; j.status = 'completed'; j.cleanupPending = false; }
    return j;
  };
  const blocked = async response => {
    assert.equal(response.body.undo, undefined); assert.notEqual(response.body.ok, true);
    assert.equal(app.state.data.mode, 'auto'); assert.equal(app.policy.transitioning, true); assert.equal(task.status, 'active'); assert.equal(app.store.root, work);
    const grant = await post('/api/settings', {browser_enabled: true}); assert.equal(grant.body.error.code, 'PERMISSION_TRANSITION');
    assert.throws(() => app.queue.propose({program: '/usr/bin/true', args: [], cwd: work, request_id: 'f2-blocked-' + (++sequence)}), e => e.code === 'PERMISSION_TRANSITION');
  };
  return {app, work, task, post, sign, evidence, groups, probes, cancelled, job, blocked, ...rig};
}
const revoke = f => f.post('/api/permissions/revoke', {gate: 'scope', id: 'full'});

test('1050 F2 real HTTP: uninstall timeout plus ready false cannot clear recovery or issue undo', async t => {
  const f = await fixture(t, {adminEnabled: true});
  f.host.check = 'timeout'; f.host.remove = 'timeout'; f.host.visibility = 'unknown';
  assert.equal(f.admin.uninstall().status, 'not_installed'); assert.equal(f.admin.ready({fresh: true}), false);
  const failed = await revoke(f); assert.equal(failed.body.error.code, 'ADMIN_REVOKE_UNCONFIRMED'); await f.blocked(failed);
  assert.ok(f.host.removers.length > 0); assert.equal(f.app.state.data.high_risk.admin, false);
  f.host.files.clear(); f.host.visibility = 'known';
  const retry = await revoke(f); assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null); assert.equal(f.app.policy.transitioning, false);
});

test('1050 F2 real HTTP: wrong remover receipt and partial presence stay closed; fresh bound receipt resolves unknown lstat', async t => {
  const f = await fixture(t, {adminEnabled: true}); f.host.remove = 'wrong_nonce';
  const wrong = await revoke(f); assert.equal(wrong.body.error.code, 'ADMIN_REVOKE_UNCONFIRMED'); await f.blocked(wrong);
  f.host.remove = 'partial'; const partial = await revoke(f); assert.equal(partial.body.error.code, 'ADMIN_REVOKE_UNCONFIRMED'); await f.blocked(partial);
  assert.equal(f.host.files.has(SUDOERS_PATH), true); assert.equal(f.host.files.has(HELPER_PATH), false);
  f.host.files.add(HELPER_PATH); f.host.visibility = 'unknown'; f.host.remove = 'exception';
  const exception = await revoke(f); assert.equal(exception.body.error.code, 'ADMIN_REVOKE_UNCONFIRMED'); await f.blocked(exception);
  f.host.remove = 'receipt'; const retry = await revoke(f);
  assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null); assert.equal(f.host.files.size, 0); assert.equal(f.app.policy.transitioning, false);
  assert.equal(new Set(f.host.removers.map(x => x.nonce)).size, f.host.removers.length, 'each privileged remover invocation has a fresh receipt');
});

test('1050 F2 real HTTP: uncertain rollback of a partial admin install keeps undo failed and execution closed', async t => {
  const f = await fixture(t, {adminEnabled: true}), revoked = await revoke(f); assert.equal(revoked.body.ok, true);
  const id = revoked.body.undo.receipt_id; f.host.install = 'failed_partial'; f.host.remove = 'timeout';
  const result = await f.post('/api/permissions/undo', {receipt_id: id, proof: f.sign(id)});
  assert.equal(result.body.error.code, 'ADMIN_SETUP_FAILED'); await f.blocked(result); assert.equal(f.app.state.data.high_risk.admin, false);
  f.host.remove = 'receipt'; const retry = await revoke(f); assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null); assert.equal(f.host.files.size, 0);
});

test('1050 F2 real HTTP: untrusted or unknown helper cannot issue a trusted remover receipt', async t => {
  const f = await fixture(t, {adminEnabled: true});
  for (const helper of ['user_owned', 'writable', 'symlink', 'unknown']) {
    f.host.helper = helper;
    const result = await revoke(f); assert.equal(result.body.error.code, 'ADMIN_REVOKE_UNCONFIRMED'); await f.blocked(result);
    assert.equal(f.host.removers.length, 0, 'untrusted launcher is never executed'); assert.equal(f.host.files.size, 2);
  }
  f.host.helper = 'trusted'; const retry = await revoke(f);
  assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null); assert.equal(f.host.removers.length, 1); assert.equal(f.host.files.size, 0);
});

test('1050 F2 real HTTP: unknown admin state before restore does not install and requires confirmed cleanup', async t => {
  const f = await fixture(t, {adminEnabled: true}), revoked = await revoke(f); assert.equal(revoked.body.ok, true);
  const id = revoked.body.undo.receipt_id, before = f.host.installs; f.host.visibility = 'unknown';
  const result = await f.post('/api/permissions/undo', {receipt_id: id, proof: f.sign(id)});
  assert.equal(result.body.error.code, 'ADMIN_STATUS_UNCONFIRMED'); assert.equal(f.host.installs, before); await f.blocked(result);
  f.host.visibility = 'known'; const retry = await revoke(f); assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null);
});

test('1050 F2 real HTTP: departed leader and cleared pending do not prove the original process group stopped', async t => {
  const f = await fixture(t), j = f.job(); f.groups.set(j.pid, 'present');
  const result = await revoke(f); assert.equal(result.body.error.code, 'REVOCATION_STOP_INCOMPLETE'); await f.blocked(result);
  assert.equal(j.child, null); assert.equal(j.cleanupPending, false); assert.deepEqual(f.cancelled, [j.id]);
  assert.ok(f.probes.length > 0 && f.probes.every(pid => pid === j.pid));
  f.groups.set(j.pid, 'absent'); const retry = await revoke(f); assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null); assert.deepEqual(f.cancelled, [j.id]);
});

test('1050 F2 real HTTP: EPERM or unknown group probe stays closed even after child and cleanup flags are gone', async t => {
  let deny = true;
  const f = await fixture(t, {probe: () => { if (deny) throw Object.assign(new Error('synthetic EPERM'), {code: 'EPERM'}); return 'absent'; }}), j = f.job({ended: true});
  const result = await revoke(f); assert.equal(result.body.error.code, 'REVOCATION_STOP_UNCONFIRMED'); await f.blocked(result); assert.deepEqual(f.cancelled, []);
  deny = false; const retry = await revoke(f); assert.equal(retry.body.ok, true); assert.equal(retry.body.undo, null); assert.equal(j.child, null);
});

test('1050 F2 real HTTP: historical or changed PIDs never authorize cancellation or a group probe', async t => {
  const f = await fixture(t); f.job({bound: false}); const replaced = f.job(); replaced.pid += 10000;
  const result = await revoke(f); assert.equal(result.body.error.code, 'REVOCATION_STOP_UNCONFIRMED'); await f.blocked(result);
  assert.deepEqual(f.cancelled, []); assert.deepEqual(f.probes, []);
});

test('1050 F2 queue boundary captures ownership only after the actual approve spawn path returns', () => {
  const evidence = new OwnedJobCleanupEvidence({platform: 'darwin', probeGroup: () => 'absent'}), state = {data: {mode: 'full', terminal_enabled: true}}, policy = {permissionRevision: 1, check() {}}, queue = {
    jobs: new Map(), inputs: new Map(),
    propose() { const job = {id: 'owned-job', sandbox: {backend: 'none', scope: 'full'}}; this.jobs.set(job.id, job); return {job_id: job.id}; },
    prepareSpawn() { return {}; },
    approve(id) { const job = this.jobs.get(id); job.started_at = 1; this.prepareSpawn(job); job.pid = 410999; job.child = {pid: job.pid, exitCode: null, signalCode: null}; return {job_id: id}; },
    approveInput() {}
  };
  installQueuePermissionFence({queue, state, policy, isTransitioning: () => false, cleanupEvidence: evidence});
  queue.propose(); const job = queue.jobs.get('owned-job'); assert.equal(evidence.mayRequestCancel(job), false);
  queue.approve(job.id); assert.equal(evidence.mayRequestCancel(job), true); assert.equal(job.permission_launch.scope, 'full');
  job.child.exitCode = 0; job.child = null; assert.equal(evidence.status(job).state, 'confirmed');
  job.pid++; assert.equal(evidence.status(job).state, 'unknown'); assert.equal(evidence.mayRequestCancel(job), false);
});

test('1050 F2 default test isolation does not probe host process groups or administrator files', () => {
  const evidence = new OwnedJobCleanupEvidence(), job = {id: 'synthetic', started_at: 1, pid: 411000, child: {pid: 411000, exitCode: 0, signalCode: null}};
  evidence.capture(job); job.child = null; assert.equal(evidence.status(job).reason, 'PROCESS_PROBE_UNAVAILABLE');
  const admin = new AdminAccess({platform: 'darwin', user: 'synthetic-user', run: async () => ({}), runSync: () => ({}), stat: () => ({})});
  assert.throws(() => admin.removalEvidence(), e => e.code === 'ADMIN_TEST_CONTEXT_BLOCKED');
  assert.throws(() => admin.uninstallForRevocation(), e => e.code === 'ADMIN_TEST_CONTEXT_BLOCKED');
});
