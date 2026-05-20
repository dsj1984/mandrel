/**
 * Parity tests for the epic-runner's local dispatch path: wave ordering,
 * blocker halt-and-resume, and story-launch isolation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runEpic } from '../../.agents/scripts/lib/orchestration/epic-runner.js';
import {
  waveEndMarker,
  waveStartMarker,
} from '../../.agents/scripts/lib/orchestration/lifecycle/listeners/structured-comment-poster.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import { EPIC_RUN_STATE_TYPE } from '../fixtures/epic-run-state-store.js';
import { buildCtx } from './_build-ctx.js';

// Stub the pre-wave smoke-test so these parity tests stay hermetic across
// CI runners that may not have the `claude` binary on PATH.
const okSmokeTest = {
  verify: async () => ({ ok: true, detail: 'stub', exitCode: 0 }),
};

function buildFakeProvider({ epicId, stories, initialEpicLabels }) {
  let autoId = 1;
  const tickets = new Map();
  const comments = new Map();
  tickets.set(epicId, {
    id: epicId,
    labels: initialEpicLabels ?? [
      'type::epic',
      'agent::executing',
      // Waive the acceptance-spec start gate (Story #2101) by default; tests
      // that exercise the gate itself override `initialEpicLabels`.
      'acceptance::n-a',
    ],
  });
  for (const s of stories) {
    tickets.set(s.id, {
      id: s.id,
      labels: ['type::story'],
      dependencies: s.dependencies ?? [],
    });
  }
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
      return stories.map((s) => ({
        id: s.id,
        number: s.id,
        labels: tickets.get(s.id).labels,
        dependencies: s.dependencies ?? [],
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

const defaultConfig = {
  runners: {
    deliverRunner: {
      enabled: true,
      concurrencyCap: 2,
      storyRetryCount: 0,
      blockerTimeoutHours: 0,
    },
  },
};

describe('epic-runner parity', () => {
  it('(a) local end-to-end on a fake-provider fixture', async () => {
    const epicId = 321;
    const stories = [
      { id: 400 },
      { id: 401 },
      { id: 402, dependencies: [400] },
    ];
    const provider = buildFakeProvider({ epicId, stories });
    const spawn = async () => ({ status: 'done' });

    const result = await runEpic({
      ctx: buildCtx({ epicId, provider, config: defaultConfig, spawn }),
      smokeTest: okSmokeTest,
    });

    assert.equal(result.state, 'completed');
    const epic = provider._tickets.get(epicId);
    // The runner no longer flips the Epic to review at end of wave loop;
    // the close-tail handles the remaining lifecycle.
    assert.ok(epic.labels.includes('agent::executing'));

    const epicComments = provider._comments.get(epicId) ?? [];
    const checkpointMarker = structuredCommentMarker(EPIC_RUN_STATE_TYPE);
    const checkpointCount = epicComments.filter((c) =>
      c.body.includes(checkpointMarker),
    ).length;
    assert.equal(checkpointCount, 1, 'exactly one epic-run-state comment');

    for (let i = 0; i < result.waveHistory.length; i++) {
      assert.ok(
        epicComments.some((c) => c.body.includes(waveStartMarker(i))),
        `wave-${i}-start comment present`,
      );
      assert.ok(
        epicComments.some((c) => c.body.includes(waveEndMarker(i))),
        `wave-${i}-end comment present`,
      );
    }
  });

  it('(c) local per-Story init leaves remote Epic label untouched', async () => {
    // This exercises the shape rather than forking a git worktree. Running
    // the actual story-init requires filesystem state; in the fake
    // provider we just confirm that the orchestrator does not rewrite the
    // Epic's executing label when launching a single-story sub-agent.
    const epicId = 321;
    const stories = [{ id: 400 }];
    const provider = buildFakeProvider({ epicId, stories });

    const spawn = async ({ storyId }) => {
      // Simulate story-init: transitioning child Tasks is a Story-
      // scoped side effect; the Story's label set should change but not the
      // Epic's.
      const story = provider._tickets.get(storyId);
      story.labels = ['type::story', 'agent::executing'];
      return { status: 'done' };
    };
    const labelsBefore = [...provider._tickets.get(epicId).labels];

    await runEpic({
      ctx: buildCtx({ epicId, provider, config: defaultConfig, spawn }),
      smokeTest: okSmokeTest,
    });

    const labelsAfter = provider._tickets.get(epicId).labels;
    // The runner now leaves the Epic in `agent::executing` after the wave
    // loop (the close-tail drives the rest); story label transitions are
    // Story-local.
    assert.ok(labelsAfter.includes('agent::executing'));
    assert.ok(
      labelsBefore.includes('agent::executing'),
      'sanity: executing was present before run',
    );
    const storyLabels = provider._tickets.get(400).labels;
    assert.ok(storyLabels.includes('agent::executing'));
  });

  it('(d) blocker halt-and-resume cycle', async () => {
    const epicId = 321;
    const stories = [{ id: 400 }, { id: 401 }];
    const provider = buildFakeProvider({ epicId, stories });

    const spawn = async ({ storyId }) => {
      if (storyId === 401) return { status: 'failed', detail: 'boom' };
      return { status: 'done' };
    };

    // Simulate operator flipping the Epic back to executing on the next read.
    const origGet = provider.getTicket.bind(provider);
    provider.getTicket = async (id) => {
      const t = await origGet(id);
      if (id === epicId) {
        t.labels = t.labels.filter((l) => l !== 'agent::blocked');
        if (!t.labels.includes('agent::executing'))
          t.labels.push('agent::executing');
      }
      return t;
    };

    const result = await runEpic({
      ctx: buildCtx({ epicId, provider, config: defaultConfig, spawn }),
      smokeTest: okSmokeTest,
    });

    const halted = result.waveHistory.find((w) => w.status === 'halted');
    assert.ok(halted, 'wave recorded as halted');
    assert.equal(
      result.state,
      'completed',
      'orchestrator resumed after operator unblock',
    );

    const epicComments = provider._comments.get(epicId) ?? [];
    const friction = epicComments.find((c) => /Epic blocked/.test(c.body));
    assert.ok(friction, 'blocker friction comment posted');
    assert.match(friction.body, /#401/);
  });
});
