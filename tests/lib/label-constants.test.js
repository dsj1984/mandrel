import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ACCEPTANCE_LABELS,
  ACCEPTANCE_NA,
  CONTEXT_ACCEPTANCE_SPEC,
  CONTEXT_LABELS,
  LABEL_COLORS,
} from '../../.agents/scripts/lib/label-constants.js';

test('CONTEXT_LABELS.ACCEPTANCE_SPEC equals "context::acceptance-spec"', () => {
  assert.equal(CONTEXT_LABELS.ACCEPTANCE_SPEC, 'context::acceptance-spec');
});

test('CONTEXT_ACCEPTANCE_SPEC named export mirrors CONTEXT_LABELS.ACCEPTANCE_SPEC', () => {
  assert.equal(CONTEXT_ACCEPTANCE_SPEC, 'context::acceptance-spec');
  assert.equal(CONTEXT_ACCEPTANCE_SPEC, CONTEXT_LABELS.ACCEPTANCE_SPEC);
});

test('ACCEPTANCE_LABELS.N_A equals "acceptance::n-a"', () => {
  assert.equal(ACCEPTANCE_LABELS.N_A, 'acceptance::n-a');
});

test('ACCEPTANCE_NA named export mirrors ACCEPTANCE_LABELS.N_A', () => {
  assert.equal(ACCEPTANCE_NA, 'acceptance::n-a');
  assert.equal(ACCEPTANCE_NA, ACCEPTANCE_LABELS.N_A);
});

test('existing CONTEXT_LABELS entries are still exposed', () => {
  assert.equal(CONTEXT_LABELS.PRD, 'context::prd');
  assert.equal(CONTEXT_LABELS.TECH_SPEC, 'context::tech-spec');
});

test('LABEL_COLORS includes a dedicated ACCEPTANCE swatch', () => {
  assert.ok(
    typeof LABEL_COLORS.ACCEPTANCE === 'string' &&
      /^#[0-9A-Fa-f]{6}$/.test(LABEL_COLORS.ACCEPTANCE),
    `expected hex color for LABEL_COLORS.ACCEPTANCE, got ${LABEL_COLORS.ACCEPTANCE}`,
  );
});
