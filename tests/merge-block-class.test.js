/**
 * tests/merge-block-class.test.js — Story #4426 (Epic #4425, slice 1).
 *
 * Table-driven coverage for the shared block-class classifier
 * (`.agents/scripts/lib/orchestration/merge-block-class.js`). Every
 * table case exercises `classifyMergeBlock` with representative
 * arm-result / PR-probe / budget inputs and asserts the resulting
 * `blockClass` — one test case per canonical class, plus edge cases that
 * pin the documented evaluation order (arm failure checked before the
 * PR probe; a branch-protection marker in the arm reason still routes to
 * `branch-protection-human-required` rather than the generic
 * `arm-failure`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BLOCK_CLASSES,
  classifyMergeBlock,
  isValidBlockClass,
  MERGE_UNLANDED_BLOCK_CLASSES,
} from '../.agents/scripts/lib/orchestration/merge-block-class.js';

describe('merge-block-class (Story #4426)', () => {
  it('BLOCK_CLASSES names exactly the four classes from the Epic #4425 Goal', () => {
    assert.deepEqual(BLOCK_CLASSES, [
      'checks-pending-timeout',
      'branch-protection-human-required',
      'arm-failure',
      'api-race-other',
    ]);
  });

  it('isValidBlockClass recognises the full merge.unlanded attribution set', () => {
    for (const cls of MERGE_UNLANDED_BLOCK_CLASSES) {
      assert.equal(isValidBlockClass(cls), true);
    }
    assert.equal(isValidBlockClass('not-a-real-class'), false);
    assert.equal(isValidBlockClass(undefined), false);
  });

  it('predicate-refused is a valid attribution but NOT a classifyMergeBlock output (Story #4472)', () => {
    // It is emitted directly by the AutomergePredicate / AutomergeArmer for a
    // headless refusal that never reached the poll-exhaustion classifier.
    assert.equal(isValidBlockClass('predicate-refused'), true);
    assert.equal(BLOCK_CLASSES.includes('predicate-refused'), false);
    assert.equal(
      MERGE_UNLANDED_BLOCK_CLASSES.includes('predicate-refused'),
      true,
    );
  });

  const cases = [
    {
      name: 'arm call failed for a generic reason → arm-failure',
      input: {
        armResult: { armed: false, reason: 'gh: rate limit exceeded' },
      },
      expected: 'arm-failure',
    },
    {
      name: 'arm call rejected by gh stderr mentioning review requirement → branch-protection-human-required',
      input: {
        armResult: {
          armed: false,
          reason:
            'GraphQL: Pull request Approving review required (mergePullRequest)',
        },
      },
      expected: 'branch-protection-human-required',
    },
    {
      name: 'arm call rejected citing required_status_checks → branch-protection-human-required',
      input: {
        armResult: {
          armed: false,
          error: 'required_status_checks configuration blocks this merge',
        },
      },
      expected: 'branch-protection-human-required',
    },
    {
      name: 'PR probe reports REVIEW_REQUIRED with a successful arm → branch-protection-human-required',
      input: {
        armResult: { armed: true },
        prProbe: {
          reviewDecision: 'REVIEW_REQUIRED',
          mergeStateStatus: 'BLOCKED',
        },
      },
      expected: 'branch-protection-human-required',
    },
    {
      name: 'PR probe reports mergeStateStatus BLOCKED alone → branch-protection-human-required',
      input: {
        prProbe: { mergeStateStatus: 'BLOCKED' },
      },
      expected: 'branch-protection-human-required',
    },
    {
      // Protected-branch steady state: GitHub reports BLOCKED for the
      // entire time required checks run, so a budget exhaustion with
      // positive checks-in-flight evidence MUST classify as the timeout
      // (headless budget extension), never human-required. Regression
      // pin for the classifier-ordering fix.
      name: 'budget exhausted with BLOCKED merge state and checks still pending → checks-pending-timeout',
      input: {
        prProbe: { mergeStateStatus: 'BLOCKED', checksStatus: 'pending' },
        budget: { exhausted: true, elapsedSeconds: 3600 },
      },
      expected: 'checks-pending-timeout',
    },
    {
      // BLOCKED with settled checks is a genuinely human gate (e.g. a
      // missing required approval) even at budget exhaustion.
      name: 'budget exhausted with BLOCKED merge state and checks settled → branch-protection-human-required',
      input: {
        prProbe: { mergeStateStatus: 'BLOCKED', checksStatus: 'success' },
        budget: { exhausted: true, elapsedSeconds: 3600 },
      },
      expected: 'branch-protection-human-required',
    },
    {
      name: 'watch budget exhausted with checks still pending → checks-pending-timeout',
      input: {
        armResult: { armed: true },
        prProbe: { checksStatus: 'pending' },
        budget: { exhausted: true, elapsedSeconds: 3600 },
      },
      expected: 'checks-pending-timeout',
    },
    {
      name: 'watch budget exhausted with checks still-running (no checksStatus reread) → checks-pending-timeout',
      input: {
        prProbe: { checksStatus: 'still-running' },
        budget: { exhausted: true, elapsedSeconds: 1800 },
      },
      expected: 'checks-pending-timeout',
    },
    {
      name: 'watch budget exhausted with no PR probe at all → checks-pending-timeout (undefined checksStatus)',
      input: {
        budget: { exhausted: true, elapsedSeconds: 900 },
      },
      expected: 'checks-pending-timeout',
    },
    {
      name: 'PR probe surfaces a transient API error → api-race-other',
      input: {
        prProbe: { error: 'ETIMEDOUT reaching api.github.com' },
      },
      expected: 'api-race-other',
    },
    {
      name: 'budget exhausted but checks already failed (not pending) → api-race-other',
      input: {
        prProbe: { checksStatus: 'failure' },
        budget: { exhausted: true, elapsedSeconds: 120 },
      },
      expected: 'api-race-other',
    },
    {
      name: 'no signals at all → api-race-other fallback',
      input: {},
      expected: 'api-race-other',
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      const verdict = classifyMergeBlock(input);
      assert.equal(verdict.blockClass, expected);
      assert.equal(isValidBlockClass(verdict.blockClass), true);
      assert.equal(typeof verdict.reason, 'string');
      assert.ok(verdict.reason.length > 0);
    });
  }

  it('every canonical block class is reachable from at least one table case', () => {
    const produced = new Set(
      cases.map((c) => classifyMergeBlock(c.input).blockClass),
    );
    for (const cls of BLOCK_CLASSES) {
      assert.ok(
        produced.has(cls),
        `no table case produced blockClass "${cls}"`,
      );
    }
  });

  it('arm failure is evaluated before the PR probe (evaluation-order pin)', () => {
    const verdict = classifyMergeBlock({
      armResult: { armed: false, reason: 'network error contacting gh' },
      // Even though the probe alone would classify as human-required,
      // the failed arm takes precedence: the reason text carries no
      // branch-protection marker, so this stays a generic arm-failure
      // rather than being reclassified from the probe.
      prProbe: { reviewDecision: 'REVIEW_REQUIRED' },
    });
    assert.equal(verdict.blockClass, 'arm-failure');
  });
});
