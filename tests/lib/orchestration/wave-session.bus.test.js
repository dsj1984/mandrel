// tests/lib/orchestration/wave-session.bus.test.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { WaveSession } from '../../../.agents/scripts/lib/orchestration/wave-session.js';

/**
 * End-to-end bus + ledger integration for wave-session. Asserts the
 * Task #2234 acceptance row by row:
 *
 *   - Recorded ledger from a 4-story concurrent run shows
 *     `story.dispatch.start` entries in submission order.
 *   - No two `story.dispatch.end` records share the same seqId; bus
 *     emits remain serial even when children settle concurrently.
 *
 * Reading the NDJSON ledger (rather than just attaching a bus listener)
 * proves the serial-emit guarantee survives the privileged emitted /
 * completed hooks the LedgerWriter installs — i.e. the wire shape AC-13
 * actually inspects is byte-identical to what an operator would tail.
 */

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('wave-session ↔ bus ↔ ledger integration', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-wave-session-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records start events in submission order on the NDJSON ledger', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 1 });
    const stories = [{ id: 201 }, { id: 202 }, { id: 203 }, { id: 204 }];
    // Deliberate settle skew — story 203 settles first, then 201, then
    // 204, then 202. Submission order is 201,202,203,204.
    const delays = { 201: 20, 202: 40, 203: 5, 204: 30 };
    await session.run({
      stories,
      cap: 4,
      dispatchFn: async (story) => {
        await new Promise((r) => setTimeout(r, delays[story.id]));
        return { status: 'done' };
      },
    });
    const records = readNdjson(writer.ledgerPath);
    const startEmits = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.start',
    );
    assert.deepEqual(
      startEmits.map((r) => r.payload.storyId),
      [201, 202, 203, 204],
      'start emits on the ledger must be in submission order',
    );
    // Every start carries the wave index from construction.
    for (const rec of startEmits) {
      assert.equal(rec.payload.waveIndex, 1);
    }
  });

  it('no two story.dispatch.end records on the ledger share the same seqId', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    // Same-tick settle cluster to maximise race surface.
    await session.run({
      stories,
      cap: 4,
      dispatchFn: async () => {
        await new Promise((r) => setTimeout(r, 2));
        return { outcome: 'done' };
      },
    });
    const records = readNdjson(writer.ledgerPath);
    const endEmits = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.end',
    );
    assert.equal(endEmits.length, 4);
    const seqIds = endEmits.map((r) => r.seqId);
    const unique = new Set(seqIds);
    assert.equal(
      unique.size,
      seqIds.length,
      `end seqIds must be unique; saw ${seqIds.join(', ')}`,
    );
  });

  it('emitted + completed records alternate per dispatch event — bus stays strictly serial', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await session.run({
      stories,
      cap: 3,
      dispatchFn: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { status: 'done' };
      },
    });
    const records = readNdjson(writer.ledgerPath);
    // Each event lands as a pair: emitted(seqId=N) immediately followed
    // by completed(seqId=N). If two emits could interleave on the bus,
    // an `emitted` record for seqId M would appear between the emitted/
    // completed pair for seqId N. Walk the file and assert otherwise.
    let i = 0;
    while (i < records.length) {
      assert.equal(records[i].kind, 'emitted', `record ${i} should be emitted`);
      assert.equal(
        records[i + 1].kind,
        'completed',
        `record ${i + 1} should be completed (paired with ${i})`,
      );
      assert.equal(records[i].seqId, records[i + 1].seqId);
      assert.equal(records[i].event, records[i + 1].event);
      i += 2;
    }
  });

  it('end record carries durationMs ≥ 0 and matches the schema enum', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    await session.run({
      stories: [{ id: 7 }],
      cap: 1,
      dispatchFn: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { status: 'blocked', reason: 'dependency-missing' };
      },
    });
    const records = readNdjson(writer.ledgerPath);
    const endRec = records.find(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.end',
    );
    assert.ok(endRec);
    assert.equal(endRec.payload.storyId, 7);
    assert.equal(endRec.payload.outcome, 'blocked');
    assert.ok(
      Number.isInteger(endRec.payload.durationMs) &&
        endRec.payload.durationMs >= 0,
      'durationMs must be a non-negative integer',
    );
  });
});
