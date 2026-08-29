const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { DEFAULT_HEAVY_OPERATION_POLICY } = require('./heavy-operation-policy.cjs');

const MAX_REQUEST_BYTES = 8192;
const TIMEOUT_MS = DEFAULT_HEAVY_OPERATION_POLICY.inspectionTimeoutMs;
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 32 * 1024;
const STALL_TIMEOUT_MS = DEFAULT_HEAVY_OPERATION_POLICY.inspectionStallTimeoutMs;

function boundedTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isAbsoluteExecutable(p) {
  if (!p || typeof p !== 'string') return false;
  if (!path.isAbsolute(p)) return false;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // Check executable bit via access
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validatePythonExecutablePath(p) {
  if (!isAbsoluteExecutable(p)) return { ok: false, reason: 'configuration_error' };
  return { ok: true };
}

function getRepoRoot() {
  // electron/ parent is repo root
  return path.resolve(__dirname, '..');
}

function validateBackendRoot(root) {
  if (!root || typeof root !== 'string' || !path.isAbsolute(root)) return { ok: false, reason: 'configuration_error' };
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return { ok: false, reason: 'configuration_error' };
    const cli = path.join(root, 'prototype', 'inspect_cli.py');
    const ffprobe = path.join(root, 'tools', 'ffprobe');
    const cliSt = fs.statSync(cli);
    if (!cliSt.isFile()) return { ok: false, reason: 'configuration_error' };
    const fpSt = fs.statSync(ffprobe);
    if (!fpSt.isFile()) return { ok: false, reason: 'configuration_error' };
    fs.accessSync(ffprobe, fs.constants.X_OK);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'configuration_error' };
  }
}

