import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  renderStoryRunProgressBody,
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
