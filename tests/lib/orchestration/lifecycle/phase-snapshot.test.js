// tests/lib/orchestration/lifecycle/phase-snapshot.test.js
/**
 * Contract test for `runSnapshotPhase` emitting `epic.snapshot.start` and
 * `epic.snapshot.end` through the lifecycle bus (Story #2233 Task #2238).
 *
 * Invariants pinned here:
 *   1. A real snapshot run appends `epic.snapshot.start` then
 *      `epic.snapshot.end` to the NDJSON ledger with matching `seqId`
 *      monotonicity (start.seqId < end.seqId).
 *   2. The snapshot.end payload validates against
 *      `.agents/schemas/lifecycle/epic.snapshot.end.schema.json` — i.e.
 *      it carries the enumerated `storyIds` of the Epic's child Stories
 *      and nothing else.
 *   3. Phases skip emits silently when no `bus` is on collaborators
 *      (preserves backward compatibility for unit fixtures that pass
 *      `{}` as collaborators).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runSnapshotPhase } from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/snapshot.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function buildProvider({ epic, descendants = [] }) {
  return {
    async getTicket(id) {
      if (id !== epic.id) throw new Error(`unexpected ticket id ${id}`);
      return { ...epic, labels: [...(epic.labels ?? [])] };
    },
    async getSubTickets(id) {
      if (id !== epic.id) throw new Error(`unexpected sub-tickets id ${id}`);
      return descendants.map((d) => ({
        ...d,
        labels: [...(d.labels ?? [])],
      }));
    },
  };
}

describe('lifecycle/phase-snapshot', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-snapshot-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits epic.snapshot.start then epic.snapshot.end with matching seqId order', async () => {
    const epicId = 4242;
    const provider = buildProvider({
      epic: {
        id: epicId,
        labels: ['type::epic', 'acceptance::n-a'],
        body: '',
      },
      descendants: [
        { id: 9001, labels: ['type::story'] },
        { id: 9002, labels: ['type::story'] },
        { id: 9003, labels: ['type::task'] }, // filtered out
      ],
    });

    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    const result = await runSnapshotPhase({ epicId, provider }, { bus }, {});

    assert.equal(result.epic.id, epicId);
    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    assert.equal(emitted.length, 2, 'two emitted records expected');
    assert.equal(emitted[0].event, 'epic.snapshot.start');
    assert.equal(emitted[1].event, 'epic.snapshot.end');
    assert.ok(
      emitted[0].seqId < emitted[1].seqId,
      'start.seqId must precede end.seqId',
    );
    // No `failed` records on a clean run.
    assert.equal(
      records.filter((r) => r.kind === 'failed').length,
      0,
      'no failed records on clean run',
    );
  });

  it('emits epic.snapshot.end carrying the enumerated storyIds (filters Tasks, deduplicates, sorts)', async () => {
    const epicId = 4243;
    const provider = buildProvider({
      epic: {
        id: epicId,
        labels: ['type::epic', 'acceptance::n-a'],
        body: '',
      },
      descendants: [
        { id: 8003, labels: ['type::story'] },
        { id: 8001, labels: ['type::story'] },
        { id: 8002, labels: ['type::story'] },
        { id: 8001, labels: ['type::story'] }, // dup
        { id: 8100, labels: ['type::task'] },
      ],
    });

    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    await runSnapshotPhase({ epicId, provider }, { bus }, {});

    const records = readNdjson(writer.ledgerPath);
    const endRecord = records.find(
      (r) => r.kind === 'emitted' && r.event === 'epic.snapshot.end',
    );
    assert.ok(endRecord, 'snapshot.end emitted record present');
    assert.deepEqual(endRecord.payload, {
      epicId,
      storyIds: [8001, 8002, 8003],
    });
  });

  it('skips emits silently when collaborators bag carries no bus (backward compat)', async () => {
    const epicId = 4244;
    const provider = buildProvider({
      epic: {
        id: epicId,
        labels: ['type::epic', 'acceptance::n-a'],
        body: '',
      },
      descendants: [],
    });
    // No `bus` on collaborators — the phase should still complete and
    // return the epic. No throw, no provider.getSubTickets call.
    let subTicketsCalled = false;
    provider.getSubTickets = async () => {
      subTicketsCalled = true;
      return [];
    };
    const result = await runSnapshotPhase({ epicId, provider }, {}, {});
    assert.equal(result.epic.id, epicId);
    assert.equal(
      subTicketsCalled,
      false,
      'getSubTickets must not run when bus is absent (no enumeration needed)',
    );
  });

  it('schema validation rejects an end payload missing storyIds (canary against schema drift)', async () => {
    const bus = new Bus();
    await assert.rejects(
      () => bus.emit('epic.snapshot.end', { epicId: 1 }),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        assert.equal(err.event, 'epic.snapshot.end');
        return true;
      },
    );
  });
});
