/**
 * tests/audit-suite/selector-sibling-test.test.js — Story #4628.
 *
 * Pins the coverage-gap routing trigger that replaced audit-quality's backwards
 * test-file `filePatterns` with the `sourceWithoutSiblingTest` predicate:
 *
 *   - `changeSetLacksSiblingTest` is a pure predicate over a fixture diff: it
 *     is true iff the change set touches a production source file whose sibling
 *     test (matched by stem) is absent from the same change set.
 *   - `selectAudits` fires `audit-quality` on a source-without-sibling diff and
 *     does NOT fire it on a test-only diff (the old, backwards behaviour) when
 *     the ticket prose carries none of the lens's keywords.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changeSetLacksSiblingTest,
  selectAudits,
} from '../../.agents/scripts/lib/audit-suite/selector.js';
import { MockProvider } from '../fixtures/mock-provider.js';

// --- the pure predicate over fixture diffs ---------------------------------

test('changeSetLacksSiblingTest: source without any test fires', () => {
  assert.equal(changeSetLacksSiblingTest(['src/checkout.js']), true);
});

test('changeSetLacksSiblingTest: source with its sibling test does not fire', () => {
  assert.equal(
    changeSetLacksSiblingTest(['src/checkout.js', 'tests/checkout.test.js']),
    false,
  );
});

test('changeSetLacksSiblingTest: a test-only diff never fires (the coverage-gap flip)', () => {
  assert.equal(changeSetLacksSiblingTest(['tests/checkout.test.js']), false);
  assert.equal(changeSetLacksSiblingTest(['src/a.spec.ts']), false);
});

test('changeSetLacksSiblingTest: a doc/config-only diff never fires', () => {
  assert.equal(
    changeSetLacksSiblingTest([
      'README.md',
      '.agents/schemas/audit-rules.json',
    ]),
    false,
  );
});

test('changeSetLacksSiblingTest: one uncovered source among many covered fires', () => {
  assert.equal(
    changeSetLacksSiblingTest([
      'src/a.js',
      'tests/a.test.js',
      'src/b.js', // no b.test.js in the set
    ]),
    true,
  );
});

test('changeSetLacksSiblingTest: matches sibling by stem across directories', () => {
  assert.equal(
    changeSetLacksSiblingTest([
      'src/deep/nested/parser.ts',
      'tests/unit/parser.test.ts',
    ]),
    false,
  );
});

test('changeSetLacksSiblingTest: tolerates null / non-string entries', () => {
  assert.equal(changeSetLacksSiblingTest(null), false);
  assert.equal(changeSetLacksSiblingTest([null, 42, 'src/x.js']), true);
});

// --- selectAudits routes audit-quality on the flipped trigger --------------

/** Keyword-free ticket so audit-quality can only be selected via the trigger. */
function makeProvider() {
  return new MockProvider({
    tickets: {
      900: {
        id: 900,
        title: 'Refactor the dispatcher module',
        body: 'Restructure the module boundaries; no behavioural change.',
        labels: [],
      },
    },
  });
}

async function select(changedFiles) {
  const result = await selectAudits({
    ticketId: 900,
    gate: 'gate3',
    provider: makeProvider(),
    changedFiles,
  });
  return result.selectedAudits;
}

test('selectAudits: fires audit-quality on source lacking a sibling test', async () => {
  const selected = await select(['src/dispatcher.js']);
  assert.ok(
    selected.includes('audit-quality'),
    `audit-quality must fire on uncovered source: ${selected.join(', ')}`,
  );
});

test('selectAudits: does NOT fire audit-quality on a test-only diff', async () => {
  const selected = await select(['tests/dispatcher.test.js']);
  assert.ok(
    !selected.includes('audit-quality'),
    `audit-quality must not fire on a test-only diff: ${selected.join(', ')}`,
  );
});

test('selectAudits: does NOT fire audit-quality when every source has a sibling test', async () => {
  const selected = await select([
    'src/dispatcher.js',
    'tests/dispatcher.test.js',
  ]);
  assert.ok(
    !selected.includes('audit-quality'),
    `audit-quality must not fire when source is covered: ${selected.join(', ')}`,
  );
});
