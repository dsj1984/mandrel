/**
 * tests/scripts/epic-plan.spec-flow.test.js — Story #1498 / Task #1528.
 *
 * End-to-end integration test for the rewritten /epic-plan persist
 * halves. Locks in the AC for the spec-write + reconcile pipeline:
 *
 *   - `runDecomposePhase` no longer calls `provider.createTicket`
 *     directly — instead it renders a spec, writes the YAML, and
 *     spawns `epic-reconcile.js --apply --yes`.
 *   - The persisted spec validates against
 *     `.agents/schemas/epic-spec.schema.json` (round-trippable via
 *     `loadSpec`).
 *   - The reconciler's apply path writes `<epicId>.state.json` with
 *     one mapping entry per spec slug.
 *   - The spawned reconciler child process exits 0 on a clean apply.
 *
 * Strategy: drive `runDecomposePhase` through a stub `ITicketingProvider`
 * over a fixture Epic, inject a stub `spawnSync` that proxies the
 * apply through the in-process `runReconcile` (same wire shape as the
 * real CLI, just without a child process), and assert the spec + state
 * artefacts on disk. We separately verify the real CLI's exit-code
 * contract via the `epic-reconcile.cli.test.js` suite — this test
 * focuses on the wiring between the two halves.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import yaml from 'js-yaml';
import { runDecomposePhase } from '../../.agents/scripts/epic-plan-decompose.js';
import {
  planEpic,
  resolveAcceptancePersistence,
  runSpecPhase,
} from '../../.agents/scripts/epic-plan-spec.js';
import {
  EXIT_CODES,
  runReconcile,
} from '../../.agents/scripts/epic-reconcile.js';
import { ACCEPTANCE_NA } from '../../.agents/scripts/lib/label-constants.js';
import { resolveReviewRouting } from '../../.agents/scripts/lib/orchestration/plan-review-routing.js';
import { classifyPlanningRisk } from '../../.agents/scripts/lib/orchestration/planning-risk.js';
import { PlanningStateManager } from '../../.agents/scripts/lib/orchestration/planning-state-manager.js';
import {
  loadSpec,
  loadState,
  writeSpec,
} from '../../.agents/scripts/lib/spec/index.js';

const EPIC_ID = 9998;

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'epic-plan-spec-flow-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Build a minimal in-memory provider that mimics the
 * `ITicketingProvider` surface the reconciler apply path consumes.
 *
 * Holds an in-memory issue table and a slug-counter so synthetic
 * Create/Update/Close ops can resolve without GH.
 */
