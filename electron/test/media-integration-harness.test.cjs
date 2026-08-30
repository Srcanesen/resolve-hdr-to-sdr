'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const harness = require('../../scripts/media-integration.cjs');

test('normal check remains offline and does not invoke the live harness', () => {
  const packageJson = require('../../package.json');
  assert.equal(packageJson.scripts.check.includes('test:media:integration'), false);
  assert.equal(packageJson.scripts['test:media:integration'], 'node scripts/media-integration.cjs');
});

test('media harness generation recipes are argv-only and cover the required metadata', () => {
  const commands = harness.buildGenerationCommands('/private/tmp/hdrtosdr-owned');
  assert.ok(Array.isArray(commands));
  assert.ok(commands.some((command) => command.name === 'generic-hlg'));
  assert.ok(commands.some((command) => command.name === 'static-pq'));
  assert.ok(commands.some((command) => command.name === 'structural-mux'));
  assert.ok(commands.some((command) => command.name === 'rotation'));
  assert.ok(commands.some((command) => command.name === 'vfr'));

  for (const command of commands) {
    assert.equal(typeof command.file, 'string');
    assert.ok(path.isAbsolute(command.file));
    assert.ok(Array.isArray(command.args));
    assert.equal(command.shell, false);
    assert.equal(command.args.at(-1), command.output);
    assert.equal(command.args.includes('-n'), true, `${command.name} must never overwrite`);
    assert.equal(command.args.some((arg) => typeof arg !== 'string'), false);
  }

  const generic = commands.find((command) => command.name === 'generic-hlg');
  assert.ok(generic.args.includes('libx265'));
  assert.ok(generic.args.includes('yuv420p10le'));
  assert.ok(generic.args.some((arg) => arg.includes('arib-std-b67')));
  assert.ok(generic.args.some((arg) => arg.includes('transfer_characteristics=18')));

  const pq = commands.find((command) => command.name === 'static-pq');
  assert.ok(pq.args.some((arg) => arg.includes('smpte2084')));
  assert.ok(pq.args.some((arg) => arg.includes('master-display=')));
  assert.ok(pq.args.some((arg) => arg.includes('max-cll=1000,400')));
  assert.ok(pq.args.some((arg) => arg.includes('transfer_characteristics=16')));
});

test('structural probe parsing selects the first real video and its frame evidence', () => {
  const probe = {
    streams: [
      { index: 0, codec_type: 'audio' },
      { index: 1, codec_type: 'video', disposition: { attached_pic: 0 }, width: 64, height: 36 },
      { index: 2, codec_type: 'video', disposition: { attached_pic: 1 }, width: 16, height: 16 },
    ],
    frames: [
      { media_type: 'video', stream_index: 2 },
      { media_type: 'video', stream_index: 1 },
      { media_type: 'video', stream_index: 2 },
    ],
  };
  const result = harness.inspectStructuralProbe(probe);
  assert.equal(result.ok, true);
  assert.equal(result.selectedVideoIndex, 1);
  assert.equal(result.frameEvidence, 'selected_real_video');
  assert.deepEqual(result.streamOrder, ['audio', 'real-video', 'attached-video']);
  assert.equal(result.presentationDimensions, '64x36');
  assert.equal(result.audioPolicy, 'audio_present');

  const invalid = harness.inspectStructuralProbe({ streams: [] });
  assert.deepEqual(invalid, { ok: false, reason: 'structural_probe_invalid' });
});

test('probe and inspection result parsing is sanitized and fail-closed', () => {
  assert.deepEqual(harness.parseProbeJson('{"streams":[]}'), { ok: true, data: { streams: [] } });
  assert.deepEqual(harness.parseProbeJson('{"filename":"/Users/.../file.mp4"}'), {
    ok: false,
    reason: 'probe_shape_invalid',
  });
  assert.deepEqual(harness.parseProbeJson('not json /Users/.../file.mp4'), {
    ok: false,
    reason: 'probe_json_invalid',
  });

  assert.deepEqual(harness.checkInspectionResult({
    outcome: 'complete',
    result: { classification: 'hlgSupported', profileId: 'hlg-rec709-v1', canConvert: true },
  }, 'hlgSupported', 'hlg-rec709-v1'), { ok: true });
  assert.deepEqual(harness.checkInspectionResult({
    outcome: 'complete',
    result: { classification: 'pqSupported', profileId: 'pq-rec709-v1', canConvert: true },
  }, 'hlgSupported', 'hlg-rec709-v1'), { ok: false, reason: 'inspection_contract_mismatch' });
  assert.deepEqual(harness.dynamicFixtureStatus(null), { status: 'not_run', reason: 'tool_unavailable' });
});

