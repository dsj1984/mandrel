/**
 * tests/scripts/plan-persist.critics-fold.test.js — #4496 fix 6.
 *
 * Persist-side coverage for the folded author-critics evaluation (the
 * former standalone `plan-critics.js` turn, retired once the fold became
 * the sole surface — now a deterministic pre-write phase inside
 * `runPlanPersist`):
 *
 *   - the result envelope carries `critics.consolidation` /
 *     `critics.premortem` with the `{ critic, dispatch, reasons }`
 *     verdict shape the folded evaluation emits;
 *   - PRE-WRITE ORDERING: the evaluation (and its critic-skip ledger
 *     records) lands BEFORE the first provider call — a persist that dies
 *     at Epic resolution has already recorded the verdicts;
 *   - skip decisions are appended to the plan-metrics ledger with
 *     `cli: 'plan-persist'` so under-firing stays auditable without a
 *     standalone CLI invocation;
 *   - the single-delivery shape records the no-tickets consolidation skip
 *     reason;
 *   - the fold delegates to the shared evaluator
 *     (`lib/orchestration/plan-critics-evaluate.js`), so the persist result
 *     matches a direct evaluator call for identical artifacts.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
import { evaluatePlanCritics } from '../../.agents/scripts/lib/orchestration/plan-critics-evaluate.js';
import {
  PLAN_METRICS_KIND_CRITIC_SKIP,
  readPlanMetrics,
} from '../../.agents/scripts/lib/orchestration/plan-metrics.js';
import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 9944;
const OPERATOR = 'plan-persist-critics-tester';

const TECH_SPEC = [
  '## Delivery Slicing',
  '',
  '| Slice | What ships | Independent? |',
  '| --- | --- | --- |',
  '| S1 | the change | Yes |',
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

const SINGLE_VERDICT = {
  ...LOW_VERDICT,
  deliveryShape: 'single',
  deliveryShapeRationale: 'One-pass-sized (test fixture).',
};

function ticket(slug) {
  const acceptance = [`${slug} done`];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [{ path: 'package.json', assumption: 'refactors-existing' }],
      acceptance,
      verify: ['npm test (validate)'],
    }),
    labels: ['type::story'],
    depends_on: [],
    acceptance,
    verify: ['npm test (validate)'],
  };
}

/** Minimal provider stub (same surface the persist integration stub uses). */
function buildStubProvider() {
  let nextId = EPIC_ID + 1;
  let nextCommentId = 5000;
  const issues = new Map();
  const comments = new Map();
  issues.set(EPIC_ID, {
    id: EPIC_ID,
    title: 'Critics Fold Test Epic',
    body: upsertEpicSection(
      '## Context\nCritics fixture.\n',
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
      return [];
    },
    async getSubTickets() {
      return [];
    },
    async createIssue({ title, body, labels = [] }) {
      const id = nextId++;
      issues.set(id, { id, title, body, labels, assignees: [], state: 'open' });
      return { id };
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
      return { id };
    },
    async updateTicket(id, patch) {
      const cur = issues.get(id) ?? { id, labels: [], assignees: [] };
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
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-critics-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
  config = {
    github: { operatorHandle: OPERATOR },
    project: { paths: { tempRoot: path.join(sandbox, 'temp') } },
  };
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function baseInput(provider, { artifacts = {}, opts = {} } = {}) {
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
    config,
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

function authorCriticSkips(entries) {
  return entries.filter(
    (e) =>
      e.kind === PLAN_METRICS_KIND_CRITIC_SKIP &&
      (e.critic === 'consolidation' || e.critic === 'pre-mortem'),
  );
}

describe('plan-persist — folded critic evaluation (pre-write phase, #4496 fix 6)', () => {
  it('returns both critic verdicts on the result envelope', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(baseInput(provider));
    assert.equal(result.critics.consolidation.critic, 'consolidation');
    assert.equal(typeof result.critics.consolidation.dispatch, 'boolean');
    assert.ok(result.critics.consolidation.reasons.length > 0);
    assert.equal(result.critics.premortem.critic, 'pre-mortem');
    assert.equal(typeof result.critics.premortem.dispatch, 'boolean');
    assert.ok(result.critics.premortem.reasons.length > 0);
  });

  it('records skip decisions on the ledger with cli plan-persist', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(baseInput(provider));
    const { entries } = await readPlanMetrics(EPIC_ID, config);
    const skips = authorCriticSkips(entries);
    const skippedCritics = [
      result.critics.consolidation,
      result.critics.premortem,
    ].filter((d) => !d.dispatch);
    assert.equal(skips.length, skippedCritics.length);
    for (const skip of skips) {
      assert.equal(skip.cli, 'plan-persist');
      assert.equal(skip.epicId, EPIC_ID);
      assert.ok(skip.reasons.length > 0);
    }
  });

  it('evaluates BEFORE the first provider call — a persist that dies at Epic resolution has already ledger-logged the verdicts', async () => {
    const provider = buildStubProvider();
    provider.getEpic = async () => {
      throw new Error('provider unavailable (sentinel)');
    };
    await assert.rejects(
      runPlanPersist(baseInput(provider)),
      /provider unavailable \(sentinel\)/,
    );
    const { entries } = await readPlanMetrics(EPIC_ID, config);
    assert.ok(
      authorCriticSkips(entries).length > 0,
      'critic evaluation must precede the first provider call',
    );
  });

  it('records the single-delivery consolidation skip reason (CLI parity)', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: { riskVerdict: SINGLE_VERDICT, tickets: null },
      }),
    );
    assert.equal(result.mode, 'single');
    assert.match(
      result.critics.consolidation.reasons[0],
      /single-delivery shape/,
    );
    assert.equal(result.critics.consolidation.dispatch, false);
  });

  it('produces the same verdicts as the shared evaluator (fold parity)', async () => {
    const provider = buildStubProvider();
    const tickets = [ticket('story-one')];
    const result = await runPlanPersist(
      baseInput(provider, { artifacts: { tickets } }),
    );
    const direct = evaluatePlanCritics({
      techSpecContent: TECH_SPEC,
      riskVerdict: LOW_VERDICT,
      tickets,
      config,
    });
    assert.deepEqual(result.critics, direct);
  });
});
