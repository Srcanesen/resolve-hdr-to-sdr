const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
let bProfile = null;
try { bProfile = require('./b-profile.cjs'); } catch {}
const PROFILE_ID_LOCAL_B_FALLBACK = 'hlg-local-b-v1';
const PROFILE_ID_GENERIC_FALLBACK = 'hlg-rec709-v1';
const PROFILE_ID_PQ_FALLBACK = 'pq-rec709-v1';
function isKnownProfile(p) {
  if (bProfile && typeof bProfile.isKnownProfileId === 'function') return bProfile.isKnownProfileId(p);
  return p === PROFILE_ID_LOCAL_B_FALLBACK || p === PROFILE_ID_GENERIC_FALLBACK || p === PROFILE_ID_PQ_FALLBACK;
}

function getOutputRoot() {
  return path.join(os.homedir(), 'Movies', 'HdrToSdr');
}

function ensureOutputRoot() {
  const root = getOutputRoot();
  const home = os.homedir();
  // Only harden components under homedir (Movies, HdrToSdr), not system prefixes like /tmp -> /private/tmp
  const moviesDir = path.join(home, 'Movies');
  const dirsToEnsure = [moviesDir, root];
  for (const dir of dirsToEnsure) {
    try {
      const lst = fs.lstatSync(dir);
      if (lst.isSymbolicLink()) throw new Error('symlink component');
      if (!lst.isDirectory()) throw new Error('not directory');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        fs.mkdirSync(dir, { mode: 0o755 });
        const lst2 = fs.lstatSync(dir);
        if (lst2.isSymbolicLink() || !lst2.isDirectory()) throw new Error('invalid dir after creation');
      } else {
        throw e;
      }
    }
  }
  const canonical = fs.realpathSync(root);
  const expected = path.resolve(root);
  if (canonical !== expected) {
    const realHome = (() => { try { return fs.realpathSync(home); } catch { return path.resolve(home); } })();
    const suffix = path.join('Movies', 'HdrToSdr');
    const expectedCanonical = path.join(realHome, suffix);
    if (canonical !== expectedCanonical && canonical !== expected) {
      throw new Error('output root symlink escape');
    }
  }
  return canonical;
}
function isPathUnderRoot(canonicalRoot, candidate) {
  let realRoot;
  try { realRoot = fs.realpathSync(canonicalRoot); } catch { realRoot = path.resolve(canonicalRoot); }
  // Candidate may not exist yet, so resolve its parent realpath
  let realCand;
  try {
    realCand = fs.realpathSync(candidate);
  } catch {
    const dir = path.dirname(candidate);
    let realDir;
    try { realDir = fs.realpathSync(dir); } catch { realDir = path.resolve(dir); }
    realCand = path.join(realDir, path.basename(candidate));
    // If candidate is a directory path (e.g., dir check), handle that case
    if (candidate.endsWith(path.sep) || fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory()) {
      try { realCand = fs.realpathSync(candidate); } catch {}
    }
  }
  if (realCand === realRoot) return true;
  return realCand.startsWith(realRoot + path.sep);
}

function sanitizeBasename(name) {
  // Take basename without extension, keep alphanumeric, dot, hyphen, underscore
  const base = path.basename(name);
  const withoutExt = base.replace(/\.[^.]+$/, '');
  // replace disallowed chars with underscore, trim
  let s = withoutExt.replace(/[^A-Za-z0-9._-]/g, '_');
  s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'output';
  // limit length to 80
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

function buildDisplayName(sourceBasename, profileId) {
  const sanitized = sanitizeBasename(sourceBasename);
  const effective = profileId || PROFILE_ID_LOCAL_B_FALLBACK;
  if (!isKnownProfile(effective)) {
    throw new Error('unknown_profile');
  }
  return `${sanitized}_sdr_rec709_h264_${effective}.mp4`;
}

function allocateUniqueFinalPath(outputRoot, displayName) {
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(outputRoot); } catch { canonicalRoot = path.resolve(outputRoot); }
  const candidate = path.join(outputRoot, path.basename(displayName));
  if (!isPathUnderRoot(canonicalRoot, candidate)) throw new Error('path escape');
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  const ext = path.extname(displayName);
  const baseWithoutExt = displayName.slice(0, -ext.length);
  const MAX_ATTEMPTS = 1000;
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const suffix = `_${String(i).padStart(3, '0')}`;
    const p = path.join(outputRoot, `${baseWithoutExt}${suffix}${ext}`);
    if (!isPathUnderRoot(canonicalRoot, p)) throw new Error('path escape');
    if (!fs.existsSync(p)) {
      return p;
    }
  }
  for (let r = 0; r < 10; r++) {
    const rand = crypto.randomBytes(3).toString('hex');
    const p = path.join(outputRoot, `${baseWithoutExt}_${rand}${ext}`);
    if (!isPathUnderRoot(canonicalRoot, p)) continue;
    if (!fs.existsSync(p)) return p;
  }
  const rand = crypto.randomBytes(3).toString('hex');
  const fallback = path.join(outputRoot, `${baseWithoutExt}_${rand}${ext}`);
  if (!isPathUnderRoot(canonicalRoot, fallback)) throw new Error('path escape');
  return fallback;
}

