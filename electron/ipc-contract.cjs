const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { PROFILE_ID, PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC, PROFILE_ID_PQ, ALLOWED_PROFILE_IDS, isKnownProfileId } = require('./b-profile.cjs');

const CHANNEL = 'hdrtosdr:inspect';

function isValidRequest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (obj.kind === 'dialog') {
    if (keys.length !== 1) return false;
    return true;
  }
  if (obj.kind === 'path') {
    if (keys.length !== 2) return false;
    if (!('path' in obj)) return false;
    const p = obj.path;
    if (typeof p !== 'string' || p.length === 0) return false;
    if (p.length > 4096) return false;
    // No arbitrary fields already checked via keys length
    return true;
  }
  return false;
}

function isValidResponse(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const topKeys = Object.keys(obj);
  const allowedTop = new Set(['outcome', 'reason', 'result']);
  for (const k of topKeys) if (!allowedTop.has(k)) return false;
  if (obj.outcome === 'busy') {
    if (topKeys.length !== 2) return false;
    if (!('outcome' in obj) || !('reason' in obj)) return false;
    return obj.reason === 'busy';
  }
  if (obj.outcome === 'cancelled') {
    if (topKeys.length !== 2) return false;
    if (!('outcome' in obj) || !('reason' in obj)) return false;
    return typeof obj.reason === 'string' && obj.reason.length > 0 && obj.reason.length < 200;
  }
  if (obj.outcome === 'error') {
    if (topKeys.length !== 2) return false;
    if (!('outcome' in obj) || !('reason' in obj)) return false;
    return typeof obj.reason === 'string' && obj.reason.length > 0 && obj.reason.length < 200;
  }
  if (obj.outcome === 'complete') {
    if (topKeys.length !== 2) return false;
    if (!('outcome' in obj) || !('result' in obj)) return false;
    const r = obj.result;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    const allowedResult = new Set(['displayName', 'size', 'sha256', 'color', 'dovi', 'duration', 'classification', 'reason', 'canConvert', 'profileId', 'sourceId']);
    for (const k of Object.keys(r)) if (!allowedResult.has(k)) return false;
    if ('sourceId' in r) {
      if (typeof r.sourceId !== 'string' || r.sourceId.length === 0 || r.sourceId.length > 200) return false;
    }
    if ('profileId' in r && r.profileId != null) {
      if (typeof r.profileId !== 'string') return false;
    }
    if (typeof r.classification !== 'string') return false;
    if (typeof r.reason !== 'string') return false;
    if (typeof r.canConvert !== 'boolean') return false;
    const allowed = new Set(['hlgKnownLocal', 'hlgSupported', 'pqSupported', 'pqHdr10Unsupported', 'dolbyVisionUnsupported', 'uncertain']);
    if (!allowed.has(r.classification)) return false;
    if ('profileId' in r && r.profileId != null) {
      if (!isKnownProfileId(r.profileId)) return false;
    }
    // canConvert must match classification/profile: eligible paths require true; if profileId present it must match classification
    if (r.classification === 'hlgKnownLocal' && 'profileId' in r && r.profileId != null && r.profileId !== PROFILE_ID_LOCAL_B) return false;
    if (r.classification === 'hlgSupported' && 'profileId' in r && r.profileId != null && r.profileId !== PROFILE_ID_GENERIC) return false;
    if (r.classification === 'pqSupported' && 'profileId' in r && r.profileId != null && r.profileId !== PROFILE_ID_PQ) return false;
    if ((r.classification === 'hlgKnownLocal' || r.classification === 'hlgSupported' || r.classification === 'pqSupported') && r.canConvert !== true) return false;
    if ((r.classification === 'pqHdr10Unsupported' || r.classification === 'dolbyVisionUnsupported' || r.classification === 'uncertain') && r.canConvert !== false) {
      // Allow missing canConvert false already enforced above for eligible, but ensure unsupported not marked true
      if (r.canConvert === true) return false;
    }
    return true;
  }
  return false;
}

let _inspectInFlight = false;
function _resetInspectGuard() { _inspectInFlight = false; }
// Allow injection of conversion service for busy coordination (single active inspection/conversion)
let _conversionServiceRef = null;
function _setConversionServiceRef(svc) { _conversionServiceRef = svc; }
function _hasActiveConversionForWindow(webContentsId) {
  if (!_conversionServiceRef) return false;
  try {
    if (_conversionServiceRef.activeJobByWindow && _conversionServiceRef.activeJobByWindow.has(webContentsId)) return true;
    for (const job of _conversionServiceRef.jobs.values()) {
      if (job.status === 'running') return true;
    }
  } catch {}
  return false;
}

