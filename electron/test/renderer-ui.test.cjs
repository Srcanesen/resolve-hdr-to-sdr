const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererDir = path.resolve(__dirname, '..', 'renderer');
const appPath = path.join(rendererDir, 'app.js');
const htmlPath = path.join(rendererDir, 'index.html');
const cssPath = path.join(rendererDir, 'styles.css');
const conversionServicePath = path.resolve(__dirname, '..', 'conversion-service.cjs');

// Load pure helpers (DOM-free)
const helpers = require('../renderer/app.js');

test('COPY contains required English workflow copies and no forbidden visible', () => {
  const { COPY, containsForbiddenVisible } = helpers;
  // Persistent
  assert.equal(helpers.COPY.eligibleTitle, 'Ready to convert');
  assert.equal(COPY.eligibleDesc, 'This video can be converted with a verified HDR → SDR profile.');
  assert.equal(COPY.eligibleDescHlg, 'HLG video can be converted with the verified HDR → SDR profile.');
  assert.equal(COPY.eligibleDescPq, 'HDR10 video can be converted with the verified HDR → SDR profile.');
  assert.equal(COPY.verifiedTitle, 'Output ready');
  assert.equal(COPY.queued, 'Preparing conversion…');
  assert.equal(COPY.converting, 'Converting HDR → SDR…');
  assert.equal(COPY.verifying, 'Verifying output…');
  assert.equal(COPY.cancel, 'Cancel');
  assert.equal(COPY.cancelling, 'Cancelling…');
  assert.equal(COPY.verifiedDrag, 'Drag to Resolve');
  assert.equal(COPY.verifiedHelp, 'Drop into the Media Pool or timeline.');
  assert.equal(COPY.retry, 'Choose another file');
  assert.equal(COPY.busy, 'Another operation is in progress. Please wait for it to finish.');
  assert.equal(COPY.unsupportedExtension, 'Only MOV and MP4 files can be selected.');
  assert.equal(COPY.dropUnavailable, 'Could not get the file. Try choosing a file instead.');
  assert.equal(COPY.inspectionFailed, 'Video could not be inspected. Check the file type.');
  assert.equal(COPY.profileUnavailable, 'Conversion is not available on this system.');
  assert.equal(COPY.verificationFailed, 'Output could not be verified. File was not made available.');
  assert.equal(COPY.conversionFailed, 'Conversion could not be completed. Inspect the video again and try again.');
  assert.equal(COPY.cancelledIdle, 'No file selected.');
  assert.equal(COPY.technicalLabel, 'Technical details');
  assert.equal(COPY.inspecting, 'Inspecting video…');
  // Unsupported copies
  assert.equal(COPY.unsupported.pq.title, 'PQ / HDR10 detected');
  assert.equal(COPY.unsupported.pq.desc, 'This version does not support PQ / HDR10 conversion.');
  assert.equal(COPY.unsupported.dv.title, 'Dolby Vision detected');
  assert.equal(COPY.unsupported.dv.desc, 'This version does not convert this Dolby Vision video.');
  assert.equal(COPY.unsupported.uncertain.title, 'HDR type could not be verified');
  assert.equal(COPY.unsupported.uncertain.desc, 'Color metadata is missing or contradictory. Conversion did not start.');

  // Ensure no COPY value contains forbidden visible strings
  const allCopyVals = [];
  function collect(obj) {
    for (const v of Object.values(obj)) {
      if (typeof v === 'string') allCopyVals.push(v);
      else if (v && typeof v === 'object') collect(v);
    }
  }
  collect(COPY);
  for (const txt of allCopyVals) {
    assert.equal(containsForbiddenVisible(txt), false, `COPY value should not contain forbidden visible: ${txt}`);
    // also ensure no absolute path leakage in visible copy (allow slash in "PQ / HDR10" display)
    if (txt.includes('~/Movies') || txt.includes('/tmp') || txt.includes('/var')) {
      assert.fail(`COPY should not contain absolute path: ${txt}`);
    }
  }
});

test('eligible format label and description are profile-aware pure helpers', () => {
  const { getFormatLabel, getEligibleDescription, COPY, containsForbiddenVisible } = helpers;
  assert.equal(typeof getFormatLabel, 'function', 'getFormatLabel must be pure helper');
  assert.equal(typeof getEligibleDescription, 'function', 'getEligibleDescription must be pure helper');
  // HLG paths
  assert.equal(getFormatLabel('hlgKnownLocal'), 'HLG');
  assert.equal(getFormatLabel('hlgSupported'), 'HLG');
  // PQ path
  assert.equal(getFormatLabel('pqSupported'), 'PQ / HDR10');
  assert.equal(getFormatLabel('uncertain'), '');
  assert.equal(getFormatLabel('pqHdr10Unsupported'), '');
  assert.equal(getFormatLabel(undefined), '');
  // Descriptions: HLG vs HDR10 vs generic fallback
  assert.equal(getEligibleDescription('hlgKnownLocal'), COPY.eligibleDescHlg);
  assert.equal(getEligibleDescription('hlgSupported'), COPY.eligibleDescHlg);
  assert.equal(getEligibleDescription('pqSupported'), COPY.eligibleDescPq);
  assert.equal(getEligibleDescription('uncertain'), COPY.eligibleDesc);
  assert.equal(getEligibleDescription(undefined), COPY.eligibleDesc);
  // Ensure descriptions contain HLG or HDR10 accordingly and no forbidden/profile IDs
  assert.ok(getEligibleDescription('hlgSupported').includes('HLG'), 'HLG desc contains HLG');
  assert.ok(getEligibleDescription('pqSupported').includes('HDR10'), 'PQ desc contains HDR10');
  assert.equal(getEligibleDescription('hlgSupported').toLowerCase().includes('hlg-local'), false, 'must not expose profile ID');
  assert.equal(getEligibleDescription('pqSupported').toLowerCase().includes('pq-rec'), false, 'must not expose profile ID');
  assert.equal(containsForbiddenVisible(getEligibleDescription('hlgSupported')), false);
  assert.equal(containsForbiddenVisible(getEligibleDescription('pqSupported')), false);
});

test('format helpers privacy and correctness', () => {
  const { formatFileSize, formatDuration, formatFileDetails, containsForbiddenVisible } = helpers;
  // size
  assert.equal(formatFileSize(100), '100 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(12.4 * 1024 * 1024), '12.4 MB');
  assert.ok(formatFileSize(32 * 1024 * 1024).includes('MB'));
  // duration
  assert.equal(formatDuration('5'), '5 s');
  assert.equal(formatDuration('65'), '1:05');
  assert.equal(formatDuration(125.2), '2:05');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration('invalid'), '');
  // file details combines without leaking
  const d = formatFileDetails(12 * 1024 * 1024, '65');
  assert.ok(d.includes('MB'));
  assert.ok(d.includes('1:05'));
  assert.equal(containsForbiddenVisible(d), false);
  // ensure not containing path
  assert.equal(d.includes('/tmp'), false);
});

test('mapUnsupportedCopy safe mapping', () => {
  const { mapUnsupportedCopy, COPY } = helpers;
  assert.deepEqual(mapUnsupportedCopy('pqHdr10Unsupported'), COPY.unsupported.pq);
  assert.deepEqual(mapUnsupportedCopy('dolbyVisionUnsupported'), COPY.unsupported.dv);
  assert.deepEqual(mapUnsupportedCopy('uncertain'), COPY.unsupported.uncertain);
  assert.deepEqual(mapUnsupportedCopy('unknown'), COPY.unsupported.uncertain);
  assert.deepEqual(mapUnsupportedCopy(undefined), COPY.unsupported.uncertain);
  // ensure mapped values are safe and not raw reason
  const pq = mapUnsupportedCopy('pqHdr10Unsupported');
  assert.equal(pq.title.includes('pq_transfer'), false);
  assert.equal(pq.desc.includes('allowlist'), false);
});

