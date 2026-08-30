'use strict';

/*
 * Fail-closed probes for the non-release portable-toolchain attempt. This
 * script only reads candidate files and invokes macOS tools with shell:false.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MANIFEST = path.join(__dirname, 'portable-toolchain-manifest.json');
const MOVING_URL_RE = /\/(?:latest|master|main|head)(?:[/?#]|$)|[?&]ref=/i;
const REQUIRED_ARCHES = ['x86_64', 'arm64'];
const ALLOWED_DYLIB_PREFIXES = ['/usr/lib/', '/System/Library/', '@rpath/', '@loader_path/', '@executable_path/'];

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest' || arg === '--tools' || arg === '--downloads' || arg === '--report' || arg === '--media' || arg === '--bundle') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = path.resolve(value);
    } else if (arg === '--manifest-only') {
      options.manifestOnly = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const HASH_CHUNK_BYTES = 1024 * 1024;

function sha256(filePath) {
  // Bounded streaming hash: never loads the whole binary into memory.
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return hash.digest('hex');
}

function validateTarMembers(archivePath) {
  const result = spawnSync('python3', ['-', String(archivePath)], {
    input: [
      'import sys, tarfile',
      'from pathlib import PurePosixPath',
      'archive = sys.argv[1]',
      'try:',
      '    tf = tarfile.open(archive, "r:*")',
      'except Exception as exc:',
      '    print(f"tar open failed: {exc}", file=sys.stderr)',
      '    sys.exit(1)',
      'allowed_types = (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE)',
      'for m in tf.getmembers():',
      '    name = m.name',
      '    linkname = m.linkname or ""',
      '    if m.type not in allowed_types:',
      '        print(f"archive unsupported type {m.type!r}: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if chr(92) in name or chr(92) in linkname:',
      '        print(f"archive member backslash: {name!r} -> {linkname!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if name.startswith("/") or linkname.startswith("/"):',
      '        print(f"archive absolute: {name!r} -> {linkname!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if PurePosixPath(name).is_absolute() or (linkname and PurePosixPath(linkname).is_absolute()):',
      '        print(f"archive absolute posix: {name!r} -> {linkname!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if ".." in name.split("/"):',
      '        print(f"archive traversal: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if linkname and ".." in linkname.split("/"):',
      '        print(f"archive link traversal: {name!r} -> {linkname!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if m.issym() or m.islnk() or m.type in (tarfile.SYMTYPE, tarfile.LNKTYPE):',
      '        if chr(92) in linkname:',
      '            print(f"archive linkname backslash: {name!r} -> {linkname!r}", file=sys.stderr)',
      '            sys.exit(1)',
      '        if linkname.startswith("/") or (linkname and PurePosixPath(linkname).is_absolute()):',
      '            print(f"archive linkname absolute: {name!r} -> {linkname!r}", file=sys.stderr)',
      '            sys.exit(1)',
      '        if linkname and ".." in linkname.split("/"):',
      '            print(f"archive linkname traversal: {name!r} -> {linkname!r}", file=sys.stderr)',
      '            sys.exit(1)',
      '        continue',
    ].join('\n'),
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function validateZipMembers(archivePath) {
  const result = spawnSync('python3', ['-', String(archivePath)], {
    input: [
      'import sys, zipfile',
      'from pathlib import PurePosixPath',
      'archive = sys.argv[1]',
      'try:',
      '    zf = zipfile.ZipFile(archive, "r")',
      'except Exception as exc:',
      '    print(f"zip open failed: {exc}", file=sys.stderr)',
      '    sys.exit(1)',
      'for info in zf.infolist():',
      '    name = info.filename',
      '    if chr(92) in name:',
      '        print(f"zip backslash: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if name.startswith("/"):',
      '        print(f"zip absolute: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    if PurePosixPath(name).is_absolute():',
      '        print(f"zip absolute posix: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    stripped = name.rstrip("/")',
      '    if stripped and ".." in stripped.split("/"):',
      '        print(f"zip traversal: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
      '    mode = (info.external_attr >> 16) & 0o170000',
      '    if mode == 0o120000:',
      '        try:',
      '            target = zf.read(name).decode("utf-8", errors="ignore")',
      '        except Exception:',
      '            target = ""',
      '        if chr(92) in target:',
      '            print(f"zip symlink backslash: {name!r} -> {target!r}", file=sys.stderr)',
      '            sys.exit(1)',
      '        if target.startswith("/") or (target and PurePosixPath(target).is_absolute()):',
      '            print(f"zip symlink absolute: {name!r} -> {target!r}", file=sys.stderr)',
      '            sys.exit(1)',
      '        if target and ".." in target.split("/"):',
      '            print(f"zip symlink traversal: {name!r} -> {target!r}", file=sys.stderr)',
      '            sys.exit(1)',
      '        continue',
      '    if mode != 0 and mode not in (0o100000, 0o040000, 0o120000):',
      '        print(f"zip unexpected type {oct(mode)}: {name!r}", file=sys.stderr)',
      '        sys.exit(1)',
    ].join('\n'),
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function validateArchiveMembers(archivePath) {
  if (/\.zip$/i.test(archivePath) || /\.whl$/i.test(archivePath)) return validateZipMembers(archivePath);
  return validateTarMembers(archivePath);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs || 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ok: result.error ? false : result.status === 0,
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function regularExecutable(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function parseArchList(text) {
  return [...new Set((String(text).match(/\b(?:x86_64|arm64)\b/g) || []))];
}

function parseDylibs(text) {
  return String(text).split(/\r?\n/)
    .filter((line) => /^\s/.test(line))
    .map((line) => line.trim().split(' (compatibility version')[0])
    .filter(Boolean);
}

function validateManifest(manifestPath, downloadsPath) {
  const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const failures = [];
  if (document.releaseStatus !== 'non-release') failures.push('manifest releaseStatus is not non-release');
  if (document.policy?.releaseEnabled !== false) failures.push('manifest releaseEnabled must be false');
  for (const item of document.artifacts || []) {
    if (!item.official) failures.push(`${item.name}: source is not marked official/maintainer`);
    if (!/^https:\/\//.test(item.url || '') || MOVING_URL_RE.test(item.url || '')) {
      failures.push(`${item.name}: source URL is not an immutable HTTPS pin`);
    }
    if (!/^[0-9a-f]{64}$/.test(item.sha256 || '')) failures.push(`${item.name}: invalid SHA-256`);
    if (!/^[^/]+$/.test(item.filename || '')) failures.push(`${item.name}: unsafe filename`);
    if (downloadsPath) {
      const filePath = path.join(downloadsPath, item.filename);
      let downloadStat;
      try { downloadStat = fs.lstatSync(filePath); } catch { downloadStat = null; }
      if (!downloadStat) {
        failures.push(`${item.name}: verified download is missing`);
      } else if (downloadStat.isSymbolicLink() || !downloadStat.isFile() || sha256(filePath) !== item.sha256) {
        failures.push(`${item.name}: downloaded file does not match manifest SHA-256`);
      } else if (/\.(?:tar(?:\.(?:gz|xz|bz2))?|tgz|zip|whl)$/i.test(item.filename)) {
        const validation = validateArchiveMembers(filePath);
        if (!validation.ok) failures.push(`${item.name}: archive contains unsafe member (fail-closed)`);
      }
    }
  }
  return {
    ok: failures.length === 0,
    releaseStatus: document.releaseStatus,
    artifacts: (document.artifacts || []).map(({ name, version, kind, url, sha256: digest }) => ({ name, version, kind, url, sha256: digest })),
    failures,
  };
}

function probeBinary(filePath) {
  const result = { path: filePath, regularExecutable: regularExecutable(filePath), checks: {} };
  if (result.regularExecutable) result.sha256 = sha256(filePath);
  if (!result.regularExecutable) {
    result.checks.failure = 'not a regular executable file';
    return result;
  }

  const fileProbe = run('file', ['-b', filePath]);
  const lipoProbe = run('lipo', ['-archs', filePath]);
  const otoolProbe = run('otool', ['-L', filePath]);
  const signProbe = run('codesign', ['--verify', '--deep', '--strict', filePath]);
  const signDetail = run('codesign', ['-dv', '--verbose=4', filePath]);
  const fileArchitectures = parseArchList(fileProbe.stdout);
  const lipoArchitectures = parseArchList(lipoProbe.stdout);
  const dylibs = parseDylibs(otoolProbe.stdout);
  const forbiddenDylibs = dylibs.filter((dependency) => !ALLOWED_DYLIB_PREFIXES.some((prefix) => dependency.startsWith(prefix)));

  result.checks.file = { ok: fileProbe.ok && /Mach-O/.test(fileProbe.stdout), output: fileProbe.stdout.trim() };
  result.checks.fileArchitectures = fileArchitectures;
  result.checks.lipo = { ok: lipoProbe.ok, architectures: lipoArchitectures, output: lipoProbe.stdout.trim() };
  result.checks.universal = REQUIRED_ARCHES.every((arch) => fileArchitectures.includes(arch) && lipoArchitectures.includes(arch));
  result.checks.otool = { ok: otoolProbe.ok && forbiddenDylibs.length === 0, dependencies: dylibs, forbidden: forbiddenDylibs };
  result.checks.codesign = {
    verify: signProbe.ok,
    detail: `${signDetail.stdout}${signDetail.stderr}`.trim(),
  };
  result.ok = result.checks.file.ok && result.checks.universal && result.checks.otool.ok && result.checks.codesign.verify;
  return result;
}

function probeCapabilities(ffmpegPath, ffprobePath, mediaPath) {
  const filterHelp = run(ffmpegPath, ['-hide_banner', '-h', 'filter=libplacebo'], { timeoutMs: 60_000 });
  const filters = run(ffmpegPath, ['-hide_banner', '-filters']);
  const encoders = run(ffmpegPath, ['-hide_banner', '-encoders']);
  const encoderHelp = run(ffmpegPath, ['-hide_banner', '-h', 'encoder=libx264']);
  const decoders = run(ffmpegPath, ['-hide_banner', '-decoders']);
  const formats = run(ffmpegPath, ['-hide_banner', '-formats']);
  const filterText = `${filterHelp.stdout}\n${filterHelp.stderr}`;
  const encoderText = `${encoders.stdout}\n${encoders.stderr}`;
  const encoderHelpText = `${encoderHelp.stdout}\n${encoderHelp.stderr}`;
  const decoderText = `${decoders.stdout}\n${decoders.stderr}`;
  const formatText = `${formats.stdout}\n${formats.stderr}`;
  const result = {
    libplacebo: {
      commandOk: filterHelp.ok,
      requiredTokens: {
        filter: /Filter libplacebo/.test(filterText),
        bt2390: /bt\.2390/.test(filterText),
        spline: /spline/.test(filterText),
        perceptual: /perceptual/.test(filterText),
        peakDetect: /peak_detect/.test(filterText),
        colorspace: /colorspace/.test(filterText),
        colorPrimaries: /color_primaries/.test(filterText),
        colorTransfer: /color_trc/.test(filterText),
        range: /range/.test(filterText),
        format: /format/.test(filterText),
      },
    },
    filters: { commandOk: filters.ok, hasLibplacebo: /libplacebo/.test(`${filters.stdout}\n${filters.stderr}`) },
    encoders: {
      commandOk: encoders.ok,
      hasLibx264: /\blibx264\b/.test(encoderText),
      noVideoToolboxEncoder: !/(?:h264|hevc)_videotoolbox\b/.test(encoderText),
      contractOptions: encoderHelp.ok && /\bpreset\b/.test(encoderHelpText) && /\bcrf\b/.test(encoderHelpText),
    },
    formats: {
      commandOk: formats.ok,
      hasMov: /\bmov\b/.test(formatText),
      hasMp4: /\bmp4\b/.test(formatText),
    },
    decoders: {
      commandOk: decoders.ok,
      hasH264: /\bh264\b/.test(decoderText),
      hasHevc: /\bhevc\b/.test(decoderText),
      hasAac: /\baac\b/.test(decoderText),
    },
    ffprobeSideData: { status: 'not-run' },
  };
  result.libplacebo.ok = Object.values(result.libplacebo.requiredTokens).every(Boolean);
  result.encoders.ok = result.encoders.commandOk && result.encoders.hasLibx264
    && result.encoders.noVideoToolboxEncoder && result.encoders.contractOptions;
  result.formats.ok = result.formats.commandOk && result.formats.hasMov && result.formats.hasMp4;
  result.decoders.ok = result.decoders.commandOk && result.decoders.hasH264 && result.decoders.hasHevc && result.decoders.hasAac;
  if (mediaPath) {
    const probe = run(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '0%+1',
      '-show_frames', '-show_entries', 'frame=side_data_list', '-of', 'json', mediaPath,
    ], { timeoutMs: 60_000 });
    let sideDataTypes = [];
    try {
      const parsed = JSON.parse(probe.stdout);
      sideDataTypes = [...new Set((parsed.frames || [])
        .flatMap((frame) => frame.side_data_list || frame.side_data || [])
        .map((item) => item.side_data_type)
        .filter(Boolean))];
    } catch {
      sideDataTypes = [];
    }
    result.ffprobeSideData = {
      status: probe.ok ? 'pass' : 'fail',
      hasSideDataField: /"side_data(?:_list)?"/.test(probe.stdout),
      sideDataTypes,
      output: probe.stdout.trim().slice(0, 4096),
      error: probe.stderr.trim().slice(0, 1024),
    };
  }
  result.ok = result.libplacebo.ok && result.filters.hasLibplacebo && result.encoders.ok
    && result.formats.ok && result.decoders.ok;
  return result;
}

function probeBundle(bundlePath) {
  if (!bundlePath) return { status: 'not-run' };
  const audit = run(process.execPath, [path.join(ROOT, 'scripts/bundle-audit.cjs'), bundlePath], { timeoutMs: 60_000 });
  return { status: audit.ok ? 'pass' : 'fail', output: `${audit.stdout}${audit.stderr}`.trim().slice(0, 4096) };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    schema: 1,
    status: 'non-release',
    host: { platform: process.platform, arch: os.arch(), release: os.release() },
    manifest: validateManifest(options.manifest, options.downloads),
  };
  if (!report.manifest.ok) {
    report.status = 'blocked';
  } else if (!options.manifestOnly && options.tools) {
    const ffmpeg = path.join(options.tools, 'ffmpeg');
    const ffprobe = path.join(options.tools, 'ffprobe');
    report.binaries = {
      ffmpeg: probeBinary(ffmpeg),
      ffprobe: probeBinary(ffprobe),
    };
    report.capabilities = (report.binaries.ffmpeg.ok && report.binaries.ffprobe.ok)
      ? probeCapabilities(ffmpeg, ffprobe, options.media)
      : { status: 'blocked-by-binary-probes' };
    report.bundleAudit = probeBundle(options.bundle);
    report.status = report.binaries.ffmpeg.ok && report.binaries.ffprobe.ok && report.capabilities.ok
      ? 'candidate-pass-non-release'
      : 'blocked';
  } else {
    report.status = 'manifest-pass-non-release';
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report) fs.writeFileSync(options.report, serialized, { mode: 0o600 });
  process.stdout.write(serialized);
  if (report.status === 'blocked') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`portable-toolchain verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, validateManifest, parseDylibs, probeBinary, probeCapabilities, sha256, HASH_CHUNK_BYTES, validateTarMembers, validateZipMembers, validateArchiveMembers };
