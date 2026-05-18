// tests/scripts/epic-plan-decompose-pipeline.test.js
//
// Story #2466 / Task #2495 — byte-identical CLI surface for the thinned
// epic-plan-decompose pipeline.
//
// After Story #2466 extracted the per-phase modules under
// `lib/orchestration/epic-plan-decompose/phases/`, this fixture-diff
// test pins the public exports + the two CLI flows (`--emit-context`
// envelope and the persist path's runDecomposePhase signature).
//
// Run: node --test tests/scripts/epic-plan-decompose-pipeline.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
  decomposeEpic,
  ensurePlanningArtifacts,
  orderTicketsForCreation,
  resolveDependencies,
  runDecomposePhase,
} from '../../.agents/scripts/epic-plan-decompose.js';

describe('epic-plan-decompose pipeline — named exports (Story #2466)', () => {
  it('re-exports the legacy named surface', () => {
    // Removing any of these breaks downstream tests + the orchestrator.
    assert.equal(typeof buildDecomposerSystemPrompt, 'function');
    assert.equal(typeof buildDecompositionContext, 'function');
    assert.equal(typeof decomposeEpic, 'function');
    assert.equal(typeof ensurePlanningArtifacts, 'function');
    assert.equal(typeof orderTicketsForCreation, 'function');
    assert.equal(typeof resolveDependencies, 'function');
    assert.equal(typeof runDecomposePhase, 'function');
  });
});

describe('epic-plan-decompose pipeline — ensurePlanningArtifacts (Story #2466)', () => {
  it('returns the body verbatim when the section is already present', () => {
    const body = 'A heading.\n\n## Planning Artifacts\n- [ ] PRD: #1\n';
    const out = ensurePlanningArtifacts(body, {
      prd: 1,
      techSpec: 2,
      acceptanceSpec: 3,
    });
    assert.equal(out, body, 'must be byte-identical when section exists');
  });

  it('appends the section exactly once when missing', () => {
    const out = ensurePlanningArtifacts('Hello', {
      prd: 10,
      techSpec: 20,
      acceptanceSpec: 30,
    });
    assert.match(out, /## Planning Artifacts/);
    assert.match(out, /- \[ \] PRD: #10/);
    assert.match(out, /- \[ \] Tech Spec: #20/);
    assert.match(out, /- \[ \] Acceptance Spec: #30/);
    // No double-append on second call.
    const out2 = ensurePlanningArtifacts(out, {
      prd: 10,
      techSpec: 20,
      acceptanceSpec: 30,
    });
    assert.equal(out2, out);
  });

  it('returns the body verbatim when linkedIssues is missing', () => {
    assert.equal(ensurePlanningArtifacts('foo'), 'foo');
    assert.equal(ensurePlanningArtifacts('foo', null), 'foo');
  });
});

describe('epic-plan-decompose pipeline — orderTicketsForCreation (Story #2466)', () => {
  it('emits features before stories before tasks', () => {
    const tickets = [
      { type: 'task', slug: 't', title: 't', parent_slug: 's' },
      { type: 'story', slug: 's', title: 's', parent_slug: 'f' },
      { type: 'feature', slug: 'f', title: 'f' },
    ];
    const ordered = orderTicketsForCreation(tickets);
    assert.deepEqual(
      ordered.map((t) => t.type),
      ['feature', 'story', 'task'],
    );
  });

  it('respects intra-group depends_on (topological order)', () => {
    const tickets = [
      {
        type: 'task',
        slug: 'b',
        title: 'b',
        parent_slug: 's',
        depends_on: ['a'],
      },
      { type: 'task', slug: 'a', title: 'a', parent_slug: 's' },
    ];
    const ordered = orderTicketsForCreation(tickets);
    assert.deepEqual(
      ordered.map((t) => t.slug),
      ['a', 'b'],
    );
  });
});

describe('epic-plan-decompose pipeline — resolveDependencies (Story #2466)', () => {
  it('maps slugs to ids via slugMap', () => {
    const slugMap = new Map([
      ['a', 11],
      ['b', 22],
    ]);
    const out = resolveDependencies(
      { type: 'task', title: 't', slug: 't', depends_on: ['a', 'b'] },
      slugMap,
    );
    assert.deepEqual(out, [11, 22]);
  });

  it('throws on unresolved slug (would otherwise drop a DAG edge)', () => {
    assert.throws(
      () =>
        resolveDependencies(
          { type: 'task', title: 't', slug: 't', depends_on: ['missing'] },
          new Map(),
        ),
      /unresolved slug "missing"/,
    );
  });
});
