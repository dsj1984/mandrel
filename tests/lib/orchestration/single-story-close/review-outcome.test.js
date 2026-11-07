/**
 * review-outcome.test.js — direct coverage for the operator-facing rendering of
 * the Story-scope review outcome (Story #5193).
 *
 * The module shipped with no tests of its own: its two exports were reachable
 * only through the close phase that calls them, so the degraded-review wording
 * could assert whatever it liked without a single assertion disagreeing. That
 * is how the false `npm run lint` coverage claim survived — the fix is only
 * durable with the wording under test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewGateValue } from '../../../../.agents/scripts/lib/orchestration/review-providers/degraded-gates.js';
import {
  buildOutcomeTally,
  formatReviewOutcomeLines,
} from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/review-outcome.js';
import { closeEnvelopeGates } from '../../../../.agents/scripts/lib/orchestration/single-story-close/result.js';

/** The severity shape every outcome carries, all-zero unless a test says otherwise. */
function severity(overrides = {}) {
  return { critical: 0, high: 0, medium: 0, suggestion: 0, ...overrides };
}

const DEGRADED = [{ surface: 'biome', reason: 'runner-not-installed' }];

test('buildOutcomeTally: a healthy review states the degraded-gate state explicitly as none', () => {
  const tally = buildOutcomeTally({ severity: severity(), degradations: [] });

  assert.match(
    tally,
    /degraded gates: none/,
    'an absent line must never be mistakable for a clean gate',
  );
  assert.match(tally, /critical:0 · high:0 · medium:0 · suggestion:0/);
});

test('buildOutcomeTally: an omitted degradations field still renders the state', () => {
  const tally = buildOutcomeTally({ severity: severity() });

  assert.match(tally, /degraded gates: none/);
});

test('buildOutcomeTally: severity counts are carried through verbatim', () => {
  const tally = buildOutcomeTally({
    severity: severity({ critical: 1, high: 2, medium: 3, suggestion: 4 }),
    degradations: [],
  });

  assert.match(tally, /critical:1 · high:2 · medium:3 · suggestion:4/);
});

test('buildOutcomeTally: a degraded gate names the surface rather than a bare count', () => {
  const tally = buildOutcomeTally({
    severity: severity(),
    degradations: DEGRADED,
  });

  assert.match(tally, /biome/);
  assert.doesNotMatch(tally, /degraded gates: none/);
});

test('formatReviewOutcomeLines: a healthy review is exactly one line and raises no warning', () => {
  const lines = formatReviewOutcomeLines({
    severity: severity(),
    degradations: [],
    prNumber: 42,
    posted: true,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /Posted to PR #42: true\./);
  assert.doesNotMatch(lines[0], /DEGRADED/);
});

test('formatReviewOutcomeLines: a degraded review adds a second, explicitly-worded line', () => {
  const lines = formatReviewOutcomeLines({
    severity: severity(),
    degradations: DEGRADED,
    prNumber: 7,
    posted: false,
  });

  assert.equal(lines.length, 2);
  assert.match(lines[1], /DEGRADED/);
  assert.match(
    lines[1],
    /not blocked/,
    'the operator must still be told the close is not gated on this read',
  );
});

test('formatReviewOutcomeLines: the degraded line claims no coverage it cannot verify (Story #5193)', () => {
  const lines = formatReviewOutcomeLines({
    severity: severity(),
    degradations: DEGRADED,
    prNumber: 7,
    posted: false,
  });

  // A stub `lint` script is a supported consumer shape, so this renderer can
  // never know what `npm run lint` covered — it must not say.
  assert.doesNotMatch(
    lines[1],
    /npm run lint/,
    'the message must not vouch for a close gate it cannot see',
  );
  assert.doesNotMatch(lines[1], /already covered/);
  assert.match(
    lines[1],
    /vouch/,
    'it must still disclaim vouching for the unreviewed surfaces',
  );
});

test('formatReviewOutcomeLines: the posted flag is reported honestly on both branches', () => {
  const notPosted = formatReviewOutcomeLines({
    severity: severity(),
    degradations: [],
    prNumber: 9,
    posted: false,
  });

  assert.match(notPosted[0], /Posted to PR #9: false\./);
});

// Story #5982 — the gate value and the warning line follow the degradation kinds.

const ofKind = (kind) => ({ surface: 'model-bug-review', reason: 'r', kind });

test('#5982 AC-3: reviewGateValue precedence is overridden > unreviewed > partial > degraded > passed', () => {
  const all = ['verdict-missing', 'coverage-partial', 'context-reduced'].map(
    ofKind,
  );
  assert.equal(reviewGateValue(all, { overridden: true }), 'overridden');
  assert.equal(reviewGateValue(all), 'unreviewed');
  assert.equal(reviewGateValue(all.slice(1)), 'partial');
  assert.equal(reviewGateValue(all.slice(2)), 'degraded');
  assert.equal(reviewGateValue([]), 'passed');
  assert.equal(reviewGateValue(undefined), 'passed');
});

test('#5982 AC-3: the close envelope gate reads the kinds, not the degraded flag', () => {
  const gate = (degradations, override = null) =>
    closeEnvelopeGates({}, null, override, degradations).codeReview;
  assert.equal(gate([ofKind('verdict-missing')]), 'unreviewed');
  assert.equal(gate([ofKind('coverage-partial')]), 'partial');
  assert.equal(gate([ofKind('context-reduced')]), 'degraded');
  assert.equal(gate([]), 'passed');
  assert.equal(
    gate([ofKind('verdict-missing')], { reason: 'x' }),
    'overridden',
  );
});

test('the close envelope reports codeReview "skipped" when no review ran, overridden still wins', () => {
  const skipped = { reviewSkipped: true };
  assert.equal(
    closeEnvelopeGates({}, null, null, undefined, skipped).codeReview,
    'skipped',
  );
  assert.equal(
    closeEnvelopeGates({}, null, { reason: 'x' }, undefined, skipped)
      .codeReview,
    'overridden',
  );
});

test('#5982 AC-11: unreviewed and partial reviews say they are not blocked unless onNoVerdict is block', () => {
  for (const [kind, word] of [
    ['verdict-missing', /UNREVIEWED/],
    ['coverage-partial', /PARTIAL/],
  ]) {
    const lines = formatReviewOutcomeLines({
      severity: severity(),
      degradations: [ofKind(kind)],
      prNumber: 7,
      posted: true,
    });
    assert.match(lines[1], word);
    assert.match(lines[1], /onNoVerdict/);
    assert.doesNotMatch(lines[1], /secondary review does not gate/);
  }
});