function buildStubProvider({ epicId, epicTitle }) {
  let nextId = epicId + 1;
  let nextCommentId = 1000;
  const issues = new Map();
  const comments = new Map(); // issueId → Array<{id, body}>
  issues.set(epicId, {
    id: epicId,
    title: epicTitle,
    body: '',
    labels: ['type::epic'],
    state: 'open',
    linkedIssues: { prd: epicId + 100, techSpec: epicId + 200 },
  });
  const calls = {
    createTicket: 0,
    updateTicket: 0,
    getTickets: 0,
    upsertComment: 0,
  };
  return {
    issues,
    comments,
    calls,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets(_parentId) {
      calls.getTickets += 1;
      return Array.from(issues.values()).filter((t) => t.id !== epicId);
    },
    async createTicket(parentId, payload) {
      calls.createTicket += 1;
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
      calls.updateTicket += 1;
      const cur = issues.get(id) ?? { id };
      if (patch.title) cur.title = patch.title;
      if (patch.body !== undefined) cur.body = patch.body;
      if (Array.isArray(patch.labels)) cur.labels = patch.labels;
      if (
        patch.labels &&
        typeof patch.labels === 'object' &&
        !Array.isArray(patch.labels)
      ) {
        const existing = new Set(cur.labels ?? []);
        for (const add of patch.labels.add ?? []) existing.add(add);
        for (const rm of patch.labels.remove ?? []) existing.delete(rm);
        cur.labels = Array.from(existing);
      }
      if (patch.state) cur.state = patch.state;
      issues.set(id, cur);
      return cur;
    },
    async getTicketComments(id) {
      return comments.get(id) ?? [];
    },
    async createComment(id, body) {
      calls.upsertComment += 1;
      const cid = nextCommentId++;
      const arr = comments.get(id) ?? [];
      arr.push({ id: cid, body });
      comments.set(id, arr);
      return { id: cid, body };
    },
    async postComment(id, payload) {
      calls.upsertComment += 1;
      const cid = nextCommentId++;
      const arr = comments.get(id) ?? [];
      const body = typeof payload === 'string' ? payload : payload.body;
      arr.push({ id: cid, body });
      comments.set(id, arr);
      return { id: cid, body };
    },
    async deleteComment(commentId) {
      for (const [k, arr] of comments.entries()) {
        const idx = arr.findIndex((c) => c.id === commentId);
        if (idx >= 0) {
          arr.splice(idx, 1);
          comments.set(k, arr);
          return true;
        }
      }
      return false;
    },
    async updateComment(_issueId, commentId, body) {
      calls.upsertComment += 1;
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
    async addSubIssue(_parentId, _childId) {
      return { ok: true };
    },
    async removeSubIssue(_parentId, _childId) {
      return { ok: true };
    },
    primeTicketCache() {},
  };
}

/**
 * Tickets fixture covering the minimum spec shape the renderer accepts:
 * one Feature, two Stories (one with an inter-Story dep), two Tasks.
 */
function buildFixtureTickets() {
  return [
    {
      slug: 'feature-a',
      type: 'feature',
      title: 'Feature A',
      body: 'A test feature.',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'story-one',
      type: 'story',
      title: 'Story One',
      body: 'First story.',
      labels: ['type::story'],
      parent_slug: 'feature-a',
      depends_on: [],
    },
    {
      slug: 'story-two',
      type: 'story',
      title: 'Story Two',
      body: 'Second story (depends on first).',
      labels: ['type::story'],
      parent_slug: 'feature-a',
      depends_on: ['story-one'],
    },
    {
      slug: 'task-one',
      type: 'task',
      title: 'Task One',
      body: {
        goal: 'do thing',
        changes: ['package.json: change a thing'],
        acceptance: ['thing done'],
        verify: ['npm test'],
      },
      labels: ['type::task'],
      parent_slug: 'story-one',
      depends_on: [],
    },
    {
      slug: 'task-two',
      type: 'task',
      title: 'Task Two',
      body: {
        goal: 'do another thing',
        changes: ['package.json: change another thing'],
        acceptance: ['another thing done'],
        verify: ['npm test'],
      },
      labels: ['type::task'],
      parent_slug: 'story-two',
      depends_on: [],
    },
  ];
}

describe('epic-plan spec-flow integration', () => {
  it('renders + writes the spec yaml and invokes the reconciler child process', async () => {
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicTitle: 'Spec Flow Test Epic',
    });
    const tickets = buildFixtureTickets();

    // Stub spawnSync — record the args + return a clean exit. The
    // reconciler's real CLI is exercised by `runReconcile` below; this
    // assertion locks in the wire-shape (path + flags) the rewired
    // persist half emits.
    const spawnCalls = [];
    const stubSpawnSync = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };

    // writeSpecFn override threads the test-only epicsDir so the
    // sandbox stays under /tmp.
    const writeSpecOverride = (epicId, spec) =>
      writeSpec(epicId, spec, { epicsDir });

    const result = await runDecomposePhase(
      EPIC_ID,
      provider,
      { tickets },
      {},
      {
        spawnSync: stubSpawnSync,
        writeSpecFn: writeSpecOverride,
        skipHealthcheck: true,
      },
    );

    // Spec yaml exists + validates via loadSpec.
    const specPath = path.join(epicsDir, `${EPIC_ID}.yaml`);
    const reloaded = loadSpec(EPIC_ID, { epicsDir });
    assert.equal(reloaded.epic.id, EPIC_ID);
    assert.equal(reloaded.epic.title, 'Spec Flow Test Epic');
    assert.equal(reloaded.features.length, 1);
    assert.equal(reloaded.features[0].stories.length, 2);

    // Reconciler was spawned with the canonical flag set.
    assert.equal(spawnCalls.length, 1);
    const call = spawnCalls[0];
    assert.ok(/epic-reconcile\.js$/.test(call.args[0]), 'reconcile CLI path');
    assert.equal(call.args[1], String(EPIC_ID));
    assert.ok(call.args.includes('--apply'));
    assert.ok(call.args.includes('--yes'));

    // The persist half no longer touches createTicket directly — the
    // reconciler is the canonical writer. (createTicket may be reached
    // *through* the spawned reconciler, but our stub spawn intercepted
    // it so the call count is the persist-half's own.)
    assert.equal(provider.calls.createTicket, 0);

    // Epic flipped to agent::ready after the apply.
    const finalEpic = await provider.getEpic(EPIC_ID);
    assert.ok(finalEpic.labels.includes('agent::ready'));

    // Result envelope carries the reconcile status + spec path.
    assert.equal(result.reconcile.status, 0);
    assert.ok(result.specPath.endsWith(`${EPIC_ID}.yaml`));
    assert.ok(specPath);
  });

  it("reconciler's apply path writes state.json with one entry per spec slug", async () => {
    // Set up: render + write a spec into the sandbox, then drive
    // `runReconcile` directly against a stub provider/state-writer.
    // This locks in the contract that the reconciler-side actually
    // persists per-slug state mappings, which is the AC the e2e flow
    // depends on.
    const tickets = buildFixtureTickets();
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicTitle: 'Spec Flow Test Epic',
    });

    // Render + write the spec into the sandbox.
    const { renderSpec } = await import(
      '../../.agents/scripts/lib/orchestration/spec-renderer.js'
    );
    const spec = renderSpec(tickets, {
      epic: { id: EPIC_ID, title: 'Spec Flow Test Epic' },
    });
    writeSpec(EPIC_ID, spec, { epicsDir });

    // Verify the spec is well-formed YAML on disk.
    const specPath = path.join(epicsDir, `${EPIC_ID}.yaml`);
    const raw = readFileSync(specPath, 'utf8');
    const parsed = yaml.load(raw);
    assert.equal(parsed.epic.id, EPIC_ID);

    // Drive runReconcile in --apply --yes mode with the in-memory
    // provider. The default loaders read .agents/epics relative to the
    // module location, so override loaderOpts to point at the sandbox
    // epicsDir. The `apply` collaborator is also overridden so its
    // writeState lands inside the sandbox (the upstream apply() does
    // not currently surface a writeStateOpts pass-through via the CLI
    // surface; injection is the test-friendly seam).
    const { apply: applyFn } = await import(
      '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-apply.js'
    );
    const stdout = [];
    const stderr = [];
    const { exitCode, applyResult } = await runReconcile(
      {
        epicId: EPIC_ID,
        dryRun: false,
        apply: true,
        explicitDelete: false,
        yes: true,
      },
      {
        provider,
        loaderOpts: { epicsDir },
        apply: (plan, prov, opts) =>
          applyFn(plan, prov, { ...opts, writeStateOpts: { epicsDir } }),
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        isTty: () => false,
      },
    );

    // Exit code 0 → clean apply.
    assert.equal(
      exitCode,
      EXIT_CODES.OK,
      `expected exit 0 (got ${exitCode}). stderr:\n${stderr.join('\n')}`,
    );

    // state.json on disk carries an entry per spec slug.
    const state = loadState(EPIC_ID, { epicsDir });
    assert.ok(
      state.mapping && typeof state.mapping === 'object',
      'state.mapping must be present',
    );
    // Spec slugs are: feature-a, story-one, story-two, task-one, task-two.
    const expectedSlugs = [
      'feature-a',
      'story-one',
      'story-two',
      'task-one',
      'task-two',
    ];
    for (const slug of expectedSlugs) {
      assert.ok(
        slug in state.mapping,
        `expected state.mapping to carry slug "${slug}". got: ${Object.keys(state.mapping).join(', ')}`,
      );
      assert.ok(
        Number.isInteger(state.mapping[slug].issueNumber),
        `state.mapping["${slug}"].issueNumber must be an integer`,
      );
    }

    // Sanity: the apply created child issues for the new slugs (the
    // reconciler's apply path is the new canonical writer).
    assert.ok(
      provider.calls.createTicket > 0,
      'reconciler.apply must create issues',
    );
    assert.ok(applyResult, 'applyResult envelope must be returned');
  });
});

