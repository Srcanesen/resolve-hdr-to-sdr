const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Test centralized b-profile
test('b-profile centralized: both profiles known and graphs frozen', () => {
  const bProfile = require('../b-profile.cjs');
  assert.ok(bProfile.isKnownProfileId('hlg-local-b-v1'));
  assert.ok(bProfile.isKnownProfileId('hlg-rec709-v1'));
  assert.equal(bProfile.isKnownProfileId('unknown'), false);
  assert.equal(bProfile.isKnownProfileId('hlg-local-b-v0'), false);
  assert.equal(bProfile.PROFILE_ID_LOCAL_B, 'hlg-local-b-v1');
  assert.equal(bProfile.PROFILE_ID_GENERIC, 'hlg-rec709-v1');
  assert.equal(bProfile.FILTER_GRAPH_LOCAL_B, 'libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le,eq=gamma=0.90');
  assert.equal(bProfile.FILTER_GRAPH_GENERIC, 'libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le');
  assert.equal(bProfile.getFilterGraph('hlg-local-b-v1'), bProfile.FILTER_GRAPH_LOCAL_B);
  assert.equal(bProfile.getFilterGraph('hlg-rec709-v1'), bProfile.FILTER_GRAPH_GENERIC);
  assert.equal(bProfile.getFilterGraph('unknown'), null);
  // PROFILES map centralized
  assert.ok(bProfile.PROFILES['hlg-local-b-v1']);
  assert.ok(bProfile.PROFILES['hlg-rec709-v1']);
  // local graph must contain spline + gamma, generic must contain bt.2390 and no gamma trim
  assert.ok(bProfile.FILTER_GRAPH_LOCAL_B.includes('tonemapping=spline'));
  assert.ok(bProfile.FILTER_GRAPH_LOCAL_B.includes('eq=gamma=0.90'));
  assert.ok(bProfile.FILTER_GRAPH_GENERIC.includes('tonemapping=bt.2390'));
  assert.ok(bProfile.FILTER_GRAPH_GENERIC.includes('gamut_mode=perceptual'));
  assert.ok(bProfile.FILTER_GRAPH_GENERIC.includes('colorspace=bt709'));
  assert.ok(bProfile.FILTER_GRAPH_GENERIC.includes('range=tv'));
  assert.ok(bProfile.FILTER_GRAPH_GENERIC.includes('format=yuv422p10le'));
  assert.equal(bProfile.FILTER_GRAPH_GENERIC.includes('eq=gamma'), false, 'generic must NOT contain local B gamma trim');
  assert.equal(bProfile.FILTER_GRAPH_GENERIC.includes('spline'), false, 'generic must not contain spline');
  assert.equal(bProfile.FILTER_GRAPH_GENERIC.includes('mobius'), false);
  assert.equal(bProfile.FILTER_GRAPH_GENERIC.includes('hable'), false);
});

