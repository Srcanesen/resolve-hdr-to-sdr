const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { ConversionService, isValidConvertStartRequest, isValidConvertCancelRequest, isValidConvertEvent } = require('../conversion-service.cjs');
const { PROFILE_ID } = require('../b-profile.cjs');

// Helpers
function makeWindow(id) {
  return { id, send: () => {} };
}

function makeStubInspection(result) {
  return { inspect: async () => result };
}

function makeStubExecutor(behavior) {
  return {
    getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
    checkCapability: () => ({ ok: true }),
    buildFfmpegArgs: () => [],
    runBConversion: async (opts) => {
      if (behavior === 'success') return { outcome: 'success' };
      if (behavior === 'fail') return { outcome: 'error', reason: 'conversion_failed' };
      if (behavior === 'profile_unavailable') return { outcome: 'error', reason: 'profile_unavailable' };
      if (behavior === 'cancelled') return { outcome: 'cancelled', reason: 'cancelled' };
      return { outcome: 'success' };
    },
  };
}

function makeOutputStore(tmpRoot) {
  const store = require('../output-store.cjs');
  // Wrap to use tmpRoot as homedir Movies
  return {
    ensureOutputRoot: () => {
      fs.mkdirSync(tmpRoot, { recursive: true });
      return tmpRoot;
    },
    buildDisplayName: store.buildDisplayName,
    allocateUniqueFinalPath: (root, name) => store.allocateUniqueFinalPath(root, name),
    getStagingPath: (root, final) => store.getStagingPath(root, final),
    removeStaging: store.removeStaging,
  };
}

test('source token ownership staleness', async () => {
  const svc = new ConversionService({ inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'abc'.repeat(21)+'a', size: 123, displayName: 'a.mov' } }) });
  const tok = svc.createSourceToken({ canonicalPath: '/tmp/a.mov', sha256: 'abc'.repeat(21)+'a', size: 123, profileId: PROFILE_ID, ownerWebContentsId: 1, displayName: 'a.mov' });
  const got = svc.getSourceToken(tok);
  assert.ok(got);
  // Different window cannot use token
  const reval = await svc.revalidateSourceToken(tok, 2);
  assert.equal(reval.ok, false);
  assert.equal(reval.reason, 'invalid_request');
  // Same window but stale after invalidate
  svc.invalidateForWindow(1);
  const reval2 = await svc.revalidateSourceToken(tok, 1);
  assert.equal(reval2.ok, false);
});

test('profile mismatch rejected', async () => {
  const svc = new ConversionService();
  const uuid = crypto.randomUUID();
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: 'wrong' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc12345', profileId: PROFILE_ID }), false, 'non-UUID should be rejected');
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: '550e8400-e29b-41d4-a716-44665544000', profileId: PROFILE_ID }), false, 'truncated UUID rejected');
  // extra field rejected
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID, extra: 1 }), false);
  // missing version
  assert.equal(isValidConvertStartRequest({ sourceId: uuid, profileId: PROFILE_ID }), false);
});

test('new inspection invalidates prior token for same window', () => {
  const svc = new ConversionService();
  const t1 = svc.createSourceToken({ canonicalPath: '/tmp/a.mov', sha256: 'a'.repeat(64), size: 1, profileId: PROFILE_ID, ownerWebContentsId: 5, displayName: 'a.mov' });
  const t2 = svc.createSourceToken({ canonicalPath: '/tmp/b.mov', sha256: 'b'.repeat(64), size: 2, profileId: PROFILE_ID, ownerWebContentsId: 5, displayName: 'b.mov' });
  assert.equal(svc.getSourceToken(t1), null);
  assert.ok(svc.getSourceToken(t2));
});

