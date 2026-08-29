const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { ConversionService, fingerprintFile } = require('../conversion-service.cjs');
const outputStore = require('../output-store.cjs');

function knownFingerprint(data) {
  return { size: Buffer.byteLength(data), sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

test('phase 3: a verified output is rejected after same-size final-file tampering', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase3-fingerprint-'));
  try {
    const finalPath = path.join(tmp, 'output.mp4');
    const original = 'verified-output';
    fs.writeFileSync(finalPath, original);
    const svc = new ConversionService({ outputStore });
    const outputId = crypto.randomUUID();
    svc.outputs.set(outputId, {
      canonicalPath: fs.realpathSync(finalPath),
      canonicalOutputRoot: fs.realpathSync(tmp),
      displayName: path.basename(finalPath),
      ownerWebContentsId: 41,
      verified: true,
      fingerprint: knownFingerprint(original),
    });
    assert.equal(svc.resolveOutputForDrag({ outputId, senderWebContentsId: 41 }).ok, true);
    fs.writeFileSync(finalPath, 'tampered-output');
    assert.equal(fs.statSync(finalPath).size, Buffer.byteLength(original), 'tamper must keep size constant');
    assert.equal(svc.resolveOutputForDrag({ outputId, senderWebContentsId: 41 }).ok, false);
    assert.deepEqual(fingerprintFile(finalPath), knownFingerprint('tampered-output'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('phase 3: thumbnail generation is rejected for a tampered verified output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase3-thumbnail-'));
  try {
    const file = path.join(tmp, 'output.mp4');
    fs.writeFileSync(file, 'verified-output');
    const service = new ConversionService({ outputStore, bExecutor: {
      getFfmpegAbsolute: () => { throw new Error('thumbnail must not start'); },
    } });
    const outputId = crypto.randomUUID();
    service.outputs.set(outputId, {
      canonicalPath: fs.realpathSync(file),
      canonicalOutputRoot: fs.realpathSync(tmp),
      displayName: path.basename(file),
      ownerWebContentsId: 12,
      verified: true,
      fingerprint: knownFingerprint('verified-output'),
    });
    fs.writeFileSync(file, 'tampered-output');
    const result = await service.getThumbnailDataUrl({ outputId, senderWebContentsId: 12 });
    assert.deepEqual(result, { ok: false, reason: 'invalid_request' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('phase 3: a verifier-pass staging swap never receives an output identity', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase3-verify-swap-'));
  try {
    const store = {
      ensureOutputRoot: () => tmp,
      buildDisplayName: outputStore.buildDisplayName,
      allocateUniqueFinalPath: outputStore.allocateUniqueFinalPath,
      getStagingPath: outputStore.getStagingPath,
      removeStaging: outputStore.removeStaging,
      isSafeOutputFile: outputStore.isSafeOutputFile,
      scavengeStagingFiles: outputStore.scavengeStagingFiles,
    };
    const source = path.join(tmp, 'source.mov');
    fs.writeFileSync(source, 's'.repeat(100));
    const service = new ConversionService({
      outputStore: store,
      inspectionAdapter: { inspect: async () => ({ outcome: 'complete', result: {
        classification: 'hlgKnownLocal', canConvert: true, profileId: 'hlg-local-b-v1',
        sha256: 'a'.repeat(64), size: 100, displayName: 'source.mov',
      } }) },
      bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ stagingPath }) => {
        fs.writeFileSync(stagingPath, 'approved');
        return { outcome: 'success' };
      } },
      verifierRunner: async (_source, stagingPath) => {
        fs.writeFileSync(stagingPath, 'tampered');
        return 0;
      },
    });
    service.validateSourcePathForSpawn = () => ({ ok: true, canonical: source });
    const sourceId = service.createSourceToken({ canonicalPath: source, sha256: 'a'.repeat(64), size: 100,
      profileId: 'hlg-local-b-v1', ownerWebContentsId: 9, displayName: 'source.mov' });
    const events = [];
    const result = await service.startJob({ sourceId, profileId: 'hlg-local-b-v1', senderWebContents: { id: 9, send: (_channel, event) => events.push(event) } });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(service.outputs.size, 0);
    assert.ok(events.some((event) => event.phase === 'error' && event.reason === 'verification_failed'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('phase 3: staging scavenger only removes exact private staging files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase3-scavenge-'));
  try {
    const stale = path.join(tmp, '.0123456789ab.partial.mp4');
    const keep = path.join(tmp, 'not-a-staging.partial.mp4');
    const link = path.join(tmp, '.abcdefabcdef.partial.mp4');
    fs.writeFileSync(stale, 'partial');
    fs.writeFileSync(keep, 'keep');
    fs.symlinkSync(keep, link);
    const result = outputStore.scavengeStagingFiles(tmp);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(keep), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('phase 3: staging cleanup reports unlink failures and scavenges safely', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase3-cleanup-'));
  const staging = path.join(tmp, '.0123456789ab.partial.mp4');
  const originalUnlink = fs.unlinkSync;
  const originalWarn = console.warn;
  const warnings = [];
  let firstAttempt = true;
  try {
    fs.writeFileSync(staging, 'partial');
    fs.unlinkSync = (candidate) => {
      if (candidate === staging && firstAttempt) {
        firstAttempt = false;
        const error = new Error('busy');
        error.code = 'EBUSY';
        throw error;
      }
      return originalUnlink(candidate);
    };
    console.warn = (message) => warnings.push(message);
    const result = outputStore.removeStaging(staging, tmp);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(staging), false, 'safe scavenger should remove the failed private staging file');
    assert.deepEqual(warnings, ['[HdrToSdr] staging cleanup warning']);
  } finally {
    fs.unlinkSync = originalUnlink;
    console.warn = originalWarn;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('phase 3: verifier contract is bounded, dimensional, audio-aware, and semantic for privacy', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../scripts/verify-spike.sh'), 'utf8');
  assert.match(script, /width[ ,].*height|width,height/);
  assert.match(script, /audio stream|audio.*count|codec_name.*aac/i);
  assert.match(script, /%\+#(\$\{)?HDR_SCAN_FRAMES/);
  assert.match(script, /tags/);
  assert.doesNotMatch(script, /strings\s+-a/);
  assert.match(script, /metadata tags|semantic/i);
});
