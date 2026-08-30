const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

function createMockApp() {
  const handlers = {};
  const app = {
    _handlers: handlers,
    whenReady: () => Promise.resolve(),
    on: (evt, fn) => {
      if (!handlers[evt]) handlers[evt] = [];
      handlers[evt].push(fn);
    },
    removeListener: (evt, fn) => {
      if (!handlers[evt]) return;
      handlers[evt] = handlers[evt].filter((candidate) => candidate !== fn);
    },
    removeAllListeners: (evt) => {
      if (evt) delete handlers[evt];
      else for (const k in handlers) delete handlers[k];
    },
    quit: () => { app._quitCalled = (app._quitCalled || 0) + 1; },
    exit: () => { app._exitCalled = true; },
    _quitCalled: 0,
    _exitCalled: false,
    _hdrHandlersInstalled: false,
  };
  app.emit = (evt, ...args) => {
    const fns = handlers[evt] || [];
    for (const f of fns) f(...args);
  };
  return app;
}

function createMockElectron(appMock) {
  return {
    app: appMock,
    ipcMain: {
      _handlers: {},
      on: function(ch, fn) { this._handlers[ch] = fn; this._lastOn = ch; },
      removeAllListeners: function(ch) { if (ch) delete this._handlers[ch]; else this._handlers = {}; },
      handle: function() {},
      removeHandler: function() {},
    },
    BrowserWindow: class {},
    nativeImage: {
      createFromDataURL: (url) => ({
        isEmpty: () => false,
        getSize: () => ({ width: 32, height: 32 }),
        _url: url,
      }),
    },
    dialog: { showErrorBox: () => {} },
  };
}

test('lifecycle ordered Initialize -> SetAPITimeout(10) -> RegisterCallback and once CleanUp', async () => {
  const electronPath = require.resolve('electron');
  const origCache = require.cache[electronPath];
  const securePath = require.resolve('../secure-window.cjs');
  const origSecure = require.cache[securePath];
  const mainPath = require.resolve('../main.cjs');
  delete require.cache[mainPath];

  const appMock = createMockApp();
  const mockElectron = createMockElectron(appMock);
  // Mock secure-window to avoid real BrowserWindow
  const mockWindow = {
    webContents: {
      id: 1,
      send: () => {},
      mainFrame: { url: '' },
      on: () => {},
      session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
      setWindowOpenHandler: () => {},
    },
    on: (evt, fn) => {
      mockWindow._on = mockWindow._on || {};
      mockWindow._on[evt] = fn;
    },
    removeAllListeners: () => {},
    loadFile: async () => {},
  };
  // set expected url
  const expectedUrl = 'file://' + path.resolve(__dirname, '..', 'renderer', 'index.html');
  mockWindow.webContents.mainFrame.url = expectedUrl;

  require.cache[securePath] = {
    id: securePath,
    filename: securePath,
    loaded: true,
    exports: {
      createSecureWindow: () => mockWindow,
      installSecureHandlers: () => {},
    },
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: mockElectron,
  };
  // Need to also mock bootstrap to avoid real ipc handlers? but we can let it run with mocked ipcMain
  delete require.cache[require.resolve('../bootstrap.cjs')];
  delete require.cache[require.resolve('../conversion-service.cjs')];
  delete require.cache[require.resolve('../output-store.cjs')];
  // Ensure fresh main
  delete require.cache[mainPath];
  const main = require('../main.cjs');
  // Reset guard
  if (typeof main._resetForTest === 'function') main._resetForTest();

  const callOrder = [];
  const wi = {
    Initialize: (id) => { callOrder.push(`Initialize:${id}`); return true; },
    SetAPITimeout: (v) => { callOrder.push(`SetAPITimeout:${v}`); return true; },
    RegisterCallback: (name, fn) => { callOrder.push(`RegisterCallback:${name}`); assert.equal(name, 'ResolveQuit'); assert.equal(typeof fn, 'function'); wi._quitCb = fn; return true; },
    CleanUp: () => { callOrder.push('CleanUp'); wi._cleanupCount = (wi._cleanupCount || 0) + 1; return true; },
  };

  const res = await main.startApp({ app: appMock, workflowIntegration: wi });
  assert.equal(res.ok, true);
  const activeService = main._getConversionServiceForTest();
  assert.ok(activeService && typeof activeService.trackProcess === 'function');
  const child = { killed: [], kill(signal) {
    this.killed.push(signal);
    if (signal === 'SIGTERM') this.exitCode = 0;
  } };
  activeService.trackProcess(child);
  assert.deepEqual(callOrder.slice(0,3), [
    'Initialize:com.hdrtosdr.app',
    'SetAPITimeout:10',
    'RegisterCallback:ResolveQuit',
  ]);
  // Ensure SetAPITimeout value is exactly 10
  assert.ok(callOrder.includes('SetAPITimeout:10'));
  // Ensure exactly-once CleanUp during before-quit
  assert.equal(wi._cleanupCount, undefined);
  // Simulate before-quit twice
  const beforeQuitHandlers = appMock._handlers['before-quit'] || [];
  assert.ok(beforeQuitHandlers.length >= 1, 'before-quit handler registered');
  // Emit before-quit twice while the first bounded cleanup is in flight.
  let prevented = 0;
  const quitEvent = { preventDefault: () => { prevented++; } };
  appMock.emit('before-quit', quitEvent);
  appMock.emit('before-quit', quitEvent);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(prevented, 1, 'before-quit must prevent default exactly once');
  assert.deepEqual(child.killed, ['SIGTERM'], 'app quit must terminate tracked child processes');
  assert.equal(wi._cleanupCount, 1, 'CleanUp must be called exactly once even if before-quit emitted twice');
  assert.equal((appMock._handlers['before-quit'] || []).length, 0, 'owned before-quit handler is removed before quit resumes');

  // Plugin window close quits app
  assert.ok(mockWindow._on && mockWindow._on['close'], 'window close handler should be registered');
  const prevQuit = appMock._quitCalled;
  mockWindow._on['close']();
  assert.equal(appMock._quitCalled, prevQuit + 1, 'window close should quit app');

  // No Resolve API beyond lifecycle: ensure GetResolve never called
  assert.equal(wi.GetResolve, undefined);
  // Ensure no extra calls like GetResolve, OpenPage etc.
  for (const c of callOrder) {
    assert.equal(c.includes('GetResolve'), false, 'should not call GetResolve');
  }

  // Cleanup
  if (typeof main._resetForTest === 'function') main._resetForTest();
  if (origCache) require.cache[electronPath] = origCache; else delete require.cache[electronPath];
  if (origSecure) require.cache[securePath] = origSecure; else delete require.cache[securePath];
  delete require.cache[mainPath];
  delete require.cache[require.resolve('../bootstrap.cjs')];
});

