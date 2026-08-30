'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const verifier = require('../../scripts/toolchain/verify-portable-tools.cjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pythonMakeTar(archivePath, entries) {
  // entries: [{name, content, type: 'file'|'symlink'|'hardlink', linkname}]
  const py = `
import tarfile, io, os
archive = ${JSON.stringify(archivePath)}
entries = ${JSON.stringify(entries)}
with tarfile.open(archive, 'w') as tf:
    for e in entries:
        name = e['name']
        typ = e.get('type', 'file')
        content = e.get('content', 'data')
        linkname = e.get('linkname', '')
        if typ == 'symlink':
            ti = tarfile.TarInfo(name)
            ti.type = tarfile.SYMTYPE
            ti.linkname = linkname
            ti.mode = 0o777
            ti.mtime = 0
            tf.addfile(ti)
        elif typ == 'hardlink':
            ti = tarfile.TarInfo(name)
            ti.type = tarfile.LNKTYPE
            ti.linkname = linkname
            ti.mode = 0o644
            ti.mtime = 0
            tf.addfile(ti)
        elif typ in ('fifo', 'char', 'block'):
            ti = tarfile.TarInfo(name)
            ti.type = {'fifo': tarfile.FIFOTYPE, 'char': tarfile.CHRTYPE, 'block': tarfile.BLKTYPE}[typ]
            ti.mode = 0o644
            ti.devmajor = 1
            ti.devminor = 3
            ti.mtime = 0
            tf.addfile(ti)
        else:
            data = content.encode('utf-8')
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mode = 0o644
            ti.mtime = 0
            tf.addfile(ti, io.BytesIO(data))
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pythonMakeTar failed: ${r.stderr}`);
}

function pythonMakeZip(archivePath, entries) {
  const py = `
import zipfile, os, stat
archive = ${JSON.stringify(archivePath)}
entries = ${JSON.stringify(entries)}
with zipfile.ZipFile(archive, 'w') as zf:
    for e in entries:
        name = e['name']
        typ = e.get('type', 'file')
        content = e.get('content', 'data')
        if typ == 'symlink':
            zi = zipfile.ZipInfo(name)
            zi.create_system = 3
            zi.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(zi, e.get('linkname', 'target'))
        else:
            zf.writestr(name, content)
        if e.get('external_attr') is not None:
            # override for custom mode test
            for info in zf.infolist():
                if info.filename == name:
                    info.external_attr = e['external_attr']
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pythonMakeZip failed: ${r.stderr}`);
}

