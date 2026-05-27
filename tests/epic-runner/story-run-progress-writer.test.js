import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultStoryPhases,
  renderStoryRunProgressBody,
  STORY_PHASE_ORDER,
  STORY_RUN_PROGRESS_TYPE,
  upsertStoryRunProgress,
} from '../../.agents/scripts/lib/orchestration/epic-runner/story-run-progress-writer.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

function buildProvider(initialComments = []) {
  const comments = initialComments.map((c, i) => ({ id: c.id ?? i + 1, ...c }));
  return {
    comments,
    async getTicketComments() {
      return comments.slice();
    },
    async postComment(_ticketId, { body }) {
      const id = comments.length + 1;
      comments.push({ id, body });
      return { id };
    },
    async updateComment(commentId, { body }) {
      const target = comments.find((c) => c.id === commentId);
      if (target) target.body = body;
      return target ?? { id: commentId };
    },
    async deleteComment(commentId) {
      const idx = comments.findIndex((c) => c.id === commentId);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

function extractPayload(body) {
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  return match ? JSON.parse(match[1]) : null;
}

describe('renderStoryRunProgressBody', () => {
  it('renders the canonical payload shape from spec #902', () => {
    const { body, payload } = renderStoryRunProgressBody({
      storyId: 912,
      branch: 'story-912',
      phase: 'implementing',
      tasks: [
        {
          id: 913,
          title: 'A',
          state: 'done',
          commitSha: 'abc1234deadbeef',
        },
        { id: 914, title: 'B', state: 'executing' },
        { id: 915, title: 'C', state: 'pending' },
      ],
      updatedAt: '2026-05-01T12:00:00Z',
    });

    assert.equal(payload.kind, 'story-run-progress');
    assert.equal(payload.storyId, 912);
    assert.equal(payload.branch, 'story-912');
    assert.equal(payload.phase, 'implementing');
    assert.equal(payload.updatedAt, '2026-05-01T12:00:00Z');
    assert.equal(payload.tasks.length, 3);
    assert.deepEqual(payload.tasks[0], {
      id: 913,
      title: 'A',
      state: 'done',
      commitSha: 'abc1234deadbeef',
    });
    // commitSha only carried on `done` rows.
    assert.equal('commitSha' in payload.tasks[1], false);
    assert.equal('commitSha' in payload.tasks[2], false);

    // Body wraps the payload in a fenced JSON block, plus a header + table.
    assert.match(body, /### 📖 Story #912 — .*implementing · 1\/3 tasks done/);
    assert.match(body, /Branch: `story-912`/);
    assert.match(body, /\| #913 \| .*done .*\| A \| `abc1234` \|/);
    assert.match(body, /\| #914 \| .*executing .*\| B \| — \|/);
    assert.match(body, /\| #915 \| .*pending .*\| C \| — \|/);
  });

  it('carries blockerCommentId on blocked rows only', () => {
    const { payload } = renderStoryRunProgressBody({
      storyId: 912,
      branch: 'story-912',
      phase: 'blocked',
      tasks: [
        {
          id: 914,
          title: 'B',
          state: 'blocked',
          blockerCommentId: 'IC_kwDO',
        },
        { id: 915, title: 'C', state: 'pending' },
      ],
    });
    assert.equal(payload.tasks[0].blockerCommentId, 'IC_kwDO');
    assert.equal('blockerCommentId' in payload.tasks[1], false);
  });

  it('renders an empty story with a placeholder line and no table', () => {
    const { body, payload } = renderStoryRunProgressBody({
      storyId: 912,
      branch: 'story-912',
      phase: 'init',
      tasks: [],
      updatedAt: '2026-05-01T00:00:00Z',
    });
    assert.equal(payload.tasks.length, 0);
    assert.match(body, /no tasks recorded for this story/);
    assert.equal(extractPayload(body).tasks.length, 0);
  });

  it('rejects malformed input early', () => {
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 0,
          branch: 'story-0',
          phase: 'init',
          tasks: [],
        }),
      /numeric storyId/,
    );
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 1,
          branch: '',
          phase: 'init',
          tasks: [],
        }),
      /non-empty branch/,
    );
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 1,
          branch: 'story-1',
          phase: 'martian',
          tasks: [],
        }),
      /invalid phase "martian"/,
    );
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 1,
          branch: 'story-1',
          phase: 'init',
          tasks: [{ id: 7, state: 'martian' }],
        }),
      /invalid task state "martian"/,
    );
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 1,
          branch: 'story-1',
          phase: 'init',
          tasks: [{ state: 'pending' }],
        }),
      /missing valid id/,
    );
  });
});

