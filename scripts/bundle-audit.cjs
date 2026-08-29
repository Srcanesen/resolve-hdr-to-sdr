'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function auditBundle(bundleRoot, allowlist = BUNDLE_FILE_ALLOWLIST) {
  try {
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

module.exports = { BUNDLE_FILE_ALLOWLIST, CHUNK_BYTES, sha256File, walkBundleFiles, auditBundle };
