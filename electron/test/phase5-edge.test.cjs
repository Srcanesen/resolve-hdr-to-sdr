const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const outputStore = require('../output-store.cjs');
const { ConversionService, fingerprintFile, MAX_OUTPUT_RECORDS } = require('../conversion-service.cjs');
const bundleAudit = require('../../scripts/bundle-audit.cjs');

function makeOutputRecord(file, owner, createdAt = Date.now()) {
  return {
    canonicalPath: fs.realpathSync(file),
    canonicalOutputRoot: fs.realpathSync(path.dirname(file)),
    displayName: path.basename(file),
    ownerWebContentsId: owner,
    verified: true,
    fingerprint: fingerprintFile(file),
    createdAt,
    expiresAt: createdAt + 50,
  };
}

test('BUG-024 partial host initialization cleans up exactly once and preserves unrelated listeners', async () => {
  const electronPath = require.resolve('electron');
  const securePath = require.resolve('../secure-window.cjs');
  const mainPath = require.resolve('../main.cjs');
  const oldElectron = require.cache[electronPath];
  const oldSecure = require.cache[securePath];
  const oldMain = require.cache[mainPath];
  const app = new EventEmitter();
  app._hdrHandlersInstalled = false;
  app.whenReady = () => Promise.resolve();
  app.quit = () => {};
  app.exit = () => {};
  const ipcMain = {
    on() {},
    handle() {},
    removeHandler() {},
    removeAllListeners() {},
  };
  const mockElectron = {
    app,
    ipcMain,
    dialog: { showErrorBox() {} },
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }) }) },
    BrowserWindow: class {},
  };
  const mainWindow = {
    webContents: {
      id: 901,
      mainFrame: { url: `file://${path.resolve(__dirname, '../renderer/index.html')}` },
      on() {},
      once() {},
      send() {},
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      setWindowOpenHandler() {},
    },
    on() {},
    removeAllListeners() {},
    loadFile: async () => {},
  };
  const oldCreate = require.cache[securePath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mockElectron };
  require.cache[securePath] = {
    id: securePath, filename: securePath, loaded: true,
    exports: { createSecureWindow: () => mainWindow, installSecureHandlers() {} },
  };
  delete require.cache[mainPath];
  try {
    const main = require('../main.cjs');
    main._resetForTest();
    let cleanupCount = 0;
    const wi = {
      Initialize: () => true,
      SetAPITimeout: () => false,
      RegisterCallback: () => true,
      CleanUp: () => { cleanupCount++; },
    };
    const res = await main.startApp({ app, workflowIntegration: wi });
    assert.deepEqual(res, { ok: false, reason: 'startup_failed' });
    assert.equal(cleanupCount, 1);

    // A successful start must not remove listeners it does not own.
    main._resetForTest();
    let unrelated = 0;
    app.on('before-quit', () => { unrelated++; });
    const goodWi = {
      Initialize: () => true,
      SetAPITimeout: () => true,
      RegisterCallback: () => true,
      CleanUp: () => { cleanupCount++; },
    };
    assert.equal((await main.startApp({ app, workflowIntegration: goodWi })).ok, true);
    app.emit('before-quit');
    assert.equal(unrelated, 1);
    main._resetForTest();
  } finally {
    if (oldMain) require.cache[mainPath] = oldMain; else delete require.cache[mainPath];
    if (oldSecure) require.cache[securePath] = oldSecure; else delete require.cache[securePath];
    if (oldElectron) require.cache[electronPath] = oldElectron; else delete require.cache[electronPath];
  }
});

test('BUG-028 sanitizes Unicode names without path/control characters and hardens output files', () => {
  const safe = outputStore.sanitizeBasename('旅行_日本 🎬.mov');
  assert.match(safe, /旅行_日本/);
  assert.equal(/[\\/\u0000-\u001f\u007f]/u.test(safe), false);
  assert.ok(safe.length <= 80);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-mode-'));
  try {
    const file = path.join(tmp, `${safe}.mp4`);
    fs.writeFileSync(file, 'output', { mode: 0o644 });
    outputStore.hardenFileMode(file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-034 output records expire and remain bounded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-records-'));
  try {
    const file = path.join(tmp, 'output.mp4');
    fs.writeFileSync(file, 'output');
    const service = new ConversionService({ outputStore, maxOutputRecords: 2, outputRecordTtlMs: 50 });
    const oldId = crypto.randomUUID();
    service.outputs.set(oldId, makeOutputRecord(file, 4, Date.now() - 1000));
    assert.equal(service.resolveOutputForDrag({ outputId: oldId, senderWebContentsId: 4 }).ok, false);
    assert.equal(service.outputs.has(oldId), false);
    for (let i = 0; i < MAX_OUTPUT_RECORDS + 3; i++) {
      const id = crypto.randomUUID();
      service.outputs.set(id, makeOutputRecord(file, 4));
    }
    service.pruneOutputRecords();
    assert.ok(service.outputs.size <= 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-027 bundle audit hashes in chunks and rejects unexpected files and symlink cycles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-bundle-audit-'));
  try {
    for (const relative of bundleAudit.BUNDLE_FILE_ALLOWLIST) {
      const target = path.join(tmp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, relative === 'WorkflowIntegration.node' ? Buffer.from([1, 2, 3]) : 'runtime');
    }
    assert.equal(bundleAudit.auditBundle(tmp).ok, true);
    assert.equal(bundleAudit.sha256File(path.join(tmp, 'package.json')), crypto.createHash('sha256').update('runtime').digest('hex'));

    fs.writeFileSync(path.join(tmp, 'electron', 'unexpected.cjs'), 'no');
    assert.equal(bundleAudit.auditBundle(tmp).ok, false);
    fs.rmSync(path.join(tmp, 'electron', 'unexpected.cjs'));
    fs.symlinkSync('..', path.join(tmp, 'electron', 'cycle'));
    const audited = bundleAudit.auditBundle(tmp);
    assert.equal(audited.ok, false);
    assert.match(audited.reason, /symlink/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-031 tool doctor is deterministic and does not install from PATH', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-doctor-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tools'));
    fs.writeFileSync(path.join(tmp, 'tools', 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'tools', 'ffprobe'), '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(path.join(tmp, 'tools', 'ffmpeg'), 0o755);
    fs.chmodSync(path.join(tmp, 'tools', 'ffprobe'), 0o755);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/tool-doctor.cjs'), '--root', tmp], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: ffmpeg/);
    assert.match(result.stdout, /OK: ffprobe/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-040 Electron dependency is exact, not range-based', () => {
  const pkg = require('../../package.json');
  const lock = require('../../package-lock.json');
  assert.equal(pkg.devDependencies.electron, '41.10.3');
  assert.equal(lock.packages[''].devDependencies.electron, '41.10.3');
  assert.equal(lock.packages['node_modules/electron'].version, '41.10.3');
});
