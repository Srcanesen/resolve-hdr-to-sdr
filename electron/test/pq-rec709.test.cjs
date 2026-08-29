const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// b-profile frozen PQ graph
test('b-profile pq-rec709-v1 frozen graph and distinct ID', () => {
  const bProfile = require('../b-profile.cjs');
  assert.ok(bProfile.isKnownProfileId('pq-rec709-v1'));
  assert.equal(bProfile.PROFILE_ID_PQ, 'pq-rec709-v1');
  assert.equal(bProfile.FILTER_GRAPH_PQ, 'libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le');
  // Same text as generic is allowed, but distinct route
  assert.equal(bProfile.FILTER_GRAPH_PQ, bProfile.FILTER_GRAPH_GENERIC);
  assert.notEqual(bProfile.PROFILE_ID_PQ, bProfile.PROFILE_ID_GENERIC);
  assert.equal(bProfile.getFilterGraph('pq-rec709-v1'), bProfile.FILTER_GRAPH_PQ);
  // PROFILES contains all three
  assert.ok(bProfile.PROFILES['pq-rec709-v1']);
  assert.ok(bProfile.PROFILES['hlg-local-b-v1']);
  assert.ok(bProfile.PROFILES['hlg-rec709-v1']);
  // No gamma trim for PQ
  assert.equal(bProfile.FILTER_GRAPH_PQ.includes('eq=gamma'), false);
  assert.equal(bProfile.FILTER_GRAPH_PQ.includes('spline'), false);
  assert.ok(bProfile.FILTER_GRAPH_PQ.includes('tonemapping=bt.2390'));
  assert.ok(bProfile.FILTER_GRAPH_PQ.includes('gamut_mode=perceptual'));
});

