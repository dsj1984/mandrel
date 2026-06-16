import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { upsertEpicRunProgress } from '../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter/composition.js';
import { EPIC_RUN_PROGRESS_TYPE } from '../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter/signals.js';
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
  it('renders a flat per-Story epic-run-progress payload and upserts it', async () => {
    const provider = buildProvider();
    const { body, payload } = await upsertEpicRunProgress({
      provider,
      epicId: 946,
      stories: {
        912: { status: 'done', title: 'A' },
        913: { status: 'done', title: 'B' },
        916: { status: 'blocked', title: 'C', blockerCommentId: 'b-1' },
      },
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
    assert.equal(payload.startedAt, '2026-05-01T00:00:00Z');
    assert.equal(payload.updatedAt, '2026-05-01T01:00:00.000Z');
    // Flat, ascending-by-id story rows — no wave grouping.
    assert.equal(payload.stories.length, 3);
    assert.deepEqual(
      payload.stories.map((s) => s.id),
      [912, 913, 916],
    );
    assert.equal(payload.stories[2].blockerCommentId, 'b-1');
    assert.equal(payload.currentWave, undefined);
    assert.equal(payload.totalWaves, undefined);
    assert.equal(payload.waves, undefined);

    // Header reflects the done count; flat ID/State/Title table.
    assert.match(body, /2\/3 stories done/);
    assert.match(body, /\| ID \| State \| Title \|/);
    assert.match(body, /\| #912 \| .*done .*\| A \|/);

    const roundTripped = extractPayload(body);
    assert.deepEqual(roundTripped, payload);
  });

  it('handles an empty stories map gracefully', async () => {
    const provider = buildProvider();
    const { body, payload } = await upsertEpicRunProgress({
      provider,
      epicId: 1,
      stories: {},
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    assert.equal(payload.stories.length, 0);
    assert.match(body, /no stories yet/);
    assert.equal(provider.comments.length, 1);
  });

  it('upserts in place — re-running does not multiply comments', async () => {
    const provider = buildProvider();
    await upsertEpicRunProgress({
      provider,
      epicId: 946,
      stories: { 912: { status: 'pending' } },
    });
    await upsertEpicRunProgress({
      provider,
      epicId: 946,
      stories: { 912: { status: 'done' } },
    });
    assert.equal(provider.comments.length, 1);
    const parsed = extractPayload(provider.comments[0].body);
    assert.equal(parsed.stories[0].state, 'done');
  });

  it('rejects bad provider / numeric arguments', async () => {
    await assert.rejects(
      () => upsertEpicRunProgress({ provider: {}, epicId: 1, stories: {} }),
      /provider with postComment/,
    );
    await assert.rejects(
      () =>
        upsertEpicRunProgress({
          provider: buildProvider(),
          epicId: 0,
          stories: {},
        }),
      /numeric epicId/,
    );
  });
});
