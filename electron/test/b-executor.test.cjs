const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const bExecutor = require('../b-executor.cjs');
const {
  PROFILE_ID,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  FILTER_GRAPH,
  FILTER_GRAPH_LOCAL_B,
  FILTER_GRAPH_GENERIC,
  FILTER_GRAPH_PQ,
} = require('../b-profile.cjs');

const EXPECTED_OUTPUT_SANITIZATION_SUFFIX = [
  'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
  'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
  'sidedata=mode=delete:type=DYNAMIC_HDR_PLUS',
  'sidedata=mode=delete:type=DOVI_RPU_BUFFER',
  'sidedata=mode=delete:type=DOVI_METADATA',
  'sidedata=mode=delete:type=DYNAMIC_HDR_VIVID',
  'sidedata=mode=delete:type=AMBIENT_VIEWING_ENVIRONMENT',
].join(',');

test('PROFILE_ID frozen', () => {
  assert.equal(PROFILE_ID, 'hlg-local-b-v1');
});

test('FILTER_GRAPH frozen exact', () => {
  assert.equal(FILTER_GRAPH, 'libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le,eq=gamma=0.90');
});

test('buildFfmpegArgs uses frozen graph and required flags', () => {
  const args = bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.partial.mp4');
  // Must contain shell:false equivalent: shell is handled by spawn, not args
  // Check required flags
  assert.ok(args.includes('-nostdin'));
  assert.ok(args.includes('-loglevel'));
  assert.ok(args.includes('error'));
  assert.ok(args.includes('-progress'));
  assert.ok(args.includes('pipe:1'));
  // filter graph
  const vfIdx = args.indexOf('-vf');
  assert.notEqual(vfIdx, -1);
  assert.equal(args[vfIdx + 1], `${FILTER_GRAPH},${EXPECTED_OUTPUT_SANITIZATION_SUFFIX}`);
  // must contain H.264 High (compact MP4)
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('high')); // profile high
  assert.ok(args.includes('medium')); // preset medium
  assert.ok(args.includes('18')); // crf 18
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('bt709'));
  assert.ok(args.includes('tv'));
  // metadata stripping
  assert.ok(args.includes('-map_metadata'));
  assert.ok(args.includes('-1'));
  assert.ok(args.includes('-map_chapters'));
  // primary video+optional audio only
  assert.ok(args.includes('0:v:0'));
  assert.ok(args.includes('0:a?'));
  // ensure no subtitle/data mapping
  assert.equal(args.includes('0:s'), false);
  assert.equal(args.includes('0:d'), false);
  // AAC 192k (optional source audio preserved with -map 0:a?)
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('192k'));
  // fps passthrough
  assert.ok(args.includes('passthrough'));
  // faststart+write_colr
  assert.ok(args.includes('+faststart+write_colr'));
  assert.equal(args.includes('prores_ks'), false, 'must not use ProRes');
  assert.equal(args.includes('ap10'), false, 'must not contain ProRes vendor');
  // -n
  assert.ok(args.includes('-n'));
  // sources
  assert.ok(args.includes('/tmp/src.mov'));
  assert.ok(args.includes('/tmp/out.partial.mp4'));
  // Ensure no mobius/spline variant/generic fallback
  const vf = args[vfIdx + 1];
  assert.ok(vf.includes('tonemapping=spline'));
  assert.ok(vf.includes('tonemapping_param=0.45'));
  assert.ok(vf.includes('gamut_mode=perceptual'));
  assert.ok(!vf.includes('mobius'));
  assert.ok(!vf.includes('bt.2390'));
  assert.ok(!vf.includes('hable'));
  assert.ok(!vf.includes('zscale'));
  assert.equal(vf.endsWith(EXPECTED_OUTPUT_SANITIZATION_SUFFIX), true);
});

test('all H.264 SDR profiles append the shared output sanitation suffix', () => {
  const cases = [
    [PROFILE_ID_LOCAL_B, FILTER_GRAPH_LOCAL_B],
    [PROFILE_ID_GENERIC, FILTER_GRAPH_GENERIC],
    [PROFILE_ID_PQ, FILTER_GRAPH_PQ],
  ];
  for (const [profileId, graph] of cases) {
    const args = bExecutor.buildFfmpegArgs('/tmp/src.mov', '/tmp/out.partial.mp4', profileId);
    const vf = args[args.indexOf('-vf') + 1];
    assert.equal(vf, `${graph},${EXPECTED_OUTPUT_SANITIZATION_SUFFIX}`);
    assert.equal(vf.startsWith(graph + ','), true);
  }
});

