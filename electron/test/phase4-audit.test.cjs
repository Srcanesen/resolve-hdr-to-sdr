const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const bExecutor = require('../b-executor.cjs');
const {
  ConversionService,
  MAX_THUMB_BYTES,
  fingerprintFile,
} = require('../conversion-service.cjs');
const { PROFILE_ID_GENERIC } = require('../b-profile.cjs');
const outputStore = require('../output-store.cjs');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function makeCapabilityFake(dir, name, libplaceboTokens, counterPath = null) {
  const fake = path.join(dir, name);
  const counter = counterPath ? `printf '%s\\n' "$*" >> ${shellQuote(counterPath)};` : '';
  const script = [
    '#!/bin/sh',
    `${counter}`,
    'case "$*" in',
    `  *filter=libplacebo*) printf '%s\\n' ${libplaceboTokens.map(shellQuote).join(' ')}; exit 0;;`,
    "  *filter=sidedata*) printf '%s\\n' 'Filter sidedata' 'MASTERING_DISPLAY_METADATA' 'CONTENT_LIGHT_LEVEL' 'DYNAMIC_HDR_PLUS' 'DOVI_RPU_BUFFER' 'DOVI_METADATA' 'DYNAMIC_HDR_VIVID' 'AMBIENT_VIEWING_ENVIRONMENT'; exit 0;;",
    "  *encoder=libx264*) printf '%s\\n' 'Encoder libx264'; exit 0;;",
    "  *encoder=aac*) printf '%s\\n' 'Encoder aac'; exit 0;;",
    '  *) exit 0;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(fake, script, { mode: 0o755 });
  fs.chmodSync(fake, 0o755);
  return fake;
}

test('BUG-010 exact capability tokens reject btX2390 while accepting bt.2390', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-token-'));
  try {
    const common = ['Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual'];
    const falsePositive = makeCapabilityFake(tmp, 'false-positive', [...common, 'btX2390']);
    const valid = makeCapabilityFake(tmp, 'valid', [...common, 'bt.2390']);
    assert.equal((await bExecutor.checkCapability(falsePositive, PROFILE_ID_GENERIC)).ok, false);
    assert.equal((await bExecutor.checkCapability(valid, PROFILE_ID_GENERIC)).ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-011 capability probing is asynchronous and coalesces cached probes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-cap-'));
  try {
    const counter = path.join(tmp, 'probe-count');
    const fake = makeCapabilityFake(tmp, 'ffmpeg', [
      'Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual', 'bt.2390',
    ], counter);
    const pending = bExecutor.checkCapability(fake, PROFILE_ID_GENERIC);
    assert.equal(typeof pending.then, 'function');
    const results = await Promise.all([
      pending,
      bExecutor.checkCapability(fake, PROFILE_ID_GENERIC),
      bExecutor.checkCapability(fake, PROFILE_ID_GENERIC),
    ]);
    assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 4, 'one async probe per capability check');
    assert.equal((await bExecutor.checkCapability(fake, PROFILE_ID_GENERIC)).ok, true);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 4, 'completed result is cached');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-012 progress parses long chunks and reports real monotonic 0..99 percentages', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-progress-'));
  try {
    const fake = path.join(tmp, 'ffmpeg');
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      "  *filter=libplacebo*) printf '%s\\n' 'Filter libplacebo' 'tonemapping' 'gamut_mode' 'perceptual' 'bt.2390'; exit 0;;",
      "  *filter=sidedata*) printf '%s\\n' 'Filter sidedata' 'MASTERING_DISPLAY_METADATA' 'CONTENT_LIGHT_LEVEL' 'DYNAMIC_HDR_PLUS' 'DOVI_RPU_BUFFER' 'DOVI_METADATA' 'DYNAMIC_HDR_VIVID' 'AMBIENT_VIEWING_ENVIRONMENT'; exit 0;;",
      "  *encoder=libx264*) printf '%s\\n' 'Encoder libx264'; exit 0;;",
      "  *encoder=aac*) printf '%s\\n' 'Encoder aac'; exit 0;;",
      '  *)',
      '    i=0; while [ "$i" -lt 5000 ]; do printf "noise-%s\\n" "$i"; i=$((i + 1)); done',
      '    printf "out_time_ms=2500000\\nprogress=continue\\nout_time_ms=10000000\\nprogress=end\\n"',
      '    exit 0;;',
      'esac',
      '',
    ].join('\n');
    fs.writeFileSync(fake, script, { mode: 0o755 });
    fs.chmodSync(fake, 0o755);
    const progress = [];
    const result = await bExecutor.runBConversion({
      sourcePath: path.join(tmp, 'source.mp4'),
      stagingPath: path.join(tmp, '.stage.partial.mp4'),
      ffmpegPath: fake,
      profileId: PROFILE_ID_GENERIC,
      durationSeconds: 10,
      onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(result, { outcome: 'success' });
    assert.deepEqual(progress.map((event) => event.percent), [25, 99]);
    assert.ok(progress.length <= 2, 'rapid progress records are throttled');
    assert.ok(progress.every((event) => event.percent >= 0 && event.percent <= 99));
    assert.ok(progress.every((event, index) => index === 0 || event.outTimeMs >= progress[index - 1].outTimeMs));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-012 conversion events use parsed duration rather than fixed midpoint progress', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-service-progress-'));
  try {
    const source = path.join(tmp, 'source.mov');
    fs.writeFileSync(source, 's'.repeat(100));
    const events = [];
    const service = new ConversionService({
      outputStore: {
        ensureOutputRoot: () => tmp,
        buildDisplayName: outputStore.buildDisplayName,
        allocateUniqueFinalPath: outputStore.allocateUniqueFinalPath,
        getStagingPath: outputStore.getStagingPath,
        removeStaging: outputStore.removeStaging,
      },
      inspectionAdapter: { inspect: async () => ({ outcome: 'complete', result: {
        classification: 'hlgSupported', canConvert: true, profileId: PROFILE_ID_GENERIC,
        sha256: 'a'.repeat(64), size: 100, duration: 10, displayName: 'source.mov',
      } }) },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake',
        runBConversion: async ({ stagingPath, onProgress }) => {
          fs.writeFileSync(stagingPath, 'encoded');
          onProgress({ outTimeMs: 2500000 });
          await new Promise((resolve) => setTimeout(resolve, 110));
          onProgress({ outTimeMs: 10000000 });
          return { outcome: 'success' };
        },
      },
      verifierRunner: async () => 0,
    });
    service.validateSourcePathForSpawn = () => ({ ok: true, canonical: source });
    const sourceId = service.createSourceToken({ canonicalPath: source, sha256: 'a'.repeat(64), size: 100,
      profileId: PROFILE_ID_GENERIC, ownerWebContentsId: 44, displayName: 'source.mov' });
    const result = await service.startJob({ sourceId, profileId: PROFILE_ID_GENERIC,
      senderWebContents: { id: 44, send: (_channel, event) => events.push(event) } });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const percentages = events.filter((event) => event.phase === 'converting' && 'percent' in event)
      .map((event) => event.percent);
    assert.deepEqual(percentages, [0, 25, 99]);
    assert.ok(percentages.every((percent) => percent >= 0 && percent <= 99));
    assert.ok(percentages.every((percent, index) => index === 0 || percent >= percentages[index - 1]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function makeOutputRecord(file, ownerWebContentsId) {
  const root = fs.realpathSync(path.dirname(file));
  return {
    canonicalPath: fs.realpathSync(file),
    canonicalOutputRoot: root,
    displayName: path.basename(file),
    ownerWebContentsId,
    verified: true,
    fingerprint: fingerprintFile(file),
  };
}

function makeThumbnailChild(bytes, delay = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    child.emit('close', null, 'SIGTERM');
  };
  setTimeout(() => {
    if (child.killed) return;
    child.stdout.emit('data', bytes);
    child.emit('close', 0, null);
  }, delay);
  return child;
}

test('BUG-016 oversized or undecodable thumbnails never become successful data URLs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-thumb-fail-'));
  try {
    const output = path.join(tmp, 'output.mp4');
    const ffmpeg = path.join(tmp, 'ffmpeg');
    fs.writeFileSync(output, 'verified-output');
    fs.writeFileSync(ffmpeg, '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(ffmpeg, 0o755);
    let decodeCalls = 0;
    const oversized = new ConversionService({
      bExecutor: { getFfmpegAbsolute: () => ffmpeg },
      spawn: () => makeThumbnailChild(Buffer.alloc(MAX_THUMB_BYTES + 1)),
      thumbnailDecoder: () => { decodeCalls++; return true; },
    });
    const outputId = crypto.randomUUID();
    oversized.outputs.set(outputId, makeOutputRecord(output, 7));
    assert.deepEqual(
      await oversized.getThumbnailDataUrl({ outputId, senderWebContentsId: 7 }),
      { ok: false, reason: 'thumbnail_failed' },
    );
    assert.equal(decodeCalls, 0, 'truncated bytes must not reach the decoder');

    const undecodable = new ConversionService({
      bExecutor: { getFfmpegAbsolute: () => ffmpeg },
      spawn: () => makeThumbnailChild(Buffer.from('not-an-image')),
      thumbnailDecoder: () => false,
    });
    const undecodableId = crypto.randomUUID();
    undecodable.outputs.set(undecodableId, makeOutputRecord(output, 7));
    assert.deepEqual(
      await undecodable.getThumbnailDataUrl({ outputId: undecodableId, senderWebContentsId: 7 }),
      { ok: false, reason: 'thumbnail_failed' },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-038 thumbnails dedupe, cache within bounds, clean owners, and invalidate fingerprints', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-thumb-cache-'));
  try {
    const output = path.join(tmp, 'output.mp4');
    const ffmpeg = path.join(tmp, 'ffmpeg');
    fs.writeFileSync(output, 'output-one');
    fs.writeFileSync(ffmpeg, '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(ffmpeg, 0o755);
    let spawnCount = 0;
    let thumbnailBytes = Buffer.from('jpeg-one');
    const service = new ConversionService({
      bExecutor: { getFfmpegAbsolute: () => ffmpeg },
      spawn: () => { spawnCount++; return makeThumbnailChild(thumbnailBytes, 5); },
      thumbnailDecoder: () => true,
      thumbnailCacheMaxEntries: 1,
    });
    const outputId = crypto.randomUUID();
    const record = makeOutputRecord(output, 22);
    service.outputs.set(outputId, record);

    const [first, duplicate] = await Promise.all([
      service.getThumbnailDataUrl({ outputId, senderWebContentsId: 22 }),
      service.getThumbnailDataUrl({ outputId, senderWebContentsId: 22 }),
    ]);
    assert.equal(first.ok, true);
    assert.deepEqual(duplicate, first);
    assert.equal(spawnCount, 1, 'concurrent requests share one decoder process');
    assert.deepEqual(await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 22 }), first);
    assert.equal(spawnCount, 1, 'cached request does not spawn');
    assert.equal((await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 99 })).ok, false);
    assert.equal(spawnCount, 1, 'wrong owner cannot consume or populate cache');

    service.cleanupOwner(22);
    assert.equal(service.thumbnailCache.size, 0);
    await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 22 });
    assert.equal(spawnCount, 2, 'owner cleanup removes cached thumbnail');

    fs.writeFileSync(output, 'output-two');
    assert.equal(service.resolveOutputForDrag({ outputId, senderWebContentsId: 22 }).ok, false, 'old fingerprint fails closed');
    assert.equal((await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 22 })).ok, false);
    assert.equal(service.thumbnailCache.size, 0, 'stale fingerprint also evicts cached bytes');
    assert.equal(spawnCount, 2, 'stale fingerprint does not reuse or regenerate blindly');

    record.fingerprint = fingerprintFile(output);
    thumbnailBytes = Buffer.from('jpeg-two');
    const refreshed = await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 22 });
    assert.equal(refreshed.ok, true);
    assert.equal(spawnCount, 3, 'new fingerprint gets fresh thumbnail');
    assert.equal(service.thumbnailCache.size, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('BUG-017 destroyed thumbnail owner terminates its decoder group and clears ownership', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-thumb-owner-'));
  try {
    const output = path.join(tmp, 'output.mp4');
    const ffmpeg = path.join(tmp, 'ffmpeg');
    fs.writeFileSync(output, 'verified-output');
    fs.writeFileSync(ffmpeg, '#!/bin/sh\\n', { mode: 0o755 });
    fs.chmodSync(ffmpeg, 0o755);
    let child;
    const service = new ConversionService({
      bExecutor: { getFfmpegAbsolute: () => ffmpeg },
      spawn: () => { child = makeThumbnailChild(Buffer.from('jpeg'), 500); return child; },
      thumbnailDecoder: () => true,
    });
    const outputId = crypto.randomUUID();
    service.outputs.set(outputId, makeOutputRecord(output, 55));
    const pending = service.getThumbnailDataUrl({ outputId, senderWebContentsId: 55 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.cleanupOwner(55);
    assert.equal(child.killed, true);
    assert.deepEqual(await pending, { ok: false, reason: 'thumbnail_failed' });
    assert.equal(service.thumbnailProcesses.size, 0);
    await service.dispose();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('BUG-038 thumbnail cache evicts oldest entries at configured bound', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase4-thumb-bound-'));
  try {
    const ffmpeg = path.join(tmp, 'ffmpeg');
    fs.writeFileSync(ffmpeg, '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(ffmpeg, 0o755);
    const service = new ConversionService({
      bExecutor: { getFfmpegAbsolute: () => ffmpeg },
      spawn: () => makeThumbnailChild(Buffer.from('jpeg')),
      thumbnailDecoder: () => true,
      thumbnailCacheMaxEntries: 2,
    });
    for (let i = 0; i < 3; i++) {
      const file = path.join(tmp, `output-${i}.mp4`);
      fs.writeFileSync(file, `output-${i}`);
      const outputId = crypto.randomUUID();
      service.outputs.set(outputId, makeOutputRecord(file, 31));
      assert.equal((await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 31 })).ok, true);
    }
    assert.equal(service.thumbnailCache.size, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
