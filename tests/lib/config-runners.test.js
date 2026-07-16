import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DECOMPOSER,
  DEFAULT_STORY_MERGE_RETRY,
  getRunners,
} from '../../.agents/scripts/lib/config/runners.js';

// Post-reshape (Epic #1720 Story #1739) only `delivery.deliverRunner` and
// `delivery.codeReview` are configurable via getRunners; `delivery.epicAudit`
// was removed on v2 (Story-only delivery). Legacy `planRunner`,
// `concurrency`, `storyMergeRetry`, and `decomposer` sub-blocks moved to
// framework-internal constants.

describe('getRunners', () => {
  it('returns defaulted shape for null/undefined/empty config', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      assert.equal(r.deliverRunner.concurrencyCap, 3);
      assert.equal(r.storyMergeRetry, DEFAULT_STORY_MERGE_RETRY);
      assert.equal(r.decomposer, DEFAULT_DECOMPOSER);
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

  it('exposes the hardcoded story-merge-retry defaults', () => {
    const r = getRunners({});
    assert.equal(r.storyMergeRetry.maxAttempts, 3);
    assert.deepEqual([...r.storyMergeRetry.backoffMs], [250, 500, 1000]);
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
