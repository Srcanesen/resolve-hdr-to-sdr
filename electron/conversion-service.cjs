const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const {
  PROFILE_ID,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  FILTER_GRAPH,
  FILTER_GRAPH_LOCAL_B,
  FILTER_GRAPH_GENERIC,
  FILTER_GRAPH_PQ,
  PROFILES,
  ALLOWED_PROFILE_IDS,
  isKnownProfileId,
  getFilterGraph,
} = require('./b-profile.cjs');
const outputStore = require('./output-store.cjs');
const bExecutor = require('./b-executor.cjs');
const inspectionAdapter = require('./inspection-adapter.cjs');

const CONVERT_START_CHANNEL = 'hdrtosdr:convert:start';
const CONVERT_CANCEL_CHANNEL = 'hdrtosdr:convert:cancel';
const CONVERT_EVENT_CHANNEL = 'hdrtosdr:convert:event';
const OUTPUT_DRAG_CHANNEL = 'hdrtosdr:output-drag:start';
const THUMBNAIL_CHANNEL = 'hdrtosdr:output:thumbnail';
const MAX_THUMB_BYTES = 700 * 1024;
const MAX_THUMB_DATAURL = 950 * 1024;

function isValidConvertStartRequest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 3) return false;
  if (obj.version !== 1) return false;
  if (typeof obj.sourceId !== 'string' || obj.sourceId.length === 0 || obj.sourceId.length > 200) return false;
  if (typeof obj.profileId !== 'string' || obj.profileId.length === 0) return false;
  if (!keys.includes('version') || !keys.includes('sourceId') || !keys.includes('profileId')) return false;
  const allowed = new Set(['version', 'sourceId', 'profileId']);
  for (const k of keys) if (!allowed.has(k)) return false;
  if (!isKnownProfileId(obj.profileId)) return false;
  // Tighten sourceId to UUID-shaped random IDs (crypto.randomUUID)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.sourceId)) return false;
  return true;
}

function isValidConvertCancelRequest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 2) return false;
  if (obj.version !== 1) return false;
  if (typeof obj.jobId !== 'string' || obj.jobId.length === 0 || obj.jobId.length > 200) return false;
  const allowed = new Set(['version', 'jobId']);
  for (const k of keys) if (!allowed.has(k)) return false;
  return true;
}

function isValidOutputDragRequest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 2) return false;
  if (obj.version !== 1) return false;
  if (typeof obj.outputId !== 'string' || obj.outputId.length === 0 || obj.outputId.length > 200) return false;
  const allowed = new Set(['version', 'outputId']);
  for (const k of keys) if (!allowed.has(k)) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.outputId)) return false;
  return true;
}

function isValidThumbnailRequest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 2) return false;
  if (obj.version !== 1) return false;
  if (typeof obj.outputId !== 'string' || obj.outputId.length === 0 || obj.outputId.length > 200) return false;
  const allowed = new Set(['version', 'outputId']);
  for (const k of keys) if (!allowed.has(k)) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj.outputId)) return false;
  return true;
}

function isValidThumbnailResponse(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.outcome === 'ok') {
    if (Object.keys(obj).length !== 2) return false;
    if (typeof obj.dataUrl !== 'string' || obj.dataUrl.length === 0) return false;
    if (obj.dataUrl.length > MAX_THUMB_DATAURL) return false;
    if (!obj.dataUrl.startsWith('data:image/jpeg;base64,') && !obj.dataUrl.startsWith('data:image/png;base64,')) return false;
    const forbidden = ['path', 'sourcePath', 'outputPath', 'stderr', 'argv', 'ffmpeg', 'canonicalPath'];
    for (const f of forbidden) if (f in obj) return false;
    return true;
  }
  if (obj.outcome === 'error') {
    if (Object.keys(obj).length !== 2) return false;
    if (typeof obj.reason !== 'string' || obj.reason.length === 0 || obj.reason.length > 200) return false;
    const forbidden = ['path', 'sourcePath', 'outputPath', 'stderr', 'argv', 'ffmpeg', 'canonicalPath', 'dataUrl'];
    for (const f of forbidden) if (f in obj) return false;
    return true;
  }
  return false;
}