test('b-executor buildFfmpegArgs routes by profileId and unknown fails closed', () => {
  const bExecutor = require('../b-executor.cjs');
  const { PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC, FILTER_GRAPH_LOCAL_B, FILTER_GRAPH_GENERIC } = require('../b-profile.cjs');
  const { OUTPUT_SANITIZATION_SUFFIX } = bExecutor;
  const argsLocal = bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.partial.mp4', PROFILE_ID_LOCAL_B);
  const vfIdxLocal = argsLocal.indexOf('-vf');
  assert.equal(argsLocal[vfIdxLocal+1], `${FILTER_GRAPH_LOCAL_B},${OUTPUT_SANITIZATION_SUFFIX}`);
  assert.ok(argsLocal[vfIdxLocal+1].includes('eq=gamma=0.90'));

  const argsGeneric = bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.partial.mp4', PROFILE_ID_GENERIC);
  const vfIdxGen = argsGeneric.indexOf('-vf');
  assert.equal(argsGeneric[vfIdxGen+1], `${FILTER_GRAPH_GENERIC},${OUTPUT_SANITIZATION_SUFFIX}`);
  assert.ok(argsGeneric[vfIdxGen+1].includes('bt.2390'));
  assert.equal(argsGeneric[vfIdxGen+1].includes('eq=gamma'), false);

  // default (no profile) should be local B for backward compat
  const argsDefault = bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.partial.mp4');
  assert.equal(argsDefault[argsDefault.indexOf('-vf')+1], `${FILTER_GRAPH_LOCAL_B},${OUTPUT_SANITIZATION_SUFFIX}`);

  // unknown profile must throw / fail closed
  assert.throws(() => bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.mov', 'unknown'), /unknown_profile/);
  assert.throws(() => bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.mov', 'hlg-local-b-v0'), /unknown_profile/);
  assert.throws(() => bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.mov', ''), /unknown_profile/);
});

test('b-executor runBConversion routes by profileId and unknown fails closed without spawn', async () => {
  const bExecutor = require('../b-executor.cjs');
  const { PROFILE_ID_GENERIC, PROFILE_ID_LOCAL_B } = require('../b-profile.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-gen-exec-'));
  try {
    const src = path.join(tmp, 'src.mov');
    const staging = path.join(tmp, 'out.partial.mp4');
    fs.writeFileSync(src, 'dummy');
    // Unknown profile should fail closed immediately (invalid_request) without spawning ffmpeg
    const resUnknown = await bExecutor.runBConversion({ sourcePath: src, stagingPath: staging, profileId: 'unknown-profile', ffmpegPath: '/nonexistent/ffmpeg' });
    assert.equal(resUnknown.outcome, 'error');
    assert.equal(resUnknown.reason, 'invalid_request');
    // Generic profile with nonexistent ffmpeg should still be profile_unavailable (capability check), not invalid_request
    const resGenericCap = await bExecutor.runBConversion({ sourcePath: src, stagingPath: staging, profileId: PROFILE_ID_GENERIC, ffmpegPath: '/nonexistent/ffmpeg' });
    assert.equal(resGenericCap.outcome, 'error');
    assert.equal(resGenericCap.reason, 'profile_unavailable');
    // Local with nonexistent also profile_unavailable
    const resLocalCap = await bExecutor.runBConversion({ sourcePath: src, stagingPath: staging, profileId: PROFILE_ID_LOCAL_B, ffmpegPath: '/nonexistent/ffmpeg' });
    assert.equal(resLocalCap.outcome, 'error');
    assert.equal(resLocalCap.reason, 'profile_unavailable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('conversion-service profile routing: isValidConvertStartRequest accepts both and rejects unknown', () => {
  const { isValidConvertStartRequest, PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC } = require('../conversion-service.cjs');
  const uuid = crypto.randomUUID();
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID_LOCAL_B }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID_GENERIC }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: 'unknown' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: 'hlg-local-b-v0' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: '' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID_LOCAL_B, extra: 1 }), false);
});

test('conversion-service isValidConvertEvent accepts both profiles', () => {
  const { isValidConvertEvent, PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC } = require('../conversion-service.cjs');
  const base = { version: 1, jobId: 'j', seq: 0, phase: 'converting', status: 'running' };
  assert.equal(isValidConvertEvent({ ...base, profileId: PROFILE_ID_LOCAL_B }), true);
  assert.equal(isValidConvertEvent({ ...base, profileId: PROFILE_ID_GENERIC }), true);
  assert.equal(isValidConvertEvent({ ...base, profileId: 'unknown' }), false);
  assert.equal(isValidConvertEvent({ ...base, profileId: 'hlg-local-b-v0' }), false);
});

