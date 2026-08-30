'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  WORKFLOW_INTEGRATION_PROVENANCE,
  WORKFLOW_INTEGRATION_SHA256,
  WORKFLOW_INTEGRATION_IDENTIFIER,
  WORKFLOW_INTEGRATION_TEAM_IDENTIFIER,
  PROVENANCE_PROBE_TIMEOUT_MS,
  verifyWorkflowIntegrationNode,
} = require('./workflow-integration-provenance.cjs');

// Keep the shipped surface explicit. Tests, caches, research assets, and the
// prototype web server are not runtime dependencies of the Resolve plugin.
const BUNDLE_FILE_ALLOWLIST = Object.freeze([
  'manifest.xml',
  'main.js',
  'package.json',
  'WorkflowIntegration.node',
  'electron/b-executor.cjs',
  'electron/b-profile.cjs',
  'electron/bootstrap.cjs',
  'electron/conversion-service.cjs',
  'electron/heavy-operation-policy.cjs',
  'electron/inspection-adapter.cjs',
  'electron/ipc-contract.cjs',
  'electron/main.cjs',
  'electron/output-store.cjs',
  'electron/preload.cjs',
  'electron/secure-window.cjs',
  'electron/source-path-policy.cjs',
  'electron/verify_contract.py',
  'electron/renderer/app.js',
  'electron/renderer/index.html',
  'electron/renderer/styles.css',
  'prototype/__init__.py',
  'prototype/__main__.py',
  'prototype/classifier.py',
  'prototype/contracts.py',
  'prototype/inspect_cli.py',
  'prototype/inspector.py',
  'prototype/path_boundary.py',
  'prototype/server.py',
  'scripts/verify-spike.sh',
  'tools/ffmpeg',
  'tools/ffprobe',
]);

const CHUNK_BYTES = 1024 * 1024;
const BUNDLE_TEXT_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.py', '.sh', '.xml', '.html', '.css']);
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const DARWIN_RUNTIME_BINARIES = Object.freeze([
  'WorkflowIntegration.node',
  'tools/ffmpeg',
  'tools/ffprobe',
]);
const DARWIN_REQUIRED_ARCHITECTURES = Object.freeze(['x86_64', 'arm64']);
const DARWIN_PROBE_MAX_BYTES = 1024 * 1024;
const DARWIN_ARCHITECTURE_RE = /\b(?:x86_64|arm64)\b/g;

function textOutput(output) {
  return Buffer.isBuffer(output) ? output.toString('utf8') : String(output ?? '');
}

function unique(values) {
  return [...new Set(values)];
}

function parseMachOFileOutput(output) {
  const text = textOutput(output);
  return {
    isMachO: /\bMach-O\b/.test(text),
    architectures: unique(text.match(DARWIN_ARCHITECTURE_RE) || []),
  };
}

function parseFileArchitectures(output) {
  return parseMachOFileOutput(output).architectures;
}

function parseLipoArchitectures(output) {
  return unique(textOutput(output).match(DARWIN_ARCHITECTURE_RE) || []);
}

function parseOtoolDependencies(output) {
  const dependencies = [];
  for (const line of textOutput(output).split(/\r?\n/)) {
    if (!/^\s/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const marker = trimmed.indexOf(' (compatibility version');
    dependencies.push(marker === -1 ? trimmed : trimmed.slice(0, marker));
  }
  return dependencies;
}

function isAllowedDarwinDylibDependency(dependency) {
  const value = String(dependency);
  const allowedAbsolute = ['/usr/lib', '/System/Library'];
  const allowedRelative = ['@rpath', '@loader_path', '@executable_path'];
  return allowedAbsolute.some((prefix) => value === prefix || value.startsWith(`${prefix}/`))
    || allowedRelative.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function runDarwinProbe(execFileSync, command, args) {
  try {
    return textOutput(execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: DARWIN_PROBE_MAX_BYTES,
      shell: false,
      timeout: PROVENANCE_PROBE_TIMEOUT_MS,
    }));
  } catch {
    throw new Error(`darwin ${command} probe failed`);
  }
}

function architectureFailure(relative, architectures) {
  const found = architectures.length ? architectures.join(',') : 'none';
  return `${relative} must contain x86_64 and arm64 Mach-O slices (found ${found})`;
}

