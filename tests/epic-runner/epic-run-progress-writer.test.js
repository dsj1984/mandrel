import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EPIC_RUN_PROGRESS_TYPE,
  parseWaveRunProgressComment,
  upsertEpicRunProgress,
  WAVE_RUN_PROGRESS_TYPE,
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

function buildWaveCommentBody(payload) {
  const marker = structuredCommentMarker(WAVE_RUN_PROGRESS_TYPE);
  return `${marker}\n\n### 🌊 Wave ${payload.wave}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

describe('parseWaveRunProgressComment', () => {
  it('parses a canonical wave-run-progress payload', () => {
    const payload = {
      kind: 'wave-run-progress',
      epicId: 900,
      wave: 1,
      concurrencyCap: 3,
      stories: [
        { id: 912, title: 'A', state: 'done', tasksDone: 2, tasksTotal: 2 },
        { id: 916, title: 'B', state: 'blocked', blockerCommentId: 'IC_x' },
      ],
      updatedAt: '2026-05-01T12:00:00Z',
    };
    const parsed = parseWaveRunProgressComment({
      body: buildWaveCommentBody(payload),
    });
    assert.equal(parsed.kind, 'wave-run-progress');
    assert.equal(parsed.epicId, 900);
    assert.equal(parsed.wave, 1);
    assert.equal(parsed.concurrencyCap, 3);
    assert.equal(parsed.stories.length, 2);
    assert.equal(parsed.updatedAt, '2026-05-01T12:00:00Z');
  });

  it('returns null for missing comment / missing body', () => {
    assert.equal(parseWaveRunProgressComment(null), null);
    assert.equal(parseWaveRunProgressComment(undefined), null);
    assert.equal(parseWaveRunProgressComment({}), null);
  });

  it('returns null for malformed bodies (no fence, bad JSON, wrong kind)', () => {
    assert.equal(
      parseWaveRunProgressComment({ body: 'plain text — no fence' }),
      null,
    );
    assert.equal(
      parseWaveRunProgressComment({ body: '```json\nnot-json\n```' }),
      null,
    );
    assert.equal(
      parseWaveRunProgressComment({
        body: '```json\n{"kind":"phase-timings","epicId":1,"wave":0,"stories":[]}\n```',
      }),
      null,
    );
  });

  it('returns null when required numeric fields are out of range', () => {
    assert.equal(
      parseWaveRunProgressComment({
        body: '```json\n{"kind":"wave-run-progress","epicId":0,"wave":0,"stories":[]}\n```',
      }),
      null,
    );
    assert.equal(
      parseWaveRunProgressComment({
        body: '```json\n{"kind":"wave-run-progress","epicId":1,"wave":-1,"stories":[]}\n```',
      }),
      null,
    );
    assert.equal(
      parseWaveRunProgressComment({
        body: '```json\n{"kind":"wave-run-progress","epicId":1,"wave":0,"stories":"nope"}\n```',
      }),
      null,
    );
  });

  it('defaults concurrencyCap to 0 when absent and tolerates missing updatedAt', () => {
    const parsed = parseWaveRunProgressComment({
      body: '```json\n{"kind":"wave-run-progress","epicId":7,"wave":2,"stories":[]}\n```',
    });
    assert.equal(parsed.concurrencyCap, 0);
    assert.equal(parsed.updatedAt, undefined);
    assert.deepEqual(parsed.stories, []);
  });
});

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