test('error mapping safe only', () => {
  const { mapInspectionError, mapConversionError, COPY } = helpers;
  assert.equal(mapInspectionError('busy'), COPY.busy);
  assert.equal(mapInspectionError('unsupported_extension'), COPY.unsupportedExtension);
  assert.equal(mapInspectionError('drop_path_unavailable'), COPY.dropUnavailable);
  assert.equal(mapInspectionError('inspection_failed'), COPY.inspectionFailed);
  assert.equal(mapInspectionError('random_reason'), COPY.inspectionFailed);
  assert.equal(mapInspectionError('invalid_request'), COPY.inspectionFailed);

  assert.equal(mapConversionError('busy'), COPY.busy);
  assert.equal(mapConversionError('profile_unavailable'), COPY.profileUnavailable);
  assert.equal(mapConversionError('verification_failed'), COPY.verificationFailed);
  assert.equal(mapConversionError('conversion_failed'), COPY.conversionFailed);
  assert.equal(mapConversionError('unknown'), COPY.conversionFailed);

  // ensure no raw reason leakage in mapped output
  for (const r of ['busy', 'unsupported_extension', 'drop_path_unavailable', 'profile_unavailable', 'verification_failed', 'conversion_failed', 'some_raw_reason_xyz']) {
    const a = mapInspectionError(r);
    const b = mapConversionError(r);
    assert.equal(a.includes(r), false, 'inspection mapping should not echo raw reason');
    assert.equal(b.includes(r), false, 'conversion mapping should not echo raw reason');
  }
});

test('isEligibleResult and privacy – never uses profileId literal', () => {
  const { isEligibleResult } = helpers;
  const good = { classification: 'hlgKnownLocal', canConvert: true, sourceId: '550e8400-e29b-41d4-a716-446655440000' };
  assert.equal(isEligibleResult(good), true);
  assert.equal(isEligibleResult({ classification: 'hlgKnownLocal', canConvert: true, sourceId: '' }), false);
  assert.equal(isEligibleResult({ classification: 'pqHdr10Unsupported', canConvert: false, sourceId: 'x' }), false);
  assert.equal(isEligibleResult({ classification: 'hlgKnownLocal', canConvert: false, sourceId: 'x' }), false);
  assert.equal(isEligibleResult(null), false);
  // ensure helper does not leak profileId by checking app.js does not need to contain HLG id in eligible check? We'll verify source file
  const appSrc = fs.readFileSync(appPath, 'utf8');
  // isEligibleResult function definition should not contain literal hlg-local-b-v1
  const eligibleFn = appSrc.slice(appSrc.indexOf('function isEligibleResult'), appSrc.indexOf('function buildSafeTechnicalFields'));
  assert.equal(eligibleFn.includes('hlg-local-b-v1'), false, 'eligible check should not embed raw profile identifier');
});

test('buildSafeTechnicalFields only safe semantic fields, no forbidden keys', () => {
  const { buildSafeTechnicalFields, containsForbiddenVisible } = helpers;
  const res = { displayName: 'my.mov', size: 1234567, duration: '12.34', classification: 'hlgKnownLocal', sha256: 'a'.repeat(64), reason: 'allowlist_hlg_match', profileId: 'hlg-local-b-v1', color: { a: 1 } };
  const fields = buildSafeTechnicalFields(res);
  // should contain size/duration converted and biçim
  assert.ok(fields.some(f => f.label === 'Size'));
  assert.ok(fields.some(f => f.label === 'Duration'));
  assert.ok(fields.some(f => f.label === 'Format'));
  // should not contain hash/reason/profile
  const combined = JSON.stringify(fields);
  assert.equal(combined.includes('sha256'), false);
  assert.equal(combined.includes('allowlist'), false);
  assert.equal(combined.includes('hlg-local-b'), false);
  assert.equal(combined.includes('hash'), false);
  // values should not contain forbidden
  for (const f of fields) {
    assert.equal(containsForbiddenVisible(f.value), false, `field value should be safe: ${f.label}=${f.value}`);
    assert.equal(containsForbiddenVisible(f.label), false);
  }
  // privacy: ensure no raw path leakage
  const withPath = { displayName: '/tmp/secret.mov', size: 100, duration: '5', classification: 'uncertain' };
  const f2 = buildSafeTechnicalFields(withPath);
  const vals = f2.map(x => x.value).join(' ');
  assert.equal(vals.includes('/tmp'), false);
});

test('stale event handling – sequence and jobId and version', () => {
  const { shouldAcceptConvertEvent } = helpers;
  const jobId = '550e8400-e29b-41d4-a716-446655440000';
  const otherJob = '550e8400-e29b-41d4-a716-446655440001';
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId, seq: 0, phase: 'converting', status: 'running' }, jobId, -1), true);
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId, seq: 0, phase: 'converting', status: 'running' }, jobId, 0), false, 'seq equal should be stale');
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId, seq: 1, phase: 'converting', status: 'running' }, jobId, 0), true);
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId: otherJob, seq: 5, phase: 'converting', status: 'running' }, jobId, 0), false, 'wrong jobId stale');
  assert.equal(shouldAcceptConvertEvent({ version: 2, jobId, seq: 5, phase: 'converting', status: 'running' }, jobId, 0), false, 'wrong version');
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId, seq: -1, phase: 'converting', status: 'running' }, jobId, -1), false, 'negative seq still <= current should be false for next expecting 0');
  assert.equal(shouldAcceptConvertEvent(null, jobId, -1), false);
});

test('getConvertPhaseCopy maps to English', () => {
  const { getConvertPhaseCopy, COPY } = helpers;
  assert.equal(getConvertPhaseCopy('queued'), COPY.queued);
  assert.equal(getConvertPhaseCopy('converting'), COPY.converting);
  assert.equal(getConvertPhaseCopy('verifying'), COPY.verifying);
});

