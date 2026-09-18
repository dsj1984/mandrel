import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLimits,
  LIMITS_DEFAULTS,
} from '../../../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Post-reshape (Epic #1720 Story #1739) — the surviving limit was
// `delivery.execution.timeoutMs`, and Story #5382 folded that never-set key
// into the fixed `LIMITS_DEFAULTS.executionTimeoutMs`.
//
// `planning.context.{maxBytes,summaryMode}` was removed in Story #4541,
// `maxTickets` in Story #5312, and `delivery.signals.{rework, retry}` with
// `SIGNALS_DEFAULTS` / `getSignals` in Story #5313 (the delivery diet):
// `getLimits` neither reads nor returns any of them.
// ---------------------------------------------------------------------------

describe('LIMITS_DEFAULTS export', () => {
  it('carries only the execution timeout — the signals block is retired', () => {
    assert.deepEqual(Object.keys(LIMITS_DEFAULTS), ['executionTimeoutMs']);
    assert.equal(Object.isFrozen(LIMITS_DEFAULTS), true);
  });
});

describe('getLimits — the fixed budget surface', () => {
  it('returns the constant and omits the retired maxTokenBudget', () => {
    const lim = getLimits({
      delivery: { maxTokenBudget: 50000, execution: { timeoutMs: 1234 } },
    });
    assert.equal('maxTokenBudget' in lim, false);
    assert.equal(
      lim.executionTimeoutMs,
      LIMITS_DEFAULTS.executionTimeoutMs,
      'a leftover execution.timeoutMs tunes nothing (Story #5382)',
    );
  });

  it('ignores a leftover delivery.signals block rather than resolving it (Story #5313)', () => {
    const lim = getLimits({
      delivery: { signals: { rework: { editsPerFile: 7 } } },
    });
    assert.equal('signals' in lim, false);
  });

  it('answers null, undefined and malformed configs alike', () => {
    for (const config of [null, undefined, { delivery: 42 }]) {
      assert.equal(getLimits(config).executionTimeoutMs, 600000);
    }
  });
});
