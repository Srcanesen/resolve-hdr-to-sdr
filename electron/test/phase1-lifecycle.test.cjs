const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConversionService } = require('../conversion-service.cjs');
const bExecutor = require('../b-executor.cjs');
const { PROFILE_ID } = require('../b-profile.cjs');
const outputStore = require('../output-store.cjs');

function makeWindow(id) {
  return { id, send: (_channel, event) => eventsByWindow.get(id).push(event) };
}

const eventsByWindow = new Map();

function makeStore(root) {
  return {
    ensureOutputRoot: () => { fs.mkdirSync(root, { recursive: true }); return root; },
    buildDisplayName: outputStore.buildDisplayName,
    allocateUniqueFinalPath: outputStore.allocateUniqueFinalPath,
    getStagingPath: outputStore.getStagingPath,
    removeStaging: outputStore.removeStaging,
  };
}

function makeService(root, overrides = {}) {
  const source = path.join(root, 'source.mov');
  fs.writeFileSync(source, 'source');
  const service = new ConversionService({
    outputStore: makeStore(root),
    ...overrides,
  });
  service.validateSourcePathForSpawn = () => ({ ok: true, canonical: source });
  service.revalidateSourceToken = async () => ({
    ok: true,
    canonical: source,
    inspectedResult: {
      classification: 'hlgKnownLocal',
      canConvert: true,
      profileId: PROFILE_ID,
      sha256: 'a'.repeat(64),
      size: 6,
      displayName: 'source.mov',
    },
  });
  return { service, source };
}