describe('upsertStoryRunProgress', () => {
  it('posts a fresh comment with the structured-comment marker on first run', async () => {
    const provider = buildProvider();
    const { body, payload } = await upsertStoryRunProgress({
      provider,
      storyId: 912,
      branch: 'story-912',
      phase: 'init',
      tasks: [{ id: 913, title: 'A', state: 'pending' }],
    });
    assert.equal(provider.comments.length, 1);
    const written = provider.comments[0];
    assert.ok(
      written.body.includes(structuredCommentMarker(STORY_RUN_PROGRESS_TYPE)),
    );
    assert.ok(written.body.endsWith(body));
    const parsed = extractPayload(written.body);
    assert.deepEqual(parsed.tasks, payload.tasks);
    assert.equal(parsed.storyId, 912);
    assert.equal(parsed.phase, 'init');
  });

  it('upserts in place — re-running across Task transitions does not multiply comments', async () => {
    const provider = buildProvider();
    // pending → executing
    await upsertStoryRunProgress({
      provider,
      storyId: 912,
      branch: 'story-912',
      phase: 'implementing',
      tasks: [{ id: 913, title: 'A', state: 'executing' }],
    });
    // executing → done
    await upsertStoryRunProgress({
      provider,
      storyId: 912,
      branch: 'story-912',
      phase: 'implementing',
      tasks: [{ id: 913, title: 'A', state: 'done', commitSha: 'abc1234' }],
    });
    // implementing → closing
    await upsertStoryRunProgress({
      provider,
      storyId: 912,
      branch: 'story-912',
      phase: 'closing',
      tasks: [{ id: 913, title: 'A', state: 'done', commitSha: 'abc1234' }],
    });
    assert.equal(provider.comments.length, 1);
    const parsed = extractPayload(provider.comments[0].body);
    assert.equal(parsed.phase, 'closing');
    assert.equal(parsed.tasks[0].state, 'done');
    assert.equal(parsed.tasks[0].commitSha, 'abc1234');
  });

  it('rejects providers missing postComment', async () => {
    await assert.rejects(
      () =>
        upsertStoryRunProgress({
          provider: {},
          storyId: 1,
          branch: 'story-1',
          phase: 'init',
          tasks: [],
        }),
      /provider with postComment/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3-tier Story-phase snapshot — Story #3129.
//
// Under `planning.hierarchy: '3-tier'` the Story has no child Tasks; the
// `story-run-progress` comment carries a `phases[]` array (init / implement /
// validate / close) instead of `tasks[]`. The two shapes are mutually
// exclusive (callers MUST pass exactly one) so the snapshot stays small and
// the parent `/epic-deliver` aggregator never has to merge them.
// ---------------------------------------------------------------------------

describe('renderStoryRunProgressBody (3-tier phases shape)', () => {
  it('defaultStoryPhases seeds the canonical init/implement/validate/close shape', () => {
    const phases = defaultStoryPhases();
    assert.deepEqual(
      phases.map((p) => p.name),
      STORY_PHASE_ORDER,
    );
    assert.deepEqual(
      phases.map((p) => p.name),
      ['init', 'implement', 'validate', 'close'],
    );
    for (const p of phases) {
      assert.equal(p.status, 'pending');
      assert.equal(p.startedAt, null);
      assert.equal(p.endedAt, null);
    }
  });

  it('renders a phases[] payload when input.phases is provided', () => {
    const { body, payload } = renderStoryRunProgressBody({
      storyId: 3129,
      branch: 'story-3129',
      phase: 'implementing',
      phases: [
        {
          name: 'init',
          status: 'done',
          startedAt: '2026-05-27T15:00:00Z',
          endedAt: '2026-05-27T15:05:00Z',
        },
        {
          name: 'implement',
          status: 'in-progress',
          startedAt: '2026-05-27T15:05:00Z',
          endedAt: null,
        },
        { name: 'validate', status: 'pending', startedAt: null, endedAt: null },
        { name: 'close', status: 'pending', startedAt: null, endedAt: null },
      ],
      updatedAt: '2026-05-27T15:30:00Z',
    });

    assert.equal(payload.kind, 'story-run-progress');
    assert.equal(payload.storyId, 3129);
    assert.equal(payload.branch, 'story-3129');
    assert.equal(payload.phase, 'implementing');
    assert.equal(payload.updatedAt, '2026-05-27T15:30:00Z');
    assert.equal(
      'tasks' in payload,
      false,
      'phases shape must not carry tasks',
    );
    assert.equal(payload.phases.length, 4);
    assert.deepEqual(payload.phases[0], {
      name: 'init',
      status: 'done',
      startedAt: '2026-05-27T15:00:00Z',
      endedAt: '2026-05-27T15:05:00Z',
    });
    assert.equal(payload.phases[1].status, 'in-progress');
    assert.equal(payload.phases[1].endedAt, null);

    assert.match(
      body,
      /### 📖 Story #3129 — .*implementing · 1\/4 phases done/,
    );
    assert.match(body, /\| Phase \| Status \| Started \| Ended \|/);
    assert.match(body, /\| init \| .*done .*\| 2026-05-27T15:00:00Z \|/);
    assert.match(body, /\| implement \| .*in-progress .*\| .*\| — \|/);
  });

  it('rejects an unknown phase name', () => {
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 3129,
          branch: 'story-3129',
          phase: 'init',
          phases: [{ name: 'rollout', status: 'pending' }],
        }),
      /invalid phase name "rollout"/,
    );
  });

  it('rejects an unknown phase status', () => {
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 3129,
          branch: 'story-3129',
          phase: 'init',
          phases: [{ name: 'init', status: 'wibble' }],
        }),
      /invalid phase status "wibble"/,
    );
  });

  it('rejects passing both `phases` and `tasks` (shapes are mutually exclusive)', () => {
    assert.throws(
      () =>
        renderStoryRunProgressBody({
          storyId: 3129,
          branch: 'story-3129',
          phase: 'init',
          phases: defaultStoryPhases(),
          tasks: [{ id: 1, title: 'x', state: 'pending' }],
        }),
      /mutually exclusive/,
    );
  });

  it('4-tier tasks shape still renders with no regression', () => {
    // Sanity guard: the tasks[] path must keep emitting `tasks` in the
    // payload (not `phases`) so the parent aggregator's 4-tier readers
    // continue to work alongside the new 3-tier shape.
    const { payload } = renderStoryRunProgressBody({
      storyId: 912,
      branch: 'story-912',
      phase: 'init',
      tasks: [{ id: 913, title: 'A', state: 'pending' }],
    });
    assert.equal(Array.isArray(payload.tasks), true);
    assert.equal('phases' in payload, false);
  });
});

