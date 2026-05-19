import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DECOMPOSER,
  DEFAULT_STORY_MERGE_RETRY,
  getRunners,
} from '../../.agents/scripts/lib/config/runners.js';

// Post-reshape (Epic #1720 Story #1739) only `delivery.deliverRunner`,
// `delivery.epicAudit`, and `delivery.codeReview` are configurable; the
// legacy `planRunner`, `concurrency`, `storyMergeRetry`, and `decomposer`
// sub-blocks moved to framework-internal constants. Story #2687 dropped
// the legacy `config.deliverRunner` / `config.orchestration.runners.*`
// fallback reads — `delivery.deliverRunner` is the only supported shape.

describe('getRunners', () => {
  it('returns defaulted shape for null/undefined/empty config', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      // deliverRunner falls back to framework constants (3 / 120s).
      assert.equal(r.deliverRunner.concurrencyCap, 3);
      assert.equal(r.deliverRunner.progressReportIntervalSec, 120);
      assert.equal(r.storyMergeRetry, DEFAULT_STORY_MERGE_RETRY);
      assert.equal(r.decomposer, DEFAULT_DECOMPOSER);
    }
  });

  it('reads delivery.deliverRunner from the post-reshape config', () => {
    const config = {
      delivery: {
        deliverRunner: { concurrencyCap: 5, progressReportIntervalSec: 60 },
      },
    };
    const r = getRunners(config);
    assert.deepEqual(r.deliverRunner, {
      concurrencyCap: 5,
      progressReportIntervalSec: 60,
    });
  });

  it('ignores legacy orchestration.runners.deliverRunner (hard cutover)', () => {
    const config = {
      orchestration: {
        runners: {
          deliverRunner: { concurrencyCap: 2, progressReportIntervalSec: 30 },
        },
      },
    };
    const r = getRunners(config);
    // Legacy reads dropped: fall through to framework defaults.
    assert.equal(r.deliverRunner.concurrencyCap, 3);
    assert.equal(r.deliverRunner.progressReportIntervalSec, 120);
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

  it('returns documented defaults for delivery.epicAudit (Story #2611)', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      assert.deepEqual(r.epicAudit, { maxFixAttempts: 3, maxFixScopeFiles: 5 });
    }
  });

  it('returns documented defaults for delivery.codeReview (Story #2611)', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      assert.deepEqual(r.codeReview, {
        maxFixAttempts: 3,
        maxFixScopeFiles: 5,
      });
    }
  });

  it('reads delivery.epicAudit overrides from config', () => {
    const r = getRunners({
      delivery: { epicAudit: { maxFixAttempts: 1, maxFixScopeFiles: 10 } },
    });
    assert.deepEqual(r.epicAudit, { maxFixAttempts: 1, maxFixScopeFiles: 10 });
  });

  it('reads delivery.codeReview overrides from config', () => {
    const r = getRunners({
      delivery: { codeReview: { maxFixAttempts: 0, maxFixScopeFiles: 2 } },
    });
    assert.deepEqual(r.codeReview, { maxFixAttempts: 0, maxFixScopeFiles: 2 });
  });
});