// b-executor capability for PQ requires bt.2390, perceptual, peak_detect
test('b-executor checkCapability for pq requires bt.2390, perceptual, peak_detect', () => {
  const bExecutor = require('../b-executor.cjs');
  const { PROFILE_ID_PQ, PROFILE_ID_GENERIC, PROFILE_ID_LOCAL_B } = require('../b-profile.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-pq-cap-'));
  const makeFake = (name, lines) => {
    const fake = path.join(tmp, name);
    const quote = (v) => `'${v.replace(/'/g, "'\\\\''")}'`;
    const script = [
      '#!/bin/sh',
      'case \"$*\" in',
      '  *filter=libplacebo*)',
      `    printf '%s\\n' ${lines.map(quote).join(' ')}`,
      '    exit 0;;',
      '  *filter=sidedata*)',
      "    printf '%s\\n' 'Filter sidedata' 'MASTERING_DISPLAY_METADATA' 'CONTENT_LIGHT_LEVEL' 'DYNAMIC_HDR_PLUS' 'DOVI_RPU_BUFFER' 'DOVI_METADATA' 'DYNAMIC_HDR_VIVID' 'AMBIENT_VIEWING_ENVIRONMENT'",
      '    exit 0;;',
      '  *encoder=libx264*)',
      "    printf '%s\\n' 'Encoder libx264'",
      '    exit 0;;',
      '  *encoder=aac*)',
      "    printf '%s\\n' 'Encoder aac'",
      '    exit 0;;',
      'esac',
      'exit 1',
    ].join('\n');
    fs.writeFileSync(fake, script, { mode: 0o755 });
    fs.chmodSync(fake, 0o755);
    return fake;
  };
  try {
    const common = ['Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual', 'bt.2390', 'peak_detect'];
    const genericOnly = makeFake('generic-only', ['Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual', 'bt.2390']);
    // PQ should fail because missing peak_detect
    const resPqOnGeneric = bExecutor.checkCapability(genericOnly, PROFILE_ID_PQ);
    assert.equal(resPqOnGeneric.ok, false);
    assert.equal(resPqOnGeneric.reason, 'profile_unavailable');
    // Generic should still pass
    const resGeneric = bExecutor.checkCapability(genericOnly, PROFILE_ID_GENERIC);
    assert.equal(resGeneric.ok, true);
    // Full PQ capable
    const pqFull = makeFake('pq-full', common);
    assert.equal(bExecutor.checkCapability(pqFull, PROFILE_ID_PQ).ok, true);
    assert.equal(bExecutor.checkCapability(pqFull, PROFILE_ID_GENERIC).ok, true);
    // Missing bt.2390
    const noBt2390 = makeFake('no-bt2390', ['Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual', 'peak_detect']);
    assert.equal(bExecutor.checkCapability(noBt2390, PROFILE_ID_PQ).ok, false);
    // Unknown profile fails before probe
    assert.equal(bExecutor.checkCapability(pqFull, 'unknown-profile').ok, false);
    assert.equal(bExecutor.checkCapability(pqFull, 'unknown-profile').reason, 'profile_unavailable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('b-executor buildFfmpegArgs routes by pq profile and unknown fails', () => {
  const bExecutor = require('../b-executor.cjs');
  const { PROFILE_ID_PQ, FILTER_GRAPH_PQ } = require('../b-profile.cjs');
  const args = bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.mov', PROFILE_ID_PQ);
  const idx = args.indexOf('-vf');
  assert.notEqual(idx, -1);
  assert.equal(args[idx+1], `${FILTER_GRAPH_PQ},${bExecutor.OUTPUT_SANITIZATION_SUFFIX}`);
  assert.ok(args[idx+1].includes('tonemapping=bt.2390'));
  assert.equal(args[idx+1].includes('eq=gamma'), false);
  assert.throws(() => bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.mov', 'unknown'), /unknown_profile/);
});

test('b-executor runBConversion pq unknown fails invalid_request without spawn', async () => {
  const bExecutor = require('../b-executor.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-pq-run-'));
  try {
    const src = path.join(tmp, 'src.mov');
    const staging = path.join(tmp, 'out.partial.mp4');
    fs.writeFileSync(src, 'dummy');
    const res = await bExecutor.runBConversion({ sourcePath: src, stagingPath: staging, profileId: 'pq-unknown', ffmpegPath: '/nonexistent/ffmpeg' });
    assert.equal(res.outcome, 'error');
    assert.equal(res.reason, 'invalid_request');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('conversion-service isValidConvertStartRequest accepts pq and rejects unknown', () => {
  const { isValidConvertStartRequest, PROFILE_ID_PQ } = require('../conversion-service.cjs');
  const uuid = crypto.randomUUID();
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: PROFILE_ID_PQ }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: 'pq-rec709-v0' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: uuid, profileId: 'unknown' }), false);
});

test('conversion-service isValidConvertEvent accepts pq', () => {
  const { isValidConvertEvent, PROFILE_ID_PQ } = require('../conversion-service.cjs');
  const base = { version: 1, jobId: 'j', seq: 0, phase: 'converting', status: 'running' };
  assert.equal(isValidConvertEvent({ ...base, profileId: PROFILE_ID_PQ }), true);
  assert.equal(isValidConvertEvent({ ...base, profileId: 'unknown' }), false);
});