describe('upsertStoryRunProgress (3-tier phases shape)', () => {
  it('upserts a phases-shaped snapshot through the writer', async () => {
    const provider = buildProvider();
    const phases = defaultStoryPhases();
    phases[0].status = 'in-progress';
    phases[0].startedAt = '2026-05-27T15:00:00Z';
    const { payload } = await upsertStoryRunProgress({
      provider,
      storyId: 3129,
      branch: 'story-3129',
      phase: 'init',
      phases,
    });
    assert.equal(provider.comments.length, 1);
    const parsed = extractPayload(provider.comments[0].body);
    assert.deepEqual(parsed.phases, payload.phases);
    assert.equal(parsed.phases.length, 4);
    assert.equal(parsed.phases[0].status, 'in-progress');
    assert.equal('tasks' in parsed, false);
  });

  it('notify fan-out reports phase progress when phases[] is the shape', async () => {
    const provider = buildProvider();
    const notifications = [];
    const phases = defaultStoryPhases();
    phases[0].status = 'done';
    phases[1].status = 'in-progress';
    await upsertStoryRunProgress({
      provider,
      storyId: 3129,
      branch: 'story-3129',
      phase: 'implementing',
      phases,
      notify: (storyId, payload, opts) => {
        notifications.push({ storyId, payload, opts });
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].storyId, 3129);
    assert.match(notifications[0].payload.message, /1\/4 phases done/);
    assert.equal(notifications[0].opts.skipComment, true);
  });
});