function attachIpc(window, adapter, conversionService) {
  if (conversionService) _setConversionServiceRef(conversionService);
  // Remove previous handler if any (idempotent for bootstrap seam)
  try {
    ipcMain.removeHandler(CHANNEL);
  } catch {}

  ipcMain.handle(CHANNEL, async (event, request) => {
    if (_inspectInFlight) {
      return { outcome: 'error', reason: 'busy' };
    }
    // Single active inspection/conversion enforcement
    try {
      const senderId = event.sender && event.sender.id;
      if (senderId != null && _hasActiveConversionForWindow(senderId)) {
        return { outcome: 'error', reason: 'busy' };
      }
      if (_conversionServiceRef) {
        for (const j of _conversionServiceRef.jobs.values()) {
          if (j.status === 'running') return { outcome: 'error', reason: 'busy' };
        }
      }
    } catch {}
    _inspectInFlight = true;
    try {
    // Validate sender equals owned window webContents
    if (!window || !window.webContents || event.sender !== window.webContents) {
      return { outcome: 'error', reason: 'invalid_sender' };
    }

    if (!isValidRequest(request)) {
      return { outcome: 'error', reason: 'invalid_request' };
    }

    const senderIdForToken = event.sender && event.sender.id != null ? event.sender.id : 0;
    // Helper to process inspection result and attach/invalidate source token
    const processInspection = async (rawPath, inspected) => {
      if (!isValidResponse(inspected)) {
        return { outcome: 'error', reason: 'inspection_failed' };
      }
      // New inspection invalidates prior token for that window
      if (_conversionServiceRef) {
        try { _conversionServiceRef.invalidateForWindow(senderIdForToken); } catch {}
      }
      if (inspected.outcome === 'complete' && inspected.result) {
        const r = inspected.result;
        const isLocalEligible = r.classification === 'hlgKnownLocal' && r.canConvert === true && r.profileId === PROFILE_ID_LOCAL_B;
        const isGenericEligible = r.classification === 'hlgSupported' && r.canConvert === true && r.profileId === PROFILE_ID_GENERIC;
        const isPqEligible = r.classification === 'pqSupported' && r.canConvert === true && r.profileId === PROFILE_ID_PQ;
        const eligible = (isLocalEligible || isGenericEligible || isPqEligible) && isKnownProfileId(r.profileId);
        if (eligible && _conversionServiceRef) {
          try {
            // Derive canonical path for token (trusted main process)
            let canonical = rawPath;
            try {
              const abs = path.resolve(rawPath);
              // lstat and realpath for symlink rejection
              const lst = fs.lstatSync(abs);
              if (!lst.isSymbolicLink()) {
                const real = fs.realpathSync(abs);
                // Validate regular, extension, size already done in adapter but double-check
                const st = fs.statSync(real);
                const ext = path.extname(real).toLowerCase();
                if (st.isFile() && (ext === '.mov' || ext === '.mp4')) {
                  canonical = real;
                }
              }
            } catch {}
            const sourceId = _conversionServiceRef.createSourceToken({
              canonicalPath: canonical,
              sha256: r.sha256,
              size: r.size,
              profileId: r.profileId,
              ownerWebContentsId: senderIdForToken,
              displayName: r.displayName,
            });
            // Attach sourceId only for eligible
            const withToken = { outcome: inspected.outcome, result: { ...r, sourceId } };
            if (!isValidResponse(withToken)) {
              return inspected;
            }
            return withToken;
          } catch {}
        }
      }
      return inspected;
    };

    if (request.kind === 'dialog') {
      let result;
      try {
        result = await dialog.showOpenDialog(window, {
          properties: ['openFile'],
          filters: [{ name: 'Video', extensions: ['mov', 'mp4'] }],
        });
      } catch {
        return { outcome: 'error', reason: 'dialog_failed' };
      }
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        // Invalidate token even on cancel? Spec: new inspection invalidates prior token – but cancel is not inspection.
        return { outcome: 'cancelled', reason: 'no_selection' };
      }
      const chosen = result.filePaths[0];
      const ext = path.extname(chosen).toLowerCase();
      if (ext !== '.mov' && ext !== '.mp4') {
        return { outcome: 'error', reason: 'unsupported_extension' };
      }
      // Delegate to adapter; adapter enforces Sample root and returns privacy-safe result
      try {
        const inspected = await adapter.inspect(chosen);
        return await processInspection(chosen, inspected);
      } catch {
        return { outcome: 'error', reason: 'inspection_failed' };
      }
    }

    if (request.kind === 'path') {
      try {
        const inspected = await adapter.inspect(request.path);
        return await processInspection(request.path, inspected);
      } catch {
        return { outcome: 'error', reason: 'inspection_failed' };
      }
    }

      return { outcome: 'error', reason: 'invalid_request' };
    } finally {
      _inspectInFlight = false;
    }
  });
}

module.exports = { CHANNEL, isValidRequest, isValidResponse, attachIpc, _resetInspectGuard, _setConversionServiceRef, _hasActiveConversionForWindow };
