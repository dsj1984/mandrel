// tests/lib/story-plan/ack-label.test.js
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  PLAN_ACKNOWLEDGED,
  PLAN_LABELS,
} from '../../../.agents/scripts/lib/label-constants.js';

// ── Story #3259 — plan::acknowledged label constant ──────────────────────────

test('PLAN_LABELS.ACKNOWLEDGED equals "plan::acknowledged"', () => {
  assert.equal(PLAN_LABELS.ACKNOWLEDGED, 'plan::acknowledged');
});

test('PLAN_ACKNOWLEDGED named export equals "plan::acknowledged"', () => {
  assert.equal(PLAN_ACKNOWLEDGED, 'plan::acknowledged');
});

test('PLAN_ACKNOWLEDGED named export mirrors PLAN_LABELS.ACKNOWLEDGED', () => {
  assert.equal(PLAN_ACKNOWLEDGED, PLAN_LABELS.ACKNOWLEDGED);
});

test('PLAN_LABELS is a non-null object with at least ACKNOWLEDGED key', () => {
  assert.ok(
    PLAN_LABELS !== null && typeof PLAN_LABELS === 'object',
    'PLAN_LABELS must be an object',
  );
  assert.ok(
    Object.hasOwn(PLAN_LABELS, 'ACKNOWLEDGED'),
    'PLAN_LABELS must have ACKNOWLEDGED key',
  );
});
