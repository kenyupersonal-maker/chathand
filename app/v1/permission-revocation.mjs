import {createHash, randomBytes} from 'node:crypto';
import {fullUnsandboxedAtStart, jobIsLive} from './queue-permission-fence.mjs';

export const FULL_DEPENDENT_HIGH_RISK = Object.freeze(['admin', 'autostart', 'erase', 'bulk_delete', 'keychain', 'pipe_run', 'gatekeeper', 'bulk_perm', 'power']);
const HIGH_RISK_IDS = Object.freeze([...FULL_DEPENDENT_HIGH_RISK, 'chatgpt_self']);
const CAPABILITIES = Object.freeze({terminal: 'terminal_enabled', browser: 'browser_enabled', desktop: 'desktop_enabled'});
const LABELS = Object.freeze({full: '整台电脑', terminal: '命令', browser: '浏览器', desktop: '桌面', admin: '管理员', autostart: '开机启动', erase: '擦除', bulk_delete: '批量删除', keychain: '钥匙串', pipe_run: '下载并执行', gatekeeper: '安全限制', bulk_perm: '批量权限', power: '电源操作', chatgpt_self: 'ChatGPT 自身控制'});
const PERMISSION_FIELDS = Object.freeze(['mode', 'full_access_confirmed', 'terminal_enabled', 'browser_enabled', 'desktop_enabled', 'high_risk', 'admin_requested', 'permission_tier_intent', 'permission_origins']);
const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), {code, ...details}); };
const clone = value => value === undefined ? undefined : structuredClone(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const field = (object, key) => Object.hasOwn(object, key) ? {present: true, value: clone(object[key])} : {present: false};
const assignField = (object, key, entry) => { if (entry.present) object[key] = clone(entry.value); else delete object[key]; };
const gateForRisk = id => ['admin', 'autostart'].includes(id) ? 'common' : 'high_risk';

export function permissionSnapshot(state, store, policy) {
  return {
    values: Object.fromEntries(PERMISSION_FIELDS.map(key => [key, field(state.data, key)])),
    adminSetup: field(state.data.setup_open_status || {}, 'admin'),
    context: {root: store.root, project: state.data.active, epoch: policy.epoch || 0, access_enabled: state.data.access_enabled, policy_enabled: policy.enabled, paused: store.paused}
  };
}

function digest(snapshot) { return createHash('sha256').update(JSON.stringify(stable(snapshot))).digest('hex'); }
function changesBetween(before, after) {
  const changes = [];
  for (const key of PERMISSION_FIELDS) if (!same(before.values[key], after.values[key])) changes.push({key, before: before.values[key], after: after.values[key]});
  if (!same(before.adminSetup, after.adminSetup)) changes.push({key: 'setup_open_status.admin', before: before.adminSetup, after: after.adminSetup});
  return changes;
}
function applyChanges(data, changes, side) {
  for (const change of changes) {
    if (change.key === 'setup_open_status.admin') {
      if (change[side].present) data.setup_open_status ||= {};
      if (data.setup_open_status) assignField(data.setup_open_status, 'admin', change[side]);
    } else assignField(data, change.key, change[side]);
  }
}

export class PermissionRevocations {
  #state; #store; #policy; #queue; #confirmations; #admin; #automation; #transition; #proof; #authorityChanged; #cleanup;
  #now; #sleep; #ttl; #stopTimeout; #normalise; #receipts = new Map(); #recovery = null;

  constructor({state, store, policy, queue, confirmations, adminAccess, automation = {}, transition, ownerProof, onAuthorityChanged = () => {}, cleanupEvidence,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), receiptTtlMs = 5000, stopTimeoutMs = 5000,
    normalizeHighRisk = value => Object.fromEntries(HIGH_RISK_IDS.map(id => [id, value?.[id] === true]))} = {}) {
    if (!state || !store || !policy || !queue || !confirmations || !transition || typeof transition.get !== 'function' || typeof transition.set !== 'function') throw new TypeError('Missing permission transaction dependencies');
    if (!Number.isSafeInteger(receiptTtlMs) || receiptTtlMs < 1 || receiptTtlMs > 30000 || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 10000) throw new TypeError('Invalid permission transaction limits');
    this.#state = state; this.#store = store; this.#policy = policy; this.#queue = queue; this.#confirmations = confirmations;
    this.#admin = adminAccess; this.#automation = automation; this.#transition = transition; this.#proof = ownerProof;
    if (typeof onAuthorityChanged !== 'function') throw new TypeError('Invalid authority change callback');
    this.#authorityChanged = onAuthorityChanged;
    this.#cleanup = cleanupEvidence;
    this.#now = now; this.#sleep = sleep; this.#ttl = receiptTtlMs; this.#stopTimeout = stopTimeoutMs; this.#normalise = normalizeHighRisk;
  }

  get blocked() { return this.#recovery !== null; }
  #snapshot() { return permissionSnapshot(this.#state, this.#store, this.#policy); }
  #revision() { return this.#policy.permissionRevision || 0; }
  #syncMode() { this.#store.accessMode = this.#state.data.mode; this.#policy.fullArmed = this.#state.data.mode === 'full' && this.#state.data.full_access_confirmed === true; }
  #enter({allowRecovery = false} = {}) {
    if (this.#transition.get() || (this.#policy.transitioning && !this.blocked)) fail('PERMISSION_TRANSITION', '权限正在切换，请等待当前操作完成。');
    if (this.blocked && !allowRecovery) fail('PERMISSION_RECOVERY_REQUIRED', '上次收权尚未完成，请先重试撤回。');
    this.#transition.set(true); this.#policy.transitioning = true;
  }
  #leave() { this.#transition.set(false); this.#policy.transitioning = this.blocked; }
  #bump() {
    this.#policy.permissionRevision = this.#revision() + 1;
    this.#confirmations.permissionsChanged();
    this.#authorityChanged();
  }
  #prune() {
    const now = this.#now();
    for (const [id, receipt] of this.#receipts) if (now - receipt.expires_at > 60000) this.#receipts.delete(id);
    // Optional undo history must never prevent narrowing authority. A newer
    // revocation invalidates the previous revision, so dropping the oldest
    // receipt is safe and keeps the private store bounded.
    while (this.#receipts.size >= 256) this.#receipts.delete(this.#receipts.keys().next().value);
  }
  #plan({gate, id} = {}) {
    if (!(gate === 'scope' && id === 'full') && !(gate === 'capability' && Object.hasOwn(CAPABILITIES, id)) && !(HIGH_RISK_IDS.includes(id) && gateForRisk(id) === gate)) fail('ARG_INVALID', '没有这项可撤回权限。');
    const before = this.#snapshot();
    // Copy only permission fields; unrelated settings and credentials never
    // enter a restoration snapshot or the transaction's working copy.
    const data = {active: this.#state.data.active, access_enabled: this.#state.data.access_enabled};
    for (const key of PERMISSION_FIELDS) assignField(data, key, before.values[key]);
    if (before.adminSetup.present) data.setup_open_status = {admin: clone(before.adminSetup.value)};
    const risk = this.#normalise(data.high_risk);
    let closed = [];
    if (gate === 'scope') {
      data.mode = 'auto'; data.full_access_confirmed = false;
      closed = FULL_DEPENDENT_HIGH_RISK.filter(key => risk[key] === true);
      data.high_risk = {...risk};
      for (const key of FULL_DEPENDENT_HIGH_RISK) data.high_risk[key] = false;
      data.admin_requested = false;
      if (data.setup_open_status) delete data.setup_open_status.admin;
    } else if (gate === 'capability') data[CAPABILITIES[id]] = false;
    else {
      data.high_risk = {...risk, [id]: false};
      if (risk[id] === true) closed = [id];
      if (id === 'admin') { data.admin_requested = false; if (data.setup_open_status) delete data.setup_open_status.admin; }
    }
    data.permission_tier_intent = 'custom';
    const after = permissionSnapshot({data}, this.#store, this.#policy);
    // A false preference is not proof that a previous external removal worked.
    return {gate, id, before, after, changes: changesBetween(before, after), closed, adminOff: gate === 'scope' || id === 'admin'};
  }
  #revokeGrants(plan) {
    if (plan.gate === 'scope') {
      this.#confirmations.revoke('scope', 'full');
      for (const id of FULL_DEPENDENT_HIGH_RISK) this.#confirmations.revoke(gateForRisk(id), id);
    } else this.#confirmations.revoke(plan.gate, plan.id);
  }
  #stopEvidence(job) {
    try { return this.#cleanup?.status(job) || {state: 'unknown'}; }
    catch { return {state: 'unknown'}; }
  }
  #requestStop(job) {
    // Never use a historical/reused PID as authority to signal a process group.
    if (job && this.#cleanup?.mayRequestCancel(job) === true) this.#queue.cancel(job.id, 'permission_revoked');
  }
  #targetJobs(plan) {
    return [...this.#queue.jobs.values()].filter(job =>
      (jobIsLive(job) || Number.isFinite(job.started_at)) &&
      (plan.gate === 'scope' ? fullUnsandboxedAtStart(job) : plan.gate === 'capability' && plan.id === 'terminal' ? true : plan.id === 'admin' && !!job.admin) &&
      this.#stopEvidence(job).state !== 'confirmed'
    ).map(job => job.id);
  }
  async #stopJobs(ids) {
    for (const id of ids) this.#requestStop(this.#queue.jobs.get(id));
    const until = this.#now() + this.#stopTimeout;
    for (;;) {
      const states = ids.map(id => this.#stopEvidence(this.#queue.jobs.get(id)).state);
      if (states.every(state => state === 'confirmed')) return;
      if (states.some(state => state !== 'confirmed' && state !== 'pending')) fail('REVOCATION_STOP_UNCONFIRMED', '权限已收回，但旧命令停止证据尚未确认。执行保持暂停，请重试撤回。', {applied: true});
      if (this.#now() >= until) fail('REVOCATION_STOP_INCOMPLETE', '权限已收回，但旧命令尚未确认停止。请重试撤回。', {applied: true});
      await this.#sleep(25);
    }
  }
  async #disableAdmin(needed) {
    if (!needed || !this.#admin?.supported?.()) return;
    let result;
    try { result = await this.#admin.uninstallForRevocation?.(); } catch {}
    if (result?.status !== 'removed' || result?.absence_confirmed !== true) fail('ADMIN_REVOKE_UNCONFIRMED', '管理员权限已关闭，但系统规则移除尚未确认。请重试撤回。', {applied: true});
  }

  async revoke(request, {withinTransition = false} = {}) {
    const plan = this.#plan(request);
    if (withinTransition) {
      // The private settings/tier handler already owns this transition. Keep
      // that outer lock held until its remaining settings commit has finished.
      if (!this.#transition.get() || this.#policy.transitioning || this.blocked) fail('PERMISSION_TRANSITION', '权限正在切换，请等待当前操作完成。');
      this.#policy.transitioning = true;
    } else this.#enter({allowRecovery: true});
    let committed = false;
    const recovering = this.#recovery;
    try {
      this.#prune();
      this.#bump();
      this.#revokeGrants(plan);
      const jobs = [...new Set([...this.#targetJobs(plan), ...(recovering?.jobs || [])])];
      const adminOff = plan.adminOff || recovering?.adminOff === true;
      // Recoveries retain only revocation obligations, never a restoration snapshot.
      const capabilities = [...new Set([...(recovering?.capabilities || []), ...(plan.gate === 'capability' && ['browser', 'desktop'].includes(plan.id) ? [plan.id] : [])])];
      this.#recovery = {jobs, adminOff, capabilities};
      applyChanges(this.#state.data, plan.changes, 'after'); this.#syncMode();
      // A disk error must not leave an old unsandboxed process running simply
      // because persistence failed before the cancellation request was reached.
      for (const id of jobs) { try { this.#requestStop(this.#queue.jobs.get(id)); } catch {} }
      // Start browser/desktop cancellation before disk I/O too. Observe cleanup
      // failures immediately so a failed save cannot leave a rejected promise
      // unhandled; successful saves still await the original stop confirmation.
      const capabilityStops = capabilities.map(capability => (async () => {
        const controller = capability === 'browser' ? this.#automation.browser : this.#automation.computer;
        const method = capability === 'browser' ? 'closeAll' : 'cancelAll';
        if (typeof controller?.[method] !== 'function') fail('CAPABILITY_STOP_UNAVAILABLE', '能力已关闭，但现有操作停止尚未确认。请重试撤回。', {applied: true});
        await controller[method]();
      })().then(() => null, error => ({error})));
      try { this.#state.save(); committed = true; }
      catch { fail('REVOCATION_PERSISTENCE_FAILED', '权限已在本次运行中收回，但保存尚未确认。执行已暂停，请重试撤回。', {applied: true}); }
      await this.#disableAdmin(adminOff);
      for (const stop of capabilityStops) { const failure = await stop; if (failure) throw failure.error; }
      await this.#stopJobs(jobs);
      this.#recovery = null;
      // A pause, workspace change, or a stopped task must never be reversed by undo.
      const after = this.#snapshot();
      const unchangedContext = same(plan.before.context, after.context);
      const message = plan.gate === 'scope' ? `已撤回整台电脑和 ${plan.closed.length} 项高危权限` : `已撤回 ${LABELS[plan.id]}`;
      let undo = null;
      if (plan.changes.length && !recovering && unchangedContext && this.#proof?.configured) {
        const receipt_id = 'pr_' + randomBytes(16).toString('hex');
        const expires_at = this.#now() + this.#ttl;
        this.#receipts.set(receipt_id, {receipt_id, state: 'available', before: plan.before, after, changes: clone(plan.changes), revision: this.#revision(), digest: digest(after), expires_at, message});
        undo = {receipt_id, expires_at};
      }
      this.#policy.emit?.('permissions_changed');
      return {ok: true, revoked: true, changed: plan.changes.length > 0, revoked_high_risk_count: plan.closed.length, message, undo};
    } catch (error) {
      // Once lower authority was applied, never widen it to hide a cleanup error.
      if (this.#recovery) { this.#syncMode(); error.applied = true; error.do_not_replay = true; }
      if (committed) this.#policy.emit?.('permissions_changed');
      throw error;
    } finally {
      if (withinTransition) this.#policy.transitioning = this.blocked;
      else this.#leave();
    }
  }

  #receipt(id) {
    const receipt = typeof id === 'string' ? this.#receipts.get(id) : null;
    if (!receipt) fail('UNDO_INVALID', '未找到对应的撤回记录，请查看当前权限。');
    if (receipt.state !== 'available') fail(receipt.state === 'stale' ? 'UNDO_STALE' : receipt.state === 'expired' ? 'UNDO_EXPIRED' : 'UNDO_USED', '这次撤销已处理或失效，请查看当前权限。');
    if (this.#now() >= receipt.expires_at) { receipt.state = 'expired'; fail('UNDO_EXPIRED', '撤销已过期，请在设置中重新开启。'); }
    if (receipt.revision !== this.#revision() || receipt.digest !== digest(this.#snapshot())) { receipt.state = 'stale'; fail('UNDO_STALE', '权限或任务环境已改变，这次撤销已失效。'); }
    return receipt;
  }

  // Native presentation reads labels only. Snapshots and signing material stay private.
  describe(id) {
    const receipt = this.#receipt(id);
    return {ok: true, receipt_id: id, message: receipt.message, expires_at: receipt.expires_at, remaining_ms: Math.max(0, receipt.expires_at - this.#now())};
  }

  async undo({receipt_id, proof} = {}) {
    this.#enter();
    let receipt, adminInstallAttempted = false, beforeAdminAbsent = false;
    try {
      receipt = this.#receipt(receipt_id);
      if (!this.#proof) fail('NATIVE_OWNER_AUTH_REQUIRED', '请在 ChatHand 原生窗口亲自撤销。');
      this.#proof.verifyAndConsume(receipt_id, proof);
      receipt.state = 'applying'; // Once acquired, an uncertain external effect is never replayed.
      const expectedRevision = receipt.revision + 1;
      this.#bump();
      const assertCurrent = () => {
        // TTL bounds acquiring this one-use transaction, not how quickly a
        // person must finish the system administrator authorization prompt.
        if (this.#revision() !== expectedRevision || receipt.digest !== digest(this.#snapshot())) fail('UNDO_STALE', '权限或任务环境已改变，这次撤销已失效。');
      };
      assertCurrent();
      const restoringAdmin = receipt.changes.some(change => change.key === 'high_risk' && change.before.value?.admin === true && change.after.value?.admin !== true);
      if (restoringAdmin) {
        if (!this.#admin?.supported?.()) fail('ADMIN_SETUP_FAILED', '当前环境无法恢复管理员权限。');
        const beforeAdminReady = this.#admin.ready({fresh: true});
        if (beforeAdminReady !== true) {
          const absent = this.#admin.removalEvidence?.();
          if (absent?.status !== 'absent') { this.#recovery = {jobs: [], adminOff: true}; fail('ADMIN_STATUS_UNCONFIRMED', '管理员规则状态尚未确认，权限未恢复。'); }
          beforeAdminAbsent = true; adminInstallAttempted = true;
          const result = await this.#admin.install();
          if (result?.status !== 'installed' || this.#admin.ready({fresh: true}) !== true) fail(result?.status === 'cancelled' ? 'ADMIN_SETUP_CANCELLED' : 'ADMIN_SETUP_FAILED', result?.message || '管理员授权没有完成，权限未恢复。');
        }
        assertCurrent();
      }
      applyChanges(this.#state.data, receipt.changes, 'before'); this.#syncMode();
      try { this.#state.save(); }
      catch (error) {
        // Restore the narrower post-revoke configuration; never report a partial grant.
        applyChanges(this.#state.data, receipt.changes, 'after'); this.#syncMode();
        try { this.#state.save(); } catch { this.#recovery = {jobs: [], adminOff: restoringAdmin}; }
        fail('UNDO_PERSISTENCE_FAILED', '撤销未保存，已保留收回后的权限。请查看设置。', {cause: error});
      }
      receipt.state = 'used';
      this.#policy.emit?.('permissions_changed');
      return {ok: true, restored: true, message: '权限已恢复'};
    } catch (error) {
      if (receipt?.state === 'applying') receipt.state = 'failed';
      // Remove only a rule whose absence before this attempt was proven.
      if (beforeAdminAbsent && adminInstallAttempted) {
        try { await this.#disableAdmin(true); }
        catch { this.#recovery = {jobs: [], adminOff: true}; }
      }
      throw error;
    } finally { this.#leave(); }
  }
}