function seed(service, owner = 1) {
  return service.createSourceToken({
    canonicalPath: '/tmp/source.mov',
    sha256: 'a'.repeat(64),
    size: 6,
    profileId: PROFILE_ID,
    ownerWebContentsId: owner,
    displayName: 'source.mov',
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('phase 1: converter watchdog aborts stalled child with a safe result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-converter-watchdog-'));
  const fake = path.join(root, 'fake-ffmpeg.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args.includes('filter=libplacebo')) console.log('Filter libplacebo\\ntonemapping\\ngamut_mode\\nperceptual\\nspline\\ntonemapping_param');
else if (args.includes('filter=sidedata')) console.log('Filter sidedata\\nMASTERING_DISPLAY_METADATA\\nCONTENT_LIGHT_LEVEL\\nDYNAMIC_HDR_PLUS\\nDOVI_RPU_BUFFER\\nDOVI_METADATA\\nDYNAMIC_HDR_VIVID\\nAMBIENT_VIEWING_ENVIRONMENT');
else if (args.includes('filter=eq')) console.log('Filter eq\\ngamma');
else if (args.includes('encoder=libx264')) console.log('Encoder libx264');
else if (args.includes('encoder=aac')) console.log('Encoder aac');
else setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  try {
    const result = await bExecutor.runBConversion({
      sourcePath: path.join(root, 'source.mov'),
      stagingPath: path.join(root, 'output.partial.mp4'),
      ffmpegPath: fake,
      timeoutMs: 30,
      stallTimeoutMs: 1000,
    });
    assert.deepEqual(result, { outcome: 'error', reason: 'conversion_timeout' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: conversion reserves synchronously before revalidation await', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-reserve-'));
  try {
    const { service } = makeService(root);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    service.revalidateSourceToken = async () => pending;
    const firstToken = seed(service, 1);
    const secondToken = seed(service, 2);
    const first = service.startJob({ sourceId: firstToken, profileId: PROFILE_ID, senderWebContents: makeWindow(1) });
    const secondPromise = service.startJob({ sourceId: secondToken, profileId: PROFILE_ID, senderWebContents: makeWindow(2) });
    release({ ok: false, reason: 'invalid_request' });
    assert.deepEqual(await first, { ok: false, reason: 'invalid_request' });
    const second = await secondPromise;
    assert.deepEqual(second, { ok: false, reason: 'busy' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: accepted start responds before queued or terminal events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-order-'));
  try {
    const { service } = makeService(root, {
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ stagingPath }) => {
          fs.writeFileSync(stagingPath, 'encoded');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async () => 0,
    });
    const win = makeWindow(3);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(response.ok, true);
    assert.deepEqual(eventsByWindow.get(win.id), []);
    await wait(100);
    assert.ok(eventsByWindow.get(win.id).some((event) => event.phase === 'queued'));
    assert.equal(eventsByWindow.get(win.id).filter((event) => ['done', 'error', 'cancelled'].includes(event.phase)).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: verifier aborts on timeout and terminalizes exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-verifier-'));
  try {
    let verifierSignal;
    const { service } = makeService(root, {
      operationPolicy: { verifierTimeoutMs: 30, verifierStallTimeoutMs: 30 },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ stagingPath }) => {
          fs.writeFileSync(stagingPath, 'encoded');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async (_source, _staging, _verifier, _profile, options) => {
        verifierSignal = options.abortSignal;
        return new Promise(() => {});
      },
    });
    const win = makeWindow(4);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(response.ok, true);
    await wait(150);
    assert.equal(verifierSignal.aborted, true);
    const terminal = eventsByWindow.get(win.id).filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].phase, 'error');
    assert.equal(service.jobs.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: early executor failure is emitted after accepted response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-early-failure-'));
  try {
    const { service } = makeService(root, {
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async () => ({ outcome: 'error', reason: 'conversion_failed' }),
      },
    });
    const win = makeWindow(8);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(response.ok, true);
    assert.deepEqual(eventsByWindow.get(win.id), []);
    await wait(50);
    const terminal = eventsByWindow.get(win.id).filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].reason, 'conversion_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: cancel during verifier aborts work and emits one cancelled terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-cancel-verifier-'));
  try {
    let verifierSignal;
    const { service } = makeService(root, {
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ stagingPath }) => {
          fs.writeFileSync(stagingPath, 'encoded');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async (_source, _staging, _verifier, _profile, options) => {
        verifierSignal = options.abortSignal;
        return new Promise(() => {});
      },
    });
    const win = makeWindow(9);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    await wait(30);
    assert.ok(verifierSignal);
    assert.deepEqual(await service.cancelJob({ jobId: response.jobId, senderWebContents: win }), { ok: true });
    assert.deepEqual(await service.cancelJob({ jobId: response.jobId, senderWebContents: win }), { ok: true });
    await wait(30);
    assert.equal(verifierSignal.aborted, true);
    const terminals = eventsByWindow.get(win.id).filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].phase, 'cancelled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: cancel queued after verifier completion cannot commit output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-cancel-commit-'));
  try {
    let jobId;
    let win;
    const { service } = makeService(root, {
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ stagingPath }) => {
          fs.writeFileSync(stagingPath, 'encoded');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async () => new Promise((resolve) => {
        setImmediate(() => {
          // This callback runs after verifier success but before the commit turn.
          setImmediate(() => { void service.cancelJob({ jobId, senderWebContents: win }); });
          resolve(0);
        });
      }),
    });
    win = makeWindow(10);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    jobId = response.jobId;
    await wait(100);
    const terminals = eventsByWindow.get(win.id).filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].phase, 'cancelled');
    assert.equal(service.outputs.size, 0);
    assert.equal(fs.readdirSync(root).filter((name) => name.includes('_sdr_rec709')).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: verifier timeout racing completion still has one terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-verifier-race-'));
  try {
    const { service } = makeService(root, {
      operationPolicy: { verifierTimeoutMs: 25, verifierStallTimeoutMs: 100 },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ stagingPath }) => {
          fs.writeFileSync(stagingPath, 'encoded');
          return { outcome: 'success' };
        },
      },
      verifierRunner: async () => new Promise((resolve) => setTimeout(() => resolve(1), 60)),
    });
    const win = makeWindow(11);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(response.ok, true);
    await wait(100);
    const terminals = eventsByWindow.get(win.id).filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].reason, 'verification_timeout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: allocation failure releases reservation and leaves no job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-allocation-'));
  try {
    const { service } = makeService(root, {
      outputStore: {
        ...makeStore(root),
        allocateUniqueFinalPath: () => { throw new Error('allocation failed'); },
      },
    });
    const win = makeWindow(5);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    assert.deepEqual(response, { ok: false, reason: 'conversion_failed' });
    assert.equal(service.jobs.size, 0);
    assert.equal(service.hasActiveOperation(), false);
    assert.deepEqual(eventsByWindow.get(win.id), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('phase 1: inspection reservation shares the conversion heavy-operation policy', async () => {
  const service = new ConversionService();
  const reservation = service.reserveOperation('inspection', 7);
  assert.ok(reservation);
  const win = makeWindow(7);
  const token = seed(service, 7);
  const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
  assert.deepEqual(response, { ok: false, reason: 'busy' });
  service.releaseOperation(reservation);
  assert.equal(service.hasActiveOperation(), false);
});

test('phase 1: dispose kills tracked process and aborts active job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-phase1-dispose-'));
  try {
    const killed = [];
    const { service } = makeService(root, {
      operationPolicy: { terminationGraceMs: 10 },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ abortSignal }) => new Promise((resolve) => {
          abortSignal.addEventListener('abort', () => resolve({ outcome: 'cancelled' }), { once: true });
        }),
      },
    });
    const fakeProcess = { kill: (signal) => {
      killed.push(signal);
      if (signal === 'SIGTERM') fakeProcess.exitCode = 0;
    } };
    const win = makeWindow(6);
    eventsByWindow.set(win.id, []);
    const token = seed(service, win.id);
    const response = await service.startJob({ sourceId: token, profileId: PROFILE_ID, senderWebContents: win });
    assert.equal(response.ok, true);
    service.trackProcess(fakeProcess);
    await service.dispose();
    assert.deepEqual(killed, ['SIGTERM']);
    assert.equal(service.hasActiveOperation(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