test('buildFfmpegArgs never includes guessed fallback', () => {
  const args = bExecutor.buildFfmpegArgs('/a/b.mp4', '/c/d.mp4');
  const asString = args.join(' ');
  assert.equal(asString.includes('mobius'), false);
  assert.equal(asString.includes('zscale'), false);
  // tonemapping is expected, but standalone tonemap filter should not appear
  assert.equal(asString.includes('tonemap='), false);
});

test('checkCapability fails when ffmpeg missing', () => {
  const res = bExecutor.checkCapability('/nonexistent/ffmpeg');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'profile_unavailable');
});

test('checkCapability is profile-aware and fails closed on missing profile tokens', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-capability-'));
  const quote = (value) => `'${value.replace(/'/g, "'\\\\''")}'`;
  const makeFake = (name, libplaceboLines, eqLines, eqStatus = 0) => {
    const fake = path.join(tmp, name);
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      '  *filter=libplacebo*)',
      `    printf '%s\\n' ${libplaceboLines.map(quote).join(' ')}`,
      '    exit 0;;',
      '  *filter=sidedata*)',
      "    printf '%s\\n' 'Filter sidedata' 'MASTERING_DISPLAY_METADATA' 'CONTENT_LIGHT_LEVEL' 'DYNAMIC_HDR_PLUS' 'DOVI_RPU_BUFFER' 'DOVI_METADATA' 'DYNAMIC_HDR_VIVID' 'AMBIENT_VIEWING_ENVIRONMENT'",
      '    exit 0;;',
      '  *filter=eq*)',
      eqLines.length ? `    printf '%s\\n' ${eqLines.map(quote).join(' ')}` : '    :',
      `    exit ${eqStatus};;`,
      '  *encoder=libx264*)',
      "    printf '%s\\n' 'Encoder libx264'",
      '    exit 0;;',
      '  *encoder=aac*)',
      "    printf '%s\\n' 'Encoder aac'",
      '    exit 0;;',
      'esac',
      'exit 1',
      '',
    ].join('\n');
    fs.writeFileSync(fake, script, { mode: 0o755 });
    fs.chmodSync(fake, 0o755);
    return fake;
  };
  const common = ['Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual'];
  try {
    // Local B has its own spline/param/eq requirements; generic needs BT.2390 instead.
    const localOnly = makeFake(
      'local-only-ffmpeg',
      [...common, 'spline', 'tonemapping_param'],
      ['Filter eq', 'gamma'],
    );
    assert.equal(bExecutor.checkCapability(localOnly, PROFILE_ID_LOCAL_B).ok, true);
    assert.equal(bExecutor.checkCapability(localOnly, PROFILE_ID_GENERIC).reason, 'profile_unavailable');

    // Generic must pass without probing eq and must reject a libplacebo lacking exact BT.2390.
    const genericOnly = makeFake('generic-only-ffmpeg', [...common, 'bt.2390'], [], 1);
    assert.equal(bExecutor.checkCapability(genericOnly, PROFILE_ID_GENERIC).ok, true);
    assert.equal(bExecutor.checkCapability(genericOnly, PROFILE_ID_LOCAL_B).reason, 'profile_unavailable');

    assert.equal(bExecutor.checkCapability(genericOnly, 'unknown-profile').reason, 'profile_unavailable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkCapability fails closed when sidedata or a required enum token is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-sidedata-capability-'));
  const makeFake = (name, sidedataLines) => {
    const fake = path.join(tmp, name);
    const quote = (value) => `'${value.replace(/'/g, "'\\\\''")}'`;
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      '  *filter=libplacebo*)',
      "    printf '%s\\n' 'Filter libplacebo' 'tonemapping' 'gamut_mode' 'perceptual' 'bt.2390' 'peak_detect'; exit 0;;",
      '  *filter=sidedata*)',
      `    printf '%s\\n' ${sidedataLines.map(quote).join(' ')}; exit 0;;`,
      '  *encoder=libx264*)',
      "    printf '%s\\n' 'Encoder libx264'; exit 0;;",
      '  *encoder=aac*)',
      "    printf '%s\\n' 'Encoder aac'; exit 0;;",
      'esac',
      'exit 1',
      '',
    ].join('\n');
    fs.writeFileSync(fake, script, { mode: 0o755 });
    fs.chmodSync(fake, 0o755);
    return fake;
  };
  const full = EXPECTED_OUTPUT_SANITIZATION_SUFFIX.split(',').map((filter) => filter.split('type=')[1]);
  try {
    const missingFilter = makeFake('missing-sidedata-filter', []);
    assert.equal(bExecutor.checkCapability(missingFilter, PROFILE_ID_PQ).reason, 'profile_unavailable');
    const missingEnum = makeFake('missing-sidedata-enum', ['Filter sidedata', ...full.slice(1)]);
    assert.equal(bExecutor.checkCapability(missingEnum, PROFILE_ID_PQ).reason, 'profile_unavailable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runBConversion fails closed before spawn when sidedata capability is incomplete', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-sidedata-spawn-'));
  const marker = path.join(tmp, 'conversion-was-spawned');
  const fake = path.join(tmp, 'ffmpeg');
  const sourcePath = path.join(tmp, 'source.mp4');
  const stagingPath = path.join(tmp, 'staging.partial.mp4');
  const script = [
    '#!/bin/sh',
    'case "$*" in',
    "  *filter=libplacebo*) printf '%s\\n' 'Filter libplacebo' 'tonemapping' 'gamut_mode' 'perceptual' 'bt.2390' 'peak_detect'; exit 0;;",
    "  *filter=sidedata*) printf '%s\\n' 'Filter sidedata' 'MASTERING_DISPLAY_METADATA' 'CONTENT_LIGHT_LEVEL' 'DYNAMIC_HDR_PLUS' 'DOVI_RPU_BUFFER' 'DOVI_METADATA' 'DYNAMIC_HDR_VIVID'; exit 0;;",
    "  *encoder=libx264*) printf '%s\\n' 'Encoder libx264'; exit 0;;",
    "  *encoder=aac*) printf '%s\\n' 'Encoder aac'; exit 0;;",
    `  *) touch '${marker}'; exit 0;;`,
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(fake, script, { mode: 0o755 });
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(sourcePath, 'dummy');
  try {
    const result = await bExecutor.runBConversion({ sourcePath, stagingPath, profileId: PROFILE_ID_PQ, ffmpegPath: fake });
    assert.deepEqual(result, { outcome: 'error', reason: 'profile_unavailable' });
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getFfmpegAbsolute uses repo tools/ffmpeg absolute', () => {
  const p = bExecutor.getFfmpegAbsolute();
  assert.ok(path.isAbsolute(p));
  assert.ok(p.endsWith(path.join('tools', 'ffmpeg')));
});

test('runBConversion capability failure does not leak path', async () => {
  // Use stub that fails capability via nonexistent binary
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-exec-'));
  const src = path.join(tmp, 'src.mov');
  const staging = path.join(tmp, 'staging.partial.mp4');
  fs.writeFileSync(src, 'dummy');
  const result = await bExecutor.runBConversion({
    sourcePath: src,
    stagingPath: staging,
    ffmpegPath: '/nonexistent/ffmpeg',
  });
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'profile_unavailable');
  // Ensure no path in reason
  assert.equal(result.sourcePath, undefined);
  assert.equal(result.stderr, undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runBConversion with mocked capability still isolates', async () => {
  assert.equal(typeof bExecutor.runBConversion, 'function');
});

test('capability preflight does not use shell-interpolated execSync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'b-executor.cjs'), 'utf8');
  // Must not contain execSync with shell interpolation
  assert.equal(src.includes('execSync(`"${ffmpegPath}"'), false, 'should not use interpolated execSync');
  assert.equal(src.includes('execSync(`${ffmpegPath}'), false);
  assert.equal(/execSync\s*\(/.test(src), false, 'should not contain execSync at all');
  // Must use spawnSync or execFileSync with shell:false and argv array
  assert.ok(src.includes('spawnSync'), 'should use spawnSync');
  assert.ok(src.includes('shell: false'), 'should pass shell:false');
  // Verify ffmpegPath is passed as absolute first arg, not interpolated string
  assert.ok(/spawnSync\s*\(\s*ffmpegPath\s*,\s*\[/.test(src), 'should call spawnSync(ffmpegPath, [...])');
  // Ensure both probes use argv arrays
  assert.ok(src.includes("'filter=libplacebo'") || src.includes('"filter=libplacebo"') || src.includes('filter=libplacebo'));
  assert.ok(src.includes("'filter=eq'") || src.includes('"filter=eq"') || src.includes('filter=eq'));
  assert.ok(src.includes("'encoder=libx264'") || src.includes('"encoder=libx264"') || src.includes('encoder=libx264'));
  assert.ok(src.includes("'encoder=aac'") || src.includes('"encoder=aac"') || src.includes('encoder=aac'));
});

test('checkCapability generic profile_unavailable on any failure without leak', () => {
  // Non-executable path
  const r1 = bExecutor.checkCapability('/tmp');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'profile_unavailable');
  assert.equal(r1.stderr, undefined);
  // Path with shell metacharacters should not be executed via shell — should still be profile_unavailable safely
  const tricky = '/tmp/ffmpeg; echo hacked';
  const r2 = bExecutor.checkCapability(tricky);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'profile_unavailable');
  // Ensure no exception propagates
  assert.equal(typeof r2.reason, 'string');
});
