// Pure helpers – DOM-free, testable without browser
const COPY = {
  idleDrop: 'Drop your video here',
  idleSupport: 'MOV or MP4',
  idlePick: 'Choose file',
  inspecting: 'Inspecting video…',
  eligibleTitle: 'Ready to convert',
  eligibleDesc: 'This video can be converted with a verified HDR → SDR profile.',
  eligibleDescHlg: 'HLG video can be converted with the verified HDR → SDR profile.',
  eligibleDescPq: 'HDR10 video can be converted with the verified HDR → SDR profile.',
  eligibleCta: 'Convert HDR → SDR',
  eligibleSupport: 'Creates a separate Rec.709 H.264 MP4 file. Compact and compatible.',
  queued: 'Preparing conversion…',
  converting: 'Converting HDR → SDR…',
  verifying: 'Verifying output…',
  cancel: 'Cancel',
  cancelling: 'Cancelling…',
  cancelledConversion: 'Conversion cancelled.',
  verifiedTitle: 'Output ready',
  verifiedSuffix: ' verified.',
  verifiedDrag: 'Drag to Resolve',
  verifiedHelp: 'Drop into the Media Pool or timeline.',
  unsupported: {
    pq: { title: 'PQ / HDR10 detected', desc: 'This version does not support PQ / HDR10 conversion.' },
    dv: { title: 'Dolby Vision detected', desc: 'This version does not convert this Dolby Vision video.' },
    uncertain: { title: 'HDR type could not be verified', desc: 'Color metadata is missing or contradictory. Conversion did not start.' }
  },
  retry: 'Choose another file',
  busy: 'Another operation is in progress. Please wait for it to finish.',
  unsupportedExtension: 'Only MOV and MP4 files can be selected.',
  dropUnavailable: 'Could not get the file. Try choosing a file instead.',
  inspectionFailed: 'Video could not be inspected. Check the file type.',
  profileUnavailable: 'Conversion is not available on this system.',
  outputRootUnsafe: 'The output folder is not safe. No file was created.',
  verificationFailed: 'Output could not be verified. File was not made available.',
  conversionFailed: 'Conversion could not be completed. Inspect the video again and try again.',
  cancelledIdle: 'No file selected.',
  technicalLabel: 'Technical details'
};

