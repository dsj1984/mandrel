/**
 * tests/scripts/plan-persist.integration.test.js — Epic #4474 PR3.
 *
 * Mock-provider integration coverage for the collapsed single-GitHub-write
 * persist surface (`plan-persist.js` / `runPlanPersist`), locking in the
 * design's non-negotiables (#4474 design §1 Step 3 + §6 PR3):
 *
 *   - full-mode happy path: sections folded, risk-verdict comment, checkpoint
 *     v2 written, single terminal `agent::ready` flip with NO intermediate
 *     `agent::review-spec` at any point, `plan-summary` comment carrying the
 *     dry-run wave table, lease acquired AND released;
 *   - fail-closed ordering: a section-gate rejection makes ZERO provider
 *     calls (before the lease, before any GitHub read/write);
 *   - mode-coherence hard errors: fan-out without tickets refuses;
 *     `deliveryShape: "single"` refuses (PR4 seam);
 *   - `--force` re-persist: overwrites sections, threads --explicit-delete
 *     to the reconciler, bypasses the open-children guard;
 *   - `--resume` after a mid-creation crash: the failed run releases the
 *     lease and leaves temp artifacts on disk (deferred cleanup); the resume
 *     run completes to `agent::ready`;
 *   - deferred cleanup: temp artifacts survive a failed run and are deleted
 *     only at terminal success (and the plan-metrics ledger is never in the
 *     persist cleanup set);
 *   - ideation mode: `--one-pager` opens the Epic (type::epic) before the
 *     lease, then persists to `agent::ready`;
 *   - healthcheck gate: a failing healthcheck refuses the flip AND still
 *     releases the lease.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import { read as readPlanState } from '../../.agents/scripts/lib/orchestration/epic-plan-state-store.js';
import {
  PLAN_CHECKPOINT_SCHEMA_VERSION_V2,
  resolveDeliveryMode,
  runPlanPersist,
} from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import {
  buildWaveTable,
  PLAN_SUMMARY_COMMENT_TYPE,
} from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import {
  PHASE_TEMP_BASENAMES,
  resolvePhaseTempPaths,
} from '../../.agents/scripts/lib/plan-phase-cleanup.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 9977;
const OPERATOR = 'plan-persist-tester';

const TECH_SPEC = [
  '## Delivery Slicing',
  '',
  '| Slice | What ships | Independent? |',
  '| --- | --- | --- |',
  '| S1 | the change | yes |',
].join('\n');

const RISK_VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'low',
      rationale: 'Test fixture — internal tooling only.',
    },
  ],
  summary: 'Low-risk internal refactor (test fixture).',
};

function buildTickets() {
  return [
    {
      slug: 'story-one',
      type: 'story',
      title: 'Story One',
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

/**
 * In-memory ITicketingProvider stub covering the surfaces the collapsed
 * persist touches: issues, structured comments, label patches,
 * assignee-as-lease patches, sub-issue links, and issue creation
 * (ideation mode). Records the full label transition history so the
 * "no intermediate agent::review-spec" contract is assertable.
 */
function buildStubProvider({
  epicId = EPIC_ID,
  epicBody,
  withEpic = true,
} = {}) {
  let nextId = epicId + 1;
  let nextCommentId = 1000;
  const issues = new Map();
  const comments = new Map();
  const labelHistory = [];
  if (withEpic) {
    issues.set(epicId, {
      id: epicId,
      title: 'Plan Persist Test Epic',
      body: epicBody ?? '## Context\nEpic context.\n',
      labels: ['type::epic'],
      assignees: [],
      state: 'open',
    });
  }
  return {
    issues,
    comments,
    labelHistory,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== epicId);
    },
    async getSubTickets(parentId) {
      // Children are the issues created under the parent (ideation mode
      // can mint an Epic id other than the fixture default, so key off
      // the recorded parent edge, not the constructor's epicId).
      return Array.from(issues.values()).filter((t) => t.parentId === parentId);
    },
    async createIssue({ title, body, labels = [] }) {
      const id = nextId++;
      issues.set(id, {
        id,
        title,
        body,
        labels: [...labels],
        assignees: [],
        state: 'open',
      });
      return { id, nodeId: `node-${id}`, url: `https://stub/issues/${id}` };
    },
    async createTicket(parentId, payload) {
      const id = nextId++;
      issues.set(id, {
        id,
        parentId,
        title: payload.title,
        body: payload.body ?? '',
        labels: payload.labels ?? [],
        assignees: [],
        state: 'open',
      });
      return { id, url: `https://stub/issues/${id}` };
    },
    async updateTicket(id, patch) {
      const cur = issues.get(id) ?? { id, labels: [], assignees: [] };
      if (patch.title) cur.title = patch.title;
      if (patch.body !== undefined) cur.body = patch.body;
      if (Array.isArray(patch.assignees)) cur.assignees = [...patch.assignees];
      if (Array.isArray(patch.labels)) cur.labels = [...patch.labels];
      if (
        patch.labels &&
        typeof patch.labels === 'object' &&
        !Array.isArray(patch.labels)
      ) {
        const existing = new Set(cur.labels ?? []);
        for (const add of patch.labels.add ?? []) {
          existing.add(add);
          labelHistory.push({ id, op: 'add', label: add });
        }
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
    async addSubIssue() {
      return { ok: true };
    },
    async removeSubIssue() {
      return { ok: true };
    },
    primeTicketCache() {},
  };
}