test('HTML structure contains required semantic surface and no forbidden visible', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  // Persistent
  assert.ok(html.includes('<h1 class="app-title">HdrToSdr</h1>'), 'must have title');
  assert.ok(html.includes('Convert HDR video to a Rec.709 SDR output. The source file is not modified.'), 'subtitle');
  // Idle
  assert.ok(html.includes('Drop your video here'), 'idle drop');
  assert.ok(html.includes('MOV or MP4'), 'idle support');
  assert.equal(html.includes('en fazla 32 MB'), false, 'no size cap copy');
  assert.ok(html.includes('>Choose file</button>'), 'idle pick');
  // No idle card language
  // Inspecting
  assert.ok(html.includes('Inspecting video…'), 'inspecting');
  // Eligible
  assert.ok(html.includes('Ready to convert'), 'eligible title');
  assert.ok(html.includes('This video can be converted with a verified HDR → SDR profile.'), 'eligible desc generic fallback in markup');
  assert.ok(html.includes('id="eligible-format"'), 'eligible format label element exists');
  assert.ok(html.includes('class="format-label"'), 'format-label semantic (not pill/card)');
  assert.ok(html.includes('id="eligible-desc"'), 'eligible-desc has id for profile-aware update');
  assert.equal(html.includes('class="pill"') || html.includes('class="card"') && html.includes('eligible-format'), false, 'format label must not be pill/card');
  assert.ok(html.includes('Convert HDR → SDR'), 'cta');
  assert.ok(html.includes('Creates a separate Rec.709 H.264 MP4 file. Compact and compatible.'), 'eligible support H.264 MP4 truthful');
  // Converting uses single progress, no second indeterminate
  assert.ok(html.includes('id="convert-bar"'), 'single convert progress exists');
  assert.equal(html.includes('id="convert-indeterminate"'), false, 'second conversion indeterminate must be removed');
  assert.ok(html.includes('<progress'), 'progress element present');
  // File meta density containers exist
  assert.ok(html.includes('id="file-name"'), 'file-name exists');
  assert.ok(html.includes('id="file-details"'), 'file-details exists');
  // Spacing utilities used instead of inline styles for eligible/converting/unsupported/error
  assert.ok(html.includes('class="mt-12"') || html.includes('mt-12'), 'spacing class used (eligible/unsupported/error)');
  assert.ok(html.includes('class="mt-8"') || html.includes('mt-8'), 'spacing class for converting');
  // Verified
  assert.ok(html.includes('Output ready'), 'verified title');
  assert.ok(html.includes('Drag to Resolve'), 'drag');
  assert.ok(html.includes('Drop into the Media Pool or timeline.'), 'drag helper');
  // Unsupported – HTML must have container, JS provides copy (not statically in HTML)
  assert.ok(html.includes('id="state-unsupported"'), 'unsupported container');
  assert.ok(html.includes('id="unsupported-title"'), 'unsupported title element');
  // verify JS COPY provides pq title
  const { COPY } = helpers;
  assert.ok(COPY.unsupported.pq.title.includes('PQ / HDR10'), 'pq title in COPY');
  // Retry button
  assert.ok(html.includes('Choose another file'), 'retry');
  // Technical details
  assert.ok(html.includes('<details'), 'details element');
  assert.ok(html.includes('Technical details'), 'technical label');
  assert.ok(html.includes('aria-live="polite"'), 'aria-live');
  assert.ok(html.includes('aria-busy'), 'aria-busy');
  // Keyboard access and draggable – drag button must be focusable element, drop zone not nested interactive
  assert.ok(html.includes('draggable="true"'), 'draggable');
  assert.ok(html.includes('<button type="button" id="drag-output"'), 'drag button is real button');
  // drop-zone must not be interactive wrapper
  const dropZoneTag = html.match(/<div[^>]*id="drop-zone"[^>]*>/);
  assert.ok(dropZoneTag, 'drop-zone exists');
  assert.equal(dropZoneTag[0].includes('role="button"'), false, 'drop-zone must not be role button when containing button');
  assert.equal(dropZoneTag[0].includes('tabindex'), false, 'drop-zone must not be focusable button');
  assert.ok(html.includes('id="btn-select"'), 'select button exists');
  // Forbidden visible checks – ensure html does not contain raw forbidden strings as visible UI
  const lower = html.toLowerCase();
  assert.equal(lower.includes('smoke'), false, 'html must not contain smoke');
  assert.equal(lower.includes('ertelendi'), false, 'html must not contain ertelendi');
  // Ensure no SHA visible in html text nodes (outside of maybe code comments, but we check)
  // We allow sha only in maybe script src but not visible
  // Check that old forbidden UI like SHA-256, Geliştirme Kabuğu, ham yol removed
  assert.equal(html.includes('SHA-256'), false, 'must not show SHA');
  assert.equal(html.includes('Geliştirme Kabuğu'), false, 'old title removed');
  assert.equal(html.includes('Kapsam dışı'), false, 'deferred removed');
  assert.equal(html.includes('beklemede'), false, 'old beklemede removed unless part of new? but new does not use beklemede');
});

test('CSS hooks – dark graphite + amber, radius, motion, forced-colors, density', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  // System font stack
  assert.ok(css.includes('-apple-system'), 'system font');
  // 13px body
  assert.ok(css.includes('font-size: 13px'), '13px body');
  // 17px title
  assert.ok(css.includes('font-size: 17px'), '17px title');
  // radius 4/6
  assert.ok(css.includes('4px') && css.includes('6px'), 'radius 4/6');
  // spacing 4/8/12/16/24
  assert.ok(css.includes('24px'), 'spacing 24');
  // amber accent
  assert.ok(css.toLowerCase().includes('#d9a525') || css.toLowerCase().includes('var(--amber'), 'amber accent');
  // no gradients
  assert.equal(css.toLowerCase().includes('linear-gradient'), false, 'no gradients');
  assert.equal(css.toLowerCase().includes('radial-gradient'), false);
  // no glass / backdrop-filter
  assert.equal(css.toLowerCase().includes('backdrop-filter'), false, 'no glass');
  assert.equal(css.toLowerCase().includes('glass'), false, 'no glow/gradient triple-check');
  // graphite dark
  assert.ok(css.includes('#1c1c1e') || css.includes('#2a2a2a') || css.includes('graphite') || css.includes('--bg'), 'dark graphite');
  // prefers-reduced-motion
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced motion');
  // forced-colors
  assert.ok(css.includes('forced-colors'), 'forced-colors');
  // visible focus
  assert.ok(css.includes('focus-visible'), 'visible focus');
  // responsive
  assert.ok(css.includes('@media'), 'responsive');
  assert.ok(css.includes('320px') || css.includes('max-width: 320'), '320 hook');
  // Compact density and preserve-mode polish
  // Drop affordance: idle drop-zone must not have pointer cursor or hover amber – only dragover has amber
  assert.ok(css.includes('cursor: default') || css.includes('cursor:default'), 'drop-zone neutral cursor not pointer');
  assert.equal(css.includes('.drop-zone:hover'), false, 'drop-zone hover-as-click removed');
  assert.ok(css.includes('.drop-zone.dragover'), 'dragover amber retained');
  // File meta density: ellipsis single line, no break-all
  assert.ok(css.includes('text-overflow: ellipsis') && css.includes('white-space: nowrap'), 'file-name one line ellipsis');
  assert.equal(css.includes('.file-name') && css.toLowerCase().includes('word-break: break-all') && css.match(/\.file-name[^}]*break-all/), null, 'file-name must not use break-all');
  // Verified drag area neutral border/background, padding 10 gap 6, amber only on button
  assert.ok(css.includes('.drag-control'), 'drag-control exists');
  const dragBlock = css.slice(css.indexOf('.drag-control'), css.indexOf('.drag-control')+400);
  assert.ok(dragBlock.includes('var(--border-strong)') || dragBlock.includes('#3f3f44'), 'drag-control neutral border');
  assert.ok(dragBlock.includes('var(--surface-raised)') || dragBlock.includes('#2c2c2f'), 'drag-control neutral background');
  assert.ok(dragBlock.includes('padding: 10px'), 'drag-control padding 10px');
  assert.ok(dragBlock.includes('gap: 6px'), 'drag-control gap 6px');
  assert.equal(dragBlock.includes('var(--amber-bg)') && dragBlock.includes('border: 1px solid var(--amber)'), false, 'drag-control must not be amber');
  assert.ok(css.includes('.drag-button') && css.slice(css.indexOf('.drag-button'), css.indexOf('.drag-button')+400).includes('var(--amber)'), 'drag button amber retained');
  // Format label compact semantic
  assert.ok(css.includes('.format-label'), 'format-label style exists');
  const fmtBlock = css.slice(css.indexOf('.format-label'), css.indexOf('.format-label')+300);
  assert.ok(fmtBlock.includes('11px') || fmtBlock.includes('12px'), 'format-label compact');
  assert.equal(fmtBlock.includes('pill') || fmtBlock.includes('card') || fmtBlock.includes('background: var(--amber'), false, 'format-label not pill/card');
  // Progress stability: reduced-motion static fallback for progress indeterminate and no layout shift
  assert.ok(css.includes('progress:indeterminate'), 'progress indeterminate styled');
  assert.ok(css.includes('prefers-reduced-motion') && css.slice(css.indexOf('prefers-reduced-motion: reduce'), css.indexOf('prefers-reduced-motion: reduce')+600).includes('progress:indeterminate'), 'reduced-motion progress fallback');
  // Spacing utilities
  assert.ok(css.includes('.mt-8') && css.includes('.mt-12'), 'spacing classes exist');
});