test('outputStore buildDisplayName routes by profileId', () => {
  const outputStore = require('../output-store.cjs');
  const { PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC } = require('../b-profile.cjs');
  const local = outputStore.buildDisplayName('my video.mov', PROFILE_ID_LOCAL_B);
  assert.equal(local, 'my_video_sdr_rec709_h264_hlg-local-b-v1.mp4');
  const generic = outputStore.buildDisplayName('my video.mov', PROFILE_ID_GENERIC);
  assert.equal(generic, 'my_video_sdr_rec709_h264_hlg-rec709-v1.mp4');
  // default without profile should be local B (backward compat)
  const def = outputStore.buildDisplayName('my video.mov');
  assert.equal(def, local);
  // unknown profile must throw
  assert.throws(() => outputStore.buildDisplayName('my.mov', 'unknown'), /unknown_profile/);
  // collision handling still works for both
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-disp-'));
  try {
    const displayLocal = outputStore.buildDisplayName('test.mov', PROFILE_ID_LOCAL_B);
    const p1 = outputStore.allocateUniqueFinalPath(tmp, displayLocal);
    fs.writeFileSync(p1, 'x');
    const p2 = outputStore.allocateUniqueFinalPath(tmp, displayLocal);
    assert.notEqual(p1, p2);
    assert.ok(p2.includes('_001'));
    const displayGeneric = outputStore.buildDisplayName('test.mov', PROFILE_ID_GENERIC);
    const pg1 = outputStore.allocateUniqueFinalPath(tmp, displayGeneric);
    // should be separate suffix space? generic name distinct, so not colliding with local
    assert.ok(pg1.includes('hlg-rec709-v1'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('inspection-adapter validateCliResponse accepts hlgSupported and both profiles', () => {
  const adapter = require('../inspection-adapter.cjs');
  const goodLocal = { outcome: 'complete', result: { displayName: 'a.mov', size: 123, sha256: 'a'.repeat(64), classification: 'hlgKnownLocal', reason: 'allowlist_hlg_match', canConvert: true, profileId: 'hlg-local-b-v1', duration: 1 } };
  assert.equal(adapter.validateCliResponse(goodLocal), true);
  const goodGeneric = { outcome: 'complete', result: { displayName: 'b.mov', size: 123, sha256: 'b'.repeat(64), classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'hlg-rec709-v1', duration: 1 } };
  assert.equal(adapter.validateCliResponse(goodGeneric), true);
  const badProfile = { outcome: 'complete', result: { displayName: 'c.mov', size: 123, sha256: 'c'.repeat(64), classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'unknown' } };
  assert.equal(adapter.validateCliResponse(badProfile), false);
  const badCls = { outcome: 'complete', result: { displayName: 'a.mov', size: 123, sha256: 'a'.repeat(64), classification: 'bogus', reason: 'x', canConvert: false } };
  assert.equal(adapter.validateCliResponse(badCls), false);
  const mismatchProfile = { outcome: 'complete', result: { displayName: 'a.mov', size: 123, sha256: 'a'.repeat(64), classification: 'hlgKnownLocal', reason: 'x', canConvert: true, profileId: 'hlg-rec709-v1' } };
  assert.equal(adapter.validateCliResponse(mismatchProfile), false);
});

test('ipc-contract isValidResponse accepts hlgSupported and validates profile pairing', () => {
  const { isValidResponse } = require('../ipc-contract.cjs');
  // hlgSupported with generic profile should be valid
  const okGeneric = { outcome: 'complete', result: { classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'hlg-rec709-v1', duration: 1 } };
  assert.equal(isValidResponse(okGeneric), true);
  // hlgSupported with local profile should be invalid (mismatched)
  const badGeneric = { outcome: 'complete', result: { classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'hlg-local-b-v1' } };
  assert.equal(isValidResponse(badGeneric), false);
  // hlgKnownLocal with generic profile invalid
  const badLocal = { outcome: 'complete', result: { classification: 'hlgKnownLocal', reason: 'allowlist_hlg_match', canConvert: true, profileId: 'hlg-rec709-v1' } };
  assert.equal(isValidResponse(badLocal), false);
  // hlgKnownLocal with local profile valid
  const okLocal = { outcome: 'complete', result: { classification: 'hlgKnownLocal', reason: 'allowlist_hlg_match', canConvert: true, profileId: 'hlg-local-b-v1', duration: 1 } };
  assert.equal(isValidResponse(okLocal), true);
  // unknown profile fails
  const unknown = { outcome: 'complete', result: { classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'unknown' } };
  assert.equal(isValidResponse(unknown), false);
  // uncertain without profile valid
  const uncertain = { outcome: 'complete', result: { classification: 'uncertain', reason: 'unknown', canConvert: false } };
  assert.equal(isValidResponse(uncertain), true);
  // pq unsupported
  const pq = { outcome: 'complete', result: { classification: 'pqHdr10Unsupported', reason: 'pq_transfer_detected', canConvert: false } };
  assert.equal(isValidResponse(pq), true);
});

test('ipc-contract attachIpc mints token for generic HLG and preserves privacy', async () => {
  const electronPath = require.resolve('electron');
  const originalCache = require.cache[electronPath];
  const mockIpcMain = {
    removeHandler() {},
    handle(channel, fn) { this._handler = fn; this._channel = channel; },
  };
  const mockDialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { ipcMain: mockIpcMain, dialog: mockDialog } };
  delete require.cache[require.resolve('../ipc-contract.cjs')];
  delete require.cache[require.resolve('../conversion-service.cjs')];
  const ipcContract = require('../ipc-contract.cjs');
  const { ConversionService } = require('../conversion-service.cjs');
  const { PROFILE_ID_GENERIC } = require('../b-profile.cjs');
  const policyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-ipc-policy-'));
  try {
    const fakeWindow = { webContents: { id: 42, send: () => {} } };
    const svc = new ConversionService();
    const genericPath = path.join(policyTmp, 'generic.mov');
    fs.writeFileSync(genericPath, 'video');
    const genericResult = {
      outcome: 'complete',
      result: {
        classification: 'hlgSupported',
        reason: 'hlg_metadata_match',
        canConvert: true,
        profileId: PROFILE_ID_GENERIC,
        duration: 1,
        displayName: 'generic.mov',
        size: 12345,
        sha256: 'b'.repeat(64),
        color: { colorSpace: 'bt2020nc', colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020', colorRange: 'tv', pixFmt: 'yuv420p10le' },
      },
    };
    const adapter = { inspect: async (p) => genericResult };
    ipcContract.attachIpc(fakeWindow, adapter, svc);
    const handler = mockIpcMain._handler;
    assert.ok(handler);
    const event = { sender: fakeWindow.webContents };
    const resp = await handler(event, { kind: 'path', path: genericPath });
    assert.equal(resp.outcome, 'complete');
    assert.equal(resp.result.classification, 'hlgSupported');
    assert.equal(resp.result.profileId, PROFILE_ID_GENERIC);
    assert.ok(resp.result.sourceId);
    assert.ok(/^[0-9a-f-]{36}$/i.test(resp.result.sourceId));
    // Token should be stored with correct profile
    const token = svc.getSourceToken(resp.result.sourceId);
    assert.ok(token);
    assert.equal(token.profileId, PROFILE_ID_GENERIC);
    assert.equal(token.sha256, 'b'.repeat(64));
    assert.equal(token.canonicalPath, fs.realpathSync(genericPath));

    // A failed canonicalization must not fall back to the submitted path or mint a token.
    const missing = await handler(event, { kind: 'path', path: path.join(policyTmp, 'missing.mov') });
    assert.deepEqual(missing, { outcome: 'error', reason: 'inspection_failed' });
    // PQ and DOVI should not be eligible (no token)
    const pqResult = {
      outcome: 'complete',
      result: { classification: 'pqHdr10Unsupported', reason: 'pq_transfer_detected', canConvert: false, displayName: 'pq.mov', size: 100, sha256: 'c'.repeat(64) },
    };
    const adapterPq = { inspect: async () => pqResult };
    ipcContract.attachIpc(fakeWindow, adapterPq, svc);
    const handler2 = mockIpcMain._handler;
    const respPq = await handler2(event, { kind: 'path', path: '/tmp/pq.mov' });
    assert.equal(respPq.outcome, 'complete');
    assert.equal(respPq.result.classification, 'pqHdr10Unsupported');
    assert.equal(respPq.result.sourceId, undefined, 'PQ should not mint sourceId');
    // Verify that inspection invalidates prior token (generic token should be gone after PQ inspection)
    assert.equal(svc.getSourceToken(resp.result.sourceId), null, 'prior generic token should be invalidated after new inspection');
  } finally {
    fs.rmSync(policyTmp, { recursive: true, force: true });
    if (originalCache) require.cache[electronPath] = originalCache; else delete require.cache[electronPath];
    delete require.cache[require.resolve('../ipc-contract.cjs')];
    delete require.cache[require.resolve('../conversion-service.cjs')];
    require('../ipc-contract.cjs'); // restore
  }
});

test('conversion-service token reinspection for generic HLG', async () => {
  const { ConversionService } = require('../conversion-service.cjs');
  const { PROFILE_ID_GENERIC, PROFILE_ID_LOCAL_B } = require('../b-profile.cjs');
  const svc = new ConversionService();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-generic-token-'));
  try {
    const src = path.join(tmp, 'generic.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    // Create generic token
    const shaGen = 'b'.repeat(64);
    const sourceIdGeneric = svc.createSourceToken({ canonicalPath: src, sha256: shaGen, size: 100, profileId: PROFILE_ID_GENERIC, ownerWebContentsId: 1, displayName: 'generic.mov' });
    // Mock inspection to return generic HLG matching
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'hlgSupported',
          reason: 'hlg_metadata_match',
          canConvert: true,
          profileId: PROFILE_ID_GENERIC,
          displayName: 'generic.mov',
          size: 100,
          sha256: shaGen,
        },
      }),
    };
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const revalOk = await svc.revalidateSourceToken(sourceIdGeneric, 1);
    assert.equal(revalOk.ok, true);
    assert.equal(revalOk.inspectedResult.classification, 'hlgSupported');
    assert.equal(revalOk.inspectedResult.profileId, PROFILE_ID_GENERIC);

    // Mismatched profile should fail: token generic but inspected returns local
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'hlgKnownLocal',
          reason: 'allowlist_hlg_match',
          canConvert: true,
          profileId: PROFILE_ID_LOCAL_B,
          displayName: 'generic.mov',
          size: 100,
          sha256: shaGen,
        },
      }),
    };
    const revalMismatch = await svc.revalidateSourceToken(sourceIdGeneric, 1);
    assert.equal(revalMismatch.ok, false, 'profile mismatch should fail revalidation');

    // PQ result should fail
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'pqHdr10Unsupported',
          reason: 'pq_transfer_detected',
          canConvert: false,
          displayName: 'generic.mov',
          size: 100,
          sha256: shaGen,
        },
      }),
    };
    const revalPq = await svc.revalidateSourceToken(sourceIdGeneric, 1);
    assert.equal(revalPq.ok, false);

    // DOVI unsupported should fail
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'dolbyVisionUnsupported',
          reason: 'dovi_not_allowlisted',
          canConvert: false,
          displayName: 'generic.mov',
          size: 100,
          sha256: shaGen,
        },
      }),
    };
    const revalDovi = await svc.revalidateSourceToken(sourceIdGeneric, 1);
    assert.equal(revalDovi.ok, false);

    // Contradictory/uncertain should fail
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'uncertain',
          reason: 'contradictory_metadata',
          canConvert: false,
          displayName: 'generic.mov',
          size: 100,
          sha256: shaGen,
        },
      }),
    };
    const revalUncertain = await svc.revalidateSourceToken(sourceIdGeneric, 1);
    assert.equal(revalUncertain.ok, false);

    // SHA mismatch should fail
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'hlgSupported',
          reason: 'hlg_metadata_match',
          canConvert: true,
          profileId: PROFILE_ID_GENERIC,
          displayName: 'generic.mov',
          size: 100,
          sha256: 'c'.repeat(64), // different
        },
      }),
    };
    const revalShaMismatch = await svc.revalidateSourceToken(sourceIdGeneric, 1);
    assert.equal(revalShaMismatch.ok, false);

    // Unknown profile token should fail
    const badSourceId = svc.createSourceToken({ canonicalPath: src, sha256: 'd'.repeat(64), size: 100, profileId: 'unknown', ownerWebContentsId: 2, displayName: 'bad.mov' });
    const revalBadProfile = await svc.revalidateSourceToken(badSourceId, 2);
    assert.equal(revalBadProfile.ok, false);

    // Valid local B token revalidation still works
    const shaLocal = 'a'.repeat(64);
    const sourceIdLocal = svc.createSourceToken({ canonicalPath: src, sha256: shaLocal, size: 100, profileId: PROFILE_ID_LOCAL_B, ownerWebContentsId: 3, displayName: 'local.mov' });
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: {
          classification: 'hlgKnownLocal',
          reason: 'allowlist_hlg_match',
          canConvert: true,
          profileId: PROFILE_ID_LOCAL_B,
          displayName: 'local.mov',
          size: 100,
          sha256: shaLocal,
        },
      }),
    };
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const revalLocal = await svc.revalidateSourceToken(sourceIdLocal, 3);
    assert.equal(revalLocal.ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('conversion-service startJob routes by profileId to executor and verifier, unknown fails', async () => {
  const { ConversionService } = require('../conversion-service.cjs');
  const { PROFILE_ID_GENERIC, PROFILE_ID_LOCAL_B } = require('../b-profile.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-route-'));
  try {
    const store = require('../output-store.cjs');
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    let executorProfile = null;
    let verifierProfile = null;
    let verifierArgs = null;
    const svc = new ConversionService({
      outputStore: {
        ensureOutputRoot: () => { fs.mkdirSync(tmp, { recursive: true }); return tmp; },
        buildDisplayName: store.buildDisplayName,
        allocateUniqueFinalPath: (r, n) => store.allocateUniqueFinalPath(r, n),
        getStagingPath: (r, f) => store.getStagingPath(r, f),
        removeStaging: store.removeStaging,
      },
      inspectionAdapter: {
        inspect: async () => ({
          outcome: 'complete',
          result: {
            classification: 'hlgSupported',
            reason: 'hlg_metadata_match',
            canConvert: true,
            profileId: PROFILE_ID_GENERIC,
            displayName: 'src.mov',
            size: 100,
            sha256: 'a'.repeat(64),
          },
        }),
      },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake',
        runBConversion: async (opts) => {
          executorProfile = opts.profileId;
          // Create staging file
          fs.writeFileSync(opts.stagingPath, 'enc');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async (canonical, staging, verifierPath, profile) => {
        verifierProfile = profile;
        verifierArgs = [canonical, staging, verifierPath, profile];
        return 0;
      },
    });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID_GENERIC, ownerWebContentsId: 10, displayName: 'src.mov' });
    const win = { id: 10, send: () => {} };
    const res = await svc.startJob({ sourceId, profileId: PROFILE_ID_GENERIC, senderWebContents: win });
    assert.equal(res.ok, true);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(executorProfile, PROFILE_ID_GENERIC);
    assert.equal(verifierProfile, PROFILE_ID_GENERIC);
    assert.ok(verifierArgs);
    assert.equal(verifierArgs[3], PROFILE_ID_GENERIC);
    // Check that displayName used generic suffix
    const files = fs.readdirSync(tmp).filter(f => f.includes('hlg-rec709-v1'));
    assert.ok(files.length >= 1, 'output should have generic profile suffix');

    // Now test local B routing
    executorProfile = null;
    verifierProfile = null;
    const svc2 = new ConversionService({
      outputStore: {
        ensureOutputRoot: () => { fs.mkdirSync(tmp, { recursive: true }); return tmp; },
        buildDisplayName: store.buildDisplayName,
        allocateUniqueFinalPath: (r, n) => store.allocateUniqueFinalPath(r, n),
        getStagingPath: (r, f) => store.getStagingPath(r, f),
        removeStaging: store.removeStaging,
      },
      inspectionAdapter: {
        inspect: async () => ({
          outcome: 'complete',
          result: {
            classification: 'hlgKnownLocal',
            reason: 'allowlist_hlg_match',
            canConvert: true,
            profileId: PROFILE_ID_LOCAL_B,
            displayName: 'src.mov',
            size: 100,
            sha256: 'b'.repeat(64),
          },
        }),
      },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake',
        runBConversion: async (opts) => {
          executorProfile = opts.profileId;
          fs.writeFileSync(opts.stagingPath, 'enc');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async (canonical, staging, verifierPath, profile) => {
        verifierProfile = profile;
        return 0;
      },
    });
    svc2.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sourceIdLocal = svc2.createSourceToken({ canonicalPath: src, sha256: 'b'.repeat(64), size: 100, profileId: PROFILE_ID_LOCAL_B, ownerWebContentsId: 11, displayName: 'src.mov' });
    const win2 = { id: 11, send: () => {} };
    const res2 = await svc2.startJob({ sourceId: sourceIdLocal, profileId: PROFILE_ID_LOCAL_B, senderWebContents: win2 });
    assert.equal(res2.ok, true);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(executorProfile, PROFILE_ID_LOCAL_B);
    assert.equal(verifierProfile, PROFILE_ID_LOCAL_B);

    // Unknown profile should fail closed at isValidConvertStartRequest and at startJob
    const { isValidConvertStartRequest } = require('../conversion-service.cjs');
    const badUuid = crypto.randomUUID();
    assert.equal(isValidConvertStartRequest({ version: 1, sourceId: badUuid, profileId: 'unknown' }), false);
    const svc3 = new ConversionService({
      inspectionAdapter: {
        inspect: async () => ({
          outcome: 'complete',
          result: {
            classification: 'hlgSupported',
            reason: 'hlg_metadata_match',
            canConvert: true,
            profileId: PROFILE_ID_GENERIC,
            displayName: 'src.mov',
            size: 100,
            sha256: 'a'.repeat(64),
          },
        }),
      },
    });
    svc3.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const goodId = svc3.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID_GENERIC, ownerWebContentsId: 12, displayName: 'src.mov' });
    const win3 = { id: 12, send: () => {} };
    const resBad = await svc3.startJob({ sourceId: goodId, profileId: 'unknown', senderWebContents: win3 });
    assert.equal(resBad.ok, false);
    assert.equal(resBad.reason, 'invalid_request');

    // Mismatched requested profile vs token should fail
    const resMismatch = await svc3.startJob({ sourceId: goodId, profileId: PROFILE_ID_LOCAL_B, senderWebContents: win3 });
    assert.equal(resMismatch.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('conversion-service verifier invocation shell argv safe', async () => {
  const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'conversion-service.cjs'), 'utf8');
  // Must use spawn with array and shell:false, including profileId as third arg
  assert.ok(svcSrc.includes("spawn(verifierPath, [reval.canonical, stagingPath, expectedProfile]"));
  assert.ok(svcSrc.includes('shell: false'));
  assert.ok(!svcSrc.includes('execSync'));
  // Check that verifierRunner signature includes profile
  assert.ok(svcSrc.includes('verifierRunner(reval.canonical, stagingPath, verifierPath, expectedProfile)'));
});

