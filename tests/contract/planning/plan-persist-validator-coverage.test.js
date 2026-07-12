/**
 * tests/contract/planning/plan-persist-validator-coverage.test.js —
 * Epic #4474 PR7: the "unchanged validator coverage" receipt.
 *
 * The #4474 acceptance bar (and the bench G2 gate) requires that the
 * 12-phase → 3-step collapse dropped ZERO deterministic gates. This file
 * enumerates every deterministic gate of the retired pipeline and asserts
 * each one is exercised — behaviorally, not by grep — on the single
 * surviving GitHub-write path (`runPlanPersist`):
 *
 *   1. section gate          (validateSpecSections, step 2)
 *   2. mode-coherence        (resolveDeliveryMode, step 3)
 *   3. ticket validator      (validateAndNormalizeTickets, step 4)
 *   4. file-assumption gate  (inside the ticket validator, step 4)
 *   5. DAG / cycle check     (inside the ticket validator, step 4)
 *   6. reviewability budget  (maxTickets, step 4)
 *   7. draft reachability    (evaluateDraftReachability, step 4.5 — PR6)
 *   8. inline healthcheck    (runHealthcheckGate, step 9 — the
 *                             `agent::ready` exit condition)
 *
 * Each case drives the real persist entry point with an input that ONLY
 * the gate under test can reject, so a silently-removed gate turns this
 * suite red. Deeper per-gate behavior (fail-closed ordering, recovery,
 * skip audit) lives in tests/scripts/plan-persist.*.test.js — this file
 * is the one-glance coverage inventory.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { upsertEpicSection } from '../../../.agents/scripts/lib/epic-body-sections.js';
import { AGENT_LABELS } from '../../../.agents/scripts/lib/label-constants.js';
import { runPlanPersist } from '../../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { writeSpec } from '../../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 9611;
const OPERATOR = 'plan-persist-coverage-tester';

const TECH_SPEC = [
  '## Delivery Slicing',
  '',
  '| Slice | What ships | Independent? |',
  '| --- | --- | --- |',
  '| S1 | the change | yes |',
].join('\n');

const LOW_VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'low',
      rationale: 'Test fixture — internal tooling only.',
    },
  ],
  summary: 'Low-risk fixture.',
};

/** Minimal valid Story ticket; override any field per gate. */
function ticket(slug, overrides = {}) {
  const acceptance = [`${slug} done`];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [
        {
          // Long-lived path: the assumption gate probes the local `main`
          // ref, so the fixture must exist on any checkout's base branch.
          path: 'package.json',
          assumption: 'refactors-existing',
        },
      ],
      acceptance,
      verify: ['npm test (validate)'],
    }),
    labels: ['type::story'],
    depends_on: [],
    acceptance,
    verify: ['npm test (validate)'],
    ...overrides,
  };
}

