#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { BUNDLE_FILE_ALLOWLIST, sha256File, auditBundle } = require('./bundle-audit.cjs');
const {
  WORKFLOW_INTEGRATION_PROVENANCE,
  verifyWorkflowIntegrationNode,
} = require('./workflow-integration-provenance.cjs');

const PLUGIN_ID = 'com.hdrtosdr.app';
const PLUGIN_NAME = 'HdrToSdr';
const PLUGIN_VERSION = '0.1.0';
const PLUGIN_DESCRIPTION = 'Verified HDR to Rec.709 SDR conversion';
const PLUGIN_FILEPATH = 'main.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(REPO_ROOT, 'build', 'workflow-integration', PLUGIN_ID);
const OFFICIAL_SDK_NODE = WORKFLOW_INTEGRATION_PROVENANCE.sdkPath;

function fail(msg) {
  console.error(`BUILD FAILED: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`OK: ${msg}`);
}

function ensureFileExists(p, opts = {}) {
  const { executable = false, notSymlink = true, label } = opts;
  const name = label || p;
  let lst;
  try {
    lst = fs.lstatSync(p);
  } catch (e) {
    fail(`${name} missing: ${p} (${e.message})`);
  }
  if (notSymlink && lst.isSymbolicLink()) {
    fail(`${name} must not be symlink: ${p}`);
  }
  if (!lst.isFile()) {
    fail(`${name} must be regular file: ${p}`);
  }
  if (executable) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch {
      fail(`${name} not executable: ${p}`);
    }
  }
}

function ensureDirExists(p, label) {
  const name = label || p;
  let lst;
  try {
    lst = fs.lstatSync(p);
  } catch (e) {
    fail(`${name} directory missing: ${p} (${e.message})`);
  }
  if (lst.isSymbolicLink()) fail(`${name} must not be symlink: ${p}`);
  if (!lst.isDirectory()) fail(`${name} must be directory: ${p}`);
}

function copyAllowlistedFiles(sourceRoot, destinationRoot, relativeFiles) {
  for (const relative of relativeFiles) {
    let component = sourceRoot;
    for (const part of relative.split(path.sep)) {
      component = path.join(component, part);
      let componentStat;
      try { componentStat = fs.lstatSync(component); } catch (e) { fail(`Allowlisted source missing: ${relative} (${e.message})`); }
      if (componentStat.isSymbolicLink()) fail(`Allowlisted source has symlink component: ${relative}`);
    }
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    let stat;
    try { stat = fs.lstatSync(source); } catch (e) { fail(`Allowlisted source missing: ${relative} (${e.message})`); }
    if (stat.isSymbolicLink()) fail(`Allowlisted source must not be symlink: ${relative}`);
    if (!stat.isFile()) fail(`Allowlisted source must be regular file: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    try { fs.chmodSync(destination, relative.endsWith('verify-spike.sh') ? 0o755 : (stat.mode & 0o777)); } catch {}
  }
}

function resolveRequiredTool(src, label) {
  try {
    return fs.realpathSync(src);
  } catch {
    fail(`${label}_missing`);
  }
}

