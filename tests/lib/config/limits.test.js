import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLimits,
  getSignals,
  LIMITS_DEFAULTS,
  resolveLimits,
  SIGNALS_DEFAULTS,
} from '../../../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Post-reshape (Epic #1720 Story #1739) — the signals taxonomy is trimmed
// to three detectors (hotspot, rework, retry) and reads from
// `delivery.signals.*`. The legacy `agentSettings.limits.signals` location
// is gone. Other limits move:
//   - planning.maxTickets / planning.context.{maxBytes,summaryMode}
//   - delivery.maxTokenBudget / delivery.execution.timeoutMs
//
// `getLimits(config)` accepts the resolved-config wrapper and surfaces the
// surviving subset; `getSignals(config)` is the shorthand for
// `getLimits(config).signals`.
// ---------------------------------------------------------------------------

describe('SIGNALS_DEFAULTS export', () => {
  it('exports only the three surviving detector blocks', () => {
    assert.deepEqual(Object.keys(SIGNALS_DEFAULTS).sort(), [
      'hotspot',
      'retry',
      'rework',
    ]);
  });

  it('matches the Tech Spec threshold values', () => {
    assert.equal(SIGNALS_DEFAULTS.hotspot.p95Multiplier, 1.25);
    assert.equal(SIGNALS_DEFAULTS.rework.editsPerFile, 5);
    assert.equal(SIGNALS_DEFAULTS.retry.repeatCount, 3);
  });

  it('is the same frozen reference as LIMITS_DEFAULTS.signals (no drift)', () => {
    assert.equal(SIGNALS_DEFAULTS, LIMITS_DEFAULTS.signals);
    assert.equal(Object.isFrozen(SIGNALS_DEFAULTS), true);
    assert.equal(Object.isFrozen(SIGNALS_DEFAULTS.hotspot), true);
  });
});

describe('resolveLimits — signals fallback', () => {
  it('returns SIGNALS_DEFAULTS values when config is undefined', () => {
    const merged = resolveLimits(undefined);
    assert.deepEqual(merged.signals, {
      hotspot: { p95Multiplier: 1.25 },
      rework: { editsPerFile: 5 },
      retry: { repeatCount: 3 },
    });
  });

  it('returns SIGNALS_DEFAULTS values when delivery.signals is absent', () => {
    const merged = resolveLimits({
      planning: { maxTickets: 80 },
      delivery: {},
    });
    assert.equal(merged.signals.hotspot.p95Multiplier, 1.25);
    assert.equal(merged.signals.rework.editsPerFile, 5);
    assert.equal(merged.signals.retry.repeatCount, 3);
  });

  it('treats a non-object signals value as missing (defaults applied)', () => {
    const fromNull = resolveLimits({ delivery: { signals: null } });
    assert.equal(fromNull.signals.hotspot.p95Multiplier, 1.25);

    const fromScalar = resolveLimits({ delivery: { signals: 42 } });
    assert.equal(fromScalar.signals.retry.repeatCount, 3);
  });
});

describe('resolveLimits — per-detector override merge', () => {
  it('overrides a single detector key without dropping siblings', () => {
    const merged = resolveLimits({
      delivery: { signals: { hotspot: { p95Multiplier: 1.5 } } },
    });
    assert.equal(merged.signals.hotspot.p95Multiplier, 1.5);
    assert.equal(merged.signals.rework.editsPerFile, 5);
    assert.equal(merged.signals.retry.repeatCount, 3);
  });

  it('merges overrides for multiple detectors simultaneously', () => {
    const merged = resolveLimits({
      delivery: {
        signals: {
          hotspot: { p95Multiplier: 2.0 },
          retry: { repeatCount: 7 },
        },
      },
    });
    assert.equal(merged.signals.hotspot.p95Multiplier, 2.0);
    assert.equal(merged.signals.retry.repeatCount, 7);
    assert.equal(merged.signals.rework.editsPerFile, 5);
  });

  it('ignores unknown detector keys (closed taxonomy)', () => {
    const merged = resolveLimits({
      delivery: { signals: { bogus: { foo: 1 } } },
    });
    assert.equal('bogus' in merged.signals, false);
    assert.deepEqual(Object.keys(merged.signals).sort(), [
      'hotspot',
      'retry',
      'rework',
    ]);
  });

  it('returns a fresh signals object on each call (not the frozen default)', () => {
    const merged = resolveLimits({});
    assert.notEqual(merged.signals, SIGNALS_DEFAULTS);
    assert.notEqual(merged.signals.hotspot, SIGNALS_DEFAULTS.hotspot);
  });
});

describe('resolveLimits — surviving budget surface', () => {
  it('reads planning.maxTickets', () => {
    const lim = resolveLimits({ planning: { maxTickets: 99 } });
    assert.equal(lim.maxTickets, 99);
  });

  it('reads delivery.maxTokenBudget + execution.timeoutMs', () => {
    const lim = resolveLimits({
      delivery: { maxTokenBudget: 50000, execution: { timeoutMs: 1234 } },
    });
    assert.equal(lim.maxTokenBudget, 50000);
    assert.equal(lim.executionTimeoutMs, 1234);
  });

  it('applies defaults when fields are absent', () => {
    const lim = resolveLimits({});
    assert.equal(lim.maxTickets, LIMITS_DEFAULTS.maxTickets);
    assert.equal(lim.maxTokenBudget, LIMITS_DEFAULTS.maxTokenBudget);
    assert.equal(lim.executionTimeoutMs, LIMITS_DEFAULTS.executionTimeoutMs);
  });
});

describe('getLimits / getSignals accessors (post-reshape)', () => {
  it('getLimits reads delivery.signals from the new top-level shape', () => {
    const limits = getLimits({
      delivery: { signals: { hotspot: { p95Multiplier: 1.75 } } },
    });
    assert.equal(limits.signals.hotspot.p95Multiplier, 1.75);
  });

  it('getSignals returns the same shape as getLimits(config).signals', () => {
    const config = {
      delivery: { signals: { retry: { repeatCount: 12 } } },
    };
    assert.deepEqual(getSignals(config), getLimits(config).signals);
    assert.equal(getSignals(config).retry.repeatCount, 12);
  });

  it('getSignals returns defaults when no config is supplied', () => {
    assert.deepEqual(getSignals(null), {
      hotspot: { p95Multiplier: 1.25 },
      rework: { editsPerFile: 5 },
      retry: { repeatCount: 3 },
    });
    assert.deepEqual(getSignals(undefined), getSignals(null));
  });
});