test('outputStore buildDisplayName routes by pq profile', () => {
  const outputStore = require('../output-store.cjs');
  const { PROFILE_ID_PQ, PROFILE_ID_GENERIC, PROFILE_ID_LOCAL_B } = require('../b-profile.cjs');
  const name = outputStore.buildDisplayName('my video.mov', PROFILE_ID_PQ);
  assert.equal(name, 'my_video_sdr_rec709_h264_pq-rec709-v1.mp4');
  assert.throws(() => outputStore.buildDisplayName('my.mov', 'unknown'), /unknown_profile/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-pq-disp-'));
  try {
    const displayPq = outputStore.buildDisplayName('test.mov', PROFILE_ID_PQ);
    const p1 = outputStore.allocateUniqueFinalPath(tmp, displayPq);
    fs.writeFileSync(p1, 'x');
    const p2 = outputStore.allocateUniqueFinalPath(tmp, displayPq);
    assert.notEqual(p1, p2);
    assert.ok(p2.includes('_001') || p2.includes('_'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('inspection-adapter validateCliResponse accepts pqSupported', () => {
  const adapter = require('../inspection-adapter.cjs');
  const goodPq = { outcome: 'complete', result: { displayName: 'a.mov', size: 123, sha256: 'a'.repeat(64), classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: true, profileId: 'pq-rec709-v1' } };
  assert.equal(adapter.validateCliResponse(goodPq), true);
  const goodHlg = { outcome: 'complete', result: { displayName: 'b.mov', size: 123, sha256: 'b'.repeat(64), classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'hlg-rec709-v1' } };
  assert.equal(adapter.validateCliResponse(goodHlg), true);
  const bad = { outcome: 'complete', result: { displayName: 'c.mov', size: 123, sha256: 'c'.repeat(64), classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: true, profileId: 'unknown' } };
  assert.equal(adapter.validateCliResponse(bad), false);
  const badCls = { outcome: 'complete', result: { displayName: 'a.mov', size: 123, sha256: 'a'.repeat(64), classification: 'bogus', reason: 'x', canConvert: false } };
  assert.equal(adapter.validateCliResponse(badCls), false);
});

test('ipc-contract isValidResponse accepts pqSupported pairing', () => {
  const { isValidResponse } = require('../ipc-contract.cjs');
  const okPq = { outcome: 'complete', result: { classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: true, profileId: 'pq-rec709-v1' } };
  assert.equal(isValidResponse(okPq), true);
  const badPq = { outcome: 'complete', result: { classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: true, profileId: 'hlg-rec709-v1' } };
  assert.equal(isValidResponse(badPq), false);
  const badGeneric = { outcome: 'complete', result: { classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: 'pq-rec709-v1' } };
  assert.equal(isValidResponse(badGeneric), false);
  const pqUnsupported = { outcome: 'complete', result: { classification: 'pqHdr10Unsupported', reason: 'pq_missing_mdcv_or_clli', canConvert: false } };
  assert.equal(isValidResponse(pqUnsupported), true);
  // pqSupported must have canConvert true
  const badCan = { outcome: 'complete', result: { classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: false, profileId: 'pq-rec709-v1' } };
  assert.equal(isValidResponse(badCan), false);
});

test('ipc-contract attachIpc mints token for pqSupported', async () => {
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
  const { PROFILE_ID_PQ } = require('../b-profile.cjs');
  try {
    const fakeWindow = { webContents: { id: 99, send: () => {} } };
    const svc = new ConversionService();
    const pqResult = {
      outcome: 'complete',
      result: {
        classification: 'pqSupported',
        reason: 'pq_metadata_match',
        canConvert: true,
        profileId: PROFILE_ID_PQ,
        displayName: 'pq.mov',
        size: 12345,
        sha256: 'f'.repeat(64),
        color: { colorSpace: 'bt2020nc', colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', colorRange: 'tv', pixFmt: 'yuv420p10le' },
      },
    };
    const adapter = { inspect: async (p) => pqResult };
    ipcContract.attachIpc(fakeWindow, adapter, svc);
    const handler = mockIpcMain._handler;
    assert.ok(handler);
    const event = { sender: fakeWindow.webContents };
    const resp = await handler(event, { kind: 'path', path: '/tmp/pq.mov' });
    assert.equal(resp.outcome, 'complete');
    assert.equal(resp.result.classification, 'pqSupported');
    assert.equal(resp.result.profileId, PROFILE_ID_PQ);
    assert.ok(resp.result.sourceId);
    const token = svc.getSourceToken(resp.result.sourceId);
    assert.ok(token);
    assert.equal(token.profileId, PROFILE_ID_PQ);
    // PQ missing metadata should not mint token
    const pqUnsupported = {
      outcome: 'complete',
      result: { classification: 'pqHdr10Unsupported', reason: 'pq_missing_mdcv_or_clli', canConvert: false, displayName: 'pq.mov', size: 100, sha256: 'c'.repeat(64) },
    };
    const adapter2 = { inspect: async () => pqUnsupported };
    ipcContract.attachIpc(fakeWindow, adapter2, svc);
    const handler2 = mockIpcMain._handler;
    const resp2 = await handler2(event, { kind: 'path', path: '/tmp/pq2.mov' });
    assert.equal(resp2.result.classification, 'pqHdr10Unsupported');
    assert.equal(resp2.result.sourceId, undefined);
    // prior token invalidated
    assert.equal(svc.getSourceToken(resp.result.sourceId), null);
  } finally {
    if (originalCache) require.cache[electronPath] = originalCache; else delete require.cache[electronPath];
    delete require.cache[require.resolve('../ipc-contract.cjs')];
    delete require.cache[require.resolve('../conversion-service.cjs')];
    require('../ipc-contract.cjs');
  }
});

test('conversion-service token reinspection for pq', async () => {
  const { ConversionService } = require('../conversion-service.cjs');
  const { PROFILE_ID_PQ, PROFILE_ID_GENERIC } = require('../b-profile.cjs');
  const svc = new ConversionService();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-pq-token-'));
  try {
    const src = path.join(tmp, 'pq.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    const sha = 'f'.repeat(64);
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: sha, size: 100, profileId: PROFILE_ID_PQ, ownerWebContentsId: 1, displayName: 'pq.mov' });
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: { classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: true, profileId: PROFILE_ID_PQ, displayName: 'pq.mov', size: 100, sha256: sha },
      }),
    };
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const revalOk = await svc.revalidateSourceToken(sourceId, 1);
    assert.equal(revalOk.ok, true);
    // Mismatch to HLG should fail
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: { classification: 'hlgSupported', reason: 'hlg_metadata_match', canConvert: true, profileId: PROFILE_ID_GENERIC, displayName: 'pq.mov', size: 100, sha256: sha },
      }),
    };
    const revalMismatch = await svc.revalidateSourceToken(sourceId, 1);
    assert.equal(revalMismatch.ok, false);
    // HDR10+ reject
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: { classification: 'pqHdr10Unsupported', reason: 'hdr10plus_detected', canConvert: false, displayName: 'pq.mov', size: 100, sha256: sha },
      }),
    };
    assert.equal((await svc.revalidateSourceToken(sourceId, 1)).ok, false);
    // DOVI priority
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: { classification: 'dolbyVisionUnsupported', reason: 'dovi_not_allowlisted', canConvert: false, displayName: 'pq.mov', size: 100, sha256: sha },
      }),
    };
    assert.equal((await svc.revalidateSourceToken(sourceId, 1)).ok, false);
    // Missing mdcv
    svc.dependencies.inspectionAdapter = {
      inspect: async () => ({
        outcome: 'complete',
        result: { classification: 'pqHdr10Unsupported', reason: 'pq_missing_mdcv_or_clli', canConvert: false, displayName: 'pq.mov', size: 100, sha256: sha },
      }),
    };
    assert.equal((await svc.revalidateSourceToken(sourceId, 1)).ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('conversion-service startJob routes pq to executor and verifier', async () => {
  const { ConversionService } = require('../conversion-service.cjs');
  const { PROFILE_ID_PQ } = require('../b-profile.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-pq-route-'));
  try {
    const store = require('../output-store.cjs');
    const src = path.join(tmp, 'src.mov');
    fs.writeFileSync(src, 'x'.repeat(100));
    let executorProfile = null;
    let verifierProfile = null;
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
          result: { classification: 'pqSupported', reason: 'pq_metadata_match', canConvert: true, profileId: PROFILE_ID_PQ, displayName: 'src.mov', size: 100, sha256: 'a'.repeat(64) },
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
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: src });
    const sourceId = svc.createSourceToken({ canonicalPath: src, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID_PQ, ownerWebContentsId: 10, displayName: 'src.mov' });
    const win = { id: 10, send: () => {} };
    const res = await svc.startJob({ sourceId, profileId: PROFILE_ID_PQ, senderWebContents: win });
    assert.equal(res.ok, true);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(executorProfile, PROFILE_ID_PQ);
    assert.equal(verifierProfile, PROFILE_ID_PQ);
    const files = fs.readdirSync(tmp).filter(f => f.includes('pq-rec709-v1'));
    assert.ok(files.length >= 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('conversion-service verifier invocation shell argv safe includes pq', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'conversion-service.cjs'), 'utf8');
  assert.ok(src.includes("spawn(verifierPath, [reval.canonical, stagingPath, expectedProfile]"));
  assert.ok(src.includes('shell: false'));
});

