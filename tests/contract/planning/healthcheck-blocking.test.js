/**
 * tests/contract/planning/healthcheck-blocking.test.js
 *
 * Contract: the `agent::ready` handoff gate.
 *
 * Story #2921 (Epic #2880 F7) made the post-plan readiness healthcheck
 * blocking. The persist half of `epic-plan-decompose.js` (see
 * `lib/orchestration/epic-plan-decompose/phases/persist.js#runDecomposePhase`)
 * must refuse to flip the Epic to `agent::ready` when the inline
 * healthcheck reports `ok: false`, unless the operator has applied the
 * `planning::healthcheck-waived` label to the Epic. The waiver scopes
 * to the healthcheck check alone — every other handoff exit condition
 * (see `.agents/SDLC.md`) still applies.
 *
 * Three cases are covered:
 *
 *   1. ok=true                                  → flip proceeds.
 *   2. ok=false, no waiver label                → throws, no flip.
 *   3. ok=false, planning::healthcheck-waived   → flip proceeds with warn.
 *
 * The healthcheck function is injected via `runHealthcheckFn`; the spawn
 * / writeSpec / renderSpec hooks are stubbed so the test stays a pure
 * boundary contract on the gate logic.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runDecomposePhase } from '../../../.agents/scripts/epic-plan-decompose.js';
import { PLANNING_HEALTHCHECK_WAIVED } from '../../../.agents/scripts/lib/label-constants.js';
import { writeSpec } from '../../../.agents/scripts/lib/spec/index.js';

const EPIC_ID = 2921;

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'planning-healthcheck-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function buildStubProvider({ epicId, epicLabels }) {
  const issues = new Map();
  const comments = new Map();
  let nextCommentId = 1000;
  let nextId = epicId + 1;
  issues.set(epicId, {
    id: epicId,
    title: 'Healthcheck Gate Epic',
    body: 'Some Epic body.\n\n## Planning Artifacts\n- [ ] PRD: #1\n- [ ] Tech Spec: #2\n',
    labels: epicLabels,
    state: 'open',
    linkedIssues: { prd: 1, techSpec: 2, acceptanceSpec: 3 },
  });
  return {
    issues,
    async getEpic(id) {
      return issues.get(id);
    },
    async getTicket(id) {
      return issues.get(id);
    },
    async getTickets() {
      return Array.from(issues.values()).filter((t) => t.id !== epicId);
    },
    async createTicket(_parentId, payload) {
      const id = nextId++;
      issues.set(id, {
        id,
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
    async deleteComment() {
      return true;
    },
    async updateComment() {
      return null;
    },
    async addSubIssue() {
      return { ok: true };
    },
    async removeSubIssue() {
      return { ok: true };
    },
    async reconcileSubIssueLinks() {
      return {
        totalExpected: 1,
        alreadyLinked: 1,
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
        changes: ['file.js: do x'],
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
const stubRenderSpec = (_tickets, opts) => ({
  epic: { id: opts.epic.id, title: opts.epic.title, body: opts.epic.body },
  features: [],
});

describe('agent::ready handoff gate — healthcheck (Story #2921 F7)', () => {
  it('flips Epic to agent::ready when healthcheck returns ok=true', async () => {
    // Arrange
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicLabels: ['type::epic', 'agent::review-spec'],
    });
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });
    const healthcheckCalls = [];
    const runHealthcheckFn = async (args) => {
      healthcheckCalls.push(args);
      return { ok: true, degraded: false, reason: null, checks: [] };
    };

    // Act
    const result = await runDecomposePhase(
      EPIC_ID,
      provider,
      { tickets: buildFixtureTickets() },
      {},
      {
        spawnSync: stubSpawnSync,
        writeSpecFn: writeSpecOverride,
        renderSpecFn: stubRenderSpec,
        runHealthcheckFn,
      },
    );

    // Assert — healthcheck called with the Epic id, ok-shape result, Epic flipped.
    assert.equal(healthcheckCalls.length, 1);
    assert.equal(healthcheckCalls[0].epicId, EPIC_ID);
    assert.equal(result.healthcheck.ok, true);
    const epic = await provider.getEpic(EPIC_ID);
    assert.ok(
      epic.labels.includes('agent::ready'),
      `Epic must carry agent::ready after a green healthcheck, got: ${JSON.stringify(epic.labels)}`,
    );
  });

  it('refuses agent::ready flip when healthcheck returns ok=false and no waiver label is applied', async () => {
    // Arrange
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicLabels: ['type::epic', 'agent::review-spec'],
    });
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });
    const runHealthcheckFn = async () => ({
      ok: false,
      degraded: true,
      reason: 'git-remote: origin unreachable',
      checks: [
        {
          name: 'git-remote',
          ok: false,
          durationMs: 50,
          detail: 'unreachable',
        },
      ],
    });

    // Act + Assert — throws with a diagnostic mentioning the waiver label.
    await assert.rejects(
      runDecomposePhase(
        EPIC_ID,
        provider,
        { tickets: buildFixtureTickets() },
        {},
        {
          spawnSync: stubSpawnSync,
          writeSpecFn: writeSpecOverride,
          renderSpecFn: stubRenderSpec,
          runHealthcheckFn,
        },
      ),
      (err) => {
        assert.match(err.message, /Refusing agent::ready handoff/);
        assert.match(err.message, /git-remote/);
        assert.match(err.message, new RegExp(PLANNING_HEALTHCHECK_WAIVED));
        return true;
      },
    );

    // Critical invariant — the Epic must NOT have flipped to agent::ready.
    const epic = await provider.getEpic(EPIC_ID);
    assert.ok(
      !epic.labels.includes('agent::ready'),
      `Epic must not carry agent::ready when healthcheck failed without waiver; saw labels=${JSON.stringify(epic.labels)}`,
    );
  });

  it('flips Epic to agent::ready when healthcheck returns ok=false but planning::healthcheck-waived is applied', async () => {
    // Arrange — the operator-applied waiver is the documented escape hatch.
    const provider = buildStubProvider({
      epicId: EPIC_ID,
      epicLabels: [
        'type::epic',
        'agent::review-spec',
        PLANNING_HEALTHCHECK_WAIVED,
      ],
    });
    const writeSpecOverride = (id, spec) => writeSpec(id, spec, { epicsDir });
    const runHealthcheckFn = async () => ({
      ok: false,
      degraded: true,
      reason: 'git-remote: origin unreachable (maintenance window)',
      checks: [],
    });

    // Act
    const result = await runDecomposePhase(
      EPIC_ID,
      provider,
      { tickets: buildFixtureTickets() },
      {},
      {
        spawnSync: stubSpawnSync,
        writeSpecFn: writeSpecOverride,
        renderSpecFn: stubRenderSpec,
        runHealthcheckFn,
      },
    );

    // Assert — healthcheck result reflects the waiver, Epic flipped anyway.
    assert.equal(result.healthcheck.ok, false);
    assert.equal(result.healthcheck.waived, true);
    assert.match(result.healthcheck.reason, /maintenance window/);
    const epic = await provider.getEpic(EPIC_ID);
    assert.ok(
      epic.labels.includes('agent::ready'),
      `Epic must carry agent::ready when waiver is applied; saw labels=${JSON.stringify(epic.labels)}`,
    );
  });
});