/**
 * Build a minimal provider for Phase 7 persist-half tests. Tracks created
 * tickets and label/body mutations on the Epic in memory.
 */
function buildPlanEpicProvider(epicShape = {}) {
  let nextId = 600;
  const epic = {
    id: 6000,
    title: epicShape.title ?? 'Test Epic',
    body: epicShape.body ?? '',
    labels: epicShape.labels ?? ['type::epic'],
    linkedIssues: { prd: null, techSpec: null, acceptanceSpec: null },
  };
  const createdTickets = [];
  const updatedTickets = [];

  const provider = {
    epic,
    createdTickets,
    updatedTickets,
    async getEpic() {
      return epic;
    },
    async getTickets() {
      return [];
    },
    async createTicket(epicId, ticketData) {
      const id = nextId++;
      createdTickets.push({ epicId, ticketData, id });
      return { id, url: `https://stub/issues/${id}` };
    },
    async updateTicket(id, mutations) {
      updatedTickets.push({ id, mutations });
      if (id !== epic.id) return;
      if (mutations.body !== undefined) epic.body = mutations.body;
      if (mutations.labels) {
        const existing = new Set(epic.labels ?? []);
        for (const add of mutations.labels.add ?? []) existing.add(add);
        for (const rm of mutations.labels.remove ?? []) existing.delete(rm);
        epic.labels = Array.from(existing);
      }
    },
    primeTicketCache() {},
  };

  return provider;
}

