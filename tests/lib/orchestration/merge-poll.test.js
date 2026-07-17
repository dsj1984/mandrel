/**
 * tests/lib/orchestration/merge-poll.test.js
 *
 * Unit coverage for the close path's check-rollup derivation.
 *
 * `failingChecksBlockMerge` is the required-vs-optional discriminator the
 * rollup itself cannot provide. The bug it exists to prevent: the #4543
 * merge fail-fast treated ANY red check as terminal, so a red optional check
 * (or a CANCELLED superseded workflow run) flipped the Story to
 * `agent::blocked` while GitHub native auto-merge — which gates only on
 * REQUIRED checks — landed the PR anyway, leaving a merged-but-blocked strand
 * only an operator could unpick.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  deriveChecksStatus,
  failingChecksBlockMerge,
} from '../../../.agents/scripts/lib/orchestration/merge-poll.js';

describe('deriveChecksStatus', () => {
  it('reports failure for a red check regardless of whether it is required', () => {
    assert.equal(
      deriveChecksStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
      'failure',
    );
  });

  it('counts a CANCELLED (e.g. superseded) run as a failure', () => {
    assert.equal(
      deriveChecksStatus([{ status: 'COMPLETED', conclusion: 'CANCELLED' }]),
      'failure',
    );
  });

  it('reports still-running while any check is incomplete', () => {
    assert.equal(
      deriveChecksStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS' },
      ]),
      'still-running',
    );
  });

  it('reports success when every check completed green', () => {
    assert.equal(
      deriveChecksStatus([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      'success',
    );
  });

  it('reports unknown for an empty or non-array rollup (checks-less repo)', () => {
    assert.equal(deriveChecksStatus([]), 'unknown');
    assert.equal(deriveChecksStatus(undefined), 'unknown');
  });
});

describe('failingChecksBlockMerge', () => {
  it('is true for a red check GitHub reports as BLOCKED (a required check)', () => {
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'BLOCKED',
      }),
      true,
    );
  });

  it('is false for a red check on an UNSTABLE PR — mergeable with non-passing checks', () => {
    // The live bug: auto-merge lands this PR. Failing fast on it strands the
    // Story agent::blocked on a merged PR.
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'UNSTABLE',
      }),
      false,
    );
  });

  it('is false when the merge state is unknown or absent (degrade to waiting)', () => {
    assert.equal(failingChecksBlockMerge({ checksStatus: 'failure' }), false);
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'UNKNOWN',
      }),
      false,
    );
  });

  it('is false for a CLEAN or BEHIND PR carrying a red check', () => {
    for (const mergeStateStatus of ['CLEAN', 'BEHIND']) {
      assert.equal(
        failingChecksBlockMerge({ checksStatus: 'failure', mergeStateStatus }),
        false,
        `${mergeStateStatus} must not read as a required-check block`,
      );
    }
  });

  it('is false whenever the checks are not red, whatever the merge state', () => {
    for (const checksStatus of [
      'success',
      'pending',
      'still-running',
      'unknown',
      undefined,
    ]) {
      assert.equal(
        failingChecksBlockMerge({ checksStatus, mergeStateStatus: 'BLOCKED' }),
        false,
        `checksStatus=${checksStatus} is not a red check`,
      );
    }
  });

  it('is false for a missing probe', () => {
    assert.equal(failingChecksBlockMerge(undefined), false);
    assert.equal(failingChecksBlockMerge(null), false);
  });

  it('accepts a lowercase merge state (defensive against gh projection drift)', () => {
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'blocked',
      }),
      true,
    );
  });
});
