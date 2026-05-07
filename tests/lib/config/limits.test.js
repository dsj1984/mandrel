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
// Story #1047 / Task #1070 — `agentSettings.limits.signals` defaults
//
// The performance-signal taxonomy (Epic #1030) wires per-detector thresholds
// through `agentSettings.limits.signals.<detector>.<key>`. The runtime must:
//   1. Surface `SIGNALS_DEFAULTS` so detectors and the `.agentrc.json`
//      template stay in lock step.
//   2. Resolve working defaults when an operator's `.agentrc.json` omits the
//      `signals` block entirely (zero-config fallback).
//   3. Shallow-merge per-detector overrides on top of defaults so an operator
//      can re-tune a single key (e.g. `hotspot.p95Multiplier`) without
//      re-listing every other detector and key.
//   4. Reach the runtime via `getLimits(config).signals` / `getSignals(config)`
//      identically — both routes return the merged shape.
// ---------------------------------------------------------------------------

describe('SIGNALS_DEFAULTS export', () => {
  it('exports the five performance-signal detector blocks', () => {
    assert.deepEqual(Object.keys(SIGNALS_DEFAULTS).sort(), [
      'churn',
      'hotspot',
      'idle',
      'retry',
      'rework',
    ]);
  });

  it('matches the Tech Spec threshold values', () => {
    assert.equal(SIGNALS_DEFAULTS.hotspot.p95Multiplier, 1.25);
    assert.equal(SIGNALS_DEFAULTS.rework.editsPerFile, 5);
    assert.equal(SIGNALS_DEFAULTS.churn.repeatCount, 4);
    assert.equal(SIGNALS_DEFAULTS.idle.gapSeconds, 120);
    assert.equal(SIGNALS_DEFAULTS.retry.repeatCount, 3);
  });

  it('is the same frozen reference as LIMITS_DEFAULTS.signals (no drift)', () => {
    assert.equal(SIGNALS_DEFAULTS, LIMITS_DEFAULTS.signals);
    assert.equal(Object.isFrozen(SIGNALS_DEFAULTS), true);
    assert.equal(Object.isFrozen(SIGNALS_DEFAULTS.hotspot), true);
  });
});

describe('resolveLimits — signals fallback', () => {
  it('returns SIGNALS_DEFAULTS values when userLimits is undefined', () => {
    const merged = resolveLimits(undefined);
    assert.deepEqual(merged.signals, {
      hotspot: { p95Multiplier: 1.25 },
      rework: { editsPerFile: 5 },
      churn: { repeatCount: 4 },
      idle: { gapSeconds: 120 },
      retry: { repeatCount: 3 },
    });
  });

  it('returns SIGNALS_DEFAULTS values when the signals block is absent', () => {
    // Acceptance Criterion: "Removing the signals block from .agentrc.json
    // still resolves working defaults via SIGNALS_DEFAULTS."
    const merged = resolveLimits({ maxTickets: 80 });
    assert.equal(merged.signals.hotspot.p95Multiplier, 1.25);
    assert.equal(merged.signals.rework.editsPerFile, 5);
    assert.equal(merged.signals.churn.repeatCount, 4);
    assert.equal(merged.signals.idle.gapSeconds, 120);
    assert.equal(merged.signals.retry.repeatCount, 3);
  });

  it('treats a non-object signals value as missing (defaults applied)', () => {
    // Defensive: a malformed `signals: null` / `signals: 42` should not
    // crash and should not pollute the merged shape.
    const fromNull = resolveLimits({ signals: null });
    assert.equal(fromNull.signals.hotspot.p95Multiplier, 1.25);

    const fromScalar = resolveLimits({ signals: 42 });
    assert.equal(fromScalar.signals.churn.repeatCount, 4);
  });
});

describe('resolveLimits — per-detector override merge', () => {
  it('overrides a single detector key without dropping siblings', () => {
    // Acceptance Criterion: "Overriding hotspot.p95Multiplier in
    // .agentrc.json reaches the hotspot detector at runtime."
    const merged = resolveLimits({
      signals: { hotspot: { p95Multiplier: 1.5 } },
    });
    assert.equal(merged.signals.hotspot.p95Multiplier, 1.5);
    // Sibling detectors keep their defaults.
    assert.equal(merged.signals.rework.editsPerFile, 5);
    assert.equal(merged.signals.churn.repeatCount, 4);
    assert.equal(merged.signals.idle.gapSeconds, 120);
    assert.equal(merged.signals.retry.repeatCount, 3);
  });

  it('merges overrides for multiple detectors simultaneously', () => {
    const merged = resolveLimits({
      signals: {
        hotspot: { p95Multiplier: 2.0 },
        idle: { gapSeconds: 300 },
      },
    });
    assert.equal(merged.signals.hotspot.p95Multiplier, 2.0);
    assert.equal(merged.signals.idle.gapSeconds, 300);
    assert.equal(merged.signals.rework.editsPerFile, 5);
  });

  it('ignores unknown detector keys (only known detectors are merged)', () => {
    // The signals shape is a closed taxonomy; an unknown `bogus` block
    // should not bleed into the merged output, otherwise the schema and
    // resolver disagree about what the detector layer can read.
    const merged = resolveLimits({
      signals: { bogus: { foo: 1 } },
    });
    assert.equal('bogus' in merged.signals, false);
    assert.deepEqual(Object.keys(merged.signals).sort(), [
      'churn',
      'hotspot',
      'idle',
      'retry',
      'rework',
    ]);
  });

  it('returns a fresh signals object on each call (not the frozen default)', () => {
    // Callers may mutate the returned object (e.g. clone for telemetry); the
    // shared frozen `SIGNALS_DEFAULTS` reference must not leak through.
    const merged = resolveLimits({});
    assert.notEqual(merged.signals, SIGNALS_DEFAULTS);
    assert.notEqual(merged.signals.hotspot, SIGNALS_DEFAULTS.hotspot);
  });
});

describe('getLimits / getSignals accessors', () => {
  it('getLimits accepts the full resolved config shape', () => {
    const limits = getLimits({
      agentSettings: {
        limits: { signals: { hotspot: { p95Multiplier: 1.75 } } },
      },
    });
    assert.equal(limits.signals.hotspot.p95Multiplier, 1.75);
  });

  it('getLimits accepts the bare limits bag (back-compat surface)', () => {
    const limits = getLimits({
      limits: { signals: { retry: { repeatCount: 7 } } },
    });
    assert.equal(limits.signals.retry.repeatCount, 7);
  });

  it('getSignals returns the same shape as getLimits(config).signals', () => {
    const config = {
      agentSettings: {
        limits: { signals: { idle: { gapSeconds: 600 } } },
      },
    };
    assert.deepEqual(getSignals(config), getLimits(config).signals);
    assert.equal(getSignals(config).idle.gapSeconds, 600);
  });

  it('getSignals returns defaults when no config is supplied', () => {
    assert.deepEqual(getSignals(null), {
      hotspot: { p95Multiplier: 1.25 },
      rework: { editsPerFile: 5 },
      churn: { repeatCount: 4 },
      idle: { gapSeconds: 120 },
      retry: { repeatCount: 3 },
    });
    assert.deepEqual(getSignals(undefined), getSignals(null));
  });
});