test('lifecycle fail closed with generic startup failure', async () => {
  const electronPath = require.resolve('electron');
  const origCache = require.cache[electronPath];
  const securePath = require.resolve('../secure-window.cjs');
  const origSecure = require.cache[securePath];
  const mainPath = require.resolve('../main.cjs');
  delete require.cache[mainPath];

  const appMock = createMockApp();
  const mockElectron = createMockElectron(appMock);
  const mockWindow = {
    webContents: {
      id: 1, send: () => {}, mainFrame: { url: 'file://' + path.resolve(__dirname, '..', 'renderer', 'index.html') },
      on: () => {}, session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }, setWindowOpenHandler: () => {},
    },
    on: () => {}, removeAllListeners: () => {}, loadFile: async () => {},
  };
  require.cache[securePath] = {
    id: securePath, filename: securePath, loaded: true,
    exports: { createSecureWindow: () => mockWindow, installSecureHandlers: () => {} },
  };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mockElectron };

  delete require.cache[require.resolve('../bootstrap.cjs')];
  delete require.cache[mainPath];
  const main = require('../main.cjs');
  if (typeof main._resetForTest === 'function') main._resetForTest();

  const wiFailInit = {
    Initialize: () => false,
    SetAPITimeout: () => true,
    RegisterCallback: () => true,
    CleanUp: () => {},
  };
  const res1 = await main.startApp({ app: appMock, workflowIntegration: wiFailInit });
  assert.equal(res1.ok, false);
  assert.equal(res1.reason, 'startup_failed');
  // Should have called quit (fail closed)
  assert.ok(appMock._quitCalled >= 1, 'should quit on Initialize failure');

  // Reset for second scenario: SetAPITimeout failure
  if (typeof main._resetForTest === 'function') main._resetForTest();
  const appMock2 = createMockApp();
  const mockElectron2 = createMockElectron(appMock2);
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mockElectron2 };
  require.cache[securePath] = {
    id: securePath, filename: securePath, loaded: true,
    exports: { createSecureWindow: () => mockWindow, installSecureHandlers: () => {} },
  };
  delete require.cache[mainPath];
  const main2 = require('../main.cjs');
  if (typeof main2._resetForTest === 'function') main2._resetForTest();
  const wiFailTimeout = {
    Initialize: () => true,
    SetAPITimeout: () => false,
    RegisterCallback: () => true,
    CleanUp: () => {},
  };
  const res2 = await main2.startApp({ app: appMock2, workflowIntegration: wiFailTimeout });
  assert.equal(res2.ok, false);
  assert.ok(appMock2._quitCalled >= 1);

  // Third: RegisterCallback failure
  if (typeof main2._resetForTest === 'function') main2._resetForTest();
  const appMock3 = createMockApp();
  const mockElectron3 = createMockElectron(appMock3);
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mockElectron3 };
  require.cache[securePath] = {
    id: securePath, filename: securePath, loaded: true,
    exports: { createSecureWindow: () => mockWindow, installSecureHandlers: () => {} },
  };
  delete require.cache[mainPath];
  const main3 = require('../main.cjs');
  if (typeof main3._resetForTest === 'function') main3._resetForTest();
  const wiFailCb = {
    Initialize: () => true,
    SetAPITimeout: () => true,
    RegisterCallback: () => false,
    CleanUp: () => {},
  };
  const res3 = await main3.startApp({ app: appMock3, workflowIntegration: wiFailCb });
  assert.equal(res3.ok, false);
  assert.ok(appMock3._quitCalled >= 1);

  // Ensure generic failure: no path or raw error exposed in reason (only startup_failed)
  assert.equal(res1.reason, 'startup_failed');
  assert.equal(res2.reason, 'startup_failed');
  assert.equal(res3.reason, 'startup_failed');

  if (typeof main3._resetForTest === 'function') main3._resetForTest();
  if (origCache) require.cache[electronPath] = origCache; else delete require.cache[electronPath];
  if (origSecure) require.cache[securePath] = origSecure; else delete require.cache[securePath];
  delete require.cache[mainPath];
});

