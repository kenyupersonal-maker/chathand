// Evidence for the new permission transaction only. This adapter never sends
// TERM/KILL. A PID from history is not authority to cancel a current process.
const nativeGroupProbe = pid => {
  try { process.kill(-pid, 0); return 'present'; }
  catch (error) { return error?.code === 'ESRCH' ? 'absent' : 'unknown'; }
};

export class OwnedJobCleanupEvidence {
  #owned = new Map(); #platform; #probe; #mayProbe;
  constructor({platform = process.platform, probeGroup = nativeGroupProbe, isolated = false} = {}) {
    if (typeof probeGroup !== 'function') throw new TypeError('Invalid process group probe');
    this.#platform = platform; this.#probe = probeGroup;
    // A temporary/test desktop must not probe host PIDs through a default effect.
    this.#mayProbe = probeGroup !== nativeGroupProbe || (!isolated && !process.env.NODE_TEST_CONTEXT);
  }
  // Called by the queue wrapper immediately after its actual synchronous spawn
  // path. Never reconstruct ownership from persisted records or public status.
  capture(job) {
    if (!job || this.#owned.has(job.id)) return false;
    const child = job.child, pid = job.pid;
    if (typeof job.id !== 'string' || !Number.isFinite(job.started_at) || !Number.isSafeInteger(pid) || pid <= 1 || !child || child.pid !== pid) return false;
    this.#owned.set(job.id, {job, child, pid, confirmed: false});
    return true;
  }
  #binding(job) {
    const binding = job && this.#owned.get(job.id);
    return binding && binding.job === job && job.pid === binding.pid ? binding : null;
  }
  mayRequestCancel(job) {
    const b = this.#binding(job);
    // A departed leader or reused historical PID must never trigger new signals.
    return !!(b && !b.confirmed && job.child === b.child && b.child.pid === b.pid && b.child.exitCode === null && b.child.signalCode === null);
  }
  status(job) {
    const b = this.#binding(job);
    if (!b) return {state: 'unknown', reason: 'PROCESS_OWNERSHIP_UNVERIFIED'};
    if (b.confirmed) return {state: 'confirmed'};
    if (!['darwin', 'linux'].includes(this.#platform) || !this.#mayProbe) return {state: 'unknown', reason: 'PROCESS_PROBE_UNAVAILABLE'};
    let observation;
    try { observation = this.#probe(b.pid); } catch { observation = 'unknown'; }
    if (observation === 'present') return {state: 'pending', reason: 'PROCESS_GROUP_PRESENT'};
    if (observation !== 'absent') return {state: 'unknown', reason: 'PROCESS_GROUP_UNCONFIRMED'};
    // Group absence plus the bound leader's exit prevents a spawn-start race.
    if (job.child === b.child && b.child.exitCode === null && b.child.signalCode === null) return {state: 'pending', reason: 'LEADER_EXIT_PENDING'};
    b.confirmed = true;
    // Once absence is proven, cancel the old engine escalation timer so it can
    // never signal a later process group that happens to reuse this numeric PID.
    clearTimeout(job.cleanupTimer); job.cleanupPending = false;
    return {state: 'confirmed'};
  }
}
