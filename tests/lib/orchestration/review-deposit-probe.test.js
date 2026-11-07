import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReviewDeposit,
  computeReviewDiffDigest,
  probeHeldReviewDiff,
} from '../../../.agents/scripts/lib/orchestration/review-deposit.js';

const SHA = 'a'.repeat(40);
const gitSpawnFn = (_cwd, verb) =>
  verb === 'diff'
    ? { status: 0, stdout: 'diff --git a/x b/x\n+line\n' }
    : { status: 0, stdout: 'f'.repeat(40) };

const digest = computeReviewDiffDigest({
  cwd: '/nowhere',
  baseRef: 'origin/main',
  headRef: SHA,
  gitSpawnFn,
});

function probe(result) {
  const held = buildReviewDeposit({
    storyId: 7,
    headSha: SHA,
    baseRef: 'origin/main',
    diffDigest: digest,
    result: { severity: { critical: 0 }, ...result },
  });
  return probeHeldReviewDiff({
    cwd: '/nowhere',
    storyId: 7,
    sha: SHA,
    baseBranch: 'main',
    gitSpawnFn,
    readDepositFn: () => held,
  }).deposit;
}

describe('probeHeldReviewDiff — which matching deposits are adopted', () => {
  it('never adopts a no-verdict halt, so the reviewer is retried', () => {
    assert.ok(digest);
    assert.equal(
      probe({ halted: true, haltCause: 'no-verdict', degraded: true }),
      null,
    );
  });

  it('adopts a context-reduced (degraded, not halted) deposit', () => {
    assert.equal(probe({ degraded: true }).degraded, true);
  });

  it('adopts a critical halt', () => {
    assert.equal(
      probe({ halted: true, haltCause: 'critical' }).haltCause,
      'critical',
    );
  });
});