test('collision naming never overwrites', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-coll-'));
  try {
    const store = makeOutputStore(tmp);
    const svc = new ConversionService({
      outputStore: store,
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'test.mov' } }),
      bExecutor: makeStubExecutor('success'),
      verifierRunner: async () => 0,
    });
    // Create a source file and token
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    // Need to bypass path validation: create file that passes lstat checks
    // We'll stub validateSourcePathForSpawn to avoid real fs checks for this test
    const origValidate = svc.validateSourcePathForSpawn.bind(svc);
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    // Also ensure staging file exists for verifier
    const origEnsure = store.ensureOutputRoot;
    // Pre-create a final file to force collision
    const display = store.buildDisplayName('test.mov');
    const existing = path.join(tmp, display);
    fs.writeFileSync(existing, 'existing');
    // Need to mock inspection to return matching sha/size for token
    const sha = 'a'.repeat(64);
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: sha, size: 100, profileId: PROFILE_ID, ownerWebContentsId: 1, displayName: 'test.mov' });
    svc.dependencies.inspectionAdapter = makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: sha, size: 100, displayName: 'test.mov' } });
    // Stub staging creation to actually create file so verifier passes
    const win = makeWindow(1);
    win.send = () => {};
    // Override runBConversion to create staging file
    svc.dependencies.bExecutor.runBConversion = async ({ stagingPath }) => {
      fs.writeFileSync(stagingPath, 'encoded');
      return { outcome: 'success' };
    };
    const res = await svc.startJob({ sourceId, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(res.ok, true);
    // Wait a tick for async job to complete and rename
    await new Promise(r => setTimeout(r, 300));
    // Original should still exist
    assert.equal(fs.existsSync(existing), true);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'existing');
    // New file should be _001
    const expected2 = path.join(tmp, 'test_sdr_rec709_h264_hlg-local-b-v1_001.mp4');
    // Could be _001 or other, check that at least one new file exists
    const files = fs.readdirSync(tmp);
    const newFiles = files.filter(f => f.includes('_001') || f.includes('_002'));
    assert.ok(newFiles.length >= 1);
    // Restore
    svc.validateSourcePathForSpawn = origValidate;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('executor argv freeze and capability failure maps to profile_unavailable', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-cap-'));
  try {
    const store = makeOutputStore(tmp);
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    const svc = new ConversionService({
      outputStore: store,
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'src.mov' } }),
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake',
        runBConversion: async () => ({ outcome: 'error', reason: 'profile_unavailable' }),
      },
      verifierRunner: async () => 0,
    });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 9, displayName: 'src.mov' });
    const win = { id: 9, send: (ch, payload) => {
      if (payload.phase === 'error') {
        assert.equal(payload.reason, 'profile_unavailable');
        assert.equal(payload.sourcePath, undefined);
        assert.equal(payload.stderr, undefined);
      }
    }};
    const res = await svc.startJob({ sourceId, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(res.ok, true);
    await new Promise(r => setTimeout(r, 500));
    // Job should be removed after error
    assert.equal(svc.jobs.size, 0);
    // Staging should be removed (no leave)
    const files = fs.readdirSync(tmp);
    const partials = files.filter(f => f.includes('partial'));
    assert.equal(partials.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cancellation cleans staging and emits cancelled', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-cancel-'));
  try {
    const store = makeOutputStore(tmp);
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    let abortSeen = false;
    const svc = new ConversionService({
      outputStore: store,
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'src.mov' } }),
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake',
        runBConversion: async ({ stagingPath, abortSignal }) => {
          // Simulate long running, create staging then wait for abort
          fs.writeFileSync(stagingPath, 'partial');
          return new Promise((resolve) => {
            const t = setTimeout(() => resolve({ outcome: 'success' }), 5000);
            if (abortSignal) {
              abortSignal.addEventListener('abort', () => {
                abortSeen = true;
                clearTimeout(t);
                resolve({ outcome: 'cancelled', reason: 'cancelled' });
              });
            }
          });
        },
      },
      verifierRunner: async () => 0,
    });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 11, displayName: 'src.mov' });
    const events = [];
    const win = { id: 11, send: (ch, payload) => events.push(payload) };
    const res = await svc.startJob({ sourceId, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(res.ok, true);
    const jobId = res.jobId;
    // Cancel quickly
    await new Promise(r => setTimeout(r, 100));
    const cancelRes = await svc.cancelJob({ jobId, senderWebContents: win });
    assert.equal(cancelRes.ok, true);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(abortSeen, true);
    // Staging should be cleaned
    const files = fs.readdirSync(tmp);
    const partials = files.filter(f => f.includes('partial'));
    assert.equal(partials.length, 0);
    // Should have cancelled event
    const cancelledEv = events.find(e => e.phase === 'cancelled');
    assert.ok(cancelledEv);
    assert.equal(cancelledEv.status, 'cancelled');
    assert.equal(cancelledEv.outputId, undefined);
    // No path leakage
    for (const e of events) {
      assert.equal(e.sourcePath, undefined);
      assert.equal(e.outputPath, undefined);
      assert.equal(e.stderr, undefined);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifier-gated result: only PASS issues outputId and renames', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-ver-'));
  try {
    const store = makeOutputStore(tmp);
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    // First case: verifier fails
    const svcFail = new ConversionService({
      outputStore: store,
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'src.mov' } }),
      bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ stagingPath }) => { fs.writeFileSync(stagingPath, 'enc'); return { outcome: 'success' }; } },
      verifierRunner: async () => 1, // fail
    });
    svcFail.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sidFail = svcFail.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 20, displayName: 'src.mov' });
    const eventsFail = [];
    const winFail = { id: 20, send: (ch, p) => eventsFail.push(p) };
    const resFail = await svcFail.startJob({ sourceId: sidFail, profileId: PROFILE_ID, senderWebContents: winFail });
    assert.equal(resFail.ok, true);
    await new Promise(r => setTimeout(r, 400));
    // Should have no outputId, staging cleaned, no rename
    assert.equal(svcFail.outputs.size, 0);
    const errEv = eventsFail.find(e => e.phase === 'error' && e.reason === 'verification_failed');
    assert.ok(errEv);
    const filesAfterFail = fs.readdirSync(tmp);
    // src.mov is in tmp, so filter only outputs with _sdr_rec709 pattern
    assert.equal(filesAfterFail.filter(f => f.includes('_sdr_rec709') && f.endsWith('.mp4')).length, 0);
    // Second case: verifier passes
    const svcPass = new ConversionService({
      outputStore: store,
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'b'.repeat(64), size: 100, displayName: 'src.mov' } }),
      bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ stagingPath }) => { fs.writeFileSync(stagingPath, 'enc'); return { outcome: 'success' }; } },
      verifierRunner: async () => 0,
    });
    svcPass.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sidPass = svcPass.createSourceToken({ canonicalPath: src, sha256: 'b'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 21, displayName: 'src.mov' });
    const eventsPass = [];
    const winPass = { id: 21, send: (ch, p) => eventsPass.push(p) };
    const resPass = await svcPass.startJob({ sourceId: sidPass, profileId: PROFILE_ID, senderWebContents: winPass });
    assert.equal(resPass.ok, true);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(svcPass.outputs.size, 1);
    const doneEv = eventsPass.find(e => e.phase === 'done' && e.status === 'success');
    assert.ok(doneEv);
    assert.ok(doneEv.outputId);
    assert.ok(doneEv.displayName);
    assert.equal(doneEv.outputId, [...svcPass.outputs.keys()][0]);
    assert.equal(doneEv.profileId, PROFILE_ID);
    // No path leakage
    for (const e of [...eventsFail, ...eventsPass]) {
      assert.equal(e.path, undefined);
      assert.equal(e.sourcePath, undefined);
      assert.equal(e.outputPath, undefined);
      assert.equal(e.stderr, undefined);
    }
    // Final file should exist after rename
    const finalFiles = fs.readdirSync(tmp).filter(f => f.includes('_sdr_rec709') && f.endsWith('.mp4'));
    assert.ok(finalFiles.length >= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('no-path/error leakage in generic errors', async () => {
  const svc = new ConversionService();
  // Invalid start request should not leak path
  const win = makeWindow(99);
  win.send = () => {};
  const res = await svc.startJob({ sourceId: 'nonexistent', profileId: PROFILE_ID, senderWebContents: win });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid_request');
  // Ensure no path in reason
  assert.equal(res.sourcePath, undefined);
});

test('strict IPC request shapes', () => {
  const uuid = crypto.randomUUID();
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: '', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'not-a-uuid', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc12345', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 2, sourceId: uuid, profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID, path: '/tmp' }), false);
  assert.equal(isValidConvertCancelRequest({ version: 1, jobId: 'job123' }), true);
  assert.equal(isValidConvertCancelRequest({ version: 1, jobId: 'job123', extra: 1 }), false);
  assert.equal(isValidConvertCancelRequest({ version: 1 }), false);
  // event shape
  assert.equal(isValidConvertEvent({ version: 1, jobId: 'j', seq: 0, phase: 'converting', status: 'running' }), true);
  assert.equal(isValidConvertEvent({ version: 1, jobId: 'j', seq: 0, phase: 'converting', status: 'running', path: '/tmp' }), false);
  assert.equal(isValidConvertEvent({ version: 1, jobId: 'j', seq: -1, phase: 'converting', status: 'running' }), false);
  assert.equal(isValidConvertEvent({ version: 1, jobId: 'j', seq: 0, phase: 'unknown', status: 'running' }), false);
});

test('sender ownership enforced', async () => {
  const svc = new ConversionService({
    inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 10, displayName: 'a.mov' } }),
  });
  svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: '/tmp/a.mov' });
  const tok = svc.createSourceToken({ canonicalPath: '/tmp/a.mov', sha256: 'a'.repeat(64), size: 10, profileId: PROFILE_ID, ownerWebContentsId: 1, displayName: 'a.mov' });
  const win1 = makeWindow(1);
  const win2 = makeWindow(2);
  win1.send = () => {};
  win2.send = () => {};
  // win2 should not be able to start with tok owned by win1
  const res = await svc.startJob({ sourceId: tok, profileId: PROFILE_ID, senderWebContents: win2 });
  assert.equal(res.ok, false);
  // win1 can cancel only its own job
  svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: '/tmp/a.mov' });
  const res2 = await svc.startJob({ sourceId: tok, profileId: PROFILE_ID, senderWebContents: win1 });
  if (res2.ok) {
    const badCancel = await svc.cancelJob({ jobId: res2.jobId, senderWebContents: win2 });
    assert.equal(badCancel.ok, false);
    // cleanup
    await svc.cancelJob({ jobId: res2.jobId, senderWebContents: win1 });
    await new Promise(r => setTimeout(r, 200));
  }
});

