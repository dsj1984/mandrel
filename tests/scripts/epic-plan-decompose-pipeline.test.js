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
import { warnTicketCapNearLimit } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/creation.js';

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

describe('epic-plan-decompose pipeline — warnTicketCapNearLimit (Story #2798)', () => {
  // Story #2798 reframed `maxTickets` as a reviewability budget. The
  // pipeline's warning helper MUST remain non-destructive (warn-only)
  // and MUST use budget language, not hard-cap "at or above" language
  // that previously implied truncation.
  const capture = () => {
    const warnings = [];
    return {
      logger: {
        warn: (msg) => warnings.push(msg),
        info: () => {},
        error: () => {},
        debug: () => {},
      },
      warnings,
    };
  };

  it('emits no warning when tickets are below the reviewability budget', () => {
    const { logger, warnings } = capture();
    warnTicketCapNearLimit(new Array(50).fill({}), 60, 'tag', { logger });
    assert.equal(warnings.length, 0);
  });

  it('warns (advisory only) when tickets meet or exceed the budget', () => {
    const { logger, warnings } = capture();
    warnTicketCapNearLimit(new Array(60).fill({}), 60, 'tag', { logger });
    assert.equal(warnings.length, 1);
    // Story #2798: language must call out the *budget*, not a hard cap.
    assert.match(warnings[0], /reviewability budget|budget/i);
    // Story #2798: the previous "at or above the N-ticket cap" phrasing
    // was misleading because the count is no longer a hard cap.
    assert.ok(
      !/at or above the/i.test(warnings[0]),
      'legacy hard-cap phrasing must be removed',
    );
  });

  it('returns nothing on either branch — it is a side-effect-only advisory', () => {
    const { logger } = capture();
    // Below-budget: returns falsy
    const r1 = warnTicketCapNearLimit(new Array(10).fill({}), 60, 'tag', {
      logger,
    });
    // Over-budget: still returns falsy (non-destructive)
    const r2 = warnTicketCapNearLimit(new Array(99).fill({}), 60, 'tag', {
      logger,
    });
    assert.equal(r1, undefined);
    assert.equal(r2, undefined);
  });
});

describe('epic-plan-decompose pipeline — runDecomposePhase over-budget gate (Story #2798)', () => {
  // The persist phase MUST refuse to write an over-budget decomposition
  // unless the operator explicitly authorises it via the
  // `allowOverBudget` override (CLI: `--allow-over-budget`). This is the
  // explicit-override-path the tech spec requires so accidental over-
  // budget plans do not silently persist.
  const buildEpic = () => ({
    id: 1,
    title: 'E',
    body: '',
    labels: ['type::epic'],
    linkedIssues: { prd: 10, techSpec: 11 },
  });

  const buildProvider = (epic) => ({
    async getEpic() {
      return epic;
    },
    async getTicket(id) {
      return { id, body: 'b' };
    },
    async updateTicket() {},
    async createTicket() {
      return { id: 999, url: 'u' };
    },
    async getTickets() {
      return [];
    },
  });

  it('throws a deterministic over-budget error when tickets.length > maxTickets and no override is set', async () => {
    const epic = buildEpic();
    const provider = buildProvider(epic);
    const tickets = new Array(65).fill(null).map((_, i) => ({
      slug: `s${i}`,
      type: 'feature',
      title: `T${i}`,
      body: 'b',
      labels: ['type::feature'],
    }));
    await assert.rejects(
      () =>
        runDecomposePhase(
          1,
          provider,
          { tickets },
          { planning: { maxTickets: 60 } },
        ),
      /over.?budget|--allow-over-budget|reviewability budget/i,
    );
  });

  it('emits no over-budget error when tickets.length <= maxTickets', async () => {
    // Negative: we only assert the over-budget gate does not preemptively
    // trip below the budget; we let the rest of the persist pipeline
    // fail downstream (validator/spawn) — what matters is the over-
    // budget check is not the first reject reason.
    const epic = buildEpic();
    const provider = buildProvider(epic);
    const tickets = new Array(5).fill(null).map((_, i) => ({
      slug: `s${i}`,
      type: 'feature',
      title: `T${i}`,
      body: 'b',
      labels: ['type::feature'],
    }));
    let err;
    try {
      await runDecomposePhase(
        1,
        provider,
        { tickets },
        { planning: { maxTickets: 60 } },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'persist will throw downstream (no spec writer wired)');
    assert.ok(
      !/over.?budget|--allow-over-budget/i.test(err.message),
      `under-budget run must NOT be rejected for over-budget reasons (got: ${err.message})`,
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
