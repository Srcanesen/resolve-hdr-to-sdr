const statusText = document.getElementById('status-text');
const spinner = document.getElementById('spinner');
const resultEl = document.getElementById('result');
const convertBtn = document.getElementById('convert-btn');
const eligibility = document.getElementById('eligibility');
const profileIdEl = document.getElementById('profile-id');
const eligibilityText = document.getElementById('eligibility-text');
const convertNote = document.getElementById('convert-note');
const pathForm = document.getElementById('path-form');
const pathInput = document.getElementById('path-input');
const fileInput = document.getElementById('file-input');
const pickerBtn = document.getElementById('picker-btn');
const dropZone = document.getElementById('drop-zone');

const TR = {
  pending: 'pending',
  inspecting: 'inspecting',
  success: 'success',
  failure: 'failure',
};

function setStatus(key) {
  statusText.textContent = TR[key] || key;
  if (key === 'inspecting') spinner.classList.remove('hidden');
  else spinner.classList.add('hidden');
}

function resetConvert() {
  convertBtn.disabled = true;
  eligibility.classList.add('hidden');
}

function handleResult(data) {
  const cls = data.classification || data.error || 'uncertain';
  const can = data.canConvert === true;
  const reason = data.reason || '';
  resultEl.textContent = JSON.stringify(data, null, 2);

  if (cls === 'hlgKnownLocal' && can) {
    setStatus('success');
    convertBtn.disabled = true;
    eligibility.classList.remove('hidden');
    profileIdEl.textContent = data.profileId || 'hlg-local-b-v1';
    eligibilityText.textContent = 'Profile B eligible — but conversion/output/Resolve drag is intentionally not implemented in this prototype.';
    convertNote.textContent = 'Convert disabled: prototype only inspects, it does not produce output.';
  } else if (cls === 'pqHdr10Unsupported' || cls === 'dolbyVisionUnsupported' || cls === 'uncertain' || data.error) {
    setStatus('failure');
    resetConvert();
    convertNote.textContent = reason ? `Reason: ${reason} — Convert disabled.` : 'Unsupported/uncertain — Convert disabled.';
  } else {
    setStatus('failure');
    resetConvert();
  }
}

function handleError(msg, extra) {
  setStatus('failure');
  resetConvert();
  resultEl.textContent = extra ? JSON.stringify(extra, null, 2) : msg;
}

async function inspectPath(path) {
  setStatus('inspecting');
  resetConvert();
  resultEl.textContent = 'Inspecting…';
  try {
    const res = await fetch('/api/inspect-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    // Even on 400, data contains classification/error; treat as failure UI
    if (res.ok) handleResult(data);
    else {
      // Map error payload to UI
      resultEl.textContent = JSON.stringify(data, null, 2);
      setStatus('failure');
      resetConvert();
      convertNote.textContent = data.reason ? `Error: ${data.reason} — Convert disabled.` : 'Error — Convert disabled.';
    }
  } catch (e) {
    handleError('Network/inspection error', { error: String(e) });
  }
}

async function inspectUpload(file) {
  if (!file) return;
  // Upload-protocol pre-check keeps 32 MiB client guard; error copy is generic (no size-limit claim).
  if (file.size > 32 * 1024 * 1024) {
    handleError('File too large');
    return;
  }
  setStatus('inspecting');
  resetConvert();
  resultEl.textContent = 'Uploading and inspecting…';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/inspect-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': file.name,
      },
      body: buf,
    });
    const data = await res.json();
    if (res.ok) handleResult(data);
    else {
      resultEl.textContent = JSON.stringify(data, null, 2);
      setStatus('failure');
      resetConvert();
      convertNote.textContent = data.reason ? `Error: ${data.reason} — Convert disabled.` : 'Error — Convert disabled.';
    }
  } catch (e) {
    handleError('Upload error', { error: String(e) });
  }
}

pathForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = pathInput.value.trim();
  if (!v) { handleError('Please enter an absolute path.'); return; }
  inspectPath(v);
});

pickerBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (f) inspectUpload(f);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) inspectUpload(f);
});

setStatus('pending');
resetConvert();
