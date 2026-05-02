import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runEpicRollup } from '../../.agents/scripts/epic-rollup.js';
import {
  EPIC_RUN_PROGRESS_TYPE,
  WAVE_RUN_PROGRESS_TYPE,
} from '../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

function waveCommentBody({
  epicId = 100,
  wave,
  stories,
  concurrencyCap = 2,
  updatedAt = '2026-05-02T12:00:00Z',
}) {
  const payload = {
    kind: WAVE_RUN_PROGRESS_TYPE,
    epicId,
    wave,
    concurrencyCap,
    stories,
    updatedAt,
  };
  return `${structuredCommentMarker(WAVE_RUN_PROGRESS_TYPE)}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function createFakeProvider({ initialComments = [] } = {}) {
  let autoId = 1;
  const comments = new Map();
  for (const [ticketId, list] of initialComments) {
    comments.set(
      ticketId,
      list.map((body) => ({ id: autoId++, body })),
    );
  }
  return {
    _comments: comments,
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const list = comments.get(ticketId) ?? [];
      const c = { id: autoId++, body: payload.body };
      list.push(c);
      comments.set(ticketId, list);
      return c;
    },
    async deleteComment(commentId) {
      for (const [, list] of comments) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
  };
}

describe('runEpicRollup', () => {
  it('aggregates every wave-run-progress comment into a single epic-run-progress comment', async () => {
    const provider = createFakeProvider({
      initialComments: [
        [
          100,
          [
            'unrelated friction comment',
            waveCommentBody({
              wave: 0,
              stories: [
                { id: 1, title: 'A', state: 'done' },
                { id: 2, title: 'B', state: 'done' },
              ],
            }),
            waveCommentBody({
              wave: 1,
              stories: [{ id: 3, title: 'C', state: 'done' }],
            }),
          ],
        ],
      ],
    });

    const out = await runEpicRollup({
      epicId: 100,
      currentWave: 1,
      totalWaves: 2,
      injectedProvider: provider,
      now: () => new Date('2026-05-02T13:00:00Z'),
    });

    assert.deepEqual(out, {
      epicId: 100,
      currentWave: 1,
      totalWaves: 2,
      wavesAggregated: 2,
    });

    // The Epic now carries an epic-run-progress comment whose body lists
    // both waves in order.
    const all = provider._comments.get(100) ?? [];
    const epicProgress = all.find((c) =>
      c.body.includes(structuredCommentMarker(EPIC_RUN_PROGRESS_TYPE)),
    );
    assert.ok(epicProgress, 'epic-run-progress must be persisted');
    assert.match(epicProgress.body, /"wave":\s*0/);
    assert.match(epicProgress.body, /"wave":\s*1/);
  });

  it('latest wave comment for the same wave wins (dedup by wave index)', async () => {
    const provider = createFakeProvider({
      initialComments: [
        [
          200,
          [
            waveCommentBody({
              wave: 0,
              stories: [{ id: 1, title: 'A', state: 'failed' }],
              updatedAt: '2026-05-02T11:00:00Z',
            }),
            waveCommentBody({
              wave: 0,
              stories: [{ id: 1, title: 'A', state: 'done' }],
              updatedAt: '2026-05-02T12:00:00Z',
            }),
          ],
        ],
      ],
    });
    const out = await runEpicRollup({
      epicId: 200,
      currentWave: 0,
      totalWaves: 1,
      injectedProvider: provider,
    });
    assert.equal(out.wavesAggregated, 1);
    const all = provider._comments.get(200) ?? [];
    const epicProgress = all.find((c) =>
      c.body.includes(structuredCommentMarker(EPIC_RUN_PROGRESS_TYPE)),
    );
    assert.ok(epicProgress);
    // Latest snapshot's `done` state must be reflected; the earlier `failed`
    // body must NOT appear.
    assert.match(epicProgress.body, /"state":\s*"done"/);
    assert.doesNotMatch(epicProgress.body, /"state":\s*"failed"/);
  });

  it('returns wavesAggregated=0 when no wave comments exist yet', async () => {
    const provider = createFakeProvider({
      initialComments: [[300, ['some other unrelated comment']]],
    });
    const out = await runEpicRollup({
      epicId: 300,
      currentWave: 0,
      totalWaves: 3,
      injectedProvider: provider,
    });
    assert.equal(out.wavesAggregated, 0);
  });

  it('validates inputs', async () => {
    await assert.rejects(
      runEpicRollup({ epicId: 0, currentWave: 0, totalWaves: 1 }),
      /must be a positive integer/,
    );
    await assert.rejects(
      runEpicRollup({ epicId: 1, currentWave: -1, totalWaves: 1 }),
      /must be a non-negative integer/,
    );
    await assert.rejects(
      runEpicRollup({ epicId: 1, currentWave: 0, totalWaves: -1 }),
      /must be a non-negative integer/,
    );
  });
});