test('secure-window backgroundColor is dark app background #1c1c1e', () => {
  const secSrc = fs.readFileSync(path.join(__dirname, '..', 'secure-window.cjs'), 'utf8');
  const appCss = fs.readFileSync(cssPath, 'utf8');
  // Background must be actual dark app bg #1c1c1e, not light #fafafa
  assert.ok(secSrc.includes("backgroundColor: '#1c1c1e'") || secSrc.includes('backgroundColor: "#1c1c1e"'), 'secure-window backgroundColor #1c1c1e');
  assert.equal(secSrc.includes("#fafafa"), false, 'must not retain light background');
  // Width bounds unchanged
  assert.ok(secSrc.includes('width: WIDTH') || secSrc.includes('width: 600') || secSrc.includes('WIDTH = 600'), 'width 600 preserved');
  assert.ok(secSrc.includes('minWidth') && secSrc.includes('maxWidth'), 'min/max bounds preserved');
  // Dark graphite in CSS matches
  assert.ok(appCss.includes('#1c1c1e'), 'css dark bg matches window');
});

test('progress stability – single progress element with value/aria handling', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const src = fs.readFileSync(appPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  // HTML: only one progress, no second indeterminate
  const progCount = (html.match(/<progress/g) || []).length;
  assert.ok(progCount >= 1, 'at least one progress');
  // Ensure converting state has exactly one convert-bar and zero convert-indeterminate
  const convertingSection = html.slice(html.indexOf('id="state-converting"'), html.indexOf('id="state-converting"')+800);
  assert.equal((convertingSection.match(/id="convert-bar"/g) || []).length, 1, 'single convert-bar');
  assert.equal(convertingSection.includes('convert-indeterminate'), false, 'no second indeterminate in converting');
  // Inspecting still has its indeterminate-bar
  const inspectingSection = html.slice(html.indexOf('id="state-inspecting"'), html.indexOf('id="state-inspecting"')+600);
  assert.ok(inspectingSection.includes('indeterminate-bar'), 'inspecting indeterminate retained');
  // JS: percent known sets value/aria-valuenow, unknown removes value and uses aria-valuetext, keeps visible
  assert.ok(src.includes("removeAttribute('value')") || src.includes('removeAttribute("value")'), 'removes value for indeterminate');
  assert.ok(src.includes("aria-valuenow") && src.includes("aria-valuetext"), 'handles both aria attrs');
  assert.ok(src.indexOf("aria-valuetext") > src.indexOf("removeAttribute('value'") || src.indexOf('aria-valuetext') > 0, 'uses valuetext for unknown');
  assert.equal(src.includes("convertBar.hidden = true"), false, 'must not hide convertBar for indeterminate (keep visible, no layout shift)');
  // The old pattern convertIndeterminate.hidden toggle must be gone
  assert.equal(src.includes('convertIndeterminate'), false, 'no convertIndeterminate references');
  // CSS: reduced-motion static fallback for progress indeterminate
  assert.ok(css.includes('progress:indeterminate'), 'progress indeterminate css');
  const reducedBlock = css.slice(css.indexOf('prefers-reduced-motion: reduce'), css.indexOf('prefers-reduced-motion: reduce')+700);
  assert.ok(reducedBlock.includes('progress:indeterminate'), 'reduced-motion progress fallback');
  // progress-wrap stays same height – check progress height 6px stable
  assert.ok(css.includes('height: 6px'), 'progress height stable 6px');
});

test('file meta density – single line ellipsis, no break-all, title tooltip', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const src = fs.readFileSync(appPath, 'utf8');
  // HTML structure
  assert.ok(html.includes('id="file-name"') && html.includes('class="file-name"'), 'file-name element');
  assert.ok(html.includes('id="file-details"') && html.includes('class="file-details"'), 'file-details separate line');
  // CSS: ellipsis
  const fileNameCss = css.slice(css.indexOf('.file-name'), css.indexOf('.file-name')+300);
  assert.ok(fileNameCss.includes('text-overflow: ellipsis'), 'ellipsis');
  assert.ok(fileNameCss.includes('white-space: nowrap'), 'single line nowrap');
  assert.ok(fileNameCss.includes('overflow: hidden'), 'overflow hidden');
  assert.equal(/\.file-name[^}]*break-all/.test(css), false, 'no break-all on file-name');
  // JS: title tooltip safe sanitized only
  assert.ok(src.includes('fileNameEl.title'), 'sets title for ellipsis tooltip');
  assert.ok(src.includes('displayName'), 'uses sanitized displayName');
  // Responsive 320 hook still present
  assert.ok(css.includes('320px'), '320 readable');
  // Ensure sanitized displayName handling – title set, no path leakage
  assert.ok(src.includes('displayName'), 'uses sanitized displayName');
  assert.equal(src.includes('dataset'), false, 'no dataset leakage via file meta');
});

test('verified drag area neutral surface and drop affordance', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const src = fs.readFileSync(appPath, 'utf8');
  // Drag area neutral
  const dragCss = css.slice(css.indexOf('.drag-control'), css.indexOf('.drag-control')+500);
  assert.ok(dragCss.includes('var(--border-strong)'), 'neutral border');
  assert.ok(dragCss.includes('var(--surface-raised)'), 'neutral background');
  assert.ok(dragCss.includes('padding: 10px'), 'padding 10');
  assert.ok(dragCss.includes('gap: 6px'), 'gap 6');
  // Amber only on button
  const btnCss = css.slice(css.indexOf('.drag-button'), css.indexOf('.drag-button')+400);
  assert.ok(btnCss.includes('var(--amber)'), 'button amber');
  // Drop affordance: no pointer, no hover amber, but dragover amber
  assert.ok(css.includes('cursor: default'), 'drop-zone cursor default not pointer');
  assert.equal(css.includes('.drop-zone:hover'), false, 'no hover-as-click');
  assert.ok(css.includes('.drop-zone.dragover'), 'dragover feedback');
  // JS must not add parent click handler
  assert.equal(src.includes("dropZone.addEventListener('click'"), false, 'no parent click handler');
  // Drag button semantics preserved
  assert.ok(html.includes('draggable="true"'), 'draggable');
  assert.ok(src.includes("dragOutput.addEventListener('dragstart'"), 'dragstart');
});