/**
 * Provider for runSpecPhase tests — extends the plan-epic stub with
 * structured-comment I/O used by epic-plan-state-store.
 */
function buildRunSpecPhaseProvider(epicShape = {}) {
  let commentId = 9000;
  const comments = new Map();
  const base = buildPlanEpicProvider(epicShape);

  return {
    ...base,
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const comment = { id: commentId++, body: payload.body };
      list.push(comment);
      comments.set(ticketId, list);
      return comment;
    },
    async deleteComment(id) {
      for (const [, list] of comments) {
        const idx = list.findIndex((entry) => entry.id === id);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
}

describe('review routing — Story #2795', () => {
  it('high-risk runSpecPhase records review-required routing in checkpoint', async () => {
    const provider = buildRunSpecPhaseProvider({
      title: 'Adaptive planning gate routing',
      body: 'Changes /epic-plan gate behavior and acceptance-spec creation.',
    });

    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        prdContent: '## Overview\nPRD.',
        techSpecContent: '## Technical Overview\nNo stale paths here.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
    );

    assert.equal(result.planningRisk.requiresReview, true);
    assert.equal(result.reviewRouting.decision, 'review-required');
    assert.equal(result.reviewRouting.requiresStop, true);
    assert.equal(result.checkpoint.reviewRouting.decision, 'review-required');
    assert.equal(result.checkpoint.reviewRouting.requiresStop, true);
    assert.ok(provider.epic.labels.includes('agent::review-spec'));
  });

  it('low-risk runSpecPhase records auto-proceed routing in checkpoint', async () => {
    const provider = buildRunSpecPhaseProvider({
      title: 'Docs-only readme cleanup',
      body: 'Documentation-only prose cleanup.',
    });

    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        prdContent: '## Overview\nPRD.',
        techSpecContent: '## Technical Overview\nNo stale paths here.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
    );

    assert.equal(result.planningRisk.requiresReview, false);
    assert.equal(result.reviewRouting.decision, 'auto-proceed');
    assert.equal(result.reviewRouting.requiresStop, false);
    assert.equal(result.checkpoint.reviewRouting.decision, 'auto-proceed');
    assert.match(result.reviewRouting.operatorMessage, /auto-proceed/i);
  });

  it('operator override forces review stop on a low-risk Epic', async () => {
    const planningRisk = classifyPlanningRisk({
      title: 'Docs-only readme cleanup',
      body: 'Documentation-only prose cleanup.',
      labels: ['type::epic'],
    });
    const routing = resolveReviewRouting({ planningRisk, forceReview: true });

    assert.equal(routing.decision, 'operator-override-review');
    assert.equal(routing.requiresStop, true);

    const provider = buildRunSpecPhaseProvider({
      title: 'Docs-only readme cleanup',
      body: 'Documentation-only prose cleanup.',
    });
    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        prdContent: '## Overview\nPRD.',
        techSpecContent: '## Technical Overview\nNo stale paths here.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      { forceReview: true },
    );

    assert.equal(result.reviewRouting.decision, 'operator-override-review');
    assert.equal(result.reviewRouting.requiresStop, true);
    assert.equal(result.checkpoint.reviewRouting.forceReviewApplied, true);
  });
});

