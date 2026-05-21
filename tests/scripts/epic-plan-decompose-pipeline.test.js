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
import { EPIC_PLAN_STATE_TYPE } from '../../.agents/scripts/lib/orchestration/epic-plan-state-store.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

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

describe('epic-plan-decompose pipeline — buildDecompositionContext planning risk (Story #2801)', () => {
  // Story #2801 — the decomposition context must surface the
  // `planningRisk` decision computed during Phase 7 so the Phase 8
  // authoring step can cite the same risk classification used by gate
  // routing. The decision is persisted in the `epic-plan-state`
  // structured comment on the Epic and is read through the standard
  // provider boundary (`getTicketComments`).
  //
  // Tests use small, opaque-but-realistic risk and routing envelopes;
  // the contract is "round-trips through the context without
  // re-shaping", not "classifier output matches an oracle".

  const EPIC_ID = 7400;
  const PRD_ID = 7401;
  const TECH_SPEC_ID = 7402;

  const PRD_BODY = '# PRD\n\nSome PRD prose for #7400.\n';
  const TECH_SPEC_BODY = '# Tech Spec\n\nSome Tech Spec prose for #7400.\n';

  const RISK_ENVELOPE = {
    axes: [
      {
        axis: 'critical-workflow',
        level: 'high',
        evidence: 'Touches /epic-plan gate routing.',
      },
    ],
    overallLevel: 'high',
    requiresReview: true,
    acceptanceDisposition: 'required',
    gateDecision: 'review-required',
  };

  const ROUTING_ENVELOPE = {
    decision: 'review-required',
    requiresStop: true,
    forceReviewApplied: false,
  };

  function planStateCommentBody(state) {
    const marker = structuredCommentMarker(EPIC_PLAN_STATE_TYPE);
    const payload = {
      version: 1,
      epicId: EPIC_ID,
      phase: 'review-spec',
      ...state,
    };
    return `${marker}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  }

  function buildProvider({ planStateBody = null } = {}) {
    const epic = {
      id: EPIC_ID,
      title: 'Adaptive planning',
      body: '## Epic body\n',
      labels: ['type::epic'],
      linkedIssues: { prd: PRD_ID, techSpec: TECH_SPEC_ID },
    };
    const tickets = new Map([
      [EPIC_ID, epic],
      [PRD_ID, { id: PRD_ID, body: PRD_BODY }],
      [TECH_SPEC_ID, { id: TECH_SPEC_ID, body: TECH_SPEC_BODY }],
    ]);
    const comments = new Map();
    if (planStateBody) {
      comments.set(EPIC_ID, [{ id: 1, body: planStateBody }]);
    }
    return {
      async getEpic(id) {
        return tickets.get(id);
      },
      async getTicket(id) {
        return tickets.get(id);
      },
      async getTicketComments(id) {
        return comments.get(id) ?? [];
      },
    };
  }

  it('surfaces the planningRisk envelope from the epic-plan-state comment', async () => {
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        planningRisk: RISK_ENVELOPE,
        reviewRouting: ROUTING_ENVELOPE,
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.deepEqual(ctx.planningRisk, RISK_ENVELOPE);
  });

  it('surfaces the reviewRouting envelope from the epic-plan-state comment', async () => {
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        planningRisk: RISK_ENVELOPE,
        reviewRouting: ROUTING_ENVELOPE,
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.deepEqual(ctx.reviewRouting, ROUTING_ENVELOPE);
  });

  it('exposes null planningRisk when the Epic has no epic-plan-state comment (older plans)', async () => {
    // Documented null-state for Epics planned before Story #2801 landed.
    const provider = buildProvider({ planStateBody: null });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.equal(
      ctx.planningRisk,
      null,
      'planningRisk must be exposed as explicit null, not undefined or omitted',
    );
    assert.equal(
      ctx.reviewRouting,
      null,
      'reviewRouting must be exposed as explicit null when the comment is absent',
    );
  });

  it('exposes null planningRisk when the comment exists but lacks the field (forward-compat)', async () => {
    // Older `epic-plan-state` payloads may exist without the risk field.
    // The decomposer must not crash and must surface a null sentinel.
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        spec: { prdId: PRD_ID, techSpecId: TECH_SPEC_ID },
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.equal(ctx.planningRisk, null);
    assert.equal(ctx.reviewRouting, null);
  });

  it('preserves existing PRD and Tech Spec body behavior (AC #2)', async () => {
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        planningRisk: RISK_ENVELOPE,
        reviewRouting: ROUTING_ENVELOPE,
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.equal(ctx.prd.id, PRD_ID);
    assert.equal(ctx.techSpec.id, TECH_SPEC_ID);
    // In default (budgeted) mode the body slot is null and a summary
    // is provided; in `fullContext: true` mode the verbatim body is
    // restored. Both behaviors are preserved by Story #2801.
    assert.ok('body' in ctx.prd && 'body' in ctx.techSpec);
    const fullCtx = await buildDecompositionContext(
      EPIC_ID,
      provider,
      { planning: { maxTickets: 60 } },
      { fullContext: true },
    );
    assert.equal(fullCtx.prd.body, PRD_BODY);
    assert.equal(fullCtx.techSpec.body, TECH_SPEC_BODY);
  });

  it('preserves the resolved maxTickets reviewability budget (AC #3)', async () => {
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        planningRisk: RISK_ENVELOPE,
        reviewRouting: ROUTING_ENVELOPE,
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 42 },
    });
    assert.equal(ctx.maxTickets, 42);
  });

  it('does not remove or rename existing context fields (Tech Spec AC)', async () => {
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        planningRisk: RISK_ENVELOPE,
        reviewRouting: ROUTING_ENVELOPE,
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    for (const key of [
      'epic',
      'prd',
      'techSpec',
      'heuristics',
      'systemPrompt',
      'maxTickets',
      'contextMode',
    ]) {
      assert.ok(
        key in ctx,
        `legacy context field "${key}" must remain present`,
      );
    }
  });

  it('emits a context that round-trips through JSON.stringify in both modes', async () => {
    // Tech Spec AC: "context remains valid JSON for compact and pretty
    // emit modes." Cycle-free JSON output is the practical contract.
    const provider = buildProvider({
      planStateBody: planStateCommentBody({
        planningRisk: RISK_ENVELOPE,
        reviewRouting: ROUTING_ENVELOPE,
      }),
    });
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    const compact = JSON.stringify(ctx);
    const pretty = JSON.stringify(ctx, null, 2);
    assert.ok(compact.length > 0);
    assert.ok(pretty.length > compact.length);
    const reparsed = JSON.parse(compact);
    assert.deepEqual(reparsed.planningRisk, RISK_ENVELOPE);
    assert.deepEqual(reparsed.reviewRouting, ROUTING_ENVELOPE);
  });
});
