const path = require('path');
const { BrowserWindow } = require('electron');

const WIDTH = 600;
const HEIGHT = 720;

function denyPermissionRequest(webContents, permission, callback) {
  callback(false);
}

function denyPermissionCheck() {
  return false;
}

function handleWillAttachWebview(event) {
  event.preventDefault();
}

function handleWillNavigate(event) {
  event.preventDefault();
}

function handleWillRedirect(event) {
  event.preventDefault();
}

function handleWindowOpen() {
  return { action: 'deny' };
}

function installSecureHandlers(win) {
  // Deny navigation
  win.webContents.on('will-navigate', handleWillNavigate);

  // Deny redirects
  win.webContents.on('will-redirect', handleWillRedirect);

  // Deny new windows
  win.webContents.setWindowOpenHandler(handleWindowOpen);

  // Deny will-attach-webview explicitly
  win.webContents.on('will-attach-webview', handleWillAttachWebview);

  const ses = win.webContents.session;
  if (ses) {
    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler(denyPermissionRequest);
    }
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(denyPermissionCheck);
    }
  }
}

function createSecureWindow() {
  const preloadPath = path.resolve(__dirname, 'preload.cjs');

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: 560,
    maxWidth: 640,
    minHeight: 600,
    show: true,
    backgroundColor: '#1c1c1e',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: preloadPath,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  installSecureHandlers(win);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  return win;
}

module.exports = {
  createSecureWindow,
  installSecureHandlers,
  handleWillNavigate,
  handleWillRedirect,
  handleWillAttachWebview,
  handleWindowOpen,
  denyPermissionRequest,
  denyPermissionCheck,
  WIDTH,
  HEIGHT,
};
