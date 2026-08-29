const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { DEFAULT_HEAVY_OPERATION_POLICY } = require('./heavy-operation-policy.cjs');
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
const DEFAULT_PROGRESS_THROTTLE_MS = 100;
const CAPABILITY_PROBE_TIMEOUT_MS = 5000;
const MAX_CAPABILITY_OUTPUT_BYTES = 128 * 1024;
const capabilityCache = new Map();

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
  // Escape regex metacharacters before applying the token boundary check. In
  // particular, `bt.2390` must not accept `btX2390`.
  const escaped = [...String(token)]
    .map((character) => /[A-Za-z0-9]/.test(character) ? character : `\\${character}`)
    .join('');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`).test(String(text));
}

function unavailableCapability() {
  return { ok: false, reason: 'profile_unavailable' };
}

function probeCapabilityHelp(ffmpegPath, args) {
  return new Promise((resolve) => {
    let child;
    let output = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = () => {
      try { if (child) child.kill('SIGKILL'); } catch {}
      finish(null);
    };
    try {
      child = spawn(ffmpegPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    const collect = (chunk) => {
      if (settled) return;
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output, 'utf8') > MAX_CAPABILITY_OUTPUT_BYTES) fail();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finish(null));
    child.on('close', (status) => finish({ status, output }));
    timer = setTimeout(fail, CAPABILITY_PROBE_TIMEOUT_MS);
  });
}

async function probeCapability(ffmpegPath, profileId) {
  try {
    const st = await fs.promises.stat(ffmpegPath);
    if (!st.isFile()) return unavailableCapability();
    await fs.promises.access(ffmpegPath, fs.constants.X_OK);
  } catch {
    return unavailableCapability();
  }

  const help = async (probeArgs, requiredTokens) => {
    const result = await probeCapabilityHelp(ffmpegPath, probeArgs);
    if (!result || (result.status !== 0 && !result.output)) return null;
    for (const token of requiredTokens) {
      if (!hasExactToken(result.output, token)) return null;
    }
    return result.output;
  };

  const common = await help(
    ['-hide_banner', '-h', 'filter=libplacebo'],
    ['Filter libplacebo', 'tonemapping', 'gamut_mode', 'perceptual'],
  );
  if (common == null) return unavailableCapability();
  let profileRequirements;
  if (profileId === PROFILE_ID_LOCAL_B) {
    profileRequirements = ['spline', 'tonemapping_param'];
  } else if (profileId === PROFILE_ID_GENERIC) {
    profileRequirements = ['bt.2390'];
  } else if (profileId === PROFILE_ID_PQ) {
    profileRequirements = ['bt.2390', 'perceptual', 'peak_detect'];
  } else {
    return unavailableCapability();
  }
  if (!profileRequirements.every((token) => hasExactToken(common, token))) return unavailableCapability();

  const sideData = await help(
    ['-hide_banner', '-h', 'filter=sidedata'],
    ['Filter sidedata', ...OUTPUT_SANITIZATION_TYPES],
  );
  if (sideData == null) return unavailableCapability();

  if (profileId === PROFILE_ID_LOCAL_B) {
    const eq = await help(['-hide_banner', '-h', 'filter=eq'], ['Filter eq', 'gamma']);
    if (eq == null) return unavailableCapability();
  }
  if (await help(['-hide_banner', '-h', 'encoder=libx264'], ['Encoder libx264']) == null) {
    return unavailableCapability();
  }
  if (await help(['-hide_banner', '-h', 'encoder=aac'], ['Encoder aac']) == null) {
    return unavailableCapability();
  }
  return { ok: true };
}

// The cache stores the in-flight promise as well as completed results. The
// executable identity is part of the key so a replacement binary cannot reuse
// a stale capability result.
async function checkCapability(ffmpegPath, profileId = PROFILE_ID_LOCAL_B) {
  if (!isKnownProfileId(profileId) || typeof ffmpegPath !== 'string' || !path.isAbsolute(ffmpegPath)) {
    return unavailableCapability();
  }
  let st;
  try {
    st = await fs.promises.stat(ffmpegPath);
    if (!st.isFile()) return unavailableCapability();
    await fs.promises.access(ffmpegPath, fs.constants.X_OK);
  } catch {
    return unavailableCapability();
  }
  const identity = [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
  const key = `${ffmpegPath}\\0${profileId}\\0${identity}`;
  const cached = capabilityCache.get(key);
  if (cached) return cached;
  const pending = probeCapability(ffmpegPath, profileId).catch(() => unavailableCapability());
  capabilityCache.set(key, pending);
  return pending;
}

function clearCapabilityCache() {
  capabilityCache.clear();
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
  // FFmpeg emits key=value records. The stream can split records at any byte
  // boundary, so callers retain only the current incomplete line.
  const idx = String(line).indexOf('=');
  if (idx === -1) return null;
  const key = String(line).slice(0, idx).trim();
  const val = String(line).slice(idx + 1).trim();
  if (key === 'out_time_ms' || key === 'out_time_us') {
    const micros = Number(val);
    if (Number.isSafeInteger(micros) && micros >= 0) {
      state.outTimeMs = Math.max(state.outTimeMs || 0, micros);
      return 'time';
    }
  } else if (key === 'out_time') {
    const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(val);
    if (match) {
      const fraction = (match[4] || '').slice(0, 6).padEnd(6, '0');
      const micros = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000000 + Number(fraction || 0);
      if (Number.isSafeInteger(micros)) {
        state.outTimeMs = Math.max(state.outTimeMs || 0, micros);
        return 'time';
      }
    }
  } else if (key === 'progress') {
    if (val === 'continue') return 'continue';
    if (val === 'end') return 'end';
  }
  return null;
}

function durationToMicros(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const micros = seconds * 1000000;
  return Number.isSafeInteger(micros) ? micros : null;
}

function calculateProgressPercent(outTimeMs, durationSeconds) {
  const durationMicros = durationToMicros(durationSeconds);
  if (durationMicros == null || !Number.isFinite(outTimeMs) || outTimeMs < 0) return null;
  return Math.max(0, Math.min(99, Math.floor((outTimeMs / durationMicros) * 100)));
}

function makeProgressReporter(onProgress, durationSeconds, throttleMs) {
  let lastSentAt = -Infinity;
  let pending = null;
  let timer = null;
  const effectiveThrottle = Number.isFinite(throttleMs) && throttleMs > 0 ? throttleMs : 0;
  const send = (payload) => {
    try { onProgress(payload); } catch {}
    lastSentAt = Date.now();
  };
  const flush = () => {
    if (!pending) return;
    const payload = pending;
    pending = null;
    if (timer) { clearTimeout(timer); timer = null; }
    send(payload);
  };
  const report = (outTimeMs, force = false) => {
    const payload = { outTimeMs };
    const percent = calculateProgressPercent(outTimeMs, durationSeconds);
    if (percent != null) payload.percent = percent;
    if (force || effectiveThrottle === 0 || Date.now() - lastSentAt >= effectiveThrottle) {
      send(payload);
      return;
    }
    pending = payload;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, Math.max(1, effectiveThrottle - (Date.now() - lastSentAt)));
    }
  };
  report.flush = flush;
  report.clear = () => {
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return report;
}

async function runBConversion(opts) {
  const {
    sourcePath,
    stagingPath,
    profileId,
    onProgress,
    abortSignal,
    ffmpegPath: overrideFfmpeg,
    timeoutMs = DEFAULT_HEAVY_OPERATION_POLICY.conversionTimeoutMs,
    stallTimeoutMs = DEFAULT_HEAVY_OPERATION_POLICY.conversionStallTimeoutMs,
    trackProcess,
    untrackProcess,
    touchActivity,
    killProcess,
    durationSeconds,
    progressThrottleMs = DEFAULT_PROGRESS_THROTTLE_MS,
  } = opts;
  const effectiveProfile = profileId === undefined ? PROFILE_ID_LOCAL_B : profileId;
  if (!isKnownProfileId(effectiveProfile)) {
    return Promise.resolve({ outcome: 'error', reason: 'invalid_request' });
  }
  if (abortSignal && abortSignal.aborted) {
    return Promise.resolve({ outcome: 'cancelled', reason: 'cancelled' });
  }
  const ffmpegPath = overrideFfmpeg || getFfmpegAbsolute();
  const cap = await checkCapability(ffmpegPath, effectiveProfile);
  if (!cap || !cap.ok) return { outcome: 'error', reason: 'profile_unavailable' };
  if (abortSignal && abortSignal.aborted) return { outcome: 'cancelled', reason: 'cancelled' };

  return new Promise((resolve) => {
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
    const stdoutDecoder = new StringDecoder('utf8');
    let stderrBound = Buffer.alloc(0);
    const maxErr = 32 * 1024;
    let finished = false;
    let timeoutTimer = null;
    let stallTimer = null;
    let forcedReason = null;
    const progressReporter = onProgress
      ? makeProgressReporter(onProgress, durationSeconds, progressThrottleMs)
      : null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(stallTimer);
      if (progressReporter) progressReporter.clear();
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      try { if (untrackProcess) untrackProcess(child); } catch {}
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };
    const killChild = () => {
      try {
        if (killProcess) killProcess(child);
        else child.kill('SIGKILL');
      } catch {}
    };
    const onAbort = () => {
      if (finished) return;
      killChild();
    };
    const activity = () => {
      if (finished) return;
      try { if (touchActivity) touchActivity(); } catch {}
      clearTimeout(stallTimer);
      if (stallTimeoutMs > 0) {
        stallTimer = setTimeout(() => {
          forcedReason = 'conversion_stalled';
          killChild();
          finish({ outcome: 'error', reason: forcedReason });
        }, stallTimeoutMs);
      }
    };

    try { if (trackProcess) trackProcess(child); } catch {}
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        forcedReason = 'conversion_timeout';
        killChild();
        finish({ outcome: 'error', reason: forcedReason });
      }, timeoutMs);
    }
    activity();

    const state = {};
    const consumeProgressText = (text) => {
      stdoutBuf += text;
      let newline;
      while ((newline = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, newline);
        stdoutBuf = stdoutBuf.slice(newline + 1);
        if (!line.trim()) continue;
        const priorTime = state.outTimeMs;
        parseProgressLine(line, state);
        if (progressReporter && state.outTimeMs != null && state.outTimeMs !== priorTime) {
          progressReporter(state.outTimeMs);
        }
      }
      // Bound only an incomplete record. Complete records are consumed even
      // when one OS pipe event contains many megabytes of progress output.
      if (Buffer.byteLength(stdoutBuf, 'utf8') > MAX_PROGRESS_BYTES) {
        stdoutBuf = stdoutBuf.slice(-MAX_PROGRESS_BYTES);
      }
    };
    child.stdout.on('data', (chunk) => {
      activity();
      consumeProgressText(stdoutDecoder.write(chunk));
    });

    child.stderr.on('data', (chunk) => {
      activity();
      if (stderrBound.length < maxErr) {
        const remain = maxErr - stderrBound.length;
        stderrBound = Buffer.concat([stderrBound, chunk.slice(0, remain)]);
      }
    });

    child.on('error', () => {
      if (forcedReason) return;
      if (abortSignal && abortSignal.aborted) {
        finish({ outcome: 'cancelled', reason: 'cancelled' });
        return;
      }
      finish({ outcome: 'error', reason: 'conversion_failed' });
    });

    child.on('close', (code, signal) => {
      if (forcedReason) return;
      if (signal === 'SIGKILL' || (abortSignal && abortSignal.aborted)) {
        finish({ outcome: 'cancelled', reason: 'cancelled' });
        return;
      }
      if (code !== 0) {
        if (progressReporter) progressReporter.clear();
        finish({ outcome: 'error', reason: 'conversion_failed' });
        return;
      }
      // Process a final record without a trailing newline and deliver the most
      // recent value before conversion transitions to verification.
      consumeProgressText(stdoutDecoder.end());
      if (stdoutBuf.trim()) {
        const priorTime = state.outTimeMs;
        parseProgressLine(stdoutBuf, state);
        if (progressReporter && state.outTimeMs != null && state.outTimeMs !== priorTime) {
          progressReporter(state.outTimeMs, true);
        }
      }
      if (progressReporter) progressReporter.flush();
      finish({ outcome: 'success' });
    });
  });
}

module.exports = {
  getFfmpegAbsolute,
  checkCapability,
  clearCapabilityCache,
  buildFfmpegArgs,
  parseProgressLine,
  calculateProgressPercent,
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
  MAX_PROGRESS_BYTES,
  DEFAULT_PROGRESS_THROTTLE_MS,
};