test('renderer eligibility and copy for pq path', () => {
  const helpers = require('../renderer/app.js');
  const { COPY } = helpers;
  const uuid = crypto.randomUUID();
  assert.equal(helpers.isEligibleResult({ classification: 'pqSupported', canConvert: true, sourceId: uuid, profileId: 'pq-rec709-v1' }), true);
  assert.equal(helpers.isEligibleResult({ classification: 'pqHdr10Unsupported', canConvert: false, sourceId: uuid }), false);
  const fieldsPq = helpers.buildSafeTechnicalFields({ classification: 'pqSupported', size: 12345, duration: '12.3' });
  assert.ok(fieldsPq.some(f => f.label === 'Format' && f.value === 'PQ / HDR10'));
  const fieldsPqUns = helpers.buildSafeTechnicalFields({ classification: 'pqHdr10Unsupported', size: 12345 });
  assert.ok(fieldsPqUns.some(f => f.label === 'Format' && f.value === 'PQ / HDR10'));
  const copyPq = helpers.mapUnsupportedCopy('pqHdr10Unsupported');
  assert.equal(copyPq.title, 'PQ / HDR10 detected');
  // eligible copy
  assert.equal(COPY.eligibleTitle, 'Ready to convert');
  assert.equal(helpers.containsForbiddenVisible(COPY.eligibleTitle), false);
});

