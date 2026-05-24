/**
 * tests/scripts/epic-plan-decompose.sub-issue-safety-net.test.js
 *
 * Regression coverage for Story #2063 — silent partial-backlog state.
 *
 * Pre-fix history: the spec-flow rewrite (Story #1498) dropped the
 * `reconcileSubIssueLinks` post-pass that the legacy `populateBacklog`
 * path always ran. A transient GraphQL failure inside
 * `provider.createTicket → addSubIssue` was captured into the return
 * envelope as `{ subIssueLinked: false, subIssueError }` and silently
 * discarded by `applyCreate`, producing a partial backlog with no
 * operator-visible signal. The dispatcher / `/epic-deliver` then walked
 * the wrong tree.
 *
 * The fix lives in two places:
 *   1. `epic-spec-reconciler-apply.js#applyCreate` — surfaces a WARN
 *      breadcrumb when `created.subIssueLinked === false` so the
 *      transient failure is visible.
 *   2. `epic-plan-decompose.js#runDecomposePhase` — calls
 *      `provider.reconcileSubIssueLinks(epicId)` between the reconcile
 *      spawn returning 0 and the Epic flip to `agent::ready`, and
 *      throws on `failed > 0`.
 *
 * The tests below drive `runDecomposePhase` with a stub provider whose
 * `reconcileSubIssueLinks` is configurable, asserting:
 *   - it is called with the Epic id (the safety net runs at all),
 *   - it runs **before** the Epic flips to `agent::ready` (so a partial
 *     backlog never persists with the "decomposition complete" label),
 *   - `failed > 0` aborts the run and surfaces the failure as an error.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runDecomposePhase } from '../../.agents/scripts/epic-plan-decompose.js';
import { writeSpec } from '../../.agents/scripts/lib/spec/index.js';

const EPIC_ID = 9994;

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'sub-issue-safety-net-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Minimal stub provider that records reconcileSubIssueLinks calls and
 * the order of side-effecting calls so the test can assert both
 * "was called" and "was called *before* the agent::ready flip".
 *
 * @param {object} opts
 * @param {(epicId: number) => Promise<{
 *   totalExpected: number, alreadyLinked: number,
 *   reconciled: number, failed: number,
 *   failures: Array<{parentId: number, childId: number, reason: string}>,
 * }>} [opts.reconcileSubIssueLinks]
 *   When omitted, defaults to a happy-path result.
 */
function buildStubProvider({ epicId, reconcileSubIssueLinks }) {
  const events = [];
  const issues = new Map();
  const comments = new Map();
  let nextCommentId = 1000;
  let nextId = epicId + 1;
  issues.set(epicId, {
    id: epicId,
    title: 'Safety Net Epic',
    body: '',
    labels: ['type::epic', 'agent::review-spec'],
    state: 'open',
    linkedIssues: { prd: epicId + 100, techSpec: epicId + 200 },
  });
  return {
    events,
    issues,
    comments,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== epicId);
    },
    async createTicket(parentId, payload) {
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
      const cur = issues.get(id) ?? { id, labels: [] };
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
        if (
          (patch.labels.add ?? []).includes('agent::ready') &&
          id === epicId
        ) {
          events.push({ type: 'epic-flip', label: 'agent::ready' });
        }
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
    async addSubIssue() {
      return { ok: true };
    },
    async removeSubIssue() {
      return { ok: true };
    },
    async reconcileSubIssueLinks(targetEpicId) {
      events.push({ type: 'reconcile-sub-issues', epicId: targetEpicId });
      if (reconcileSubIssueLinks) {
        return reconcileSubIssueLinks(targetEpicId);
      }
      return {
        totalExpected: 5,
        alreadyLinked: 5,
        reconciled: 0,
        failed: 0,
        failures: [],
      };
    },
    primeTicketCache() {},
  };
}

function buildFixtureTickets() {
  return [
    {
      slug: 'feature-a',
      type: 'feature',
      title: 'Feature A',
      body: 'feature body',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'story-one',
      type: 'story',
      title: 'Story One',
      body: 'story body',
      labels: ['type::story'],
      parent_slug: 'feature-a',
      depends_on: [],
    },
    {
      slug: 'task-one',
      type: 'task',
      title: 'Task One',
      body: {
        goal: 'do thing',
        changes: ['package.json: change a thing'],
        acceptance: ['done'],
        verify: ['npm test'],
      },
      labels: ['type::task'],
      parent_slug: 'story-one',
      depends_on: [],
    },
  ];
}

