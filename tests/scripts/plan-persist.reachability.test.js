/**
 * tests/scripts/plan-persist.reachability.test.js — v2 Stage 3.
 *
 * Persist-side coverage for deterministic draft reachability on the flat
 * Story persist path:
 *
 *   - orphaned route set → NAMED SOFT FAILURE (`PLAN_REACHABILITY_ORPHANS`)
 *     with ZERO provider calls;
 *   - configured navRegistry × clean route set → persist completes;
 *   - unconfigured `planning.navigation` → silent skip, ledger-logged.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import {
  PLAN_METRICS_KIND_CRITIC_SKIP,
  readPlanMetrics,
} from '../../.agents/scripts/lib/orchestration/plan-metrics.js';
import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const OPERATOR = 'plan-persist-reachability-tester';

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
      reason_to_exist: `Ship ${slug}`,
    }),
    labels: ['type::story'],
    depends_on: [],
    acceptance: acceptanceLines,
    verify: ['npm test (validate)'],
  };
}

function buildStubProvider() {
  let nextId = 9700;
  let nextCommentId = 2000;
  const issues = new Map();
  const comments = new Map();
  return {
    issues,
    comments,
    createIssueCalls: 0,
    async createIssue({ title, body, labels }) {
      this.createIssueCalls += 1;
      const id = nextId++;
      issues.set(id, { id, title, body, labels: labels ?? [], state: 'open' });
      return { id, url: `https://stub/issues/${id}` };
    },
    // Persist's terminal step flips every created Story to `agent::ready`
    // once its checkpoints are written (Story #4541), so a provider driving
    // a full run must accept the label mutation.
    async updateTicket(id, mutations) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      const next = new Set(issue.labels ?? []);
      for (const l of mutations.labels?.remove ?? []) next.delete(l);
      for (const l of mutations.labels?.add ?? []) next.add(l);
      issue.labels = [...next];
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
    async deleteComment() {
      return false;
    },
  };
}

let sandbox;
let config;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'plan-persist-reach-'));
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
    provider,
    artifacts: {
      stories: [ticket('default', { filePath: 'src/default.js' })],
      techSpecContent: '## Overview\nReachability fixture.\n',
      ...artifacts,
    },
    config: planning ? { ...config, planning } : config,
    settings: {
      baseBranch: 'main',
      paths: { tempRoot: path.join(sandbox, 'temp') },
    },
    opts: {
      skipCleanup: true,

      ...opts,
    },
  };
}

function criticSkips(entries) {
  return entries.filter(
    (e) =>
      e.kind === PLAN_METRICS_KIND_CRITIC_SKIP && e.critic === 'reachability',
  );
}

describe('plan-persist — deterministic reachability (Stage 3)', () => {
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
            stories: [ticket('orphan-page', { filePath: 'pages/reports.tsx' })],
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
    assert.deepEqual(caught.orphans, [
      { story: 'orphan-page', paths: ['pages/reports.tsx'] },
    ]);
    assert.equal(providerCalls, 0, 'soft failure precedes any GitHub write');
    assert.equal(inner.createIssueCalls, 0);
  });

  it('passes a clean route set and records reachability in the result envelope', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          stories: [
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
    const issue = provider.issues.get(result.primaryStoryId);
    assert.ok(issue.labels.includes(AGENT_LABELS.READY));
  });

  it('is a silent no-op when planning.navigation is unconfigured — skip is ledger-logged', async () => {
    const provider = buildStubProvider();
    const result = await runPlanPersist(
      baseInput(provider, {
        artifacts: {
          stories: [ticket('orphan-page', { filePath: 'pages/reports.tsx' })],
        },
      }),
    );
    assert.equal(result.reachability.status, 'skipped');
    const { entries } = await readPlanMetrics(null, config);
    const skips = criticSkips(entries);
    assert.ok(skips.length >= 1);
    assert.equal(skips.at(-1).critic, 'reachability');
    assert.equal(skips.at(-1).cli, 'plan-persist');
    assert.match(
      skips.at(-1).reasons[0],
      /No planning\.navigation\.routeGlobs/,
    );
  });
});
