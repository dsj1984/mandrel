/**
 * tests/scripts/plan-persist.checkpoint-consumers.test.js — Epic #4474 PR3.
 *
 * Regression receipts for the design's non-negotiable 1: the checkpoint the
 * collapsed persist surface writes at schema v2 MUST be readable, without
 * modification, by all four delivery-time consumers of `epic-plan-state`
 * (#4474 design §3 consumer table):
 *
 *   1. `lib/orchestration/code-review.js` — `resolveReviewDepthForEpic`
 *      inherits `planningRisk.overallLevel` as the review depth;
 *   2. `epic-audit-prepare.js` — `resolveRiskRoutedLenses` routes audit
 *      lenses off `planningRisk.axes`;
 *   3. `story-close/phases/locked-pipeline.js` —
 *      `resolveParentEpicPlanningRisk` inherits the parent Epic's envelope;
 *   4. the decompose context reader — `buildDecompositionContext` surfaces
 *      `planningRisk` / `reviewRouting` verbatim.
 *
 * Each test exercises the consumer's ACTUAL exported read path against a
 * checkpoint produced by the real v2 writer (`writeCheckpointV2`) over a
 * mock provider — a true round-trip, not a hand-built fixture.
 *
 * The file also re-proves the ≥60-ticket rate-limit recovery path (#4474
 * PR3 risk register): a crash partway through a 65-ticket creation persists
 * per-slug state, and the resume apply creates ONLY the missing slugs.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { resolveRiskRoutedLenses } from '../../.agents/scripts/epic-audit-prepare.js';
import {
  EXIT_CODES,
  runReconcile,
} from '../../.agents/scripts/epic-reconcile.js';
import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
import { resolveReviewDepthForEpic } from '../../.agents/scripts/lib/orchestration/code-review.js';
import { buildDecompositionContext } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/context.js';
import { read as readPlanState } from '../../.agents/scripts/lib/orchestration/epic-plan-state-store.js';
import { apply as applyFn } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-apply.js';
import { writeCheckpointV2 } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { renderSpec } from '../../.agents/scripts/lib/orchestration/spec-renderer.js';
import { resolveParentEpicPlanningRisk } from '../../.agents/scripts/lib/orchestration/story-close/phases/locked-pipeline.js';
import { loadState, writeSpec } from '../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 9966;

const EPIC_BODY = upsertEpicSection(
  '## Context\nConsumer round-trip fixture.\n',
  'techSpec',
  '## Delivery Slicing\n\nFixture spec content.',
);

/** High-risk envelope so every consumer resolves a non-default value. */
const PLANNING_RISK = {
  axes: [
    {
      axis: 'critical-workflow',
      level: 'high',
      rationale: 'Touches the /plan gate routing.',
    },
  ],
  overallLevel: 'high',
  requiresReview: true,
  acceptanceDisposition: 'required',
  gateDecision: 'review-required',
};

const RISK_VERDICT = {
  axes: [
    {
      axis: 'critical-workflow',
      level: 'high',
      rationale: 'Touches the /plan gate routing.',
    },
  ],
  summary: 'High-risk fixture verdict.',
};

const REVIEW_ROUTING = {
  decision: 'review-required',
  requiresStop: true,
  forceReviewApplied: false,
};

/** Minimal comment-capable provider (the surface the checkpoint store uses). */
function buildProvider() {
  const comments = new Map();
  let nextCommentId = 1;
  const epic = {
    id: EPIC_ID,
    title: 'Consumer Round-Trip Epic',
    body: EPIC_BODY,
    labels: ['type::epic'],
    state: 'open',
  };
  return {
    async getEpic(id) {
      return id === EPIC_ID ? epic : null;
    },
    async getTicket(id) {
      return id === EPIC_ID ? epic : null;
    },
    async getTicketComments(id) {
      return comments.get(id) ?? [];
    },
    async createComment(id, body) {
      const cid = nextCommentId++;
      const arr = comments.get(id) ?? [];
      arr.push({ id: cid, body });
      comments.set(id, arr);
      return { id: cid, body };
    },
    async postComment(id, payload) {
      const body = typeof payload === 'string' ? payload : payload.body;
      return this.createComment(id, body);
    },
    async updateComment(_issueId, commentId, body) {
      for (const arr of comments.values()) {
        for (const c of arr) {
          if (c.id === commentId) {
            c.body = body;
            return c;
          }
        }
      }
      return null;
    },
  };
}