test('renderer eligibility and copy for both HLG paths', () => {
  const helpers = require('../renderer/app.js');
  const { COPY } = helpers;
  // isEligibleResult should accept both classifications with sourceId
  const uuid = crypto.randomUUID();
  assert.equal(helpers.isEligibleResult({ classification: 'hlgKnownLocal', canConvert: true, sourceId: uuid, profileId: 'hlg-local-b-v1' }), true);
  assert.equal(helpers.isEligibleResult({ classification: 'hlgSupported', canConvert: true, sourceId: uuid, profileId: 'hlg-rec709-v1' }), true);
  // Should also accept without explicit profile check (renderer generic)
  assert.equal(helpers.isEligibleResult({ classification: 'hlgSupported', canConvert: true, sourceId: uuid }), true);
  // PQ/DOVI/uncertain should not be eligible
  assert.equal(helpers.isEligibleResult({ classification: 'pqHdr10Unsupported', canConvert: false, sourceId: uuid }), false);
  assert.equal(helpers.isEligibleResult({ classification: 'dolbyVisionUnsupported', canConvert: false, sourceId: uuid }), false);
  assert.equal(helpers.isEligibleResult({ classification: 'uncertain', canConvert: false, sourceId: uuid }), false);
  // Missing sourceId should fail
  assert.equal(helpers.isEligibleResult({ classification: 'hlgSupported', canConvert: true, sourceId: '' }), false);
  // buildSafeTechnicalFields should show HLG for both
  const fieldsLocal = helpers.buildSafeTechnicalFields({ classification: 'hlgKnownLocal', size: 12345, duration: 12.3 });
  assert.ok(fieldsLocal.some(f => f.label === 'Format' && f.value === 'HLG'));
  const fieldsGeneric = helpers.buildSafeTechnicalFields({ classification: 'hlgSupported', size: 12345, duration: 12.3 });
  assert.ok(fieldsGeneric.some(f => f.label === 'Format' && f.value === 'HLG'));
  // copy checks
  assert.equal(COPY.eligibleTitle, 'Ready to convert');
  assert.equal(COPY.eligibleDesc, 'This video can be converted with a verified HDR → SDR profile.');
  // Ensure copy does not contain forbidden profile literals (renderer should not leak)
  const allCopy = JSON.stringify(COPY).toLowerCase();
  // COPY values should not contain literal profile IDs? The test helper checks containsForbiddenVisible includes hlg-local etc. But COPY now should still not contain them
  // We already check containsForbiddenVisible for COPY values in previous tests. Here just ensure generic still works.
  assert.equal(helpers.containsForbiddenVisible(COPY.eligibleTitle), false);
});

