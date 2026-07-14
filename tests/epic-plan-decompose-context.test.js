import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS_DEFAULTS } from '../.agents/scripts/lib/config/limits.js';
import { upsertEpicSection } from '../.agents/scripts/lib/epic-body-sections.js';
import { buildDecompositionContext } from '../.agents/scripts/lib/orchestration/planning/decomposer-context.js';

// ---------------------------------------------------------------------------
// Story #3875 — the decomposition context envelope carries the real
// delivery envelope: the global hydration budget (`maxTokenBudget`) and
// the configured `delivery.preflight.max*` ceilings (`preflightCeilings`),
// so the decomposer sizes Stories against what delivery will actually
// hydrate and preflight will actually gate.
// ---------------------------------------------------------------------------

// Story #4324 retired the context-ticket classes: the decomposition context
// reads the Epic body (as `epicBody`), which carries the folded Tech Spec
// sections, so the linked Tech Spec fetch is gone from the provider stub.
const buildProvider = () => ({
  async getEpic(id) {
    return {
      id,
      title: 'Envelope Epic',
      body: upsertEpicSection(
        'EPIC BODY',
        'techSpec',
        '## Delivery Slicing\n\nTECH SPEC BODY',
      ),
    };
  },
});

describe('buildDecompositionContext delivery envelope (Story #3875)', () => {
  it('carries maxTokenBudget from the resolved limits surface', async () => {
    const ctx = await buildDecompositionContext(1, buildProvider(), {
      delivery: { maxTokenBudget: 250000 },
    });
    assert.equal(ctx.maxTokenBudget, 250000);
  });

  it('defaults maxTokenBudget to the single global LIMITS_DEFAULTS value', async () => {
    const ctx = await buildDecompositionContext(1, buildProvider(), {});
    assert.equal(ctx.maxTokenBudget, LIMITS_DEFAULTS.maxTokenBudget);
    assert.equal(ctx.maxTokenBudget, 300000);
  });

  it('carries only the configured delivery.preflight.max* keys in preflightCeilings', async () => {
    const ctx = await buildDecompositionContext(1, buildProvider(), {
      delivery: {
        preflight: { maxStories: 8, maxClaudeQuotaTokens: 4000000 },
      },
    });
    assert.deepEqual(ctx.preflightCeilings, {
      maxStories: 8,
      maxClaudeQuotaTokens: 4000000,
    });
  });

  it('yields an empty preflightCeilings object when delivery.preflight is absent', async () => {
    const ctx = await buildDecompositionContext(1, buildProvider(), {});
    assert.ok(
      ctx.preflightCeilings !== null && ctx.preflightCeilings !== undefined,
      'preflightCeilings must never be null/undefined',
    );
    assert.deepEqual(ctx.preflightCeilings, {});
  });

  it('survives JSON round-tripping with both envelope fields intact', async () => {
    const ctx = await buildDecompositionContext(1, buildProvider(), {});
    const roundTripped = JSON.parse(JSON.stringify(ctx));
    assert.equal(roundTripped.maxTokenBudget, 300000);
    assert.deepEqual(roundTripped.preflightCeilings, {});
  });
});
