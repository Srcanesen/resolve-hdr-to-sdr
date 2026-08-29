const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const outputStore = require('../output-store.cjs');

test('sanitizeBasename removes unsafe chars and limits', () => {
  assert.equal(outputStore.sanitizeBasename('../../etc/passwd.mov'), 'passwd');
  assert.equal(outputStore.sanitizeBasename(' my file @#$ .mov'), 'my_file');
  assert.equal(outputStore.sanitizeBasename(''), 'output');
  const long = 'a'.repeat(200) + '.mov';
  assert.ok(outputStore.sanitizeBasename(long).length <= 80);
});

test('buildDisplayName uses sanitized plus suffix', () => {
  const name = outputStore.buildDisplayName('IMG_6700.MOV');
  assert.equal(name, 'IMG_6700_sdr_rec709_h264_hlg-local-b-v1.mp4');
  const name2 = outputStore.buildDisplayName('/tmp/../foo bar.mov');
  assert.equal(name2, 'foo_bar_sdr_rec709_h264_hlg-local-b-v1.mp4');
});

test('allocateUniqueFinalPath collision handling', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-out-'));
  try {
    const display = 'test_sdr_rec709_h264_hlg-local-b-v1.mp4';
    const p1 = outputStore.allocateUniqueFinalPath(tmp, display);
    assert.equal(p1, path.join(tmp, display));
    fs.writeFileSync(p1, 'dummy');
    const p2 = outputStore.allocateUniqueFinalPath(tmp, display);
    assert.notEqual(p2, p1);
    assert.ok(p2.includes('_001'));
    assert.equal(fs.existsSync(p2), false);
    fs.writeFileSync(p2, 'dummy2');
    const p3 = outputStore.allocateUniqueFinalPath(tmp, display);
    assert.ok(p3.includes('_002'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('allocateUniqueFinalPath never overwrites existing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-out-'));
  try {
    const display = 'collide_sdr_rec709_h264_hlg-local-b-v1.mp4';
    const p1 = path.join(tmp, display);
    fs.writeFileSync(p1, 'orig');
    const p2 = outputStore.allocateUniqueFinalPath(tmp, display);
    assert.notEqual(p1, p2);
    // Ensure original still exists and not overwritten
    assert.equal(fs.readFileSync(p1, 'utf8'), 'orig');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getStagingPath is private collision-free .partial', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-out-'));
  try {
    const final = path.join(tmp, 'foo_sdr_rec709_h264_hlg-local-b-v1.mp4');
    const staging = outputStore.getStagingPath(tmp, final);
    assert.ok(staging.startsWith(tmp));
    assert.ok(path.basename(staging).startsWith('.'));
    assert.ok(staging.endsWith('.partial.mp4'));
    assert.equal(fs.existsSync(staging), false);
    // Second call gives different path
    const staging2 = outputStore.getStagingPath(tmp, final);
    assert.notEqual(staging, staging2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeStaging cleans only staging, preserves existing outputs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-out-'));
  try {
    const staging = path.join(tmp, '.abc.partial.mp4');
    const final = path.join(tmp, 'keep_sdr_rec709_h264_hlg-local-b-v1.mp4');
    fs.writeFileSync(staging, 'partial');
    fs.writeFileSync(final, 'final');
    outputStore.removeStaging(staging);
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.existsSync(final), true);
    assert.equal(fs.readFileSync(final, 'utf8'), 'final');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getOutputRoot is ~/Movies/HdrToSdr', () => {
  const root = outputStore.getOutputRoot();
  assert.ok(root.endsWith(path.join('Movies', 'HdrToSdr')));
  assert.ok(path.isAbsolute(root));
});

test('ensureOutputRoot rejects symlink components', () => {
  const os = require('os');
  const realHome = os.homedir();
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-home-'));
  const fakeHome = path.join(tmpBase, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const origHomedir = os.homedir;
  // Monkey patch homedir
  os.homedir = () => fakeHome;
  // Need fresh require of output-store to pick up patched homedir
  delete require.cache[require.resolve('../output-store.cjs')];
  const store2 = require('../output-store.cjs');
  try {
    // Create Movies as symlink to another dir
    const realMovies = path.join(tmpBase, 'realMovies');
    fs.mkdirSync(realMovies);
    const moviesLink = path.join(fakeHome, 'Movies');
    fs.symlinkSync(realMovies, moviesLink, 'dir');
    let threw = false;
    try {
      store2.ensureOutputRoot();
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('symlink') || e.message.includes('escape'));
    }
    assert.equal(threw, true, 'should reject symlink Movies component');
    // Clean symlink and try normal creation should succeed
    fs.unlinkSync(moviesLink);
    const root = store2.ensureOutputRoot();
    assert.ok(fs.existsSync(root));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    // Verify second call idempotent
    const root2 = store2.ensureOutputRoot();
    assert.equal(root, root2);
  } finally {
    os.homedir = origHomedir;
    delete require.cache[require.resolve('../output-store.cjs')];
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('allocateUniqueFinalPath and getStagingPath containment checks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-contain-'));
  try {
    // Candidate that escapes via traversal should be normalized but still under root due to basename
    const display = '../escape.mov';
    const p = outputStore.allocateUniqueFinalPath(tmp, display);
    assert.ok(p.startsWith(path.resolve(tmp)), 'should be contained');
    // getStagingPath must be under root
    const staging = outputStore.getStagingPath(tmp, p);
    assert.ok(staging.startsWith(path.resolve(tmp)));
    // Staging outside root should throw
    assert.throws(() => {
      outputStore.getStagingPath(tmp, path.join('/tmp', 'outside.mov'));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('naming and staging collision loops are bounded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-bound-'));
  try {
    const display = 'test_sdr_rec709_h264_hlg-local-b-v1.mp4';
    // Fill many collisions
    for (let i = 0; i < 5; i++) {
      const p = i === 0 ? path.join(tmp, display) : path.join(tmp, `test_sdr_rec709_h264_hlg-local-b-v1_${String(i).padStart(3, '0')}.mp4`);
      fs.writeFileSync(p, 'x');
    }
    const next = outputStore.allocateUniqueFinalPath(tmp, display);
    assert.ok(!fs.existsSync(next));
    assert.ok(next.includes('_00'));
    // Staging collision bounded: pre-create a staging-like file then ensure new one differs
    const final = path.join(tmp, display);
    const s1 = outputStore.getStagingPath(tmp, final);
    fs.writeFileSync(s1, 'partial');
    const s2 = outputStore.getStagingPath(tmp, final);
    assert.notEqual(s1, s2);
    assert.equal(fs.existsSync(s2), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
