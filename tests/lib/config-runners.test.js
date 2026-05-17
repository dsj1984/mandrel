import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DECOMPOSER,
  DEFAULT_STORY_MERGE_RETRY,
  getRunners,
} from '../../.agents/scripts/lib/config/runners.js';

// Post-reshape (Epic #1720 Story #1739) only `delivery.deliverRunner` is
// configurable; the legacy `planRunner`, `concurrency`, `storyMergeRetry`,
// and `decomposer` sub-blocks moved to framework-internal constants. The
// `getRunners` accessor still returns the legacy-shaped wrapper so existing
// call sites continue to destructure without rewriting.

describe('getRunners', () => {
  it('returns defaulted shape for null/undefined/empty config', () => {
    for (const input of [null, undefined, {}, { delivery: {} }]) {
      const r = getRunners(input);
      // deliverRunner falls back to framework constants (3 / 120s).
      assert.equal(r.deliverRunner.concurrencyCap, 3);
      assert.equal(r.deliverRunner.progressReportIntervalSec, 120);
      assert.deepEqual(r.planRunner, {});
      assert.deepEqual(r.concurrency, {});
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
    assert.equal(r.deliverRunner.concurrencyCap, 5);
    assert.equal(r.deliverRunner.progressReportIntervalSec, 60);
    assert.equal(r.deliverRunner.concurrencyCapSource, 'config');
    assert.equal(r.deliverRunner.progressReportIntervalSecSource, 'config');
  });

  it('marks both deliver-runner values as default-sourced when config is absent', () => {
    const r = getRunners({});
    assert.equal(r.deliverRunner.concurrencyCapSource, 'default');
    assert.equal(r.deliverRunner.progressReportIntervalSecSource, 'default');
  });

  it('marks one field as default and the other as config when only one is overridden', () => {
    const r = getRunners({
      delivery: { deliverRunner: { progressReportIntervalSec: 30 } },
    });
    assert.equal(r.deliverRunner.concurrencyCapSource, 'default');
    assert.equal(r.deliverRunner.progressReportIntervalSecSource, 'config');
  });

  it('still reads legacy orchestration.runners.deliverRunner during the transition', () => {
    const config = {
      orchestration: {
        runners: {
          deliverRunner: { concurrencyCap: 2, progressReportIntervalSec: 30 },
        },
      },
    };
    const r = getRunners(config);
    assert.equal(r.deliverRunner.concurrencyCap, 2);
    assert.equal(r.deliverRunner.progressReportIntervalSec, 30);
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
});