function resolveBackendRoot() {
  const envRoot = process.env.HDRTOSDR_BACKEND_ROOT;
  if (envRoot) {
    if (!path.isAbsolute(envRoot)) return { ok: false, reason: 'configuration_error' };
    const v = validateBackendRoot(envRoot);
    if (!v.ok) return v;
    return { ok: true, root: path.resolve(envRoot) };
  }
  const devRoot = getRepoRoot();
  const v = validateBackendRoot(devRoot);
  if (!v.ok) return { ok: false, reason: 'configuration_error' };
  return { ok: true, root: devRoot };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_CLASSIFICATIONS = new Set([
  'hlgKnownLocal', 'hlgSupported', 'pqSupported',
  'pqHdr10Unsupported', 'dolbyVisionUnsupported', 'uncertain',
]);
const ALLOWED_PROFILES = new Set(['hlg-local-b-v1', 'hlg-rec709-v1', 'pq-rec709-v1']);
const EXPECTED_PROFILE_BY_CLASSIFICATION = {
  hlgKnownLocal: 'hlg-local-b-v1',
  hlgSupported: 'hlg-rec709-v1',
  pqSupported: 'pq-rec709-v1',
};

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeText(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeReason(value) {
  return isSafeText(value, 200) && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function validateInspectionResult(r, { allowSourceId = false } = {}) {
  if (!isPlainObject(r)) return false;
  const allowedResult = new Set([
    'displayName', 'size', 'sha256', 'color', 'dovi', 'duration',
    'classification', 'reason', 'canConvert', 'profileId',
    ...(allowSourceId ? ['sourceId'] : []),
  ]);
  for (const key of Object.keys(r)) if (!allowedResult.has(key)) return false;

  if (!ALLOWED_CLASSIFICATIONS.has(r.classification)) return false;
  if (!isSafeReason(r.reason)) return false;
  if (typeof r.canConvert !== 'boolean') return false;

  if ('displayName' in r) {
    if (!isSafeText(r.displayName, 255) || /[/\\]/.test(r.displayName)) return false;
  }
  if ('size' in r && (!Number.isSafeInteger(r.size) || r.size < 0)) return false;
  if ('sha256' in r && (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256))) return false;
  if ('duration' in r && !isSafeText(r.duration, 128)) return false;

  if ('color' in r) {
    if (!isPlainObject(r.color)) return false;
    const colorKeys = new Set(['colorSpace', 'colorTransfer', 'colorPrimaries', 'colorRange', 'pixFmt', 'codecTag', 'codecName', 'chromaLocation']);
    for (const key of Object.keys(r.color)) {
      if (!colorKeys.has(key) || !isSafeText(r.color[key], 128)) return false;
    }
    if (Object.keys(r.color).length === 0) return false;
  }

  if ('dovi' in r) {
    if (!isPlainObject(r.dovi) || Object.keys(r.dovi).length === 0) return false;
    const doviKeys = new Set(['hasDovi', 'dvProfile', 'dvLevel', 'dvCompatId', 'rpuPresent', 'elPresent', 'blPresent', 'hasMdcv', 'hasClli', 'hasHdr10Plus']);
    const booleanKeys = new Set(['hasDovi', 'rpuPresent', 'elPresent', 'blPresent', 'hasMdcv', 'hasClli', 'hasHdr10Plus']);
    const integerKeys = new Set(['dvProfile', 'dvLevel', 'dvCompatId']);
    for (const key of Object.keys(r.dovi)) {
      if (!doviKeys.has(key)) return false;
      if (booleanKeys.has(key) && typeof r.dovi[key] !== 'boolean') return false;
      if (integerKeys.has(key) && (!Number.isSafeInteger(r.dovi[key]) || r.dovi[key] < 0)) return false;
    }
    if (r.dovi.hasDovi === false
      && ['dvProfile', 'dvLevel', 'dvCompatId', 'rpuPresent', 'elPresent', 'blPresent'].some((key) => key in r.dovi)) return false;
  }

  if ('profileId' in r) {
    if (typeof r.profileId !== 'string' || !ALLOWED_PROFILES.has(r.profileId)) return false;
  }
  const expectedProfile = EXPECTED_PROFILE_BY_CLASSIFICATION[r.classification];
  if (expectedProfile) {
    if (r.canConvert !== true || r.profileId !== expectedProfile) return false;
  } else if (r.canConvert !== false || 'profileId' in r) {
    return false;
  }

  if ('sourceId' in r) {
    if (!allowSourceId || !expectedProfile || typeof r.sourceId !== 'string' || !UUID_RE.test(r.sourceId)) return false;
  }
  return true;
}

function validateCliResponse(obj) {
  if (!isPlainObject(obj)) return false;
  const topKeys = Object.keys(obj);
  if (obj.outcome === 'error') {
    return topKeys.length === 2
      && topKeys.includes('outcome')
      && topKeys.includes('reason')
      && isSafeReason(obj.reason);
  }
  if (obj.outcome !== 'complete') return false;
  if (topKeys.length !== 2 || !topKeys.includes('outcome') || !topKeys.includes('result')) return false;
  // The CLI always returns these evidence fields, including parse-failure results.
  const result = obj.result;
  if (!isPlainObject(result) || !('displayName' in result) || !('size' in result) || !('sha256' in result)) return false;
  return validateInspectionResult(result);
}

function inspect(userPath, options = {}) {
  const {
    abortSignal,
    timeoutMs = TIMEOUT_MS,
    stallTimeoutMs = STALL_TIMEOUT_MS,
    trackProcess,
    untrackProcess,
    touchActivity,
    killProcess,
  } = options || {};
  const effectiveTimeoutMs = boundedTimeout(timeoutMs, TIMEOUT_MS);
  const effectiveStallTimeoutMs = boundedTimeout(stallTimeoutMs, STALL_TIMEOUT_MS);
  return new Promise((resolve) => {
    // Validate python config first
    const py = process.env.HDRTOSDR_PYTHON;
    const pyCheck = validatePythonExecutablePath(py);
    if (!pyCheck.ok) {
      resolve({ outcome: 'error', reason: 'configuration_error' });
      return;
    }
    const backend = resolveBackendRoot();
    if (!backend.ok) {
      resolve({ outcome: 'error', reason: 'configuration_error' });
      return;
    }
    const cliPath = path.join(backend.root, 'prototype', 'inspect_cli.py');
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let stalled = false;
    let killed = false;
    let settled = false;
    let timeoutTimer = null;
    let stallTimer = null;
    const payload = JSON.stringify({ version: 1, path: userPath });
    if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BYTES) {
      resolve({ outcome: 'error', reason: 'invalid_request' });
      return;
    }
    if (abortSignal && abortSignal.aborted) {
      resolve({ outcome: 'error', reason: 'inspection_failed' });
      return;
    }

    let child;
    try {
      child = spawn(py, [cliPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ outcome: 'error', reason: 'inspection_failed' });
      return;
    }

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(stallTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      try { if (untrackProcess) untrackProcess(child); } catch {}
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const killChild = () => {
      try {
        if (killProcess) killProcess(child);
        else child.kill('SIGKILL');
      } catch {}
    };
    const onAbort = () => {
      if (settled) return;
      killed = true;
      killChild();
      finish({ outcome: 'error', reason: 'inspection_failed' });
    };
    const activity = () => {
      if (settled) return;
      try { if (touchActivity) touchActivity(); } catch {}
      clearTimeout(stallTimer);
      if (effectiveStallTimeoutMs > 0) {
        stallTimer = setTimeout(() => {
          stalled = true;
          killChild();
          finish({ outcome: 'error', reason: 'inspection_failed' });
        }, effectiveStallTimeoutMs);
      }
    };

    try { if (trackProcess) trackProcess(child); } catch {}
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
    if (effectiveTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killChild();
        finish({ outcome: 'error', reason: 'inspection_failed' });
      }, effectiveTimeoutMs);
    }
    activity();

    child.stdout.on('data', (chunk) => {
      activity();
      if (stdout.length + chunk.length > MAX_STDOUT) {
        killed = true;
        killChild();
        finish({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr.on('data', (chunk) => {
      activity();
      if (stderr.length + chunk.length <= MAX_STDERR) stderr = Buffer.concat([stderr, chunk]);
    });

    child.on('error', () => finish({ outcome: 'error', reason: 'inspection_failed' }));
    child.on('close', () => {
      if (settled) return;
      if (timedOut || stalled || killed) {
        finish({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      if (!stdout || stdout.length === 0 || stdout.length > MAX_STDOUT) {
        finish({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      let parsed;
      try { parsed = JSON.parse(stdout.toString('utf8')); } catch {
        finish({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      if (!validateCliResponse(parsed)) {
        finish({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      finish(parsed);
    });

    try {
      child.stdin.write(payload, 'utf8');
      child.stdin.end();
    } catch {
      killed = true;
      killChild();
      finish({ outcome: 'error', reason: 'inspection_failed' });
    }
  });
}

module.exports = {
  isAbsoluteExecutable,
  validatePythonExecutablePath,
  validateBackendRoot,
  getRepoRoot,
  resolveBackendRoot,
  validateCliResponse,
  validateInspectionResult,
  isSafeReason,
  inspect,
  MAX_REQUEST_BYTES,
  TIMEOUT_MS,
  STALL_TIMEOUT_MS,
};
