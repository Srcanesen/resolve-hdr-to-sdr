'use strict';

/*
 * Opt-in real-media harness.  This file deliberately does not share the normal
 * test/check entry point: it creates only synthetic media below a private,
 * owned temporary directory and never writes Sample/ or Output/.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  HeavyOperationCoordinator,
  markProcessGroupOwned,
} = require('../electron/heavy-operation-policy.cjs');
const inspectionAdapter = require('../electron/inspection-adapter.cjs');
const bExecutor = require('../electron/b-executor.cjs');
const {
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
} = require('../electron/b-profile.cjs');

const TEMP_PREFIX = 'hdrtosdr-media-integration-';
const MAX_COMMAND_STDOUT = 128 * 1024;
const MAX_COMMAND_STDERR = 64 * 1024;
const GENERATION_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 20_000;
const VERIFIER_TIMEOUT_MS = 90_000;
const TERMINATION_GRACE_MS = 1_000;
const REQUIRED_SCENARIOS = [
  'genericHlg',
  'staticPq',
  'attachedPictureAudioFirst',
  'rotation',
  'vfr',
];
const DYNAMIC_SCENARIOS = ['dolbyVision', 'hdr10Plus'];
const SAFE_REASON_RE = /^[A-Za-z0-9_.:-]+$/;

function repoToolPath(repoRoot, name) {
  return path.resolve(repoRoot, 'tools', name);
}

function isRegularExecutable(filePath, fsImpl = fs) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile()) return false;
    fsImpl.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function validateExecutable(filePath, label, fsImpl = fs) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, reason: `${label}_invalid` };
  }
  let resolved;
  try {
    resolved = fsImpl.realpathSync(filePath);
  } catch {
    try {
      fsImpl.lstatSync(filePath);
      return { ok: false, reason: `${label}_not_regular` };
    } catch {
      return { ok: false, reason: `${label}_missing` };
    }
  }
  if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) {
    return { ok: false, reason: `${label}_not_regular` };
  }
  let stat;
  try {
    stat = fsImpl.lstatSync(resolved);
  } catch {
    return { ok: false, reason: `${label}_not_regular` };
  }
  if (!stat.isFile()) return { ok: false, reason: `${label}_not_regular` };
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
    return { ok: false, reason: `${label}_not_regular` };
  }
  try {
    fsImpl.accessSync(resolved, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: `${label}_not_executable` };
  }
  return { ok: true, resolvedPath: resolved };
}

function validateRequiredTools(repoRoot, fsImpl = fs) {
  const targets = [
    ['ffmpeg', repoToolPath(repoRoot, 'ffmpeg')],
    ['ffprobe', repoToolPath(repoRoot, 'ffprobe')],
    ['verifier', path.resolve(repoRoot, 'scripts', 'verify-spike.sh')],
  ];
  const resolved = {};
  for (const [label, filePath] of targets) {
    const result = validateExecutable(filePath, label, fsImpl);
    if (!result.ok) return { ...result, label };
    resolved[label] = result.resolvedPath || filePath;
  }
  return {
    ok: true,
    ffmpegPath: resolved.ffmpeg,
    ffprobePath: resolved.ffprobe,
    verifierPath: resolved.verifier,
    portable: false,
    resolved_external_tool: true,
  };
}

function resolvePythonExecutable(fsImpl = fs) {
  const configured = process.env.HDRTOSDR_PYTHON;
  const candidates = configured
    ? [configured]
    : ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
  for (const candidate of candidates) {
    if (isRegularExecutable(candidate, fsImpl)) return { ok: true, path: candidate };
  }
  return { ok: false, reason: 'python_not_available' };
}

function hlgFilter() {
  return 'testsrc2=size=64x36:rate=6:duration=1,format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc';
}

function pqFilter() {
  return 'testsrc2=size=64x36:rate=6:duration=1,format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc';
}

function audioFilter() {
  return 'anullsrc=channel_layout=stereo:sample_rate=48000:duration=1';
}

function encodedHdrArgs({ output, transfer, inputFilter, withAudio = true, rotation = false, vfr = false }) {
  const x265Transfer = transfer === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  const transferCode = transfer === 'hlg' ? 18 : 16;
  const x265Metadata = transfer === 'pq'
    ? ':master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400'
    : '';
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', inputFilter,
  ];
  if (withAudio) args.push('-f', 'lavfi', '-i', audioFilter());
  if (withAudio) args.push('-map', '0:v:0', '-map', '1:a:0');
  else args.push('-map', '0:v:0');
  if (vfr) {
    args.push(
      '-vf',
      'format=yuv420p10le,setparams=range=limited:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,settb=1/1000,setpts=N*1000/6+31*N',
    );
    args.push('-fps_mode', 'vfr', '-video_track_timescale', '1000');
  }
  args.push(
    '-c:v', 'libx265',
    '-preset', 'ultrafast',
    '-x265-params', `log-level=error:level-idc=51:colorprim=bt2020:transfer=${x265Transfer}:colormatrix=bt2020nc:range=limited${x265Metadata}`,
    '-pix_fmt', 'yuv420p10le',
    '-colorspace', 'bt2020nc',
    '-color_primaries', 'bt2020',
    '-color_trc', x265Transfer,
    '-color_range', 'tv',
    '-bsf:v', `hevc_metadata=colour_primaries=9:transfer_characteristics=${transferCode}:matrix_coefficients=9:video_full_range_flag=0`,
  );
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '32k', '-shortest');
  if (rotation) args.push('-metadata:s:v:0', 'rotate=90');
  args.push('-movflags', '+write_colr', '-n', output);
  return args;
}

function buildGenerationCommands(tempRoot, ffmpegPathOverride = null) {
  const root = path.resolve(tempRoot);
  const file = (name) => path.join(root, name);
  const ffmpeg = typeof ffmpegPathOverride === 'string'
    ? path.resolve(ffmpegPathOverride)
    : repoToolPath(path.resolve(__dirname, '..'), 'ffmpeg');
  const commands = [
    {
      name: 'generic-hlg',
      file: ffmpeg,
      args: encodedHdrArgs({ output: file('generic-hlg.mp4'), transfer: 'hlg', inputFilter: hlgFilter() }),
      output: file('generic-hlg.mp4'),
      shell: false,
    },
    {
      name: 'static-pq',
      file: ffmpeg,
      args: [
        ...encodedHdrArgs({ output: file('static-pq.mp4'), transfer: 'pq', inputFilter: pqFilter() }),
      ],
      output: file('static-pq.mp4'),
      shell: false,
    },
    {
      name: 'cover',
      file: ffmpeg,
      args: [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=1',
        '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2', '-n', file('cover.jpg'),
      ],
      output: file('cover.jpg'),
      shell: false,
    },
    {
      name: 'structural-main',
      file: ffmpeg,
      args: encodedHdrArgs({ output: file('structural-main.mp4'), transfer: 'hlg', inputFilter: hlgFilter(), withAudio: false }),
      output: file('structural-main.mp4'),
      shell: false,
    },
    {
      name: 'structural-mux',
      file: ffmpeg,
      args: [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', file('cover.jpg'),
        '-f', 'lavfi', '-i', audioFilter(),
        '-i', file('structural-main.mp4'),
        '-map', '0:v:0', '-map', '1:a:0', '-map', '2:V:0',
        '-c:v:0', 'copy', '-c:a', 'aac', '-b:a', '32k', '-c:v:1', 'copy',
        '-disposition:v:0', 'attached_pic',
        '-map_metadata', '-1', '-map_chapters', '-1', '-t', '1',
        '-movflags', '+faststart+write_colr', '-n', file('attached-picture-audio-first.mp4'),
      ],
      output: file('attached-picture-audio-first.mp4'),
      shell: false,
    },
    {
      name: 'rotation',
      file: ffmpeg,
      args: encodedHdrArgs({ output: file('rotation.mp4'), transfer: 'hlg', inputFilter: hlgFilter(), rotation: true }),
      output: file('rotation.mp4'),
      shell: false,
    },
    {
      name: 'vfr',
      file: ffmpeg,
      args: encodedHdrArgs({ output: file('vfr.mp4'), transfer: 'hlg', inputFilter: hlgFilter(), vfr: true }),
      output: file('vfr.mp4'),
      shell: false,
    },
  ];
  return commands;
}

function buildProbeArgs(mediaPath, allStreams = false) {
  // ffprobe 9.x does not expose ffmpeg's -nostdin switch; it never receives
  // stdin in runCommand (stdio[0] is "ignore"). A one-second interval is
  // still bounded, and is used for both selected-video and all-stream structural frame evidence.
  const args = ['-v', 'error', '-read_intervals', '0%+1'];
  if (!allStreams) args.push('-select_streams', 'V:0');
  args.push('-show_streams', '-show_frames', '-of', 'json', mediaPath);
  return args;
}

function parseProbeJson(value) {
  let data;
  try {
    data = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch {
    return { ok: false, reason: 'probe_json_invalid' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.streams)) {
    return { ok: false, reason: 'probe_shape_invalid' };
  }
  return { ok: true, data };
}

function attachedPictureValue(stream) {
  const disposition = stream && stream.disposition;
  if (disposition == null) return false;
  if (typeof disposition !== 'object' || Array.isArray(disposition)) throw new Error('disposition_shape_invalid');
  const value = disposition.attached_pic;
  if (value === undefined || value === null) return false;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  throw new Error('attached_pic_invalid');
}

function inspectStructuralProbe(data) {
  try {
    if (!data || !Array.isArray(data.streams)) throw new Error('streams_invalid');
    const videos = data.streams.filter((stream) => stream && stream.codec_type === 'video');
    const realVideo = videos.find((stream) => !attachedPictureValue(stream));
    if (!realVideo) throw new Error('real_video_missing');
    const realVideoPosition = data.streams.indexOf(realVideo);
    const selectedVideoIndex = realVideo.index === undefined
      ? realVideoPosition : realVideo.index;
    if (!Number.isSafeInteger(selectedVideoIndex) || selectedVideoIndex < 0) throw new Error('real_video_index_invalid');
    const streamOrder = data.streams.map((stream) => {
      if (!stream || typeof stream.codec_type !== 'string') throw new Error('stream_shape_invalid');
      if (stream.codec_type === 'video') return attachedPictureValue(stream) ? 'attached-video' : 'real-video';
      return stream.codec_type;
    });
    const selectedFrames = Array.isArray(data.frames)
      ? data.frames.filter((frame) => frame && frame.media_type === 'video' && frame.stream_index === selectedVideoIndex)
      : [];
    const attachedIndexes = new Set(videos.filter((stream) => attachedPictureValue(stream)).map((stream) => stream.index));
    const nonSelectedFrameEvidence = Array.isArray(data.frames)
      && data.frames.some((frame) => frame && frame.media_type === 'video'
        && Number.isSafeInteger(frame.stream_index)
        && frame.stream_index !== selectedVideoIndex
        && !attachedIndexes.has(frame.stream_index));
    const width = Number(realVideo.width);
    const height = Number(realVideo.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error('dimensions_invalid');
    }
    const orderText = streamOrder.join(',');
    const acceptedOrders = new Set([
      'attached-video,audio,real-video',
      'audio,real-video,attached-video',
    ]);
    if (!acceptedOrders.has(orderText)) {
      return { ok: false, reason: 'structural_stream_order_unsupported', streamOrder };
    }
    return {
      ok: true,
      selectedVideoIndex,
      streamOrder,
      frameEvidence: selectedFrames.length > 0 && !nonSelectedFrameEvidence
        ? 'selected_real_video'
        : 'selected_stream_not_proven',
      presentationDimensions: `${width}x${height}`,
      audioPolicy: data.streams.some((stream) => stream && stream.codec_type === 'audio')
        ? 'audio_present'
        : 'audio_absent',
    };
  } catch {
    return { ok: false, reason: 'structural_probe_invalid' };
  }
}

function checkInspectionResult(response, expectedClassification, expectedProfile) {
  if (!response || response.outcome !== 'complete' || !response.result) {
    return { ok: false, reason: 'inspection_contract_mismatch' };
  }
  const result = response.result;
  if (result.classification !== expectedClassification
      || result.profileId !== expectedProfile
      || result.canConvert !== true) {
    return { ok: false, reason: 'inspection_contract_mismatch' };
  }
  return { ok: true };
}

function dynamicFixtureStatus(toolPath) {
  if (!toolPath) return { status: 'not_run', reason: 'tool_unavailable' };
  // Dynamic metadata is deliberately never reported as PASS by this harness.
  return { status: 'not_run', reason: 'dynamic_fixture_not_run' };
}

function parseRational(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match || match[2] === '0') return null;
  try {
    return { numerator: BigInt(match[1]), denominator: BigInt(match[2]) };
  } catch {
    return null;
  }
}

function ratesDiffer(first, second) {
  const a = parseRational(first);
  const b = parseRational(second);
  if (!a || !b) return null;
  return a.numerator * b.denominator !== b.numerator * a.denominator;
}

function rotationEvidence(data) {
  if (!data || !Array.isArray(data.streams)) return { ok: false, reason: 'rotation_readback_unavailable' };
  for (const stream of data.streams) {
    if (!stream || stream.codec_type !== 'video') continue;
    if (stream.tags && typeof stream.tags === 'object' && stream.tags.rotate !== undefined) {
      const value = Number(stream.tags.rotate);
      if (Number.isFinite(value) && Math.abs(value) % 360 !== 0) {
        return { ok: true, readback: 'rotate_tag' };
      }
    }
    if (Array.isArray(stream.side_data_list)
        && stream.side_data_list.some((item) => item && /display matrix/i.test(String(item.side_data_type || '')))) {
      return { ok: true, readback: 'display_matrix' };
    }
  }
  return { ok: false, reason: 'rotation_metadata_not_preserved_by_ffmpeg_mp4', readback: 'no_display_matrix_or_rotate_tag' };
}

function makeSummary(input = {}) {
  const safeStatus = new Set(['pass', 'blocked', 'fail', 'not_run', 'tool_unavailable']);
  const safeReason = (value, fallback) => {
    const text = typeof value === 'string' && SAFE_REASON_RE.test(value) && value.length <= 100 ? value : fallback;
    return text;
  };
  const safeText = (value) => typeof value === 'string' && value.length <= 100 && SAFE_REASON_RE.test(value) ? value : undefined;
  const scenarioInput = input.scenarios && typeof input.scenarios === 'object' ? input.scenarios : {};
  const scenarios = {};
  for (const name of REQUIRED_SCENARIOS) {
    const record = scenarioInput[name];
    if (!record || typeof record !== 'object') continue;
    const item = {
      status: safeStatus.has(record.status) ? record.status : 'fail',
      reason: safeReason(record.reason, 'scenario_failed'),
    };
    for (const key of [
      'classification', 'profileId', 'conversion', 'verification', 'streamSelection',
      'frameEvidence', 'presentationDimensions', 'audioPolicy', 'mapping', 'streamOrder', 'readback',
      'policy', 'vfrReadback',
    ]) {
      const value = safeText(record[key]);
      if (value !== undefined) item[key] = value;
    }
    scenarios[name] = item;
  }
  const dynamicInput = input.dynamic && typeof input.dynamic === 'object' ? input.dynamic : {};
  const dynamic = {};
  for (const name of DYNAMIC_SCENARIOS) {
    const record = dynamicInput[name] || dynamicFixtureStatus(null);
    dynamic[name] = {
      status: record.status === 'not_run' ? 'not_run' : 'not_run',
      reason: safeReason(record.reason, 'tool_unavailable'),
    };
  }
  const cleanup = input.cleanup && typeof input.cleanup === 'object' ? input.cleanup : {};
  return {
    version: 1,
    status: safeStatus.has(input.status) ? input.status : 'fail',
    reason: safeReason(input.reason, 'harness_failed'),
    portable: false,
    resolved_external_tool: true,
    scenarios,
    dynamic,
    cleanup: {
      status: cleanup.status === 'pass' ? 'pass' : 'fail',
      residueCount: Number.isSafeInteger(cleanup.residueCount) && cleanup.residueCount >= 0
        ? cleanup.residueCount : 0,
    },
  };
}

function cleanupOwnedTemp(tempRoot, fsImpl = fs) {
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot)) {
    return { ok: false, reason: 'cleanup_refused' };
  }
  const resolved = path.resolve(tempRoot);
  const expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    return { ok: false, reason: 'cleanup_refused' };
  }
  try {
    const stat = fsImpl.lstatSync(resolved);
    if (!stat.isDirectory()) return { ok: false, reason: 'cleanup_refused' };
    fsImpl.rmSync(resolved, { recursive: true, force: true });
    if (fsImpl.existsSync(resolved)) return { ok: false, reason: 'cleanup_failed' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'cleanup_failed' };
  }
}

function makeTempRoot(fsImpl = fs) {
  const root = fsImpl.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  fsImpl.chmodSync(root, 0o700);
  return root;
}

function chmodPrivate(filePath, fsImpl = fs) {
  try {
    fsImpl.chmodSync(filePath, 0o600);
  } catch {
    return false;
  }
  return true;
}

function runCommand(file, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : GENERATION_TIMEOUT_MS;
  const maxStdout = Number.isSafeInteger(options.maxStdoutBytes) && options.maxStdoutBytes > 0
    ? options.maxStdoutBytes : MAX_COMMAND_STDOUT;
  const maxStderr = Number.isSafeInteger(options.maxStderrBytes) && options.maxStderrBytes > 0
    ? options.maxStderrBytes : MAX_COMMAND_STDERR;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timeout = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let forcedReason = null;
    const coordinator = new HeavyOperationCoordinator({ terminationGraceMs: TERMINATION_GRACE_MS });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { if (child) coordinator.untrack(child); } catch {}
      resolve({
        ok: result.ok === true,
        status: result.status,
        reason: result.reason,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    };
    const stop = (reason) => {
      if (settled || forcedReason) return;
      forcedReason = reason;
      if (!child) {
        finish({ ok: false, reason });
        return;
      }
      Promise.resolve(coordinator.terminate(child)).finally(() => finish({ ok: false, reason }));
    };
    const collect = (which, chunk, limit) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (which === 'stdout') {
        if (stdout.length + buffer.length > limit) {
          stop('command_output_limit');
          return;
        }
        stdout = Buffer.concat([stdout, buffer]);
      } else {
        if (stderr.length + buffer.length > limit) {
          stop('command_output_limit');
          return;
        }
        stderr = Buffer.concat([stderr, buffer]);
      }
    };

    try {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        finish({ ok: false, reason: 'invalid_command' });
        return;
      }
      child = spawnImpl(file, args, {
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      markProcessGroupOwned(child);
      coordinator.track(child);
    } catch {
      finish({ ok: false, reason: 'command_spawn_failed' });
      return;
    }
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => collect('stdout', chunk, maxStdout));
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => collect('stderr', chunk, maxStderr));
    child.once('error', () => {
      if (forcedReason) return;
      finish({ ok: false, reason: 'command_failed' });
    });
    child.once('close', (status) => {
      if (forcedReason) return;
      finish({ ok: status === 0, status, reason: status === 0 ? undefined : 'command_failed' });
    });
    timeout = setTimeout(() => stop('command_timeout'), timeoutMs);
  });
}

function mapCommandFailure(result, fallback) {
  if (!result || result.ok !== false) return fallback;
  if (result.reason === 'command_timeout') return `${fallback}_timeout`;
  if (result.reason === 'command_output_limit') return `${fallback}_output_limit`;
  return fallback;
}

async function verifyGenerationCapabilities(ffmpegPath, runner) {
  const checks = [
    [['-hide_banner', '-h', 'encoder=libx265'], 'Encoder libx265'],
    [['-hide_banner', '-h', 'bsf=hevc_metadata'], 'Bit stream filter hevc_metadata'],
  ];
  for (const [args, token] of checks) {
    const result = await runner(ffmpegPath, args, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!result || result.ok !== true || typeof result.stdout !== 'string' || !result.stdout.includes(token)) {
      return { ok: false, reason: 'tool_capability_unavailable' };
    }
  }
  return { ok: true };
}

async function runGeneration(commands, ffmpegPath, runner, fsImpl = fs) {
  for (const command of commands) {
    const result = await runner(ffmpegPath, command.args, { timeoutMs: GENERATION_TIMEOUT_MS });
    if (!result || result.ok !== true) return { ok: false, reason: mapCommandFailure(result, 'generation_failed') };
    if (!chmodPrivate(command.output, fsImpl)) return { ok: false, reason: 'private_file_setup_failed' };
  }
  return { ok: true };
}

async function inspectMedia(sourcePath, repoRoot, pythonPath) {
  const oldPython = process.env.HDRTOSDR_PYTHON;
  const oldBackend = process.env.HDRTOSDR_BACKEND_ROOT;
  process.env.HDRTOSDR_PYTHON = pythonPath;
  process.env.HDRTOSDR_BACKEND_ROOT = repoRoot;
  try {
    return await inspectionAdapter.inspect(sourcePath, {
      timeoutMs: PROBE_TIMEOUT_MS,
      stallTimeoutMs: PROBE_TIMEOUT_MS,
    });
  } finally {
    if (oldPython === undefined) delete process.env.HDRTOSDR_PYTHON;
    else process.env.HDRTOSDR_PYTHON = oldPython;
    if (oldBackend === undefined) delete process.env.HDRTOSDR_BACKEND_ROOT;
    else process.env.HDRTOSDR_BACKEND_ROOT = oldBackend;
  }
}

async function runScenario({ name, sourcePath, stagingPath, classification, profileId, repoRoot, ffmpegPath, verifierPath, pythonPath, runner, inspectFn, convertFn, verifyFn, fsImpl = fs }) {
  const inspection = await inspectFn(sourcePath, repoRoot, pythonPath);
  const checked = checkInspectionResult(inspection, classification, profileId);
  if (!checked.ok) return { status: 'fail', reason: checked.reason };
  const conversion = await convertFn({
    sourcePath,
    stagingPath,
    profileId,
    ffmpegPath,
    timeoutMs: VERIFIER_TIMEOUT_MS,
    stallTimeoutMs: PROBE_TIMEOUT_MS,
    durationSeconds: inspection.result.duration,
  });
  if (!conversion || conversion.outcome !== 'success' || !chmodPrivate(stagingPath, fsImpl)) {
    return { status: 'fail', reason: conversion && conversion.reason
      ? mapCommandFailure(conversion, 'conversion_failed') : 'conversion_failed' };
  }
  const verification = await verifyFn(sourcePath, stagingPath, profileId, verifierPath, runner);
  if (!verification || verification.ok !== true
      || (verification.status !== undefined && verification.status !== 0)) {
    return { status: 'fail', reason: mapCommandFailure(verification, 'verification_failed') };
  }
  return {
    status: 'pass',
    reason: 'conversion_and_verification_pass',
    classification,
    profileId,
    conversion: 'pass',
    verification: 'pass',
  };
}

async function defaultVerify(sourcePath, outputPath, profileId, verifierPath, runner) {
  return runner(verifierPath, [sourcePath, outputPath, profileId], { timeoutMs: VERIFIER_TIMEOUT_MS });
}

async function runHarness(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..'));
  const fsImpl = options.fsImpl || fs;
  const runner = options.runCommand || runCommand;
  const inspectFn = options.inspectFn || inspectMedia;
  const convertFn = options.convertFn || bExecutor.runBConversion;
  const verifyFn = options.verifyFn || defaultVerify;
  const required = validateRequiredTools(repoRoot, fsImpl);
  const optionalDovi = validateExecutable(repoToolPath(repoRoot, 'dovi_tool'), 'dovi_tool', fsImpl);
  const optionalHdr10Plus = validateExecutable(repoToolPath(repoRoot, 'hdr10plus_tool'), 'hdr10plus_tool', fsImpl);
  const dynamic = {
    dolbyVision: dynamicFixtureStatus(optionalDovi.ok ? repoToolPath(repoRoot, 'dovi_tool') : null),
    hdr10Plus: dynamicFixtureStatus(optionalHdr10Plus.ok ? repoToolPath(repoRoot, 'hdr10plus_tool') : null),
  };
  if (!required.ok) {
    const scenarios = Object.fromEntries(REQUIRED_SCENARIOS.map((name) => [name, {
      status: 'tool_unavailable', reason: required.reason,
    }]));
    return makeSummary({ status: 'blocked', reason: required.reason, scenarios, dynamic, cleanup: { status: 'pass', residueCount: 0 } });
  }
  const python = options.pythonPath
    ? (isRegularExecutable(options.pythonPath, fsImpl) ? { ok: true, path: options.pythonPath } : { ok: false, reason: 'python_not_available' })
    : resolvePythonExecutable(fsImpl);
  if (!python.ok) {
    const scenarios = Object.fromEntries(REQUIRED_SCENARIOS.map((name) => [name, {
      status: 'tool_unavailable', reason: python.reason,
    }]));
    return makeSummary({ status: 'blocked', reason: python.reason, scenarios, dynamic, cleanup: { status: 'pass', residueCount: 0 } });
  }
  const generationCapability = await verifyGenerationCapabilities(required.ffmpegPath, runner);
  if (!generationCapability.ok) {
    const scenarios = Object.fromEntries(REQUIRED_SCENARIOS.map((name) => [name, {
      status: 'tool_unavailable', reason: generationCapability.reason,
    }]));
    return makeSummary({ status: 'blocked', reason: generationCapability.reason, scenarios, dynamic, cleanup: { status: 'pass', residueCount: 0 } });
  }

  let tempRoot = null;
  let scenarioResults = {};
  let overallStatus = 'fail';
  let overallReason = 'harness_failed';
  let cleanupResult = { status: 'fail', residueCount: 1 };
  let finalSummary = null;
  try {
    tempRoot = makeTempRoot(fsImpl);
    const commands = buildGenerationCommands(tempRoot, required.ffmpegPath);
    const generated = await runGeneration(commands, required.ffmpegPath, runner, fsImpl);
    if (!generated.ok) {
      overallReason = generated.reason;
      scenarioResults = Object.fromEntries(REQUIRED_SCENARIOS.map((name) => [name, {
        status: 'fail', reason: generated.reason,
      }]));
      finalSummary = makeSummary({ status: 'fail', reason: overallReason, scenarios: scenarioResults, dynamic, cleanup: cleanupResult });
      return finalSummary;
    }
    const commandByName = new Map(commands.map((command) => [command.name, command]));
    const generic = commandByName.get('generic-hlg');
    const pq = commandByName.get('static-pq');
    const structural = commandByName.get('structural-mux');
    const rotation = commandByName.get('rotation');
    const vfr = commandByName.get('vfr');
    scenarioResults.genericHlg = await runScenario({
      name: 'genericHlg', sourcePath: generic.output, stagingPath: path.join(tempRoot, 'generic-hlg.partial.mp4'),
      classification: 'hlgSupported', profileId: PROFILE_ID_GENERIC, repoRoot, ffmpegPath: required.ffmpegPath,
      verifierPath: required.verifierPath, pythonPath: python.path, runner, inspectFn, convertFn, verifyFn, fsImpl,
    });
    scenarioResults.staticPq = await runScenario({
      name: 'staticPq', sourcePath: pq.output, stagingPath: path.join(tempRoot, 'static-pq.partial.mp4'),
      classification: 'pqSupported', profileId: PROFILE_ID_PQ, repoRoot, ffmpegPath: required.ffmpegPath,
      verifierPath: required.verifierPath, pythonPath: python.path, runner, inspectFn, convertFn, verifyFn, fsImpl,
    });

    const structuralProbeResult = await runner(required.ffprobePath, buildProbeArgs(structural.output, true), { timeoutMs: PROBE_TIMEOUT_MS });
    const structuralProbe = structuralProbeResult.ok ? parseProbeJson(structuralProbeResult.stdout) : { ok: false, reason: 'structural_probe_failed' };
    const structuralEvidence = structuralProbe.ok ? inspectStructuralProbe(structuralProbe.data) : { ok: false, reason: structuralProbe.reason };
    if (!structuralEvidence.ok || structuralEvidence.frameEvidence !== 'selected_real_video') {
      scenarioResults.attachedPictureAudioFirst = { status: 'not_run', reason: structuralEvidence.reason || 'frame_evidence_not_selected' };
    } else {
      const structuralRun = await runScenario({
        name: 'attachedPictureAudioFirst', sourcePath: structural.output, stagingPath: path.join(tempRoot, 'attached-picture.partial.mp4'),
        classification: 'hlgSupported', profileId: PROFILE_ID_GENERIC, repoRoot, ffmpegPath: required.ffmpegPath,
        verifierPath: required.verifierPath, pythonPath: python.path, runner, inspectFn, convertFn, verifyFn, fsImpl,
      });
      scenarioResults.attachedPictureAudioFirst = {
        ...structuralRun,
        streamSelection: 'first_real_video',
        frameEvidence: structuralEvidence.frameEvidence,
        streamOrder: structuralEvidence.streamOrder.join('-'),
        presentationDimensions: structuralEvidence.presentationDimensions,
        audioPolicy: structuralRun.status === 'pass' ? 'pass' : structuralEvidence.audioPolicy,
        mapping: '0:V:0',
      };
    }

    const rotationProbeResult = await runner(required.ffprobePath, buildProbeArgs(rotation.output, true), { timeoutMs: PROBE_TIMEOUT_MS });
    const rotationProbe = rotationProbeResult.ok ? parseProbeJson(rotationProbeResult.stdout) : { ok: false, reason: 'rotation_probe_failed' };
    const rotated = rotationProbe.ok ? rotationEvidence(rotationProbe.data) : { ok: false, reason: rotationProbe.reason };
    if (!rotated.ok) {
      scenarioResults.rotation = { status: 'not_run', reason: rotated.reason, readback: rotated.readback || 'unavailable' };
    } else {
      const rotationRun = await runScenario({
        name: 'rotation', sourcePath: rotation.output, stagingPath: path.join(tempRoot, 'rotation.partial.mp4'),
        classification: 'hlgSupported', profileId: PROFILE_ID_GENERIC, repoRoot, ffmpegPath: required.ffmpegPath,
        verifierPath: required.verifierPath, pythonPath: python.path, runner, inspectFn, convertFn, verifyFn, fsImpl,
      });
      scenarioResults.rotation = { ...rotationRun, policy: 'presentation_dimensions', readback: rotated.readback };
    }

    const vfrProbeResult = await runner(required.ffprobePath, buildProbeArgs(vfr.output, false), { timeoutMs: PROBE_TIMEOUT_MS });
    const vfrProbe = vfrProbeResult.ok ? parseProbeJson(vfrProbeResult.stdout) : { ok: false, reason: 'vfr_probe_failed' };
    const vfrStream = vfrProbe.ok && vfrProbe.data.streams[0];
    const vfrDifference = vfrStream ? ratesDiffer(vfrStream.r_frame_rate, vfrStream.avg_frame_rate) : null;
    if (vfrDifference !== true) {
      scenarioResults.vfr = {
        status: 'not_run',
        reason: vfrDifference === false ? 'vfr_not_preserved_by_mp4' : 'vfr_readback_unavailable',
        vfrReadback: vfrDifference === false ? 'avg_frame_rate_equals_r_frame_rate' : 'unavailable',
      };
    } else {
      const vfrRun = await runScenario({
        name: 'vfr', sourcePath: vfr.output, stagingPath: path.join(tempRoot, 'vfr.partial.mp4'),
        classification: 'hlgSupported', profileId: PROFILE_ID_GENERIC, repoRoot, ffmpegPath: required.ffmpegPath,
        verifierPath: required.verifierPath, pythonPath: python.path, runner, inspectFn, convertFn, verifyFn, fsImpl,
      });
      scenarioResults.vfr = { ...vfrRun, policy: 'passthrough', vfrReadback: 'avg_frame_rate_differs' };
    }
    const requiredPass = ['genericHlg', 'staticPq', 'attachedPictureAudioFirst']
      .every((name) => scenarioResults[name] && scenarioResults[name].status === 'pass');
    const edgeAcceptable = ['rotation', 'vfr'].every((name) => ['pass', 'not_run'].includes(scenarioResults[name] && scenarioResults[name].status));
    overallStatus = requiredPass && edgeAcceptable ? 'pass' : 'fail';
    overallReason = overallStatus === 'pass' ? 'required_media_scenarios_pass' : 'required_media_scenario_failed';
    finalSummary = makeSummary({ status: overallStatus, reason: overallReason, scenarios: scenarioResults, dynamic, cleanup: cleanupResult });
    return finalSummary;
  } catch {
    finalSummary = makeSummary({ status: 'fail', reason: 'harness_failed', scenarios: scenarioResults, dynamic, cleanup: cleanupResult });
    return finalSummary;
  } finally {
    if (tempRoot) {
      const cleaned = cleanupOwnedTemp(tempRoot, fsImpl);
      cleanupResult = cleaned.ok ? { status: 'pass', residueCount: 0 } : { status: 'fail', residueCount: 1 };
      if (finalSummary) finalSummary.cleanup = cleanupResult;
    }
  }
}

async function main() {
  let summary;
  try {
    summary = await runHarness();
  } catch {
    summary = makeSummary({ status: 'fail', reason: 'harness_failed', cleanup: { status: 'fail', residueCount: 1 } });
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.status !== 'pass') process.exitCode = summary.status === 'blocked' ? 2 : 1;
}

if (require.main === module) main();

module.exports = {
  TEMP_PREFIX,
  MAX_COMMAND_STDOUT,
  MAX_COMMAND_STDERR,
  buildGenerationCommands,
  buildProbeArgs,
  parseProbeJson,
  inspectStructuralProbe,
  checkInspectionResult,
  dynamicFixtureStatus,
  validateExecutable,
  validateRequiredTools,
  runCommand,
  cleanupOwnedTemp,
  makeSummary,
  runHarness,
  ratesDiffer,
};
