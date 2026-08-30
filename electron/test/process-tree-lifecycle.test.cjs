const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  HeavyOperationCoordinator,
  markProcessGroupOwned,
} = require('../heavy-operation-policy.cjs');
const { ConversionService } = require('../conversion-service.cjs');
const bExecutor = require('../b-executor.cjs');
const { PROFILE_ID_GENERIC } = require('../b-profile.cjs');
const outputStore = require('../output-store.cjs');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(20);
  }
  assert.fail('condition did not become true before deadline');
}

async function waitForDead(pids, timeoutMs = 2000) {
  await waitFor(() => pids.every((pid) => !pidAlive(pid)), timeoutMs);
}

function writeTreeFixture(root) {
  const fixture = path.join(root, 'tree-fixture.js');
  fs.writeFileSync(fixture, `
const fs = require('fs');
const { spawn } = require('child_process');
const mode = process.argv[2];
const marker = process.argv[3];
if (mode === 'grandchild') {
  fs.appendFileSync(marker, 'grandchild-ready\\n');
  if (process.argv[4] === 'ignore' || process.argv[4] === 'parent-term-child-ignore') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => { fs.appendFileSync(marker, 'grandchild-term\\n'); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  const grandchild = spawn(process.execPath, [__filename, 'grandchild', marker, mode], { stdio: ['ignore', 'ignore', 'ignore'] });
  fs.appendFileSync(marker, 'parent-ready\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n'), 50);
  if (mode === 'ignore') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => { fs.appendFileSync(marker, 'parent-term\\n'); process.exit(0); });
  setInterval(() => {}, 1000);
}
`, 'utf8');
  return fixture;
}

async function spawnFixture(root, mode) {
  const marker = path.join(root, `${mode}.marker`);
  const fixture = writeTreeFixture(root);
  const child = spawn(process.execPath, [fixture, mode, marker], {
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let line = '';
  child.stdout.setEncoding('utf8');
  const grandchildPid = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      line += chunk;
      const newline = line.indexOf('\n');
      if (newline !== -1) {
        try { resolve(JSON.parse(line.slice(0, newline)).grandchildPid); } catch (error) { reject(error); }
      }
    });
    child.once('error', reject);
  });
  return { child, grandchildPid, marker };
}

function makeOutputStore(root) {
  return {
    ensureOutputRoot: () => { fs.mkdirSync(root, { recursive: true }); return root; },
    buildDisplayName: outputStore.buildDisplayName,
    allocateUniqueFinalPath: outputStore.allocateUniqueFinalPath,
    getStagingPath: outputStore.getStagingPath,
    removeStaging: outputStore.removeStaging,
  };
}

