import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPendingStoryKeys,
  evaluateConcurrencyGate,
  filterFindingsToPending,
  renderGateErrorMessage,
} from '../../../.agents/scripts/lib/orchestration/epic-runner/concurrency-gate.js';

/**
 * Pure-function unit coverage for the cross-Story concurrency-hazard
 * gate that `epic-deliver-prepare.js` consumes (Story #2297).
 *
 * The gate is decomposed into four pure pieces — `collectPendingStoryKeys`,
 * `filterFindingsToPending`, `evaluateConcurrencyGate`, and
 * `renderGateErrorMessage` — so each piece can be exercised without
 * spinning up a provider or wave DAG.
 */

// ---------------------------------------------------------------------------
// collectPendingStoryKeys
// ---------------------------------------------------------------------------

test('collectPendingStoryKeys: omits stories carrying agent::done', () => {
  const wavePlan = [
    [
      { id: 201, number: 201, labels: ['type::story', 'agent::done'] },
      { id: 202, number: 202, labels: ['type::story'] },
    ],
    [{ id: 203, number: 203, labels: ['type::story'] }],
  ];
  const keys = collectPendingStoryKeys(wavePlan);
  assert.equal(keys.has('201'), false);
  assert.equal(keys.has('202'), true);
  assert.equal(keys.has('203'), true);
});

test('collectPendingStoryKeys: accepts slug-shaped identifiers alongside numbers', () => {
  const wavePlan = [[{ id: 301, slug: 's-a', labels: ['type::story'] }]];
  const keys = collectPendingStoryKeys(wavePlan);
  assert.equal(keys.has('301'), true);
  assert.equal(keys.has('s-a'), true);
});

test('collectPendingStoryKeys: tolerates non-array input', () => {
  assert.equal(collectPendingStoryKeys(null).size, 0);
  assert.equal(collectPendingStoryKeys(undefined).size, 0);
  assert.equal(collectPendingStoryKeys([null, [null], [{}]]).size, 0);
});

// ---------------------------------------------------------------------------
// filterFindingsToPending
// ---------------------------------------------------------------------------

test('filterFindingsToPending: keeps findings touching at least one pending story', () => {
  const findings = [
    { kind: 'shared-editor', storySlugs: ['s-a', 's-b'], severity: 'soft' },
    {
      kind: 'shared-editor',
      storySlugs: ['s-done-1', 's-done-2'],
      severity: 'soft',
    },
  ];
  const pending = new Set(['s-a']);
  const kept = filterFindingsToPending(findings, pending);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].storySlugs[0], 's-a');
});

test('filterFindingsToPending: implicit-cross-story-dep keys come from producer + consumer', () => {
  const findings = [
    {
      kind: 'implicit-cross-story-dep',
      producer: { storySlug: 's-prod', taskSlug: 't1' },
      consumer: { storySlug: 's-cons', taskSlug: 't2', sourceField: 'verify' },
      severity: 'soft',
    },
  ];
  assert.equal(
    filterFindingsToPending(findings, new Set(['s-prod'])).length,
    1,
  );
  assert.equal(
    filterFindingsToPending(findings, new Set(['s-cons'])).length,
    1,
  );
  assert.equal(
    filterFindingsToPending(findings, new Set(['s-other'])).length,
    0,
  );
});

test('filterFindingsToPending: conservatively keeps findings with no identifiers', () => {
  const findings = [{ kind: 'shared-editor', severity: 'hard' }];
  const kept = filterFindingsToPending(findings, new Set(['s-a']));
  assert.equal(kept.length, 1);
});

// ---------------------------------------------------------------------------
// evaluateConcurrencyGate
// ---------------------------------------------------------------------------

test('evaluateConcurrencyGate: passes on advisory-only findings', () => {
  const result = evaluateConcurrencyGate({
    findings: [{ kind: 'shared-editor', severity: 'soft' }],
    policy: {},
  });
  assert.equal(result.tripped, false);
  assert.equal(result.bypassed, false);
});

test('evaluateConcurrencyGate: trips on a hard-severity finding', () => {
  const result = evaluateConcurrencyGate({
    findings: [{ kind: 'shared-editor', severity: 'hard' }],
    policy: {},
  });
  assert.equal(result.tripped, true);
  assert.equal(result.reason, 'hard-severity');
  assert.equal(result.bypassed, false);
});

test('evaluateConcurrencyGate: failOnConcurrencyHazards upgrades any finding to a trip', () => {
  const result = evaluateConcurrencyGate({
    findings: [{ kind: 'shared-editor', severity: 'soft' }],
    policy: { failOnConcurrencyHazards: true },
  });
  assert.equal(result.tripped, true);
  assert.equal(result.reason, 'config-fail-on');
});

test('evaluateConcurrencyGate: ignore=true marks bypassed but still reports tripped', () => {
  const result = evaluateConcurrencyGate({
    findings: [{ kind: 'shared-editor', severity: 'hard' }],
    policy: {},
    ignore: true,
  });
  assert.equal(result.tripped, true);
  assert.equal(result.bypassed, true);
});

test('evaluateConcurrencyGate: empty findings always pass', () => {
  const result = evaluateConcurrencyGate({
    findings: [],
    policy: { failOnConcurrencyHazards: true },
  });
  assert.equal(result.tripped, false);
});

// ---------------------------------------------------------------------------
// renderGateErrorMessage
// ---------------------------------------------------------------------------

test('renderGateErrorMessage: lists paths, Stories, and gh issue edit remediation', () => {
  const message = renderGateErrorMessage(
    [
      {
        kind: 'shared-editor',
        path: '.github/workflows/quality.yml',
        storySlugs: ['s-a', 's-b'],
        severity: 'hard',
      },
      {
        kind: 'implicit-cross-story-dep',
        path: '.agents/schemas/baselines/coverage.schema.json',
        producer: { storySlug: 's-prod', taskSlug: 't-prod' },
        consumer: {
          storySlug: 's-cons',
          taskSlug: 't-cons',
          sourceField: 'verify',
        },
        severity: 'hard',
      },
    ],
    'dsj1984/mandrel',
  );
  assert.match(message, /Refusing to flip Epic/);
  assert.match(message, /Shared-editor conflicts/);
  assert.match(message, /\.github\/workflows\/quality\.yml/);
  assert.match(message, /Implicit cross-Story dependencies/);
  assert.match(message, /gh issue edit s-cons --repo dsj1984\/mandrel/);
  assert.match(message, /--ignore-concurrency-hazards/);
});

test('renderGateErrorMessage: omits --repo flag when ownerRepo is undefined', () => {
  const message = renderGateErrorMessage(
    [
      {
        kind: 'implicit-cross-story-dep',
        path: 'p',
        producer: { storySlug: 'a', taskSlug: 't1' },
        consumer: { storySlug: 'b', taskSlug: 't2', sourceField: 'verify' },
        severity: 'hard',
      },
    ],
    undefined,
  );
  assert.equal(message.includes('--repo'), false);
});
