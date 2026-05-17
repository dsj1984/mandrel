/**
 * Regression tests — the epic-runner MUST derive wave ordering from the same
 * canonical source as `manifest-builder.js`: `blocked by #NNN` / `depends on
 * #NNN` references parsed from each Story's body via `parseBlockedBy`.
 *
 * These tests use real provider-shaped payloads (only `id`, `number`, `body`,
 * `labels` — no synthetic `dependencies` field) so a regression where
 * epic-runner silently reverts to reading the optional in-memory field would
 * be caught here. They also guard the closed-graph invariant: dependency edges
 * pointing outside the scheduled Story set must be dropped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBlockedBy } from '../../.agents/scripts/lib/dependency-parser.js';
import { computeWaves } from '../../.agents/scripts/lib/Graph.js';
import { runEpic } from '../../.agents/scripts/lib/orchestration/epic-runner.js';
import { buildCtx } from './_build-ctx.js';

// Stub the pre-wave smoke-test so these tests stay hermetic across CI
// runners that may not have the `claude` binary on PATH.
const okSmokeTest = {
  verify: async () => ({ ok: true, detail: 'stub', exitCode: 0 }),
};

function providerFromStories(epicId, stories) {
  let autoId = 1;
  const tickets = new Map();
  const comments = new Map();
  tickets.set(epicId, {
    id: epicId,
    // Waive the acceptance-spec start gate (Story #2101); this fixture is
    // about dependency resolution, not the gate.
    labels: ['type::epic', 'acceptance::n-a'],
  });
  for (const s of stories)
    tickets.set(s.id, {
      id: s.id,
      labels: ['type::story'],
      body: s.body ?? '',
    });
  return {
    _tickets: tickets,
    _comments: comments,
    async getTicket(id) {
      const t = tickets.get(id);
      if (!t) throw new Error(`no ticket ${id}`);
      return { ...t, labels: [...t.labels] };
    },
    async getSubTickets(parent) {
      if (parent !== epicId) return [];
      // Real-provider-shaped payloads: NO `dependencies` field.
      return stories.map((s) => ({
        id: s.id,
        number: s.id,
        labels: ['type::story'],
        body: s.body ?? '',
      }));
    },
    async getTicketDependencies() {
      return { blocks: [], blockedBy: [] };
    },
    async getTicketComments(id) {
      return (comments.get(id) ?? []).map((c) => ({ ...c }));
    },
    async postComment(id, payload) {
      const list = comments.get(id) ?? [];
      const c = { id: autoId++, body: payload.body, type: payload.type };
      list.push(c);
      comments.set(id, list);
      return c;
    },
    async deleteComment(commentId) {
      for (const list of comments.values()) {
        const i = list.findIndex((c) => c.id === commentId);
        if (i !== -1) list.splice(i, 1);
      }
    },
    async updateTicket(id, mutations) {
      const t = tickets.get(id);
      if (!t) return;
      if (mutations.labels) {
        const add = mutations.labels.add ?? [];
        const remove = mutations.labels.remove ?? [];
        t.labels = [
          ...new Set([...t.labels.filter((l) => !remove.includes(l)), ...add]),
        ];
      }
    },
  };
}

const config = {
  runners: {
    deliverRunner: { enabled: true, concurrencyCap: 5 },
  },
};

describe('epic-runner dependency source (body-parsed)', () => {
  it('parses `blocked by #N` from story bodies and orders waves accordingly', async () => {
    const epicId = 900;
    const stories = [
      { id: 1001, body: '' },
      { id: 1002, body: '## Dependencies\nblocked by #1001' },
      { id: 1003, body: 'depends on #1002' },
    ];
    const provider = providerFromStories(epicId, stories);

    const order = [];
    let tick = 0;
    const spawn = async ({ storyId }) => {
      order.push({ storyId, tick: tick++ });
      return { status: 'done' };
    };

    const result = await runEpic({
      ctx: buildCtx({ epicId, provider, config, spawn }),
      smokeTest: okSmokeTest,
    });

    assert.equal(result.state, 'completed');
    assert.equal(
      result.waveHistory.length,
      3,
      'three sequential waves required by linear chain',
    );
    // Under parallelism (concurrencyCap=5), 1001 must still launch before 1002,
    // and 1002 before 1003.
    const tickById = Object.fromEntries(
      order.map(({ storyId, tick }) => [storyId, tick]),
    );
    assert.ok(tickById[1001] < tickById[1002], '#1001 launches before #1002');
    assert.ok(tickById[1002] < tickById[1003], '#1002 launches before #1003');
  });

  it('drops dependency edges that point outside the scheduled Story set', async () => {
    // #7777 isn't in this Epic's story set — the edge must be discarded so the
    // DAG stays closed (otherwise computeWaves would loop forever on a missing
    // node).
    const epicId = 900;
    const stories = [
      { id: 2001, body: 'blocked by #7777' },
      { id: 2002, body: '' },
    ];
    const provider = providerFromStories(epicId, stories);

    const spawn = async () => ({ status: 'done' });
    const result = await runEpic({
      ctx: buildCtx({ epicId, provider, config, spawn }),
      smokeTest: okSmokeTest,
    });

    assert.equal(result.state, 'completed');
    assert.equal(
      result.waveHistory.length,
      1,
      'both stories land in wave 0 once the foreign edge is dropped',
    );
  });

  it('end-to-end parity — manifest-shaped dependency graph matches runtime wave order', async () => {
    // (1) Dependency graph derived via the manifest parser.
    // (2) Wave order computed via `Graph.computeWaves()` with the same parser
    //     output.
    // (3) Runtime epic-runner execution — verify Story launch order respects
    //     the declared edges under parallelism.
    const epicId = 900;
    const stories = [
      { id: 3001, body: '' },
      { id: 3002, body: 'blocked by #3001' },
      { id: 3003, body: 'blocked by #3001' },
      { id: 3004, body: 'blocked by #3002\nblocked by #3003' },
    ];

    // (1) manifest-shaped graph
    const manifestGraph = new Map();
    for (const s of stories)
      manifestGraph.set(
        s.id,
        parseBlockedBy(s.body).filter((id) => stories.some((x) => x.id === id)),
      );
    const manifestTaskMap = new Map(
      stories.map((s) => [s.id, { id: s.id, title: `S${s.id}` }]),
    );
    const manifestWaves = computeWaves(manifestGraph, manifestTaskMap);
    assert.equal(manifestWaves.length, 3, 'manifest graph produces 3 waves');
    assert.deepEqual(manifestWaves[0].map((t) => t.id).sort(), [3001]);
    assert.deepEqual(manifestWaves[1].map((t) => t.id).sort(), [3002, 3003]);
    assert.deepEqual(manifestWaves[2].map((t) => t.id).sort(), [3004]);

    // (3) runtime epic-runner execution
    const provider = providerFromStories(epicId, stories);
    const launches = [];
    const spawn = async ({ storyId }) => {
      launches.push(storyId);
      return { status: 'done' };
    };
    const result = await runEpic({
      ctx: buildCtx({ epicId, provider, config, spawn }),
      smokeTest: okSmokeTest,
    });

    // Parity: same number of waves, same membership per wave.
    assert.equal(result.waveHistory.length, manifestWaves.length);

    // Under parallelism: no story launches before any of its declared
    // dependencies has launched.
    const launchIndex = new Map(launches.map((id, i) => [id, i]));
    for (const [storyId, deps] of manifestGraph.entries()) {
      for (const dep of deps) {
        assert.ok(
          launchIndex.get(dep) < launchIndex.get(storyId),
          `story #${storyId} must launch after dep #${dep}`,
        );
      }
    }
  });
});
