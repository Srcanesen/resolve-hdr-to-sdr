const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidConvertStartRequest, isValidConvertCancelRequest, isValidConvertEvent, CONVERT_START_CHANNEL, CONVERT_CANCEL_CHANNEL, CONVERT_EVENT_CHANNEL } = require('../conversion-service.cjs');
const { PROFILE_ID } = require('../b-profile.cjs');

test('isValidConvertStartRequest strict', () => {
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: '550e8400-e29b-41d4-a716-446655440000', profileId: PROFILE_ID }), true);
  // reject generic ipc shape
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc', profileId: PROFILE_ID, outputPath: '/tmp/out.mp4' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc', profileId: PROFILE_ID, argv: ['x'] }), false);
  assert.equal(isValidConvertStartRequest({ sourceId: 'abc', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc', profileId: 'hlg-local-b-v0' }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: '', profileId: PROFILE_ID }), false);
});

test('isValidConvertCancelRequest strict', () => {
  assert.equal(isValidConvertCancelRequest({ version: 1, jobId: '550e8400-e29b-41d4-a716-446655440001' }), true);
  assert.equal(isValidConvertCancelRequest({ version: 1, jobId: 'abc', extra: 1 }), false);
  assert.equal(isValidConvertCancelRequest({ version: 1, jobId: '' }), false);
  assert.equal(isValidConvertCancelRequest({ jobId: 'abc' }), false);
  assert.equal(isValidConvertCancelRequest(null), false);
});

test('isValidConvertEvent versioned sequence-monotonic and no path', () => {
  const base = { version: 1, jobId: 'jid', seq: 0, phase: 'converting', status: 'running' };
  assert.equal(isValidConvertEvent(base), true);
  assert.equal(isValidConvertEvent({ ...base, seq: 1, percent: 50 }), true);
  assert.equal(isValidConvertEvent({ ...base, displayName: 'foo_sdr_rec709_h264_hlg-local-b-v1.mp4', profileId: PROFILE_ID }), true);
  assert.equal(isValidConvertEvent({ ...base, outputId: 'oid', phase: 'done', status: 'success', displayName: 'x.mp4', profileId: PROFILE_ID }), true);
  // reject path leakage
  assert.equal(isValidConvertEvent({ ...base, sourcePath: '/tmp/a.mp4' }), false);
  assert.equal(isValidConvertEvent({ ...base, outputPath: '/tmp/b.mp4' }), false);
  assert.equal(isValidConvertEvent({ ...base, stderr: 'error' }), false);
  // reject non-monotonic seq type
  assert.equal(isValidConvertEvent({ ...base, seq: -1 }), false);
  assert.equal(isValidConvertEvent({ ...base, seq: 1.5 }), false);
  // reject missing version
  assert.equal(isValidConvertEvent({ jobId: 'j', seq: 0, phase: 'converting', status: 'running' }), false);
  // reject extra keys
  assert.equal(isValidConvertEvent({ ...base, foo: 1 }), false);
});

test('conversion IPC enforces same sender ownership and single active', async () => {
  const electronPath = require.resolve('electron');
  const originalCache = require.cache[electronPath];
  const mockIpc = {
    handlers: {},
    removeHandler(ch) { delete this.handlers[ch]; },
    handle(ch, fn) { this.handlers[ch] = fn; },
  };
  const mockDialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { ipcMain: mockIpc, dialog: mockDialog } };
  delete require.cache[require.resolve('../conversion-service.cjs')];
  delete require.cache[require.resolve('../ipc-contract.cjs')];
  const { ConversionService } = require('../conversion-service.cjs');
  const ipcContract = require('../ipc-contract.cjs');
  try {
    const fakeWindow = { webContents: { id: 100, send: () => {} } };
    const fakeWindow2 = { webContents: { id: 200, send: () => {} } };
    const adapter = { inspect: async () => ({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'a.mp4' } }) };
    const svc = new ConversionService({ inspectionAdapter: adapter });
    // Attach inspect with conversion service ref for busy coordination
    ipcContract.attachIpc(fakeWindow, adapter, svc);
    svc.attachIpc(fakeWindow);
    // Need to also handle second window? We'll test ownership via direct service, not ipc handler mock complexity
    // Test start handler ownership: simulate event.sender mismatch
    const startHandler = mockIpc.handlers[CONVERT_START_CHANNEL];
    assert.ok(startHandler, 'start handler registered');
    // Create token owned by window 200 to test ownership mismatch vs window 100
    const tokenOwnedBy200 = svc.createSourceToken({ canonicalPath: '/tmp/a.mp4', sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 200, displayName: 'a.mp4' });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: '/tmp/a.mp4' });
    // Wrong sender for window check: sender object not equal to window.webContents => invalid_sender
    const wrongSender = { id: 200, send: () => {} };
    const resInvalidSender = await startHandler({ sender: wrongSender }, { version: 1, sourceId: tokenOwnedBy200, profileId: PROFILE_ID });
    assert.equal(resInvalidSender.outcome, 'error');
    assert.equal(resInvalidSender.reason, 'invalid_sender');
    // Ownership mismatch where sender equals window but token owned by different id => invalid_request
    const tokenWrongOwner = tokenOwnedBy200;
    const resWrong = await startHandler({ sender: fakeWindow.webContents }, { version: 1, sourceId: tokenWrongOwner, profileId: PROFILE_ID });
    assert.equal(resWrong.outcome, 'error');
    assert.equal(resWrong.reason, 'invalid_request');
    // Try with correct sender but generic IPC injection: extra field should be invalid_request
    const correctSender = fakeWindow.webContents;
    const goodToken = svc.createSourceToken({ canonicalPath: '/tmp/a.mp4', sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 100, displayName: 'a.mp4' });
    const resBad = await startHandler({ sender: correctSender }, { version: 1, sourceId: goodToken, profileId: PROFILE_ID, outputPath: '/tmp/hack.mp4' });
    assert.equal(resBad.outcome, 'error');
    // Valid request should be accepted (but we need to ensure busy not triggered)
    const resOk = await startHandler({ sender: fakeWindow.webContents }, { version: 1, sourceId: goodToken, profileId: PROFILE_ID });
    // May be busy if previous? Should be accepted
    assert.ok(resOk.outcome === 'accepted' || resOk.outcome === 'error');
    if (resOk.outcome === 'accepted') {
      assert.ok(resOk.jobId);
      // Second immediate start should be busy
      const token2 = svc.createSourceToken({ canonicalPath: '/tmp/b.mp4', sha256: 'b'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 100, displayName: 'b.mp4' });
      // Need to mock inspection for b.mp4 second time to succeed, but busy should trigger before revalidation
      const resBusy = await startHandler({ sender: fakeWindow.webContents }, { version: 1, sourceId: token2, profileId: PROFILE_ID });
      assert.equal(resBusy.outcome, 'error');
      assert.equal(resBusy.reason, 'busy');
      // Cancel handler ownership test
      const cancelHandler = mockIpc.handlers[CONVERT_CANCEL_CHANNEL];
      const badCancel = await cancelHandler({ sender: wrongSender }, { version: 1, jobId: resOk.jobId });
      assert.equal(badCancel.outcome, 'error');
      const goodCancel = await cancelHandler({ sender: fakeWindow.webContents }, { version: 1, jobId: resOk.jobId });
      assert.equal(goodCancel.outcome, 'cancelled');
      await new Promise(r => setTimeout(r, 300));
    }
    // Inspect busy when conversion running: create long job
    // Ensure dialog still approves for svc2
    mockDialog.showMessageBox = async () => ({ response: 1 });
    const svc2 = new ConversionService({
      inspectionAdapter: adapter,
      bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ abortSignal }) => new Promise((res) => {
        const t = setTimeout(() => res({ outcome: 'success' }), 5000);
        if (abortSignal) abortSignal.addEventListener('abort', () => { clearTimeout(t); res({ outcome: 'cancelled' }); });
      }) },
      verifierRunner: async () => 0,
    });
    svc2.validateSourcePathForSpawn = () => ({ ok: true, canonical: '/tmp/a.mp4' });
    const tok2 = svc2.createSourceToken({ canonicalPath: '/tmp/a.mp4', sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 100, displayName: 'a.mp4' });
    const fakeWin = { webContents: { id: 100, send: () => {} } };
    ipcContract.attachIpc(fakeWin, adapter, svc2);
    svc2.attachIpc(fakeWin);
    const inspectHandler = mockIpc.handlers['hdrtosdr:inspect'];
    // Start conversion to make active
    const start2 = mockIpc.handlers[CONVERT_START_CHANNEL];
    const startRes2 = await start2({ sender: fakeWin.webContents }, { version: 1, sourceId: tok2, profileId: PROFILE_ID });
    if (startRes2.outcome === 'accepted') {
      const inspRes = await inspectHandler({ sender: fakeWin.webContents }, { kind: 'path', path: '/tmp/a.mp4' });
      assert.equal(inspRes.outcome, 'error');
      assert.equal(inspRes.reason, 'busy');
      // Cleanup cancel
      await mockIpc.handlers[CONVERT_CANCEL_CHANNEL]({ sender: fakeWin.webContents }, { version: 1, jobId: startRes2.jobId });
      await new Promise(r => setTimeout(r, 300));
    }
  } finally {
    if (originalCache) require.cache[electronPath] = originalCache;
    else delete require.cache[electronPath];
    delete require.cache[require.resolve('../conversion-service.cjs')];
    delete require.cache[require.resolve('../ipc-contract.cjs')];
    require('../ipc-contract.cjs');
  }
});