/** In-memory provider stub (same surface the persist integration stub uses). */
function buildStubProvider() {
  let nextId = 9700;
  let nextCommentId = 3000;
  const issues = new Map();
  const comments = new Map();
  issues.set(EPIC_ID, {
    id: EPIC_ID,
    title: 'Validator Coverage Test Epic',
    body: upsertEpicSection(
      '## Context\nCoverage fixture.\n',
      'techSpec',
      TECH_SPEC,
    ),
    labels: ['type::epic'],
    assignees: [],
    state: 'open',
  });
  return {
    issues,
    comments,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== EPIC_ID);
    },
    async getSubTickets(parentId) {
      return Array.from(issues.values()).filter(
        (t) => t.parentId === parentId && t.state === 'open',
      );
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
    async deleteComment() {
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

let sandbox;
let epicsDir;
let config;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-coverage-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
  config = {
    github: { operatorHandle: OPERATOR },
    project: { paths: { tempRoot: path.join(sandbox, 'temp') } },
  };
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function baseInput(provider, { artifacts = {}, planning, opts = {} } = {}) {
  return {
    epicId: EPIC_ID,
    provider,
    artifacts: {
      techSpecContent: TECH_SPEC,
      acceptanceSpecContent: null,
      riskVerdict: LOW_VERDICT,
      tickets: [ticket('story-one')],
      ...artifacts,
    },
    config: planning ? { ...config, planning } : config,
    settings: {
      baseBranch: 'main',
      paths: { tempRoot: path.join(sandbox, 'temp') },
    },
    opts: {
      skipHealthcheck: true,
      skipCleanup: true,
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
      writeSpecFn: (epicId, spec) => writeSpec(epicId, spec, { epicsDir }),
      loadStateFn: () => ({ epicId: EPIC_ID, mapping: {} }),
      writeStateFn: () => '/dev/null',
      bddProbeFn: async () => null,
      ...opts,
    },
  };
}

describe('plan-persist — deterministic gate coverage inventory (#4474 G2 receipt)', () => {
  it('gate 1 — section gate rejects a Tech Spec missing the required sections', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: { techSpecContent: 'prose without any managed section' },
        }),
      ),
      /section/i,
    );
  });

  it('gate 2 — mode-coherence hard-errors on deliveryShape "single" with a tickets payload', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            riskVerdict: {
              ...LOW_VERDICT,
              deliveryShape: 'single',
              deliveryShapeRationale: 'one-pass-sized (fixture)',
            },
            tickets: [ticket('story-one')],
          },
        }),
      ),
      /single|coheren/i,
    );
  });

  it('gate 2 (converse) — mode-coherence hard-errors on fan-out without tickets', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(baseInput(provider, { artifacts: { tickets: null } })),
      /ticket/i,
    );
  });

  it('gate 3 — ticket validator rejects a non-story ticket type (2-tier hierarchy)', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: { tickets: [ticket('story-one', { type: 'task' })] },
        }),
      ),
      /type|story/i,
    );
  });

  it('gate 4 — file-assumption gate rejects a refactors-existing claim on a path absent from the base branch', async () => {
    const provider = buildStubProvider();
    const acceptance = ['bad-path done'];
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            tickets: [
              ticket('bad-path', {
                body: serialize({
                  goal: 'Refactor a file that does not exist.',
                  changes: [
                    {
                      path: 'definitely/not/a/real/file.js',
                      assumption: 'refactors-existing',
                    },
                  ],
                  acceptance,
                  verify: ['npm test (validate)'],
                }),
                acceptance,
              }),
            ],
          },
        }),
      ),
      /assumption/i,
    );
  });

  it('gate 5 — DAG check rejects a circular depends_on graph', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            tickets: [
              ticket('story-a', { depends_on: ['story-b'] }),
              ticket('story-b', { depends_on: ['story-a'] }),
            ],
          },
        }),
      ),
      /circular|cycle/i,
    );
  });

  it('gate 6 — reviewability budget rejects an over-budget plan without --allow-over-budget', async () => {
    const provider = buildStubProvider();
    // 81 minimal tickets: the budget gate (framework constant 80) fires
    // BEFORE per-ticket validation, so slug/type/title suffice.
    const tickets = Array.from({ length: 81 }, (_, i) => ticket(`story-${i}`));
    await assert.rejects(
      runPlanPersist(baseInput(provider, { artifacts: { tickets } })),
      /reviewability budget/i,
    );
  });

  it('gate 7 — draft reachability raises the named soft failure on an orphan route surface', async () => {
    const provider = buildStubProvider();
    const acceptance = ['orphan-page done'];
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          artifacts: {
            tickets: [
              ticket('orphan-page', {
                body: serialize({
                  goal: 'Add a page nothing links to.',
                  changes: [
                    { path: 'pages/reports.tsx', assumption: 'creates' },
                  ],
                  acceptance,
                  verify: ['npm test (validate)'],
                }),
                acceptance,
              }),
            ],
          },
          planning: {
            navigation: {
              routeGlobs: ['pages/**'],
              navRegistry: ['nav-registry.ts'],
            },
          },
        }),
      ),
      (err) => err.code === 'PLAN_REACHABILITY_ORPHANS',
    );
  });

  it('gate 8 — inline healthcheck refuses the agent::ready flip on ok:false', async () => {
    const provider = buildStubProvider();
    await assert.rejects(
      runPlanPersist(
        baseInput(provider, {
          opts: {
            skipHealthcheck: false,
            runHealthcheckFn: async () => ({
              ok: false,
              reason: 'coverage fixture failure',
            }),
          },
        }),
      ),
      /Refusing agent::ready handoff/,
    );
    const epic = provider.issues.get(EPIC_ID);
    assert.ok(
      !epic.labels.includes(AGENT_LABELS.READY),
      'a failed healthcheck must not hand off agent::ready',
    );
  });
});