test('outcome hierarchy – unsupported/error titles parity, spacing classes, no glow', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  // Unsupported/error both use status-title/status-desc
  assert.ok(html.includes('id="unsupported-title"') && html.includes('class="status-title"'), 'unsupported title parity');
  assert.ok(html.includes('id="error-text"') && html.includes('status-desc'), 'error desc parity');
  // Both have mt-12 spacing wrapper
  const unsBlock = html.slice(html.indexOf('id="state-unsupported"'), html.indexOf('id="state-unsupported"')+600);
  assert.ok(unsBlock.includes('mt-12'), 'unsupported spacing class');
  const errBlock = html.slice(html.indexOf('id="state-error"'), html.indexOf('id="state-error"')+500);
  assert.ok(errBlock.includes('mt-12'), 'error spacing class');
  // No glow/gradient/glass/icons
  assert.equal(css.toLowerCase().includes('box-shadow: 0 0'), false, 'no glow');
  assert.equal(css.toLowerCase().includes('linear-gradient'), false, 'no gradient');
  assert.equal(css.toLowerCase().includes('backdrop-filter'), false, 'no glass');
  // No em-dash in visible strings (html)
  assert.equal(html.includes('—'), false, 'no em-dash in html');
  // Check no icon pill card decorations added
  assert.equal(html.includes('class="pill"') || html.includes('class="card"'), false, 'no new cards/pills');
});

test('copy audit – English, H.264 MP4 truthful, no profile IDs/paths/raw reasons', () => {
  const { COPY, containsForbiddenVisible, getFormatLabel, getEligibleDescription } = helpers;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(appPath, 'utf8');
  // Visible strings English – check file contains H.264 MP4
  assert.ok(html.includes('Creates a separate Rec.709 H.264 MP4 file. Compact and compatible.'), 'H.264 MP4 truthful eligible support');
  assert.ok(html.includes('Tümü') === false, 'no stale copy');
  // No profile IDs in visible HTML or COPY values
  const visibleCombined = html + JSON.stringify(COPY);
  assert.equal(visibleCombined.includes('hlg-local-b-v1'), false, 'no profile ID in visible');
  assert.equal(visibleCombined.includes('hlg-rec709-v1'), false, 'no profile ID');
  assert.equal(visibleCombined.includes('pq-rec709-v1'), false, 'no pq profile ID');
  // No path/raw reason leakage
  assert.equal(visibleCombined.includes('~/Movies'), false, 'no path');
  assert.equal(visibleCombined.includes('allowlist'), false, 'no raw reason');
  // Resolve drag wording preserved
  assert.ok(COPY.verifiedDrag.includes('Resolve'), 'Resolve drag wording');
  assert.ok(html.includes('Drag to Resolve'), 'drag button English');
  // No em-dash in visible COPY
  for (const v of Object.values(COPY)) {
    if (typeof v === 'string') assert.equal(v.includes('—'), false, `no em-dash in COPY: ${v}`);
    if (v && typeof v === 'object') {
      for (const sub of Object.values(v)) if (typeof sub === 'string') assert.equal(sub.includes('—'), false);
    }
  }
  assert.equal(html.includes('—'), false, 'no em-dash in html');
  // Design preflight: one dark theme, one amber accent, radius 4/6 consistent
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.ok(css.includes('#1c1c1e'), 'dark theme #1c1c1e');
  assert.ok(css.toLowerCase().includes('#d9a525') || css.includes('var(--amber'), 'one amber accent');
  assert.ok(css.includes('4px') && css.includes('6px'), 'radius 4/6 consistent');
  // Contrast/focus: focus-visible present
  assert.ok(css.includes('focus-visible'), 'focus visible');
  // One live region, reduced motion, no nested interactive already covered elsewhere
});

test('static scan – renderer surface must not contain forbidden visible strings/keys', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(appPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  // Combine visible surface: html text + COPY values + convert phase text assignments that are user-facing
  // We'll scan html and js user-facing strings (textContent assignments, COPY values) for forbidden patterns.
  // Define forbidden patterns that should never appear as visible UI (case-insensitive for rendered UI)
  const forbiddenVisible = [
    'smoke',
    'ertelendi',
    'Kapsam dışı',
    'Geliştirme Kabuğu',
    '~/movies/hdrtosdr',
    'allowlist_hlg_match',
    'pq_transfer_detected',
    'dovi_not_allowlisted',
    'unspecified_metadata',
    'contradictory_metadata',
    'unknown_or_missing',
    'hlgknownlocal', // raw classification if rendered
    'hlg-local-b-v1', // profile id
    'profileunavailable',
    'verification_failed', // raw reason
    'conversion_failed',
    'sha-256',
    'sha256'
  ];
  const combinedVisible = (html + js).toLowerCase();
  // We will check html separately for user-visible; js COPY is allowed to have mapping keys internally but should not render them as UI.
  // However ensure that js does not contain textContent assignment with raw reason strings as visible.
  // Check that js does not set textContent to raw profileId or sha256 etc. via regex for textContent = r. patterns
  assert.equal(/r\.sha256/.test(js) || /r\.sha/.test(js), false, 'renderer must not reference sha directly for UI');
  // Check html forbidden
  for (const pat of forbiddenVisible) {
    if (pat === 'sha256' || pat === 'sha-256') {
      // already checked that html shouldn't have SHA
      assert.equal(html.toLowerCase().includes(pat), false, `html must not contain ${pat}`);
    } else if (['smoke','ertelendi'].includes(pat)) {
      assert.equal(html.toLowerCase().includes(pat), false, `html must not contain ${pat}`);
      // also js visible strings should not contain literal smoke/ertelendi outside of test helper? Check js COPY values already ensure not, but also check js overall not containing smoke in user strings (except maybe helper list)
      // Our helper contains forbidden list that includes smoke intentionally for check – allow it but ensure not in COPY
      // So we skip checking js for smoke in helper definition
    } else {
      // For raw reason patterns, ensure they only appear in mapping function definitions (allowed internal) but not in html visible
      // We'll just ensure html does't contain them
      assert.equal(html.toLowerCase().includes(pat), false, `html must not contain raw identifier ${pat}`);
    }
  }
  // Ensure no absolute path visible in html/js UI strings (like "/tmp", "/var", "~/Movies")
  // Html should not have "/Movies" visible text
  assert.equal(html.includes('~/Movies'), false, 'html must not contain path');
  // JS COPY values checked earlier not to contain path; already ensures
  // Ensure no data-attribute outputId/sourceId leakage in html
  assert.equal(html.includes('data-output'), false);
  assert.equal(html.includes('data-source'), false);
  // Ensure no raw JSON display in html
  assert.equal(html.includes('<pre'), false, 'html must not contain pre for raw JSON');
  assert.equal(html.includes('r-technical'), false, 'old technical pre id removed');
});

test('conversion-service native confirmation English and no path', () => {
  const src = fs.readFileSync(conversionServicePath, 'utf8');
  assert.ok(src.includes("buttons: ['Cancel', 'Convert']") || src.includes('Cancel'), 'buttons English');
  assert.ok(src.includes('Convert HDR → SDR'), 'title English');
  assert.ok(src.includes('A separate Rec.709 H.264 MP4 file will be created. The source video is not modified. Compact and compatible.'), 'detail English');
  assert.equal(src.includes('Output will be written'), false, 'old English detail removed');
  assert.equal(src.includes('Start conversion?'), false, 'old title removed');
  // Ensure dialog detail does not contain path – check around showMessageBox block
  const dialogBlock = src.slice(src.indexOf('showMessageBox'), src.indexOf('showMessageBox') + 500);
  assert.equal(dialogBlock.includes('~/Movies'), false, 'dialog must not contain output path');
  assert.equal(dialogBlock.includes('outputPath') && dialogBlock.includes('detail'), false, 'dialog detail must not leak path');
});

test('preload and ipc contracts unchanged – no renderer path leakage', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '..', 'preload.cjs'), 'utf8');
  // Should not have been modified to include path
  assert.ok(preload.includes('startOutputDrag'));
  assert.equal(preload.includes('canonicalPath'), false);
});