function getStagingPath(outputRoot, finalPath) {
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(outputRoot); } catch { canonicalRoot = path.resolve(outputRoot); }
  const dir = path.dirname(path.resolve(finalPath));
  if (!isPathUnderRoot(canonicalRoot, dir) && path.resolve(dir) !== path.resolve(canonicalRoot)) {
    // Also allow dir that is realpath-equivalent
    const dirReal = (() => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } })();
    if (dirReal !== canonicalRoot && !dirReal.startsWith(canonicalRoot + path.sep)) {
      throw new Error('staging outside output root');
    }
  }
  const MAX_STAGING_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt++) {
    const rand = crypto.randomBytes(6).toString('hex');
    const name = `.${rand}.partial.mp4`;
    const staging = path.join(dir, name);
    if (!isPathUnderRoot(canonicalRoot, staging)) continue;
    if (!fs.existsSync(staging)) {
      return staging;
    }
  }
  const rand = crypto.randomBytes(6).toString('hex');
  const fallback = path.join(dir, `.${rand}.partial.mp4`);
  if (!isPathUnderRoot(canonicalRoot, fallback)) throw new Error('staging escape');
  if (fs.existsSync(fallback)) throw new Error('staging collision');
  return fallback;
}

function removeStaging(stagingPath) {
  try {
    if (stagingPath && fs.existsSync(stagingPath)) {
      fs.unlinkSync(stagingPath);
    }
  } catch {}
}

// Non-creating helper usable by drag revalidation: validates strict containment, no symlink components, TOCTOU-safe checks.
function isSafeOutputFile(canonicalPath, canonicalRoot) {
  try {
    if (!canonicalPath || !canonicalRoot) return false;
    if (typeof canonicalPath !== 'string' || typeof canonicalRoot !== 'string') return false;
    if (!path.isAbsolute(canonicalPath) || !path.isAbsolute(canonicalRoot)) return false;
    // Validate canonicalRoot still exists, is directory, not symlink, and realpath equals resolved canonical
    const rootLst = fs.lstatSync(canonicalRoot);
    if (rootLst.isSymbolicLink()) return false;
    if (!rootLst.isDirectory()) return false;
    let rootReal;
    try { rootReal = fs.realpathSync(canonicalRoot); } catch { return false; }
    const rootResolved = path.resolve(canonicalRoot);
    if (rootReal !== rootResolved) {
      // Allow macOS alias for homedir: realHome may differ, but stored canonicalRoot was previously canonicalized via ensureOutputRoot
      // For strict drag validation, require exact equality; alias case should have been canonicalized at storage time.
      return false;
    }
    // Validate file lstat regular non-symlink
    const lst = fs.lstatSync(canonicalPath);
    if (lst.isSymbolicLink()) return false;
    if (!lst.isFile()) return false;
    let real;
    try { real = fs.realpathSync(canonicalPath); } catch { return false; }
    if (real !== path.resolve(canonicalPath)) return false;
    if (real !== canonicalPath) return false;
    // Direct containment: relative from root to real must be inside, non-empty, not escaping
    const rel = path.relative(canonicalRoot, real);
    if (!rel || rel === '' || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return false;
    // Ensure immediate parent is canonicalRoot (direct containment) or at least inside root
    const dir = path.dirname(real);
    let dirReal;
    try { dirReal = fs.realpathSync(dir); } catch { return false; }
    // Direct containment enforcement: dirReal must equal canonicalRoot
    // Also allow file directly under root: check parent lstat not symlink
    try {
      const dirLst = fs.lstatSync(dir);
      if (dirLst.isSymbolicLink()) return false;
    } catch { return false; }
    if (dirReal !== canonicalRoot) {
      // If nested deeper than direct, still allow if dirReal is inside canonicalRoot and no symlink component
      if (dirReal !== canonicalRoot && !dirReal.startsWith(canonicalRoot + path.sep)) return false;
      // Walk components from dir up to root to ensure no symlink component
      let cur = dir;
      const rootRes = path.resolve(canonicalRoot);
      let depth = 0;
      const MAX_DEPTH = 256;
      while (cur && cur !== rootRes && depth < MAX_DEPTH) {
        try {
          const st = fs.lstatSync(cur);
          if (st.isSymbolicLink()) return false;
          const curReal = fs.realpathSync(cur);
          if (curReal !== path.resolve(cur)) return false;
        } catch { return false; }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
        depth++;
        if (cur.length < rootRes.length) break;
      }
      if (depth >= MAX_DEPTH) return false;
      // Still require that immediate containment holds via relative check already
    }
    return true;
  } catch {
    return false;
  }
}

function getCanonicalOutputRootNoCreate() {
  const root = getOutputRoot();
  const resolved = path.resolve(root);
  try {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink()) throw new Error('symlink component');
    if (!lst.isDirectory()) throw new Error('not directory');
    const real = fs.realpathSync(resolved);
    if (real !== resolved) {
      const home = os.homedir();
      let realHome;
      try { realHome = fs.realpathSync(home); } catch { realHome = path.resolve(home); }
      const suffix = path.join('Movies', 'HdrToSdr');
      const expectedCanonical = path.join(realHome, suffix);
      if (real !== expectedCanonical) throw new Error('output root symlink escape');
      return real;
    }
    return real;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Not yet created: return resolved path but validation for drag should fail closed if root missing
      // For non-creating helper, we return resolved but caller must handle missing dir as failure in isSafeOutputFile
      // To indicate missing, throw
      throw new Error('output root missing');
    }
    throw e;
  }
}

module.exports = {
  getOutputRoot,
  ensureOutputRoot,
  sanitizeBasename,
  buildDisplayName,
  allocateUniqueFinalPath,
  getStagingPath,
  removeStaging,
  isSafeOutputFile,
  getCanonicalOutputRootNoCreate,
  isPathUnderRoot,
};
