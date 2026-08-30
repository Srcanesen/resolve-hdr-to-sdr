const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { isValidRequest, isValidResponse } = require('../ipc-contract.cjs');
const adapter = require('../inspection-adapter.cjs');

test('isValidRequest accepts dialog', () => {
  assert.equal(isValidRequest({ kind: 'dialog' }), true);
});

test('isValidRequest accepts path', () => {
  assert.equal(isValidRequest({ kind: 'path', path: '/tmp/a.mov' }), true);
});

test('isValidRequest rejects arbitrary fields', () => {
  assert.equal(isValidRequest({ kind: 'dialog', extra: 1 }), false);
  assert.equal(isValidRequest({ kind: 'path', path: '/a.mov', foo: 'bar' }), false);
});

test('isValidRequest rejects missing kind', () => {
  assert.equal(isValidRequest({ path: '/a.mov' }), false);
});

test('isValidRequest rejects unknown kind', () => {
  assert.equal(isValidRequest({ kind: 'unknown' }), false);
});

test('isValidRequest rejects non-string path', () => {
  assert.equal(isValidRequest({ kind: 'path', path: 123 }), false);
  assert.equal(isValidRequest({ kind: 'path', path: '' }), false);
});

test('isValidResponse accepts complete', () => {
  const resp = { outcome: 'complete', result: { classification: 'hlgKnownLocal', reason: 'allowlist_hlg_match', canConvert: true, profileId: 'hlg-local-b-v1', duration: 1 } };
  assert.equal(isValidResponse(resp), true);
});

test('BUG-021 IPC duration is a finite positive JSON number and is required for conversion', () => {
  const base = { classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'hlg-rec709-v1' };
  assert.equal(isValidResponse({ outcome: 'complete', result: { ...base, duration: 1.25 } }), true);
  for (const duration of [undefined, '1.25', 0, -1, NaN, Infinity, -Infinity, null]) {
    const result = { ...base };
    if (duration !== undefined) result.duration = duration;
    assert.equal(isValidResponse({ outcome: 'complete', result }), false, `duration=${String(duration)}`);
  }
  assert.equal(isValidResponse({ outcome: 'complete', result: {
    classification: 'uncertain', reason: 'unknown', canConvert: false, duration: 1,
  } }), true);
  assert.equal(isValidResponse({ outcome: 'complete', result: {
    classification: 'uncertain', reason: 'unknown', canConvert: false, duration: '1',
  } }), false);
});

test('isValidResponse accepts error', () => {
  assert.equal(isValidResponse({ outcome: 'error', reason: 'invalid_request' }), true);
});

test('isValidResponse accepts cancelled', () => {
  assert.equal(isValidResponse({ outcome: 'cancelled', reason: 'no_selection' }), true);
  assert.equal(isValidResponse({ outcome: 'cancelled', reason: '/tmp/secret.mov' }), false);
  assert.equal(isValidResponse({ outcome: 'error', reason: '/tmp/secret.mov' }), false);
});

test('isValidResponse rejects invalid classification', () => {
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'bogus', reason: 'x', canConvert: false } }), false);
});

test('isValidResponse rejects missing canConvert', () => {
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x' } }), false);
});

test('isValidResponse rejects unexpected top-level keys', () => {
  assert.equal(isValidResponse({ outcome: 'error', reason: 'invalid_request', extra: 1 }), false);
  assert.equal(isValidResponse({ outcome: 'cancelled', reason: 'no_selection', extra: 'x' }), false);
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false }, extra: 1 }), false);
  assert.equal(isValidResponse({ outcome: 'error', reason: 'x', result: { classification: 'uncertain', reason: 'x', canConvert: false } }), false);
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false }, reason: 'oops' }), false);
});

test('isValidResponse rejects privacy-unsafe result keys', () => {
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false, rawPath: '/secret' } }), false);
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false, path: '/secret' } }), false);
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false, extra: 123 } }), false);
  // allowed privacy-safe keys should pass
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false, displayName: 'a.mov', size: 1, sha256: 'a'.repeat(64) } }), true);
});

test('isValidResponse handles busy outcome shape', () => {
  assert.equal(isValidResponse({ outcome: 'error', reason: 'busy' }), true);
  assert.equal(isValidResponse({ outcome: 'busy', reason: 'busy' }), true);
  assert.equal(isValidResponse({ outcome: 'busy', reason: 'busy', extra: 1 }), false);
  assert.equal(isValidResponse({ outcome: 'error', reason: 'busy', extra: 1 }), false);
});

test('validatePythonExecutablePath requires absolute executable', () => {
  assert.equal(adapter.validatePythonExecutablePath('python3').ok, false);
  assert.equal(adapter.validatePythonExecutablePath('/nonexistent/py').ok, false);
  const py = process.execPath;
  assert.equal(adapter.validatePythonExecutablePath(py).ok, true);
});

