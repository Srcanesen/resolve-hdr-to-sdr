// Shared lifecycle policy for inspection, conversion, and verification.
// Values are intentionally conservative for real media while remaining injectable in tests.
const DEFAULT_HEAVY_OPERATION_POLICY = Object.freeze({
  inspectionTimeoutMs: 20_000,
  inspectionStallTimeoutMs: 10_000,
  conversionTimeoutMs: 30 * 60 * 1_000,
  conversionStallTimeoutMs: 60_000,
  verifierTimeoutMs: 20_000,
  verifierStallTimeoutMs: 10_000,
  // Process groups get TERM first, then KILL only after this bounded grace.
  terminationGraceMs: 1_000,
});

const PROCESS_GROUP_OWNED = Symbol('hdrtosdr.processGroupOwned');
const MAX_TERMINATION_GRACE_MS = 30_000;

function normalizePolicy(overrides = {}) {
  const nested = overrides.heavyOperationPolicy || overrides.operationPolicy || {};
  const policy = { ...DEFAULT_HEAVY_OPERATION_POLICY, ...nested };
  for (const key of Object.keys(DEFAULT_HEAVY_OPERATION_POLICY)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) policy[key] = overrides[key];
  }
  const commonTimeout = overrides.operationTimeoutMs ?? overrides.timeoutMs ?? nested.timeoutMs;
  const commonStallTimeout = overrides.operationStallTimeoutMs ?? overrides.stallTimeoutMs ?? nested.stallTimeoutMs;
  if (Number.isFinite(commonTimeout)) {
    policy.inspectionTimeoutMs = commonTimeout;
    policy.conversionTimeoutMs = commonTimeout;
    policy.verifierTimeoutMs = commonTimeout;
  }
  if (Number.isFinite(commonStallTimeout)) {
    policy.inspectionStallTimeoutMs = commonStallTimeout;
    policy.conversionStallTimeoutMs = commonStallTimeout;
    policy.verifierStallTimeoutMs = commonStallTimeout;
  }
  const grace = overrides.terminationGraceMs
    ?? overrides.processTerminationGraceMs
    ?? overrides.killGraceMs
    ?? overrides.graceMs
    ?? nested.terminationGraceMs
    ?? nested.processTerminationGraceMs
    ?? nested.killGraceMs
    ?? nested.graceMs;
  if (Number.isFinite(grace)) policy.terminationGraceMs = grace;
  const categories = [
    ['inspection', 'inspectionTimeoutMs', 'inspectionStallTimeoutMs'],
    ['conversion', 'conversionTimeoutMs', 'conversionStallTimeoutMs'],
    ['verifier', 'verifierTimeoutMs', 'verifierStallTimeoutMs'],
  ];
  for (const [name, timeoutKey, stallKey] of categories) {
    const category = nested[name];
    if (!category || typeof category !== 'object') continue;
    if (Number.isFinite(category.timeoutMs)) policy[timeoutKey] = category.timeoutMs;
    if (Number.isFinite(category.stallTimeoutMs)) policy[stallKey] = category.stallTimeoutMs;
  }
  for (const key of Object.keys(DEFAULT_HEAVY_OPERATION_POLICY)) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) {
      policy[key] = DEFAULT_HEAVY_OPERATION_POLICY[key];
    }
  }
  policy.terminationGraceMs = Math.min(MAX_TERMINATION_GRACE_MS, policy.terminationGraceMs);
  return Object.freeze(policy);
}

function markProcessGroupOwned(child) {
  if (!child || typeof child !== 'object') return child;
  try {
    Object.defineProperty(child, PROCESS_GROUP_OWNED, {
      configurable: true,
      enumerable: false,
      value: true,
      writable: false,
    });
  } catch {}
  return child;
}

