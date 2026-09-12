import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLimits,
  LIMITS_DEFAULTS,
  resolveLimits,
} from '../../../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Post-reshape (Epic #1720 Story #1739) — the surviving limit is
// `delivery.execution.timeoutMs`.
//
// `planning.context.{maxBytes,summaryMode}` was removed in Story #4541,
// `maxTickets` in Story #5312, and `delivery.signals.{rework, retry}` with
// `SIGNALS_DEFAULTS` / `getSignals` in Story #5313 (the delivery diet):
// `resolveLimits` neither reads nor returns any of them.
// ---------------------------------------------------------------------------

describe('LIMITS_DEFAULTS export', () => {
  it('carries only the execution timeout — the signals block is retired', () => {
    assert.deepEqual(Object.keys(LIMITS_DEFAULTS), ['executionTimeoutMs']);
    assert.equal(Object.isFrozen(LIMITS_DEFAULTS), true);
  });
});

describe('resolveLimits — surviving budget surface', () => {
  it('reads delivery.execution.timeoutMs and omits the retired maxTokenBudget', () => {
    const lim = resolveLimits({
      delivery: { maxTokenBudget: 50000, execution: { timeoutMs: 1234 } },
    });
    assert.equal('maxTokenBudget' in lim, false);
    assert.equal(lim.executionTimeoutMs, 1234);
  });

  it('applies defaults when fields are absent', () => {
    const lim = resolveLimits({});
    assert.equal(lim.executionTimeoutMs, LIMITS_DEFAULTS.executionTimeoutMs);
  });

  it('ignores a leftover delivery.signals block rather than resolving it (Story #5313)', () => {
    const lim = resolveLimits({
      delivery: { signals: { rework: { editsPerFile: 7 } } },
    });
    assert.equal('signals' in lim, false);
  });

  it('treats a non-object delivery / execution as absent', () => {
    assert.equal(
      resolveLimits({ delivery: 42 }).executionTimeoutMs,
      LIMITS_DEFAULTS.executionTimeoutMs,
    );
    assert.equal(
      resolveLimits({ delivery: { execution: null } }).executionTimeoutMs,
      LIMITS_DEFAULTS.executionTimeoutMs,
    );
  });
});

describe('getLimits accessor (post-reshape)', () => {
  it('reads the resolved-config wrapper and null/undefined alike', () => {
    assert.equal(
      getLimits({ delivery: { execution: { timeoutMs: 99 } } })
        .executionTimeoutMs,
      99,
    );
    assert.deepEqual(getLimits(null), getLimits(undefined));
    assert.equal(getLimits(null).executionTimeoutMs, 600000);
  });
});
