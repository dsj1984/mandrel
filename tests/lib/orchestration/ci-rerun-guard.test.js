/**
 * tests/lib/orchestration/ci-rerun-guard.test.js
 *
 * The CI digest records whether each failure was a required or an advisory
 * check, and the green-verdict classifier admits `advisory-cleared` only when
 * every recorded failure is advisory and the probe reads each green on the
 * same head (Story #5876).
 */

import { strict as assert } from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { recordRequiredRed } from '../../../.agents/scripts/lib/orchestration/ci-red-handling.js';
import {
  classifyGreenVerdict,
  readCiDigest,
  recordRerunAllowance,
  writeCiDigest,
} from '../../../.agents/scripts/lib/orchestration/ci-rerun-guard.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const STORY = 5876;
const HEAD = 'abc1234def';

function writeDigest(tempRoot, failures) {
  return writeCiDigest({
    storyId: STORY,
    prNumber: 1,
    headSha: HEAD,
    failures,
    tempRoot,
    cwd: tempRoot,
    prRef: '1',
    checkRunFn: () => ({ runId: '9', url: 'https://example/runs/9' }),
    logTailFn: () => '',
  });
}

describe('writeCiDigest — the required flag', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = makeTempDir('mandrel-5876-');
  });
  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

  it('records required:false for an advisory red and true otherwise, absent reading as true', () => {
    const paths = writeDigest(tempRoot, [
      { name: 'policy-impact', outcome: 'failure', required: false },
      { name: 'validate', outcome: 'failure', required: true },
      { name: 'lint', outcome: 'failure' },
    ]);
    const digest = readCiDigest({ storyId: STORY, tempRoot, cwd: tempRoot });
    assert.deepEqual(
      digest.allFailures.map((f) => f.required),
      [false, true, true],
    );
    const md = readFileSync(paths.mdPath, 'utf8');
    assert.match(md, /`policy-impact`=failure \(advisory\)/);
    assert.match(md, /`validate`=failure \(required\)/);
    assert.match(md, /`lint`=failure \(required\)/);
  });

  it('recordRequiredRed disarms first, then passes the flag through to the digest', async () => {
    const order = [];
    await recordRequiredRed({
      storyId: STORY,
      prNumber: 1,
      prRef: '1',
      failures: [
        { name: 'policy-impact', outcome: 'failure', required: false },
      ],
      tempRoot,
      cwd: tempRoot,
      headSha: HEAD,
      disarmFn: async () => {
        order.push('disarm');
        return { disarmed: true, detail: 'ok' };
      },
      writeDigestFn: (args) => {
        order.push('digest');
        return writeDigest(tempRoot, args.failures);
      },
    });
    assert.deepEqual(order, ['disarm', 'digest']);
    const digest = readCiDigest({ storyId: STORY, tempRoot, cwd: tempRoot });
    assert.equal(digest.allFailures[0].required, false);
  });
});

describe('classifyGreenVerdict — advisory-cleared', () => {
  const advisory = {
    headSha: HEAD,
    allFailures: [
      { name: 'policy-impact', outcome: 'failure', required: false },
    ],
  };

  it('returns advisory-cleared when the only recorded failures are advisory and now green on the same head', () => {
    const result = classifyGreenVerdict({
      digest: advisory,
      headSha: HEAD,
      checks: { 'policy-impact': 'success', validate: 'success' },
    });
    assert.equal(result.verdict, 'advisory-cleared');
    assert.match(result.reason, /`policy-impact`/);
  });

  it('keeps today’s verdict for a still-red, pending or unread advisory check', () => {
    for (const checks of [
      { 'policy-impact': 'failure' },
      { 'policy-impact': 'pending' },
      {},
      null,
      undefined,
    ]) {
      assert.equal(
        classifyGreenVerdict({ digest: advisory, headSha: HEAD, checks })
          .verdict,
        'rerun',
        JSON.stringify(checks),
      );
    }
  });

  it('never clears a required red, even with every check green', () => {
    const digest = {
      headSha: HEAD,
      allFailures: [
        { name: 'policy-impact', outcome: 'failure', required: false },
        { name: 'validate', outcome: 'failure', required: true },
      ],
    };
    const checks = { 'policy-impact': 'success', validate: 'success' };
    assert.equal(
      classifyGreenVerdict({ digest, headSha: HEAD, checks }).verdict,
      'rerun',
    );
  });

  it('reads a digest without the flag as required (pre-#5876 digests behave as before)', () => {
    const digest = {
      headSha: HEAD,
      allFailures: [{ name: 'policy-impact', outcome: 'failure' }],
    };
    assert.equal(
      classifyGreenVerdict({
        digest,
        headSha: HEAD,
        checks: { 'policy-impact': 'success' },
      }).verdict,
      'rerun',
    );
    assert.equal(
      classifyGreenVerdict({
        digest: { headSha: HEAD },
        headSha: HEAD,
        checks: {},
      }).verdict,
      'rerun',
    );
  });

  it('a recorded allowance still yields rerun-permitted when the advisory check is not cleared', () => {
    const digest = {
      ...advisory,
      rerunAllowance: { verdict: 'capacity', headSha: HEAD },
    };
    assert.equal(
      classifyGreenVerdict({ digest, headSha: HEAD, checks: {} }).verdict,
      'rerun-permitted',
    );
  });

  it('leaves the head-moved and unverifiable verdicts unchanged', () => {
    const checks = { 'policy-impact': 'success' };
    assert.equal(
      classifyGreenVerdict({ digest: advisory, headSha: 'other', checks })
        .verdict,
      'fix-at-source',
    );
    assert.equal(
      classifyGreenVerdict({ digest: advisory, headSha: null, checks }).verdict,
      'unverifiable',
    );
    assert.equal(
      classifyGreenVerdict({ digest: null, headSha: HEAD, checks }).verdict,
      'clean',
    );
  });
});

