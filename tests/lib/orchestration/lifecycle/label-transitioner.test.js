// tests/lib/orchestration/lifecycle/label-transitioner.test.js
/**
 * Regression guard for the missing Epic `agent::done` flip (2026-07-11
 * incident): Epics #4405 / #4425 / #4429 merged cleanly — Cleaner
 * archived, `epic.complete` landed on the ledger — yet the tickets
 * stranded at `agent::executing`, because no listener on the
 * `lifecycle-emit` chain owned the terminal label transition after the
 * original LabelTransitioner died with the in-process runner stratum
 * (Story #3908). These tests drive a REAL `Bus` emit of `epic.complete`
 * through the re-homed listener and assert the provider-level effect:
 * `agent::done` added, every other `agent::*` removed, issue closed as
 * completed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  LabelTransitioner,
  SUBSCRIBED_EVENT,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/label-transitioner.js';
import { STATE_LABELS } from '../../../../.agents/scripts/lib/orchestration/ticketing/reads.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Minimal provider capturing `updateTicket` mutations. `getTicket`
 * returns a snapshot carrying the pre-flip label so the transition's
 * `fromState` lookup and label-merge path both resolve without network.
 */
function createRecordingProvider() {
  const calls = [];
  return {
    calls,
    async getTicket(id) {
      return {
        id,
        number: id,
        labels: ['type::epic', STATE_LABELS.EXECUTING],
      };
    },
    async getSubTickets() {
      return [];
    },
    async updateTicket(id, mutations) {
      calls.push({ id, mutations });
      return { id };
    },
  };
}

describe('LabelTransitioner — epic.complete → agent::done', () => {
  it('flips the Epic to agent::done and closes it as completed on epic.complete', async () => {
    const bus = new Bus();
    const epicId = 4405;
    const provider = createRecordingProvider();
    const listener = new LabelTransitioner({
      bus,
      epicId,
      provider,
      logger: quietLogger(),
    });
    listener.register();

    await bus.emit(SUBSCRIBED_EVENT, {
      epicId,
      prUrl: 'https://github.com/o/r/pull/1',
    });

    const epicUpdates = provider.calls.filter((c) => c.id === epicId);
    assert.equal(epicUpdates.length, 1, 'exactly one updateTicket for Epic');
    const { mutations } = epicUpdates[0];
    assert.deepEqual(mutations.labels.add, [STATE_LABELS.DONE]);
    assert.ok(
      mutations.labels.remove.includes(STATE_LABELS.EXECUTING),
      'removes agent::executing',
    );
    assert.equal(mutations.state, 'closed');
    assert.equal(mutations.state_reason, 'completed');
  });

  it('is idempotent per (event, seqId): a bus-replay of the same seqId flips once', async () => {
    const bus = new Bus();
    const epicId = 4425;
    const provider = createRecordingProvider();
    const listener = new LabelTransitioner({
      bus,
      epicId,
      provider,
      logger: quietLogger(),
    });
    listener.register();

    // Drive handle() directly to replay an identical (event, seqId)
    // pair — the bus itself always mints fresh seqIds, so the replay
    // window (re-emitting an event whose `emitted` line landed but
    // whose `completed` did not) is simulated at the listener seam.
    await listener.handle({ event: SUBSCRIBED_EVENT, seqId: 7, payload: {} });
    await listener.handle({ event: SUBSCRIBED_EVENT, seqId: 7, payload: {} });

    assert.equal(
      provider.calls.filter((c) => c.id === epicId).length,
      1,
      'duplicate (event, seqId) does not re-flip',
    );

    // A NEW seqId (a genuine second emit) flips again — the provider
    // layer is idempotent, so a legitimate re-run stays safe.
    await listener.handle({ event: SUBSCRIBED_EVENT, seqId: 8, payload: {} });
    assert.equal(provider.calls.filter((c) => c.id === epicId).length, 2);
  });

  it('propagates a provider failure (loud ledger outcome, never a silent strand)', async () => {
    const bus = new Bus();
    const failingProvider = {
      async getTicket() {
        return { labels: [] };
      },
      async getSubTickets() {
        return [];
      },
      async updateTicket() {
        throw new Error('provider outage');
      },
    };
    const listener = new LabelTransitioner({
      bus,
      epicId: 4429,
      provider: failingProvider,
      logger: quietLogger(),
    });

    await assert.rejects(
      () => listener.handle({ event: SUBSCRIBED_EVENT, seqId: 1, payload: {} }),
      /provider outage/,
    );
  });

  it('constructor validates bus, epicId, and provider', () => {
    const bus = new Bus();
    const provider = createRecordingProvider();
    assert.throws(
      () => new LabelTransitioner({ epicId: 1, provider }),
      /requires a bus/,
    );
    assert.throws(
      () => new LabelTransitioner({ bus, provider }),
      /numeric epicId/,
    );
    assert.throws(
      () => new LabelTransitioner({ bus, epicId: 1 }),
      /requires a provider/,
    );
  });

  it('exposes the canonical frozen events array for the doc-drift extractor', () => {
    const listener = new LabelTransitioner({
      bus: new Bus(),
      epicId: 1,
      provider: createRecordingProvider(),
      logger: quietLogger(),
    });
    assert.deepEqual([...listener.events], ['epic.complete']);
    assert.ok(Object.isFrozen(listener.events));
  });
});