describe('plan-persist checkpoint v2 — four-consumer round-trip (#4474 §3)', () => {
  /** @type {ReturnType<typeof buildProvider>} */
  let provider;

  beforeEach(async () => {
    provider = buildProvider();
    // The real v2 writer, exactly as runPlanPersist invokes it.
    await writeCheckpointV2(provider, EPIC_ID, {
      planningRisk: PLANNING_RISK,
      riskVerdict: RISK_VERDICT,
      reviewRouting: REVIEW_ROUTING,
      spec: {
        techSpecPersisted: true,
        acceptanceTable: 'persisted',
        completedAt: new Date().toISOString(),
      },
      persist: { mode: 'fan-out', cli: 'plan-persist', completedAt: null },
    });
  });

  it('writes version 2 with the v1-byte-compatible consumer fields', async () => {
    const state = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(state.version, 2);
    assert.deepEqual(state.planningRisk, PLANNING_RISK);
    assert.deepEqual(state.reviewRouting, REVIEW_ROUTING);
  });

  it('consumer 1 — code-review.js resolveReviewDepthForEpic inherits the judged risk', async () => {
    const depth = await resolveReviewDepthForEpic({
      epicId: EPIC_ID,
      provider,
    });
    assert.equal(depth, 'deep', 'high overallLevel must resolve deep review');
  });

  it('consumer 2 — epic-audit-prepare.js resolveRiskRoutedLenses reads the axes', async () => {
    // Inject the lens mapper so the assertion pins the READ path (the
    // checkpoint's planningRisk reaches the mapper verbatim) rather than
    // the lens vocabulary.
    const received = [];
    const lenses = await resolveRiskRoutedLenses({
      epicId: EPIC_ID,
      provider,
      resolveAuditLenses: (envelope) => {
        received.push(envelope);
        return envelope.axes.map((a) => a.axis);
      },
    });
    assert.deepEqual(lenses, ['critical-workflow']);
    assert.deepEqual(received[0], PLANNING_RISK);
  });

  it('consumer 3 — locked-pipeline.js resolveParentEpicPlanningRisk inherits the envelope', async () => {
    const envelope = await resolveParentEpicPlanningRisk({
      provider,
      epicId: EPIC_ID,
    });
    assert.deepEqual(envelope, PLANNING_RISK);
  });

  it('consumer 4 — the decompose context reader surfaces planningRisk/reviewRouting verbatim', async () => {
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.deepEqual(ctx.planningRisk, PLANNING_RISK);
    assert.deepEqual(ctx.reviewRouting, REVIEW_ROUTING);
  });

  it('the v1 persist writers still read/extend a v2 checkpoint (delegate-release compat)', async () => {
    // The one-release delegates (epic-plan-spec/-decompose) merge-write the
    // same comment. Their reader is the shared `read`; a v2 checkpoint must
    // round-trip through it without loss.
    const state = await readPlanState({ provider, epicId: EPIC_ID });
    assert.ok(state, 'v1 reader parses the v2 checkpoint');
    assert.equal(state.spec.acceptanceTable, 'persisted');
  });
});

