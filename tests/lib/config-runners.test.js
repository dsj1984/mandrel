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
      // The footprint guard defaults to enforce and stays there: it encodes
      // delivery-time-only knowledge no depends_on edge carries (Story #5044).
      assert.equal(r.deliverRunner.footprintGuard, 'enforce');
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
      footprintGuard: 'enforce',
    });
  });

  it('reads an operator-set footprintGuard, leaving the cap defaulted', () => {
    const r = getRunners({
      delivery: { deliverRunner: { footprintGuard: 'advisory' } },
    });
    assert.deepEqual(r.deliverRunner, {
      concurrencyCap: 3,
      footprintGuard: 'advisory',
    });
  });

  it('keeps the returned shape closed over the framework defaults', () => {
    // A key the framework does not define must not reach a consumer through
    // here, so a stray entry degrades to the defaults rather than to an
    // undefined a caller would read as configuration.
    const r = getRunners({
      delivery: { deliverRunner: { concurrencyCap: 4, nope: true } },
    });
    assert.deepEqual(r.deliverRunner, {
      concurrencyCap: 4,
      footprintGuard: 'enforce',
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
        autoFixSeverity: 'medium',
      });
    }
  });

  it('reads delivery.codeReview overrides from config', () => {
    const r = getRunners({
      delivery: { codeReview: { maxFixAttempts: 0 } },
    });
    assert.deepEqual(r.codeReview, {
      maxFixAttempts: 0,
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
