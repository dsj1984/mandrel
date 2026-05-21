/**
 * Contract test for `runCodeReview` rendering of a seeded `Finding[]`.
 *
 * Story #2831 (Epic #2815) — pins the structured-comment body emitted
 * for a known set of findings to a committed fixture so the renderer
 * cannot drift under refactor.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'code-review-snapshot.md',
);

const SEEDED_FINDINGS = [
  {
    severity: 'critical',
    title: 'Low Maintainability',
    body: 'Module `src/a.js` reports a critical maintainability tier (worst method 12.0).',
    file: 'src/a.js',
    category: 'maintainability',
  },
  {
    severity: 'high',
    title: 'Lint check failed (2 error(s))',
    body: 'Scoped lint reported 2 error(s) and 1 warning(s) on the changed surface.',
    category: 'lint',
  },
  {
    severity: 'medium',
    title: 'Size/Volume Warning',
    body: 'Module `src/b.js` reports a size/volume warning (module 60.0).',
    file: 'src/b.js',
    category: 'maintainability',
  },
  {
    severity: 'suggestion',
    title: 'Lint runner could not execute',
    body: 'The scoped lint runner produced no parseable output.',
    category: 'lint',
  },
];

test('runCodeReview renders a known Finding[] to the committed snapshot body', async () => {
  let postedBody = null;
  await runCodeReview({
    epicId: 4242,
    provider: { kind: 'github' },
    bus: { emit: async () => {} },
    baseBranch: 'main',
    reviewProvider: { runReview: async () => SEEDED_FINDINGS },
    resolveConfigFn: () => ({
      project: { baseBranch: 'main' },
      delivery: { codeReview: { provider: 'native' } },
    }),
    upsertCommentFn: async (_provider, _ticketId, _type, body) => {
      postedBody = body;
    },
  });

  assert.ok(postedBody, 'upsertStructuredComment must have been invoked');

  if (process.env.UPDATE_SNAPSHOT === '1') {
    writeFileSync(FIXTURE_PATH, postedBody, 'utf8');
  }

  const expected = readFileSync(FIXTURE_PATH, 'utf8');
  assert.equal(
    postedBody,
    expected,
    'Rendered body drifted from the committed snapshot. ' +
      'Re-run with UPDATE_SNAPSHOT=1 if the change is intentional.',
  );
});
