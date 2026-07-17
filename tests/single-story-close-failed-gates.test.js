/**
 * tests/single-story-close-failed-gates.test.js
 *
 * The terminal schema's `gates` contract: "A gate the run skipped … reports
 * `skipped` rather than being omitted, so a missing gate is never mistaken
 * for a passing one."
 *
 * The failed-terminal builder used to name ONLY the gate that died and omit
 * the other two entirely — exactly the ambiguity the contract forbids. A
 * reader of a base-sync failure could not tell whether validation had passed
 * or had never run.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gatesForFailedPhase } from '../.agents/scripts/single-story-close.js';

const ALL_GATES = ['validation', 'baseSync', 'codeReview'];
const OUTCOMES = new Set(['passed', 'failed', 'skipped']);

describe('gatesForFailedPhase', () => {
  it('always reports every gate, whatever phase died', () => {
    for (const phase of [
      'init',
      'wrong-tree-guard',
      'close-validation',
      'base-sync',
      'push',
      'pull-request',
      'code-review',
      'auto-merge',
      'confirm-merge',
      'post-land',
    ]) {
      const gates = gatesForFailedPhase(phase, {});
      assert.deepEqual(
        Object.keys(gates).sort(),
        [...ALL_GATES].sort(),
        `phase ${phase} must report every gate`,
      );
      for (const [gate, outcome] of Object.entries(gates)) {
        assert.ok(
          OUTCOMES.has(outcome),
          `${gate}=${outcome} is not a schema outcome`,
        );
      }
    }
  });

  it('names the dead gate failed and leaves later gates skipped, not passed', () => {
    assert.deepEqual(gatesForFailedPhase('close-validation', {}), {
      validation: 'failed',
      baseSync: 'skipped',
      codeReview: 'skipped',
    });
  });

  it('reports gates the run had already cleared as passed', () => {
    // Reaching code-review means validation and base-sync completed — the
    // pipeline is strictly sequential.
    assert.deepEqual(gatesForFailedPhase('code-review', {}), {
      validation: 'passed',
      baseSync: 'passed',
      codeReview: 'failed',
    });
  });

  it('reports an operator-disabled gate as skipped, never passed', () => {
    assert.deepEqual(
      gatesForFailedPhase('code-review', {
        skipValidation: true,
        skipSync: true,
      }),
      { validation: 'skipped', baseSync: 'skipped', codeReview: 'failed' },
    );
  });

  it('reports every gate skipped when the run died before any of them', () => {
    assert.deepEqual(gatesForFailedPhase('init', {}), {
      validation: 'skipped',
      baseSync: 'skipped',
      codeReview: 'skipped',
    });
  });

  it('marks post-arm phases as having cleared all three gates', () => {
    assert.deepEqual(gatesForFailedPhase('confirm-merge', {}), {
      validation: 'passed',
      baseSync: 'passed',
      codeReview: 'passed',
    });
  });

  it('degrades to all-skipped for an unrecognised phase rather than claiming passes', () => {
    assert.deepEqual(gatesForFailedPhase('not-a-phase', {}), {
      validation: 'skipped',
      baseSync: 'skipped',
      codeReview: 'skipped',
    });
  });
});