test('validateBackendRoot checks existence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-backend-existence-'));
  try {
    const protodir = path.join(tmp, 'prototype');
    const toolsdir = path.join(tmp, 'tools');
    fs.mkdirSync(protodir, { recursive: true });
    fs.mkdirSync(toolsdir, { recursive: true });
    fs.writeFileSync(path.join(protodir, 'inspect_cli.py'), '# cli');
    const ff = path.join(toolsdir, 'ffprobe');
    fs.writeFileSync(ff, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
    fs.chmodSync(ff, 0o755);
    assert.equal(adapter.validateBackendRoot(tmp).ok, true);
    assert.equal(adapter.validateBackendRoot('/tmp').ok, false);
    assert.equal(adapter.validateBackendRoot('relative/path').ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateBackendRoot requires executable ffprobe', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-backend-'));
  try {
    const protodir = path.join(tmp, 'prototype');
    const toolsdir = path.join(tmp, 'tools');
    fs.mkdirSync(protodir, { recursive: true });
    fs.mkdirSync(toolsdir, { recursive: true });
    fs.writeFileSync(path.join(protodir, 'inspect_cli.py'), '# cli');
    const ff = path.join(toolsdir, 'ffprobe');
    fs.writeFileSync(ff, '# ffprobe');
    fs.chmodSync(ff, 0o644);
    assert.equal(adapter.validateBackendRoot(tmp).ok, false, 'non-executable ffprobe should fail');
    fs.chmodSync(ff, 0o755);
    assert.equal(adapter.validateBackendRoot(tmp).ok, true, 'executable ffprobe should pass');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateCliResponse privacy shape', () => {
  const good = { outcome: 'complete', result: { displayName: '1.MOV', size: 123, sha256: 'a'.repeat(64), classification: 'uncertain', reason: 'unknown', canConvert: false } };
  assert.equal(adapter.validateCliResponse(good), true);
  const withRawPath = { outcome: 'complete', result: { displayName: '1.MOV', size: 1, sha256: 'a'.repeat(64), classification: 'uncertain', reason: 'x', canConvert: false, rawPath: '/secret' } };
  assert.equal(adapter.validateCliResponse(withRawPath), false);
  const badCls = { outcome: 'complete', result: { classification: 'bad', reason: 'x', canConvert: false } };
  assert.equal(adapter.validateCliResponse(badCls), false);
  assert.equal(adapter.validateCliResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false } }), false);
});

test('inspection response schema rejects malformed nested fields and non-canonical tokens', () => {
  const good = { outcome: 'complete', result: {
    displayName: 'clip.mov', size: 1, sha256: 'a'.repeat(64),
    classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true,
    profileId: 'hlg-rec709-v1', sourceId: '550e8400-e29b-41d4-a716-446655440000', duration: 1,
    color: { colorTransfer: 'arib-std-b67' },
    dovi: { hasDovi: false, hasMdcv: false, hasClli: false },
  } };
  assert.equal(isValidResponse(good), true);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, size: '1' } }), false);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, sha256: 'not-a-hash' } }), false);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, canConvert: 'true' } }), false);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, color: [] } }), false);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, dovi: { hasDovi: 'false' } } }), false);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, sourceId: '/tmp/source.mov' } }), false);
  assert.equal(isValidResponse({ ...good, result: { ...good.result, profileId: 'hlg-local-b-v1' } }), false);
  assert.equal(isValidResponse({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false, sourceId: good.result.sourceId } }), false);
});