/** Config bag giving the lease guard an operator identity. */
const CONFIG = { github: { operatorHandle: OPERATOR } };

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function baseOpts(overrides = {}) {
  return {
    skipHealthcheck: true,
    skipCleanup: true,
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    writeSpecFn: (epicId, spec) => writeSpec(epicId, spec, { epicsDir }),
    loadStateFn: () => ({ mapping: {} }),
    bddProbeFn: async () => null,
    ...overrides,
  };
}

function baseInput(provider, overrides = {}) {
  return {
    epicId: EPIC_ID,
    provider,
    artifacts: {
      techSpecContent: TECH_SPEC,
      acceptanceSpecContent: null,
      riskVerdict: RISK_VERDICT,
      tickets: buildTickets(),
    },
    config: CONFIG,
    settings: {
      baseBranch: 'main',
      paths: { tempRoot: path.join(sandbox, 'temp') },
    },
    opts: baseOpts(),
    ...overrides,
  };
}

function commentsOfType(provider, epicId, type) {
  const marker = structuredCommentMarker(type);
  return (provider.comments.get(epicId) ?? []).filter((c) =>
    c.body.startsWith(marker),
  );
}

describe('plan-persist — full fan-out happy path', () => {
  it('persists sections, checkpoint v2, wave-table summary, and lands agent::ready exactly once', async () => {
    const provider = buildStubProvider();
    const spawnCalls = [];
    const result = await runPlanPersist(
      baseInput(provider, {
        opts: baseOpts({
          spawnSync: (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, opts });
            return { status: 0, stdout: '', stderr: '' };
          },
        }),
      }),
    );

    // Managed Tech Spec section folded into the Epic body.
    const epic = provider.issues.get(EPIC_ID);
    assert.match(epic.body, /## Delivery Slicing/);

    // Single terminal agent::ready flip — agent::review-spec is NEVER
    // written by this surface, at any point of the run.
    assert.ok(epic.labels.includes(AGENT_LABELS.READY));
    const readyFlips = provider.labelHistory.filter(
      (h) => h.label === AGENT_LABELS.READY,
    );
    assert.equal(readyFlips.length, 1, 'exactly one agent::ready flip');
    const reviewSpecFlips = provider.labelHistory.filter(
      (h) => h.label === AGENT_LABELS.REVIEW_SPEC,
    );
    assert.equal(
      reviewSpecFlips.length,
      0,
      'the intermediate agent::review-spec flip is retired on this surface',
    );

    // risk-verdict structured comment landed.
    assert.equal(commentsOfType(provider, EPIC_ID, 'risk-verdict').length, 1);

    // Checkpoint v2: version bumped, byte-compatible consumer fields present.
    const state = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(state.version, PLAN_CHECKPOINT_SCHEMA_VERSION_V2);
    assert.equal(state.planningRisk.overallLevel, 'low');
    assert.ok(Array.isArray(state.planningRisk.axes));
    assert.equal(typeof state.reviewRouting.decision, 'string');
    assert.equal(typeof state.reviewRouting.requiresStop, 'boolean');
    assert.equal(state.decompose.ticketCount, 2);
    assert.ok(state.decompose.completedAt);
    assert.ok(state.persist.completedAt, 'terminal persist checkpoint');

    // Single plan-summary comment with the dry-run wave table as closing text.
    const summaries = commentsOfType(
      provider,
      EPIC_ID,
      PLAN_SUMMARY_COMMENT_TYPE,
    );
    assert.equal(summaries.length, 1);
    assert.match(summaries[0].body, /Dry-run wave table/);
    assert.match(summaries[0].body, /\| 1 \| `story-one` \|/);
    assert.match(summaries[0].body, /\| 2 \| `story-two` \|/);

    // Reconciler spawned with the canonical flag set (no --explicit-delete
    // on a plain persist).
    assert.equal(spawnCalls.length, 1);
    assert.ok(/epic-reconcile\.js$/.test(spawnCalls[0].args[0]));
    assert.ok(spawnCalls[0].args.includes('--apply'));
    assert.ok(spawnCalls[0].args.includes('--yes'));
    assert.ok(!spawnCalls[0].args.includes('--explicit-delete'));

    // Lease released on the success path.
    assert.deepEqual(provider.issues.get(EPIC_ID).assignees, []);

    // Result envelope shape.
    assert.equal(result.epicId, EPIC_ID);
    assert.equal(result.ticketCount, 2);
    assert.equal(result.labelTransition, 'ready');
    assert.equal(result.waveTable.length, 2);
  });
});