test('runCommand uses shell:false, argv arrays, and bounded mock output', async () => {
  let observed;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  const resultPromise = harness.runCommand('/private/tmp/ffmpeg', ['-version'], {
    spawnImpl: (file, args, options) => {
      observed = { file, args, options };
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('safe stdout'));
        child.stderr.emit('data', Buffer.from('safe stderr'));
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'safe stdout');
  assert.equal(result.stderr, 'safe stderr');
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.detached, true);
  assert.deepEqual(observed.args, ['-version']);
});

test('required tool validation accepts safe canonical symlink to regular executable', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-media-integration-validator-'));
  try {
    const target = path.join(root, 'target');
    const link = path.join(root, 'tool');
    fs.writeFileSync(target, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    fs.symlinkSync(target, link);
    const result = harness.validateExecutable(link, 'ffmpeg');
    assert.equal(result.ok, true);
    assert.equal(typeof result.resolvedPath, 'string');
    assert.ok(path.isAbsolute(result.resolvedPath));
    assert.equal(result.reason, undefined);
    const stat = fs.lstatSync(result.resolvedPath);
    assert.equal(stat.isFile(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('required tool validation rejects broken symlink', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-media-integration-validator-'));
  try {
    const missing = path.join(root, 'missing-target');
    const link = path.join(root, 'tool');
    fs.symlinkSync(missing, link);
    const result = harness.validateExecutable(link, 'ffmpeg');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ffmpeg_not_regular');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('required tool validation rejects symlink to non-regular (directory)', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-media-integration-validator-'));
  try {
    const dir = path.join(root, 'dir');
    fs.mkdirSync(dir);
    const link = path.join(root, 'tool');
    fs.symlinkSync(dir, link);
    const result = harness.validateExecutable(link, 'ffprobe');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ffprobe_not_regular');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('summary reports portable:false and resolved_external_tool:true without path leakage', () => {
  const summary = harness.makeSummary({
    status: 'pass',
    reason: 'required_media_scenarios_pass',
    scenarios: {
      genericHlg: { status: 'pass', reason: 'conversion_and_verification_pass' },
    },
    dynamic: {
      dolbyVision: harness.dynamicFixtureStatus(null),
      hdr10Plus: harness.dynamicFixtureStatus(null),
    },
    cleanup: { status: 'pass', residueCount: 0 },
  });
  assert.equal(summary.portable, false);
  assert.equal(summary.resolved_external_tool, true);
  const text = JSON.stringify(summary);
  assert.equal(text.includes('/opt/homebrew'), false);
  assert.equal(text.includes('/private'), false);
  assert.equal(text.includes('/tmp'), false);
});

test('cleanupOwnedTemp removes only the harness-owned temporary directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-media-integration-'));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'private.partial'), 'owned', { mode: 0o600 });
  assert.deepEqual(harness.cleanupOwnedTemp(root), { ok: true });
  assert.equal(fs.existsSync(root), false);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'not-hdrtosdr-owned-'));
  try {
    assert.deepEqual(harness.cleanupOwnedTemp(outside), { ok: false, reason: 'cleanup_refused' });
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('summary sanitizer never exposes paths or dynamic PASS claims', () => {
  const summary = harness.makeSummary({
    status: 'blocked',
    reason: 'repo_tool_not_regular',
    scenarios: {},
    dynamic: {
      dolbyVision: harness.dynamicFixtureStatus(null),
      hdr10Plus: harness.dynamicFixtureStatus(null),
    },
    cleanup: { status: 'pass', residueCount: 0 },
  });
  const text = JSON.stringify(summary);
  assert.equal(text.includes('/private/'), false);
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.portable, false);
  assert.equal(summary.resolved_external_tool, true);
  assert.equal(summary.dynamic.dolbyVision.status, 'not_run');
  assert.equal(summary.dynamic.dolbyVision.reason, 'tool_unavailable');
});