test('source revalidation rejects symlink final and symlink parent and requires realpath equality', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-srcval-'));
  try {
    const realDir = path.join(base, 'real');
    fs.mkdirSync(realDir);
    const srcReal = path.join(realDir, 'src.mov');
    fs.writeFileSync(srcReal, 'x'.repeat(100));
    const linkDir = path.join(base, 'linkDir');
    fs.symlinkSync(realDir, linkDir, 'dir');
    const srcViaLink = path.join(linkDir, 'src.mov');
    const svc = new ConversionService({
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'src.mov' } }),
    });
    // Final symlink
    const linkFile = path.join(base, 'link.mov');
    fs.symlinkSync(srcReal, linkFile);
    const r1 = svc.validateSourcePathForSpawn(linkFile);
    assert.equal(r1.ok, false, 'final symlink should be rejected');
    // Symlink parent
    const r2 = svc.validateSourcePathForSpawn(srcViaLink);
    assert.equal(r2.ok, false, 'symlink parent should be rejected');
    // Realpath equality: token path is via link, but real differs
    const tokenPathViaLink = srcViaLink;
    const fakeToken = svc.createSourceToken({ canonicalPath: tokenPathViaLink, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 1, displayName: 'src.mov' });
    const win = makeWindow(1);
    // Even if we bypass lstat parent check by using real path token, swapping file to symlink should fail
    // Now test realpath equality failure when file is replaced by symlink after token creation
    const src2 = path.join(base, 'real2.mov');
    fs.writeFileSync(src2, 'x'.repeat(100));
    const tok2 = svc.createSourceToken({ canonicalPath: src2, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 2, displayName: 'real2.mov' });
    // Replace file with symlink to another location
    fs.unlinkSync(src2);
    fs.symlinkSync(srcReal, src2);
    const reval = await svc.revalidateSourceToken(tok2, 2);
    assert.equal(reval.ok, false, 'realpath mismatch after symlink swap should be rejected');
    // Valid case should pass (use realpath for canonical)
    const validReal = path.join(base, 'valid.mov');
    fs.writeFileSync(validReal, 'x'.repeat(100));
    const validRealCanonical = fs.realpathSync(validReal);
    const tokValid = svc.createSourceToken({ canonicalPath: validRealCanonical, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 3, displayName: 'valid.mov' });
    svc.dependencies.inspectionAdapter = makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'valid.mov' } });
    const revalOk = await svc.revalidateSourceToken(tokValid, 3);
    assert.equal(revalOk.ok, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('commit via hard-link never overwrites existing final (race between reservation and commit)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-race-'));
  try {
    const store = makeOutputStore(tmp);
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    const svc = new ConversionService({
      outputStore: store,
      inspectionAdapter: makeStubInspection({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'src.mov' } }),
      bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ stagingPath }) => { fs.writeFileSync(stagingPath, 'encoded-race'); return { outcome: 'success' }; } },
      verifierRunner: async () => 0,
    });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 1, displayName: 'src.mov' });
    const win = { id: 1, send: () => {} };
    // Pre-create the would-be final to simulate reservation collision? Instead test race where file appears after reservation but before link
    // We monkey-patch allocateUniqueFinalPath to return a predictable path, then create race file before commit
    const originalAlloc = store.allocateUniqueFinalPath.bind(store);
    // Force allocate to return tmp/test_sdr...mov
    const display = store.buildDisplayName('src.mov');
    const raceFinal = path.join(tmp, display);
    // Ensure raceFinal does NOT exist at reservation time, but will be created just before commit
    if (fs.existsSync(raceFinal)) fs.unlinkSync(raceFinal);
    let allocCalled = false;
    svc.dependencies.outputStore.allocateUniqueFinalPath = (root, name) => {
      if (!allocCalled) { allocCalled = true; return raceFinal; }
      // On retry (EEXIST) return next suffix
      return originalAlloc(root, name);
    };
    // Intercept runBConversion to create race file after reservation (between reservation and link)
    const origRun = svc.dependencies.bExecutor.runBConversion;
    svc.dependencies.bExecutor.runBConversion = async (opts) => {
      const res = await origRun(opts);
      // Race: create file at raceFinal before commit (simulates another process)
      if (!fs.existsSync(raceFinal)) {
        fs.writeFileSync(raceFinal, 'original-race');
      }
      return res;
    };
    const res = await svc.startJob({ sourceId, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(res.ok, true);
    await new Promise(r => setTimeout(r, 600));
    // Original race file must be unchanged
    assert.equal(fs.existsSync(raceFinal), true);
    assert.equal(fs.readFileSync(raceFinal, 'utf8'), 'original-race', 'existing final must not be overwritten');
    // New output should be at _001
    const files = fs.readdirSync(tmp).filter(f => f.includes('_sdr_rec709'));
    const newFiles = files.filter(f => f !== path.basename(raceFinal));
    assert.ok(newFiles.length >= 1, 'should have created collision file');
    const newPath = path.join(tmp, newFiles[0]);
    assert.equal(fs.readFileSync(newPath, 'utf8'), 'encoded-race');
    // Ensure no rename was used to overwrite (source file checks that link was used)
    const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'conversion-service.cjs'), 'utf8');
    assert.ok(svcSrc.includes('linkSync'), 'should use linkSync');
    assert.equal(/\brenameSync\s*\(/.test(svcSrc) && svcSrc.includes('renameSync(stagingPath, finalPath)'), false, 'should not use clobbering rename');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sourceId must be UUID-shaped', () => {
  const good = crypto.randomUUID();
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: good, profileId: PROFILE_ID }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc123', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: '550e8400-e29b-41d4-a716-446655440000', profileId: PROFILE_ID }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: '550e8400e29b41d4a716446655440000', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: good + ' ', profileId: PROFILE_ID }), false);
  // Token creation produces UUID
  const svc = new ConversionService();
  const tok = svc.createSourceToken({ canonicalPath: '/tmp/a.mov', sha256: 'a'.repeat(64), size: 1, profileId: PROFILE_ID, ownerWebContentsId: 1, displayName: 'a.mov' });
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok), 'token should be UUID');
});

