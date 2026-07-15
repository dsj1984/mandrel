import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITS_DEFAULTS } from '../../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Post-reshape drift guard (Epic #1720 Story #1739).
//
// The surviving operator-configurable budget/timeout keys are spread across
// the new top-level blocks rather than a single `agentSettings.limits` block:
//   - planning.context.{maxBytes, summaryMode}
//   - delivery.maxTokenBudget
//   - delivery.execution.timeoutMs
//   - delivery.signals.{rework, retry}
//
// This guard keeps `.agents/docs/agentrc-reference.json` aligned with
// `LIMITS_DEFAULTS` so the exhaustive reference template documents the
// same values the resolver would otherwise compute.
// ---------------------------------------------------------------------------

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../.agents/docs/agentrc-reference.json', import.meta.url),
);

describe('full-agentrc.json ↔ LIMITS_DEFAULTS drift guard', () => {
  const parsed = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));

  it('does not declare the removed planning.maxTickets knob (Story #4163)', () => {
    // maxTickets collapsed to a framework constant — it is no longer an
    // operator-configurable key, so the exhaustive reference must not list it.
    assert.equal(
      'maxTickets' in (parsed?.planning ?? {}),
      false,
      'agentrc-reference.json must not document the removed planning.maxTickets knob',
    );
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

  it('declares the two surviving detector blocks under delivery.signals', () => {
    const sig = parsed?.delivery?.signals;
    assert.ok(sig, 'delivery.signals must be present');
    assert.deepEqual(Object.keys(sig).sort(), ['retry', 'rework']);
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
