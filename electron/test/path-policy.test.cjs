const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../source-path-policy.cjs');
const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/path-parity.json'), 'utf8'));

test('BUG-026/027 canonical path policy matches the shared parity corpus', () => {
  for (const fixture of cases) {
    assert.equal(
      policy.canonicalPathsEqual(fixture.left, fixture.right, path.posix, 'linux'),
      fixture.posixEqual,
      fixture.name,
    );
    assert.equal(
      policy.canonicalPathsEqual(fixture.left, fixture.right, path.posix, 'darwin'),
      fixture.darwinEqual,
      `${fixture.name} darwin`,
    );
  }
});

test('BUG-027 does not fold case when comparing canonical paths', () => {
  assert.notEqual(
    policy.normalizeCanonicalPath('/private/tmp/HdrToSdr/source.mov', path.posix, 'darwin'),
    policy.normalizeCanonicalPath('/private/tmp/hdrtosdr/source.mov', path.posix, 'darwin'),
  );
});