function isValidConvertEvent(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.version !== 1) return false;
  if (typeof obj.jobId !== 'string' || obj.jobId.length === 0) return false;
  if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq) || obj.seq < 0) return false;
  if (typeof obj.phase !== 'string' || obj.phase.length === 0) return false;
  const allowedPhases = new Set(['queued', 'converting', 'verifying', 'done', 'error', 'cancelled']);
  if (!allowedPhases.has(obj.phase)) return false;
  // status field
  if (typeof obj.status !== 'string') return false;
  const allowedStatus = new Set(['running', 'success', 'error', 'cancelled']);
  if (!allowedStatus.has(obj.status)) return false;
  // optional progress
  if ('percent' in obj) {
    if (typeof obj.percent !== 'number' || obj.percent < 0 || obj.percent > 100) return false;
  }
  if ('displayName' in obj) {
    if (typeof obj.displayName !== 'string' || obj.displayName.length === 0) return false;
  }
  if ('profileId' in obj) {
    if (!isKnownProfileId(obj.profileId)) return false;
  }
  if ('outputId' in obj) {
    if (typeof obj.outputId !== 'string' || obj.outputId.length === 0) return false;
  }
  if ('reason' in obj) {
    if (typeof obj.reason !== 'string' || obj.reason.length === 0 || obj.reason.length > 200) return false;
  }
  // No path leakage: must not contain path, stderr, sourcePath, outputPath etc
  const forbidden = ['path', 'sourcePath', 'outputPath', 'stderr', 'argv', 'ffmpeg'];
  for (const f of forbidden) if (f in obj) return false;
  // Check no extra unknown keys beyond allowlist
  const allowedKeys = new Set(['version', 'jobId', 'seq', 'phase', 'status', 'percent', 'displayName', 'profileId', 'outputId', 'reason']);
  for (const k of Object.keys(obj)) if (!allowedKeys.has(k)) return false;
  return true;
}

class ConversionService {
  constructor(opts = {}) {
    this.sourceTokens = new Map(); // sourceId -> token
    this.windowTokens = new Map(); // webContentsId -> sourceId (latest)
    this.jobs = new Map(); // jobId -> job
    this.outputs = new Map(); // outputId -> { canonicalPath, canonicalOutputRoot, displayName, ownerWebContentsId, verified:true }
    this.activeJobByWindow = new Map(); // webContentsId -> jobId
    this.dependencies = {
      fs: opts.fs || fs,
      path: opts.path || path,
      crypto: opts.crypto || crypto,
      inspectionAdapter: opts.inspectionAdapter || inspectionAdapter,
      bExecutor: opts.bExecutor || bExecutor,
      outputStore: opts.outputStore || outputStore,
      // for testing: stub verifier
      verifierRunner: opts.verifierRunner || null,
    };
  }

  // Create source token after successful eligible inspection
  createSourceToken({ canonicalPath, sha256, size, profileId, ownerWebContentsId, displayName }) {
    // Invalidate prior token for same window
    const prior = this.windowTokens.get(ownerWebContentsId);
    if (prior) {
      this.sourceTokens.delete(prior);
    }
    const sourceId = crypto.randomUUID();
    const token = {
      sourceId,
      canonicalPath,
      sha256,
      size,
      profileId,
      ownerWebContentsId,
      displayName,
      createdAt: Date.now(),
    };
    this.sourceTokens.set(sourceId, token);
    this.windowTokens.set(ownerWebContentsId, sourceId);
    return sourceId;
  }

  invalidateForWindow(webContentsId) {
    const prior = this.windowTokens.get(webContentsId);
    if (prior) {
      this.sourceTokens.delete(prior);
      this.windowTokens.delete(webContentsId);
    }
  }

  getSourceToken(sourceId) {
    return this.sourceTokens.get(sourceId) || null;
  }

