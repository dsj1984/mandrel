import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITS_DEFAULTS } from '../../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Post-reshape drift guard (Epic #1720 Story #1739).
//
// The surviving budget/timeout keys are spread across the new top-level
// blocks rather than a single `agentSettings.limits` block:
//   - planning.maxTickets
//   - planning.context.{maxBytes, summaryMode}
//   - delivery.maxTokenBudget
//   - delivery.execution.timeoutMs
//   - delivery.signals.{hotspot, rework, retry}
//
// This guard keeps `.agents/default-agentrc.json` aligned with
// `LIMITS_DEFAULTS` so consumers who bootstrap from the template inherit
// the same values the resolver would otherwise compute.
// ---------------------------------------------------------------------------

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../.agents/default-agentrc.json', import.meta.url),
);

describe('default-agentrc.json ↔ LIMITS_DEFAULTS drift guard', () => {
  const parsed = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));

  it('declares planning.maxTickets matching LIMITS_DEFAULTS.maxTickets', () => {
    assert.equal(parsed?.planning?.maxTickets, LIMITS_DEFAULTS.maxTickets);
  });

  it('declares planning.context matching LIMITS_DEFAULTS.planningContext', () => {
    assert.deepEqual(parsed?.planning?.context, {
      ...LIMITS_DEFAULTS.planningContext,
    });
  });

  it('declares delivery.maxTokenBudget matching LIMITS_DEFAULTS.maxTokenBudget', () => {
    assert.equal(
      parsed?.delivery?.maxTokenBudget,
      LIMITS_DEFAULTS.maxTokenBudget,
    );
  });

  it('declares delivery.execution.timeoutMs matching LIMITS_DEFAULTS.executionTimeoutMs', () => {
    assert.equal(
      parsed?.delivery?.execution?.timeoutMs,
      LIMITS_DEFAULTS.executionTimeoutMs,
    );
  });

  it('declares the three surviving detector blocks under delivery.signals', () => {
    const sig = parsed?.delivery?.signals;
    assert.ok(sig, 'delivery.signals must be present');
    assert.deepEqual(Object.keys(sig).sort(), ['hotspot', 'retry', 'rework']);
    assert.equal(
      sig.hotspot.p95Multiplier,
      LIMITS_DEFAULTS.signals.hotspot.p95Multiplier,
    );
    assert.equal(
      sig.rework.editsPerFile,
      LIMITS_DEFAULTS.signals.rework.editsPerFile,
    );
    assert.equal(
      sig.retry.repeatCount,
      LIMITS_DEFAULTS.signals.retry.repeatCount,
    );
  });
});