// Archive validation tests
test('toolchain archive validation rejects absolute paths in tar', () => {
  const dir = tmpDir('hdrtosdr-tar-abs-');
  try {
    const archive = path.join(dir, 'abs.tar');
    pythonMakeTar(archive, [{ name: '/etc/passwd', content: 'x' }]);
    const res = verifier.validateTarMembers(archive);
    assert.equal(res.ok, false, 'absolute tar member must be rejected');
    assert.match(res.stderr, /absolute/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain archive validation rejects traversal in tar', () => {
  const dir = tmpDir('hdrtosdr-tar-traversal-');
  try {
    const archive = path.join(dir, 'traversal.tar');
    pythonMakeTar(archive, [{ name: '../evil', content: 'x' }]);
    assert.equal(verifier.validateTarMembers(archive).ok, false);
    const archive2 = path.join(dir, 'traversal2.tar');
    pythonMakeTar(archive2, [{ name: 'a/../../b', content: 'x' }]);
    assert.equal(verifier.validateTarMembers(archive2).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain archive validation rejects backslash in tar', () => {
  const dir = tmpDir('hdrtosdr-tar-bs-');
  try {
    const archive = path.join(dir, 'bs.tar');
    pythonMakeTar(archive, [{ name: 'a\\b', content: 'x' }]);
    assert.equal(verifier.validateTarMembers(archive).ok, false);
    assert.match(verifier.validateTarMembers(archive).stderr, /backslash/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain archive validation rejects FIFO and character/block devices before extraction', () => {
  const dir = tmpDir('hdrtosdr-tar-special-');
  try {
    for (const type of ['fifo', 'char', 'block']) {
      const archive = path.join(dir, `${type}.tar`);
      const extracted = path.join(dir, `${type}-extracted`);
      pythonMakeTar(archive, [{ name: `pkg/${type}`, type }]);
      const result = verifier.validateTarMembers(archive);
      assert.equal(result.ok, false, `${type} tar member must be rejected`);
      assert.match(result.stderr, /unsupported.*type/i);
      assert.equal(fs.existsSync(extracted), false, 'rejected special member must not be extracted');
    }

    const buildScript = fs.readFileSync(path.join(__dirname, '../../scripts/toolchain/build-portable-tools.sh'), 'utf8');
    assert.match(buildScript, /member\.type not in/);
    assert.match(buildScript, /validate_tar_members "\$archive"\s*\n\s*tar -xf/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain archive validation rejects symlink and hardlink in tar', () => {
  const dir = tmpDir('hdrtosdr-tar-link-');
  try {
    const sym = path.join(dir, 'sym.tar');
    pythonMakeTar(sym, [{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }]);
    assert.equal(verifier.validateTarMembers(sym).ok, false);

    const symTraversal = path.join(dir, 'sym2.tar');
    pythonMakeTar(symTraversal, [{ name: 'link2', type: 'symlink', linkname: '../evil' }]);
    assert.equal(verifier.validateTarMembers(symTraversal).ok, false);

    const hard = path.join(dir, 'hard.tar');
    pythonMakeTar(hard, [{ name: 'hard', type: 'hardlink', linkname: '/etc/passwd' }]);
    assert.equal(verifier.validateTarMembers(hard).ok, false);

    const hardTraversal = path.join(dir, 'hard2.tar');
    pythonMakeTar(hardTraversal, [{ name: 'hard2', type: 'hardlink', linkname: '../evil' }]);
    assert.equal(verifier.validateTarMembers(hardTraversal).ok, false);

    // Safe internal symlink/hardlink should be allowed (e.g., MoltenVK dylib)
    const safeSym = path.join(dir, 'safe.tar');
    pythonMakeTar(safeSym, [{ name: 'pkg/link', type: 'symlink', linkname: 'target' }]);
    assert.equal(verifier.validateTarMembers(safeSym).ok, true);
    const safeHard = path.join(dir, 'safeHard.tar');
    pythonMakeTar(safeHard, [{ name: 'pkg/hard', type: 'hardlink', linkname: 'pkg/file' }, { name: 'pkg/file', content: 'data' }]);
    assert.equal(verifier.validateTarMembers(safeHard).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain archive validation rejects absolute traversal backslash and symlink in zip', () => {
  const dir = tmpDir('hdrtosdr-zip-');
  try {
    const abs = path.join(dir, 'abs.zip');
    pythonMakeZip(abs, [{ name: '/evil', content: 'x' }]);
    assert.equal(verifier.validateZipMembers(abs).ok, false);

    const trav = path.join(dir, 'trav.zip');
    pythonMakeZip(trav, [{ name: '../evil', content: 'x' }]);
    assert.equal(verifier.validateZipMembers(trav).ok, false);

    const bs = path.join(dir, 'bs.zip');
    pythonMakeZip(bs, [{ name: 'a\\b', content: 'x' }]);
    assert.equal(verifier.validateZipMembers(bs).ok, false);

    const sym = path.join(dir, 'sym.zip');
    pythonMakeZip(sym, [{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }]);
    assert.equal(verifier.validateZipMembers(sym).ok, false);
    const symTrav = path.join(dir, 'sym2.zip');
    pythonMakeZip(symTrav, [{ name: 'link2', type: 'symlink', linkname: '../evil' }]);
    assert.equal(verifier.validateZipMembers(symTrav).ok, false);
    const symSafe = path.join(dir, 'symSafe.zip');
    pythonMakeZip(symSafe, [{ name: 'linkSafe', type: 'symlink', linkname: 'target' }]);
    assert.equal(verifier.validateZipMembers(symSafe).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain archive validation accepts valid tar and zip', () => {
  const dir = tmpDir('hdrtosdr-valid-');
  try {
    const goodTar = path.join(dir, 'good.tar');
    pythonMakeTar(goodTar, [
      { name: 'pkg-1.0/', content: '' },
      { name: 'pkg-1.0/file.txt', content: 'hello' },
      { name: 'pkg-1.0/nested/data.bin', content: '123' },
    ]);
    assert.equal(verifier.validateTarMembers(goodTar).ok, true);
    assert.equal(verifier.validateArchiveMembers(goodTar).ok, true);

    const goodZip = path.join(dir, 'good.zip');
    pythonMakeZip(goodZip, [
      { name: 'pkg/', content: '' },
      { name: 'pkg/file.txt', content: 'hello' },
    ]);
    assert.equal(verifier.validateZipMembers(goodZip).ok, true);
    assert.equal(verifier.validateArchiveMembers(goodZip).ok, true);

    const wheelLike = path.join(dir, 'pkg-1.0-py3-none-any.whl');
    pythonMakeZip(wheelLike, [{ name: 'pkg/module.py', content: 'print(1)' }]);
    assert.equal(verifier.validateArchiveMembers(wheelLike).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain streaming hash is bounded and deterministic', () => {
  const dir = tmpDir('hdrtosdr-hash-');
  try {
    // Create file larger than chunk size to prove chunking
    const file = path.join(dir, 'large.bin');
    const chunk = verifier.HASH_CHUNK_BYTES;
    assert.ok(chunk >= 64 * 1024, 'chunk size must be bounded');
    const size = chunk * 2 + 12345;
    const data = Buffer.alloc(size, 'a');
    // sprinkle deterministic pattern
    for (let i = 0; i < size; i += 997) data[i] = 0x42;
    fs.writeFileSync(file, data);
    const viaStreaming = verifier.sha256(file);
    const viaDirect = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(viaStreaming, viaDirect, 'streaming hash must match direct hash');

    // check source does not use readFileSync for hashing
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/toolchain/verify-portable-tools.cjs'), 'utf8');
    assert.equal(/hash\.update\(fs\.readFileSync/.test(src), false, 'must not use readFileSync for hashing');
    assert.match(src, /HASH_CHUNK_BYTES/);
    assert.match(src, /fs\.openSync/);
    assert.match(src, /fs\.readSync/);
    assert.match(src, /Buffer\.allocUnsafe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolchain build script reads hashes from manifest and validates before extraction', () => {
  const buildScript = fs.readFileSync(path.join(__dirname, '../../scripts/toolchain/build-portable-tools.sh'), 'utf8');
  // must contain validation helpers
  assert.match(buildScript, /validate_tar_members/);
  assert.match(buildScript, /validate_zip_members/);
  // every extraction must be preceded by validation
  const extractSingleIdx = buildScript.indexOf('extract_single_root()');
  const validateTarIdx = buildScript.indexOf('validate_tar_members()');
  assert.ok(validateTarIdx < extractSingleIdx, 'validation helper must be defined before use');
  // check that tar extraction is guarded
  assert.match(buildScript, /validate_tar_members "\$archive"\s*\n\s*tar -xf/);
  assert.match(buildScript, /validate_zip_members "\$archive"\s*\n\s*unzip -q/);
  // check manifest hash deduplication: no hardcoded sha literals for pinned archives
  const pinnedShas = [
    'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635',
    '4efe1c8d4da3c61295eb5fdfa50e6037409d8425eb3c15dd86788679c4ce59ee',
    'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9',
  ];
  for (const sha of pinnedShas) {
    // manifest still contains it, build script should not have literal assignment
    const count = (buildScript.match(new RegExp(sha, 'g')) || []).length;
    assert.equal(count, 0, `build script must not duplicate SHA literal ${sha}`);
  }
  assert.match(buildScript, /manifest_sha_for/);
  assert.match(buildScript, /Remaining duplication note/);
  // ensure backslash and link checks are present
  assert.match(buildScript, /chr\(92\)|\\\\/);
  assert.match(buildScript, /issym|islnk|SYMTYPE|LNKTYPE/);
  // ensure manifest remains non-release
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../scripts/toolchain/portable-toolchain-manifest.json'), 'utf8'));
  assert.equal(manifest.releaseStatus, 'non-release');
  assert.equal(manifest.policy.releaseEnabled, false);
});
