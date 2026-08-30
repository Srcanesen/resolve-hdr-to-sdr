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
const { canonicalizeSafeSourcePath, canonicalPathsEqual } = require('./source-path-policy.cjs');
const {
  DEFAULT_HEAVY_OPERATION_POLICY,
  HeavyOperationCoordinator,
  normalizePolicy,
  markProcessGroupOwned,
} = require('./heavy-operation-policy.cjs');

const CONVERT_START_CHANNEL = 'hdrtosdr:convert:start';
const CONVERT_CANCEL_CHANNEL = 'hdrtosdr:convert:cancel';
const CONVERT_EVENT_CHANNEL = 'hdrtosdr:convert:event';
const OUTPUT_DRAG_CHANNEL = 'hdrtosdr:output-drag:start';
const THUMBNAIL_CHANNEL = 'hdrtosdr:output:thumbnail';
const MAX_THUMB_BYTES = 700 * 1024;
const MAX_THUMB_DATAURL = 950 * 1024;
const CONVERSION_FAILURE_REASONS = new Set(['conversion_failed', 'conversion_timeout', 'conversion_stalled', 'profile_unavailable', 'invalid_request']);
const VERIFICATION_FAILURE_REASONS = new Set(['verification_failed', 'verification_timeout', 'verification_stalled']);
const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;
const PROGRESS_THROTTLE_MS = 100;
const MAX_THUMB_CACHE_ENTRIES = 16;
const MAX_THUMB_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_RECORDS = 128;
const OUTPUT_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

function _sameFileSnapshot(before, after) {
  return before && after
    && before.size === after.size
    && before.ino === after.ino
    && before.dev === after.dev
    && String(before.mtimeNs ?? before.mtimeMs) === String(after.mtimeNs ?? after.mtimeMs);
}

// Hash a regular file while checking that its identity did not change during the read.
// This is intentionally synchronous because native drag must resolve a path synchronously.
function fingerprintFile(filePath, fileSystem = fs, cryptoImpl = crypto) {
  let before;
  try {
    const lst = fileSystem.lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    before = fileSystem.statSync(filePath);
    if (!before.isFile()) return null;
  } catch {
    return null;
  }

  let fd;
  let hash;
  try {
    const hashCrypto = cryptoImpl && typeof cryptoImpl.createHash === 'function' ? cryptoImpl : crypto;
    hash = hashCrypto.createHash('sha256');
  } catch {
    return null;
  }
  const buffer = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
  try {
    fd = fileSystem.openSync(filePath, 'r');
    let position = 0;
    for (;;) {
      const count = fileSystem.readSync(fd, buffer, 0, buffer.length, position);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch {}
    }
  }

  try {
    const after = fileSystem.statSync(filePath);
    if (!after.isFile() || !_sameFileSnapshot(before, after)) return null;
    return { size: after.size, sha256: hash.digest('hex') };
  } catch {
    return null;
  }
}

function sameFingerprint(left, right) {
  return !!left && !!right
    && left.size === right.size
    && left.sha256 === right.sha256;
}

