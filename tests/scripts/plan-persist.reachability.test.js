/**
 * tests/scripts/plan-persist.reachability.test.js — Epic #4474 PR6.
 *
 * Persist-side coverage for the deterministic draft reachability check
 * (design §4: the 8.4 critic demoted into `plan-persist.js` step 4.5):
 *
 *   - orphaned route set → NAMED SOFT FAILURE
 *     (`code: PLAN_REACHABILITY_ORPHANS`) raised with ZERO provider calls,
 *     so the one-targeted-amend recovery re-runs a clean persist;
 *   - configured navRegistry × clean route set → persist completes and the
 *     result envelope records `reachability.status: 'ok'`;
 *   - unconfigured `planning.navigation` → silent no-op, and the skip
 *     decision is appended to the plan-metrics ledger
 *     (`kind: 'critic-skip'`, critic 'reachability') for audit;
 *   - single-delivery mode → no draft tree to scan; the skip is
 *     ledger-logged with the single-shape reason.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import {
  PLAN_METRICS_KIND_CRITIC_SKIP,
  readPlanMetrics,
} from '../../.agents/scripts/lib/orchestration/plan-metrics.js';
import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const EPIC_ID = 8899;
const OPERATOR = 'plan-persist-reachability-tester';

const TECH_SPEC = [
  '## Delivery Slicing',
  '',
  '| Slice | What ships | Independent? |',
  '| --- | --- | --- |',
  '| S1 | the page | Yes |',
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

/** Build a minimal valid Story ticket touching `filePath`. */
function ticket(slug, { filePath, acceptance } = {}) {
  const acceptanceLines = acceptance ?? [`${slug} done`];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [{ path: filePath, assumption: 'creates' }],
      acceptance: acceptanceLines,
      verify: ['npm test (validate)'],
    }),
    labels: ['type::story'],
    depends_on: [],
    acceptance: acceptanceLines,
    verify: ['npm test (validate)'],
  };
}

/** In-memory provider stub (trimmed from the PR4 modes-test stub). */
function buildStubProvider() {
  let nextId = 9700;
  let nextCommentId = 2000;
  const issues = new Map();
  const comments = new Map();
  issues.set(EPIC_ID, {
    id: EPIC_ID,
    title: 'Reachability Test Epic',
    body: upsertEpicSection(
      '## Context\nReachability fixture.\n',
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
    createTicketCalls: 0,
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
      this.createTicketCalls += 1;
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
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-reach-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
  config = {
    github: { operatorHandle: OPERATOR },
    project: { paths: { tempRoot: path.join(sandbox, 'temp') } },
  };
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

const NAV_PLANNING = {
  navigation: {
    routeGlobs: ['pages/**'],
    navRegistry: ['nav-registry.ts'],
  },
};

function baseInput(provider, { artifacts = {}, planning, opts = {} } = {}) {
  return {
    epicId: EPIC_ID,
    provider,
    artifacts: {
      techSpecContent: TECH_SPEC,
      acceptanceSpecContent: null,
      riskVerdict: LOW_VERDICT,
      tickets: null,
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

function criticSkips(entries) {
  return entries.filter((e) => e.kind === PLAN_METRICS_KIND_CRITIC_SKIP);
}

describe('plan-persist — deterministic reachability (step 4.5, PR6)', () => {
  it('raises the named soft failure on orphan surfaces with ZERO provider calls', async () => {
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

    let caught;
    try {
      await runPlanPersist(
        baseInput(counting, {
          artifacts: {
            tickets: [ticket('orphan-page', { filePath: 'pages/reports.tsx' })],
          },
          planning: NAV_PLANNING,
        }),
      );
      assert.fail('expected PLAN_REACHABILITY_ORPHANS');
    } catch (err) {
      caught = err;
    }
    assert.equal(caught.code, 'PLAN_REACHABILITY_ORPHANS');
    assert.match(caught.message, /SOFT FAILURE — reachability orphans/);
    assert.match(caught.message, /orphan-page: pages\/reports\.tsx/);
    assert.match(caught.message, /ONE targeted amend/);
    assert.deepEqual(caught.orphans, [
      { story: 'orphan-page', paths: ['pages/reports.tsx'] },
    ]);
    assert.equal(providerCalls, 0, 'soft failure precedes any GitHub write');
    assert.equal(inner.createTicketCalls, 0);
  });

  it('passes a clean route set and records reachability in the result envelope', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          tickets: [
            ticket('nav-owned-page', {
              filePath: 'pages/reports.tsx',
              acceptance: ['page is registered in nav-registry.ts'],
            }),
          ],
        },
        planning: NAV_PLANNING,
      }),
    );
    assert.equal(result.reachability.status, 'ok');
    assert.ok(provider.issues.get(EPIC_ID).labels.includes(AGENT_LABELS.READY));
    const { entries } = await readPlanMetrics(EPIC_ID, config);
    assert.equal(
      criticSkips(entries).length,
      0,
      'a configured, clean scan is not a skip — nothing to audit',
    );
  });

  it('is a silent no-op when planning.navigation is unconfigured — skip is ledger-logged', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          tickets: [ticket('orphan-page', { filePath: 'pages/reports.tsx' })],
        },
        // no planning.navigation
      }),
    );
    assert.equal(result.reachability.status, 'skipped');
    const { entries } = await readPlanMetrics(EPIC_ID, config);
    const skips = criticSkips(entries);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].critic, 'reachability');
    assert.equal(skips[0].cli, 'plan-persist');
    assert.equal(skips[0].epicId, EPIC_ID);
    assert.match(skips[0].reasons[0], /No planning\.navigation\.routeGlobs/);
  });

  it('skips in single-delivery mode (no draft tree) and logs the shape reason', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: { riskVerdict: SINGLE_VERDICT, tickets: null },
        planning: NAV_PLANNING,
      }),
    );
    assert.equal(result.mode, 'single');
    assert.equal(result.reachability.status, 'skipped');
    const { entries } = await readPlanMetrics(EPIC_ID, config);
    const skips = criticSkips(entries);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].critic, 'reachability');
    assert.match(skips[0].reasons[0], /single-delivery shape/);
  });
});