function formatFileSize(bytes) {
  if (bytes == null || typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(duration) {
  if (duration == null) return '';
  const v = typeof duration === 'string' ? parseFloat(duration) : Number(duration);
  if (!Number.isFinite(v) || v < 0) return '';
  const totalSec = Math.round(v);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s} s`;
}

function formatFileDetails(size, duration) {
  const parts = [];
  if (size != null && Number.isFinite(size)) {
    const f = formatFileSize(size);
    if (f) parts.push(f);
  }
  if (duration != null && duration !== '') {
    const d = formatDuration(duration);
    if (d) parts.push(d);
  }
  return parts.join(' · ');
}

function mapUnsupportedCopy(classification) {
  if (classification === 'pqHdr10Unsupported') return COPY.unsupported.pq;
  if (classification === 'dolbyVisionUnsupported') return COPY.unsupported.dv;
  return COPY.unsupported.uncertain;
}

function mapInspectionError(reason) {
  if (reason === 'busy') return COPY.busy;
  if (reason === 'unsupported_extension') return COPY.unsupportedExtension;
  if (reason === 'drop_path_unavailable') return COPY.dropUnavailable;
  return COPY.inspectionFailed;
}

function mapConversionError(reason) {
  if (reason === 'busy') return COPY.busy;
  if (reason === 'profile_unavailable') return COPY.profileUnavailable;
  if (reason === 'output_root_unsafe') return COPY.outputRootUnsafe;
  if (reason === 'verification_failed') return COPY.verificationFailed;
  if (reason === 'conversion_failed') return COPY.conversionFailed;
  return COPY.conversionFailed;
}

function isEligibleResult(result) {
  if (!result || typeof result !== 'object') return false;
  const isEligibleCls = result.classification === 'hlgKnownLocal' || result.classification === 'hlgSupported' || result.classification === 'pqSupported';
  // Renderer stays generic on profile literal to avoid embedding frozen IDs; main process validates strictly.
  return isEligibleCls && result.canConvert === true && typeof result.sourceId === 'string' && result.sourceId.length > 0;
}

function buildSafeTechnicalFields(result) {
  if (!result || typeof result !== 'object') return [];
  const fields = [];
  if (result.size != null && typeof result.size === 'number') {
    fields.push({ label: 'Size', value: formatFileSize(result.size) });
  }
  if (result.duration != null && result.duration !== '') {
    const d = formatDuration(result.duration);
    if (d) fields.push({ label: 'Duration', value: d });
  }
  let clsLabel = 'Unknown';
  if (result.classification === 'hlgKnownLocal' || result.classification === 'hlgSupported') clsLabel = 'HLG';
  else if (result.classification === 'pqSupported' || result.classification === 'pqHdr10Unsupported') clsLabel = 'PQ / HDR10';
  else if (result.classification === 'dolbyVisionUnsupported') clsLabel = 'Dolby Vision';
  fields.push({ label: 'Format', value: clsLabel });
  return fields;
}

function getFormatLabel(classification) {
  if (classification === 'hlgKnownLocal' || classification === 'hlgSupported') return 'HLG';
  if (classification === 'pqSupported') return 'PQ / HDR10';
  return '';
}

function getEligibleDescription(classification) {
  if (classification === 'hlgKnownLocal' || classification === 'hlgSupported') return COPY.eligibleDescHlg;
  if (classification === 'pqSupported') return COPY.eligibleDescPq;
  return COPY.eligibleDesc;
}

function getSafeErrorForContext(reason, context) {
  if (context === 'inspect') return mapInspectionError(reason);
  if (context === 'convert') return mapConversionError(reason);
  if (reason === 'busy') return COPY.busy;
  return COPY.inspectionFailed;
}

// stale event helper – pure
function shouldAcceptConvertEvent(ev, currentJobId, currentSeq) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.version !== 1) return false;
  if (!currentJobId || ev.jobId !== currentJobId) return false;
  if (typeof ev.seq !== 'number' || ev.seq <= currentSeq) return false;
  return true;
}

function getConvertPhaseCopy(phase) {
  if (phase === 'queued') return COPY.queued;
  if (phase === 'converting') return COPY.converting;
  if (phase === 'verifying') return COPY.verifying;
  if (phase === 'done') return COPY.verifiedTitle;
  return phase;
}

// privacy check helper for tests
function containsForbiddenVisible(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const forbidden = ['sha', 'hash', 'smoke', 'ertelendi', 'profileid', 'allowlist', 'pq_transfer', 'dovi_', 'hlg-local', 'outputpath', 'sourcepath', 'sourceid', 'outputid', '~/movies'];
  return forbidden.some(f => lower.includes(f));
}

// Export helpers for Node tests without breaking browser load
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    COPY,
    formatFileSize,
    formatDuration,
    formatFileDetails,
    mapUnsupportedCopy,
    mapInspectionError,
    mapConversionError,
    isEligibleResult,
    buildSafeTechnicalFields,
    getFormatLabel,
    getEligibleDescription,
    getSafeErrorForContext,
    containsForbiddenVisible,
    shouldAcceptConvertEvent,
    getConvertPhaseCopy
  };
}

// UI – runs only when document exists (browser/Electron)
if (typeof document !== 'undefined') {
(() => {
  const $ = (id) => document.getElementById(id);

  const workflow = $('workflow');
  const dropZone = $('drop-zone');
  const btnSelect = $('btn-select');
  const pathInput = $('path-input');
  const btnInspect = $('btn-inspect');

  const stateIdle = $('state-idle');
  const stateInspecting = $('state-inspecting');
  const stateFile = $('state-file');
  const fileNameEl = $('file-name');
  const fileDetailsEl = $('file-details');

  const stateEligible = $('state-eligible');
  const eligibleFormat = $('eligible-format');
  const eligibleDesc = $('eligible-desc');
  const btnConvert = $('btn-convert');

  const stateConverting = $('state-converting');
  const convertPhase = $('convert-phase');
  const convertBar = $('convert-bar');
  const btnCancel = $('btn-cancel');

  const stateVerified = $('state-verified');
  const verifiedDesc = $('verified-desc');
  const dragControl = $('drag-control');
  const dragOutput = $('drag-output');
  const verifiedThumbWrap = $('verified-thumb-wrap');
  const outputThumb = $('output-thumb');

  const stateUnsupported = $('state-unsupported');
  const unsupportedTitle = $('unsupported-title');
  const unsupportedDesc = $('unsupported-desc');

  const stateError = $('state-error');
  const errorText = $('error-text');

  const technicalDetails = $('technical-details');
  const techGrid = $('tech-grid');

  const liveAnnouncer = $('live-announcer');

  let currentSourceId = null;
  let currentProfileId = null;
  let currentJobId = null;
  let currentSeq = -1;
  let currentOutputId = null;
  let active = false;
  let hasPresentedIdle = false;
  let lastEligibleResult = null;
  let thumbSeq = 0;

  function setBusy(isBusy) {
    if (workflow) workflow.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  function announce(text) {
    if (liveAnnouncer) liveAnnouncer.textContent = text;
  }

  function hideAllStates() {
    if (stateInspecting) stateInspecting.hidden = true;
    if (stateFile) stateFile.hidden = true;
    if (stateEligible) stateEligible.hidden = true;
    if (stateConverting) stateConverting.hidden = true;
    if (stateVerified) stateVerified.hidden = true;
    if (stateUnsupported) stateUnsupported.hidden = true;
    if (stateError) stateError.hidden = true;
  }

  function clearThumbnail() {
    thumbSeq++;
    if (outputThumb) {
      try { outputThumb.removeAttribute('src'); } catch {}
      outputThumb.hidden = true;
    }
    if (verifiedThumbWrap) verifiedThumbWrap.hidden = true;
  }

  function clearDragOutput() {
    currentOutputId = null;
    if (dragControl) dragControl.hidden = true;
    if (dragOutput) { dragOutput.hidden = true; dragOutput.removeAttribute('draggable'); }
    clearThumbnail();
  }

  function showDragOutput(outputId) {
    if (!outputId || typeof outputId !== 'string') return;
    currentOutputId = outputId;
    if (dragControl) dragControl.hidden = false;
    if (dragOutput) {
      dragOutput.hidden = false;
      dragOutput.setAttribute('draggable', 'true');
      // focus per spec verified -> focus drag control
      try { dragOutput.focus(); } catch {}
    }
  }

  function resetToIdle(message) {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = false;
    if (stateFile) stateFile.hidden = true;
    clearDragOutput();
    clearThumbnail();
    if (technicalDetails) technicalDetails.hidden = true;
    if (techGrid) techGrid.innerHTML = '';
    currentSourceId = null;
    currentProfileId = null;
    lastEligibleResult = null;
    currentJobId = null;
    currentSeq = -1;
    active = false;
    setBusy(false);
    if (message) announce(message);
    // ensure drop zone accessible
    if (dropZone) dropZone.hidden = false;
    // reset progress – single determinate bar, no layout shift
    if (convertBar) {
      convertBar.hidden = false;
      try { convertBar.value = 0; } catch {}
      convertBar.setAttribute('aria-valuenow', '0');
      convertBar.removeAttribute('aria-valuetext');
      convertBar.setAttribute('aria-label', 'Conversion progress');
    }
    if (btnCancel) { btnCancel.textContent = COPY.cancel; btnCancel.hidden = true; }
    const shouldFocus = hasPresentedIdle;
    hasPresentedIdle = true;
    if (shouldFocus && btnSelect && typeof btnSelect.focus === 'function') {
      try {
        if (document.contains(btnSelect) && stateIdle && !stateIdle.hidden) {
          btnSelect.focus();
        }
      } catch {}
    }
  }

  function showInspecting() {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    clearDragOutput();
    clearThumbnail();
    lastEligibleResult = null;
    if (technicalDetails) technicalDetails.hidden = true;
    if (stateInspecting) stateInspecting.hidden = false;
    if (stateFile) stateFile.hidden = true;
    setBusy(true);
    announce(COPY.inspecting);
  }

  function showFileMeta(result) {
    if (!result) return;
    const displayName = result.displayName || 'Video';
    if (fileNameEl) {
      fileNameEl.textContent = displayName;
      // single-line ellipsis; title tooltip only when needed and safe
      if (displayName && displayName !== '-' && displayName !== 'Video') {
        fileNameEl.title = displayName;
      } else {
        fileNameEl.removeAttribute('title');
      }
    }
    const details = formatFileDetails(result.size, result.duration);
    if (fileDetailsEl) fileDetailsEl.textContent = details || '';
    if (stateFile) stateFile.hidden = false;
    // technical details
    const fields = buildSafeTechnicalFields(result);
    if (techGrid) {
      techGrid.innerHTML = '';
      fields.forEach(f => {
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        dd.textContent = f.value;
        techGrid.appendChild(dt);
        techGrid.appendChild(dd);
      });
    }
    if (technicalDetails) technicalDetails.hidden = false;
  }

  function showEligible(result) {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    if (stateFile) stateFile.hidden = false;
    showFileMeta(result);
    const cls = (result && result.classification) || '';
    const fmt = getFormatLabel(cls);
    const desc = getEligibleDescription(cls);
    if (eligibleFormat) eligibleFormat.textContent = fmt;
    if (eligibleDesc) eligibleDesc.textContent = desc;
    if (stateEligible) stateEligible.hidden = false;
    if (btnConvert) btnConvert.disabled = false;
    setBusy(false);
    announce(`${COPY.eligibleTitle}. ${desc} ${fmt}`.trim());
  }

  function showUnsupported(result, classification) {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    if (stateFile) stateFile.hidden = false;
    showFileMeta(result);
    const copy = mapUnsupportedCopy(classification);
    if (unsupportedTitle) unsupportedTitle.textContent = copy.title;
    if (unsupportedDesc) unsupportedDesc.textContent = copy.desc;
    if (stateUnsupported) stateUnsupported.hidden = false;
    setBusy(false);
    announce(`${copy.title}. ${copy.desc}`);
  }

  function showError(message) {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    if (errorText) errorText.textContent = message;
    if (stateError) stateError.hidden = false;
    clearDragOutput();
    setBusy(false);
    announce(message);
  }

  function showConvertingPhase(text, percent) {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    // keep file visible if present
    if (fileNameEl && fileNameEl.textContent && fileNameEl.textContent !== '-') {
      if (stateFile) stateFile.hidden = false;
    }
    if (stateConverting) stateConverting.hidden = false;
    if (convertPhase) convertPhase.textContent = text;
    if (convertBar) {
      convertBar.hidden = false;
      convertBar.setAttribute('aria-label', 'Conversion progress');
      if (typeof percent === 'number' && Number.isFinite(percent)) {
        const clamped = Math.max(0, Math.min(100, percent));
        try { convertBar.value = clamped; } catch {}
        // ensure determinate – set value attribute for CSS :indeterminate fallback
        convertBar.setAttribute('value', String(clamped));
        convertBar.setAttribute('aria-valuenow', String(Math.round(clamped)));
        convertBar.removeAttribute('aria-valuetext');
      } else {
        // indeterminate: remove value, use aria-valuetext, keep visible – no layout shift
        try { convertBar.removeAttribute('value'); } catch {}
        // also remove property value to trigger indeterminate in some engines
        if ('value' in convertBar) { try { convertBar.value = null; } catch {} }
        convertBar.removeAttribute('aria-valuenow');
        convertBar.setAttribute('aria-valuetext', text);
      }
    }
    if (btnCancel) {
      btnCancel.hidden = false;
      btnCancel.textContent = COPY.cancel;
      btnCancel.disabled = false;
    }
    // keep technical details visible if previously shown
    setBusy(true);
    announce(text);
  }

  function showVerified(displayName) {
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    if (stateFile) stateFile.hidden = false;
    if (stateVerified) stateVerified.hidden = false;
    if (verifiedDesc) verifiedDesc.textContent = `${displayName}${COPY.verifiedSuffix}`;
    if (dragControl) dragControl.hidden = false;
    if (btnCancel) btnCancel.hidden = true;
    setBusy(false);
    announce(`${COPY.verifiedTitle}. ${displayName}${COPY.verifiedSuffix}`);
  }

  async function requestThumbnail(outputId) {
    if (!outputId || typeof outputId !== 'string') return;
    if (!window.hdrToSdr || typeof window.hdrToSdr.getOutputThumbnail !== 'function') return;
    const mySeq = ++thumbSeq;
    // ensure placeholder hidden until success
    if (verifiedThumbWrap) verifiedThumbWrap.hidden = true;
    if (outputThumb) outputThumb.hidden = true;
    try {
      const resp = await window.hdrToSdr.getOutputThumbnail(outputId);
      if (mySeq !== thumbSeq) return;
      if (currentOutputId !== outputId) return;
      if (!resp || resp.outcome !== 'ok' || typeof resp.dataUrl !== 'string') return;
      const url = resp.dataUrl;
      if (!url.startsWith('data:image/jpeg;base64,') && !url.startsWith('data:image/png;base64,')) return;
      if (url.length > 950 * 1024) return;
      if (outputThumb) {
        outputThumb.src = url;
        outputThumb.hidden = false;
      }
      if (verifiedThumbWrap) verifiedThumbWrap.hidden = false;
    } catch {
      // best-effort: ignore, drag remains
    }
  }

  function handleDragStart(e) {
    if (!currentOutputId) { e.preventDefault(); return; }
    try {
      if (window.hdrToSdr && typeof window.hdrToSdr.startOutputDrag === 'function') {
        window.hdrToSdr.startOutputDrag(currentOutputId);
        e.preventDefault();
      }
    } catch {}
  }

  function resetForNewJob() {
    clearDragOutput();
    clearThumbnail();
    currentJobId = null;
    currentSeq = -1;
  }

  function handleNeutralConversionCancel() {
    active = false;
    clearDragOutput();
    currentJobId = null;
    currentSeq = -1;
    if (btnCancel) { btnCancel.hidden = true; btnCancel.textContent = COPY.cancel; btnCancel.disabled = false; }
    const canRestore = lastEligibleResult && currentSourceId && currentProfileId && lastEligibleResult.sourceId === currentSourceId && (lastEligibleResult.profileId || null) === currentProfileId;
    if (canRestore) {
      showEligible(lastEligibleResult);
      announce(COPY.cancelledConversion);
      if (btnConvert && typeof btnConvert.focus === 'function') {
        try { btnConvert.focus(); } catch {}
      }
      setBusy(false);
      return true;
    }
    hideAllStates();
    if (stateIdle) stateIdle.hidden = true;
    if (fileNameEl && fileNameEl.textContent && fileNameEl.textContent !== '-') {
      if (stateFile) stateFile.hidden = false;
    }
    setBusy(false);
    announce(COPY.cancelledConversion);
    return false;
  }

  function renderResponse(resp) {
    if (!resp || typeof resp !== 'object') {
      resetToIdle(null);
      showError(COPY.inspectionFailed);
      return;
    }
    if (resp.outcome === 'cancelled') {
      // selection cancellation back to idle with No file selected.
      resetToIdle(COPY.cancelledIdle);
      // also show subtle idle announcement, not error card
      // For accessibility, announce idle message
      return;
    }
    if (resp.outcome === 'error') {
      const reason = resp.reason || '';
      const msg = mapInspectionError(reason);
      // Special handling for busy etc – map already
      // Hide file, show error
      hideAllStates();
      if (stateIdle) stateIdle.hidden = true;
      clearDragOutput();
      if (technicalDetails) technicalDetails.hidden = true;
      currentSourceId = null;
      currentProfileId = null;
      lastEligibleResult = null;
      showError(msg);
      return;
    }
    if (resp.outcome === 'complete') {
      const r = resp.result || {};
      const cls = r.classification || 'uncertain';
      // show file meta always for complete
      // Determine eligibility
      if (isEligibleResult(r)) {
        currentSourceId = r.sourceId;
        currentProfileId = r.profileId || null;
        lastEligibleResult = r;
        active = false;
        currentJobId = null;
        currentSeq = -1;
        clearDragOutput();
        showEligible(r);
        return;
      } else {
        // unsupported
        currentSourceId = null;
        currentProfileId = null;
        lastEligibleResult = null;
        clearDragOutput();
        // Decide which unsupported path: pq, dv, uncertain
        // r can be any classification
        hideAllStates();
        if (stateIdle) stateIdle.hidden = true;
        showUnsupported(r, cls);
        return;
      }
    }
    // unknown
    resetToIdle(null);
    showError(COPY.inspectionFailed);
  }

  async function handleInspectPath(p) {
    const val = (p != null ? String(p) : (pathInput ? pathInput.value : '')).trim();
    if (!val) {
      showError(COPY.inspectionFailed);
      return;
    }
    if (active) {
      showError(COPY.busy);
      return;
    }
    showInspecting();
    clearDragOutput();
    resetForNewJob();
    try {
      const resp = await window.hdrToSdr.inspectPath(val);
      renderResponse(resp);
    } catch (e) {
      showError(COPY.inspectionFailed);
    }
  }

  async function handleSelect() {
    if (active) {
      showError(COPY.busy);
      return;
    }
    showInspecting();
    clearDragOutput();
    resetForNewJob();
    // Note: we don't hide file yet until response, but showInspecting already cleared
    try {
      const resp = await window.hdrToSdr.selectAndInspect();
      renderResponse(resp);
    } catch {
      showError(COPY.inspectionFailed);
    }
  }

  async function handleDroppedFile(file) {
    if (active) {
      showError(COPY.busy);
      return;
    }
    showInspecting();
    clearDragOutput();
    resetForNewJob();
    try {
      const resp = await window.hdrToSdr.inspectDroppedFile(file);
      renderResponse(resp);
    } catch {
      showError(COPY.inspectionFailed);
    }
  }

  async function handleConvert() {
    if (!currentSourceId || !currentProfileId) {
      showError(COPY.conversionFailed);
      return;
    }
    if (active) {
      showError(COPY.busy);
      return;
    }
    active = true;
    clearDragOutput();
    if (btnConvert) btnConvert.disabled = true;
    showConvertingPhase(COPY.queued, 0);
    try {
      const resp = await window.hdrToSdr.convertStart(currentSourceId, currentProfileId);
      if (!resp || resp.outcome !== 'accepted' || !resp.jobId) {
        if (resp && resp.outcome === 'cancelled' && resp.reason === 'user_cancelled') {
          handleNeutralConversionCancel();
          return;
        }
        const reason = (resp && resp.reason) || 'conversion_failed';
        const msg = mapConversionError(reason);
        active = false;
        clearDragOutput();
        currentJobId = null;
        currentSeq = -1;
        lastEligibleResult = null;
        if (btnCancel) btnCancel.hidden = true;
        showError(msg);
        return;
      }
      currentJobId = resp.jobId;
      currentSeq = -1;
      announce(COPY.converting);
      showConvertingPhase(COPY.converting, 0);
    } catch {
      active = false;
      clearDragOutput();
      currentJobId = null;
      currentSeq = -1;
      lastEligibleResult = null;
      if (btnCancel) btnCancel.hidden = true;
      showError(COPY.conversionFailed);
    }
  }

  async function handleCancel() {
    if (!currentJobId) return;
    if (btnCancel) { btnCancel.textContent = COPY.cancelling; btnCancel.disabled = true; }
    try {
      await window.hdrToSdr.convertCancel(currentJobId);
      announce(COPY.cancelling);
    } catch {
      if (btnCancel) { btnCancel.textContent = COPY.cancel; btnCancel.disabled = false; }
    }
  }

  // Subscribe to convert events – preserve stale handling
  if (window.hdrToSdr && window.hdrToSdr.onConvertEvent) {
    window.hdrToSdr.onConvertEvent((ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.version !== 1) return;
      if (!currentJobId || ev.jobId !== currentJobId) return;
      if (typeof ev.seq !== 'number' || ev.seq <= currentSeq) return;
      currentSeq = ev.seq;

      if (ev.status === 'running') {
        if (ev.phase === 'queued') {
          const pct = typeof ev.percent === 'number' ? ev.percent : undefined;
          showConvertingPhase(COPY.queued, pct);
        } else if (ev.phase === 'converting') {
          const pct = typeof ev.percent === 'number' ? ev.percent : undefined;
          showConvertingPhase(COPY.converting, pct);
        } else if (ev.phase === 'verifying') {
          showConvertingPhase(COPY.verifying, undefined);
        }
      } else if (ev.status === 'success') {
        active = false;
        const name = ev.displayName || 'output';
        showVerified(name);
        if (ev.outputId && typeof ev.outputId === 'string') {
          showDragOutput(ev.outputId);
          requestThumbnail(ev.outputId);
        } else {
          clearThumbnail();
        }
        currentSourceId = null;
        currentProfileId = null;
        lastEligibleResult = null;
        currentJobId = null;
        currentSeq = -1;
      } else if (ev.status === 'cancelled') {
        handleNeutralConversionCancel();
      } else if (ev.status === 'error') {
        active = false;
        const reason = ev.reason || 'conversion_failed';
        const msg = mapConversionError(reason);
        clearDragOutput();
        currentJobId = null;
        currentSeq = -1;
        lastEligibleResult = null;
        hideAllStates();
        if (stateIdle) stateIdle.hidden = true;
        if (fileNameEl && fileNameEl.textContent && fileNameEl.textContent !== '-') {
          if (stateFile) stateFile.hidden = false;
        }
        showError(msg);
        if (btnCancel) btnCancel.hidden = true;
      }
    });
  }

  // Wire events
  if (dragOutput) {
    dragOutput.addEventListener('dragstart', handleDragStart);
    dragOutput.addEventListener('click', (e) => {
      // For button, click activation should also trigger drag for keyboard users where dragstart not fired
      if (e.detail === 0) {
        handleDragStart(e);
      }
    });
    dragOutput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleDragStart(e);
      }
    });
    clearDragOutput();
  }

  if (btnSelect) btnSelect.addEventListener('click', handleSelect);
  if (btnConvert) btnConvert.addEventListener('click', handleConvert);
  if (btnCancel) btnCancel.addEventListener('click', handleCancel);
  if (pathInput) pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleInspectPath();
    }
  });
  if (btnInspect) btnInspect.addEventListener('click', () => handleInspectPath());

  // Retry buttons
  document.querySelectorAll('.btn-retry').forEach(btn => {
    btn.addEventListener('click', handleSelect);
  });

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        handleDroppedFile(files[0]);
      } else {
        showError(COPY.dropUnavailable);
      }
    });
  }

  // Initial idle
  resetToIdle(null);
  // Ensure idle announcement not busy
  announce('');
})();
}