test('app.js DOM handling preserves keyboard and drag and aria', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  // Preserve picker via real button + drop handling; drop-zone must not be interactive button
  assert.equal(src.includes("dropZone.addEventListener('click'"), false, 'drop-zone click must be removed (button is picker)');
  assert.equal(src.includes("dropZone.addEventListener('keydown'"), false, 'drop-zone keydown must be removed');
  assert.ok(src.includes("btnSelect.addEventListener('click'"), 'picker button click');
  // drag button keyboard activation
  assert.ok(src.includes("e.key === 'Enter'"), 'Enter handling');
  assert.ok(src.includes("e.key === ' '"), 'Space handling');
  // drag button must handle dragstart and keyboard
  assert.ok(src.includes("dragOutput.addEventListener('dragstart'"), 'dragstart on button');
  assert.ok(src.includes("dragOutput.addEventListener('keydown'"), 'drag button keydown');
  assert.ok(src.includes('dragover'), 'dragover');
  assert.ok(src.includes('drop'), 'drop');
  // inspect/conversion/cancel/native-drag
  assert.ok(src.includes('handleSelect'), 'select');
  assert.ok(src.includes('handleConvert'), 'convert');
  assert.ok(src.includes('handleCancel'), 'cancel');
  assert.ok(src.includes('handleDragStart'), 'drag');
  assert.ok(src.includes('startOutputDrag'), 'native drag');
  // New preserve-mode polish: single progress, no second indeterminate
  assert.equal(src.includes('convertIndeterminate'), false, 'second conversion indeterminate must be removed');
  assert.equal(src.includes('convert-indeterminate'), false, 'no convert-indeterminate id reference');
  assert.ok(src.includes('convertBar'), 'convertBar single progress exists');
  assert.ok(src.includes("removeAttribute('value')") || src.includes('removeAttribute("value")'), 'indeterminate via remove value');
  assert.ok(src.includes("aria-valuetext") && src.includes("aria-valuenow"), 'progress aria handling for determinate vs indeterminate');
  assert.ok(src.includes('getFormatLabel'), 'format label helper used');
  assert.ok(src.includes('getEligibleDescription'), 'eligible description helper used');
  assert.ok(src.includes('eligibleFormat'), 'eligibleFormat DOM ref');
  assert.ok(src.includes('eligibleDesc'), 'eligibleDesc DOM ref');
  // File meta ellipsis handling
  assert.ok(src.includes('fileNameEl.title') || src.includes('.title ='), 'file-name title tooltip handling');
  // stale-event
  assert.ok(src.includes('ev.version !== 1'), 'version check');
  assert.ok(src.includes('ev.jobId !== currentJobId'), 'jobId check');
  assert.ok(src.includes('ev.seq <= currentSeq'), 'seq monotonic');
  // aria
  assert.ok(src.includes('aria-busy'), 'aria-busy');
  assert.ok(src.includes('aria-live') || src.includes('announce'), 'aria-live');
  // focus
  assert.ok(src.includes('.focus()'), 'focus drag');
  // drag cleared on new inspect/error/cancel
  assert.ok(src.includes('clearDragOutput'), 'clearDrag');
  // never put IDs/paths in DOM
  assert.equal(src.includes('dataset'), false, 'no dataset leakage');
  assert.equal(src.includes('data-'), false);
  assert.equal(src.includes('.setAttribute(\'data'), false);
});

test('P0: no nested interactive drop zone static', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dz = html.match(/<div[^>]*id="drop-zone"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(dz, 'drop-zone exists');
  const openTag = html.match(/<div[^>]*id="drop-zone"[^>]*>/)[0];
  assert.equal(openTag.includes('role='), false, 'drop-zone must not have role button');
  assert.equal(openTag.includes('tabindex'), false, 'drop-zone must not have tabindex');
  assert.equal(openTag.includes('aria-label'), false, 'drop-zone must not have aria-label as button');
  assert.ok(dz[0].includes('id="btn-select"'), 'drop-zone contains real select button');
  assert.ok(html.includes('<button type="button" id="btn-select"'), 'btn-select is real button');
});

test('P0: inspecting progress accessible – no aria-hidden ancestor', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  // inspecting progress must be role progressbar with label and not hidden by ancestor
  assert.ok(html.includes('role="progressbar"'), 'progressbar exists');
  // ensure progress-wrap for inspecting is not aria-hidden
  assert.equal(html.includes('<div class="progress-wrap" aria-hidden="true">'), false, 'inspecting wrap must not be aria-hidden');
  // check inspecting progress has accessible label
  const barMatch = html.match(/role="progressbar"[^>]*>/);
  assert.ok(barMatch, 'progressbar tag found');
  assert.ok(barMatch[0].includes('aria-label'), 'progressbar has label');
  // ensure inspecting progress wrap itself is not aria-hidden (span with aria-hidden is sibling decorative, not ancestor)
  const inspectingSection = html.slice(html.indexOf('id="state-inspecting"'), html.indexOf('id="state-inspecting"') + 600);
  const wrapTag = inspectingSection.match(/<div class="progress-wrap"[^>]*>/);
  assert.ok(wrapTag, 'progress-wrap exists');
  assert.equal(wrapTag[0].includes('aria-hidden'), false, 'progress wrap must not be aria-hidden');
  // indeterminate allowed but must have valuemin/max or valuetext
  assert.ok(barMatch[0].includes('aria-valuemin') || barMatch[0].includes('aria-valuetext'), 'progressbar has range/value semantics');
});

test('P0: drag-output is real button with draggable and keyboard activation', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const src = fs.readFileSync(appPath, 'utf8');
  assert.ok(html.includes('<button type="button" id="drag-output"'), 'drag-output is button type button');
  assert.ok(html.includes('id="drag-output" draggable="true"'), 'drag button draggable true');
  assert.equal(html.includes('<div id="drag-output"'), false, 'must not be div');
  const dragTag = html.match(/<button[^>]*id="drag-output"[^>]*>/)[0];
  assert.equal(dragTag.includes('role="button"'), false, 'button must not have redundant role');
  assert.equal(dragTag.includes('tabindex'), false, 'button natively focusable, no tabindex needed');
  // js preserves dragstart and keyboard
  assert.ok(src.includes("dragOutput.addEventListener('dragstart'"), 'dragstart preserved');
  assert.ok(src.includes("dragOutput.addEventListener('keydown'"), 'keyboard activation preserved');
  assert.ok(src.includes('handleDragStart'), 'handleDragStart exists');
  assert.ok(src.includes('startOutputDrag'), 'calls native drag');
  // safe no-ID behavior
  assert.ok(src.includes('if (!currentOutputId)'), 'safe no-ID check');
  // focus on verified
  assert.ok(src.includes('dragOutput.focus()') || src.includes('dragOutput.focus'), 'focus on verified');
});

test('P0: sole live region is #live-announcer, workflow not live', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const workflowTag = html.match(/<section[^>]*id="workflow"[^>]*>/)[0];
  assert.equal(workflowTag.includes('aria-live'), false, 'workflow must not have aria-live');
  assert.equal(workflowTag.includes('aria-atomic'), false, 'workflow must not have aria-atomic');
  assert.ok(workflowTag.includes('aria-busy'), 'workflow retains aria-busy');
  const liveCount = (html.match(/aria-live="polite"/g) || []).length;
  assert.equal(liveCount, 1, 'exactly one aria-live polite (live-announcer)');
  assert.equal((html.match(/role="status"/g) || []).length, 0, 'no role=status; live-announcer is sole announcer');
  assert.ok(html.includes('id="live-announcer"'), 'live-announcer exists');
  const announcerMatch = html.match(/<p[^>]*id="live-announcer"[^>]*>/)[0];
  assert.ok(announcerMatch.includes('aria-live'), 'announcer is live region');
  // ensure announce function uses live-announcer not workflow
  const src = fs.readFileSync(appPath, 'utf8');
  assert.ok(src.includes('liveAnnouncer.textContent'), 'announce uses live-announcer');
  assert.equal((src.match(/workflow.*aria-live/g) || []).length, 0, 'workflow not used as live');
});