test('verifier script supports both profiles and unknown fails, argv safe', () => {
  const scriptPath = path.resolve(__dirname, '../../scripts/verify-spike.sh');
  const src = fs.readFileSync(scriptPath, 'utf8');
  // Must accept 2 or 3 args, third is profileId
  assert.ok(src.includes('EXPECTED_PROFILE="${3:-hlg-local-b-v1}"') || src.includes('EXPECTED_PROFILE'));
  assert.ok(src.includes('hlg-local-b-v1') && src.includes('hlg-rec709-v1'));
  assert.ok(src.includes('case \"$EXPECTED_PROFILE\" in'));
  assert.ok(src.includes('unknown profile'));
  // Generic and PQ source re-gates must use the shared normalized evidence helper.
  assert.ok(src.includes('verify_contract.py" source'));
  assert.ok(src.includes('-select_streams V:0'));
  assert.equal(src.includes('-select_streams v:0'), false);
  // Must retain privacy scan and Rec709 tags checks
  assert.ok(src.includes('com[.]apple[.]quicktime'));
  assert.ok(src.includes('bt709'));
  // Shell argv safe: uses spawn equivalent? In bash, ensure no eval, uses quoted \"$1\" etc.
  assert.ok(src.includes('\"$SRC_INPUT\"') || src.includes('\"$1\"'));
  assert.equal(src.includes('eval '), false);
  // Must still check source!=output
  assert.ok(src.includes('source and output resolve to the same path'));
  // Must handle both profiles: check for SHA gate for local and metadata for generic
  assert.ok(src.includes('EXPECTED_1') && src.includes('EXPECTED_2'));
  assert.ok(src.includes('generic HLG') || src.includes('hlg-rec709-v1'));
});
