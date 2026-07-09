/**
 * tests/scripts/epic-plan.spec-flow.test.js — Story #1498 / Task #1528.
 *
 * End-to-end integration test for the rewritten /plan persist
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
import {
  extractEpicSection,
  hasEpicSection,
  upsertEpicSection,
} from '../../.agents/scripts/lib/epic-body-sections.js';
import { ACCEPTANCE_NA } from '../../.agents/scripts/lib/label-constants.js';
import { resolveReviewRouting } from '../../.agents/scripts/lib/orchestration/plan-review-routing.js';
import { deriveRiskEnvelope } from '../../.agents/scripts/lib/orchestration/planning-risk.js';
import {
  loadSpec,
  loadState,
  writeSpec,
} from '../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 9998;

// Canonical folded Tech Spec content (Story #4324 — the Epic body carries
// the spec as a managed section opening with `## Delivery Slicing`).
const TECH_SPEC_SECTION =
  '## Delivery Slicing\n\n| Slice | What ships | Independent? |\n| --- | --- | --- |\n| S1 | the change | yes |';

// A sectioned Epic body: ideation sections plus the managed Tech Spec
// region the decomposer gate (`hasTechSpecContent`) requires.
const SECTIONED_EPIC_BODY = upsertEpicSection(
  '## Context\nEpic context.\n\n## Acceptance Criteria\n- [ ] the thing works',
  'techSpec',
  TECH_SPEC_SECTION,
);

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
    // The decompose gate keys on the Epic body carrying folded Tech Spec
    // content (Story #4324) — no linked context tickets exist anymore.
    body: SECTIONED_EPIC_BODY,
    labels: ['type::epic'],
    state: 'open',
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
    // Story #3455 — the reconciler's `fetchGhState` now enumerates the
    // Epic's children via the scoped `getSubTickets` rather than the
    // repo-wide `getTickets`. Mirror the same child set so the apply
    // path observes the live tickets it always did.
    async getSubTickets(_parentId) {
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
 * two Stories (one with an inter-Story dep). Under the 2-tier hierarchy
 * (Story #4041) Stories carry inline acceptance[] / verify[] arrays
 * directly — there is no Feature or Task tier.
 */
