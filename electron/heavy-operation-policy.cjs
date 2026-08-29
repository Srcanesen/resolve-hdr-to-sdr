// Shared lifecycle policy for inspection, conversion, and verification.
// Values are intentionally conservative for real media while remaining injectable in tests.
const DEFAULT_HEAVY_OPERATION_POLICY = Object.freeze({
  inspectionTimeoutMs: 20_000,
  inspectionStallTimeoutMs: 10_000,
  conversionTimeoutMs: 30 * 60 * 1_000,
  conversionStallTimeoutMs: 60_000,
  verifierTimeoutMs: 20_000,
  verifierStallTimeoutMs: 10_000,
});

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
  return Object.freeze(policy);
}

class HeavyOperationCoordinator {
  constructor(policy = {}) {
    this.policy = normalizePolicy(policy);
    this.active = null;
    this.processes = new Set();
    this.killedProcesses = new WeakSet();
    this.disposed = false;
  }

  reserve(kind, ownerWebContentsId) {
    if (this.disposed || this.active) return null;
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
    this.processes.add(child);
    if (operation && operation.processes) operation.processes.add(child);
  }

  untrack(child, operation = null) {
    if (!child) return;
    this.processes.delete(child);
    if (operation && operation.processes) operation.processes.delete(child);
    else if (this.active && this.active.processes) this.active.processes.delete(child);
  }

  kill(child, signal = 'SIGKILL') {
    if (!child || typeof child.kill !== 'function' || this.killedProcesses.has(child)) return;
    this.killedProcesses.add(child);
    try { child.kill(signal); } catch {}
  }

  killAll(signal = 'SIGKILL') {
    for (const child of this.processes) this.kill(child, signal);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active && this.active.abortController) {
      try { this.active.abortController.abort(); } catch {}
    }
    this.killAll();
  }
}

module.exports = {
  DEFAULT_HEAVY_OPERATION_POLICY,
  normalizePolicy,
  HeavyOperationCoordinator,
};
