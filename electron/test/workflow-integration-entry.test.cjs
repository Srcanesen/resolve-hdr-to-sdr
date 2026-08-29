'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BUILD_ROOT = path.resolve(__dirname, '../../build/workflow-integration/com.hdrtosdr.app');
const BUILT_MAIN = path.join(BUILD_ROOT, 'main.js');
const BUILT_ELECTRON_MAIN = path.join(BUILD_ROOT, 'electron', 'main.cjs');
const BUILT_NODE = path.join(BUILD_ROOT, 'WorkflowIntegration.node');

test('workflow integration built main.js static invariant: no require.main gate, root official node injection, exactly-once start call', () => {
  assert.ok(fs.existsSync(BUILT_MAIN), `built main.js missing: ${BUILT_MAIN} — run npm run bundle:resolve first`);
  const content = fs.readFileSync(BUILT_MAIN, 'utf8');

  // Must delegate to electron/main.cjs
  assert.ok(content.includes('electron/main.cjs'), 'must delegate to electron/main.cjs');

  // Must NOT use require.main to gate startup — Resolve loads as module, not main
  assert.equal(
    content.includes('require.main'),
    false,
    'built main.js must NOT use require.main === module to gate startup; Resolve loads FilePath as module'
  );

  // Must source native module from official root location only
  assert.ok(content.includes('WorkflowIntegration.node'), 'must load WorkflowIntegration.node');
  // Must be from root __dirname/WorkflowIntegration.node, not electron subdir or ClipDock
  const hasRootInjection = content.includes("path.join(__dirname, 'WorkflowIntegration.node')") ||
                           content.includes('path.join(__dirname, "WorkflowIntegration.node")') ||
                           content.includes("path.join(__dirname,'WorkflowIntegration.node')") ||
                           content.includes('__dirname, \'WorkflowIntegration.node\'') ||
                           /require\s*\(\s*path\.join\s*\(\s*__dirname\s*,\s*['"]WorkflowIntegration\.node['"]\s*\)/.test(content);
  assert.ok(hasRootInjection, 'must unconditionally load official local ./WorkflowIntegration.node via path.join(__dirname, \'WorkflowIntegration.node\')');

  assert.equal(content.includes('ClipDock'), false, 'must never source native module from ClipDock');

  // Must NOT use electron subdir for native module — check explicit electron + WorkflowIntegration.node path, not broad cross-file match
  const hasElectronNodePath = content.includes("'electron', 'WorkflowIntegration") ||
                              content.includes('"electron", "WorkflowIntegration') ||
                              content.includes('electron/WorkflowIntegration') ||
                              content.includes('electron\\WorkflowIntegration');
  assert.equal(hasElectronNodePath, false, 'must never source native module from electron subdir');

  // Exactly-once startApp call shape: startApp({ workflowIntegration })
  const startCalls = content.match(/startApp\s*\(/g) || [];
  assert.equal(startCalls.length, 1, `must invoke startApp exactly once, found ${startCalls.length}`);
  assert.ok(/startApp\s*\(\s*\{\s*workflowIntegration/.test(content), 'start call shape must be startApp({ workflowIntegration }) with official root node injected');
  // Must contain workflowIntegration variable reference
  assert.ok(content.includes('workflowIntegration'), 'must pass workflowIntegration injection');

  // Startup errors remain swallowed only at outer plugin entrypoint
  assert.ok(content.includes('.catch'), 'must swallow startup errors at outer entrypoint with .catch');
  assert.ok(content.includes('.catch(() => {})') || content.includes('.catch(()=>{})') || /\.catch\s*\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(content),
    'outer entrypoint must swallow with .catch(() => {})');

  // Keep module export if useful
  assert.ok(content.includes('module.exports'), 'must keep module export');
});

test('workflow integration built main.js loads as Resolve module (not require.main) and invokes startApp exactly once with root WorkflowIntegration.node injected; startup errors swallowed at outer', async () => {
  assert.ok(fs.existsSync(BUILT_MAIN), `built main.js missing: ${BUILT_MAIN}`);
  // Ensure electron and node files exist for require resolution
  assert.ok(fs.existsSync(BUILT_ELECTRON_MAIN), `built electron/main.cjs missing: ${BUILT_ELECTRON_MAIN}`);

  // Save original caches to restore after
  const origMainCache = require.cache[BUILT_MAIN];
  const origElectronCache = require.cache[BUILT_ELECTRON_MAIN];
  const origNodeCache = require.cache[BUILT_NODE];

  // Helper to clean
  function clean() {
    delete require.cache[BUILT_MAIN];
    delete require.cache[BUILT_ELECTRON_MAIN];
    delete require.cache[BUILT_NODE];
  }

  clean();

  let startCallCount = 0;
  let startArg = null;
  const fakeWorkflowIntegration = { Initialize: () => true, __isFakeRootNode: true };
  const mockElectronMain = {
    startApp: (opts) => {
      startCallCount++;
      startArg = opts;
      return Promise.resolve({ ok: true });
    }
  };

  // Install mocks for the files the shim will require
  require.cache[BUILT_ELECTRON_MAIN] = {
    id: BUILT_ELECTRON_MAIN,
    filename: BUILT_ELECTRON_MAIN,
    loaded: true,
    exports: mockElectronMain,
  };
  require.cache[BUILT_NODE] = {
    id: BUILT_NODE,
    filename: BUILT_NODE,
    loaded: true,
    exports: fakeWorkflowIntegration,
  };

  // Verify test is not the main module for built file
  const isBuiltMain = require.main && require.main.filename === BUILT_MAIN;
  assert.equal(isBuiltMain, false, 'built main.js must be loaded as module, not as require.main');

  // Load shim as Resolve would (require, not main)
  let loadError = null;
  try {
    require(BUILT_MAIN);
  } catch (e) {
    loadError = e;
  }
  assert.equal(loadError, null, `requiring built main.js should not throw, got ${loadError && loadError.message}`);

  // Wait for async startApp().catch
  await new Promise(r => setTimeout(r, 20));

  assert.equal(startCallCount, 1, 'loading built main.js as Resolve module must invoke electron/main.cjs startApp exactly once');
  assert.ok(startArg && startArg.workflowIntegration === fakeWorkflowIntegration,
    'must inject official root WorkflowIntegration.node via startApp({ workflowIntegration })');

  // Now verify startup errors are swallowed only at outer entrypoint
  clean();
  let rejectCallCount = 0;
  const mockReject = {
    startApp: () => {
      rejectCallCount++;
      return Promise.reject(new Error('startup boom'));
    }
  };
  require.cache[BUILT_ELECTRON_MAIN] = {
    id: BUILT_ELECTRON_MAIN,
    filename: BUILT_ELECTRON_MAIN,
    loaded: true,
    exports: mockReject,
  };
  require.cache[BUILT_NODE] = {
    id: BUILT_NODE,
    filename: BUILT_NODE,
    loaded: true,
    exports: fakeWorkflowIntegration,
  };

  let unhandled = false;
  function onUnhandled() { unhandled = true; }
  process.once('unhandledRejection', onUnhandled);

  try {
    require(BUILT_MAIN);
  } catch (e) {
    assert.fail(`should not throw even when startApp rejects, got ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 30));
  process.removeListener('unhandledRejection', onUnhandled);

  assert.equal(rejectCallCount, 1, 'startApp must still be called exactly once even when it rejects');
  assert.equal(unhandled, false, 'startup rejection must be swallowed at outer plugin entrypoint (no unhandledRejection)');

  // Cleanup restore
  clean();
  if (origMainCache) require.cache[BUILT_MAIN] = origMainCache;
  if (origElectronCache) require.cache[BUILT_ELECTRON_MAIN] = origElectronCache;
  else delete require.cache[BUILT_ELECTRON_MAIN];
  if (origNodeCache) require.cache[BUILT_NODE] = origNodeCache;
  else delete require.cache[BUILT_NODE];
});