test('P1: dark color-scheme without weakening forced-colors', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.ok(css.includes('color-scheme'), 'color-scheme present');
  // must be dark on html
  const htmlRule = css.match(/html\s*\{[^}]*\}/g);
  assert.ok(htmlRule && htmlRule.some(r => r.includes('color-scheme') && r.includes('dark')), 'html has color-scheme dark');
  assert.ok(css.includes('forced-colors'), 'forced-colors preserved');
  assert.ok(css.includes('forced-colors: active'), 'forced-colors active block intact');
});

test('P1: return focus to #btn-select after idle reset (not initial paint) and safe handling', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  // must focus btnSelect after resetToIdle
  assert.ok(src.includes('btnSelect.focus'), 'focuses btn-select');
  // must be inside resetToIdle
  const resetIdx = src.indexOf('function resetToIdle');
  const nextFnIdx = src.indexOf('function showInspecting', resetIdx);
  const resetBody = src.slice(resetIdx, nextFnIdx);
  assert.ok(resetBody.includes('btnSelect.focus'), 'focus inside resetToIdle');
  assert.ok(resetBody.includes('hasPresentedIdle') || resetBody.includes('hasRendered') || resetBody.includes('initial'), 'not autofocus at initial paint guard');
  // safe when unavailable/destroyed
  assert.ok(resetBody.includes('document.contains') || resetBody.includes('contains(btnSelect)'), 'safe destroyed check');
  assert.ok(resetBody.includes('typeof btnSelect.focus') || resetBody.includes("btnSelect &&"), 'safe availability check');
  // must check visibility (stateIdle not hidden)
  assert.ok(resetBody.includes('stateIdle') && resetBody.includes('hidden'), 'checks visible before focus');
});

test('P0: keyboard activation on real select button not wrapper', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  // wrapper must not handle keyboard for select
  assert.equal(src.includes("dropZone.addEventListener('keydown'"), false, 'drop-zone must not handle Enter/Space');
  assert.ok(src.includes("btnSelect.addEventListener('click'"), 'select button handles click');
  // native button handles Enter/Space via click, so key handling on button not required but drag button still needs Enter/Space
  assert.ok(src.includes("dragOutput.addEventListener('keydown'"), 'drag button handles keyboard');
});

test('responsive and visual density – single workflow surface, no duplicate cards', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  // Should have workflow single surface
  assert.ok(html.includes('id=\"workflow\"'), 'single workflow');
  // Should not have duplicate status/result cards like old .status and .results
  assert.equal(html.includes('class=\"status\"'), false, 'no duplicate status card');
  assert.equal(html.includes('class=\"results\"'), false, 'no duplicate results card');
  assert.equal(html.includes('class=\"deferred\"'), false, 'no deferred');
});

// --- Neutral, retryable conversion cancellation (renderer only) ---
test('COPY cancelledConversion neutral English and safe', () => {
  const { COPY, containsForbiddenVisible } = helpers;
  assert.equal(COPY.cancelledConversion, 'Conversion cancelled.');
  assert.equal(containsForbiddenVisible(COPY.cancelledConversion), false);
  // ensure not mapped as error copy
  assert.notEqual(COPY.cancelledConversion, COPY.conversionFailed);
  assert.notEqual(COPY.cancelledConversion, COPY.cancelledIdle);
});

test('handleConvert maps user_cancelled as neutral, not generic conversion failure', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const convertIdx = src.indexOf('async function handleConvert');
  const nextIdx = src.indexOf('async function handleCancel', convertIdx);
  const body = src.slice(convertIdx, nextIdx);
  // must check for cancelled outcome before error mapping
  assert.ok(body.includes("resp.outcome === 'cancelled'") && body.includes("'user_cancelled'") , 'checks user_cancelled before error');
  // must delegate to neutral helper, not showError with conversionFailed
  assert.ok(body.includes('handleNeutralConversionCancel'), 'delegates to neutral helper');
  // the cancelled branch must return before mapConversionError for that case
  const cancelledPos = body.indexOf("'user_cancelled'");
  const mapPos = body.indexOf('mapConversionError', cancelledPos);
  // ensure neutral handling appears before generic error handling in same function
  assert.ok(cancelledPos < mapPos || body.slice(cancelledPos, mapPos).includes('handleNeutralConversionCancel'), 'neutral before generic');
  // must not trigger reinspection IPC on neutral decline
  const neutralSlice = body.slice(cancelledPos, cancelledPos + 600);
  assert.equal(neutralSlice.includes('inspectPath'), false, 'no inspectPath on neutral');
  assert.equal(neutralSlice.includes('selectAndInspect'), false, 'no selectAndInspect on neutral');
  assert.equal(neutralSlice.includes('inspectDroppedFile'), false, 'no inspectDroppedFile on neutral');
});

test('terminal cancelled event is neutral and restores eligible state', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const evIdx = src.indexOf("window.hdrToSdr.onConvertEvent");
  const evBlock = src.slice(evIdx, evIdx + 2500);
  // cancelled handling must be neutral
  assert.ok(evBlock.includes("ev.status === 'cancelled'") , 'handles cancelled event');
  assert.ok(evBlock.includes('handleNeutralConversionCancel'), 'cancelled event delegates to neutral');
  // must not show generic conversion failure for cancelled – isolate cancelled branch only
  const cancelledPos = evBlock.indexOf("ev.status === 'cancelled'");
  const nextErrorPos = evBlock.indexOf("ev.status === 'error'", cancelledPos);
  const cancelledBranch = evBlock.slice(cancelledPos, nextErrorPos > 0 ? nextErrorPos : cancelledPos + 400);
  assert.equal(cancelledBranch.includes('showError(COPY.conversionFailed)'), false, 'cancelled must not map to conversionFailed');
  assert.equal(cancelledBranch.includes('mapConversionError'), false, 'cancelled must not map via conversion error');
  assert.equal(cancelledBranch.includes("COPY.conversionFailed"), false, 'cancelled branch must not mention conversionFailed');
});

test('neutral cancel retains active inspected source tokens (no ID reuse)', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const helperIdx = src.indexOf('function handleNeutralConversionCancel');
  const helperBody = src.slice(helperIdx, helperIdx + 1200);
  // must retain source/profile, clear only job/seq
  assert.ok(helperBody.includes('currentJobId = null'), 'clears jobId');
  assert.ok(helperBody.includes('currentSeq = -1'), 'clears seq');
  assert.ok(helperBody.includes('clearDragOutput'), 'clears verified output and drag');
  // must NOT clear source/profile on neutral
  assert.ok(helperBody.includes('lastEligibleResult') && helperBody.includes('currentSourceId') && helperBody.includes('currentProfileId'), 'retains eligible source/profile');
  const beforeRestore = helperBody.slice(0, helperBody.indexOf('showEligible'));
  assert.equal(beforeRestore.includes('currentSourceId = null'), false, 'neutral must not null source before restore');
  assert.equal(beforeRestore.includes('currentProfileId = null'), false, 'neutral must not null profile before restore');
  // must check eligibility matches active source
  assert.ok(helperBody.includes('lastEligibleResult.sourceId === currentSourceId'), 'retains only for active inspected source');
  assert.ok(helperBody.includes('(lastEligibleResult.profileId || null) === currentProfileId'), 'checks profile match');
  // do not re-use cancelled jobId – ensures null before next convert
  assert.ok(helperBody.includes('currentJobId = null'), 'does not reuse cancelled jobId');
});