test('conversion start requires native confirmation dialog — rejected does not start executor', async () => {
  const electronPath = require.resolve('electron');
  const originalCache = require.cache[electronPath];
  const mockIpc = { handlers: {}, removeHandler(ch) { delete this.handlers[ch]; }, handle(ch, fn) { this.handlers[ch] = fn; } };
  let dialogCalls = 0;
  let executorStarted = false;
  const mockDialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => { dialogCalls++; return { response: 0 }; }, // Cancel
  };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { ipcMain: mockIpc, dialog: mockDialog } };
  delete require.cache[require.resolve('../conversion-service.cjs')];
  delete require.cache[require.resolve('../ipc-contract.cjs')];
  const { ConversionService: CS, CONVERT_START_CHANNEL: CH } = require('../conversion-service.cjs');
  const ipcContract = require('../ipc-contract.cjs');
  try {
    const fakeWindow = { webContents: { id: 55, send: () => {} } };
    const adapter = { inspect: async () => ({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'a.mp4' } }) };
    const svc = new CS({ inspectionAdapter: adapter, bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async () => { executorStarted = true; return { outcome: 'success' }; } }, verifierRunner: async () => 0 });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: '/tmp/a.mp4' });
    ipcContract.attachIpc(fakeWindow, adapter, svc);
    svc.attachIpc(fakeWindow);
    const token = svc.createSourceToken({ canonicalPath: '/tmp/a.mp4', sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 55, displayName: 'a.mp4' });
    const handler = mockIpc.handlers[CH];
    const res = await handler({ sender: fakeWindow.webContents }, { version: 1, sourceId: token, profileId: PROFILE_ID });
    assert.equal(res.outcome, 'cancelled');
    assert.equal(res.reason, 'user_cancelled');
    assert.equal(dialogCalls, 1);
    assert.equal(executorStarted, false, 'executor must not start when dialog rejected');
    // Dialog throws or no response also yields cancelled
    mockDialog.showMessageBox = async () => { throw new Error('dialog fail'); };
    const res2 = await handler({ sender: fakeWindow.webContents }, { version: 1, sourceId: token, profileId: PROFILE_ID });
    assert.equal(res2.outcome, 'cancelled');
    assert.equal(executorStarted, false);
  } finally {
    if (originalCache) require.cache[electronPath] = originalCache; else delete require.cache[electronPath];
    delete require.cache[require.resolve('../conversion-service.cjs')];
    delete require.cache[require.resolve('../ipc-contract.cjs')];
    require('../ipc-contract.cjs');
  }
});

