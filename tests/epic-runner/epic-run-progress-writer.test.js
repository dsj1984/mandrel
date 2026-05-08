import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EPIC_RUN_PROGRESS_TYPE,
  upsertEpicRunProgress,
} from '../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

function buildProvider(initialComments = []) {
  const comments = initialComments.map((c, i) => ({ id: c.id ?? i + 1, ...c }));
  return {
    comments,
    async getTicketComments() {
      return comments.slice();
    },
    async listComments() {
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

describe('upsertEpicRunProgress', () => {
  it('renders an epic-run-progress payload and upserts via the provider', async () => {
    const provider = buildProvider();
    const { body, payload } = await upsertEpicRunProgress({
      provider,
      epicId: 946,
      waves: [
        {
          wave: 0,
          concurrencyCap: 2,
          stories: [
            { id: 912, title: 'A', state: 'done', tasksDone: 3, tasksTotal: 3 },
            { id: 913, title: 'B', state: 'done', tasksDone: 1, tasksTotal: 1 },
          ],
        },
        {
          wave: 1,
          concurrencyCap: 2,
          stories: [{ id: 916, title: 'C', state: 'in-flight' }],
        },
      ],
      currentWave: 1,
      totalWaves: 3,
      startedAt: '2026-05-01T00:00:00Z',
      now: () => new Date('2026-05-01T01:00:00.000Z'),
    });

    assert.equal(provider.comments.length, 1);
    const written = provider.comments[0];
    assert.ok(
      written.body.includes(structuredCommentMarker(EPIC_RUN_PROGRESS_TYPE)),
      'comment body carries the epic-run-progress marker',
    );

    assert.equal(payload.kind, EPIC_RUN_PROGRESS_TYPE);
    assert.equal(payload.epicId, 946);
    assert.equal(payload.currentWave, 1);
    assert.equal(payload.totalWaves, 3);
    assert.equal(payload.startedAt, '2026-05-01T00:00:00Z');
    assert.equal(payload.updatedAt, '2026-05-01T01:00:00.000Z');
    assert.equal(payload.waves.length, 2);

    // Header reflects the done count and wave progress.
    assert.match(body, /Wave 2\/3/);
    assert.match(body, /2\/3 stories done/);
    // Table rows for both waves render with the correct state emoji.
    assert.match(body, /\| 1 \| #912 \| .*done .*\| A \|/);
    assert.match(body, /\| 2 \| #916 \| .*in-flight .*\| C \|/);

    // The fenced payload round-trips.
    const roundTripped = extractPayload(body);
    assert.deepEqual(roundTripped, payload);
  });

  it('handles empty waves[] gracefully', async () => {
    const provider = buildProvider();
    const { body, payload } = await upsertEpicRunProgress({
      provider,
      epicId: 1,
      waves: [],
      currentWave: 0,
      totalWaves: 0,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    assert.equal(payload.waves.length, 0);
    assert.match(body, /no waves yet/);
    // Still upserts a single comment.
    assert.equal(provider.comments.length, 1);
  });

  it('upserts in place — re-running does not multiply comments', async () => {
    const provider = buildProvider();
    await upsertEpicRunProgress({
      provider,
      epicId: 946,
      waves: [{ wave: 0, stories: [{ id: 912, state: 'in-flight' }] }],
      currentWave: 0,
      totalWaves: 2,
    });
    await upsertEpicRunProgress({
      provider,
      epicId: 946,
      waves: [
        {
          wave: 0,
          stories: [{ id: 912, state: 'done', tasksDone: 1, tasksTotal: 1 }],
        },
      ],
      currentWave: 1,
      totalWaves: 2,
    });
    assert.equal(provider.comments.length, 1);
    const parsed = extractPayload(provider.comments[0].body);
    assert.equal(parsed.waves[0].stories[0].state, 'done');
  });

  it('rejects bad provider / numeric arguments', async () => {
    await assert.rejects(
      () =>
        upsertEpicRunProgress({
          provider: {},
          epicId: 1,
          waves: [],
          currentWave: 0,
          totalWaves: 0,
        }),
      /provider with postComment/,
    );
    await assert.rejects(
      () =>
        upsertEpicRunProgress({
          provider: buildProvider(),
          epicId: 0,
          waves: [],
          currentWave: 0,
          totalWaves: 0,
        }),
      /numeric epicId/,
    );
    await assert.rejects(
      () =>
        upsertEpicRunProgress({
          provider: buildProvider(),
          epicId: 1,
          waves: [],
          currentWave: -1,
          totalWaves: 0,
        }),
      /currentWave/,
    );
    await assert.rejects(
      () =>
        upsertEpicRunProgress({
          provider: buildProvider(),
          epicId: 1,
          waves: [],
          currentWave: 0,
          totalWaves: -1,
        }),
      /totalWaves/,
    );
  });
});