describe('plan-persist — fail-closed ordering (design non-negotiable 2)', () => {
  it('a section-gate rejection makes ZERO provider calls', async () => {
    const inner = buildStubProvider();
    let providerCalls = 0;
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (...args) => {
            providerCalls += 1;
            return value.apply(target, args);
          };
        }
        return value;
      },
    });

    await assert.rejects(
      runPlanPersist(
        baseInput(counting, {
          provider: counting,
          artifacts: {
            techSpecContent: '## Not A Spec\n\nNo slicing section here.',
            riskVerdict: RISK_VERDICT,
            tickets: buildTickets(),
          },
        }),
      ),
      /Delivery Slicing/,
    );
    assert.equal(
      providerCalls,
      0,
      'the section gate must reject before the lease and before any provider call',
    );
  });

  it('a ticket-validation failure also precedes every provider call', async () => {
    const inner = buildStubProvider();
    let providerCalls = 0;
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (...args) => {
            providerCalls += 1;
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    const tickets = buildTickets();
    tickets[1].depends_on = ['missing-slug'];

    await assert.rejects(
      runPlanPersist(
        baseInput(counting, {
          provider: counting,
          artifacts: {
            techSpecContent: TECH_SPEC,
            riskVerdict: RISK_VERDICT,
            tickets,
          },
        }),
      ),
    );
    assert.equal(providerCalls, 0);
  });
});

describe('plan-persist — mode coherence (PR4: resolveDeliveryMode)', () => {
  it('refuses fan-out without tickets', () => {
    assert.throws(
      () => resolveDeliveryMode(RISK_VERDICT, undefined),
      /fan-out persist requires a non-empty tickets array/,
    );
    assert.throws(
      () => resolveDeliveryMode(RISK_VERDICT, []),
      /non-empty tickets/,
    );
  });

  it('refuses deliveryShape "single" combined with a tickets payload (DAG-skip fence)', () => {
    assert.throws(
      () =>
        resolveDeliveryMode(
          { ...RISK_VERDICT, deliveryShape: 'single' },
          buildTickets(),
        ),
      /mode-coherence/,
    );
  });

  it('refuses --force with --resume, and --resume in ideation mode', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, { opts: baseOpts({ force: true, resume: true }) }),
      ),
      /mutually exclusive/,
    );
    await assert.rejects(
      runPlanPersist({
        ...baseInput(provider),
        epicId: null,
        artifacts: {
          techSpecContent: TECH_SPEC,
          riskVerdict: RISK_VERDICT,
          tickets: buildTickets(),
          onePagerContent: '# Idea\n\n## Context\nx\n',
          templateContent: '# {{title}}\n\n## Context\n{{context}}\n',
        },
        opts: { ...baseOpts(), resume: true },
      }),
      /--resume requires --epic/,
    );
  });
});