function auditDarwinPortability(bundleRoot, options = {}) {
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (platform !== 'darwin') {
    return { ok: false, reason: 'darwin portability requires a Darwin build host' };
  }
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const failures = [];
  const nodeProvenance = verifyWorkflowIntegrationNode(
    path.join(bundleRoot, 'WorkflowIntegration.node'),
    {
      platform,
      execFileSync: options.execFileSync,
      spawnSync: options.spawnSync,
      hashFile: options.workflowIntegrationHashFile || sha256File,
    },
  );
  if (!nodeProvenance.ok) {
    failures.push(`WorkflowIntegration.node provenance: ${nodeProvenance.reason}`);
  }
  for (const relative of DARWIN_RUNTIME_BINARIES) {
    const binary = path.join(bundleRoot, relative);
    try {
      const stat = fs.lstatSync(binary);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        failures.push(`${relative} is not a regular file`);
        continue;
      }
    } catch {
      failures.push(`${relative} is missing or unreadable`);
      continue;
    }

    let fileInfo;
    try {
      fileInfo = parseMachOFileOutput(runDarwinProbe(execFileSync, 'file', ['-b', binary]));
    } catch {
      failures.push(`${relative} file probe failed`);
      continue;
    }
    if (!fileInfo.isMachO) failures.push(`${relative} is not a Mach-O binary`);

    let lipoArchitectures;
    try {
      lipoArchitectures = parseLipoArchitectures(runDarwinProbe(execFileSync, 'lipo', ['-archs', binary]));
    } catch {
      failures.push(`${relative} lipo probe failed`);
      lipoArchitectures = [];
    }
    const missingFromLipo = DARWIN_REQUIRED_ARCHITECTURES.filter((arch) => !lipoArchitectures.includes(arch));
    if (missingFromLipo.length) failures.push(architectureFailure(relative, lipoArchitectures));
    const missingFromFile = fileInfo.architectures.length
      ? DARWIN_REQUIRED_ARCHITECTURES.filter((arch) => !fileInfo.architectures.includes(arch))
      : [];
    if (missingFromFile.length && !failures.some((failure) => failure.startsWith(`${relative} must contain`))) {
      failures.push(architectureFailure(relative, fileInfo.architectures));
    }

    try {
      const dependencies = parseOtoolDependencies(runDarwinProbe(execFileSync, 'otool', ['-L', binary]));
      if (dependencies.some((dependency) => !isAllowedDarwinDylibDependency(dependency))) {
        failures.push(`${relative} has a non-system absolute dylib dependency`);
      }
    } catch {
      failures.push(`${relative} otool probe failed`);
    }
  }
  return failures.length
    ? { ok: false, reason: `darwin portability: ${failures.join('; ')}` }
    : { ok: true };
}

function scanTextFile(filePath, forbiddenStrings) {
  const fd = fs.openSync(filePath, 'r');
  let carry = '';
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const text = carry + buffer.subarray(0, count).toString('utf8');
      if (PRIVATE_KEY_RE.test(text)) return false;
      if (forbiddenStrings.some((value) => value && text.includes(value))) return false;
      carry = text.slice(-256);
    }
    return true;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
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

function lstatOrFailure(candidate) {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    const failure = new Error(`missing or unreadable bundle entry: ${candidate}`);
    failure.code = error && error.code;
    throw failure;
  }
}

function walkBundleFiles(root) {
  const found = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    const absolute = path.join(root, relative);
    const stat = lstatOrFailure(absolute);
    if (stat.isSymbolicLink()) throw new Error(`bundle symlink is not allowed: ${relative || '.'}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) {
        stack.push(relative ? path.join(relative, entry) : entry);
      }
    } else if (stat.isFile()) {
      found.push(relative.split(path.sep).join('/'));
    } else {
      throw new Error(`unsupported bundle entry: ${relative}`);
    }
  }
  return found;
}

function auditBundle(bundleRoot, allowlist = BUNDLE_FILE_ALLOWLIST, options = {}) {
  try {
    if (!Array.isArray(allowlist) && allowlist && typeof allowlist === 'object') {
      options = allowlist;
      allowlist = BUNDLE_FILE_ALLOWLIST;
    }
    if (typeof bundleRoot !== 'string' || !path.isAbsolute(bundleRoot)) {
      return { ok: false, reason: 'bundle_root_must_be_absolute' };
    }
    const rootStat = lstatOrFailure(bundleRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, reason: 'bundle_root_not_directory' };
    }
    const expected = new Set(allowlist);
    const found = walkBundleFiles(bundleRoot);
    const unexpected = found.filter((entry) => !expected.has(entry));
    if (unexpected.length) return { ok: false, reason: `unexpected bundle entries: ${unexpected.join(',')}` };
    const missing = [...expected].filter((entry) => !found.includes(entry));
    if (missing.length) return { ok: false, reason: `missing bundle entries: ${missing.join(',')}` };
    const forbiddenStrings = [process.env.HOME, '/opt/homebrew', '/Users/', '/home/'];
    for (const relative of expected) {
      const absolute = path.join(bundleRoot, relative);
      const stat = lstatOrFailure(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { ok: false, reason: `bundle entry is not a regular file: ${relative}` };
      }
      if (BUNDLE_TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())
        && !scanTextFile(absolute, forbiddenStrings)) {
        return { ok: false, reason: `bundle text contains a developer path or private key: ${relative}` };
      }
    }
    const portability = auditDarwinPortability(bundleRoot, options);
    if (!portability.ok) return portability;
    return { ok: true, files: found.sort() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'bundle_audit_failed' };
  }
}

if (require.main === module) {
  const bundleRoot = process.argv[2];
  if (!bundleRoot) {
    console.error('Usage: node scripts/bundle-audit.cjs <absolute-bundle-root>');
    process.exitCode = 2;
  } else {
    const result = auditBundle(path.resolve(bundleRoot));
    if (!result.ok) {
      console.error(`BUNDLE AUDIT FAILED: ${result.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`BUNDLE AUDIT OK: ${result.files.length} allowlisted regular files`);
    }
  }
}

module.exports = {
  BUNDLE_FILE_ALLOWLIST,
  CHUNK_BYTES,
  DARWIN_RUNTIME_BINARIES,
  DARWIN_REQUIRED_ARCHITECTURES,
  WORKFLOW_INTEGRATION_PROVENANCE,
  WORKFLOW_INTEGRATION_SHA256,
  WORKFLOW_INTEGRATION_IDENTIFIER,
  WORKFLOW_INTEGRATION_TEAM_IDENTIFIER,
  sha256File,
  walkBundleFiles,
  parseMachOFileOutput,
  parseFileArchitectures,
  parseLipoArchitectures,
  parseOtoolDependencies,
  isAllowedDarwinDylibDependency,
  auditDarwinPortability,
  auditBundle,
};
