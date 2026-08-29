const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNEL = 'hdrtosdr:inspect';
const CONVERT_START = 'hdrtosdr:convert:start';
const CONVERT_CANCEL = 'hdrtosdr:convert:cancel';
const CONVERT_EVENT = 'hdrtosdr:convert:event';
const OUTPUT_DRAG_CHANNEL = 'hdrtosdr:output-drag:start';
const THUMBNAIL_CHANNEL = 'hdrtosdr:output:thumbnail';

const api = {
  selectAndInspect() {
    return ipcRenderer.invoke(CHANNEL, { kind: 'dialog' });
  },
  inspectPath(p) {
    return ipcRenderer.invoke(CHANNEL, { kind: 'path', path: String(p) });
  },
  inspectDroppedFile(file) {
    try {
      const fp = webUtils.getPathForFile(file);
      if (!fp || typeof fp !== 'string' || fp.length === 0) {
        return Promise.resolve({ outcome: 'error', reason: 'drop_path_unavailable' });
      }
      return ipcRenderer.invoke(CHANNEL, { kind: 'path', path: fp });
    } catch {
      return Promise.resolve({ outcome: 'error', reason: 'drop_path_unavailable' });
    }
  },
  convertStart(sourceId, profileId) {
    return ipcRenderer.invoke(CONVERT_START, { version: 1, sourceId: String(sourceId), profileId: String(profileId) });
  },
  convertCancel(jobId) {
    return ipcRenderer.invoke(CONVERT_CANCEL, { version: 1, jobId: String(jobId) });
  },
  onConvertEvent(callback) {
    const handler = (_event, data) => {
      try { callback(data); } catch {}
    };
    ipcRenderer.on(CONVERT_EVENT, handler);
    return () => ipcRenderer.removeListener(CONVERT_EVENT, handler);
  },
  startOutputDrag(outputId) {
    try {
      if (typeof outputId !== 'string' || outputId.length === 0) return;
      ipcRenderer.send(OUTPUT_DRAG_CHANNEL, { version: 1, outputId: String(outputId) });
    } catch {}
  },
  getOutputThumbnail(outputId) {
    try {
      if (typeof outputId !== 'string' || outputId.length === 0) return Promise.resolve({ outcome: 'error', reason: 'invalid_request' });
      return ipcRenderer.invoke(THUMBNAIL_CHANNEL, { version: 1, outputId: String(outputId) });
    } catch {
      return Promise.resolve({ outcome: 'error', reason: 'invalid_request' });
    }
  },
};

contextBridge.exposeInMainWorld('hdrToSdr', Object.freeze(api));