function writeBlockingFfmpeg(root, treeFixture, mode, marker) {
  const binary = path.join(root, `fake-ffmpeg-${mode}.js`);
  const pidFile = `${marker}.pids`;
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const marker = ${JSON.stringify(marker)};
const pidFile = ${JSON.stringify(pidFile)};
if (args.some((arg) => arg.includes('filter=libplacebo'))) {
  console.log('Filter libplacebo\\ntonemapping\\ngamut_mode\\nperceptual\\nbt.2390');
  process.exit(0);
}
if (args.some((arg) => arg.includes('filter=sidedata'))) {
  console.log('Filter sidedata\\nMASTERING_DISPLAY_METADATA\\nCONTENT_LIGHT_LEVEL\\nDYNAMIC_HDR_PLUS\\nDOVI_RPU_BUFFER\\nDOVI_METADATA\\nDYNAMIC_HDR_VIVID\\nAMBIENT_VIEWING_ENVIRONMENT');
  process.exit(0);
}
if (args.some((arg) => arg.includes('encoder=libx264'))) { console.log('Encoder libx264'); process.exit(0); }
if (args.some((arg) => arg.includes('encoder=aac'))) { console.log('Encoder aac'); process.exit(0); }
const worker = spawn(process.execPath, [${JSON.stringify(treeFixture)}, 'grandchild', marker, ${JSON.stringify(mode)}], { stdio: ['ignore', 'ignore', 'ignore'] });
fs.writeFileSync(pidFile, String(process.pid) + '\\n' + String(worker.pid) + '\\n');
if (${JSON.stringify(mode)} === 'ignore') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => { fs.appendFileSync(marker, 'converter-term\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`, 'utf8');
  fs.chmodSync(binary, 0o755);
  return { binary, pidFile };
}

function makeConversionService(root, options = {}) {
  const source = path.join(root, 'source.mov');
  fs.writeFileSync(source, 'source-data');
  const sha256 = require('crypto').createHash('sha256').update('source-data').digest('hex');
  const service = new ConversionService({
    ...options,
    outputStore: makeOutputStore(root),
    operationPolicy: {
      conversionTimeoutMs: 2000,
      conversionStallTimeoutMs: 2000,
      terminationGraceMs: 60,
      ...(options.operationPolicy || {}),
    },
    inspectionAdapter: options.inspectionAdapter || { inspect: async () => ({ outcome: 'complete', result: {
      classification: 'hlgSupported', canConvert: true, profileId: PROFILE_ID_GENERIC,
      sha256, size: 11, duration: 1, displayName: 'source.mov',
    } }) },
  });
  service.validateSourcePathForSpawn = () => ({ ok: true, canonical: source });
  const sourceId = service.createSourceToken({
    canonicalPath: source,
    sha256,
    size: 11,
    profileId: PROFILE_ID_GENERIC,
    ownerWebContentsId: 77,
    displayName: 'source.mov',
  });
  return { service, source, sourceId };
}

test('BUG-017 coordinator fails closed for PID 0, current PID, and negative PID', async () => {
  for (const pid of [0, process.pid, -7]) {
    const signals = [];
    const child = { pid, kill: (signal) => signals.push(signal) };
    const coordinator = new HeavyOperationCoordinator({ terminationGraceMs: 5 });
    markProcessGroupOwned(child);
    coordinator.track(child);
    await coordinator.dispose();
    assert.deepEqual(signals, [], `unsafe pid ${pid} must not be signalled`);
    assert.equal(coordinator.records.size, 0);
    assert.equal(coordinator.terminationTimers.size, 0);
  }
});

test('BUG-017 coordinator terminates an owned tree once with TERM and bounded KILL escalation', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-tree-grace-'));
  try {
    const { child, grandchildPid, marker } = await spawnFixture(root, 'graceful');
    const coordinator = new HeavyOperationCoordinator({ terminationGraceMs: 100 });
    markProcessGroupOwned(child);
    coordinator.track(child);
    await wait(50);
    const groupSignals = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0) groupSignals.push(signal);
      return originalKill(pid, signal);
    };
    try {
      coordinator.kill(child);
      coordinator.kill(child);
      await coordinator.dispose();
    } finally {
      process.kill = originalKill;
    }
    await waitForDead([child.pid, grandchildPid]);
    assert.deepEqual(groupSignals, ['SIGTERM'], 'graceful group must not receive KILL');
    const marks = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.ok(marks.includes('parent-term'), 'parent received TERM');
    assert.ok(marks.includes('grandchild-term'), 'grandchild received TERM');
    assert.equal(coordinator.processes.size, 0);
    assert.equal(coordinator.terminationTimers.size, 0);
    assert.equal(coordinator.records.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-017 TERM-ignoring owned tree escalates to group KILL and leaves no descendants', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-tree-kill-'));
  try {
    const { child, grandchildPid } = await spawnFixture(root, 'ignore');
    const coordinator = new HeavyOperationCoordinator({ terminationGraceMs: 60 });
    markProcessGroupOwned(child);
    coordinator.track(child);
    const groupSignals = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0) groupSignals.push(signal);
      return originalKill(pid, signal);
    };
    try { await coordinator.dispose(); } finally { process.kill = originalKill; }
    await waitForDead([child.pid, grandchildPid]);
    assert.deepEqual(groupSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(coordinator.processes.size, 0);
    assert.equal(coordinator.terminationTimers.size, 0);
    assert.equal(coordinator.records.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-017 cancel uses coordinator group cleanup and leaves no converter descendants with one terminal event', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-tree-cancel-'));
  try {
    const treeFixture = writeTreeFixture(root);
    const marker = path.join(root, 'cancel.marker');
    const fake = writeBlockingFfmpeg(root, treeFixture, 'ignore', marker);
    const { service, sourceId } = makeConversionService(root, {
      bExecutor: {
        ...bExecutor,
        getFfmpegAbsolute: () => fake.binary,
      },
    });
    const events = [];
    const window = { id: 77, send: (_channel, event) => events.push(event) };
    const started = await service.startJob({ sourceId, profileId: PROFILE_ID_GENERIC, senderWebContents: window });
    assert.equal(started.ok, true);
    await waitFor(() => fs.existsSync(fake.pidFile));
    const pids = fs.readFileSync(fake.pidFile, 'utf8').trim().split('\n').map(Number);
    await service.cancelJob({ jobId: started.jobId, senderWebContents: window });
    await waitForDead(pids);
    await service.dispose();
    const terminals = events.filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].phase, 'cancelled');
    assert.equal(service.operationCoordinator.terminationTimers.size, 0);
    assert.equal(service.operationCoordinator.records.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-017 verifier timeout cleans its real process tree and leaves one terminal event', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-tree-verifier-'));
  try {
    const treeFixture = writeTreeFixture(root);
    const marker = path.join(root, 'verifier.marker');
    const pidFile = `${marker}.pids`;
    const { service, sourceId } = makeConversionService(root, {
      operationPolicy: { verifierTimeoutMs: 80, verifierStallTimeoutMs: 1000 },
      bExecutor: {
        getFfmpegAbsolute: () => '/tmp/fake-ffmpeg',
        runBConversion: async ({ stagingPath }) => { fs.writeFileSync(stagingPath, 'encoded'); return { outcome: 'success' }; },
      },
      verifierRunner: async (_source, _staging, _verifier, _profile, options) => new Promise((resolve) => {
        const child = spawn(process.execPath, [treeFixture, 'ignore', marker], {
          detached: true,
          shell: false,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        markProcessGroupOwned(child);
        fs.writeFileSync(pidFile, String(child.pid) + '\n');
        options.trackProcess(child);
        const onAbort = () => { try { options.killProcess(child); } catch {} };
        options.abortSignal.addEventListener('abort', onAbort, { once: true });
        child.once('close', () => {
          options.abortSignal.removeEventListener('abort', onAbort);
          options.untrackProcess(child);
          resolve(1);
        });
      }),
    });
    const events = [];
    const window = { id: 77, send: (_channel, event) => events.push(event) };
    const started = await service.startJob({ sourceId, profileId: PROFILE_ID_GENERIC, senderWebContents: window });
    assert.equal(started.ok, true);
    await waitFor(() => fs.existsSync(pidFile));
    const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    await waitFor(() => events.some((event) => event.phase === 'error'));
    await waitForDead(pids);
    await service.dispose();
    const terminals = events.filter((event) => ['done', 'error', 'cancelled'].includes(event.phase));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].reason, 'verification_timeout');
    assert.equal(service.operationCoordinator.terminationTimers.size, 0);
    assert.equal(service.operationCoordinator.records.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BUG-017 app-quit runtime disposal is idempotent and cleans a tracked tree and timers', { timeout: 5000, skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-tree-quit-'));
  try {
    const { child, grandchildPid } = await spawnFixture(root, 'ignore');
    const service = new ConversionService({ operationPolicy: { terminationGraceMs: 60 } });
    markProcessGroupOwned(child);
    service.trackProcess(child, null);
    const first = service.dispose();
    const second = service.dispose();
    assert.strictEqual(first, second, 'runtime disposal is idempotent');
    await first;
    await waitForDead([child.pid, grandchildPid]);
    assert.equal(service.operationCoordinator.terminationTimers.size, 0);
    assert.equal(service.operationCoordinator.records.size, 0);
    assert.equal(service.activeProcesses.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
