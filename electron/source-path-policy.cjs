const path = require('path');
const fs = require('fs');

// These are the platform aliases used by macOS for ordinary temporary/system
// locations. All other source symlink components are rejected.
const ALLOWED_SYSTEM_SYMLINKS = new Map([
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
  ['/etc', '/private/etc'],
]);

function isAllowedSystemAlias(component, resolved, pathModule = path) {
  const expected = ALLOWED_SYSTEM_SYMLINKS.get(component);
  return expected !== undefined && pathModule.resolve(resolved) === pathModule.resolve(expected);
}

function normalizeCanonicalPath(value, pathModule = path) {
  let normalized = pathModule.resolve(value);
  if (process.platform === 'darwin') {
    for (const [alias, target] of ALLOWED_SYSTEM_SYMLINKS) {
      if (normalized === alias) normalized = target;
      else if (normalized.startsWith(`${alias}${pathModule.sep}`)) {
        normalized = `${target}${normalized.slice(alias.length)}`;
      }
    }
    // APFS is normally case-insensitive; realpath supplies the authoritative
    // spelling, while this also handles a legacy token made before realpath.
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function canonicalPathsEqual(first, second, pathModule = path) {
  return normalizeCanonicalPath(first, pathModule) === normalizeCanonicalPath(second, pathModule);
}

function canonicalizeSafeSourcePath(inputPath, fsModule = fs, pathModule = path) {
  if (typeof inputPath !== 'string' || !pathModule.isAbsolute(inputPath)) {
    return { ok: false, reason: 'invalid_source' };
  }
  const absolute = pathModule.resolve(inputPath);
  const inputExt = pathModule.extname(absolute).toLowerCase();
  if (inputExt !== '.mov' && inputExt !== '.mp4') {
    return { ok: false, reason: 'invalid_source' };
  }

  let finalStat;
  try {
    finalStat = fsModule.lstatSync(absolute);
  } catch {
    return { ok: false, reason: 'invalid_source' };
  }
  if (finalStat.isSymbolicLink() || !finalStat.isFile()) {
    return { ok: false, reason: 'invalid_source' };
  }

  // Inspect the spelling supplied by the caller, not only the resolved path,
  // so a symlinked parent cannot be hidden by realpath().
  const root = pathModule.parse(absolute).root;
  let component = root;
  const parts = absolute.slice(root.length).split(pathModule.sep).filter(Boolean);
  for (const part of parts) {
    component = pathModule.join(component, part);
    let item;
    try {
      item = fsModule.lstatSync(component);
    } catch {
      return { ok: false, reason: 'invalid_source' };
    }
    if (!item.isSymbolicLink()) continue;
    let resolvedComponent;
    try {
      resolvedComponent = fsModule.realpathSync(component);
    } catch {
      return { ok: false, reason: 'invalid_source' };
    }
    if (!isAllowedSystemAlias(component, resolvedComponent, pathModule)) {
      return { ok: false, reason: 'invalid_source' };
    }
  }

  let canonical;
  try {
    canonical = fsModule.realpathSync(absolute);
    // Recheck the submitted final component after resolution to close the
    // simple replace-with-symlink race between the initial lstat and realpath.
    const finalAgain = fsModule.lstatSync(absolute);
    if (finalAgain.isSymbolicLink() || !finalAgain.isFile()) return { ok: false, reason: 'invalid_source' };
    const canonicalStat = fsModule.statSync(canonical);
    if (!canonicalStat.isFile()) return { ok: false, reason: 'invalid_source' };
  } catch {
    return { ok: false, reason: 'invalid_source' };
  }
  const canonicalExt = pathModule.extname(canonical).toLowerCase();
  if (canonicalExt !== '.mov' && canonicalExt !== '.mp4') {
    return { ok: false, reason: 'invalid_source' };
  }
  return { ok: true, canonical };
}

module.exports = {
  ALLOWED_SYSTEM_SYMLINKS,
  canonicalPathsEqual,
  canonicalizeSafeSourcePath,
};