describe('plan-persist checkpoint v2 — single-mode fixture round-trip (#4474 PR4)', () => {
  /** @type {ReturnType<typeof buildProvider>} */
  let provider;

  beforeEach(async () => {
    provider = buildProvider();
    // The single-delivery persist variant: decompose is a DELIBERATE
    // zero-ticket single-shape block (never an absence delivery-time
    // consumers could misread as unplanned).
    await writeCheckpointV2(provider, EPIC_ID, {
      planningRisk: PLANNING_RISK,
      riskVerdict: {
        ...RISK_VERDICT,
        deliveryShape: 'single',
        deliveryShapeRationale: 'Pure dependent chain — one-pass-sized.',
      },
      reviewRouting: REVIEW_ROUTING,
      spec: {
        techSpecPersisted: true,
        acceptanceTable: 'persisted',
        completedAt: new Date().toISOString(),
      },
      decompose: {
        ticketCount: 0,
        shape: 'single',
        completedAt: new Date().toISOString(),
      },
      persist: { mode: 'single', cli: 'plan-persist', completedAt: null },
    });
  });

  it('records the deliberate zero-ticket single-shape decompose block', async () => {
    const state = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(state.decompose.ticketCount, 0);
    assert.equal(state.decompose.shape, 'single');
    assert.ok(state.decompose.completedAt, 'planned, not unplanned');
  });

  it('consumer 1 — code-review.js resolves review depth off the single-mode checkpoint', async () => {
    const depth = await resolveReviewDepthForEpic({
      epicId: EPIC_ID,
      provider,
    });
    assert.equal(depth, 'deep');
  });

  it('consumer 2 — epic-audit-prepare.js routes lenses off the single-mode checkpoint', async () => {
    const lenses = await resolveRiskRoutedLenses({
      epicId: EPIC_ID,
      provider,
      resolveAuditLenses: (envelope) => envelope.axes.map((a) => a.axis),
    });
    assert.deepEqual(lenses, ['critical-workflow']);
  });

  it('consumer 3 — locked-pipeline.js inherits the envelope from the single-mode checkpoint', async () => {
    const envelope = await resolveParentEpicPlanningRisk({
      provider,
      epicId: EPIC_ID,
    });
    assert.deepEqual(envelope, PLANNING_RISK);
  });

  it('consumer 4 — the decompose context reader surfaces the single-mode fields verbatim', async () => {
    const ctx = await buildDecompositionContext(EPIC_ID, provider, {
      planning: { maxTickets: 60 },
    });
    assert.deepEqual(ctx.planningRisk, PLANNING_RISK);
    assert.deepEqual(ctx.reviewRouting, REVIEW_ROUTING);
  });
});

