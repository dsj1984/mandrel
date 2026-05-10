import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EPIC_RUN_STATE_TYPE } from '../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';
import { runEpic } from '../../.agents/scripts/lib/orchestration/epic-runner.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';
import { buildCtx } from './_build-ctx.js';

// Stub the pre-wave smoke-test so these integration tests stay hermetic
// across CI runners that may not have the `claude` binary on PATH.
const okSmokeTest = {
  verify: async () => ({ ok: true, detail: 'stub', exitCode: 0 }),
};

/**
 * Fake provider — minimal surface needed by the runner under test:
 *   - getTicket, getSubTickets
 *   - getTicketComments, postComment, deleteComment (for upsert)
 *   - updateTicket (label flips + sub-issue close)
 */
function buildFakeProvider({ epicId, stories }) {
  let autoId = 1;
  const tickets = new Map();
  const comments = new Map();

  tickets.set(epicId, {
    id: epicId,
    labels: ['type::epic', 'agent::executing'],
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

describe('EpicRunner integration', () => {
  it('drives a two-wave epic to completion via happy-path spawns', async () => {
    const epicId = 321;
    const stories = [
      { id: 400, dependencies: [] },
      { id: 401, dependencies: [] },
      { id: 402, dependencies: [400] }, // wave 2
    ];
    const provider = buildFakeProvider({ epicId, stories });

    const spawned = [];
    const spawn = async ({ storyId }) => {
      spawned.push(storyId);
      // mark story done so cascade-like flows see it (not used here but
      // mirrors real behavior)
      const t = provider._tickets.get(storyId);
      t.labels = ['type::story', 'agent::done'];
      return { status: 'done' };
    };

    const config = {
      runners: {
        deliverRunner: {
          enabled: true,
          concurrencyCap: 2,
          storyRetryCount: 0,
          blockerTimeoutHours: 0,
        },
      },
    };

    const ctx = buildCtx({
      epicId,
      provider,
      config,
      spawn,
    });
    const result = await runEpic({ ctx, smokeTest: okSmokeTest });

    assert.equal(result.state, 'completed');
    assert.equal(result.waveHistory.length, 2);
    assert.deepEqual(
      result.waveHistory.map((w) => w.status),
      ['completed', 'completed'],
    );
    assert.deepEqual([...spawned].sort(), [400, 401, 402]);

    // After the wave loop the Epic is no longer flipped to a review state by
    // the runner; the close-tail (in `epic-deliver-close-tail.js`) drives the
    // remaining lifecycle. The Epic stays in `agent::executing` here until
    // the close-tail runs.
    const epic = provider._tickets.get(epicId);
    assert.ok(epic.labels.includes('agent::executing'));

    // Exactly one checkpoint comment survives.
    const marker = structuredCommentMarker(EPIC_RUN_STATE_TYPE);
    const epicComments = provider._comments.get(epicId) ?? [];
    const checkpoints = epicComments.filter((c) => c.body.includes(marker));
    assert.equal(checkpoints.length, 1);
  });

  it('filters non-story descendants returned by getSubTickets', async () => {
    // Real GitHub provider's `getSubTickets` returns the full descendant set
    // (Features, PRD, Tech Spec, Stories, Tasks) via native sub-issues plus
    // body reverse-lookup. The runner must filter to `type::story` before
    // building the wave DAG — otherwise non-stories reach `story-init`
    // and fail its type guard.
    const epicId = 500;
    const stories = [{ id: 600, dependencies: [] }];
    const provider = buildFakeProvider({ epicId, stories });

    // Seed non-story descendants that the real provider would also return.
    provider._tickets.set(700, { id: 700, labels: ['type::feature'] });
    provider._tickets.set(701, { id: 701, labels: ['context::prd'] });
    provider._tickets.set(702, { id: 702, labels: ['type::task'] });
    const origGetSub = provider.getSubTickets.bind(provider);
    provider.getSubTickets = async (parent) => {
      const stories = await origGetSub(parent);
      return [
        ...stories,
        { id: 700, labels: ['type::feature'] },
        { id: 701, labels: ['context::prd'] },
        { id: 702, labels: ['type::task'] },
      ];
    };

    const spawned = [];
    const spawn = async ({ storyId }) => {
      spawned.push(storyId);
      return { status: 'done' };
    };

    await runEpic({
      ctx: buildCtx({
        epicId,
        provider,
        spawn,
        gitAdapter: async () => 1,
        config: {
          runners: {
            deliverRunner: {
              enabled: true,
              concurrencyCap: 1,
              storyRetryCount: 0,
              blockerTimeoutHours: 0,
            },
          },
        },
      }),
      smokeTest: okSmokeTest,
    });

    assert.deepEqual(spawned, [600], 'only the story should be spawned');
  });

  it('halts on a failed story and flips the epic to agent::blocked', async () => {
    const epicId = 321;
    const stories = [
      { id: 400, dependencies: [] },
      { id: 401, dependencies: [] },
    ];
    const provider = buildFakeProvider({ epicId, stories });

    const spawn = async ({ storyId }) => {
      if (storyId === 401) return { status: 'failed', detail: 'compile error' };
      return { status: 'done' };
    };

    const config = {
      runners: {
        deliverRunner: {
          enabled: true,
          concurrencyCap: 2,
          storyRetryCount: 0,
          blockerTimeoutHours: 0,
        },
      },
    };

    // Pre-arm the epic to resume immediately by flipping it back to
    // executing before halt enters the wait loop; we simulate the operator
    // intervention by patching the provider's getTicket to return executing
    // on every poll.
    const origGetTicket = provider.getTicket.bind(provider);
    provider.getTicket = async (id) => {
      const t = await origGetTicket(id);
      if (id === epicId) {
        // Operator flipped back — resume.
        t.labels = t.labels.filter((l) => l !== 'agent::blocked');
        if (!t.labels.includes('agent::executing'))
          t.labels.push('agent::executing');
      }
      return t;
    };

    const result = await runEpic({
      ctx: buildCtx({
        epicId,
        provider,
        spawn,
        config,
        gitAdapter: async () => 1,
      }),
      smokeTest: okSmokeTest,
    });

    // After resume, no more waves remain, so final state is 'completed'.
    assert.equal(result.state, 'completed');
    const halted = result.waveHistory.find((w) => w.status === 'halted');
    assert.ok(halted, 'one wave should record a halt');
  });

  it('reclassifies a zero-delta `done` story as failed with commit-assertion detail', async () => {
    const epicId = 321;
    const stories = [
      { id: 400, dependencies: [] },
      { id: 401, dependencies: [] },
    ];
    const provider = buildFakeProvider({ epicId, stories });

    // Both stories report done via spawn, but story 401 produced zero commits
    // on its story branch — the post-wave commit assertion must reclassify it.
    const spawn = async ({ storyId }) => {
      const t = provider._tickets.get(storyId);
      t.labels = ['type::story', 'agent::done'];
      return { status: 'done' };
    };

    const gitAdapter = async ({ storyId }) => (storyId === 401 ? 0 : 3);

    const config = {
      runners: {
        deliverRunner: {
          enabled: true,
          concurrencyCap: 2,
          storyRetryCount: 0,
          blockerTimeoutHours: 0,
        },
      },
    };

    // The reclassification turns this wave into a halt; pre-arm the provider
    // to auto-resume so the runner can finalize rather than hanging.
    const origGetTicket = provider.getTicket.bind(provider);
    provider.getTicket = async (id) => {
      const t = await origGetTicket(id);
      if (id === epicId) {
        t.labels = t.labels.filter((l) => l !== 'agent::blocked');
        if (!t.labels.includes('agent::executing'))
          t.labels.push('agent::executing');
      }
      return t;
    };

    const result = await runEpic({
      ctx: buildCtx({
        epicId,
        provider,
        spawn,
        config,
        gitAdapter,
      }),
      smokeTest: okSmokeTest,
    });

    const wave = result.waveHistory[0];
    assert.equal(wave.status, 'halted', 'zero-delta row must halt the wave');
    const reclassified = wave.stories.find((s) => s.storyId === 401);
    assert.equal(reclassified.status, 'failed');
    assert.equal(reclassified.detail, 'commit-assertion: zero-delta');
    assert.equal(reclassified.newCommitCount, 0);

    // And the wave-end structured comment reflects the reclassification.
    const epicComments = provider._comments.get(epicId) ?? [];
    const waveEnd = epicComments.find((c) =>
      c.body.includes('type="wave-0-end"'),
    );
    assert.ok(waveEnd, 'wave-end comment written');
    assert.match(waveEnd.body, /halted/);
    assert.match(waveEnd.body, /commit-assertion: zero-delta/);
  });
});
