'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const provenance = require('../../scripts/workflow-integration-provenance.cjs');

const EXPECTED_SHA256 = '91705298c56b649a75bf76be101fea28fbe41b1e88adf4778490ce8b2d14b3e2';

function fakeCodesign(calls, detail, verifyStatus = 0) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'codesign');
    if (args[0] === '--verify') {
      return { status: verifyStatus, signal: null, stdout: '', stderr: '' };
    }
    return { status: 0, signal: null, stdout: '', stderr: detail };
  };
}

test('WorkflowIntegration provenance manifest centralizes the pinned SDK identity', () => {
  assert.equal(provenance.WORKFLOW_INTEGRATION_PROVENANCE.sha256, EXPECTED_SHA256);
  assert.equal(provenance.WORKFLOW_INTEGRATION_PROVENANCE.identifier, 'com.blackmagic-design.WorkflowIntegration');
  assert.equal(provenance.WORKFLOW_INTEGRATION_PROVENANCE.teamIdentifier, '9ZGFBWLSYP');
  assert.equal(provenance.WORKFLOW_INTEGRATION_PROVENANCE.resolveVersion, '21.0.3');
});

test('Darwin source provenance requires exact hash, codesign verification, and parsed identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-workflow-provenance-'));
  try {
    const nodePath = path.join(dir, 'WorkflowIntegration.node');
    fs.writeFileSync(nodePath, 'synthetic node');
    const calls = [];
    const result = provenance.verifyWorkflowIntegrationNode(nodePath, {
      platform: 'darwin',
      hashFile: () => EXPECTED_SHA256,
      spawnSync: fakeCodesign(calls, [
        'Identifier=com.blackmagic-design.WorkflowIntegration',
        'TeamIdentifier=9ZGFBWLSYP',
      ].join('\n')),
    });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(calls.map(({ args }) => args), [
      ['--verify', '--deep', '--strict', nodePath],
      ['-dv', '--verbose=4', nodePath],
    ]);
    assert.ok(calls.every(({ options }) => options.shell === false));
    assert.ok(calls.every(({ options }) => Number.isFinite(options.timeout)));
    assert.ok(calls.every(({ options }) => options.maxBuffer > 0));
    assert.deepEqual(result.identity, {
      identifier: 'com.blackmagic-design.WorkflowIntegration',
      teamIdentifier: '9ZGFBWLSYP',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Darwin source provenance rejects wrong identity and failed signature without exposing probe output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrtosdr-workflow-provenance-fail-'));
  try {
    const nodePath = path.join(dir, 'WorkflowIntegration.node');
    fs.writeFileSync(nodePath, 'synthetic node');
    const wrongIdentity = provenance.verifyWorkflowIntegrationNode(nodePath, {
      platform: 'darwin',
      hashFile: () => EXPECTED_SHA256,
      spawnSync: fakeCodesign([], 'Identifier=other\nTeamIdentifier=other\nSECRET-PROBE-OUTPUT'),
    });
    assert.equal(wrongIdentity.ok, false);
    assert.match(wrongIdentity.reason, /identifier|team/i);
    assert.equal(wrongIdentity.reason.includes('SECRET-PROBE-OUTPUT'), false);

    const failedSignature = provenance.verifyWorkflowIntegrationNode(nodePath, {
      platform: 'darwin',
      hashFile: () => EXPECTED_SHA256,
      spawnSync: fakeCodesign([], '', 1),
    });
    assert.equal(failedSignature.ok, false);
    assert.match(failedSignature.reason, /codesign verify/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