  // Validation helper for source path before spawn (canonical, regular, non-symlink, extension, <=32MiB)
  // Hardened: rejects final symlink, any symlink parent up to trust boundary, and requires realpath equality.
  validateSourcePathForSpawn(canonicalPath) {
    try {
      const p = path.resolve(canonicalPath);
      if (!path.isAbsolute(p)) return { ok: false, reason: 'invalid_source' };
      const ext = path.extname(p).toLowerCase();
      if (ext !== '.mov' && ext !== '.mp4') return { ok: false, reason: 'invalid_source' };
      // Reject final symlink
      const lst = fs.lstatSync(p);
      if (lst.isSymbolicLink()) return { ok: false, reason: 'invalid_source' };
      if (!lst.isFile()) return { ok: false, reason: 'invalid_source' };
      // Reject any symlink parent between canonical path and stable trust boundary (fs root)
      // Whitelist known macOS system aliases (/tmp -> /private/tmp, /var -> /private/var, /etc -> /private/etc)
      const WHITELISTED_SYMLINKS = new Set(['/tmp', '/var', '/etc', '/private']);
      const root = path.parse(p).root;
      let dir = path.dirname(p);
      let depth = 0;
      const MAX_DEPTH = 256;
      while (dir && dir !== root && depth < MAX_DEPTH) {
        let st;
        try {
          st = fs.lstatSync(dir);
        } catch {
          return { ok: false, reason: 'invalid_source' };
        }
        if (st.isSymbolicLink() && !WHITELISTED_SYMLINKS.has(dir)) {
          // Also allow /private/var etc. subpaths? Check if realpath resolves to same prefix alias
          const realDir = (() => { try { return fs.realpathSync(dir); } catch { return null; } })();
          const isAlias = (dir === '/var' && realDir === '/private/var') || (dir === '/tmp' && realDir === '/private/tmp');
          if (!isAlias) return { ok: false, reason: 'invalid_source' };
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        depth++;
      }
      if (depth >= MAX_DEPTH) return { ok: false, reason: 'invalid_source' };
      // Require current canonical realpath to equal registered canonical source path (alias-aware)
      const real = fs.realpathSync(p);
      if (real !== p) {
        // Allow system alias normalization /var -> /private/var, /tmp -> /private/tmp
        const aliasNormalized = p.replace(/^\/var\//, '/private/var/').replace(/^\/tmp\//, '/private/tmp/').replace(/^\/var$/, '/private/var').replace(/^\/tmp$/, '/private/tmp');
        if (real !== aliasNormalized) return { ok: false, reason: 'invalid_source' };
      }
      const st = fs.statSync(real);
      if (!st.isFile()) return { ok: false, reason: 'invalid_source' };
      return { ok: true, canonical: real };
    } catch {
      return { ok: false, reason: 'invalid_source' };
    }
  }

  // For DI in tests: allow injecting inspect function
  async revalidateSourceToken(sourceId, senderWebContentsId) {
    const token = this.sourceTokens.get(sourceId);
    if (!token) return { ok: false, reason: 'invalid_request' };
    if (token.ownerWebContentsId !== senderWebContentsId) return { ok: false, reason: 'invalid_request' };
    if (!isKnownProfileId(token.profileId)) return { ok: false, reason: 'invalid_request' };
    // Recheck path
    const pathCheck = this.validateSourcePathForSpawn(token.canonicalPath);
    if (!pathCheck.ok) return { ok: false, reason: 'invalid_request' };
    const canonical = pathCheck.canonical;
    // Require current canonical realpath equals registered canonical source path (no substitution, alias-aware for /var↔/private/var)
    const normalizedToken = token.canonicalPath.replace(/^\/var\//, '/private/var/').replace(/^\/tmp\//, '/private/tmp/').replace(/^\/var$/, '/private/var').replace(/^\/tmp$/, '/private/tmp');
    if (canonical !== token.canonicalPath && canonical !== normalizedToken) return { ok: false, reason: 'invalid_request' };
    // Re-inspect via private Python CLI seam
    let inspected;
    try {
      inspected = await this.dependencies.inspectionAdapter.inspect(canonical);
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    if (!inspected || inspected.outcome !== 'complete') return { ok: false, reason: 'invalid_request' };
    const r = inspected.result;
    if (!r) return { ok: false, reason: 'invalid_request' };
    // Validate classification/profile is eligible and matches token (all profiles)
    const isLocal = r.classification === 'hlgKnownLocal' && r.canConvert === true && r.profileId === PROFILE_ID_LOCAL_B;
    const isGeneric = r.classification === 'hlgSupported' && r.canConvert === true && r.profileId === PROFILE_ID_GENERIC;
    const isPq = r.classification === 'pqSupported' && r.canConvert === true && r.profileId === PROFILE_ID_PQ;
    if (!isLocal && !isGeneric && !isPq) {
      return { ok: false, reason: 'invalid_request' };
    }
    if (r.profileId !== token.profileId) {
      return { ok: false, reason: 'invalid_request' };
    }
    if (r.sha256 !== token.sha256 || r.size !== token.size) {
      return { ok: false, reason: 'invalid_request' };
    }
    return { ok: true, canonical, inspectedResult: r };
  }

  // Job lifecycle
  async startJob({ sourceId, profileId, senderWebContents }) {
    const senderId = senderWebContents.id;
    // enforce single active per window and global single active conversion?
    // Check if any active job globally or for this window
    if (this.activeJobByWindow.has(senderId)) {
      return { ok: false, reason: 'busy' };
    }
    // Also check global single active: if any job is running
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        return { ok: false, reason: 'busy' };
      }
    }

    if (!isKnownProfileId(profileId)) {
      return { ok: false, reason: 'invalid_request' };
    }
    const reval = await this.revalidateSourceToken(sourceId, senderId);
    if (!reval.ok) {
      return { ok: false, reason: 'invalid_request' };
    }
    // Requested profile must match revalidated/token profile strictly
    if (profileId !== reval.inspectedResult.profileId) {
      return { ok: false, reason: 'invalid_request' };
    }

    const jobId = crypto.randomUUID();
    const seqHolder = { seq: 0 };
    const job = {
      jobId,
      sourceId,
      senderId,
      senderWebContents,
      status: 'running',
      seq: 0,
      stagingPath: null,
      finalPath: null,
      outputId: null,
      abortController: new AbortController(),
    };
    this.jobs.set(jobId, job);
    this.activeJobByWindow.set(senderId, jobId);

    const emit = (payload) => {
      payload.version = 1;
      payload.jobId = jobId;
      payload.seq = seqHolder.seq++;
      // validate before send
      if (!isValidConvertEvent(payload)) {
        // fallback to error event
        return;
      }
      try {
        senderWebContents.send(CONVERT_EVENT_CHANNEL, payload);
      } catch {}
      job.seq = payload.seq;
    };

    // Prepare output root and staging only on user click (here)
    let outputRoot;
    try {
      outputRoot = this.dependencies.outputStore.ensureOutputRoot();
    } catch {
      this.jobs.delete(jobId);
      this.activeJobByWindow.delete(senderId);
      emit({ phase: 'error', status: 'error', reason: 'conversion_failed' });
      return { ok: false, reason: 'conversion_failed' };
    }

    const expectedProfile = reval.inspectedResult.profileId;
    // Ensure expectedProfile is known and matches requested
    if (!isKnownProfileId(expectedProfile) || expectedProfile !== profileId) {
      this.jobs.delete(jobId);
      this.activeJobByWindow.delete(senderId);
      emit({ phase: 'error', status: 'error', reason: 'invalid_request' });
      return { ok: false, reason: 'invalid_request' };
    }

    const displayNameBase = reval.inspectedResult.displayName || path.basename(reval.canonical);
    let displayName;
    try {
      displayName = this.dependencies.outputStore.buildDisplayName(displayNameBase, expectedProfile);
    } catch {
      this.jobs.delete(jobId);
      this.activeJobByWindow.delete(senderId);
      emit({ phase: 'error', status: 'error', reason: 'invalid_request' });
      return { ok: false, reason: 'invalid_request' };
    }
    const finalPath = this.dependencies.outputStore.allocateUniqueFinalPath(outputRoot, displayName);
    const stagingPath = this.dependencies.outputStore.getStagingPath(outputRoot, finalPath);
    job.stagingPath = stagingPath;
    job.finalPath = finalPath;
    job.displayName = displayName;
    job.profileId = expectedProfile;

    // ensure no overwrite: staging should not exist, final should not exist (already allocated unique)
    // Create empty staging placeholder? executor will write via -n guard

    // Emit queued -> converting
    emit({ phase: 'queued', status: 'running', profileId: expectedProfile });
    emit({ phase: 'converting', status: 'running', profileId: expectedProfile, percent: 0 });

    // Run executor async
    (async () => {
      try {
        const ffmpegPath = this.dependencies.bExecutor.getFfmpegAbsolute
          ? this.dependencies.bExecutor.getFfmpegAbsolute()
          : path.resolve(getRepoRoot(), 'tools', 'ffmpeg');

        const result = await this.dependencies.bExecutor.runBConversion({
          sourcePath: reval.canonical,
          stagingPath,
          profileId: expectedProfile,
          ffmpegPath,
          onProgress: () => {
            emit({ phase: 'converting', status: 'running', profileId: expectedProfile, percent: 50 });
          },
          abortSignal: job.abortController.signal,
        });

        if (result.outcome === 'cancelled') {
          this.dependencies.outputStore.removeStaging(stagingPath);
          emit({ phase: 'cancelled', status: 'cancelled', reason: 'cancelled' });
          job.status = 'cancelled';
          this.jobs.delete(jobId);
          this.activeJobByWindow.delete(senderId);
          return;
        }
        if (result.outcome !== 'success') {
          this.dependencies.outputStore.removeStaging(stagingPath);
          const reason = result.reason === 'profile_unavailable' ? 'profile_unavailable' : 'conversion_failed';
          emit({ phase: 'error', status: 'error', reason });
          job.status = 'error';
          this.jobs.delete(jobId);
          this.activeJobByWindow.delete(senderId);
          return;
        }

        // Verify staging exists and non-empty
        try {
          const st = fs.statSync(stagingPath);
          if (!st.isFile() || st.size === 0) throw new Error('missing staging');
        } catch {
          this.dependencies.outputStore.removeStaging(stagingPath);
          emit({ phase: 'error', status: 'error', reason: 'conversion_failed' });
          job.status = 'error';
          this.jobs.delete(jobId);
          this.activeJobByWindow.delete(senderId);
          return;
        }

        emit({ phase: 'verifying', status: 'running', profileId: expectedProfile });

        // Run verifier – generalized to receive expected profile ID (argv safe: spawn with array)
        const verifierPath = path.resolve(getRepoRoot(), 'scripts', 'verify-spike.sh');
        let verifierExit = 1;
        try {
          if (this.dependencies.verifierRunner) {
            verifierExit = await this.dependencies.verifierRunner(reval.canonical, stagingPath, verifierPath, expectedProfile);
          } else {
            const proc = spawn(verifierPath, [reval.canonical, stagingPath, expectedProfile], { shell: false, stdio: 'ignore' });
            verifierExit = await new Promise((res) => {
              proc.on('close', (code) => res(code === 0 ? 0 : 1));
              proc.on('error', () => res(1));
            });
          }
        } catch {
          verifierExit = 1;
        }

        if (verifierExit !== 0) {
          this.dependencies.outputStore.removeStaging(stagingPath);
          emit({ phase: 'error', status: 'error', reason: 'verification_failed' });
          job.status = 'error';
          this.jobs.delete(jobId);
          this.activeJobByWindow.delete(senderId);
          return;
        }

        // Atomic no-clobber commit: hard-link staging -> final (same directory regular files), then unlink staging. Never overwrite existing final.
        let committedFinalPath = finalPath;
        let commitOk = false;
        try {
          const MAX_COMMIT_ATTEMPTS = 100;
          let attemptPath = finalPath;
          for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
            try {
              fs.linkSync(stagingPath, attemptPath);
              try { fs.unlinkSync(stagingPath); } catch {}
              committedFinalPath = attemptPath;
              job.finalPath = attemptPath;
              commitOk = true;
              break;
            } catch (e) {
              if (e && e.code === 'EEXIST') {
                // Final already exists (race) — allocate next collision suffix bounded
                try {
                  const next = this.dependencies.outputStore.allocateUniqueFinalPath(outputRoot, displayName);
                  // If allocate returns same as attemptPath (should be new), force suffix bump
                  if (next === attemptPath) {
                    const ext = path.extname(displayName);
                    const base = displayName.slice(0, -ext.length);
                    const rand = crypto.randomBytes(3).toString('hex');
                    attemptPath = path.join(outputRoot, `${base}_${rand}${ext}`);
                  } else {
                    attemptPath = next;
                  }
                } catch {
                  const ext = path.extname(displayName);
                  const base = displayName.slice(0, -ext.length);
                  const rand = crypto.randomBytes(3).toString('hex');
                  attemptPath = path.join(outputRoot, `${base}_${rand}${ext}`);
                }
                continue;
              }
              throw e;
            }
          }
          if (!commitOk) throw new Error('commit failed after retries');
        } catch {
          this.dependencies.outputStore.removeStaging(stagingPath);
          emit({ phase: 'error', status: 'error', reason: 'conversion_failed' });
          job.status = 'error';
          this.jobs.delete(jobId);
          this.activeJobByWindow.delete(senderId);
          return;
        }

        // Issue outputId only after verifier PASS — store opaque verified record with canonical root and owner
        const outputId = crypto.randomUUID();
        // Canonicalize committed path and root for drag revalidation (TOCTOU-safe, non-symlink)
        let canonicalPathStored = committedFinalPath;
        try { canonicalPathStored = fs.realpathSync(committedFinalPath); } catch { canonicalPathStored = path.resolve(committedFinalPath); }
        let canonicalRootStored = outputRoot;
        try { canonicalRootStored = fs.realpathSync(outputRoot); } catch { canonicalRootStored = path.resolve(outputRoot); }
        this.outputs.set(outputId, {
          canonicalPath: canonicalPathStored,
          canonicalOutputRoot: canonicalRootStored,
          displayName: path.basename(committedFinalPath),
          ownerWebContentsId: senderId,
          verified: true,
        });
        job.outputId = outputId;
        job.status = 'success';
        emit({
          phase: 'done',
          status: 'success',
          displayName: path.basename(committedFinalPath),
          profileId: expectedProfile,
          outputId,
        });
        // Keep job for possible cleanup? Remove from active but retain? For cancellation handling remove.
        this.jobs.delete(jobId);
        this.activeJobByWindow.delete(senderId);
      } catch {
        try { this.dependencies.outputStore.removeStaging(stagingPath); } catch {}
        emit({ phase: 'error', status: 'error', reason: 'conversion_failed' });
        job.status = 'error';
        this.jobs.delete(jobId);
        this.activeJobByWindow.delete(senderId);
      }
    })();

    return { ok: true, jobId };
  }

  async cancelJob({ jobId, senderWebContents }) {
    const senderId = senderWebContents.id;
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'invalid_request' };
    if (job.senderId !== senderId) return { ok: false, reason: 'invalid_request' };
    try {
      job.abortController.abort();
    } catch {}
    // staging cleanup will happen in run loop; also try immediate
    // Do not delete job here; run loop will emit cancelled and cleanup
    return { ok: true };
  }

