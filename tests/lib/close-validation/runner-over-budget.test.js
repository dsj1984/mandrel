/**
 * Story #5949 — a capture script that exits 76 declares its slice over this
 * host's budget. Under `coverage.onOverBudget: "defer-to-ci"` close records
 * the capture as deferred, skips every gate that reads the artifact it never
 * wrote and says so in the envelope and the PR body; under the default
 * `block` it fails naming the switch. A timeout is never deferred.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDefaultGates,
  COVERAGE_DEFERRED_SKIP_REASON,
} from '../../../.agents/scripts/lib/close-validation/gates.js';
import { runCloseValidation } from '../../../.agents/scripts/lib/close-validation/runner.js';
import { buildPullRequestFields } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/normalize-pr-title.js';
import { closeEnvelopeGates } from '../../../.agents/scripts/lib/orchestration/single-story-close/result.js';

const CAPTURE_SCRIPTS = { 'test:coverage': 'c8 node --test' };
const policyConfig = (onOverBudget) => ({
  delivery: {
    quality: {
      gates: {
        crap: { enabled: true },
        maintainability: { enabled: true },
        coverage: { enabled: true, ...(onOverBudget ? { onOverBudget } : {}) },
      },
    },
  },
});
const gatesFor = (onOverBudget) =>
  buildDefaultGates({
    config: policyConfig(onOverBudget),
    packageScripts: CAPTURE_SCRIPTS,
    presentBaselines: ['coverage', 'crap', 'maintainability'],
  });
const byName = (gates, name) => gates.find((g) => g.name === name);

describe('buildDefaultGates — over-budget flags', () => {
  it('marks the capture deferrable only under defer-to-ci', () => {
    assert.equal(
      byName(gatesFor('defer-to-ci'), 'coverage-capture').deferOnOverBudget,
      true,
    );
    assert.equal(
      byName(gatesFor(null), 'coverage-capture').deferOnOverBudget,
      undefined,
    );
  });

  it('marks exactly the coverage-reading gates', () => {
    const gates = gatesFor('defer-to-ci');
    assert.equal(
      byName(gates, 'quality-preview-crap').readsCoverageArtifact,
      true,
    );
    assert.equal(
      byName(gates, 'check-baselines-coverage').readsCoverageArtifact,
      true,
    );
    assert.equal(
      byName(gates, 'check-baselines-independent').readsCoverageArtifact,
      undefined,
    );
    assert.equal(
      byName(gates, 'quality-preview-mi').readsCoverageArtifact,
      undefined,
    );
  });
});

const CAPTURE = {
  name: 'coverage-capture',
  cmd: 'node',
  args: ['capture'],
  hint: 'failing tests hint',
};
const CRAP_PREVIEW = {
  name: 'quality-preview-crap',
  cmd: 'node',
  args: ['preview'],
  readsCoverageArtifact: true,
};
const COVERAGE_BASELINES = {
  name: 'check-baselines-coverage',
  cmd: 'node',
  args: ['baselines'],
  readsCoverageArtifact: true,
};

/** Runs the serial tail with the capture exiting `status`; records evidence writes. */
async function runTail({ status, deferOnOverBudget }) {
  const spawned = [];
  const recorded = [];
  const lines = [];
  const validation = await runCloseValidation({
    cwd: '/repo',
    gates: [
      { ...CAPTURE, ...(deferOnOverBudget ? { deferOnOverBudget } : {}) },
      CRAP_PREVIEW,
      COVERAGE_BASELINES,
    ],
    runner: (_cmd, args) => {
      spawned.push(args[0]);
      return { status: args[0] === 'capture' ? status : 0 };
    },
    log: (m) => lines.push(m),
    storyId: 5949,
    standalone: true,
    getHeadSha: () => 'a'.repeat(40),
    getTreeFingerprint: () => 'tree',
    shouldSkip: () => ({ skip: false }),
    recordPass: (record) => recorded.push(record.gateName),
    runProjections: async () => ({}),
  });
  return { validation, spawned, recorded, lines };
}

describe('runCloseValidation — exit 76', () => {
  it('defers a flagged capture and skips the gates that read its artifact', async () => {
    const { validation, spawned, recorded, lines } = await runTail({
      status: 76,
      deferOnOverBudget: true,
    });
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.failed, []);
    assert.deepEqual(
      validation.deferred.map((d) => [d.gate.name, d.reason]),
      [['coverage-capture', 'over-budget']],
    );
    assert.deepEqual(
      validation.skipped.map((s) => [s.gate.name, s.reason]),
      [
        ['quality-preview-crap', COVERAGE_DEFERRED_SKIP_REASON],
        ['check-baselines-coverage', COVERAGE_DEFERRED_SKIP_REASON],
      ],
    );
    assert.deepEqual(spawned, ['capture']);
    assert.deepEqual(recorded, [], 'a deferral earns no evidence');
    assert.ok(lines.some((l) => /deferred to CI/.test(l)));
  });

  it('fails an unflagged capture with a hint naming onOverBudget', async () => {
    const { validation, spawned } = await runTail({ status: 76 });
    assert.equal(validation.ok, false);
    const [failure] = validation.failed;
    assert.equal(failure.outcome, 'over-budget');
    assert.match(failure.gate.hint, /onOverBudget/);
    assert.deepEqual(spawned, ['capture']);
  });

  it('never defers a timeout, flag or not', async () => {
    const { validation } = await runTail({
      status: 124,
      deferOnOverBudget: true,
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.failed[0].outcome, 'timeout');
    assert.deepEqual(validation.deferred, []);
  });
});

describe('close envelope and PR body', () => {
  it('reports a deferred capture in the envelope gates', () => {
    const gates = closeEnvelopeGates(
      {},
      {
        'coverage-capture': 'deferred',
        'check-baselines-coverage': 'skipped',
        lint: 'passed',
      },
      null,
      false,
    );
    assert.equal(gates['coverage-capture'], 'deferred');
    assert.equal(gates['check-baselines-coverage'], 'skipped');
    assert.equal(gates.lint, undefined);
  });

  it('omits the capture from the envelope when it simply passed', () => {
    const gates = closeEnvelopeGates(
      {},
      { 'coverage-capture': 'passed' },
      null,
    );
    assert.equal(gates['coverage-capture'], undefined);
  });

  it('adds the deferral line beneath Closes only when coverage was deferred', () => {
    const fields = (coverageDeferred) =>
      buildPullRequestFields({
        storyTitle: 'Defer coverage',
        storyId: 5949,
        storyBranch: 'story-5949',
        baseBranch: 'main',
        gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
        coverageDeferred,
      }).body;
    const deferred = fields(true).split('\n');
    assert.equal(deferred[0], 'Closes #5949');
    assert.match(
      deferred[2],
      /^Coverage deferred to CI: .*onOverBudget: defer-to-ci/,
    );
    assert.doesNotMatch(fields(false), /Coverage deferred to CI/);
  });
});