function isSafePid(pid) {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

function isPosix() {
  return process.platform !== 'win32';
}

class HeavyOperationCoordinator {
  constructor(policy = {}) {
    this.policy = normalizePolicy(policy);
    this.active = null;
    // `processes` is intentionally the public live-process set used by the
    // service. `records` retains a terminating group until its descendants are
    // gone (the leader may close before its inherited descendants do).
    this.processes = new Set();
    this.records = new Map();
    this.terminationTimers = new Set();
    this.disposed = false;
    this.disposePromise = null;
    this.lateTerminationPromises = new Set();
  }

  reserve(kind, ownerWebContentsId) {
    if (this.disposed || this.active || this.records.size > 0) return null;
    const operation = {
      kind,
      ownerWebContentsId,
      abortController: new AbortController(),
      processes: new Set(),
      released: false,
    };
    this.active = operation;
    return operation;
  }

  release(operation) {
    if (!operation || operation.released) return;
    operation.released = true;
    if (this.active === operation) this.active = null;
  }

  hasActive() {
    return this.active !== null;
  }

  track(child, operation = this.active) {
    if (!child || typeof child.kill !== 'function') return;
    let record = this.records.get(child);
    if (!record) {
      record = {
        child,
        pid: child.pid,
        groupOwned: child[PROCESS_GROUP_OWNED] === true,
        terminating: false,
        termSent: false,
        killSent: false,
        closed: false,
        leaderExited: false,
        timers: new Set(),
        operations: new Set(),
        listener: null,
        resolve: null,
        promise: null,
        deadline: 0,
      };
      record.promise = new Promise((resolve) => { record.resolve = resolve; });
      this.records.set(child, record);
      this.processes.add(child);
      const onClose = () => {
        record.closed = true;
        record.leaderExited = true;
        // For an owned group, close only proves the leader is gone. Keep the
        // record through the grace window so inherited descendants are checked.
        if (!record.terminating || !record.groupOwned) this._releaseRecord(record);
      };
      record.listener = onClose;
      try {
        if (typeof child.once === 'function') child.once('close', onClose);
        else if (typeof child.on === 'function') child.on('close', onClose);
      } catch {}
    }
    if (operation && operation.processes) {
      operation.processes.add(child);
      record.operations.add(operation);
    }
    if (this.disposed) {
      const termination = this.terminate(child);
      this.lateTerminationPromises.add(termination);
      termination.then(() => this.lateTerminationPromises.delete(termination), () => this.lateTerminationPromises.delete(termination));
    }
    return record;
  }

  untrack(child, operation = null) {
    if (!child) return;
    const record = this.records.get(child);
    if (operation && operation.processes) {
      operation.processes.delete(child);
      if (record) record.operations.delete(operation);
    } else if (this.active && this.active.processes) {
      this.active.processes.delete(child);
      if (record) record.operations.delete(this.active);
    }
    // A timeout/cancel calls untrack from the child wrapper before the OS has
    // reaped it. A terminating record must remain owned until group cleanup.
    if (!record || record.terminating) return;
    this._releaseRecord(record);
  }

  _safeGroup(record) {
    return isPosix()
      && record.groupOwned
      && isSafePid(record.pid)
      && record.child
      && record.child.pid === record.pid;
  }

  _safeDirect(record) {
    if (!record || !record.child) return false;
    const pid = record.child.pid;
    // A real ChildProcess always has a stable safe pid. The handle-only branch
    // is for injected ChildProcess-compatible test seams; it never constructs a PID.
    return (pid == null && record.pid == null) || (isSafePid(pid) && pid === record.pid);
  }

  _send(record, signal) {
    if (!record || !record.child) return false;
    try {
      if (this._safeGroup(record)) {
        // Negative PIDs are used only after detached ownership was recorded and
        // the PID has passed the current-process/0 safety checks.
        process.kill(-record.pid, signal);
        return true;
      }
      if (this._safeDirect(record)) {
        record.child.kill(signal);
        return true;
      }
    } catch (error) {
      if (error && error.code === 'ESRCH') return false;
    }
    return false;
  }

  _alive(record) {
    if (!record) return false;
    const child = record.child;
    // A detached leader can emit `close` while an inherited descendant keeps
    // the process group alive. Group existence, not leader state, is the
    // liveness proof during termination.
    try {
      if (this._safeGroup(record)) {
        process.kill(-record.pid, 0);
        return true;
      }
      if (record.closed) return false;
      if (child && child.exitCode !== null && child.exitCode !== undefined) return false;
      if (child && child.signalCode !== null && child.signalCode !== undefined) return false;
      if (isSafePid(child && child.pid) && child.pid === record.pid) {
        process.kill(record.pid, 0);
        return true;
      }
    } catch (error) {
      if (error && error.code === 'EPERM') return true;
      return false;
    }
    // A handle-only test seam has no portable liveness query. It is owned by
    // this coordinator and is therefore treated as live until close or KILL.
    return this._safeDirect(record);
  }

  _addTimer(record, callback, delay) {
    const timer = setTimeout(() => {
      record.timers.delete(timer);
      this.terminationTimers.delete(timer);
      callback();
    }, Math.max(1, delay));
    record.timers.add(timer);
    this.terminationTimers.add(timer);
    return timer;
  }

  _clearTimer(timer, record) {
    if (!timer) return;
    clearTimeout(timer);
    this.terminationTimers.delete(timer);
    if (record) record.timers.delete(timer);
  }

  _pollAfterKill(record) {
    if (!this.records.has(record.child)) return;
    if (!this._alive(record) || Date.now() >= record.deadline) {
      this._releaseRecord(record);
      return;
    }
    this._addTimer(record, () => this._pollAfterKill(record), Math.min(25, this.policy.terminationGraceMs));
  }

  _onGrace(record) {
    if (!this.records.has(record.child)) return;
    if (!this._alive(record)) {
      this._releaseRecord(record);
      return;
    }
    // KILL is sent at most once and only after the bounded TERM grace while
    // the owned target/group is still observable as alive.
    if (!record.killSent) {
      record.killSent = true;
      this._send(record, 'SIGKILL');
    }
    record.deadline = Date.now() + this.policy.terminationGraceMs;
    this._pollAfterKill(record);
  }

  terminate(child) {
    const record = this.records.get(child);
    if (!record) return Promise.resolve();
    if (record.terminating) return record.promise;
    record.terminating = true;
    record.deadline = Date.now() + this.policy.terminationGraceMs;
    if (!record.termSent) {
      record.termSent = true;
      this._send(record, 'SIGTERM');
    }
    if (!this._alive(record)) {
      this._releaseRecord(record);
    } else {
      this._addTimer(record, () => this._onGrace(record), this.policy.terminationGraceMs);
    }
    return record.promise;
  }

  // Kept as the service's central signal seam. Callers cannot request an
  // unsafe one-shot KILL; every owned process follows TERM -> grace -> KILL.
  kill(child) {
    return this.terminate(child);
  }

  killAll() {
    return Promise.all([...this.records.values()].map((record) => this.terminate(record.child)));
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (this.active && this.active.abortController) {
      try { this.active.abortController.abort(); } catch {}
    }
    if (this.active) {
      this.active.released = true;
      this.active = null;
    }
    this.disposePromise = (async () => {
      // Spawns can race the abort callback. Drain late records as well as the
      // initial snapshot so app quit cannot resume while a just-created child
      // is still owned by this coordinator.
      while (this.records.size > 0 || this.lateTerminationPromises.size > 0) {
        const waits = [
          ...[...this.records.values()].map((record) => this.terminate(record.child)),
          ...this.lateTerminationPromises,
        ];
        if (waits.length === 0) break;
        await Promise.all(waits);
      }
      // No live record should remain after the bounded termination promises.
      for (const record of [...this.records.values()]) this._releaseRecord(record);
      for (const timer of [...this.terminationTimers]) clearTimeout(timer);
      this.terminationTimers.clear();
    })();
    return this.disposePromise;
  }

  _releaseRecord(record) {
    if (!record || !this.records.has(record.child)) return;
    for (const timer of [...record.timers]) this._clearTimer(timer, record);
    if (record.listener && record.child) {
      try {
        if (typeof record.child.removeListener === 'function') record.child.removeListener('close', record.listener);
        else if (typeof record.child.off === 'function') record.child.off('close', record.listener);
      } catch {}
    }
    record.listener = null;
    this.records.delete(record.child);
    this.processes.delete(record.child);
    for (const operation of record.operations) {
      if (operation && operation.processes) operation.processes.delete(record.child);
    }
    record.operations.clear();
    try { if (record.resolve) record.resolve(); } catch {}
    record.resolve = null;
  }
}

module.exports = {
  DEFAULT_HEAVY_OPERATION_POLICY,
  normalizePolicy,
  markProcessGroupOwned,
  isSafePid,
  HeavyOperationCoordinator,
};
