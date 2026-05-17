import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateWaveStatus,
  classifyWaveOutcome,
  parseInputArg,
  runEpicExecuteRecordWave,
  validateResults,
} from '../../.agents/scripts/epic-execute-record-wave.js';
import { Checkpointer } from '../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';

function createFakeProvider({ ticketsById } = {}) {
  let autoId = 1;
  const comments = new Map();
  const provider = {
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
  // Only attach `getTicket` when the test has seeded ticket state.
  // `verifyWaveResults` short-circuits when the provider lacks `getTicket`,
  // so happy-path tests that don't care about verification can omit it.
  if (ticketsById) {
    provider.getTicket = async (id) => ticketsById[id] ?? null;
  }
  return provider;
}

async function seedCheckpoint(provider, epicId, overrides = {}) {
  const cp = new Checkpointer({ provider, epicId });
  return cp.initialize({
    totalWaves: 3,
    concurrencyCap: 2,
    ...overrides,
  });
}

const TEST_CONFIG = {
  orchestration: { runners: { deliverRunner: { concurrencyCap: 2 } } },
};

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

describe('aggregateWaveStatus', () => {
  it('all done → complete', () => {
    assert.deepEqual(
      aggregateWaveStatus([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'done' },
      ]),
      { status: 'complete', blockedStoryIds: [] },
    );
  });

  it('any blocked + no failed → blocked', () => {
    assert.deepEqual(
      aggregateWaveStatus([
        { storyId: 1, status: 'done' },
        { storyId: 2, status: 'blocked' },
      ]),
      { status: 'blocked', blockedStoryIds: [2] },
    );
  });

  it('any failed → failed', () => {
    const out = aggregateWaveStatus([
      { storyId: 1, status: 'failed' },
      { storyId: 2, status: 'blocked' },
    ]);
    assert.equal(out.status, 'failed');
  });

  it('empty → complete (no-op fan-out)', () => {
    assert.deepEqual(aggregateWaveStatus([]), {
      status: 'complete',
      blockedStoryIds: [],
    });
  });
});

describe('validateResults', () => {
  it('accepts canonical /story-deliver return rows', () => {
    const out = validateResults([
      { storyId: 1, status: 'done', tasksDone: 3, tasksTotal: 3 },
      { storyId: 2, status: 'blocked', blockerCommentId: 'c-99' },
    ]);
    assert.deepEqual(out[0], {
      storyId: 1,
      status: 'done',
      tasksDone: 3,
      tasksTotal: 3,
    });
    assert.equal(out[1].blockerCommentId, 'c-99');
  });

  it('rejects non-array input', () => {
    assert.throws(
      () => validateResults({ storyId: 1 }),
      /must be a JSON array/,
    );
  });

  it('rejects unknown status', () => {
    assert.throws(
      () => validateResults([{ storyId: 1, status: 'glorbo' }]),
      /must be one of/,
    );
  });
});

describe('parseInputArg', () => {
  it('parses inline JSON array', () => {
    assert.deepEqual(parseInputArg('[{"storyId":1,"status":"done"}]'), [
      { storyId: 1, status: 'done' },
    ]);
  });

  it('parses @<file> via injected reader', () => {
    const fakeRead = (p) => {
      assert.equal(p, '/tmp/results.json');
      return '[{"storyId":2,"status":"blocked"}]';
    };
    assert.deepEqual(
      parseInputArg('@/tmp/results.json', { readFile: fakeRead }),
      [{ storyId: 2, status: 'blocked' }],
    );
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parseInputArg('not-json'), /not valid JSON/);
  });
});

