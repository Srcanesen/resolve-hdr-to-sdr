const { ipcMain, dialog } = require('electron');
const path = require('path');
const { PROFILE_ID, PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC, PROFILE_ID_PQ, isKnownProfileId } = require('./b-profile.cjs');
const { validateInspectionResult, isSafeReason } = require('./inspection-adapter.cjs');
const { canonicalizeSafeSourcePath } = require('./source-path-policy.cjs');

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
    return isSafeReason(obj.reason);
  }
  if (obj.outcome === 'error') {
    if (topKeys.length !== 2) return false;
    if (!('outcome' in obj) || !('reason' in obj)) return false;
    return isSafeReason(obj.reason);
  }
  if (obj.outcome === 'complete') {
    return topKeys.length === 2
      && topKeys.includes('outcome')
      && topKeys.includes('result')
      && validateInspectionResult(obj.result, { allowSourceId: true });
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
    if (typeof _conversionServiceRef.hasActiveOperation === 'function') return _conversionServiceRef.hasActiveOperation();
    if (_conversionServiceRef.activeJobByWindow && _conversionServiceRef.activeJobByWindow.has(webContentsId)) return true;
    for (const job of _conversionServiceRef.jobs.values()) {
      if (job.status === 'running' || job.status === 'starting') return true;
    }
  } catch {}
  return false;
}

function attachIpc(window, adapter, conversionService) {
  _setConversionServiceRef(conversionService || null);
  // Remove previous handler if any (idempotent for bootstrap seam)
  try {
    ipcMain.removeHandler(CHANNEL);
  } catch {}

  ipcMain.handle(CHANNEL, async (event, request) => {
    const senderId = event.sender && event.sender.id;
    const serviceRef = _conversionServiceRef;
    let operationReservation = null;
    if (serviceRef && typeof serviceRef.reserveOperation === 'function') {
      operationReservation = serviceRef.reserveOperation('inspection', senderId);
      if (!operationReservation) return { outcome: 'error', reason: 'busy' };
    } else {
      if (_inspectInFlight) return { outcome: 'error', reason: 'busy' };
      if (senderId != null && _hasActiveConversionForWindow(senderId)) {
        return { outcome: 'error', reason: 'busy' };
      }
      _inspectInFlight = true;
    }
    const policy = (serviceRef && serviceRef.operationPolicy) || {};
    const operationOptions = operationReservation ? {
      abortSignal: operationReservation.abortController && operationReservation.abortController.signal,
      timeoutMs: policy.inspectionTimeoutMs,
      stallTimeoutMs: policy.inspectionStallTimeoutMs,
      touchActivity: () => {},
      trackProcess: (child) => serviceRef.trackProcess(child, operationReservation),
      untrackProcess: (child) => serviceRef.untrackProcess(child, operationReservation),
      killProcess: (child) => serviceRef.killProcess(child),
    } : {};
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
            // Never mint a token from the submitted spelling or from a failed
            // canonicalization. The token must bind to a current safe file.
            const canonicalized = canonicalizeSafeSourcePath(rawPath);
            if (!canonicalized.ok) {
              return { outcome: 'error', reason: 'inspection_failed' };
            }
            const sourceId = _conversionServiceRef.createSourceToken({
              canonicalPath: canonicalized.canonical,
              sha256: r.sha256,
              size: r.size,
              profileId: r.profileId,
              ownerWebContentsId: senderIdForToken,
              displayName: r.displayName,
            });
            const withToken = { outcome: inspected.outcome, result: { ...r, sourceId } };
            if (!isValidResponse(withToken)) {
              return { outcome: 'error', reason: 'inspection_failed' };
            }
            return withToken;
          } catch {
            return { outcome: 'error', reason: 'inspection_failed' };
          }
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
        const inspected = await adapter.inspect(chosen, operationOptions);
        return await processInspection(chosen, inspected);
      } catch {
        return { outcome: 'error', reason: 'inspection_failed' };
      }
    }

    if (request.kind === 'path') {
      try {
        const inspected = await adapter.inspect(request.path, operationOptions);
        return await processInspection(request.path, inspected);
      } catch {
        return { outcome: 'error', reason: 'inspection_failed' };
      }
    }

      return { outcome: 'error', reason: 'invalid_request' };
    } finally {
      if (operationReservation) serviceRef.releaseOperation(operationReservation);
      else _inspectInFlight = false;
    }
  });
}

module.exports = { CHANNEL, isValidRequest, isValidResponse, attachIpc, _resetInspectGuard, _setConversionServiceRef, _hasActiveConversionForWindow };