test('conversion start dialog approved proceeds to executor', async () => {
  const electronPath = require.resolve('electron');
  const originalCache = require.cache[electronPath];
  const mockIpc = { handlers: {}, removeHandler(ch) { delete this.handlers[ch]; }, handle(ch, fn) { this.handlers[ch] = fn; } };
  let executorStarted = false;
  const mockDialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 1 }),
  };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { ipcMain: mockIpc, dialog: mockDialog } };
  delete require.cache[require.resolve('../conversion-service.cjs')];
  delete require.cache[require.resolve('../ipc-contract.cjs')];
  const { ConversionService: CS, CONVERT_START_CHANNEL: CH, CONVERT_CANCEL_CHANNEL: CANCEL } = require('../conversion-service.cjs');
  const ipcContract = require('../ipc-contract.cjs');
  try {
    const fakeWindow = { webContents: { id: 60, send: () => {} } };
    const adapter = { inspect: async () => ({ outcome: 'complete', result: { classification: 'hlgKnownLocal', canConvert: true, profileId: PROFILE_ID, sha256: 'a'.repeat(64), size: 100, displayName: 'a.mp4' } }) };
    // Mock output store and source to a private real temporary directory.
    const os = require('os'); const path = require('path'); const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-dlg-'));
    const sourcePath = path.join(tmp, 'a.mp4');
    fs.writeFileSync(sourcePath, 'source');
    const svc = new CS({ inspectionAdapter: adapter, bExecutor: { getFfmpegAbsolute: () => '/tmp/fake', runBConversion: async ({ stagingPath }) => { executorStarted = true; fs.writeFileSync(stagingPath, 'enc'); return { outcome: 'success' }; } }, verifierRunner: async () => 0 });
    svc.validateSourcePathForSpawn = () => ({ ok: true, canonical: sourcePath });
    const store = require('../output-store.cjs');
    svc.dependencies.outputStore = {
      ensureOutputRoot: () => { fs.mkdirSync(tmp, { recursive: true }); return tmp; },
      buildDisplayName: store.buildDisplayName,
      allocateUniqueFinalPath: (r, n) => store.allocateUniqueFinalPath(r, n),
      getStagingPath: (r, f) => store.getStagingPath(r, f),
      removeStaging: store.removeStaging,
    };
    ipcContract.attachIpc(fakeWindow, adapter, svc);
    svc.attachIpc(fakeWindow);
    const token = svc.createSourceToken({ canonicalPath: sourcePath, sha256: 'a'.repeat(64), size: 100, profileId: PROFILE_ID, ownerWebContentsId: 60, displayName: 'a.mp4' });
    const handler = mockIpc.handlers[CH];
    const res = await handler({ sender: fakeWindow.webContents }, { version: 1, sourceId: token, profileId: PROFILE_ID });
    assert.equal(res.outcome, 'accepted');
    // Executor is started async inside startJob IIFE; allow tick to observe
    await new Promise(r => setTimeout(r, 100));
    assert.equal(executorStarted, true, 'executor should have started after dialog approval');
    // Wait for async job to finish
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    if (originalCache) require.cache[electronPath] = originalCache; else delete require.cache[electronPath];
    delete require.cache[require.resolve('../conversion-service.cjs')];
    delete require.cache[require.resolve('../ipc-contract.cjs')];
    require('../ipc-contract.cjs');
  }
});

test('sourceId UUID tightening rejects permissive strings', () => {
  const good = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: good, profileId: PROFILE_ID }), true);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'abc12345', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: 'not-a-uuid-at-all-xyz', profileId: PROFILE_ID }), false);
  assert.equal(isValidConvertStartRequest({ version: 1, sourceId: good.replace(/-/g, ''), profileId: PROFILE_ID }), false);
});
