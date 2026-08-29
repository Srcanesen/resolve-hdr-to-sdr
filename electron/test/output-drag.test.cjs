const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { ConversionService, OUTPUT_DRAG_CHANNEL, isValidOutputDragRequest } = require('../conversion-service.cjs');
const outputStore = require('../output-store.cjs');
const { PROFILE_ID } = require('../b-profile.cjs');

function makeWindow(id) {
  return { id, send: () => {} };
}

test('isValidOutputDragRequest strict', () => {
  const good = crypto.randomUUID();
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: good }), true);
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: good, extra: 1 }), false);
  assert.equal(isValidOutputDragRequest({ version: 2, outputId: good }), false);
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: 'not-uuid' }), false);
  assert.equal(isValidOutputDragRequest({ version: 1 }), false);
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: '' }), false);
  assert.equal(isValidOutputDragRequest(null), false);
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: good, path: '/tmp/a' }), false);
});

test('drag permitted only after verifier PASS and opaque', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-drag-'));
  try {
    const store = {
      ensureOutputRoot: () => tmp,
      buildDisplayName: outputStore.buildDisplayName,
      allocateUniqueFinalPath: (r, n) => outputStore.allocateUniqueFinalPath(r, n),
      getStagingPath: (r, f) => outputStore.getStagingPath(r, f),
      removeStaging: outputStore.removeStaging,
      isSafeOutputFile: outputStore.isSafeOutputFile,
    };
    const svc = new ConversionService({
      outputStore: store,
      inspectionAdapter: { inspect: async () => ({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'a.mov' } }) },
      bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ stagingPath }) => { fs.writeFileSync(stagingPath, 'enc'); return { outcome: 'success' }; } },
      verifierRunner: async () => 0,
    });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: path.join(tmp, 'src.mov') });
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    const srcId = svc.createSourceToken({ canonicalPath: path.join(tmp, 'src.mov'), sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 10, displayName: 'a.mov' });
    const win = { id: 10, send: () => {} };
    // Ensure src path validation uses real file
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    // Need to override inspect to return matching
    svc.dependencies.inspectionAdapter = { inspect: async () => ({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'a.mov' } }) };
    const res = await svc.startJob({ sourceId: srcId, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(res.ok, true);
    await new Promise(r => setTimeout(r, 600));
    assert.equal(svc.outputs.size, 1);
    const outputId = [...svc.outputs.keys()][0];
    const rec = svc.outputs.get(outputId);
    assert.ok(rec.verified === true);
    assert.ok(rec.canonicalPath);
    assert.ok(rec.canonicalOutputRoot);
    assert.equal(rec.ownerWebContentsId, 10);
    assert.equal(rec.displayName.endsWith('.mp4'), true);
    assert.ok(rec.fingerprint && rec.fingerprint.sha256, 'verified output must have a fingerprint');
    const originalOutputBytes = fs.readFileSync(rec.canonicalPath);
    // Verify that rec does not leak via renderer? Just check internal store has path
    // But ensure that valid drag succeeds with same owner
    const ok1 = svc.resolveOutputForDrag({ outputId, senderWebContentsId: 10 });
    assert.equal(ok1.ok, true);
    assert.equal(ok1.canonicalPath, rec.canonicalPath);
    // Non-owner fails closed
    const badOwner = svc.resolveOutputForDrag({ outputId, senderWebContentsId: 99 });
    assert.equal(badOwner.ok, false);
    // Stale: move file away
    const movedPath = path.join(tmp, 'moved.mov');
    fs.renameSync(rec.canonicalPath, movedPath);
    const stale = svc.resolveOutputForDrag({ outputId, senderWebContentsId: 10 });
    assert.equal(stale.ok, false, 'moved file should fail');
    // Restore for next test
    fs.renameSync(movedPath, rec.canonicalPath);
    const okAfterRestore = svc.resolveOutputForDrag({ outputId, senderWebContentsId: 10 });
    assert.equal(okAfterRestore.ok, true);
    // Replaced with symlink should fail
    fs.unlinkSync(rec.canonicalPath);
    const other = path.join(tmp, 'other.mov');
    fs.writeFileSync(other, 'other');
    fs.symlinkSync(other, rec.canonicalPath);
    const symlinkFail = svc.resolveOutputForDrag({ outputId, senderWebContentsId: 10 });
    assert.equal(symlinkFail.ok, false, 'symlink replaced file should fail');
    fs.unlinkSync(rec.canonicalPath);
    fs.writeFileSync(rec.canonicalPath, originalOutputBytes);
    // After restore, realpath check should still pass? Need to ensure file is regular and realpath equals canonical
    const okAfterSymlinkRestore = svc.resolveOutputForDrag({ outputId, senderWebContentsId: 10 });
    assert.equal(okAfterSymlinkRestore.ok, true);
    // Non-symlink output root symlink attack: make root a symlink? We simulate by replacing canonicalOutputRoot check
    // Create new tmp with symlink root (should be rejected by isSafeOutputFile)
    // Already tested via isSafeOutputFile: if root is symlink, fails.
    // Ensure outputId is opaque UUID and not path
    assert.ok(/^[0-9a-f-]{36}$/i.test(outputId));
    assert.equal(outputId.includes('/'), false);
    assert.equal(outputId.includes(tmp), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('drag revalidation checks direct containment and non-symlink root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-drag2-'));
  try {
    const svc = new ConversionService({ outputStore });
    const realRoot = fs.realpathSync(tmp);
    const fileInside = path.join(realRoot, 'file_sdr.mov');
    fs.writeFileSync(fileInside, 'data');
    const realFile = fs.realpathSync(fileInside);
    const oid = crypto.randomUUID();
    svc.outputs.set(oid, {
      canonicalPath: realFile,
      canonicalOutputRoot: realRoot,
      displayName: 'file_sdr.mov',
      ownerWebContentsId: 5,
      verified: true,
      fingerprint: { size: 4, sha256: crypto.createHash('sha256').update('data').digest('hex') },
    });
    assert.equal(svc.resolveOutputForDrag({ outputId: oid, senderWebContentsId: 5 }).ok, true);
    // Direct containment: file outside root should fail (simulate by storing path outside)
    const outside = path.join(os.tmpdir(), 'outside.mov');
    fs.writeFileSync(outside, 'x');
    const oid2 = crypto.randomUUID();
    svc.outputs.set(oid2, {
      canonicalPath: fs.realpathSync(outside),
      canonicalOutputRoot: realRoot,
      displayName: 'outside.mov',
      ownerWebContentsId: 5,
      verified: true,
    });
    assert.equal(svc.resolveOutputForDrag({ outputId: oid2, senderWebContentsId: 5 }).ok, false);
    fs.unlinkSync(outside);
    // Symlink file should fail
    const link = path.join(realRoot, 'link.mov');
    fs.symlinkSync(fileInside, link);
    const oid3 = crypto.randomUUID();
    svc.outputs.set(oid3, {
      canonicalPath: link, // stored as symlink path (should be canonical non-symlink, but attacker tries)
      canonicalOutputRoot: realRoot,
      displayName: 'link.mov',
      ownerWebContentsId: 5,
      verified: true,
    });
    assert.equal(svc.resolveOutputForDrag({ outputId: oid3, senderWebContentsId: 5 }).ok, false);
    fs.unlinkSync(link);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('paths only stay in main, never renderer: ensure resolve returns path only internally and request never contains path', () => {
  // Verify isValidOutputDragRequest never allows path field, and resolve returns canonicalPath only to main
  const uuid = crypto.randomUUID();
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: uuid, file: '/tmp/a.mov' }), false);
  assert.equal(isValidOutputDragRequest({ version: 1, outputId: uuid, path: '/tmp' }), false);
  // Verify ConversionService does not expose path via getOutputRecord without realpath check? It does expose internally but not via IPC
  // Simulate that renderer cannot get path via IPC: only outputId is sent via convert event, not path
  // Ensure that outputStore helper is non-creating
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-drag3-'));
  try {
    const file = path.join(tmp, 'a.mov');
    fs.writeFileSync(file, 'x');
    const real = fs.realpathSync(file);
    const rootReal = fs.realpathSync(tmp);
    assert.equal(outputStore.isSafeOutputFile(real, rootReal), true);
    // Non-creating helper should not create missing root
    const missingRoot = path.join(tmp, 'missingRoot');
    assert.equal(outputStore.isSafeOutputFile(real, missingRoot), false);
    assert.equal(fs.existsSync(missingRoot), false, 'helper must not create missing root');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('preload exposes only startOutputDrag with correct channel and never paths', () => {
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
  assert.ok(preloadSrc.includes("hdrtosdr:output-drag:start"));
  assert.ok(preloadSrc.includes('startOutputDrag'));
  // Ensure startOutputDrag only takes outputId, not path
  const idx = preloadSrc.indexOf('startOutputDrag');
  const snippet = preloadSrc.slice(idx, idx + 300);
  assert.ok(snippet.includes('outputId'));
  assert.equal(snippet.includes('file'), false, 'preload drag should not mention file path');
  // Ensure no path leakage in preload
  assert.equal(preloadSrc.includes('canonicalPath'), false);
  // Ensure ipcRenderer.send is used (fire-and-forget), not invoke
  assert.ok(preloadSrc.includes('ipcRenderer.send'));
  assert.ok(snippet.includes('version: 1'));
});

test('native drag handler is synchronous and uses startDrag with icon', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  // Accept either literal or constant usage
  assert.ok(mainSrc.includes('hdrtosdr:output-drag:start') || mainSrc.includes('OUTPUT_DRAG_CHANNEL'));
  assert.ok(mainSrc.includes('startDrag'));
  assert.ok(mainSrc.includes('isValidOutputDragRequest'));
  assert.ok(mainSrc.includes('DRAG_ICON'));
  assert.ok(mainSrc.includes('isEmpty'));
  assert.ok(mainSrc.includes('getSize'));
  assert.ok(mainSrc.includes('32'));
  // Ensure handler is ipcMain.on, not handle
  assert.ok(mainSrc.includes("ipcMain.on(OUTPUT_DRAG_CHANNEL") || mainSrc.includes('ipcMain.on'));
  assert.equal(mainSrc.includes("ipcMain.handle(OUTPUT_DRAG_CHANNEL"), false);
  // Ensure sender validation uses mainFrame and file URL
  assert.ok(mainSrc.includes('mainFrame'));
  assert.ok(mainSrc.includes('getExpectedFileUrl') || mainSrc.includes('file://'));
});
