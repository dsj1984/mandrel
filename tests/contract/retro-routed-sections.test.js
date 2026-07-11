/**
 * Contract test for retro-routed-sections (Story #2558, Epic #2547).
 *
 * Asserts the wire shape of the retro body when `routedProposals` is
 * supplied: four explicit labeled sections in deterministic order above
 * the `<!-- retro-complete: ... -->` marker, with pre-drafted
 * `gh issue create --repo ...` commands and a memory-as-instructions
 * block (NOT memory frontmatter).
 *
 * Also asserts that:
 *   - Compact (clean-manifest) path is unaffected when manifest is clean
 *     even if routedProposals is non-empty (per spec — compact path stays
 *     compact; routedProposals only displaces the legacy Action Items
 *     section on the full path).
 *   - With routedProposals empty/absent, the legacy section renders
 *     (backward-compatible).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { composeRoutedProposals } from '../../.agents/scripts/lib/orchestration/retro-proposals.js';
import { composeRetroBody } from '../../.agents/scripts/lib/orchestration/retro-runner.js';

const NON_CLEAN_COUNTS = {
  friction: 5,
  parked: 0,
  recuts: 0,
  hotfixes: 1,
  hitl: 0,
};

test('contract: full retro renders three routed sections in deterministic order', () => {
  // Synthetic signals stream: framework lint-loop x3, consumer flaky-test x2,
  // consumer one-off x1. The former "Proposed memory updates" pane was
  // deleted in the Epic #4406 cutover.
  const routedProposals = composeRoutedProposals({
    epicId: 2547,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'dsj1984/domio',
    signals: [
      { category: 'lint-loop', source: 'framework' },
      { category: 'lint-loop', source: 'framework' },
      { category: 'lint-loop', source: 'framework' },
      { category: 'flaky-test', source: 'consumer' },
      { category: 'flaky-test', source: 'consumer' },
      { category: 'one-off', source: 'consumer' },
    ],
  });

  const { body } = composeRetroBody({
    epicId: 2547,
    epicTitle: 'Feedback loop routing',
    counts: NON_CLEAN_COUNTS,
    routedProposals,
    tasksTotal: 6,
    tasksFirstTry: 4,
    timestamp: '2026-05-19T00:00:00.000Z',
  });

  // The three section headings appear verbatim; the memory heading does NOT.
  const consumerIdx = body.indexOf('### Proposed issues — consumer repo');
  const frameworkIdx = body.indexOf('### Proposed issues — framework repo');
  const discardedIdx = body.indexOf('### One-off / discarded');
  const completeIdx = body.indexOf('<!-- retro-complete:');

  assert.notEqual(consumerIdx, -1, 'consumer section heading present');
  assert.notEqual(frameworkIdx, -1, 'framework section heading present');
  assert.equal(
    body.includes('### Proposed memory updates'),
    false,
    'memory section heading must be gone',
  );
  assert.notEqual(discardedIdx, -1, 'discarded section heading present');
  assert.notEqual(completeIdx, -1, 'retro-complete marker present');

  // Deterministic ordering: consumer < framework < discarded < marker.
  assert.ok(consumerIdx < frameworkIdx, 'consumer appears before framework');
  assert.ok(frameworkIdx < discardedIdx, 'framework appears before discarded');
  assert.ok(
    discardedIdx < completeIdx,
    'all three sections appear before the retro-complete marker',
  );
});

test('contract: each Proposed issues section contains pre-drafted gh issue create with --repo flag', () => {
  const routedProposals = composeRoutedProposals({
    epicId: 2547,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'dsj1984/domio',
    signals: [
      { category: 'lint-loop', source: 'framework' },
      { category: 'lint-loop', source: 'framework' },
      { category: 'flaky-test', source: 'consumer' },
      { category: 'flaky-test', source: 'consumer' },
    ],
  });
  const { body } = composeRetroBody({
    epicId: 2547,
    epicTitle: 'Feedback loop routing',
    counts: NON_CLEAN_COUNTS,
    routedProposals,
    timestamp: '2026-05-19T00:00:00.000Z',
  });

  // Framework section gets the framework repo flag.
  assert.match(body, /gh issue create --repo dsj1984\/mandrel/);
  // Consumer section gets the consumer repo flag.
  assert.match(body, /gh issue create --repo dsj1984\/domio/);
  // Labels carry meta::* and friction::*.
  assert.match(body, /meta::framework-gap,friction::lint-loop/);
  assert.match(body, /meta::consumer-improvement,friction::flaky-test/);
  // Heredoc body-file form.
  assert.match(body, /--body-file - <<EOF/);
});

test('contract: the retro renders no "Proposed memory updates" section', () => {
  // The memory pane was deleted in the Epic #4406 cutover — even with
  // actionable routed proposals present, no memory section is rendered.
  const routedProposals = composeRoutedProposals({
    epicId: 2547,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'dsj1984/domio',
    signals: [
      { category: 'noise', source: 'consumer' },
      { category: 'noise', source: 'consumer' },
    ],
  });
  const { body } = composeRetroBody({
    epicId: 2547,
    epicTitle: 'Feedback loop routing',
    counts: NON_CLEAN_COUNTS,
    routedProposals,
    timestamp: '2026-05-19T00:00:00.000Z',
  });
  assert.equal(body.includes('### Proposed memory updates'), false);
  assert.equal(
    body.includes('update your memory with the following insights:'),
    false,
  );
});

test('contract: compact (clean-manifest) path remains unaffected when routedProposals is empty', () => {
  const empty = composeRoutedProposals({
    epicId: 2547,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'dsj1984/domio',
    signals: [],
  });
  const { body, compact } = composeRetroBody({
    epicId: 2547,
    epicTitle: 'Clean Epic',
    counts: { friction: 0, parked: 0, recuts: 0, hotfixes: 0, hitl: 0 },
    routedProposals: empty,
    tasksTotal: 3,
    tasksFirstTry: 3,
    timestamp: '2026-05-19T00:00:00.000Z',
  });
  assert.equal(compact, true, 'clean manifest still routes to compact path');
  assert.match(body, /🟢 Clean sprint/);
  // The compact path retains its existing "Action Items for Next Epic" stub.
  assert.match(body, /### Action Items for Next Epic/);
  // The four routed section headings MUST NOT leak into the compact body.
  assert.equal(
    body.includes('### Proposed issues — consumer repo'),
    false,
    'compact path must not render routed sections',
  );
  assert.equal(body.includes('### Proposed issues — framework repo'), false);
});

test('contract: full path with absent routedProposals renders legacy Action Items section', () => {
  const { body, compact } = composeRetroBody({
    epicId: 2547,
    epicTitle: 'Legacy Path Epic',
    counts: NON_CLEAN_COUNTS,
    // routedProposals omitted entirely.
    tasksTotal: 6,
    tasksFirstTry: 4,
    timestamp: '2026-05-19T00:00:00.000Z',
  });
  assert.equal(compact, false);
  assert.match(body, /### Action Items for Next Epic/);
  // The four new section headings MUST NOT appear when routedProposals is
  // absent — that's the backward-compat guarantee.
  assert.equal(body.includes('### Proposed issues — consumer repo'), false);
  assert.equal(body.includes('### Proposed memory updates'), false);
});

test('contract: routed sections render placeholders for empty buckets', () => {
  // A single-occurrence friction → only the discarded bucket is non-empty;
  // the two "Proposed issues" buckets render "_None._".
  const routedProposals = composeRoutedProposals({
    epicId: 2547,
    frameworkRepo: 'dsj1984/mandrel',
    consumerRepo: 'dsj1984/domio',
    signals: [{ category: 'one-off', source: 'consumer' }],
  });
  const { body } = composeRetroBody({
    epicId: 2547,
    epicTitle: 'Discarded-only Epic',
    counts: NON_CLEAN_COUNTS,
    routedProposals,
    timestamp: '2026-05-19T00:00:00.000Z',
  });
  // The three headings are emitted; empty buckets render "_None._".
  assert.match(body, /### Proposed issues — consumer repo\n\n_None\._/);
  assert.match(body, /### Proposed issues — framework repo\n\n_None\._/);
  // The discarded bucket is populated.
  assert.match(body, /### One-off \/ discarded/);
  assert.match(body, /`one-off`/);
  // No memory section.
  assert.equal(body.includes('### Proposed memory updates'), false);
});