  // Verified-output-only drag revalidation: returns filesystem path only internally, never renderer
  resolveOutputForDrag({ outputId, senderWebContentsId }) {
    const rec = this.outputs.get(outputId);
    if (!rec) return { ok: false };
    if (!rec.verified) return { ok: false };
    if (rec.ownerWebContentsId !== senderWebContentsId) return { ok: false };
    // Canonical non-symlink output root revalidation
    try {
      const lstRoot = fs.lstatSync(rec.canonicalOutputRoot);
      if (lstRoot.isSymbolicLink() || !lstRoot.isDirectory()) return { ok: false };
      const realRoot = fs.realpathSync(rec.canonicalOutputRoot);
      if (realRoot !== path.resolve(rec.canonicalOutputRoot) || realRoot !== rec.canonicalOutputRoot) return { ok: false };
    } catch {
      return { ok: false };
    }
    // Use non-creating boundary helper if available, otherwise direct checks
    try {
      if (this.dependencies.outputStore && typeof this.dependencies.outputStore.isSafeOutputFile === 'function') {
        const safe = this.dependencies.outputStore.isSafeOutputFile(rec.canonicalPath, rec.canonicalOutputRoot);
        if (!safe) return { ok: false };
      } else {
        // Fallback direct checks
        const lst = fs.lstatSync(rec.canonicalPath);
        if (lst.isSymbolicLink() || !lst.isFile()) return { ok: false };
        const real = fs.realpathSync(rec.canonicalPath);
        if (real !== rec.canonicalPath) return { ok: false };
        const rel = path.relative(rec.canonicalOutputRoot, real);
        if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return { ok: false };
      }
    } catch {
      return { ok: false };
    }
    // Current realpath equals stored canonical (TOCTOU)
    try {
      const curReal = fs.realpathSync(rec.canonicalPath);
      if (curReal !== rec.canonicalPath) return { ok: false };
      // Also verify regular non-symlink via lstat already, and stat is file
      const st = fs.statSync(curReal);
      if (!st.isFile()) return { ok: false };
    } catch {
      return { ok: false };
    }
    // Direct containment already enforced via isSafeOutputFile; additionally ensure parent is root
    // Return path only internally
    return { ok: true, canonicalPath: rec.canonicalPath };
  }