function progressPercent(outTimeMs, durationSeconds) {
  const duration = Number(durationSeconds);
  const output = Number(outTimeMs);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(output) || output < 0) return null;
  return Math.max(0, Math.min(99, Math.floor((output / (duration * 1000000)) * 100)));
}

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
    this.outputs = new Map(); // outputId -> { canonicalPath, canonicalOutputRoot, displayName, ownerWebContentsId, verified:true, fingerprint }
    this.outputRecordLimit = Number.isSafeInteger(opts.maxOutputRecords) && opts.maxOutputRecords > 0
      ? Math.min(opts.maxOutputRecords, MAX_OUTPUT_RECORDS)
      : MAX_OUTPUT_RECORDS;
    this.outputRecordTtlMs = Number.isFinite(opts.outputRecordTtlMs) && opts.outputRecordTtlMs > 0
      ? Math.min(opts.outputRecordTtlMs, 7 * OUTPUT_RECORD_TTL_MS)
      : OUTPUT_RECORD_TTL_MS;
    this.activeJobByWindow = new Map(); // webContentsId -> jobId
    this.thumbnailCache = new Map(); // outputId -> validated {dataUrl, owner, fingerprint}
    this.thumbnailCacheBytes = 0;
    this.thumbnailInFlight = new Map(); // outputId + owner + fingerprint -> shared promise
    this.thumbnailProcesses = new Map(); // ownerWebContentsId -> Set<ChildProcess>
    this.thumbnailOwnerGenerations = new Map();
    this.thumbnailCacheMaxEntries = Number.isSafeInteger(opts.thumbnailCacheMaxEntries) && opts.thumbnailCacheMaxEntries > 0
      ? Math.min(opts.thumbnailCacheMaxEntries, MAX_THUMB_CACHE_ENTRIES)
      : MAX_THUMB_CACHE_ENTRIES;
    this.thumbnailCacheMaxBytes = Number.isSafeInteger(opts.thumbnailCacheMaxBytes) && opts.thumbnailCacheMaxBytes > 0
      ? Math.min(opts.thumbnailCacheMaxBytes, MAX_THUMB_CACHE_BYTES)
      : MAX_THUMB_CACHE_BYTES;
    this.operationPolicy = normalizePolicy(opts);
    this.operationCoordinator = opts.operationCoordinator || new HeavyOperationCoordinator(this.operationPolicy);
    this.activeProcesses = this.operationCoordinator.processes;
    this.disposed = false;
    this.disposePromise = null;
    this.dependencies = {
      fs: opts.fs || fs,
      path: opts.path || path,
      crypto: opts.crypto || crypto,
      inspectionAdapter: opts.inspectionAdapter || inspectionAdapter,
      bExecutor: opts.bExecutor || bExecutor,
      outputStore: opts.outputStore || outputStore,
      // for testing: stub verifier
      verifierRunner: opts.verifierRunner || null,
      spawn: opts.spawn || spawn,
      nativeImage: opts.nativeImage || null,
      thumbnailDecoder: opts.thumbnailDecoder || null,
    };
  }

  fingerprintFile(filePath) {
    return fingerprintFile(filePath, this.dependencies.fs, this.dependencies.crypto);
  }

  _removeThumbnailCacheEntry(outputId, expected = null) {
    const entry = this.thumbnailCache.get(outputId);
    if (!entry || (expected && entry !== expected)) return false;
    this.thumbnailCache.delete(outputId);
    this.thumbnailCacheBytes = Math.max(0, this.thumbnailCacheBytes - entry.bytes);
    return true;
  }

  _cacheThumbnail(outputId, entry) {
    this._removeThumbnailCacheEntry(outputId);
    this.thumbnailCache.set(outputId, entry);
    this.thumbnailCacheBytes += entry.bytes;
    while (this.thumbnailCache.size > this.thumbnailCacheMaxEntries
      || this.thumbnailCacheBytes > this.thumbnailCacheMaxBytes) {
      const oldest = this.thumbnailCache.keys().next().value;
      if (oldest === undefined) break;
      this._removeThumbnailCacheEntry(oldest);
    }
  }

  pruneOutputRecords(now = Date.now()) {
    for (const [outputId, record] of this.outputs) {
      const createdAt = record && Number(record.createdAt);
      const expiresAt = record && Number(record.expiresAt);
      const expired = (Number.isFinite(expiresAt) && expiresAt <= now)
        || (Number.isFinite(createdAt) && createdAt + this.outputRecordTtlMs <= now);
      if (expired) {
        this.outputs.delete(outputId);
        this._removeThumbnailCacheEntry(outputId);
      }
    }
    while (this.outputs.size > this.outputRecordLimit) {
      const oldest = this.outputs.keys().next().value;
      if (oldest === undefined) break;
      this.outputs.delete(oldest);
      this._removeThumbnailCacheEntry(oldest);
    }
    return this.outputs.size;
  }

  clearThumbnailCache(ownerWebContentsId) {
    let removed = 0;
    for (const [outputId, entry] of [...this.thumbnailCache]) {
      if (ownerWebContentsId === undefined || entry.ownerWebContentsId === ownerWebContentsId) {
        if (this._removeThumbnailCacheEntry(outputId, entry)) removed++;
      }
    }
    for (const flight of this.thumbnailInFlight.values()) {
      if (ownerWebContentsId === undefined || flight.ownerWebContentsId === ownerWebContentsId) {
        flight.cacheAllowed = false;
      }
    }
    return removed;
  }

  _pruneThumbnailOwnerGeneration(ownerWebContentsId) {
    if (this.thumbnailProcesses.has(ownerWebContentsId)) return;
    for (const flight of this.thumbnailInFlight.values()) {
      if (flight.ownerWebContentsId === ownerWebContentsId) return;
    }
    this.thumbnailOwnerGenerations.delete(ownerWebContentsId);
  }

  // Clear renderer-owned thumbnail state when its webContents is destroyed.
  cleanupOwner(ownerWebContentsId) {
    this.thumbnailOwnerGenerations.set(
      ownerWebContentsId,
      (this.thumbnailOwnerGenerations.get(ownerWebContentsId) || 0) + 1,
    );
    const processes = this.thumbnailProcesses.get(ownerWebContentsId);
    if (processes) {
      for (const child of processes) this.killProcess(child);
      this.thumbnailProcesses.delete(ownerWebContentsId);
    }
    const removed = this.clearThumbnailCache(ownerWebContentsId);
    this._pruneThumbnailOwnerGeneration(ownerWebContentsId);
    return removed;
  }

  _decodeThumbnailBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_THUMB_BYTES) return false;
    try {
      if (typeof this.dependencies.thumbnailDecoder === 'function') {
        return this.dependencies.thumbnailDecoder(buffer) === true;
      }
      let nativeImage = this.dependencies.nativeImage;
      if (!nativeImage) {
        try { nativeImage = require('electron').nativeImage; } catch {}
      }
      if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return false;
      const image = nativeImage.createFromBuffer(buffer);
      if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) return false;
      const size = typeof image.getSize === 'function' ? image.getSize() : null;
      return !!size && Number.isSafeInteger(size.width) && size.width > 0
        && Number.isSafeInteger(size.height) && size.height > 0;
    } catch {
      return false;
    }
  }

  _cleanupStaging(job) {
    if (!job || !job.stagingPath) return true;
    try {
      const result = this.dependencies.outputStore.removeStaging(job.stagingPath, job.outputRoot);
      if (result && result.ok === false) {
        if (!result.reported) console.warn('[HdrToSdr] staging cleanup warning');
        return false;
      }
      return true;
    } catch {
      console.warn('[HdrToSdr] staging cleanup warning');
      try {
        if (this.dependencies.outputStore && typeof this.dependencies.outputStore.scavengeStagingFiles === 'function') {
          this.dependencies.outputStore.scavengeStagingFiles(job.outputRoot);
        }
      } catch {}
      return false;
    }
  }

  // All inspection and conversion work reserves through this one coordinator.
  // The method is deliberately synchronous: callers reserve before their first await.
  reserveOperation(kind, ownerWebContentsId) {
    return this.operationCoordinator.reserve(kind, ownerWebContentsId);
  }

  releaseOperation(operation) {
    this.operationCoordinator.release(operation);
  }

  hasActiveOperation() {
    return this.operationCoordinator.hasActive();
  }

  trackProcess(child, operationOrJob = undefined) {
    const operation = operationOrJob && operationOrJob.operation
      ? operationOrJob.operation
      : operationOrJob;
    // undefined preserves the historical active-operation default; null is an
    // explicit coordinator-only track for thumbnails and similar consumers.
    const coordinatorOperation = operationOrJob === null
      ? null
      : (operation || this.operationCoordinator.active);
    this.operationCoordinator.track(child, coordinatorOperation);
    if (operationOrJob && operationOrJob.processes) operationOrJob.processes.add(child);
  }

  killProcess(child) {
    return this.operationCoordinator.kill(child);
  }

  untrackProcess(child, operationOrJob = null) {
    const operation = operationOrJob && operationOrJob.operation
      ? operationOrJob.operation
      : operationOrJob;
    this.operationCoordinator.untrack(child, operation || null);
    if (operationOrJob && operationOrJob.processes) operationOrJob.processes.delete(child);
    if (operationOrJob && operationOrJob.terminalized && operationOrJob.processes && operationOrJob.processes.size === 0) {
      this.releaseOperation(operationOrJob.operation);
    }
  }

  _dropUnstartedJob(job) {
    if (!job || job.terminalized) return;
    job.terminalized = true;
    job.status = 'error';
    this._killJobProcesses(job);
    this.jobs.delete(job.jobId);
    if (this.activeJobByWindow.get(job.senderId) === job.jobId) this.activeJobByWindow.delete(job.senderId);
    this.releaseOperation(job.operation);
    this._cleanupStaging(job);
  }

  _killJobProcesses(job) {
    if (!job || !job.processes) return;
    for (const child of job.processes) this.killProcess(child);
  }


  _finalizeJob(job, terminal) {
    if (!job || job.terminalized) return false;
    job.terminalized = true;
    job.status = terminal.status;
    if (job.progressTimer) {
      clearTimeout(job.progressTimer);
      job.progressTimer = null;
    }
    const shouldEmit = job.accepted !== false;
    if (terminal.status !== 'success') this._cleanupStaging(job);
    if (terminal.status !== 'success' && !this.disposed) this._killJobProcesses(job);
    this.jobs.delete(job.jobId);
    if (this.activeJobByWindow.get(job.senderId) === job.jobId) this.activeJobByWindow.delete(job.senderId);
    if (!job.processes || job.processes.size === 0) this.releaseOperation(job.operation);
    if (shouldEmit) {
      try { job.emit(terminal.event); } catch {}
    }
    return true;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const job of this.jobs.values()) {
      job.cancelRequested = true;
      try { job.abortController.abort(); } catch {}
    }
    const coordinatorDispose = this.operationCoordinator.dispose();
    for (const job of [...this.jobs.values()]) {
      this._finalizeJob(job, {
        status: 'cancelled',
        event: { phase: 'cancelled', status: 'cancelled', reason: 'cancelled' },
      });
      job.processes.clear();
      this.releaseOperation(job.operation);
    }
    this.disposePromise = Promise.resolve(coordinatorDispose).then(() => {
      this.activeProcesses.clear();
      this.thumbnailProcesses.clear();
      this.thumbnailOwnerGenerations.clear();
      this.clearThumbnailCache();
      this.thumbnailInFlight.clear();
    });
    return this.disposePromise;
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

  // Validation helper for source path before spawn. Inspection and conversion use
  // the same canonical, non-symlink source policy.
  validateSourcePathForSpawn(canonicalPath) {
    return canonicalizeSafeSourcePath(canonicalPath, this.dependencies.fs, this.dependencies.path);
  }

  // For DI in tests: allow injecting inspect function
  async revalidateSourceToken(sourceId, senderWebContentsId, operationOptions = {}) {
    const token = this.sourceTokens.get(sourceId);
    if (!token) return { ok: false, reason: 'invalid_request' };
    if (token.ownerWebContentsId !== senderWebContentsId) return { ok: false, reason: 'invalid_request' };
    if (!isKnownProfileId(token.profileId)) return { ok: false, reason: 'invalid_request' };
    // Recheck path
    const pathCheck = this.validateSourcePathForSpawn(token.canonicalPath);
    if (!pathCheck.ok) return { ok: false, reason: 'invalid_request' };
    const canonical = pathCheck.canonical;
    // Compare canonical filesystem names so the shared policy handles both
    // macOS aliases and the filesystem's agreed case behavior.
    let registeredCanonical;
    try {
      registeredCanonical = this.dependencies.fs.realpathSync(token.canonicalPath);
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    if (!canonicalPathsEqual(canonical, registeredCanonical, this.dependencies.path)) {
      return { ok: false, reason: 'invalid_request' };
    }
    // Re-inspect via private Python CLI seam
    let inspected;
    try {
      inspected = await this.dependencies.inspectionAdapter.inspect(canonical, operationOptions);
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

  // Job lifecycle. Reservation and job insertion happen before the first await.
  startJob({ sourceId, profileId, senderWebContents }) {
    const senderId = senderWebContents && senderWebContents.id;
    if (senderId == null || this.disposed) return Promise.resolve({ ok: false, reason: 'invalid_request' });
    if (this.activeJobByWindow.has(senderId) || this.hasActiveOperation()) {
      return Promise.resolve({ ok: false, reason: 'busy' });
    }
    if (!isKnownProfileId(profileId)) return Promise.resolve({ ok: false, reason: 'invalid_request' });

    const operation = this.reserveOperation('conversion', senderId);
    if (!operation) return Promise.resolve({ ok: false, reason: 'busy' });
    let jobId;
    try {
      jobId = this.dependencies.crypto.randomUUID();
    } catch {
      this.releaseOperation(operation);
      return Promise.resolve({ ok: false, reason: 'conversion_failed' });
    }
    const job = {
      jobId,
      sourceId,
      senderId,
      senderWebContents,
      operation,
      status: 'starting',
      seq: 0,
      stagingPath: null,
      finalPath: null,
      outputId: null,
      processes: new Set(),
      cancelRequested: false,
      terminalized: false,
      accepted: false,
      abortController: operation.abortController,
    };
    job.emit = (payload) => {
      if (job.terminalized && payload.status !== 'success' && payload.status !== 'error' && payload.status !== 'cancelled') return;
      const event = { ...payload, version: 1, jobId: job.jobId, seq: job.seq++ };
      if (!isValidConvertEvent(event)) return;
      try { senderWebContents.send(CONVERT_EVENT_CHANNEL, event); } catch {}
    };
    this.jobs.set(jobId, job);
    this.activeJobByWindow.set(senderId, jobId);

    return this._prepareJob(job, { sourceId, profileId, senderId }).catch(() => {
      this._dropUnstartedJob(job);
      return { ok: false, reason: 'conversion_failed' };
    });
  }

  async _prepareJob(job, { sourceId, profileId, senderId }) {
    let reval;
    try {
      reval = await this.revalidateSourceToken(sourceId, senderId, {
        abortSignal: job.abortController.signal,
        timeoutMs: this.operationPolicy.inspectionTimeoutMs,
        stallTimeoutMs: this.operationPolicy.inspectionStallTimeoutMs,
        touchActivity: () => {},
        trackProcess: (child) => this.trackProcess(child, job),
        untrackProcess: (child) => this.untrackProcess(child, job),
        killProcess: (child) => this.killProcess(child),
        terminationGraceMs: this.operationPolicy.terminationGraceMs,
      });
    } catch {
      reval = { ok: false };
    }
    if (job.terminalized || job.cancelRequested || this.disposed) {
      this._dropUnstartedJob(job);
      return { ok: false, reason: 'conversion_failed' };
    }
    if (!reval || !reval.ok || !reval.inspectedResult || profileId !== reval.inspectedResult.profileId) {
      this._dropUnstartedJob(job);
      return { ok: false, reason: 'invalid_request' };
    }
    const expectedProfile = reval.inspectedResult.profileId;
    if (!isKnownProfileId(expectedProfile)) {
      this._dropUnstartedJob(job);
      return { ok: false, reason: 'invalid_request' };
    }

    try {
      const outputRoot = this.dependencies.outputStore.ensureOutputRoot();
      const displayNameBase = reval.inspectedResult.displayName || path.basename(reval.canonical);
      const displayName = this.dependencies.outputStore.buildDisplayName(displayNameBase, expectedProfile);
      const finalPath = this.dependencies.outputStore.allocateUniqueFinalPath(outputRoot, displayName);
      const stagingPath = this.dependencies.outputStore.getStagingPath(outputRoot, finalPath);
      job.outputRoot = outputRoot;
      job.displayName = displayName;
      job.finalPath = finalPath;
      job.stagingPath = stagingPath;
      job.profileId = expectedProfile;
      job.canonicalSourcePath = reval.canonical;
      job.status = 'running';
      job.reval = reval;
    } catch (error) {
      this._dropUnstartedJob(job);
      const reason = error && error.code === 'output_root_unsafe' ? 'output_root_unsafe' : 'conversion_failed';
      return { ok: false, reason };
    }

    // Defer every event and process spawn until the accepted response has returned.
    job.accepted = true;
    setImmediate(() => {
      this._runJob(job).catch(() => {
        this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'conversion_failed' } });
      });
    });
    return { ok: true, jobId: job.jobId };
  }

  _operationOptions(job, kind, touchActivity) {
    const prefix = kind === 'conversion' ? 'conversion' : 'verifier';
    return {
      abortSignal: job.abortController.signal,
      timeoutMs: this.operationPolicy[`${prefix}TimeoutMs`],
      stallTimeoutMs: this.operationPolicy[`${prefix}StallTimeoutMs`],
      touchActivity,
      trackProcess: (child) => this.trackProcess(child, job),
      untrackProcess: (child) => this.untrackProcess(child, job),
      killProcess: (child) => this.killProcess(child),
      terminationGraceMs: this.operationPolicy.terminationGraceMs,
    };
  }

  _runManagedOperation(job, kind, operation) {
    const policyPrefix = kind === 'conversion' ? 'conversion' : 'verifier';
    const reasonPrefix = kind === 'conversion' ? 'conversion' : 'verification';
    const timeoutReason = `${reasonPrefix}_timeout`;
    const stallReason = `${reasonPrefix}_stalled`;
    const timeoutMs = this.operationPolicy[`${policyPrefix}TimeoutMs`];
    const stallTimeoutMs = this.operationPolicy[`${policyPrefix}StallTimeoutMs`];
    return new Promise((resolve) => {
      let settled = false;
      let timeoutTimer = null;
      let stallTimer = null;
      let forcedReason = null;
      const signal = job.abortController.signal;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(stallTimer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const touchActivity = () => {
        if (settled) return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          forcedReason = stallReason;
          try { signal.aborted || job.abortController.abort(); } catch {}
          finish({ outcome: 'error', reason: stallReason });
        }, stallTimeoutMs);
      };
      const onAbort = () => {
        finish(forcedReason
          ? { outcome: 'error', reason: forcedReason }
          : { outcome: 'cancelled', reason: 'cancelled' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutTimer = setTimeout(() => {
        forcedReason = timeoutReason;
        try { job.abortController.abort(); } catch {}
        finish({ outcome: 'error', reason: timeoutReason });
      }, timeoutMs);
      touchActivity();
      const options = this._operationOptions(job, kind, touchActivity);
      Promise.resolve().then(() => operation(options)).then((result) => {
        if (settled) return;
        if (forcedReason) {
          finish({ outcome: 'error', reason: forcedReason });
          return;
        }
        finish(result || { outcome: 'error', reason: `${reasonPrefix}_failed` });
      }, () => finish({ outcome: 'error', reason: `${reasonPrefix}_failed` }));
    });
  }

  async _runVerifier(job) {
    const verifierPath = path.resolve(getRepoRoot(), 'scripts', 'verify-spike.sh');
    return this._runManagedOperation(job, 'verifier', (options) => {
      const reval = job.reval;
      const stagingPath = job.stagingPath;
      const expectedProfile = job.profileId;
      if (this.dependencies.verifierRunner) {
        // The first four arguments remain the public verifierRunner seam: verifierRunner(reval.canonical, stagingPath, verifierPath, expectedProfile)
        return Promise.resolve(this.dependencies.verifierRunner(reval.canonical, stagingPath, verifierPath, expectedProfile, options))
          .then((exit) => typeof exit === 'number'
            ? (exit === 0 ? { outcome: 'success' } : { outcome: 'error', reason: 'verification_failed' })
            : exit);
      }
      return new Promise((resolve) => {
        if (options.abortSignal && options.abortSignal.aborted) {
          resolve({ outcome: 'cancelled', reason: 'cancelled' });
          return;
        }
        let proc;
        try {
          proc = spawn(verifierPath, [reval.canonical, stagingPath, expectedProfile], {
            detached: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          markProcessGroupOwned(proc);
        } catch {
          resolve({ outcome: 'error', reason: 'verification_failed' });
          return;
        }
        let finished = false;
        const onAbort = () => {
          if (finished) return;
          try { options.killProcess(proc); } catch {}
        };
        const done = (result) => {
          if (finished) return;
          finished = true;
          try { options.abortSignal.removeEventListener('abort', onAbort); } catch {}
          options.untrackProcess(proc);
          resolve(result);
        };
        options.trackProcess(proc);
        try {
          options.abortSignal.addEventListener('abort', onAbort, { once: true });
          if (options.abortSignal.aborted) onAbort();
        } catch {}
        const onActivity = () => options.touchActivity();
        try { proc.stdout.on('data', onActivity); } catch {}
        try { proc.stderr.on('data', onActivity); } catch {}
        proc.on('error', () => done({ outcome: 'error', reason: 'verification_failed' }));
        proc.on('close', (code) => done(code === 0
          ? { outcome: 'success' }
          : { outcome: 'error', reason: 'verification_failed' }));
      });
    });
  }

  async _runJob(job) {
    if (!job || job.terminalized) return;
    const expectedProfile = job.profileId;
    const reval = job.reval;
    job.progressPercent = 0;
    job.progressLastEmittedAt = Date.now();
    let pendingProgress = null;
    const emitConversionProgress = (value, force = false) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      const percent = Math.max(0, Math.min(99, Math.floor(numeric)));
      if (percent <= job.progressPercent) return;
      const send = (next) => {
        pendingProgress = null;
        if (job.progressTimer) {
          clearTimeout(job.progressTimer);
          job.progressTimer = null;
        }
        if (next <= job.progressPercent || job.terminalized) return;
        job.progressPercent = next;
        job.progressLastEmittedAt = Date.now();
        job.emit({ phase: 'converting', status: 'running', profileId: expectedProfile, percent: next });
      };
      if (force && pendingProgress != null) {
        const queued = pendingProgress;
        pendingProgress = null;
        send(queued);
      }
      if (force || Date.now() - job.progressLastEmittedAt >= PROGRESS_THROTTLE_MS) {
        send(percent);
        return;
      }
      pendingProgress = Math.max(pendingProgress || 0, percent);
      if (!job.progressTimer) {
        job.progressTimer = setTimeout(() => {
          job.progressTimer = null;
          if (pendingProgress != null) send(pendingProgress);
        }, Math.max(1, PROGRESS_THROTTLE_MS - (Date.now() - job.progressLastEmittedAt)));
      }
    };
    job.emit({ phase: 'queued', status: 'running', profileId: expectedProfile });
    job.emit({ phase: 'converting', status: 'running', profileId: expectedProfile, percent: 0 });
    if (job.cancelRequested || job.abortController.signal.aborted) {
      this._finalizeJob(job, { status: 'cancelled', event: { phase: 'cancelled', status: 'cancelled', reason: 'cancelled' } });
      return;
    }

    const ffmpegPath = this.dependencies.bExecutor.getFfmpegAbsolute
      ? this.dependencies.bExecutor.getFfmpegAbsolute()
      : path.resolve(getRepoRoot(), 'tools', 'ffmpeg');
    const conversion = await this._runManagedOperation(job, 'conversion', (options) => this.dependencies.bExecutor.runBConversion({
      sourcePath: reval.canonical,
      stagingPath: job.stagingPath,
      profileId: expectedProfile,
      ffmpegPath,
      onProgress: (progress) => {
        options.touchActivity();
        const reported = progress && progress.percent != null
          ? progress.percent
          : progressPercent(progress && progress.outTimeMs, reval.inspectedResult && reval.inspectedResult.duration);
        emitConversionProgress(reported);
      },
      durationSeconds: reval.inspectedResult && reval.inspectedResult.duration,
      progressThrottleMs: PROGRESS_THROTTLE_MS,
      abortSignal: options.abortSignal,
      timeoutMs: options.timeoutMs,
      stallTimeoutMs: options.stallTimeoutMs,
      trackProcess: options.trackProcess,
      untrackProcess: options.untrackProcess,
      touchActivity: options.touchActivity,
      killProcess: options.killProcess,
      terminationGraceMs: options.terminationGraceMs,
    }));
    if (job.terminalized) return;
    if (job.cancelRequested || conversion.outcome === 'cancelled') {
      this._finalizeJob(job, { status: 'cancelled', event: { phase: 'cancelled', status: 'cancelled', reason: 'cancelled' } });
      return;
    }
    if (!conversion || conversion.outcome !== 'success') {
      const reason = conversion && CONVERSION_FAILURE_REASONS.has(conversion.reason)
        ? conversion.reason : 'conversion_failed';
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason } });
      return;
    }

    try {
      const st = this.dependencies.fs.statSync(job.stagingPath);
      if (!st.isFile() || st.size === 0) throw new Error('missing staging');
      if (this.dependencies.outputStore && typeof this.dependencies.outputStore.hardenFileMode === 'function') {
        this.dependencies.outputStore.hardenFileMode(job.stagingPath);
      } else {
        this.dependencies.fs.chmodSync(job.stagingPath, 0o600);
      }
    } catch {
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'conversion_failed' } });
      return;
    }
    emitConversionProgress(99, true);
    // Bind the verifier result to an unchanged staging inode/content window. A
    // post-verifier hash alone could accidentally bless a swap made just after
    // the verifier exited.
    job.preVerificationFingerprint = this.fingerprintFile(job.stagingPath);
    if (!job.preVerificationFingerprint) {
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'verification_failed' } });
      return;
    }
    job.emit({ phase: 'verifying', status: 'running', profileId: expectedProfile });
    const verification = await this._runVerifier(job);
    if (job.terminalized) return;
    if (job.cancelRequested || verification.outcome === 'cancelled') {
      this._finalizeJob(job, { status: 'cancelled', event: { phase: 'cancelled', status: 'cancelled', reason: 'cancelled' } });
      return;
    }
    if (!verification || verification.outcome !== 'success') {
      const reason = verification && VERIFICATION_FAILURE_REASONS.has(verification.reason)
        ? verification.reason : 'verification_failed';
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason } });
      return;
    }
    // The verifier checks content, so bind that successful verification to the exact
    // bytes that are about to be committed. A later final-file check catches swaps
    // between verification and the hard-link commit.
    job.verifiedFingerprint = this.fingerprintFile(job.stagingPath);
    if (!sameFingerprint(job.preVerificationFingerprint, job.verifiedFingerprint)) {
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'verification_failed' } });
      return;
    }
    if (!job.verifiedFingerprint) {
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'verification_failed' } });
      return;
    }

    // Give a queued cancellation callback a turn before the irreversible commit.
    await new Promise((resolve) => setImmediate(resolve));
    if (job.terminalized || job.cancelRequested || job.abortController.signal.aborted) {
      this._finalizeJob(job, { status: 'cancelled', event: { phase: 'cancelled', status: 'cancelled', reason: 'cancelled' } });
      return;
    }

    let committedFinalPath = job.finalPath;
    try {
      let attemptPath = job.finalPath;
      let commitOk = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          this.dependencies.fs.linkSync(job.stagingPath, attemptPath);
          if (job.cancelRequested || job.abortController.signal.aborted) {
            try { this.dependencies.fs.unlinkSync(attemptPath); } catch {}
            throw new Error('cancelled');
          }
          const committedFingerprint = this.fingerprintFile(attemptPath);
          if (!sameFingerprint(job.verifiedFingerprint, committedFingerprint)) {
            try { this.dependencies.fs.unlinkSync(attemptPath); } catch {}
            throw new Error('verification_failed');
          }
          this._cleanupStaging(job);
          committedFinalPath = attemptPath;
          job.finalPath = attemptPath;
          job.finalFingerprint = committedFingerprint;
          commitOk = true;
          break;
        } catch (error) {
          if (error && error.message === 'cancelled') throw error;
          if (!error || error.code !== 'EEXIST') throw error;
          try {
            const next = this.dependencies.outputStore.allocateUniqueFinalPath(job.outputRoot, job.displayName);
            if (next === attemptPath) {
              const ext = path.extname(job.displayName);
              const base = job.displayName.slice(0, -ext.length);
              attemptPath = path.join(job.outputRoot, `${base}_${this.dependencies.crypto.randomBytes(3).toString('hex')}${ext}`);
            } else attemptPath = next;
          } catch {
            const ext = path.extname(job.displayName);
            const base = job.displayName.slice(0, -ext.length);
            attemptPath = path.join(job.outputRoot, `${base}_${this.dependencies.crypto.randomBytes(3).toString('hex')}${ext}`);
          }
        }
      }
      if (!commitOk) throw new Error('commit failed');
    } catch (error) {
      if (error && error.message === 'cancelled') {
        this._finalizeJob(job, { status: 'cancelled', event: { phase: 'cancelled', status: 'cancelled', reason: 'cancelled' } });
      } else if (error && error.message === 'verification_failed') {
        this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'verification_failed' } });
      } else {
        this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'conversion_failed' } });
      }
      return;
    }

    try {
      const outputId = this.dependencies.crypto.randomUUID();
      const createdAt = Date.now();
      let canonicalPathStored = committedFinalPath;
      try { canonicalPathStored = this.dependencies.fs.realpathSync(committedFinalPath); } catch { canonicalPathStored = path.resolve(committedFinalPath); }
      let canonicalRootStored = job.outputRoot;
      try { canonicalRootStored = this.dependencies.fs.realpathSync(job.outputRoot); } catch { canonicalRootStored = path.resolve(job.outputRoot); }
      this.outputs.set(outputId, {
        canonicalPath: canonicalPathStored,
        canonicalOutputRoot: canonicalRootStored,
        displayName: path.basename(committedFinalPath),
        ownerWebContentsId: job.senderId,
        verified: true,
        fingerprint: job.finalFingerprint,
        createdAt,
        expiresAt: createdAt + this.outputRecordTtlMs,
      });
      this.pruneOutputRecords(createdAt);
      job.outputId = outputId;
      this._finalizeJob(job, {
        status: 'success',
        event: {
          phase: 'done',
          status: 'success',
          displayName: path.basename(committedFinalPath),
          profileId: expectedProfile,
          outputId,
        },
      });
    } catch {
      try { this.dependencies.fs.unlinkSync(committedFinalPath); } catch {}
      this._finalizeJob(job, { status: 'error', event: { phase: 'error', status: 'error', reason: 'conversion_failed' } });
    }
  }

  async cancelJob({ jobId, senderWebContents }) {
    const senderId = senderWebContents && senderWebContents.id;
    const job = this.jobs.get(jobId);
    if (!job || senderId == null || job.senderId !== senderId) return { ok: false, reason: 'invalid_request' };
    if (job.terminalized) return { ok: true };
    job.cancelRequested = true;
    try { job.abortController.abort(); } catch {}
    // The managed operation emits one cancellation terminal and cleanup is centralized.
    return { ok: true };
  }

  // Verified-output-only drag revalidation: returns filesystem path only internally, never renderer
  resolveOutputForDrag({ outputId, senderWebContentsId }) {
    this.pruneOutputRecords();
    const rec = this.outputs.get(outputId);
    if (!rec) return { ok: false };
    if (!rec.verified) return { ok: false };
    if (rec.ownerWebContentsId !== senderWebContentsId) return { ok: false };
    if (!rec.fingerprint || !/^[0-9a-f]{64}$/.test(rec.fingerprint.sha256)
      || !Number.isSafeInteger(rec.fingerprint.size) || rec.fingerprint.size < 1) return { ok: false };
    const fileSystem = this.dependencies.fs;
    // Canonical non-symlink output root revalidation
    try {
      const lstRoot = fileSystem.lstatSync(rec.canonicalOutputRoot);
      if (lstRoot.isSymbolicLink() || !lstRoot.isDirectory()) return { ok: false };
      const realRoot = fileSystem.realpathSync(rec.canonicalOutputRoot);
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
        const lst = fileSystem.lstatSync(rec.canonicalPath);
        if (lst.isSymbolicLink() || !lst.isFile()) return { ok: false };
        const real = fileSystem.realpathSync(rec.canonicalPath);
        if (real !== rec.canonicalPath) return { ok: false };
        const rel = path.relative(rec.canonicalOutputRoot, real);
        if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return { ok: false };
      }
    } catch {
      return { ok: false };
    }
    // Current realpath equals stored canonical (TOCTOU)
    try {
      const curReal = fileSystem.realpathSync(rec.canonicalPath);
      if (curReal !== rec.canonicalPath) return { ok: false };
      // Also verify regular non-symlink via lstat already, and stat is file
      const st = fileSystem.statSync(curReal);
      if (!st.isFile()) return { ok: false };
    } catch {
      return { ok: false };
    }
    const currentFingerprint = this.fingerprintFile(rec.canonicalPath);
    if (!sameFingerprint(rec.fingerprint, currentFingerprint)) return { ok: false };
    // Direct containment already enforced via isSafeOutputFile; additionally ensure parent is root
    // Return path only internally
    return { ok: true, canonicalPath: rec.canonicalPath };
  }

  getOutputRecord(outputId) {
    this.pruneOutputRecords();
    return this.outputs.get(outputId) || null;
  }

  async _generateThumbnailDataUrl({ outputId, senderWebContentsId, canonicalPath, ownerGeneration }) {
    const ownerStillActive = () => !this.disposed
      && (this.thumbnailOwnerGenerations.get(senderWebContentsId) || 0) === ownerGeneration;
    try {
      const ffmpegPath = this.dependencies.bExecutor && typeof this.dependencies.bExecutor.getFfmpegAbsolute === 'function'
        ? this.dependencies.bExecutor.getFfmpegAbsolute()
        : path.resolve(getRepoRoot(), 'tools', 'ffmpeg');
      const fileSystem = this.dependencies.fs;
      try {
        const st = fileSystem.statSync(ffmpegPath);
        if (!st.isFile()) return { ok: false, reason: 'thumbnail_failed' };
        fileSystem.accessSync(ffmpegPath, fs.constants.X_OK);
      } catch {
        return { ok: false, reason: 'thumbnail_failed' };
      }
      const attempt = (seek) => {
        if (!ownerStillActive()) return Promise.resolve(null);
        // Revalidate immediately before each decoder invocation; thumbnailing is
        // also an output consumer and must never read an untrusted replacement.
        const current = this.resolveOutputForDrag({ outputId, senderWebContentsId });
        if (!current || !current.ok) return Promise.resolve(null);
        return new Promise((resolve) => {
          const args = [
            '-nostdin', '-loglevel', 'error',
            '-ss', String(seek),
            '-i', canonicalPath,
            '-map', '0:V:0',
            '-frames:v', '1',
            '-vf', 'scale=120:68:force_original_aspect_ratio=decrease,pad=120:68:(ow-iw)/2:(oh-ih)/2:color=black',
            '-q:v', '6',
            '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
          ];
          let child;
          try {
            child = this.dependencies.spawn(ffmpegPath, args, {
              detached: true,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            markProcessGroupOwned(child);
            this.trackProcess(child, null);
            let ownerProcesses = this.thumbnailProcesses.get(senderWebContentsId);
            if (!ownerProcesses) {
              ownerProcesses = new Set();
              this.thumbnailProcesses.set(senderWebContentsId, ownerProcesses);
            }
            ownerProcesses.add(child);
          } catch {
            resolve(null);
            return;
          }
          const chunks = [];
          let total = 0;
          let finished = false;
          const cleanupChild = () => {
            try { this.untrackProcess(child, null); } catch {}
            const ownerProcesses = this.thumbnailProcesses.get(senderWebContentsId);
            if (ownerProcesses) {
              ownerProcesses.delete(child);
              if (ownerProcesses.size === 0) this.thumbnailProcesses.delete(senderWebContentsId);
            }
          };
          const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            try { this.killProcess(child); } catch {}
            cleanupChild();
            resolve(null);
          }, 6000);
          child.stdout.on('data', (chunk) => {
            if (finished) return;
            if (total + chunk.length > MAX_THUMB_BYTES) {
              // Never return a truncated image as if it were decodable.
              finished = true;
              clearTimeout(timer);
              try { this.killProcess(child); } catch {}
              cleanupChild();
              resolve({ tooLarge: true });
              return;
            }
            chunks.push(chunk);
            total += chunk.length;
          });
          child.stderr.on('data', () => {});
          child.on('error', () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            cleanupChild();
            resolve(null);
          });
          child.on('close', (code) => {
            if (finished) {
              cleanupChild();
              return;
            }
            finished = true;
            clearTimeout(timer);
            cleanupChild();
            if (code !== 0 || total === 0) {
              resolve(null);
              return;
            }
            resolve(Buffer.concat(chunks));
          });
        });
      };

      let attemptResult = await attempt('0.5');
      if (!ownerStillActive()) return { ok: false, reason: 'thumbnail_failed' };
      if (attemptResult && attemptResult.tooLarge) return { ok: false, reason: 'thumbnail_failed' };
      let buf = Buffer.isBuffer(attemptResult) ? attemptResult : null;
      let decoded = this._decodeThumbnailBuffer(buf);
      if (!decoded) {
        if (!ownerStillActive()) return { ok: false, reason: 'thumbnail_failed' };
        attemptResult = await attempt('0');
        if (!ownerStillActive()) return { ok: false, reason: 'thumbnail_failed' };
        if (attemptResult && attemptResult.tooLarge) return { ok: false, reason: 'thumbnail_failed' };
        buf = Buffer.isBuffer(attemptResult) ? attemptResult : null;
        decoded = this._decodeThumbnailBuffer(buf);
      }
      if (!decoded) return { ok: false, reason: 'thumbnail_failed' };
      // Reject a file changed while ffmpeg was decoding it.
      const afterThumbnail = this.resolveOutputForDrag({ outputId, senderWebContentsId });
      if (!afterThumbnail || !afterThumbnail.ok) return { ok: false, reason: 'thumbnail_failed' };
      const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
      if (dataUrl.length > MAX_THUMB_DATAURL) return { ok: false, reason: 'thumbnail_failed' };
      return { ok: true, dataUrl };
    } catch {
      return { ok: false, reason: 'thumbnail_failed' };
    }
  }

  // Secure thumbnail: only verified output, revalidated ownership + safe file,
  // bounded data URL, and one decoder process per output fingerprint.
  async getThumbnailDataUrl({ outputId, senderWebContentsId }) {
    if (this.disposed) return { ok: false, reason: 'invalid_request' };
    const resolved = this.resolveOutputForDrag({ outputId, senderWebContentsId });
    if (!resolved || !resolved.ok) {
      const rec = this.outputs.get(outputId);
      // A failed revalidation for the legitimate owner invalidates any old
      // thumbnail; a non-owner request must not mutate owner state.
      if (rec && rec.ownerWebContentsId === senderWebContentsId) {
        this._removeThumbnailCacheEntry(outputId);
      }
      return { ok: false, reason: 'invalid_request' };
    }
    const rec = this.outputs.get(outputId);
    const fingerprint = rec && rec.fingerprint;
    if (!rec || !fingerprint) return { ok: false, reason: 'invalid_request' };
    const cached = this.thumbnailCache.get(outputId);
    if (cached && cached.ownerWebContentsId === senderWebContentsId
      && sameFingerprint(cached.fingerprint, fingerprint)) {
      return { ok: true, dataUrl: cached.dataUrl };
    }
    if (cached) this._removeThumbnailCacheEntry(outputId, cached);

    const key = `${outputId}:${senderWebContentsId}:${fingerprint.size}:${fingerprint.sha256}`;
    const ownerGeneration = this.thumbnailOwnerGenerations.get(senderWebContentsId) || 0;
    const existing = this.thumbnailInFlight.get(key);
    if (existing) return existing.promise;
    const flight = {
      ownerWebContentsId: senderWebContentsId,
      fingerprint: { size: fingerprint.size, sha256: fingerprint.sha256 },
      cacheAllowed: true,
      promise: null,
    };
    const promise = this._generateThumbnailDataUrl({
      outputId,
      senderWebContentsId,
      canonicalPath: resolved.canonicalPath,
      ownerGeneration,
    }).then((result) => {
      if (result && result.ok && flight.cacheAllowed && !this.disposed) {
        const current = this.outputs.get(outputId);
        const currentResolved = this.resolveOutputForDrag({ outputId, senderWebContentsId });
        if (currentResolved && currentResolved.ok && current && sameFingerprint(current.fingerprint, flight.fingerprint)) {
          this._cacheThumbnail(outputId, {
            dataUrl: result.dataUrl,
            bytes: Buffer.byteLength(result.dataUrl, 'utf8'),
            ownerWebContentsId: flight.ownerWebContentsId,
            fingerprint: flight.fingerprint,
          });
        }
      }
      return result;
    }, () => ({ ok: false, reason: 'thumbnail_failed' }));
    flight.promise = promise;
    this.thumbnailInFlight.set(key, flight);
    try {
      return await promise;
    } finally {
      if (this.thumbnailInFlight.get(key) === flight) this.thumbnailInFlight.delete(key);
      this._pruneThumbnailOwnerGeneration(senderWebContentsId);
    }
  }

  // For testing: attach IPC
  attachIpc(window) {
    const { ipcMain, dialog } = require('electron');
    const dlg = (this.dependencies && this.dependencies.dialog) || dialog;
    try {
      if (window && window.webContents && typeof window.webContents.once === 'function') {
        window.webContents.once('destroyed', () => this.cleanupOwner(window.webContents.id));
      }
    } catch {}
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
        if (res.reason === 'output_root_unsafe') return { outcome: 'error', reason: 'output_root_unsafe' };
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
  MAX_THUMB_CACHE_ENTRIES,
  MAX_THUMB_CACHE_BYTES,
  MAX_OUTPUT_RECORDS,
  OUTPUT_RECORD_TTL_MS,
  PROGRESS_THROTTLE_MS,
  PROFILE_ID,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  ALLOWED_PROFILE_IDS,
  fingerprintFile,
  sameFingerprint,
  isKnownProfileId,
  PROFILES,
  DEFAULT_HEAVY_OPERATION_POLICY,
  HeavyOperationCoordinator,
  normalizePolicy,
};