/**
 * Story #5945 — two same-name checks on one head (an earlier failed run and a
 * later green one a governance label started): the digest blames the failed
 * run, never the green one.
 */
describe('writeCiDigest — same-name check attribution', () => {
  const RUNS = 'https://github.com/o/r/actions/runs';
  let tempRoot;
  beforeEach(() => {
    tempRoot = makeTempDir('mandrel-5945-');
  });
  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

  function digestFrom(rows, failure) {
    const spawnFn = (_file, args) => ({
      status: 0,
      stdout: args[0] === 'pr' ? JSON.stringify(rows) : '',
      stderr: '',
    });
    writeCiDigest({
      storyId: STORY,
      prNumber: 1,
      headSha: HEAD,
      failures: [failure],
      tempRoot,
      cwd: tempRoot,
      prRef: '1',
      logTailFn: () => '',
      spawnFn,
    });
    return readCiDigest({ storyId: STORY, tempRoot, cwd: tempRoot });
  }

  const failedThenGreen = [
    {
      name: 'migration-guards',
      link: `${RUNS}/100/job/1`,
      bucket: 'fail',
      completedAt: '2026-11-01T10:00:00Z',
    },
    {
      name: 'migration-guards',
      link: `${RUNS}/200/job/2`,
      bucket: 'pass',
      completedAt: '2026-11-01T11:00:00Z',
    },
  ];

  it('names the failed run even when a later same-name run succeeded', () => {
    const digest = digestFrom([...failedThenGreen].reverse(), {
      name: 'migration-guards',
      outcome: 'failure',
    });
    assert.equal(digest.runId, '100');
    assert.equal(digest.runUrl, `${RUNS}/100/job/1`);
  });

  it('records the run the failure itself names over another failed same-name run', () => {
    const rows = [
      {
        name: 'migration-guards',
        link: `${RUNS}/300/job/3`,
        bucket: 'fail',
        completedAt: '2026-11-01T12:00:00Z',
      },
      ...failedThenGreen,
    ];
    const digest = digestFrom(rows, {
      name: 'migration-guards',
      outcome: 'failure',
      runId: 100,
    });
    assert.equal(digest.runId, '100');
    assert.equal(digest.runUrl, `${RUNS}/100/job/1`);
  });

  it('records nulls rather than a green run when no same-name check failed', () => {
    const digest = digestFrom([failedThenGreen[1]], {
      name: 'migration-guards',
      outcome: 'failure',
    });
    assert.equal(digest.runId, null);
    assert.equal(digest.runUrl, null);
  });

  it('admits the same-head green once a governance-label allowance is recorded', () => {
    digestFrom(failedThenGreen, {
      name: 'migration-guards',
      outcome: 'failure',
    });
    const before = readCiDigest({ storyId: STORY, tempRoot, cwd: tempRoot });
    assert.equal(
      classifyGreenVerdict({ digest: before, headSha: HEAD }).verdict,
      'rerun',
    );
    const allowance = recordRerunAllowance({
      storyId: STORY,
      verdict: 'governance-label',
      tempRoot,
      cwd: tempRoot,
      evidence: { label: 'migration:destructive-ok', actor: 'admin' },
    });
    assert.equal(allowance.evidence.label, 'migration:destructive-ok');
    const after = readCiDigest({ storyId: STORY, tempRoot, cwd: tempRoot });
    assert.equal(
      classifyGreenVerdict({ digest: after, headSha: HEAD }).verdict,
      'rerun-permitted',
    );
  });
});
