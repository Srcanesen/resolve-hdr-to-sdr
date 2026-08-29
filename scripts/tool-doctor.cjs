'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  return 'Usage: node scripts/tool-doctor.cjs [--root <repo-root>]';
}

function checkTool(repoRoot, name) {
  const link = path.join(repoRoot, 'tools', name);
  let resolved;
  try {
    resolved = fs.realpathSync(link);
  } catch {
    return { ok: false, message: `${name}: missing repo-local tools/${name}` };
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, message: `${name}: resolved target is not a regular file` };
    }
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    return { ok: false, message: `${name}: resolved target is not executable` };
  }
  return { ok: true, message: `OK: ${name} repo-local executable` };
}

function run(argv = process.argv.slice(2), stdout = console.log, stderr = console.error) {
  let root = path.resolve(__dirname, '..');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      root = path.resolve(argv[++i]);
    } else {
      stderr(usage());
      return 2;
    }
  }
  const results = ['ffmpeg', 'ffprobe'].map((name) => checkTool(root, name));
  for (const result of results) (result.ok ? stdout : stderr)(result.message);
  if (results.every((result) => result.ok)) {
    stdout('Tool doctor passed. No download or PATH fallback was attempted.');
    return 0;
  }
  stderr('Tool doctor failed. Install verified repo-local tools/ffmpeg and tools/ffprobe, then rerun.');
  return 1;
}

if (require.main === module) process.exitCode = run();

module.exports = { checkTool, run };