describe('acceptance disposition persistence — Story #2792', () => {
  it('resolveAcceptancePersistence routes required disposition to acceptance-spec', () => {
    const verdict = resolveAcceptancePersistence(
      {
        title: 'Security and billing rollout',
        body: 'User-facing security changes with Stripe billing.',
        labels: ['type::epic'],
      },
      '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    );

    assert.equal(verdict.planningRisk.acceptanceDisposition, 'required');
    assert.equal(verdict.wantsAcceptanceSpec, true);
    assert.equal(verdict.applyAcceptanceWaiver, false);
  });

  it('resolveAcceptancePersistence routes not-applicable disposition to waiver', () => {
    const verdict = resolveAcceptancePersistence(
      {
        title: 'Docs-only readme cleanup',
        body: 'Documentation-only prose cleanup.',
        labels: ['type::epic'],
      },
      '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    );

    assert.equal(verdict.planningRisk.acceptanceDisposition, 'not-applicable');
    assert.equal(verdict.wantsAcceptanceSpec, false);
    assert.equal(verdict.applyAcceptanceWaiver, true);
  });

  it('required disposition creates and links context::acceptance-spec', async () => {
    const provider = buildPlanEpicProvider({
      title: 'Adaptive planning gate routing',
      body: 'Changes /epic-plan gate behavior and acceptance-spec creation.',
    });

    await planEpic(provider.epic.id, provider, {
      prdContent: '## Overview\nPRD.',
      techSpecContent: '## Technical Overview\nTS.',
      acceptanceSpecContent:
        '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    });

    assert.equal(provider.createdTickets.length, 3);
    assert.deepEqual(provider.createdTickets[2].ticketData.labels, [
      'context::acceptance-spec',
    ]);
    const epicUpdate = provider.updatedTickets.find(
      (entry) => entry.id === provider.epic.id,
    );
    assert.ok(epicUpdate.mutations.body.includes('Acceptance Spec'));
    assert.ok(
      !(epicUpdate.mutations.labels?.add ?? []).includes(ACCEPTANCE_NA),
    );
  });

  it('not-applicable disposition applies acceptance::n-a and skips acceptance-spec', async () => {
    const provider = buildPlanEpicProvider({
      title: 'Internal refactor cleanup',
      body: 'Internal refactor only — docs-only housekeeping.',
    });

    await planEpic(provider.epic.id, provider, {
      prdContent: '## Overview\nPRD.',
      techSpecContent: '## Technical Overview\nTS.',
      acceptanceSpecContent:
        '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    });

    assert.equal(
      provider.createdTickets.length,
      2,
      'must not create acceptance-spec when disposition is not-applicable',
    );
    const epicUpdate = provider.updatedTickets.find(
      (entry) => entry.id === provider.epic.id,
    );
    assert.ok((epicUpdate.mutations.labels?.add ?? []).includes(ACCEPTANCE_NA));
    assert.ok(!epicUpdate.mutations.body.includes('Acceptance Spec'));
    assert.ok(provider.epic.labels.includes(ACCEPTANCE_NA));

    const mgr = new PlanningStateManager({
      async getTicket(id) {
        if (id === provider.epic.id) {
          return {
            id: provider.epic.id,
            labels: provider.epic.labels,
            body: provider.epic.body,
          };
        }
        const created = provider.createdTickets.find((t) => t.id === id);
        if (!created) return null;
        return {
          id,
          labels: created.ticketData.labels,
          state: 'closed',
        };
      },
      async getTickets() {
        return provider.createdTickets.map((t) => ({
          id: t.id,
          labels: t.ticketData.labels,
          state: 'closed',
        }));
      },
      primeTicketCache() {},
    });
    const verdict = await mgr.computeReviewReadiness(provider.epic.id);
    assert.strictEqual(verdict.ready, true);
    assert.strictEqual(verdict.reason, 'acceptance-waived');
    assert.strictEqual(verdict.contexts.acceptanceSpec, 'waived');
  });
});