describe('plan-persist — --force re-persist', () => {
  it('overwrites sections, bypasses the open-children guard, and threads --explicit-delete', async () => {
    const provider = buildStubProvider({
      epicBody: upsertEpicSection(
        '## Context\nEpic context.\n',
        'techSpec',
        '## Delivery Slicing\n\nOld spec content.',
      ),
    });
    // An existing open story child would refuse a plain persist.
    provider.issues.set(EPIC_ID + 500, {
      id: EPIC_ID + 500,
      parentId: EPIC_ID,
      title: 'Existing child',
      body: '',
      labels: ['type::story'],
      assignees: [],
      state: 'open',
    });

    const spawnCalls = [];
    await runPlanPersist(
      baseInput(provider, {
        opts: baseOpts({
          force: true,
          spawnSync: (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, opts });
            return { status: 0, stdout: '', stderr: '' };
          },
        }),
      }),
    );
    const epic = provider.issues.get(EPIC_ID);
    assert.match(epic.body, /\| S1 \| the change \| yes \|/);
    assert.ok(
      !/Old spec content/.test(epic.body),
      'force overwrites the managed section',
    );
    assert.ok(spawnCalls[0].args.includes('--explicit-delete'));
    assert.ok(epic.labels.includes(AGENT_LABELS.READY));
  });

  it('a plain persist refuses when open story children exist', async () => {
    const provider = buildStubProvider();
    provider.issues.set(EPIC_ID + 500, {
      id: EPIC_ID + 500,
      parentId: EPIC_ID,
      title: 'Existing child',
      body: '',
      labels: ['type::story'],
      assignees: [],
      state: 'open',
    });
    await assert.rejects(
      runPlanPersist(baseInput(provider)),
      /already has\s+1 open plan child/,
    );
    // Lease released on the gate-failure path too.
    assert.deepEqual(provider.issues.get(EPIC_ID).assignees, []);
  });
});

describe('plan-persist — crash + --resume recovery (deferred cleanup)', () => {
  it('a mid-creation crash releases the lease, leaves artifacts, and --resume completes to ready', async () => {
    const provider = buildStubProvider();

    // Simulate a rate-limit crash inside the reconciler child.
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          opts: baseOpts({
            spawnSync: () => ({
              status: 1,
              stdout: '',
              stderr: 'HTTP 403 rate limit exceeded',
            }),
          }),
        }),
      ),
      /epic-reconcile\.js exited with status 1/,
    );

    // Lease released on the throw path (design non-negotiable 5).
    assert.deepEqual(provider.issues.get(EPIC_ID).assignees, []);

    // The crash happened after the spec-half checkpoint: planningRisk and
    // the in-flight decompose block are recorded, but no completion.
    const midState = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(midState.version, PLAN_CHECKPOINT_SCHEMA_VERSION_V2);
    assert.equal(midState.planningRisk.overallLevel, 'low');
    assert.equal(midState.decompose.completedAt, null);
    assert.equal(midState.persist.completedAt, null);

    // No agent::ready, no summary comment, and — deferred cleanup — the
    // run never called cleanupPhaseTempFiles (skipCleanup only suppresses
    // the success-path call; the failure path never reaches step 12).
    assert.ok(
      !provider.issues.get(EPIC_ID).labels.includes(AGENT_LABELS.READY),
    );
    assert.equal(
      commentsOfType(provider, EPIC_ID, PLAN_SUMMARY_COMMENT_TYPE).length,
      0,
    );

    // Resume: sections short-circuit (already persisted), the reconciler
    // re-runs (idempotent per-slug via its state ledger), ready lands.
    const result = await runPlanPersist(
      baseInput(provider, { opts: baseOpts({ resume: true }) }),
    );
    assert.ok(provider.issues.get(EPIC_ID).labels.includes(AGENT_LABELS.READY));
    assert.equal(result.labelTransition, 'ready');
    const finalState = await readPlanState({ provider, epicId: EPIC_ID });
    assert.equal(finalState.decompose.ticketCount, 2);
    assert.ok(finalState.persist.completedAt);
    // Exactly one summary comment (upsert, not append).
    assert.equal(
      commentsOfType(provider, EPIC_ID, PLAN_SUMMARY_COMMENT_TYPE).length,
      1,
    );
  });
});

