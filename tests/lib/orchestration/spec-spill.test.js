/**
 * Unit tests for the v2 Story ## Spec budget gate (no spill-to-docs).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSpecWithinBudget,
  DEFAULT_SPEC_BODY_TOKEN_BUDGET,
  spillSpecIfOverBudget,
} from '../../../.agents/scripts/lib/orchestration/spec-spill.js';

describe('assertSpecWithinBudget — under budget', () => {
  it('keeps a small spec inline', () => {
    const res = assertSpecWithinBudget({
      storyId: 's1',
      spec: 'short spec',
    });
    assert.equal(res.content, 'short spec');
    assert.ok(res.estimatedTokens < DEFAULT_SPEC_BODY_TOKEN_BUDGET);
  });
});

describe('assertSpecWithinBudget — over budget', () => {
  const bigSpec = 'x'.repeat((DEFAULT_SPEC_BODY_TOKEN_BUDGET + 100) * 4);

  it('rejects an over-budget Spec instead of writing docs/', () => {
    assert.throws(
      () => assertSpecWithinBudget({ storyId: '#4512', spec: bigSpec }),
      /too large|never written to docs/,
    );
  });

  it('honors a custom budget', () => {
    assert.throws(
      () =>
        assertSpecWithinBudget(
          { storyId: 's1', spec: 'x'.repeat(41) },
          { tokenBudget: 10 },
        ),
      /budget 10/,
    );
  });
});

describe('spillSpecIfOverBudget (compat alias)', () => {
  it('never spills — returns inline when under budget', () => {
    const res = spillSpecIfOverBudget({
      storyId: 's1',
      spec: 'short',
    });
    assert.equal(res.spilled, false);
    assert.equal(res.docPath, null);
    assert.equal(res.reference, null);
  });

  it('throws when over budget (same fail-closed policy)', () => {
    const bigSpec = 'x'.repeat((DEFAULT_SPEC_BODY_TOKEN_BUDGET + 100) * 4);
    assert.throws(
      () => spillSpecIfOverBudget({ storyId: 's1', spec: bigSpec }),
      /never written to docs/,
    );
  });
});
