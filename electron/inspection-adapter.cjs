const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const MAX_REQUEST_BYTES = 8192;
const TIMEOUT_MS = 20000;
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 32 * 1024;

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

function validateCliResponse(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.outcome !== 'complete' && obj.outcome !== 'error') return false;
  if (obj.outcome === 'error') {
    return typeof obj.reason === 'string' && obj.reason.length > 0 && obj.reason.length < 200;
  }
  // complete
  const r = obj.result;
  if (!r || typeof r !== 'object') return false;
  // allowed keys check: privacy-shaped fields only
  const allowedTop = new Set(['displayName', 'size', 'sha256', 'color', 'dovi', 'duration', 'classification', 'reason', 'canConvert', 'profileId']);
  for (const k of Object.keys(r)) {
    if (!allowedTop.has(k)) return false;
  }
  if (typeof r.classification !== 'string') return false;
  if (typeof r.reason !== 'string') return false;
  if (typeof r.canConvert !== 'boolean') return false;
  // classification must be in enum (now includes pqSupported)
  const allowedCls = new Set(['hlgKnownLocal', 'hlgSupported', 'pqSupported', 'pqHdr10Unsupported', 'dolbyVisionUnsupported', 'uncertain']);
  if (!allowedCls.has(r.classification)) return false;
  // profileId if present must be known
  if ('profileId' in r && r.profileId != null) {
    if (typeof r.profileId !== 'string') return false;
    const allowedProfiles = new Set(['hlg-local-b-v1', 'hlg-rec709-v1', 'pq-rec709-v1']);
    if (!allowedProfiles.has(r.profileId)) return false;
  }
  return true;
}

function inspect(userPath) {
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
    // Extra validation that cli exists (already)
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let killed = false;
    const payload = JSON.stringify({ version: 1, path: userPath });
    if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BYTES) {
      resolve({ outcome: 'error', reason: 'invalid_request' });
      return;
    }

    let child;
    try {
      child = spawn(py, [cliPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ outcome: 'error', reason: 'inspection_failed' });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_STDOUT) {
        // cap: kill and generic error
        if (!killed) {
          killed = true;
          try { child.kill('SIGKILL'); } catch {}
        }
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length > MAX_STDERR) {
        // cap but don't expose
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ outcome: 'error', reason: 'inspection_failed' });
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      if (killed) {
        resolve({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      // Expect stdout to be JSON
      if (!stdout || stdout.length === 0) {
        resolve({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      if (stdout.length > MAX_STDOUT) {
        resolve({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.toString('utf8'));
      } catch {
        resolve({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      if (!validateCliResponse(parsed)) {
        resolve({ outcome: 'error', reason: 'inspection_failed' });
        return;
      }
      // Map to renderer-safe shape: ensure no path leakage (already validated)
      resolve(parsed);
    });

    // Feed stdin
    try {
      child.stdin.write(payload, 'utf8');
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ outcome: 'error', reason: 'inspection_failed' });
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
  inspect,
  MAX_REQUEST_BYTES,
  TIMEOUT_MS,
};
