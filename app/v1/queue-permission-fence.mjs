const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const FENCED = Symbol('permission-fenced-queue');

export function jobIsLive(job) {
  return !!(job?.child || job?.process_alive || job?.cleanupPending || job?.cleanup_pending || job?.status === 'running');
}

// A Job Object contains a process tree; it does not sandbox file access.
export function fullUnsandboxedAtStart(job) {
  if (!job || !Number.isFinite(job.started_at)) return false;
  if (job.permission_launch) return job.permission_launch.scope === 'full' && job.permission_launch.file_sandbox === false;
  const sandbox = job.sandbox;
  if (!sandbox || typeof sandbox !== 'object') return false;
  if (sandbox.backend === 'none' && sandbox.scope === 'full') return true;
  if (job.admin && sandbox.backend === '管理员（sudo）' && sandbox.scope === 'computer') return true;
  return sandbox.not_os_sandbox === true && ['full', 'computer'].includes(sandbox.scope);
}

export function installQueuePermissionFence({queue, state, policy, isTransitioning, cleanupEvidence}) {
  if (!queue || !state || !policy || typeof isTransitioning !== 'function') throw new TypeError('Missing permission fence dependencies');
  if (queue[FENCED]) throw new TypeError('Queue already has a permission fence');
  queue[FENCED] = true;
  const revision = () => policy.permissionRevision || 0;
  const proposals = new Map();
  const launches = new Map();
  const check = () => {
    if (isTransitioning() || policy.transitioning) fail('PERMISSION_TRANSITION', '权限正在切换，请等待当前操作完成。');
    if (state.data.terminal_enabled === false) fail('CAPABILITY_DISABLED', '命令能力已关闭，请在对话中重新申请。');
    policy.check?.();
  };
  const checkJob = job => {
    check();
    if (!job || proposals.get(job.id) !== revision()) fail('PERMISSION_CHANGED', '这条命令的权限已改变，请在原任务中按当前范围重新申请。');
    if (job.admin && (state.data.mode !== 'full' || state.data.high_risk?.admin !== true)) {
      fail('NEEDS_FULL_ACCESS', '这条管理员命令需要当前的整台电脑与管理员权限。');
    }
  };
  const original = {};
  for (const name of ['propose', 'approve', 'prepareSpawn', 'approveInput']) {
    if (typeof queue[name] !== 'function') throw new TypeError(`Queue is missing ${name}`);
    original[name] = queue[name].bind(queue);
  }
  queue.propose = spec => {
    check();
    const before = revision();
    const result = original.propose(spec);
    // Replaying an old request must not refresh the authorization version.
    if (!result.replayed && result.job_id && !proposals.has(result.job_id)) proposals.set(result.job_id, before);
    return result;
  };
  queue.approve = id => {
    const job = queue.jobs.get(id);
    checkJob(job);
    try { return original.approve(id); }
    finally { cleanupEvidence?.capture(job); }
  };
  queue.prepareSpawn = job => {
    // Last synchronous boundary before the engine calls spawn().
    checkJob(job);
    const launch = original.prepareSpawn(job);
    const sandbox = job.sandbox || {};
    const full = state.data.mode === 'full' && ['full', 'computer'].includes(sandbox.scope);
    const fileSandbox = sandbox.backend === 'macOS Seatbelt' && ['auto', 'folder'].includes(sandbox.scope);
    const unsandboxed = sandbox.backend === 'none' || sandbox.backend === '管理员（sudo）' || sandbox.not_os_sandbox === true;
    const metadata = Object.freeze({revision: revision(), scope: full ? 'full' : 'folder', file_sandbox: fileSandbox ? true : unsandboxed ? false : null});
    launches.set(job.id, metadata);
    // Internal metadata only: the queue's publicJob whitelist does not expose it.
    Object.defineProperty(job, 'permission_launch', {value: metadata, enumerable: false, configurable: false, writable: false});
    return launch;
  };
  queue.approveInput = id => {
    check();
    const jobId = queue.inputs.get(id)?.job_id;
    const started = launches.get(jobId);
    if (!started || started.revision !== revision()) fail('PERMISSION_CHANGED', '这次输入对应的权限已改变，请先查看原命令状态。');
    return original.approveInput(id);
  };
  return Object.freeze({check});
}