  getOutputRecord(outputId) {
    return this.outputs.get(outputId) || null;
  }

  // Secure thumbnail: only verified output, revalidated ownership + safe file, bounded data URL
  async getThumbnailDataUrl({ outputId, senderWebContentsId }) {
    const resolved = this.resolveOutputForDrag({ outputId, senderWebContentsId });
    if (!resolved || !resolved.ok) return { ok: false, reason: 'invalid_request' };
    const canonicalPath = resolved.canonicalPath;
    // Generate thumbnail best-effort via bundled ffmpeg
    try {
      const ffmpegPath = this.dependencies.bExecutor && typeof this.dependencies.bExecutor.getFfmpegAbsolute === 'function'
        ? this.dependencies.bExecutor.getFfmpegAbsolute()
        : path.resolve(getRepoRoot(), 'tools', 'ffmpeg');
      // Validate ffmpeg binary is executable regular file (fail closed quickly)
      try {
        const st = fs.statSync(ffmpegPath);
        if (!st.isFile()) return { ok: false, reason: 'thumbnail_failed' };
        fs.accessSync(ffmpegPath, fs.constants.X_OK);
      } catch {
        return { ok: false, reason: 'thumbnail_failed' };
      }
      const attempt = (seek) => new Promise((resolve) => {
        const args = [
          '-nostdin', '-loglevel', 'error',
          '-ss', String(seek),
          '-i', canonicalPath,
          '-frames:v', '1',
          '-vf', 'scale=120:68:force_original_aspect_ratio=decrease,pad=120:68:(ow-iw)/2:(oh-ih)/2:color=black',
          '-q:v', '6',
          '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
        ];
        let child;
        try {
          child = spawn(ffmpegPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
          resolve(null);
          return;
        }
        const chunks = [];
        let total = 0;
        let finished = false;
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try { child.kill('SIGKILL'); } catch {}
          resolve(null);
        }, 6000);
        child.stdout.on('data', (c) => {
          if (finished) return;
          if (total + c.length > MAX_THUMB_BYTES) {
            // truncate and kill
            const remain = MAX_THUMB_BYTES - total;
            if (remain > 0) { chunks.push(c.slice(0, remain)); total += remain; }
            finished = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch {}
            resolve(Buffer.concat(chunks));
            return;
          }
          chunks.push(c);
          total += c.length;
        });
        child.stderr.on('data', () => {});
        child.on('error', () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(null);
        });
        child.on('close', (code) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (code !== 0) { resolve(null); return; }
          if (chunks.length === 0 || total === 0) { resolve(null); return; }
          resolve(Buffer.concat(chunks));
        });
      });
      let buf = await attempt('0.5');
      if (!buf || buf.length === 0) buf = await attempt('0');
      if (!buf || buf.length === 0) return { ok: false, reason: 'thumbnail_failed' };
      if (buf.length > MAX_THUMB_BYTES) return { ok: false, reason: 'thumbnail_failed' };
      const b64 = buf.toString('base64');
      const dataUrl = 'data:image/jpeg;base64,' + b64;
      if (dataUrl.length > MAX_THUMB_DATAURL) return { ok: false, reason: 'thumbnail_failed' };
      return { ok: true, dataUrl };
    } catch {
      return { ok: false, reason: 'thumbnail_failed' };
    }
  }

  // For testing: attach IPC
  attachIpc(window) {
    const { ipcMain, dialog } = require('electron');
    const dlg = (this.dependencies && this.dependencies.dialog) || dialog;
    try { ipcMain.removeHandler(CONVERT_START_CHANNEL); } catch {}
    try { ipcMain.removeHandler(CONVERT_CANCEL_CHANNEL); } catch {}

    ipcMain.handle(CONVERT_START_CHANNEL, async (event, req) => {
      if (!window || !window.webContents || event.sender !== window.webContents) {
        return { outcome: 'error', reason: 'invalid_sender' };
      }
      if (!isValidConvertStartRequest(req)) {
        return { outcome: 'error', reason: 'invalid_request' };
      }
      // Explicit user approval via native confirmation dialog immediately before job (renderer click alone not trusted)
      try {
        if (!dlg || typeof dlg.showMessageBox !== 'function') {
          return { outcome: 'cancelled', reason: 'user_cancelled' };
        }
        const result = await dlg.showMessageBox(window, {
          type: 'question',
          buttons: ['Cancel', 'Convert'],
          defaultId: 1,
          cancelId: 0,
          message: 'Convert HDR → SDR',
          detail: 'A separate Rec.709 H.264 MP4 file will be created. The source video is not modified. Compact and compatible.',
          noLink: true,
        });
        const resp = result && typeof result.response === 'number' ? result.response : 0;
        if (resp !== 1) {
          return { outcome: 'cancelled', reason: 'user_cancelled' };
        }
      } catch {
        return { outcome: 'cancelled', reason: 'user_cancelled' };
      }
      const res = await this.startJob({ sourceId: req.sourceId, profileId: req.profileId, senderWebContents: event.sender });
      if (!res.ok) {
        // generic error, never leak path
        if (res.reason === 'busy') return { outcome: 'error', reason: 'busy' };
        return { outcome: 'error', reason: 'invalid_request' };
      }
      return { outcome: 'accepted', jobId: res.jobId };
    });

    ipcMain.handle(CONVERT_CANCEL_CHANNEL, async (event, req) => {
      if (!window || !window.webContents || event.sender !== window.webContents) {
        return { outcome: 'error', reason: 'invalid_sender' };
      }
      if (!isValidConvertCancelRequest(req)) {
        return { outcome: 'error', reason: 'invalid_request' };
      }
      const res = await this.cancelJob({ jobId: req.jobId, senderWebContents: event.sender });
      if (!res.ok) {
        return { outcome: 'error', reason: 'invalid_request' };
      }
      return { outcome: 'cancelled', jobId: req.jobId };
    });

    try { ipcMain.removeHandler(THUMBNAIL_CHANNEL); } catch {}
    ipcMain.handle(THUMBNAIL_CHANNEL, async (event, req) => {
      try {
        if (!window || !window.webContents || event.sender !== window.webContents) {
          return { outcome: 'error', reason: 'invalid_sender' };
        }
        // Require same mainFrame url as drag to reject cross-window callers
        try {
          if (!window.webContents.mainFrame || event.senderFrame !== window.webContents.mainFrame) {
            return { outcome: 'error', reason: 'invalid_sender' };
          }
          const expected = path.resolve(__dirname, 'renderer', 'index.html');
          const expectedUrl = require('url').pathToFileURL(expected).toString();
          const senderUrl = event.senderFrame && event.senderFrame.url;
          if (senderUrl !== expectedUrl) return { outcome: 'error', reason: 'invalid_sender' };
        } catch {
          return { outcome: 'error', reason: 'invalid_sender' };
        }
        if (!isValidThumbnailRequest(req)) {
          return { outcome: 'error', reason: 'invalid_request' };
        }
        const senderId = event.sender && typeof event.sender.id === 'number' ? event.sender.id : null;
        if (senderId == null) return { outcome: 'error', reason: 'invalid_request' };
        const res = await this.getThumbnailDataUrl({ outputId: req.outputId, senderWebContentsId: senderId });
        if (!res || !res.ok) {
          return { outcome: 'error', reason: 'invalid_request' };
        }
        const payload = { outcome: 'ok', dataUrl: res.dataUrl };
        if (!isValidThumbnailResponse(payload)) return { outcome: 'error', reason: 'invalid_request' };
        return payload;
      } catch {
        return { outcome: 'error', reason: 'invalid_request' };
      }
    });
  }
}

function getRepoRoot() {
  return path.resolve(__dirname, '..');
}

module.exports = {
  ConversionService,
  isValidConvertStartRequest,
  isValidConvertCancelRequest,
  isValidConvertEvent,
  isValidOutputDragRequest,
  isValidThumbnailRequest,
  isValidThumbnailResponse,
  CONVERT_START_CHANNEL,
  CONVERT_CANCEL_CHANNEL,
  CONVERT_EVENT_CHANNEL,
  OUTPUT_DRAG_CHANNEL,
  THUMBNAIL_CHANNEL,
  MAX_THUMB_BYTES,
  MAX_THUMB_DATAURL,
  PROFILE_ID,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  ALLOWED_PROFILE_IDS,
  isKnownProfileId,
  PROFILES,
};