test('CTA focus logic after neutral cancel enables and focuses convert button', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const helperIdx = src.indexOf('function handleNeutralConversionCancel');
  const helperBody = src.slice(helperIdx, helperIdx + 1300);
  // showEligible enables button
  assert.ok(src.includes('function showEligible') && src.slice(src.indexOf('function showEligible'), src.indexOf('function showEligible')+600).includes('btnConvert.disabled = false'), 'showEligible enables CTA');
  // neutral helper must focus enabled button after restore
  assert.ok(helperBody.includes('btnConvert.focus'), 'focuses CTA after neutral');
  assert.ok(helperBody.includes('typeof btnConvert.focus'), 'safe focus check');
  assert.ok(helperBody.includes('showEligible(lastEligibleResult)'), 'restores eligible before focus');
  // announce neutral Turkish copy
  assert.ok(helperBody.includes('announce(COPY.cancelledConversion)'), 'announces Conversion cancelled.');
});

test('neutral cancellation requires no source reinspection IPC call', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const helperIdx = src.indexOf('function handleNeutralConversionCancel');
  const helperBody = src.slice(helperIdx, helperIdx + 1200);
  // helper must not invoke any inspect channel
  assert.equal(helperBody.includes('inspectPath'), false);
  assert.equal(helperBody.includes('selectAndInspect'), false);
  assert.equal(helperBody.includes('inspectDroppedFile'), false);
  assert.equal(helperBody.includes('hdrToSdr.inspect'), false);
  assert.equal(helperBody.includes('ipcRenderer.invoke'), false, 'no direct IPC invoke for reinspection');
  // also handleConvert neutral branch must not call reinspection
  const cIdx = src.indexOf('async function handleConvert');
  const cBody = src.slice(cIdx, cIdx + 1200);
  const neutralPos = cBody.indexOf("'user_cancelled'");
  const neutralAfter = cBody.slice(neutralPos, neutralPos + 400);
  assert.equal(neutralAfter.includes('inspect'), false, 'neutral branch does not reinspect');
});

test('error separation – real conversion failure still shows safe error state', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  // error event mapping must remain
  const evIdx = src.indexOf("window.hdrToSdr.onConvertEvent");
  const evBlock = src.slice(evIdx, evIdx + 3000);
  const errorPos = evBlock.indexOf("ev.status === 'error'");
  assert.ok(errorPos > -1, 'handles error event');
  const errorSegment = evBlock.slice(errorPos, errorPos + 800);
  assert.ok(errorSegment.includes('mapConversionError'), 'error maps via mapConversionError');
  assert.ok(errorSegment.includes('showError('), 'error shows error surface');
  assert.ok(errorSegment.includes('lastEligibleResult = null'), 'error clears retained eligibility');
  // convertStart failure (non-cancelled) must map to error as well
  const cIdx = src.indexOf('async function handleConvert');
  const cBody = src.slice(cIdx, cIdx + 1500);
  // after user_cancelled check, next branch is generic error
  assert.ok(cBody.includes('mapConversionError'), 'convert failure maps to conversion error');
  assert.ok(cBody.includes('showError(msg)'), 'convert failure shows error');
  // ensure neutral copy not used for error
  assert.equal(errorSegment.includes('COPY.cancelledConversion'), false, 'error must not announce neutral copy');
});

test('stale cancellation rejection preserved for terminal cancelled', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const evIdx = src.indexOf("window.hdrToSdr.onConvertEvent");
  const guardBlock = src.slice(evIdx, evIdx + 600);
  // must retain version/job/seq guards before any status handling
  assert.ok(guardBlock.includes('ev.version !== 1'), 'version guard preserved');
  assert.ok(guardBlock.includes('ev.jobId !== currentJobId'), 'jobId guard preserved');
  assert.ok(guardBlock.includes('ev.seq <= currentSeq'), 'seq monotonic guard preserved');
  // helpers should still be correct
  const { shouldAcceptConvertEvent } = helpers;
  const jid = '550e8400-e29b-41d4-a716-446655440000';
  const other = '550e8400-e29b-41d4-a716-446655440001';
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId: jid, seq: 0, phase: 'cancelled', status: 'cancelled' }, jid, -1), true);
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId: jid, seq: 0, phase: 'cancelled', status: 'cancelled' }, jid, 0), false, 'stale seq rejected');
  assert.equal(shouldAcceptConvertEvent({ version: 1, jobId: other, seq: 5, phase: 'cancelled', status: 'cancelled' }, jid, 0), false, 'wrong jobId rejected');
  assert.equal(shouldAcceptConvertEvent({ version: 2, jobId: jid, seq: 5, phase: 'cancelled', status: 'cancelled' }, jid, 0), false, 'wrong version rejected');
  // app.js must apply same guards before cancelled handling – ensure cancelled not handled if stale
  const cancelledPos = src.indexOf("ev.status === 'cancelled'");
  const beforeCancelled = src.slice(evIdx, cancelledPos);
  assert.ok(beforeCancelled.includes('ev.jobId !== currentJobId'), 'stale job check before cancelled');
});

test('eligible retention stored and cleared correctly', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  // renderResponse must store lastEligible on eligible
  assert.ok(src.includes('lastEligibleResult = r') || src.includes('lastEligibleResult=r'), 'stores eligible result');
  // error and unsupported must clear
  const renderIdx = src.indexOf('function renderResponse');
  const renderBody = src.slice(renderIdx, renderIdx + 2500);
  assert.ok(renderBody.includes('lastEligibleResult = null'), 'clears on non-eligible');
  // showInspecting must clear retention (new inspection invalidates prior)
  const inspectIdx = src.indexOf('function showInspecting');
  const inspectBody = src.slice(inspectIdx, inspectIdx + 500);
  assert.ok(inspectBody.includes('lastEligibleResult = null'), 'clears on new inspecting');
  // resetToIdle must clear
  const idleIdx = src.indexOf('function resetToIdle');
  const idleBody = src.slice(idleIdx, idleIdx + 700);
  assert.ok(idleBody.includes('lastEligibleResult = null'), 'clears on idle reset');
  // success must clear (verified output no longer needs eligibility)
  assert.ok(src.includes("ev.status === 'success'") && src.slice(src.indexOf("ev.status === 'success'"), src.indexOf("ev.status === 'success'")+600).includes('lastEligibleResult = null'), 'clears on success');
});

test('verified output and drag cleared at conversion start and on neutral cancel', () => {
  const src = fs.readFileSync(appPath, 'utf8');
  const cIdx = src.indexOf('async function handleConvert');
  const cBody = src.slice(cIdx, cIdx + 800);
  assert.ok(cBody.includes('clearDragOutput'), 'clears drag at conversion start');
  const helperIdx = src.indexOf('function handleNeutralConversionCancel');
  const helperBody = src.slice(helperIdx, helperIdx + 600);
  assert.ok(helperBody.includes('clearDragOutput'), 'clears drag on cancel');
  // also resetToIdle and success path already clear via clearDragOutput – check exists
  assert.ok(src.includes('function clearDragOutput'), 'clear helper exists');
});