test('verifier script supports pq profile and rejects HDR frame side data', () => {
  const scriptPath = path.resolve(__dirname, '../../scripts/verify-spike.sh');
  const src = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(src.includes('pq-rec709-v1'));
  assert.ok(src.includes('-read_intervals "%+#1"'));
  for (const token of ['Mastering display metadata', 'Content light level metadata', 'HDR10+', 'DOVI', 'HDR Vivid', 'Ambient viewing environment']) {
    assert.ok(src.toLowerCase().includes(token.toLowerCase()), `verifier must detect ${token}`);
  }
  assert.match(src, /forbidden HDR frame side data/);
  assert.ok(src.includes('case \"$EXPECTED_PROFILE\" in'));
  assert.ok(src.includes('unknown profile'));
  assert.ok(src.includes('bt2020nc'));
  assert.ok(src.includes('smpte2084'));
  assert.ok(src.includes('has_mdcv') || src.includes('hasMdcv') || src.includes('MDCV'));
  assert.ok(src.includes('has_dovi') || src.includes('hasDovi'));
  assert.ok(src.includes('has_hdr10plus') || src.includes('hasHdr10Plus') || src.includes('hdr10plus'));
  assert.ok(src.includes('com[.]apple[.]quicktime'));
  assert.ok(src.includes('bt709'));
  assert.equal(src.includes('eval '), false);
  assert.ok(src.includes('source and output resolve to the same path'));
  assert.ok(src.includes('read_intervals') || src.includes('%+#1'));
});

const knownSource = '/tmp/212724_5s_excerpt.mp4';
const knownLeakyOutput = path.join(
  os.homedir(),
  'Movies',
  'HdrToSdr',
  '212724_5s_excerpt_sdr_rec709_h264_pq-rec709-v1.mp4',
);
test('verifier rejects the confirmed leaky PQ output artifact', { skip: !(fs.existsSync(knownSource) && fs.existsSync(knownLeakyOutput)) }, () => {
  const scriptPath = path.resolve(__dirname, '../../scripts/verify-spike.sh');
  const result = spawnSync(scriptPath, [knownSource, knownLeakyOutput, 'pq-rec709-v1'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'the obsolete output must fail the HDR side-data gate');
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, /HDR frame side data|Mastering display metadata|Content light level metadata/);
});