function copyDereferencedFile(src, dest) {
  let realSrc;
  try {
    realSrc = fs.realpathSync(src);
  } catch (e) {
    fail(`Failed to resolve realpath for ${src}: ${e.message}`);
  }
  let lst;
  try {
    lst = fs.lstatSync(realSrc);
  } catch (e) {
    fail(`Real target missing for ${src} -> ${realSrc}: ${e.message}`);
  }
  if (lst.isSymbolicLink()) fail(`Real target must not be symlink after dereference: ${realSrc}`);
  if (!lst.isFile()) fail(`Real target must be file: ${realSrc}`);
  try {
    fs.accessSync(realSrc, fs.constants.X_OK);
  } catch {
    fail(`Real target not executable: ${realSrc}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(realSrc, dest);
  try { fs.chmodSync(dest, 0o755); } catch {}
  let dLst;
  try { dLst = fs.lstatSync(dest); } catch (e) { fail(`Failed lstat dest ${dest}: ${e.message}`); }
  if (dLst.isSymbolicLink()) fail(`Dest must not be symlink: ${dest}`);
  if (!dLst.isFile()) fail(`Dest must be file: ${dest}`);
  try { fs.accessSync(dest, fs.constants.X_OK); } catch { fail(`Dest not executable after copy: ${dest}`); }
  const srcHash = sha256File(realSrc);
  const destHash = sha256File(dest);
  if (srcHash !== destHash) fail(`Hash mismatch copying ${realSrc} -> ${dest}`);
}

function shouldSkipEntry(name) {
  if (name === '__pycache__') return true;
  if (name === '.DS_Store') return true;
  if (name.endsWith('.pyc')) return true;
  if (name.endsWith('.pyo')) return true;
  return false;
}

function copyDirRecursiveSync(src, dest, visited = new Set()) {
  // This helper is retained for local callers, but never follows links. A
  // symlinked directory could otherwise create an unbounded traversal cycle.
  const real = fs.realpathSync(src);
  if (visited.has(real)) fail(`directory cycle while copying ${src}`);
  visited.add(real);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of entries) {
    if (shouldSkipEntry(ent.name)) continue;
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);
    const lst = fs.lstatSync(srcPath);
    if (lst.isSymbolicLink()) fail(`source symlink is not allowed: ${srcPath}`);
    if (lst.isDirectory()) copyDirRecursiveSync(srcPath, destPath, visited);
    else if (lst.isFile()) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      try { fs.chmodSync(destPath, lst.mode & 0o777); } catch {}
    } else fail(`Unsupported file type ${srcPath}`);
  }
  visited.delete(real);
}

function walkNoSymlinkSync(root) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let lst;
    try { lst = fs.lstatSync(cur); } catch (e) { fail(`Failed lstat during walk ${cur}: ${e.message}`); }
    if (lst.isSymbolicLink()) {
      fail(`Output bundle must have no symlink: ${cur} -> ${fs.readlinkSync(cur)}`);
    }
    if (lst.isDirectory()) {
      const entries = fs.readdirSync(cur);
      for (const e of entries) stack.push(path.join(cur, e));
    }
  }
}

function checkNoAbsolutePaths(root, repoRoot) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let lst;
    try { lst = fs.lstatSync(cur); } catch (e) { fail(`Failed lstat during absolute path scan ${cur}: ${e.message}`); }
    if (lst.isDirectory()) {
      for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
    } else if (lst.isFile()) {
      if (cur.includes('WorkflowIntegration.node') || cur.endsWith('/ffmpeg') || cur.endsWith('/ffprobe')) continue;
      // Skip __pycache__ and pyc
      if (cur.includes('__pycache__') || cur.endsWith('.pyc')) continue;
      const ext = path.extname(cur);
      const binaryExts = new Set(['.node', '.png']);
      if (binaryExts.has(ext) && ext !== '.cjs' && ext !== '.js' && ext !== '.json' && ext !== '.xml' && ext !== '.html' && ext !== '.py' && ext !== '.sh') continue;
      try {
        const data = fs.readFileSync(cur, 'utf8');
        // Skip binary files containing null byte
        if (data.includes('\u0000') || data.includes('\0')) continue;
        if (data.includes(repoRoot)) {
          fail(`Built runtime must not contain source repository absolute path ${repoRoot} in ${path.relative(root, cur)}`);
        }
      } catch {}
    }
  }
}

function main() {
  console.log('Building HdrToSdr Workflow Integration bundle...');
  console.log('Repo root configured.');
  console.log('Build root configured.');
  console.log('Official SDK node input configured.');

  ensureFileExists(OFFICIAL_SDK_NODE, { executable: false, notSymlink: true, label: 'Official WorkflowIntegration.node' });
  const sourceProvenance = verifyWorkflowIntegrationNode(OFFICIAL_SDK_NODE);
  if (!sourceProvenance.ok) fail(`Official WorkflowIntegration.node provenance failed: ${sourceProvenance.reason}`);
  let sdkStat;
  try { sdkStat = fs.statSync(OFFICIAL_SDK_NODE); } catch (e) { fail(`Official node stat failed: ${e.message}`); }
  if (sdkStat.size === 0) fail('Official node is empty');
  const officialHash = sourceProvenance.sha256;
  ok(`Official SDK node found and provenance verified (${sdkStat.size} bytes, sha256 ${officialHash.slice(0,12)}...)`);

  ensureDirExists(path.join(REPO_ROOT, 'electron'), 'electron directory');
  ensureFileExists(path.join(REPO_ROOT, 'electron', 'main.cjs'), { label: 'electron/main.cjs' });
  ensureFileExists(path.join(REPO_ROOT, 'electron', 'preload.cjs'), { label: 'electron/preload.cjs' });
  ensureFileExists(path.join(REPO_ROOT, 'electron', 'secure-window.cjs'), { label: 'electron/secure-window.cjs' });
  ensureFileExists(path.join(REPO_ROOT, 'electron', 'bootstrap.cjs'), { label: 'electron/bootstrap.cjs' });
  ensureFileExists(path.join(REPO_ROOT, 'electron', 'conversion-service.cjs'), { label: 'electron/conversion-service.cjs' });
  ensureFileExists(path.join(REPO_ROOT, 'electron', 'output-store.cjs'), { label: 'electron/output-store.cjs' });
  ensureDirExists(path.join(REPO_ROOT, 'prototype'), 'prototype directory');
  ensureFileExists(path.join(REPO_ROOT, 'prototype', 'inspect_cli.py'), { label: 'prototype/inspect_cli.py' });
  ensureFileExists(path.join(REPO_ROOT, 'scripts', 'verify-spike.sh'), { label: 'scripts/verify-spike.sh', executable: true });
  ensureFileExists(path.join(REPO_ROOT, 'workflow-integration', 'manifest.xml'), { label: 'workflow-integration/manifest.xml' });
  const manifestSrc = fs.readFileSync(path.join(REPO_ROOT, 'workflow-integration', 'manifest.xml'), 'utf8');
  const requiredFields = [
    `<Id>${PLUGIN_ID}</Id>`,
    `<Name>${PLUGIN_NAME}</Name>`,
    `<Version>${PLUGIN_VERSION}</Version>`,
    `<Description>${PLUGIN_DESCRIPTION}</Description>`,
    `<FilePath>${PLUGIN_FILEPATH}</FilePath>`,
  ];
  for (const f of requiredFields) {
    if (!manifestSrc.includes(f)) {
      fail(`workflow-integration/manifest.xml missing required field: ${f}`);
    }
  }
  ok('Source manifest has exact required fields');

  const ffmpegLink = path.join(REPO_ROOT, 'tools', 'ffmpeg');
  const ffprobeLink = path.join(REPO_ROOT, 'tools', 'ffprobe');
  const ffmpegReal = resolveRequiredTool(ffmpegLink, 'ffmpeg');
  const ffprobeReal = resolveRequiredTool(ffprobeLink, 'ffprobe');
  ensureFileExists(ffmpegReal, { executable: true, notSymlink: true, label: 'tools/ffmpeg real target' });
  ensureFileExists(ffprobeReal, { executable: true, notSymlink: true, label: 'tools/ffprobe real target' });
  ok('tools/ffmpeg real target resolved and executable');
  ok('tools/ffprobe real target resolved and executable');

  const secureWinSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'secure-window.cjs'), 'utf8');
  const sandboxChecks = [
    'sandbox: true',
    'contextIsolation: true',
    'nodeIntegration: false',
    'webSecurity: true',
  ];
  for (const c of sandboxChecks) {
    if (!secureWinSrc.includes(c)) fail(`secure-window.cjs missing invariant: ${c}`);
  }
  ok('Sandbox invariants preserved in secure-window.cjs');

  const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.cjs'), 'utf8');
  if (!mainSrc.includes('startApp')) fail('electron/main.cjs must export startApp');
  if (!mainSrc.includes('require.main === module')) fail('electron/main.cjs must auto-start only when main module');
  if (!mainSrc.includes('Initialize') || !mainSrc.includes('SetAPITimeout') || !mainSrc.includes('RegisterCallback')) {
    fail('electron/main.cjs must contain lifecycle Initialize/SetAPITimeout/RegisterCallback');
  }
  if (!mainSrc.includes('CleanUp')) fail('electron/main.cjs must handle CleanUp');
  ok('electron/main.cjs lifecycle guards present');

  const preloadSrc = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'preload.cjs'), 'utf8');
  if (!preloadSrc.includes('startOutputDrag')) fail('preload.cjs must expose startOutputDrag');
  if (!preloadSrc.includes('hdrtosdr:output-drag:start')) fail('preload must use exact drag channel hdrtosdr:output-drag:start');
  ok('preload drag channel present');

  if (fs.existsSync(BUILD_ROOT)) {
    fs.rmSync(BUILD_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(BUILD_ROOT, { recursive: true });

  const manifestContent = `<?xml version="1.0" encoding="UTF-8"?>\n<BlackmagicDesign>\n    <Plugin>\n        <Id>${PLUGIN_ID}</Id>\n        <Name>${PLUGIN_NAME}</Name>\n        <Version>${PLUGIN_VERSION}</Version>\n        <Description>${PLUGIN_DESCRIPTION}</Description>\n        <FilePath>${PLUGIN_FILEPATH}</FilePath>\n    </Plugin>\n</BlackmagicDesign>\n`;
  fs.writeFileSync(path.join(BUILD_ROOT, 'manifest.xml'), manifestContent, 'utf8');
  ok('Generated manifest.xml with exact fields');

  const mainShim = `'use strict';\n// HdrToSdr Workflow Integration entry — delegates to electron/main.cjs\nconst path = require('path');\nconst electronMain = require(path.join(__dirname, 'electron', 'main.cjs'));\nlet workflowIntegration = null;\ntry { workflowIntegration = require(path.join(__dirname, 'WorkflowIntegration.node')); } catch {}\nif (electronMain && typeof electronMain.startApp === 'function') {\n  electronMain.startApp({ workflowIntegration }).catch(() => {});\n}\nmodule.exports = electronMain;\n`;
  fs.writeFileSync(path.join(BUILD_ROOT, 'main.js'), mainShim, 'utf8');
  ok('Generated main.js shim');

  const pkg = {
    name: PLUGIN_ID,
    version: PLUGIN_VERSION,
    description: PLUGIN_DESCRIPTION,
    main: PLUGIN_FILEPATH,
    private: true
  };
  fs.writeFileSync(path.join(BUILD_ROOT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  ok('Generated package.json');

  const sourceRuntimeFiles = BUNDLE_FILE_ALLOWLIST.filter((relative) => (
    relative.startsWith('electron/') || relative.startsWith('prototype/') || relative === 'scripts/verify-spike.sh'
  ));
  copyAllowlistedFiles(REPO_ROOT, BUILD_ROOT, sourceRuntimeFiles);
  ok(`Copied ${sourceRuntimeFiles.length} allowlisted runtime files`);

  copyDereferencedFile(ffmpegLink, path.join(BUILD_ROOT, 'tools', 'ffmpeg'));
  copyDereferencedFile(ffprobeLink, path.join(BUILD_ROOT, 'tools', 'ffprobe'));
  ok('Copied tools/ffmpeg and tools/ffprobe dereferenced');

  const destNode = path.join(BUILD_ROOT, 'WorkflowIntegration.node');
  fs.copyFileSync(OFFICIAL_SDK_NODE, destNode);
  ensureFileExists(destNode, { label: 'bundle WorkflowIntegration.node' });
  const destHash = sha256File(destNode);
  if (destHash !== officialHash) fail(`WorkflowIntegration.node hash mismatch: src ${officialHash} vs dest ${destHash}`);
  ok(`Copied WorkflowIntegration.node hash verified (${destHash.slice(0,12)}...)`);

  ensureFileExists(path.join(BUILD_ROOT, 'manifest.xml'), { label: 'bundle manifest.xml' });
  ensureFileExists(path.join(BUILD_ROOT, 'main.js'), { label: 'bundle main.js' });
  ensureFileExists(path.join(BUILD_ROOT, 'package.json'), { label: 'bundle package.json' });
  ensureDirExists(path.join(BUILD_ROOT, 'electron'), 'bundle electron');
  ensureDirExists(path.join(BUILD_ROOT, 'prototype'), 'bundle prototype');
  ensureFileExists(path.join(BUILD_ROOT, 'scripts', 'verify-spike.sh'), { label: 'bundle scripts/verify-spike.sh' });
  ensureFileExists(path.join(BUILD_ROOT, 'tools', 'ffmpeg'), { executable: true, label: 'bundle tools/ffmpeg' });
  ensureFileExists(path.join(BUILD_ROOT, 'tools', 'ffprobe'), { executable: true, label: 'bundle tools/ffprobe' });

  const builtManifest = fs.readFileSync(path.join(BUILD_ROOT, 'manifest.xml'), 'utf8');
  for (const f of requiredFields) {
    if (!builtManifest.includes(f)) fail(`Built manifest missing ${f}`);
  }
  if (!builtManifest.includes('<FilePath>main.js</FilePath>')) fail('Built manifest FilePath must be main.js');
  ok('Verified built manifest exact values');

  const builtMain = fs.readFileSync(path.join(BUILD_ROOT, 'main.js'), 'utf8');
  if (!builtMain.includes('electron/main.cjs')) fail('Built main.js must delegate to electron/main.cjs');
  if (builtMain.includes('require.main')) fail('Built main.js must NOT gate startup with require.main === module; Resolve loads FilePath as module');
  if (!builtMain.includes('WorkflowIntegration.node')) fail('Built main.js must load WorkflowIntegration.node');
  if (builtMain.includes('ClipDock')) fail('Built main.js must never source native module from ClipDock');
  if (builtMain.includes("'electron', 'WorkflowIntegration") || builtMain.includes('"electron", "WorkflowIntegration') || builtMain.includes('electron/WorkflowIntegration')) fail('Built main.js must never source native module from electron subdir; must use root ./WorkflowIntegration.node');
  if (!/require\s*\(\s*path\.join\s*\(\s*__dirname\s*,\s*['"]WorkflowIntegration\.node['"]\s*\)/.test(builtMain)) fail('Built main.js must unconditionally load official local ./WorkflowIntegration.node via path.join(__dirname, \'WorkflowIntegration.node\')');
  const startAppCalls = (builtMain.match(/startApp\s*\(/g) || []).length;
  if (startAppCalls !== 1) fail(`Built main.js must invoke startApp exactly once, found ${startAppCalls}`);
  if (!/startApp\s*\(\s*\{\s*workflowIntegration/.test(builtMain)) fail('Built main.js must invoke electronMain.startApp({ workflowIntegration }) with official root node injected');
  if (!builtMain.includes('.catch')) fail('Built main.js must swallow startup errors at outer entrypoint');
  if (!builtMain.includes('module.exports')) fail('Built main.js must keep module export');
  ok('Verified built entrypoint main.js (no gate, root node injection, exactly-once startApp({ workflowIntegration }))');

  walkNoSymlinkSync(BUILD_ROOT);
  ok('Verified bundle has no symlinks');

  const bundleAudit = auditBundle(BUILD_ROOT);
  if (!bundleAudit.ok) fail(`Bundle allowlist/portability audit failed: ${bundleAudit.reason}`);
  ok(`Bundle allowlist/portability audit passed (${bundleAudit.files.length} regular files)`);

  const ffmpegDest = path.join(BUILD_ROOT, 'tools', 'ffmpeg');
  const ffprobeDest = path.join(BUILD_ROOT, 'tools', 'ffprobe');
  ensureFileExists(ffmpegDest, { executable: true, label: 'bundle tools/ffmpeg executable' });
  ensureFileExists(ffprobeDest, { executable: true, label: 'bundle tools/ffprobe executable' });
  const fl = fs.lstatSync(ffmpegDest);
  if (fl.isSymbolicLink()) fail('bundle tools/ffmpeg must not be symlink');
  const pl = fs.lstatSync(ffprobeDest);
  if (pl.isSymbolicLink()) fail('bundle tools/ffprobe must not be symlink');
  ok('Verified tool binaries executable regular');

  checkNoAbsolutePaths(BUILD_ROOT, REPO_ROOT);
  ok('Verified no source absolute paths in built runtime');

  const systemPluginPath = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.hdrtosdr.app';
  if (fs.existsSync(systemPluginPath)) {
    console.warn(`WARNING: System plugin path already exists (not created by build): ${systemPluginPath}`);
  }
  if (BUILD_ROOT.startsWith('/Library/Application Support')) fail('Build must not be system path');
  ok('Verified no auto-install to system plugins');

  console.log(`\nBUILD SUCCESS: ${BUILD_ROOT}`);
  console.log(`Manifest and native module are official-source-derived and runtime assets are regular, non-symlink files.`);
}

main();