test('startApp guarded and standalone only when main module', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.ok(mainSrc.includes('started'), 'should have guarded started flag');
  assert.ok(mainSrc.includes('already_started'), 'should return already_started on second call');
  assert.ok(mainSrc.includes('require.main === module'), 'must auto-start only when main module');
  // Ensure exports startApp
  assert.ok(mainSrc.includes('module.exports') && mainSrc.includes('startApp'));
});

test('window close quits app exactly and reuse one window', async () => {
  const electronPath = require.resolve('electron');
  const origCache = require.cache[electronPath];
  const securePath = require.resolve('../secure-window.cjs');
  const origSecure = require.cache[securePath];
  const mainPath = require.resolve('../main.cjs');
  delete require.cache[mainPath];

  const appMock = createMockApp();
  const mockElectron = createMockElectron(appMock);
  let createCount = 0;
  const mockWindow = {
    webContents: {
      id: 1, send: () => {}, mainFrame: { url: 'file://' + path.resolve(__dirname, '..', 'renderer', 'index.html') },
      on: () => {}, session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }, setWindowOpenHandler: () => {},
    },
    on: (evt, fn) => { mockWindow._on = mockWindow._on || {}; mockWindow._on[evt] = fn; },
    removeAllListeners: () => {}, loadFile: async () => {},
  };
  require.cache[securePath] = {
    id: securePath, filename: securePath, loaded: true,
    exports: {
      createSecureWindow: () => { createCount++; return mockWindow; },
      installSecureHandlers: () => {},
    },
  };
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: mockElectron };
  delete require.cache[mainPath];
  const main = require('../main.cjs');
  if (typeof main._resetForTest === 'function') main._resetForTest();

  const wi = {
    Initialize: () => true,
    SetAPITimeout: () => true,
    RegisterCallback: () => true,
    CleanUp: () => {},
  };
  const res1 = await main.startApp({ app: appMock, workflowIntegration: wi });
  assert.equal(res1.ok, true);
  assert.equal(createCount, 1);
  const res2 = await main.startApp({ app: appMock, workflowIntegration: wi });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'already_started');
  assert.equal(createCount, 1, 'should reuse one BrowserWindow, not create second');

  if (typeof main._resetForTest === 'function') main._resetForTest();
  if (origCache) require.cache[electronPath] = origCache; else delete require.cache[electronPath];
  if (origSecure) require.cache[securePath] = origSecure; else delete require.cache[securePath];
  delete require.cache[mainPath];
});
