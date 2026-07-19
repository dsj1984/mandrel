/**
 * tests/audit-suite/selector-keyword-boundary.test.js
 *
 * Contract tests for #4579's over/under-selection halves:
 *
 * 1. Keyword triggers match **whole words only**. The old bare substring
 *    test selected web lenses on accidental fragments — `"ui"` inside
 *    "requires" (audit-ux-ui), `"auth"` inside "author"
 *    (audit-security) — on a repo with no web surface at all.
 *
 * 2. `audit-architecture` is reachable. Its manifest entry used to carry
 *    gates only — with neither keywords nor filePatterns, the selector's
 *    `gateMatch && (keywordMatch || fileMatch)` predicate could never
 *    select it, on any diff. It now fires via filePatterns on
 *    source-module-touching diffs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAudits } from '../../.agents/scripts/lib/audit-suite/selector.js';
import { MockProvider } from '../fixtures/mock-provider.js';

function makeProvider(body) {
  return new MockProvider({
    tickets: {
      600: {
        id: 600,
        title: 'Refactor the close pipeline',
        body,
        labels: [],
      },
    },
  });
}

async function select({ body, changedFiles, gate = 'gate3' }) {
  const result = await selectAudits({
    ticketId: 600,
    gate,
    provider: makeProvider(body),
    changedFiles,
  });
  return result.selectedAudits;
}

test('selector: "ui" fragment inside "requires" does not select the web lenses', async () => {
  const selected = await select({
    body: 'validateTaskBodies requires non-empty acceptance criteria.',
    changedFiles: ['.agents/scripts/deliver.js'],
  });
  assert.ok(
    !selected.includes('audit-ux-ui'),
    `audit-ux-ui selected on a "requires" fragment: ${selected}`,
  );
  assert.ok(
    !selected.includes('audit-accessibility'),
    `audit-accessibility selected on a "requires" fragment: ${selected}`,
  );
});

test('selector: "auth" fragment inside "author" does not select audit-security', async () => {
  const selected = await select({
    body: 'The author of the change updated the changelog prose.',
    changedFiles: ['docs/CHANGELOG.md'],
  });
  assert.ok(
    !selected.includes('audit-security'),
    `audit-security selected on an "author" fragment: ${selected}`,
  );
});

test('selector: a whole-word keyword still selects its lens', async () => {
  const selected = await select({
    body: 'Harden the auth flow: rate-limit the login endpoint.',
    changedFiles: ['docs/notes.txt'],
  });
  assert.ok(
    selected.includes('audit-security'),
    `audit-security not selected on a whole-word "auth": ${selected}`,
  );
});

test('selector: audit-architecture fires on a source-module diff', async () => {
  const selected = await select({
    body: 'Prose with no trigger keywords at all.',
    changedFiles: [
      '.agents/scripts/lib/orchestration/run-epilogue.js',
      'lib/cli/update.js',
    ],
  });
  assert.ok(
    selected.includes('audit-architecture'),
    `audit-architecture not selected on a lib diff: ${selected}`,
  );
});

test('selector: audit-architecture stays out of a docs-only diff', async () => {
  const selected = await select({
    body: 'Prose with no trigger keywords at all.',
    changedFiles: ['docs/onboarding.md', 'README.md'],
  });
  assert.ok(
    !selected.includes('audit-architecture'),
    `audit-architecture selected on a docs-only diff: ${selected}`,
  );
});