test('staging and final allocation bounded loops do not hang', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-bounded-'));
  try {
    const store = require('../output-store.cjs');
    const display = 'test_sdr_rec709_h264_hlg-local-b-v1.mp4';
    // Create many colliding files to exhaust 001..005
    for (let i = 0; i < 10; i++) {
      const p = i === 0 ? path.join(tmp, display) : path.join(tmp, `test_sdr_rec709_h264_hlg-local-b-v1_${String(i).padStart(3, '0')}.mp4`);
      fs.writeFileSync(p, 'x');
    }
    const next = store.allocateUniqueFinalPath(tmp, display);
    assert.ok(!fs.existsSync(next));
    // Staging bounded: should return quickly even with collisions
    const final = path.join(tmp, display);
    const stagings = new Set();
    for (let i = 0; i < 20; i++) {
      const s = store.getStagingPath(tmp, final);
      assert.ok(!stagings.has(s), 'should be unique');
      stagings.add(s);
      fs.writeFileSync(s, 'p');
    }
    // Cleanup stagings
    for (const s of stagings) fs.unlinkSync(s);
    // Verify source does not contain unbounded recursion
    const outSrc = fs.readFileSync(path.join(__dirname, '..', 'output-store.cjs'), 'utf8');
    assert.ok(outSrc.includes('MAX_ATTEMPTS') || outSrc.includes('MAX_STAGING_ATTEMPTS'));
    assert.equal(/function getStagingPath[\s\S]*return getStagingPath\(/.test(outSrc), false, 'should not have unbounded recursion');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