describe('runEpicExecuteRecordWave', () => {
  it('appends the wave outcome and returns dispatch-next when more waves remain', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 555);

    const out = await runEpicExecuteRecordWave({
      epicId: 555,
      wave: 0,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
      now: () => new Date('2026-05-02T12:00:00Z'),
    });

    assert.equal(out.recorded, true);
    assert.equal(out.status, 'complete');
    assert.equal(out.nextAction, 'dispatch-next');
    assert.equal(out.remainingWaves, 2);
    assert.equal(typeof out.renderedBody, 'string');
    assert.match(out.renderedBody, /Epic Progress/);

    const cp = new Checkpointer({ provider, epicId: 555 });
    const state = await cp.read();
    assert.equal(state.waves.length, 1);
    assert.equal(state.waves[0].index, 0);
    assert.equal(state.waves[0].status, 'complete');
    assert.equal(state.waves[0].completedAt, '2026-05-02T12:00:00.000Z');
    assert.equal(state.waves[0].concurrencyCap, 2);
    assert.equal(state.waves[0].stories[0].id, 1);
    assert.equal(state.waves[0].stories[0].state, 'done');
    assert.equal(state.currentWave, 1);
  });

  it('returns finalize on the last wave', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 556, { totalWaves: 2 });

    await runEpicExecuteRecordWave({
      epicId: 556,
      wave: 0,
      results: [],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    const out = await runEpicExecuteRecordWave({
      epicId: 556,
      wave: 1,
      results: [],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    assert.equal(out.nextAction, 'finalize');
    assert.equal(out.remainingWaves, 0);
  });

  it('returns halt-blocked when any Story returned blocked', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 557);
    const out = await runEpicExecuteRecordWave({
      epicId: 557,
      wave: 0,
      results: [
        { storyId: 1, status: 'done' },
        { storyId: 9, status: 'blocked' },
      ],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    assert.equal(out.status, 'blocked');
    assert.deepEqual(out.blockedStoryIds, [9]);
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
      results: [{ storyId: 1, status: 'failed' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    await runEpicExecuteRecordWave({
      epicId: 558,
      wave: 0,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    const state = await new Checkpointer({ provider, epicId: 558 }).read();
    assert.equal(state.waves.length, 1);
    assert.equal(state.waves[0].status, 'complete');
  });

  it('downgrades unverified `done` claims to failed', async () => {
    // Live ticket carries `agent::executing`, not `agent::done` — verify path
    // catches the mismatch and reclassifies the wave row.
    const provider = createFakeProvider({
      ticketsById: {
        7: { labels: ['agent::executing'], state: 'open' },
      },
    });
    await seedCheckpoint(provider, 559);
    const out = await runEpicExecuteRecordWave({
      epicId: 559,
      wave: 0,
      results: [{ storyId: 7, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    assert.equal(out.status, 'failed');
    assert.ok(Array.isArray(out.discrepancies));
    assert.equal(out.discrepancies.length, 1);
    assert.equal(out.discrepancies[0].storyId, 7);
    assert.equal(out.discrepancies[0].claimed, 'done');
  });

  it('upserts a single epic-run-progress comment grouped by wave', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 560, { totalWaves: 2 });
    await runEpicExecuteRecordWave({
      epicId: 560,
      wave: 0,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    await runEpicExecuteRecordWave({
      epicId: 560,
      wave: 1,
      results: [{ storyId: 2, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
    });
    const epicComments = provider._comments.get(560) ?? [];
    const epicProgress = epicComments.filter((c) =>
      /epic-run-progress/.test(c.body),
    );
    // upsert keeps a single comment; no `wave-run-progress` companion
    assert.equal(epicProgress.length, 1);
    const waveProgress = epicComments.filter((c) =>
      /wave-run-progress/.test(c.body),
    );
    assert.equal(waveProgress.length, 0);
  });

  it('throws when no checkpoint exists', async () => {
    const provider = createFakeProvider();
    await assert.rejects(
      runEpicExecuteRecordWave({
        epicId: 561,
        wave: 0,
        results: [],
        injectedProvider: provider,
        injectedConfig: TEST_CONFIG,
      }),
      /no epic-run-state checkpoint found/,
    );
  });

  it('rejects passing both results and returns', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 562);
    await assert.rejects(
      runEpicExecuteRecordWave({
        epicId: 562,
        wave: 0,
        results: [],
        returns: [],
        injectedProvider: provider,
        injectedConfig: TEST_CONFIG,
      }),
      /not both/,
    );
  });

  it('rejects malformed per-Story rows', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 563);
    await assert.rejects(
      runEpicExecuteRecordWave({
        epicId: 563,
        wave: 0,
        results: [{ storyId: 1, status: 'gibberish' }],
        injectedProvider: provider,
        injectedConfig: TEST_CONFIG,
      }),
      /must be one of/,
    );
  });
});

describe('runEpicExecuteRecordWave — curated webhook emits', () => {
  // The /epic-deliver host-LLM loop drives wave-boundary webhook events
  // through this CLI (it does not pass through `runEpic`). Each emit goes
  // through the injected notify; tests capture the event sequence to
  // pin the kickoff / complete / blocked / unblocked / finalize routing.
  function captureNotify() {
    const events = [];
    const fn = async (ticketId, payload) => {
      events.push({
        ticketId,
        event: payload.event,
        severity: payload.severity,
      });
    };
    return { events, fn };
  }

  it('fires epic-started + epic-progress on the first record (wave 0 kickoff)', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 600);
    const { events, fn } = captureNotify();
    await runEpicExecuteRecordWave({
      epicId: 600,
      wave: 0,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
      injectedNotify: fn,
    });
    assert.deepEqual(
      events.map((e) => e.event),
      ['epic-started', 'epic-progress'],
    );
    assert.equal(events[0].ticketId, 600);
    assert.equal(events[1].severity, 'medium');
  });

  it('fires epic-blocked + epic-progress(openBlockers) on a blocked wave', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 601);
    const { events, fn } = captureNotify();
    await runEpicExecuteRecordWave({
      epicId: 601,
      wave: 0,
      results: [
        { storyId: 1, status: 'done' },
        { storyId: 9, status: 'blocked' },
      ],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
      injectedNotify: fn,
    });
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes('epic-started'));
    assert.ok(eventNames.includes('epic-blocked'));
    const blockedFire = events.find((e) => e.event === 'epic-blocked');
    assert.equal(blockedFire.severity, 'high');
  });

  it('fires epic-unblocked when a previously-blocked wave is re-recorded as complete', async () => {
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 602);
    // First call: wave 0 lands blocked.
    await runEpicExecuteRecordWave({
      epicId: 602,
      wave: 0,
      results: [{ storyId: 9, status: 'blocked' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
      injectedNotify: async () => {},
    });
    // Second call (operator unblocked, host re-dispatched): wave 0 lands complete.
    const { events, fn } = captureNotify();
    await runEpicExecuteRecordWave({
      epicId: 602,
      wave: 0,
      results: [{ storyId: 9, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
      injectedNotify: fn,
    });
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes('epic-unblocked'));
    assert.equal(
      eventNames.indexOf('epic-unblocked') <
        eventNames.indexOf('epic-progress'),
      true,
      'epic-unblocked must precede the follow-up epic-progress',
    );
  });

  it('does NOT fire epic-complete at the finalize boundary (moved to PR-create)', async () => {
    // The `epic-complete` webhook used to fire here, before `gh pr create`
    // had a chance to run — operators got an "Epic complete" ping with no
    // PR to click. The fire moved to `epic-deliver-finalize.js`, post-PR.
    // Recording the final wave should now emit `epic-progress` (and
    // potentially `epic-unblocked` on resume) but NOT `epic-complete`.
    const provider = createFakeProvider();
    await seedCheckpoint(provider, 603, { totalWaves: 1 });
    const { events, fn } = captureNotify();
    await runEpicExecuteRecordWave({
      epicId: 603,
      wave: 0,
      results: [{ storyId: 1, status: 'done' }],
      injectedProvider: provider,
      injectedConfig: TEST_CONFIG,
      injectedNotify: fn,
    });
    const eventNames = events.map((e) => e.event);
    assert.ok(
      !eventNames.includes('epic-complete'),
      `epic-complete must not fire here; got events: ${eventNames.join(',')}`,
    );
    // Sanity: the `epic-progress` fire still happens — only `epic-complete`
    // moved.
    assert.ok(
      eventNames.includes('epic-progress'),
      'epic-progress must still fire on the finalize boundary',
    );
  });
});
