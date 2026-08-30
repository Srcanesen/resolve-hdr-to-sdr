const { app, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const { createSecureWindow } = require('./secure-window.cjs');
const { bootstrap } = require('./bootstrap.cjs');
const adapter = require('./inspection-adapter.cjs');
const { OUTPUT_DRAG_CHANNEL, isValidOutputDragRequest } = require('./conversion-service.cjs');

const PLUGIN_ID = 'com.hdrtosdr.app';
const DRAG_ICON_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAM0lEQVR4nO3QQQ0AAAgDMUA25iGo4NMZuKUZPROPq8+4AwQIECBAgAABAgQIECBAgMAJLN2aAriXDiGXAAAAAElFTkSuQmCC';
let DRAG_ICON = null;
try {
  DRAG_ICON = nativeImage.createFromDataURL(DRAG_ICON_DATAURL);
} catch {}

let mainWindow = null;
let conversionService = null;
let started = false;
let cleanupDone = false;
let workflowIntegration = null;
let beforeQuitApp = null;
let beforeQuitHandler = null;
let beforeQuitInFlight = null;
const RUNTIME_DISPOSE_TIMEOUT_MS = 5_000;

function logStartupFailure(stage = 'startup') {
  const safeStages = new Set(['host_lifecycle', 'app_ready', 'window_create', 'startup']);
  const safeStage = safeStages.has(stage) ? stage : 'startup';
  try { console.error(`[HdrToSdr] startup failed (${safeStage})`); } catch {}
}

function disposeRuntime() {
  try {
    if (conversionService && typeof conversionService.dispose === 'function') {
      return Promise.resolve(conversionService.dispose()).catch(() => {});
    }
  } catch {}
  return Promise.resolve();
}

async function disposeRuntimeBounded() {
  let timer;
  await Promise.race([
    disposeRuntime(),
    new Promise((resolve) => {
      timer = setTimeout(resolve, RUNTIME_DISPOSE_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function cleanupHost(wi) {
  if (!wi || cleanupDone) return;
  cleanupDone = true;
  try { if (typeof wi.CleanUp === 'function') wi.CleanUp(); } catch {}
}

function removeBeforeQuitHandler() {
  if (beforeQuitApp && beforeQuitHandler) {
    try {
      if (typeof beforeQuitApp.removeListener === 'function') beforeQuitApp.removeListener('before-quit', beforeQuitHandler);
      else if (typeof beforeQuitApp.off === 'function') beforeQuitApp.off('before-quit', beforeQuitHandler);
    } catch {}
  }
  beforeQuitApp = null;
  beforeQuitHandler = null;
}

function installBeforeQuitHandler(appObj, wi, isHost) {
  removeBeforeQuitHandler();
  beforeQuitInFlight = null;
  const handler = (event) => {
    if (beforeQuitInFlight) return;
    try {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    } catch {}
    beforeQuitInFlight = (async () => {
      await disposeRuntimeBounded();
      if (isHost) cleanupHost(wi);
      // Remove only this handler before resuming quit. Host/application
      // listeners owned elsewhere remain installed and can observe the final
      // quit attempt without causing this handler to recurse.
      removeBeforeQuitHandler();
      try { appObj.quit(); } catch {}
    })().catch(() => {
      removeBeforeQuitHandler();
      try { appObj.quit(); } catch {}
    });
    return beforeQuitInFlight;
  };
  try {
    appObj.on('before-quit', handler);
    beforeQuitApp = appObj;
    beforeQuitHandler = handler;
  } catch {
    throw new Error('before_quit_listener_failed');
  }
}

function getExpectedFileUrl() {
  const filePath = path.resolve(__dirname, 'renderer', 'index.html');
  return url.pathToFileURL(filePath).toString();
}

function tryLoadWorkflowIntegration(external) {
  if (external !== undefined && external !== null) return external;
  try {
    const candidate = path.join(__dirname, 'WorkflowIntegration.node');
    if (fs.existsSync(candidate)) {
      // Do not source from ClipDock; only from official bundle location (this directory)
      return require(candidate);
    }
    return null;
  } catch {
    return null;
  }
}

function isValidDragSender(event) {
  try {
    if (!mainWindow || !mainWindow.webContents) return false;
    if (event.sender !== mainWindow.webContents) return false;
    const mainFrame = mainWindow.webContents.mainFrame;
    if (!mainFrame) return false;
    if (event.senderFrame !== mainFrame) return false;
    const expected = getExpectedFileUrl();
    const senderUrl = event.senderFrame.url;
    if (senderUrl !== expected) return false;
    return true;
  } catch {
    return false;
  }
}

function registerDragHandler() {
  try {
    // Remove previous listeners for idempotency
    ipcMain.removeAllListeners(OUTPUT_DRAG_CHANNEL);
  } catch {}
  ipcMain.on(OUTPUT_DRAG_CHANNEL, (event, req) => {
    try {
      if (!isValidOutputDragRequest(req)) return;
      if (!isValidDragSender(event)) return;
      if (!DRAG_ICON || (typeof DRAG_ICON.isEmpty === 'function' && DRAG_ICON.isEmpty())) return;
      try {
        const size = DRAG_ICON.getSize();
        if (!size || size.width !== 32 || size.height !== 32) return;
      } catch {
        return;
      }
      if (!conversionService) return;
      const senderId = event.sender && typeof event.sender.id === 'number' ? event.sender.id : null;
      if (senderId == null) return;
      const resolved = conversionService.resolveOutputForDrag({ outputId: req.outputId, senderWebContentsId: senderId });
      if (!resolved || !resolved.ok) return;
      const filePath = resolved.canonicalPath;
      if (!filePath || typeof filePath !== 'string') return;
      // Synchronously call startDrag
      event.sender.startDrag({ file: filePath, icon: DRAG_ICON });
    } catch {
      // fail closed, ignore
    }
  });
}

function createWindowInternal() {
  if (mainWindow) return mainWindow;
  mainWindow = createSecureWindow();
  conversionService = bootstrap(mainWindow, adapter, conversionService);
  registerDragHandler();

  if (!process.env.HDRTOSDR_PYTHON) {
    console.warn('[HdrToSdr] HDRTOSDR_PYTHON is not set. Example: HDRTOSDR_PYTHON="$(command -v python3)" npm start');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Plugin window close quits app (host and dev)
  mainWindow.on('close', () => {
    try { app.quit(); } catch {}
  });

  return mainWindow;
}

async function hostLifecycle(wi, appObj, onPartialFailure = () => {}) {
  let ok;
  let initialized = false;
  const fail = () => {
    if (initialized) {
      try { onPartialFailure(); } catch {}
    }
    return false;
  };
  try {
    ok = wi.Initialize(PLUGIN_ID);
    if (ok && typeof ok.then === 'function') ok = await ok;
  } catch {
    ok = false;
  }
  if (!ok) return false;
  initialized = true;
  try {
    ok = wi.SetAPITimeout(10);
    if (ok && typeof ok.then === 'function') ok = await ok;
  } catch {
    ok = false;
  }
  if (!ok) return fail();
  try {
    const quitCb = () => { try { appObj.quit(); } catch {} };
    ok = wi.RegisterCallback('ResolveQuit', quitCb);
    if (ok && typeof ok.then === 'function') ok = await ok;
  } catch {
    ok = false;
  }
  if (!ok) return fail();
  return true;
}

function failClosedGeneric(appObj) {
  try {
    if (dialog && typeof dialog.showErrorBox === 'function') {
      dialog.showErrorBox('HdrToSdr', 'Startup failed');
    }
  } catch {}
  try { appObj.quit(); } catch {}
  try { appObj.exit(1); } catch {}
}

async function startApp(options = {}) {
  if (started) return { ok: false, reason: 'already_started' };
  started = true;
  const appObj = options.app || app;
  const wi = tryLoadWorkflowIntegration(options.workflowIntegration);
  workflowIntegration = wi;
  const isHost = !!wi && typeof wi.Initialize === 'function';

  cleanupDone = false;

  if (isHost) {
    let lifecycleOk = false;
    try {
      lifecycleOk = await hostLifecycle(wi, appObj, () => cleanupHost(wi));
    } catch {
      lifecycleOk = false;
    }
    if (!lifecycleOk) {
      logStartupFailure('host_lifecycle');
      failClosedGeneric(appObj);
      return { ok: false, reason: 'startup_failed' };
    }
  }

  try {
    // Install before readiness so a later app/window failure still has one
    // owned cleanup edge. Do not remove listeners owned by the host.
    installBeforeQuitHandler(appObj, wi, isHost);
    const whenReady = typeof appObj.whenReady === 'function' ? appObj.whenReady() : Promise.resolve();
    await whenReady;
    createWindowInternal();
  } catch {
    removeBeforeQuitHandler();
    await disposeRuntimeBounded();
    if (isHost) cleanupHost(wi);
    logStartupFailure('app_ready');
    failClosedGeneric(appObj);
    return { ok: false, reason: 'startup_failed' };
  }

  if (!appObj._hdrHandlersInstalled) {
    appObj._hdrHandlersInstalled = true;
    appObj.on('activate', () => {
      if (mainWindow === null) createWindowInternal();
    });
    appObj.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        try { appObj.quit(); } catch {}
      }
    });
  }

  return { ok: true };
}

function _resetForTest() {
  removeBeforeQuitHandler();
  beforeQuitInFlight = null;
  void disposeRuntimeBounded();
  started = false;
  cleanupDone = false;
  workflowIntegration = null;
  if (mainWindow) {
    try { mainWindow.removeAllListeners('close'); } catch {}
    try { mainWindow.removeAllListeners('closed'); } catch {}
  }
  mainWindow = null;
  conversionService = null;
  try { ipcMain.removeAllListeners(OUTPUT_DRAG_CHANNEL); } catch {}
  // Do not remove other handlers here; bootstrap will handle
}

if (require.main === module) {
  startApp().catch(() => {
    logStartupFailure();
    failClosedGeneric(app);
  });
}

module.exports = {
  startApp,
  _resetForTest,
  getExpectedFileUrl,
  _getConversionServiceForTest: () => conversionService,
  PLUGIN_ID,
  OUTPUT_DRAG_CHANNEL,
  DRAG_ICON_DATAURL,
};
