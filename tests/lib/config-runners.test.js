import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DECOMPOSER,
  getRunners,
} from '../../.agents/scripts/lib/config/runners.js';

// Post-reshape (Epic #1720 Story #1739) only `delivery.deliverRunner` and
// `delivery.codeReview` are configurable via getRunners; `delivery.epicAudit`
// was removed on v2 (Story-only delivery). Legacy `planRunner`,
// `concurrency` and `decomposer` sub-blocks moved to framework-internal
// constants. `storyMergeRetry` went with `push-epic-retry.js`: the v2
// cutover deleted its only consumer (the bounded retry on the epic-branch
// push), leaving a policy nothing could apply.

describe('getRunners', () => {
  it('returns defaulted shape for null/undefined/empty config', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      assert.equal(r.deliverRunner.concurrencyCap, 3);
      assert.equal(r.decomposer, DEFAULT_DECOMPOSER);
      assert.equal(r.storyMergeRetry, undefined);
      assert.equal(r.epicAudit, undefined);
    }
  });

  it('reads delivery.deliverRunner from the post-reshape config', () => {
    const config = {
      delivery: {
        deliverRunner: { concurrencyCap: 5 },
      },
    };
    const r = getRunners(config);
    assert.deepEqual(r.deliverRunner, {
      concurrencyCap: 5,
    });
  });

  it('ignores legacy orchestration.runners.deliverRunner (hard cutover)', () => {
    const config = {
      orchestration: {
        runners: {
          deliverRunner: { concurrencyCap: 2 },
        },
      },
    };
    const r = getRunners(config);
    assert.equal(r.deliverRunner.concurrencyCap, 3);
  });

  it('exposes the hardcoded decomposer concurrency cap', () => {
    const r = getRunners({});
    assert.equal(r.decomposer.concurrencyCap, 3);
  });

  it('returns documented defaults for delivery.codeReview (Story #2611)', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      assert.deepEqual(r.codeReview, {
        maxFixAttempts: 3,
        maxFixScopeFiles: 5,
        autoFixSeverity: 'medium',
      });
    }
  });

  it('reads delivery.codeReview overrides from config', () => {
    const r = getRunners({
      delivery: { codeReview: { maxFixAttempts: 0, maxFixScopeFiles: 2 } },
    });
    assert.deepEqual(r.codeReview, {
      maxFixAttempts: 0,
      maxFixScopeFiles: 2,
      autoFixSeverity: 'medium',
    });
  });

  it('reads delivery.codeReview.autoFixSeverity override (Story #4399)', () => {
    const r = getRunners({
      delivery: { codeReview: { autoFixSeverity: 'high' } },
    });
    assert.equal(r.codeReview.autoFixSeverity, 'high');
  });
});