describe('plan-persist — deferred temp cleanup (design non-negotiable 3)', () => {
  it('the persist phase owns every plan artifact incl. risk-verdict.json, and never the plan-metrics ledger', () => {
    const persistSet = PHASE_TEMP_BASENAMES.persist;
    for (const basename of [
      ...PHASE_TEMP_BASENAMES.spec,
      ...PHASE_TEMP_BASENAMES.decompose,
      'risk-verdict.json',
    ]) {
      assert.ok(
        persistSet.includes(basename),
        `persist cleanup set must include ${basename}`,
      );
    }
    assert.ok(
      !persistSet.includes('plan-metrics.json'),
      'the PR1 plan-metrics ledger must survive persist cleanup',
    );
  });

  it('deletes temp artifacts only at terminal success', async () => {
    // Materialize the artifacts in the real per-Epic temp tree the resolver
    // points at, then verify success-path deletion end to end.
    const tempPaths = resolvePhaseTempPaths('persist', EPIC_ID);
    for (const p of tempPaths) {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, 'fixture', 'utf8');
    }
    try {
      const provider = buildStubProvider();
      const result = await runPlanPersist(
        baseInput(provider, { opts: baseOpts({ skipCleanup: false }) }),
      );
      assert.equal(result.cleanup.deleted.length, tempPaths.length);
      for (const p of tempPaths) {
        assert.ok(!existsSync(p), `expected ${p} to be cleaned up at success`);
      }
    } finally {
      const dir = path.dirname(tempPaths[0]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plan-persist — ideation mode (--one-pager fold)', () => {
  it('opens the Epic from the one-pager, then persists to agent::ready', async () => {
    const provider = buildStubProvider({ withEpic: false });
    const onePager = [
      '# Collapse The Plan Flow',
      '',
      '## Context',
      'Planning takes 60+ turns.',
      '',
      '## Goal',
      'Three steps.',
      '',
      '## Scope',
      'plan-persist CLI.',
    ].join('\n');
    const template = [
      '# {{title}}',
      '',
      '## Context',
      '{{context}}',
      '',
      '## Goal',
      '{{goal}}',
      '',
      '## Scope',
      '{{scope}}',
    ].join('\n');

    const result = await runPlanPersist({
      ...baseInput(provider),
      epicId: null,
      artifacts: {
        techSpecContent: TECH_SPEC,
        riskVerdict: RISK_VERDICT,
        tickets: buildTickets(),
        onePagerContent: onePager,
        templateContent: template,
      },
    });

    assert.equal(result.epicCreated, true);
    const epic = provider.issues.get(result.epicId);
    assert.equal(epic.title, 'Collapse The Plan Flow');
    assert.ok(epic.labels.includes('type::epic'));
    assert.ok(epic.labels.includes(AGENT_LABELS.READY));
    assert.match(epic.body, /## Delivery Slicing/);
    assert.deepEqual(epic.assignees, [], 'lease released');
  });
});

describe('plan-persist — healthcheck gate', () => {
  it('a failing healthcheck refuses the ready flip and still releases the lease', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          opts: baseOpts({
            skipHealthcheck: false,
            runHealthcheckFn: async () => ({
              ok: false,
              reason: 'reachability failed',
            }),
          }),
        }),
      ),
      /Refusing agent::ready handoff/,
    );
    const epic = provider.issues.get(EPIC_ID);
    assert.ok(!epic.labels.includes(AGENT_LABELS.READY));
    assert.deepEqual(
      epic.assignees,
      [],
      'lease released on the gate-failure path',
    );
  });
});

describe('plan-persist — wave table', () => {
  it('layers dependent stories into later waves', () => {
    const table = buildWaveTable([
      { slug: 'a', title: 'A', depends_on: [] },
      { slug: 'b', title: 'B', depends_on: ['a'] },
      { slug: 'c', title: 'C', depends_on: [] },
      { slug: 'd', title: 'D', depends_on: ['b', 'c'] },
    ]);
    assert.deepEqual(
      table.map(({ wave, stories }) => [wave, stories.map((s) => s.slug)]),
      [
        [0, ['a', 'c']],
        [1, ['b']],
        [2, ['d']],
      ],
    );
  });
});