describe('plan-persist — ≥60-ticket rate-limit recovery re-proof (#4474 PR3 risk)', () => {
  let sandbox;
  let epicsDir;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-recovery-'));
    epicsDir = path.join(sandbox, '.agents', 'epics');
  });

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  const TICKET_COUNT = 65;
  const FAIL_AFTER = 40;

  function buildManyTickets() {
    return Array.from({ length: TICKET_COUNT }, (_, i) => {
      const n = i + 1;
      return {
        slug: `story-${String(n).padStart(2, '0')}`,
        type: 'story',
        title: `Recovery Story ${n}`,
        body: serialize({
          goal: `Recovery story ${n}.`,
          changes: [
            {
              path: 'tests/scripts/epic-plan.spec-flow.test.js',
              assumption: 'refactors-existing',
            },
          ],
          acceptance: [`thing ${n} done`],
          verify: ['npm test (validate)'],
        }),
        labels: ['type::story'],
        depends_on: [],
        acceptance: [`thing ${n} done`],
        verify: ['npm test (validate)'],
      };
    });
  }

  function buildRateLimitedProvider() {
    let nextId = EPIC_ID + 1;
    const issues = new Map();
    issues.set(EPIC_ID, {
      id: EPIC_ID,
      title: 'Recovery Epic',
      body: EPIC_BODY,
      labels: ['type::epic'],
      state: 'open',
    });
    const provider = {
      issues,
      createCalls: 0,
      failAfter: Number.POSITIVE_INFINITY,
      async getEpic(id) {
        return issues.get(id);
      },
      async getTicket(id) {
        return issues.get(id);
      },
      async getSubTickets() {
        return Array.from(issues.values()).filter((t) => t.id !== EPIC_ID);
      },
      async getTickets() {
        return Array.from(issues.values()).filter((t) => t.id !== EPIC_ID);
      },
      async createTicket(parentId, payload) {
        provider.createCalls += 1;
        if (provider.createCalls > provider.failAfter) {
          throw new Error('HTTP 403: API rate limit exceeded (fixture)');
        }
        const id = nextId++;
        issues.set(id, {
          id,
          parentId,
          title: payload.title,
          body: payload.body ?? '',
          labels: payload.labels ?? [],
          state: 'open',
        });
        return { id, url: `https://stub/issues/${id}` };
      },
      async updateTicket(id, patch) {
        const cur = issues.get(id) ?? { id };
        Object.assign(cur, patch.title ? { title: patch.title } : {});
        if (patch.body !== undefined) cur.body = patch.body;
        if (patch.state) cur.state = patch.state;
        issues.set(id, cur);
        return cur;
      },
      async getTicketComments() {
        return [];
      },
      async createComment(_id, body) {
        return { id: 1, body };
      },
      async addSubIssue() {
        return { ok: true };
      },
      async removeSubIssue() {
        return { ok: true };
      },
      primeTicketCache() {},
    };
    return provider;
  }

  it('a crash mid-creation persists per-slug state; resume creates ONLY the missing slugs', async () => {
    const tickets = buildManyTickets();
    const spec = renderSpec(tickets, {
      epic: { id: EPIC_ID, title: 'Recovery Epic' },
    });
    writeSpec(EPIC_ID, spec, { epicsDir });

    const provider = buildRateLimitedProvider();
    provider.failAfter = FAIL_AFTER;

    const collab = {
      provider,
      loaderOpts: { epicsDir },
      apply: (plan, prov, opts) =>
        applyFn(plan, prov, {
          ...opts,
          writeStateOpts: { epicsDir },
          // Serial creation so the crash point is deterministic.
          concurrency: 1,
        }),
      stdout: () => {},
      stderr: () => {},
      isTty: () => false,
    };

    // ---- First run: rate-limit crash after FAIL_AFTER creations. ----
    const first = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: false,
        yes: true,
      },
      collab,
    );
    assert.notEqual(
      first.exitCode,
      EXIT_CODES.OK,
      'partial failure exits non-zero',
    );
    assert.equal(
      provider.createCalls,
      FAIL_AFTER + 1,
      'stopped at the rate limit',
    );

    // Per-slug state persisted for exactly the completed creations —
    // the lossless-resume ledger. (The projected state carries an entry
    // per spec slug; only completed creations carry an issueNumber.)
    const midState = loadState(EPIC_ID, { epicsDir });
    const mappedSlugs = Object.entries(midState.mapping ?? {}).filter(
      ([slug, entry]) =>
        slug.startsWith('story-') && Number.isInteger(entry?.issueNumber),
    );
    assert.equal(
      mappedSlugs.length,
      FAIL_AFTER,
      `state.json must map exactly the ${FAIL_AFTER} created slugs`,
    );

    // ---- Resume run: rate limit lifted. ----
    provider.failAfter = Number.POSITIVE_INFINITY;
    const createsBeforeResume = provider.createCalls;
    const second = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: false,
        yes: true,
      },
      collab,
    );
    assert.equal(
      second.exitCode,
      EXIT_CODES.OK,
      'resume apply completes cleanly',
    );
    const resumedCreates = provider.createCalls - createsBeforeResume;
    assert.equal(
      resumedCreates,
      TICKET_COUNT - FAIL_AFTER,
      'resume creates ONLY the missing slugs — idempotent per-slug creation',
    );

    // Every slug mapped with an issue number; no duplicates among live issues.
    const finalState = loadState(EPIC_ID, { epicsDir });
    const finalSlugs = Object.entries(finalState.mapping ?? {}).filter(
      ([slug, entry]) =>
        slug.startsWith('story-') && Number.isInteger(entry?.issueNumber),
    );
    assert.equal(finalSlugs.length, TICKET_COUNT);
    const liveTitles = (await provider.getSubTickets()).map((t) => t.title);
    assert.equal(
      new Set(liveTitles).size,
      liveTitles.length,
      'no duplicate story issues after resume',
    );
    assert.equal(liveTitles.length, TICKET_COUNT);
  });
});
