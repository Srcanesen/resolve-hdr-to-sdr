'use strict';

const crypto = require('crypto');
const fs = require('fs');
const childProcess = require('child_process');

const WORKFLOW_INTEGRATION_PROVENANCE = Object.freeze(
  require('./workflow-integration-provenance.json'),
);
const WORKFLOW_INTEGRATION_SHA256 = WORKFLOW_INTEGRATION_PROVENANCE.sha256;
const WORKFLOW_INTEGRATION_IDENTIFIER = WORKFLOW_INTEGRATION_PROVENANCE.identifier;
const WORKFLOW_INTEGRATION_TEAM_IDENTIFIER = WORKFLOW_INTEGRATION_PROVENANCE.teamIdentifier;
const PROVENANCE_PROBE_TIMEOUT_MS = 10_000;
const PROVENANCE_PROBE_MAX_BYTES = 256 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

function textOutput(output) {
  return Buffer.isBuffer(output) ? output.toString('utf8') : String(output ?? '');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function probeOptions() {
  return {
    encoding: 'utf8',
    shell: false,
    timeout: PROVENANCE_PROBE_TIMEOUT_MS,
    maxBuffer: PROVENANCE_PROBE_MAX_BYTES,
  };
}

function normalizeSpawnResult(result) {
  return {
    status: result && Number.isInteger(result.status) ? result.status : null,
    signal: result && result.signal ? result.signal : null,
    stdout: textOutput(result && result.stdout),
    stderr: textOutput(result && result.stderr),
    error: result && result.error ? String(result.error.message || result.error) : null,
  };
}

function runProbe(command, args, options = {}) {
  const spawnOptions = probeOptions();
  let result;
  try {
    if (typeof options.spawnSync === 'function') {
      result = options.spawnSync(command, args, spawnOptions);
    } else if (typeof options.execFileSync === 'function') {
      try {
        result = {
          status: 0,
          stdout: options.execFileSync(command, args, spawnOptions),
          stderr: '',
        };
      } catch (error) {
        result = {
          status: Number.isInteger(error.status) ? error.status : null,
          signal: error.signal || null,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          error,
        };
      }
    } else {
      result = childProcess.spawnSync(command, args, spawnOptions);
    }
  } catch (error) {
    result = { status: null, signal: null, stdout: '', stderr: '', error };
  }
  const normalized = normalizeSpawnResult(result);
  normalized.ok = normalized.error === null && normalized.status === 0;
  return normalized;
}

function parseCodesignIdentity(output) {
  const fields = {};
  for (const line of textOutput(output).split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].trim();
  }
  return {
    identifier: fields.Identifier || null,
    teamIdentifier: fields.TeamIdentifier || null,
  };
}

function failure(reason) {
  return { ok: false, reason };
}

function verifyWorkflowIntegrationNode(filePath, options = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return failure('WorkflowIntegration.node is missing or unreadable');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return failure('WorkflowIntegration.node is not a regular file');
  }

  let digest;
  try {
    digest = (options.hashFile || sha256File)(filePath);
  } catch {
    return failure('WorkflowIntegration.node hash could not be computed');
  }
  if (digest !== WORKFLOW_INTEGRATION_SHA256) {
    return failure('WorkflowIntegration.node SHA-256 does not match the pinned SDK');
  }

  const platform = options.platform === undefined ? process.platform : options.platform;
  if (platform !== 'darwin') return { ok: true, sha256: digest };

  const verify = runProbe('codesign', ['--verify', '--deep', '--strict', filePath], options);
  if (!verify.ok) return failure('WorkflowIntegration.node codesign verify failed');

  const detail = runProbe('codesign', ['-dv', '--verbose=4', filePath], options);
  if (!detail.ok) return failure('WorkflowIntegration.node codesign identity probe failed');
  const identity = parseCodesignIdentity(`${detail.stdout}\n${detail.stderr}`);
  if (identity.identifier !== WORKFLOW_INTEGRATION_IDENTIFIER) {
    return failure('WorkflowIntegration.node codesign identifier does not match the pinned SDK');
  }
  if (identity.teamIdentifier !== WORKFLOW_INTEGRATION_TEAM_IDENTIFIER) {
    return failure('WorkflowIntegration.node codesign TeamIdentifier does not match the pinned SDK');
  }
  return { ok: true, sha256: digest, identity };
}

module.exports = {
  WORKFLOW_INTEGRATION_PROVENANCE,
  WORKFLOW_INTEGRATION_SHA256,
  WORKFLOW_INTEGRATION_IDENTIFIER,
  WORKFLOW_INTEGRATION_TEAM_IDENTIFIER,
  PROVENANCE_PROBE_TIMEOUT_MS,
  PROVENANCE_PROBE_MAX_BYTES,
  HASH_CHUNK_BYTES,
  sha256File,
  parseCodesignIdentity,
  runProbe,
  verifyWorkflowIntegrationNode,
};