const stubSpawnSync = () => ({ status: 0, stdout: '', stderr: '' });

describe('runDecomposePhase — sub-issue link safety net (Story #2063)', () => {
  it('calls provider.reconcileSubIssueLinks after a clean reconcile spawn', async () => {
    const provider = buildStubProvider({ epicId: EPIC_ID });
    const tickets = buildFixtureTickets();
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });

    await runDecomposePhase(
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

    const reconcileEvent = provider.events.find(
      (e) => e.type === 'reconcile-sub-issues',
    );
    assert.ok(
      reconcileEvent,
      'reconcileSubIssueLinks must be called by runDecomposePhase',
    );
    assert.equal(reconcileEvent.epicId, EPIC_ID);
  });

  it('runs reconcileSubIssueLinks before flipping the Epic to agent::ready', async () => {
    const provider = buildStubProvider({ epicId: EPIC_ID });
    const tickets = buildFixtureTickets();
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });

    await runDecomposePhase(
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

    const reconcileIdx = provider.events.findIndex(
      (e) => e.type === 'reconcile-sub-issues',
    );
    const flipIdx = provider.events.findIndex((e) => e.type === 'epic-flip');
    assert.ok(reconcileIdx !== -1, 'reconcile event must be recorded');
    assert.ok(flipIdx !== -1, 'epic-flip event must be recorded');
    assert.ok(
      reconcileIdx < flipIdx,
      `reconcile must run before flip — partial backlog must not persist with agent::ready (got reconcileIdx=${reconcileIdx}, flipIdx=${flipIdx})`,
    );
  });

  it('throws and does NOT flip the Epic to agent::ready when failed > 0', async () => {
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      reconcileSubIssueLinks: async () => ({
        totalExpected: 5,
        alreadyLinked: 3,
        reconciled: 1,
        failed: 1,
        failures: [
          {
            parentId: EPIC_ID + 1,
            childId: EPIC_ID + 2,
            reason: 'transient GraphQL error',
          },
        ],
      }),
    });
    const tickets = buildFixtureTickets();
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });

    await assert.rejects(
      runDecomposePhase(
        EPIC_ID,
        provider,
        { tickets },
        {},
        {
          spawnSync: stubSpawnSync,
          writeSpecFn: writeSpecOverride,
          skipHealthcheck: true,
        },
      ),
      /Sub-issue reconciliation incomplete/,
    );

    // Critical invariant: the Epic must not have been flipped to
    // agent::ready when the safety net fails. A partial backlog labelled
    // "decomposition complete" is the exact silent-failure mode the bug
    // produced — the throw must happen before the flip.
    const epic = await provider.getEpic(EPIC_ID);
    assert.ok(
      !epic.labels.includes('agent::ready'),
      `Epic must not carry agent::ready when reconcileSubIssueLinks failed; saw labels=${JSON.stringify(epic.labels)}`,
    );
  });

  it('completes successfully when the provider does not implement reconcileSubIssueLinks (in-process stubs / non-GH providers)', async () => {
    // Defensive contract — the existing helper at
    // epic-plan-decompose.js:487 silently skips when the method is
    // absent, so test providers without GH semantics are not forced to
    // implement it. Lock that in so a future tightening doesn't break
    // unit-test seams unintentionally.
    const provider = buildStubProvider({ epicId: EPIC_ID });
    // Test seam — remove the method to verify the silent-skip branch in
    // epic-plan-decompose.js's reconcileSubIssueLinks helper (returns
    // early when typeof provider.reconcileSubIssueLinks !== 'function').
    provider.reconcileSubIssueLinks = undefined;
    const tickets = buildFixtureTickets();
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });

    await runDecomposePhase(
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

    // Epic flipped to agent::ready as normal — the missing method is a
    // permissible test seam, not an error.
    const epic = await provider.getEpic(EPIC_ID);
    assert.ok(epic.labels.includes('agent::ready'));
  });
});