function buildFixtureTickets() {
  return [
    {
      slug: 'story-one',
      type: 'story',
      title: 'Story One',
      // Canonical serialized structured body — `refactors-existing` against a
      // path that exists on `main` so the freshness/assumption git probes
      // pass. The re-pointed task-body validator (Story #3906) parses this
      // back and validates the sections.
      body: serialize({
        goal: 'First story.',
        changes: [
          {
            path: 'tests/scripts/epic-plan.spec-flow.test.js',
            assumption: 'refactors-existing',
          },
        ],
        acceptance: ['thing done'],
        verify: ['npm test (validate)'],
      }),
      labels: ['type::story'],
      depends_on: [],
      acceptance: ['thing done'],
      verify: ['npm test (validate)'],
    },
    {
      slug: 'story-two',
      type: 'story',
      title: 'Story Two',
      body: serialize({
        goal: 'Second story (depends on first).',
        changes: [
          {
            path: 'tests/scripts/epic-plan.spec-flow.test.js',
            assumption: 'refactors-existing',
          },
        ],
        acceptance: ['another thing done'],
        verify: ['npm test (validate)'],
      }),
      labels: ['type::story'],
      depends_on: ['story-one'],
      acceptance: ['another thing done'],
      verify: ['npm test (validate)'],
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
    assert.equal(reloaded.stories.length, 2);

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
    // Spec slugs are: story-one, story-two (2-tier — no Feature/Task tier).
    const expectedSlugs = ['story-one', 'story-two'];
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
 * tickets, label/body mutations on the Epic, and posted comments in memory.
 */
function buildPlanEpicProvider(epicShape = {}) {
  let nextId = 600;
  const epic = {
    id: 6000,
    title: epicShape.title ?? 'Test Epic',
    body: epicShape.body ?? '',
    labels: epicShape.labels ?? ['type::epic'],
  };
  const createdTickets = [];
  const updatedTickets = [];
  const postedComments = []; // { id, payload }

  const provider = {
    epic,
    createdTickets,
    updatedTickets,
    postedComments,
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
    async postComment(id, payload) {
      postedComments.push({ id, payload });
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
    // The Epic-plan lease (acquireEpicPlanLease) reads/writes the assignee via
    // getTicket/updateTicket. The epic starts unassigned, so the lease takes an
    // unclaimed claim cleanly.
    async getTicket(id) {
      return { ...base.epic, id, assignees: base.epic.assignees ?? [] };
    },
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

// Shared opts.config carrying an operator handle so the Epic-plan lease can
// acquire (the guard fails closed without one). Reused across the runSpecPhase
// cases below.
const SPEC_LEASE_CFG = {
  github: { owner: 'o', repo: 'r', operatorHandle: '@ci' },
};

// Planner-authored risk verdicts (Epic #3865) — runSpecPhase derives the
// planningRisk envelope from these instead of regex-classifying the body.
const HIGH_RISK_VERDICT = {
  axes: [
    {
      axis: 'critical-workflow',
      level: 'high',
      rationale: 'Changes /plan gate behavior and acceptance-spec creation.',
    },
  ],
  summary: 'High-risk planning-gate change.',
};

const LOW_RISK_VERDICT = {
  axes: [
    {
      axis: 'docs-only',
      level: 'low',
      rationale: 'Documentation-only prose cleanup.',
    },
  ],
  summary: 'Docs-only cleanup.',
};

const REQUIRED_DISPOSITION_VERDICT = {
  axes: [
    {
      axis: 'security',
      level: 'high',
      rationale: 'User-facing security changes.',
    },
    {
      axis: 'billing',
      level: 'high',
      rationale: 'Touches the Stripe billing integration.',
    },
  ],
  summary: 'User-facing security and billing rollout.',
};

describe('review routing — Story #2795', () => {
  it('high-risk runSpecPhase records review-required routing in checkpoint', async () => {
    const provider = buildRunSpecPhaseProvider({
      title: 'Adaptive planning gate routing',
      body: 'Changes /plan gate behavior and acceptance-spec creation.',
    });

    const result = await runSpecPhase(
      provider.epic.id,
      provider,
      {
        techSpecContent:
          '## Delivery Slicing\n\n## Technical Overview\nNo stale paths here.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      { config: SPEC_LEASE_CFG, riskVerdict: HIGH_RISK_VERDICT },
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
        techSpecContent:
          '## Delivery Slicing\n\n## Technical Overview\nNo stale paths here.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      { config: SPEC_LEASE_CFG, riskVerdict: LOW_RISK_VERDICT },
    );

    assert.equal(result.planningRisk.requiresReview, false);
    assert.equal(result.reviewRouting.decision, 'auto-proceed');
    assert.equal(result.reviewRouting.requiresStop, false);
    assert.equal(result.checkpoint.reviewRouting.decision, 'auto-proceed');
    assert.match(result.reviewRouting.operatorMessage, /auto-proceed/i);
  });

  it('operator override forces review stop on a low-risk Epic', async () => {
    const planningRisk = deriveRiskEnvelope(LOW_RISK_VERDICT);
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
        techSpecContent:
          '## Delivery Slicing\n\n## Technical Overview\nNo stale paths here.',
      },
      { baseBranch: 'main', paths: { tempRoot: sandbox } },
      {
        forceReview: true,
        config: SPEC_LEASE_CFG,
        riskVerdict: LOW_RISK_VERDICT,
      },
    );

    assert.equal(result.reviewRouting.decision, 'operator-override-review');
    assert.equal(result.reviewRouting.requiresStop, true);
    assert.equal(result.checkpoint.reviewRouting.forceReviewApplied, true);
  });
});

describe('acceptance disposition persistence — Story #2792', () => {
  it('resolveAcceptancePersistence routes required disposition to acceptance-spec', () => {
    const verdict = resolveAcceptancePersistence(
      deriveRiskEnvelope(REQUIRED_DISPOSITION_VERDICT),
      '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    );

    assert.equal(verdict.planningRisk.acceptanceDisposition, 'required');
    assert.equal(verdict.wantsAcceptanceSpec, true);
    assert.equal(verdict.applyAcceptanceWaiver, false);
  });

  it('resolveAcceptancePersistence routes not-applicable disposition to waiver', () => {
    const verdict = resolveAcceptancePersistence(
      deriveRiskEnvelope(LOW_RISK_VERDICT),
      '## Acceptance Criteria\n| AC-1 | x | f | s | new |',
    );

    assert.equal(verdict.planningRisk.acceptanceDisposition, 'not-applicable');
    assert.equal(verdict.wantsAcceptanceSpec, false);
    assert.equal(verdict.applyAcceptanceWaiver, true);
  });

  it('required disposition persists the ## Acceptance Table managed section', async () => {
    const provider = buildPlanEpicProvider({
      title: 'Adaptive planning gate routing',
      body: 'Changes /plan gate behavior and acceptance-spec creation.',
    });

    const result = await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nTS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { planningRisk: deriveRiskEnvelope(HIGH_RISK_VERDICT) },
    );

    // No context tickets exist anymore — the section lands on the Epic body.
    assert.equal(provider.createdTickets.length, 0);
    assert.equal(result.acceptanceTable, 'persisted');
    const epicUpdate = provider.updatedTickets.find(
      (entry) => entry.id === provider.epic.id,
    );
    assert.ok(hasEpicSection(epicUpdate.mutations.body, 'acceptanceTable'));
    assert.match(
      extractEpicSection(epicUpdate.mutations.body, 'acceptanceTable'),
      /AC-1/,
    );
    assert.ok(
      !(epicUpdate.mutations.labels?.add ?? []).includes(ACCEPTANCE_NA),
    );
  });

  it('not-applicable disposition applies acceptance::n-a and skips the acceptance table', async () => {
    const provider = buildPlanEpicProvider({
      title: 'Internal refactor cleanup',
      body: 'Internal refactor only — docs-only housekeeping.',
    });

    const result = await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nTS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { planningRisk: deriveRiskEnvelope(LOW_RISK_VERDICT) },
    );

    assert.equal(
      provider.createdTickets.length,
      0,
      'must not create any tickets — planning writes are Epic-body sections',
    );
    assert.equal(result.acceptanceTable, 'waived');
    const epicUpdate = provider.updatedTickets.find(
      (entry) => entry.id === provider.epic.id,
    );
    assert.ok((epicUpdate.mutations.labels?.add ?? []).includes(ACCEPTANCE_NA));
    assert.ok(
      !hasEpicSection(epicUpdate.mutations.body, 'acceptanceTable'),
      'waived disposition must not persist an ## Acceptance Table section',
    );
    assert.ok(hasEpicSection(epicUpdate.mutations.body, 'techSpec'));
    assert.ok(provider.epic.labels.includes(ACCEPTANCE_NA));
  });
});

/**
 * Build a Phase 7 provider whose Epic already carries persisted planning
 * sections (Tech Spec + optional Acceptance Table managed regions) plus a
 * legacy `## Planning Artifacts` checklist, so the `--force`
 * overwrite-in-place path can be exercised end-to-end against the sectioned
 * Epic body (Story #4324 — no linked context tickets exist anymore).
 */
function buildOverwriteProvider({
  epicTitle = 'Test Epic',
  withAcceptanceTable = true,
  epicLabels = ['type::epic'],
} = {}) {
  // A historical body: ideation prose, the retired machine-managed
  // `## Planning Artifacts` checklist (must be stripped on persist,
  // never crash the parser), and the existing managed sections.
  let body =
    'Epic context.\n\n## Planning Artifacts\n- [ ] Tech Spec: #6200\n- [ ] Acceptance Spec: #6300\n';
  body = upsertEpicSection(body, 'techSpec', '## Delivery Slicing\nOLD TS.');
  if (withAcceptanceTable) {
    body = upsertEpicSection(
      body,
      'acceptanceTable',
      '## Acceptance Table\n| AC-1 | old outcome | f | s | new |',
    );
  }
  return buildPlanEpicProvider({ title: epicTitle, body, labels: epicLabels });
}

describe('--force overwrite-in-place — Story #3310 / #4324', () => {
  it('overwrites the managed sections in place (no ticket creates, prose preserved)', async () => {
    const provider = buildOverwriteProvider({
      epicTitle: 'Security and billing rollout',
    });

    const result = await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nNEW TS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { force: true },
    );

    // AC-1: no tickets created — planning writes are Epic-body sections.
    assert.equal(provider.createdTickets.length, 0);
    assert.equal(result.reason, 'force-replan');

    // AC-1: section contents replaced in place.
    const epicBody = provider.epic.body;
    assert.match(extractEpicSection(epicBody, 'techSpec'), /NEW TS/);
    assert.doesNotMatch(extractEpicSection(epicBody, 'techSpec'), /OLD TS/);
    assert.match(extractEpicSection(epicBody, 'acceptanceTable'), /AC-1/);

    // AC-2: content outside the managed sections is preserved…
    assert.match(epicBody, /Epic context\./);
    // …while the retired `## Planning Artifacts` checklist is stripped.
    assert.doesNotMatch(epicBody, /## Planning Artifacts/);
    assert.doesNotMatch(epicBody, /Tech Spec: #6200/);
  });

  it('AC-3: posts a single regeneration audit comment on the Epic', async () => {
    const provider = buildOverwriteProvider({
      epicTitle: 'Security and billing rollout',
    });

    await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nNEW TS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { force: true },
    );

    const regenComments = provider.postedComments.filter((c) =>
      /Regeneration Audit/.test(c.payload.body),
    );
    assert.equal(regenComments.length, 1);
    assert.equal(regenComments[0].id, provider.epic.id);
  });

  it('AC-5: present→waived strips the stale ## Acceptance Table section', async () => {
    const provider = buildOverwriteProvider({
      // A docs-only verdict resolves to acceptance disposition not-applicable.
      epicTitle: 'Docs-only readme cleanup',
    });

    const result = await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nNEW TS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { force: true, planningRisk: deriveRiskEnvelope(LOW_RISK_VERDICT) },
    );

    // The stale acceptance-table section is genuinely removed, not kept.
    assert.equal(result.acceptanceTable, 'waived');
    assert.ok(!hasEpicSection(provider.epic.body, 'acceptanceTable'));
    assert.doesNotMatch(provider.epic.body, /## Acceptance Table/);
    // The Tech Spec section survives the waiver.
    assert.match(extractEpicSection(provider.epic.body, 'techSpec'), /NEW TS/);
    // The acceptance::n-a waiver is applied.
    assert.ok(provider.epic.labels.includes(ACCEPTANCE_NA));
  });

  it('AC-5: absent→present appends a new ## Acceptance Table section', async () => {
    const provider = buildOverwriteProvider({
      epicTitle: 'Security and billing rollout',
      withAcceptanceTable: false, // no acceptance table persisted yet
    });

    const result = await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nNEW TS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { force: true },
    );

    assert.equal(result.acceptanceTable, 'persisted');
    assert.ok(hasEpicSection(provider.epic.body, 'acceptanceTable'));
    assert.match(
      extractEpicSection(provider.epic.body, 'acceptanceTable'),
      /AC-1/,
    );
    // The Tech Spec section was overwritten in place, and no tickets were
    // created for either artifact.
    assert.match(extractEpicSection(provider.epic.body, 'techSpec'), /NEW TS/);
    assert.equal(provider.createdTickets.length, 0);
  });

  it('AC-7: first-time --force (no prior sections) still persists both sections', async () => {
    const provider = buildPlanEpicProvider({
      title: 'Security and billing rollout',
      body: 'User-facing security changes with Stripe billing.',
    });

    const result = await planEpic(
      provider.epic.id,
      provider,
      {
        techSpecContent: '## Delivery Slicing\nTS.',
        acceptanceSpecContent:
          '## Acceptance Table\n| AC-1 | x | f | s | new |',
      },
      {},
      { force: true },
    );

    // Both managed sections land from scratch on the Epic body.
    assert.equal(result.techSpecPersisted, true);
    assert.equal(result.acceptanceTable, 'persisted');
    assert.ok(hasEpicSection(provider.epic.body, 'techSpec'));
    assert.ok(hasEpicSection(provider.epic.body, 'acceptanceTable'));
    assert.equal(provider.createdTickets.length, 0);
  });
});
