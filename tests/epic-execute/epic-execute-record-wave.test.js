import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyWaveOutcome,
  resolveResultArg,
  runEpicExecuteRecordWave,
} from '../../.agents/scripts/epic-execute-record-wave.js';
import { Checkpointer } from '../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';

function createFakeProvider() {
  let autoId = 1;
  const comments = new Map();
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

async function seedCheckpoint(provider, epicId, overrides = {}) {
  const cp = new Checkpointer({ provider, epicId });
  return cp.initialize({
    totalWaves: 3,
    concurrencyCap: 2,
    autoClose: false,
    ...overrides,
  });
}

describe('classifyWaveOutcome', () => {
  it('complete + remaining waves → dispatch-next', () => {
    assert.deepEqual(
      classifyWaveOutcome({
        resultStatus: 'complete',
        currentWave: 0,
        totalWaves: 3,
      }),
      { nextAction: 'dispatch-next', remainingWaves: 2 },
    );
  });

  it('complete + last wave → finalize', () => {
    assert.deepEqual(
      classifyWaveOutcome({
        resultStatus: 'complete',
        currentWave: 2,
        totalWaves: 3,
      }),
      { nextAction: 'finalize', remainingWaves: 0 },
    );
  });

  it('blocked → halt-blocked', () => {
    const out = classifyWaveOutcome({
      resultStatus: 'blocked',
      currentWave: 1,
      totalWaves: 3,
    });
    assert.equal(out.nextAction, 'halt-blocked');
    assert.equal(out.remainingWaves, 1);
  });

  it('failed → halt-failed', () => {
    const out = classifyWaveOutcome({
      resultStatus: 'failed',
      currentWave: 0,
      totalWaves: 3,
    });
    assert.equal(out.nextAction, 'halt-failed');
  });

  it('throws on unknown status', () => {
    assert.throws(
      () =>
        classifyWaveOutcome({
          resultStatus: 'glorbo',
          currentWave: 0,
          totalWaves: 3,
        }),
      /must be one of/,
    );
  });
});

describe('resolveResultArg', () => {
  it('parses inline JSON', () => {
    assert.deepEqual(resolveResultArg('{"status":"complete","stories":[]}'), {
      status: 'complete',
      stories: [],
    });
  });

  it('parses @<file> via injected reader', () => {
    const fakeRead = (p) => {
      assert.equal(p, '/tmp/wave.json');
      return '{"status":"blocked"}';
    };
    assert.deepEqual(
      resolveResultArg('@/tmp/wave.json', { readFileImpl: fakeRead }),
      { status: 'blocked' },
    );
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => resolveResultArg('not-json'), /not valid JSON/);
  });
});

describe('runEpicExecuteRecordWave', () => {
  it('appends the wave outcome and returns dispatch-next when more waves remain', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 555);

    const out = await runEpicExecuteRecordWave({
      epicId: 555,
      wave: 0,
      result: {
        status: 'complete',
        stories: [{ storyId: 1, status: 'done' }],
      },
      injectedProvider: provider,
      now: () => new Date('2026-05-02T12:00:00Z'),
    });

    assert.equal(out.recorded, true);
    assert.equal(out.nextAction, 'dispatch-next');
    assert.equal(out.remainingWaves, 2);

    const cp = new Checkpointer({ provider, epicId: 555 });
    const state = await cp.read();
    assert.equal(state.waves.length, 1);
    assert.equal(state.waves[0].index, 0);
    assert.equal(state.waves[0].status, 'complete');
    assert.equal(state.waves[0].completedAt, '2026-05-02T12:00:00.000Z');
    assert.equal(state.currentWave, 1);
  });

  it('returns finalize on the last wave', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 556, { totalWaves: 2 });

    // First wave already recorded.
    await runEpicExecuteRecordWave({
      epicId: 556,
      wave: 0,
      result: { status: 'complete', stories: [] },
      injectedProvider: provider,
    });
    const out = await runEpicExecuteRecordWave({
      epicId: 556,
      wave: 1,
      result: { status: 'complete', stories: [] },
      injectedProvider: provider,
    });
    assert.equal(out.nextAction, 'finalize');
    assert.equal(out.remainingWaves, 0);
  });

  it('returns halt-blocked when the wave is blocked', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 557);
    const out = await runEpicExecuteRecordWave({
      epicId: 557,
      wave: 0,
      result: {
        status: 'blocked',
        stories: [{ storyId: 9, status: 'blocked' }],
      },
      injectedProvider: provider,
    });
    assert.equal(out.nextAction, 'halt-blocked');
    // currentWave must NOT advance on a halt — resume re-dispatches the same wave.
    const state = await new Checkpointer({ provider, epicId: 557 }).read();
    assert.equal(state.currentWave, 0);
  });

  it('replaces a prior record for the same wave (idempotent re-record)', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 558);
    await runEpicExecuteRecordWave({
      epicId: 558,
      wave: 0,
      result: { status: 'failed', stories: [] },
      injectedProvider: provider,
    });
    await runEpicExecuteRecordWave({
      epicId: 558,
      wave: 0,
      result: { status: 'complete', stories: [{ storyId: 1, status: 'done' }] },
      injectedProvider: provider,
    });
    const state = await new Checkpointer({ provider, epicId: 558 }).read();
    assert.equal(state.waves.length, 1);
    assert.equal(state.waves[0].status, 'complete');
  });

  it('throws when no checkpoint exists', async () => {
    const provider = createFakeProvider();
    await assert.rejects(
      runEpicExecuteRecordWave({
        epicId: 559,
        wave: 0,
        result: { status: 'complete' },
        injectedProvider: provider,
      }),
      /no epic-run-state checkpoint found/,
    );
  });

  it('throws on malformed wave result', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 560);
    await assert.rejects(
      runEpicExecuteRecordWave({
        epicId: 560,
        wave: 0,
        result: null,
        injectedProvider: provider,
      }),
      /must be a JSON object/,
    );
    await assert.rejects(
      runEpicExecuteRecordWave({
        epicId: 560,
        wave: 0,
        result: { status: 'gibberish' },
        injectedProvider: provider,
      }),
      /must be one of/,
    );
  });
});
