import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  renderWaveRunProgressBody,
  upsertWaveRunProgress,
  WAVE_RUN_PROGRESS_TYPE,
} from '../../.agents/scripts/lib/orchestration/epic-runner/wave-run-progress-writer.js';
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

describe('renderWaveRunProgressBody', () => {
  it('renders the canonical payload shape from spec #902', () => {
    const { body, payload } = renderWaveRunProgressBody({
      epicId: 900,
      wave: 2,
      concurrencyCap: 3,
      stories: [
        { id: 912, title: 'A', state: 'done', tasksDone: 3, tasksTotal: 3 },
        {
          id: 916,
          title: 'B',
          state: 'in-flight',
          tasksDone: 1,
          tasksTotal: 4,
        },
        {
          id: 917,
          title: 'C',
          state: 'blocked',
          blockerCommentId: 'IC_kwDO',
        },
      ],
      updatedAt: '2026-05-01T12:00:00Z',
    });

    assert.equal(payload.kind, 'wave-run-progress');
    assert.equal(payload.epicId, 900);
    assert.equal(payload.wave, 2);
    assert.equal(payload.concurrencyCap, 3);
    assert.equal(payload.updatedAt, '2026-05-01T12:00:00Z');
    assert.equal(payload.stories.length, 3);
    assert.deepEqual(payload.stories[0], {
      id: 912,
      title: 'A',
      state: 'done',
      tasksDone: 3,
      tasksTotal: 3,
    });
    // Blocked rows carry blockerCommentId; non-blocked rows do not.
    assert.equal(payload.stories[2].blockerCommentId, 'IC_kwDO');
    assert.equal('blockerCommentId' in payload.stories[0], false);

    // Body wraps the payload in a fenced JSON block, plus a header + table.
    assert.match(body, /### 🌊 Wave 2 — 1\/3 done · cap 3/);
    assert.match(body, /\| #912 \| .*done .*\| A \| 3\/3 \|/);
    assert.match(body, /\| #917 \| .*blocked .*\| C \| — \|/);
  });

  it('renders an empty wave with a placeholder line and no table', () => {
    const { body, payload } = renderWaveRunProgressBody({
      epicId: 900,
      wave: 0,
      concurrencyCap: 2,
      stories: [],
      updatedAt: '2026-05-01T00:00:00Z',
    });
    assert.equal(payload.stories.length, 0);
    assert.match(body, /no stories assigned to this wave/);
    assert.equal(extractPayload(body).stories.length, 0);
  });

  it('rejects malformed input early', () => {
    assert.throws(
      () =>
        renderWaveRunProgressBody({
          epicId: 0,
          wave: 0,
          concurrencyCap: 1,
          stories: [],
        }),
      /numeric epicId/,
    );
    assert.throws(
      () =>
        renderWaveRunProgressBody({
          epicId: 1,
          wave: -1,
          concurrencyCap: 1,
          stories: [],
        }),
      /non-negative integer wave/,
    );
    assert.throws(
      () =>
        renderWaveRunProgressBody({
          epicId: 1,
          wave: 0,
          concurrencyCap: 0,
          stories: [],
        }),
      /positive concurrencyCap/,
    );
    assert.throws(
      () =>
        renderWaveRunProgressBody({
          epicId: 1,
          wave: 0,
          concurrencyCap: 1,
          stories: [{ id: 7, state: 'martian' }],
        }),
      /invalid state "martian"/,
    );
    assert.throws(
      () =>
        renderWaveRunProgressBody({
          epicId: 1,
          wave: 0,
          concurrencyCap: 1,
          stories: [{ state: 'done' }],
        }),
      /missing valid id/,
    );
  });
});

describe('upsertWaveRunProgress', () => {
  it('posts a fresh comment with the structured-comment marker on first run', async () => {
    const provider = buildProvider();
    const payload = await upsertWaveRunProgress({
      provider,
      epicId: 900,
      wave: 1,
      concurrencyCap: 2,
      stories: [
        { id: 912, title: 'A', state: 'done', tasksDone: 1, tasksTotal: 1 },
      ],
    });
    assert.equal(provider.comments.length, 1);
    const written = provider.comments[0];
    assert.ok(
      written.body.includes(structuredCommentMarker(WAVE_RUN_PROGRESS_TYPE)),
    );
    const parsed = extractPayload(written.body);
    assert.deepEqual(parsed.stories, payload.stories);
    assert.equal(parsed.epicId, 900);
    assert.equal(parsed.wave, 1);
  });

  it('upserts in place — re-running does not multiply comments', async () => {
    const provider = buildProvider();
    await upsertWaveRunProgress({
      provider,
      epicId: 900,
      wave: 1,
      concurrencyCap: 2,
      stories: [{ id: 912, title: 'A', state: 'in-flight' }],
    });
    await upsertWaveRunProgress({
      provider,
      epicId: 900,
      wave: 1,
      concurrencyCap: 2,
      stories: [
        { id: 912, title: 'A', state: 'done', tasksDone: 1, tasksTotal: 1 },
      ],
    });
    assert.equal(provider.comments.length, 1);
    const parsed = extractPayload(provider.comments[0].body);
    assert.equal(parsed.stories[0].state, 'done');
  });

  it('rejects providers missing postComment', async () => {
    await assert.rejects(
      () =>
        upsertWaveRunProgress({
          provider: {},
          epicId: 1,
          wave: 0,
          concurrencyCap: 1,
          stories: [],
        }),
      /provider with postComment/,
    );
  });
});