test('shared source policy canonicalizes safe files and rejects all non-system symlinks', () => {
  const { canonicalizeSafeSourcePath } = require('../source-path-policy.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-policy-'));
  try {
    const realDir = path.join(root, 'real');
    const linkDir = path.join(root, 'link');
    fs.mkdirSync(realDir);
    const source = path.join(realDir, 'source.mov');
    fs.writeFileSync(source, 'video');
    fs.symlinkSync(realDir, linkDir, 'dir');
    assert.deepEqual(canonicalizeSafeSourcePath(source).canonical, fs.realpathSync(source));
    assert.equal(canonicalizeSafeSourcePath(path.join(linkDir, 'source.mov')).ok, false);
    const finalLink = path.join(root, 'final.mov');
    fs.symlinkSync(source, finalLink);
    assert.equal(canonicalizeSafeSourcePath(finalLink).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspection adapter enforces an injected finite timeout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-timeout-'));
  const python = path.join(tmp, 'slow-python');
  const protodir = path.join(tmp, 'prototype');
  const toolsdir = path.join(tmp, 'tools');
  fs.mkdirSync(protodir);
  fs.mkdirSync(toolsdir);
  fs.writeFileSync(path.join(protodir, 'inspect_cli.py'), '# cli');
  fs.writeFileSync(path.join(toolsdir, 'ffprobe'), '#!/bin/sh\nsleep 2\n');
  fs.writeFileSync(python, '#!/bin/sh\nsleep 2\n');
  fs.chmodSync(path.join(toolsdir, 'ffprobe'), 0o755);
  fs.chmodSync(python, 0o755);
  const previousPython = process.env.HDRTOSDR_PYTHON;
  const previousBackend = process.env.HDRTOSDR_BACKEND_ROOT;
  process.env.HDRTOSDR_PYTHON = python;
  process.env.HDRTOSDR_BACKEND_ROOT = tmp;
  const started = Date.now();
  try {
    const result = await adapter.inspect('/tmp/source.mov', { timeoutMs: 40, stallTimeoutMs: 1000 });
    assert.deepEqual(result, { outcome: 'error', reason: 'inspection_failed' });
    assert.ok(Date.now() - started < 1000, 'inspection must settle within its timeout');
  } finally {
    if (previousPython === undefined) delete process.env.HDRTOSDR_PYTHON;
    else process.env.HDRTOSDR_PYTHON = previousPython;
    if (previousBackend === undefined) delete process.env.HDRTOSDR_BACKEND_ROOT;
    else process.env.HDRTOSDR_BACKEND_ROOT = previousBackend;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getRepoRoot resolves to existing directory containing prototype', () => {
  const r = adapter.getRepoRoot();
  assert.equal(path.isAbsolute(r), true);
  assert.equal(fs.existsSync(path.join(r, 'prototype', 'inspect_cli.py')), true);
});

// Pure helper tests for secure-window without launching Electron
test('secure-window pure helpers deny correctly', () => {
  const sec = require('../secure-window.cjs');
  // denyPermissionRequest
  let called = null;
  sec.denyPermissionRequest(null, 'media', (v) => { called = v; });
  assert.equal(called, false);
  // denyPermissionCheck
  assert.equal(sec.denyPermissionCheck(), false);
  // will-attach-webview
  let prevented = false;
  sec.handleWillAttachWebview({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  // will-navigate
  prevented = false;
  sec.handleWillNavigate({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  // will-redirect
  prevented = false;
  sec.handleWillRedirect({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  // windowOpen
  assert.deepEqual(sec.handleWindowOpen(), { action: 'deny' });
});

test('secure-window installSecureHandlers uses window session not defaultSession', () => {
  const sec = require('../secure-window.cjs');
  let reqHandler = null;
  let checkHandler = null;
  const fakeSession = {
    setPermissionRequestHandler(fn) { reqHandler = fn; },
    setPermissionCheckHandler(fn) { checkHandler = fn; },
  };
  const events = {};
  const fakeWin = {
    webContents: {
      session: fakeSession,
      on(evt, fn) { events[evt] = fn; },
      setWindowOpenHandler(fn) { events['windowOpen'] = fn; },
    },
  };
  sec.installSecureHandlers(fakeWin);
  assert.equal(typeof reqHandler, 'function');
  assert.equal(typeof checkHandler, 'function');
  assert.equal(typeof events['will-navigate'], 'function');
  assert.equal(typeof events['will-redirect'], 'function');
  assert.equal(typeof events['will-attach-webview'], 'function');
  assert.equal(typeof events['windowOpen'], 'function');
  // verify handlers deny
  let v = null;
  reqHandler(null, 'test', (val) => { v = val; });
  assert.equal(v, false);
  assert.equal(checkHandler(), false);
  let pd = false;
  events['will-attach-webview']({ preventDefault() { pd = true; } });
  assert.equal(pd, true);
});

test('attachIpc single-flight guard with deferred adapter', async () => {
  const electronPath = require.resolve('electron');
  const originalCache = require.cache[electronPath];
  const mockIpcMain = {
    removeHandler() {},
    handle(channel, fn) { this._handler = fn; this._channel = channel; },
  };
  const mockDialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  // inject mock electron
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { ipcMain: mockIpcMain, dialog: mockDialog },
  };
  // clear ipc-contract cache
  delete require.cache[require.resolve('../ipc-contract.cjs')];
  const fresh = require('../ipc-contract.cjs');
  try {
    const fakeWindow = { webContents: {} };
    let release;
    const deferred = new Promise((resolve) => { release = resolve; });
    const deferredAdapter = {
      inspect: () => deferred,
    };
    fresh.attachIpc(fakeWindow, deferredAdapter);
    const handler = mockIpcMain._handler;
    assert.ok(handler, 'handler should be registered');
    const event = { sender: fakeWindow.webContents };
    // first request starts and hangs on adapter
    const p1 = handler(event, { kind: 'path', path: '/Sample/1.MOV' });
    // second simultaneous request should get busy immediately
    const p2 = handler(event, { kind: 'path', path: '/Sample/1.MOV' });
    const r2 = await p2;
    assert.deepEqual(r2, { outcome: 'error', reason: 'busy' });
    assert.equal(fresh.isValidResponse(r2), true);
    // release first
    release({ outcome: 'complete', result: { classification: 'uncertain', reason: 'x', canConvert: false } });
    const r1 = await p1;
    assert.equal(r1.outcome, 'complete');
    // after release, guard should be free
    const r3 = await handler(event, { kind: 'path', path: '/Sample/1.MOV' });
    // this will invoke adapter again (which still returns same resolved deferred -> complete)
    assert.equal(r3.outcome, 'complete');
  } finally {
    // restore electron cache
    if (originalCache) require.cache[electronPath] = originalCache;
    else delete require.cache[electronPath];
    delete require.cache[require.resolve('../ipc-contract.cjs')];
    // re-load original for subsequent tests
    require('../ipc-contract.cjs');
  }
});
