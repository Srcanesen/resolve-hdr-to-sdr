const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const {
  FILTER_GRAPH,
  PROFILE_ID,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  FILTER_GRAPH_LOCAL_B,
  FILTER_GRAPH_GENERIC,
  FILTER_GRAPH_PQ,
  PROFILES,
  isKnownProfileId,
  getFilterGraph,
} = require('./b-profile.cjs');

const MAX_PROGRESS_BYTES = 64 * 1024;

// Keep tone-map profile graphs frozen; append only the narrowly-scoped SDR side-data cleanup.
const OUTPUT_SANITIZATION_TYPES = [
  'MASTERING_DISPLAY_METADATA',
  'CONTENT_LIGHT_LEVEL',
  'DYNAMIC_HDR_PLUS',
  'DOVI_RPU_BUFFER',
  'DOVI_METADATA',
  'DYNAMIC_HDR_VIVID',
  'AMBIENT_VIEWING_ENVIRONMENT',
];
const OUTPUT_SANITIZATION_SUFFIX = OUTPUT_SANITIZATION_TYPES
  .map((type) => `sidedata=mode=delete:type=${type}`)
  .join(',');

function getRepoRoot() {
  return path.resolve(__dirname, '..');
}

function getFfmpegAbsolute() {
  const repoRoot = getRepoRoot();
  const p = path.resolve(repoRoot, 'tools', 'ffmpeg');
  return p;
}

function hasExactToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`).test(text);
}

function checkCapability(ffmpegPath, profileId = PROFILE_ID_LOCAL_B) {
  // Returns { ok: boolean, reason?: string }. Validate the profile before any probe.
  if (!isKnownProfileId(profileId)) return { ok: false, reason: 'profile_unavailable' };
  try {
    const st = fs.statSync(ffmpegPath);
    if (!st.isFile()) return { ok: false, reason: 'profile_unavailable' };
    fs.accessSync(ffmpegPath, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: 'profile_unavailable' };
  }
  try {
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'filter=libplacebo'], { encoding: 'utf8', timeout: 5000, shell: false });
    if (r.error) throw r.error;
    const libplaceboHelp = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0 && !libplaceboHelp) return { ok: false, reason: 'profile_unavailable' };
    if (!hasExactToken(libplaceboHelp, 'Filter libplacebo')) return { ok: false, reason: 'profile_unavailable' };
    const common = ['tonemapping', 'gamut_mode', 'perceptual'];
    for (const tok of common) {
      if (!hasExactToken(libplaceboHelp, tok)) return { ok: false, reason: 'profile_unavailable' };
    }
    let profileRequirements;
    if (profileId === PROFILE_ID_LOCAL_B) {
      profileRequirements = ['spline', 'tonemapping_param'];
    } else if (profileId === PROFILE_ID_GENERIC) {
      profileRequirements = ['bt.2390'];
    } else if (profileId === PROFILE_ID_PQ) {
      profileRequirements = ['bt.2390', 'perceptual', 'peak_detect'];
    } else {
      return { ok: false, reason: 'profile_unavailable' };
    }
    for (const tok of profileRequirements) {
      if (!hasExactToken(libplaceboHelp, tok)) return { ok: false, reason: 'profile_unavailable' };
    }
  } catch {
    return { ok: false, reason: 'profile_unavailable' };
  }
  // Every SDR profile uses this exact, narrow sanitation suffix. Probe the filter and
  // every enum named by the suffix before any conversion process can be spawned.
  try {
    const rSideData = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'filter=sidedata'], { encoding: 'utf8', timeout: 5000, shell: false });
    if (rSideData.error) throw rSideData.error;
    const sideDataHelp = `${rSideData.stdout || ''}${rSideData.stderr || ''}`;
    if (rSideData.status !== 0 && !sideDataHelp) return { ok: false, reason: 'profile_unavailable' };
    if (!hasExactToken(sideDataHelp, 'Filter sidedata')) return { ok: false, reason: 'profile_unavailable' };
    for (const type of OUTPUT_SANITIZATION_TYPES) {
      if (!hasExactToken(sideDataHelp, type)) return { ok: false, reason: 'profile_unavailable' };
    }
  } catch {
    return { ok: false, reason: 'profile_unavailable' };
  }
  if (profileId === PROFILE_ID_LOCAL_B) {
    try {
      const r2 = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'filter=eq'], { encoding: 'utf8', timeout: 5000, shell: false });
      if (r2.error) throw r2.error;
      const eqHelp = `${r2.stdout || ''}${r2.stderr || ''}`;
      if (r2.status !== 0 && !eqHelp) return { ok: false, reason: 'profile_unavailable' };
      if (!hasExactToken(eqHelp, 'Filter eq')) return { ok: false, reason: 'profile_unavailable' };
      if (!hasExactToken(eqHelp, 'gamma')) return { ok: false, reason: 'profile_unavailable' };
    } catch {
      return { ok: false, reason: 'profile_unavailable' };
    }
  }
  // Locked H.264/AAC capability for every profile (no fallback)
  try {
    const r264 = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'encoder=libx264'], { encoding: 'utf8', timeout: 5000, shell: false });
    if (r264.error) throw r264.error;
    const h264Help = `${r264.stdout || ''}${r264.stderr || ''}`;
    if (r264.status !== 0 && !h264Help) return { ok: false, reason: 'profile_unavailable' };
    if (!hasExactToken(h264Help, 'Encoder libx264')) return { ok: false, reason: 'profile_unavailable' };
  } catch {
    return { ok: false, reason: 'profile_unavailable' };
  }
  try {
    const rAac = spawnSync(ffmpegPath, ['-hide_banner', '-h', 'encoder=aac'], { encoding: 'utf8', timeout: 5000, shell: false });
    if (rAac.error) throw rAac.error;
    const aacHelp = `${rAac.stdout || ''}${rAac.stderr || ''}`;
    if (rAac.status !== 0 && !aacHelp) return { ok: false, reason: 'profile_unavailable' };
    if (!hasExactToken(aacHelp, 'Encoder aac')) return { ok: false, reason: 'profile_unavailable' };
  } catch {
    return { ok: false, reason: 'profile_unavailable' };
  }
  return { ok: true };
}

function buildFfmpegArgs(sourcePath, stagingPath, profileId) {
  const effective = profileId === undefined ? PROFILE_ID_LOCAL_B : profileId;
  if (!isKnownProfileId(effective)) {
    throw new Error('unknown_profile');
  }
  const profileGraph = getFilterGraph(effective);
  if (!profileGraph) throw new Error('unknown_profile');
  const vf = `${profileGraph},${OUTPUT_SANITIZATION_SUFFIX}`;
  return [
    '-nostdin',
    '-loglevel', 'error',
    '-progress', 'pipe:1',
    '-i', sourcePath,
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', vf,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-fps_mode', 'passthrough',
    '-movflags', '+faststart+write_colr',
    '-n',
    stagingPath,
  ];
}

function parseProgressLine(line, state) {
  // bounded progress parsing: expect key=value lines
  // We collect out_time_ms or frame or progress
  const idx = line.indexOf('=');
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const val = line.slice(idx + 1).trim();
  if (key === 'out_time_ms') {
    const ms = parseInt(val, 10);
    if (!isNaN(ms)) {
      state.outTimeMs = ms;
    }
  } else if (key === 'progress') {
    if (val === 'continue') return 'continue';
    if (val === 'end') return 'end';
  }
  return null;
}

function runBConversion(opts) {
  const { sourcePath, stagingPath, profileId, onProgress, abortSignal, ffmpegPath: overrideFfmpeg } = opts;
  const effectiveProfile = profileId === undefined ? PROFILE_ID_LOCAL_B : profileId;
  if (!isKnownProfileId(effectiveProfile)) {
    // Unknown profile fails closed immediately, no ffmpeg spawn
    return Promise.resolve({ outcome: 'error', reason: 'invalid_request' });
  }
  const ffmpegPath = overrideFfmpeg || getFfmpegAbsolute();
  return new Promise((resolve) => {
    const cap = checkCapability(ffmpegPath, effectiveProfile);
    if (!cap.ok) {
      resolve({ outcome: 'error', reason: 'profile_unavailable' });
      return;
    }

    // Validate source/staging are absolute?
    // Caller ensures revalidation.

    let args;
    try {
      args = buildFfmpegArgs(sourcePath, stagingPath, effectiveProfile);
    } catch {
      resolve({ outcome: 'error', reason: 'invalid_request' });
      return;
    }
    let child;
    try {
      child = spawn(ffmpegPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ outcome: 'error', reason: 'conversion_failed' });
      return;
    }

    let stdoutBuf = '';
    let stderrBound = Buffer.alloc(0);
    const maxErr = 32 * 1024;
    let progressBytes = 0;
    let finished = false;

    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };

    const onAbort = () => {
      if (finished) return;
      try { child.kill('SIGKILL'); } catch {}
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        try { child.kill('SIGKILL'); } catch {}
      } else {
        abortSignal.addEventListener('abort', onAbort);
      }
    }

    const state = {};

    child.stdout.on('data', (chunk) => {
      if (progressBytes + chunk.length > MAX_PROGRESS_BYTES) {
        // bound: ignore excess but keep parsing limited
        chunk = chunk.slice(0, MAX_PROGRESS_BYTES - progressBytes);
        if (chunk.length === 0) return;
      }
      progressBytes += chunk.length;
      stdoutBuf += chunk.toString('utf8');
      let lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        parseProgressLine(trimmed, state);
        if (onProgress && state.outTimeMs != null) {
          // Estimate percent? We don't have duration; just send pulse
          // Renderer will show phase converting with bounded percent if available
          // We emit progress with state.outTimeMs but don't leak path
          // For bounded, cap calls
          try { onProgress({ outTimeMs: state.outTimeMs }); } catch {}
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBound.length < maxErr) {
        const remain = maxErr - stderrBound.length;
        const slice = chunk.slice(0, remain);
        stderrBound = Buffer.concat([stderrBound, slice]);
      }
    });

    child.on('error', () => {
      if (finished) return;
      finished = true;
      cleanup();
      // Never return stderr/path
      resolve({ outcome: 'error', reason: 'conversion_failed' });
    });

    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (signal === 'SIGKILL' || (abortSignal && abortSignal.aborted)) {
        resolve({ outcome: 'cancelled', reason: 'cancelled' });
        return;
      }
      if (code !== 0) {
        resolve({ outcome: 'error', reason: 'conversion_failed' });
        return;
      }
      resolve({ outcome: 'success' });
    });
  });
}

module.exports = {
  getFfmpegAbsolute,
  checkCapability,
  buildFfmpegArgs,
  runBConversion,
  FILTER_GRAPH,
  PROFILE_ID,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  FILTER_GRAPH_LOCAL_B,
  FILTER_GRAPH_GENERIC,
  FILTER_GRAPH_PQ,
  PROFILES,
  isKnownProfileId,
  getFilterGraph,
  OUTPUT_SANITIZATION_SUFFIX,
};
