// tests/lib/orchestration/wave-session.edge.test.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { WaveSession } from '../../../.agents/scripts/lib/orchestration/wave-session.js';

/**
 * Wave-session edge cases at the primitive level. Covers the wave-
 * completeness invariant (AC-8) and the no-silent-skip contract (AC-9)
 * from the consuming caller's point of view:
 *
 *   - empty wave           — no dispatch events; caller's wave.start /
 *                            wave.end pair still lands.
 *   - single-story wave    — exactly one dispatch.start + dispatch.end
 *                            pair lands on the ledger.
 *   - malformed return     — surfaces as a typed `failed` outcome with
 *                            the originating error captured on `returns`.
 *   - child throw          — same surface as malformed return; wave does
 *                            not abort.
 *   - timeout-style return — legacy `status: 'timeout'` is rejected as
 *                            malformed; the wave surfaces a `failed`
 *                            outcome via the catch path.
 *
 * These tests deliberately exercise the wave-session ↔ bus boundary via
 * the LedgerWriter so the wire-shape assertion is the same one a human
 * reviewer would tail on `temp/epic-<id>/lifecycle.ndjson`.
 */

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('wave-session edge cases', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-wave-edge-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('empty wave: no dispatch events emitted, caller still owns wave.start/wave.end pair', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    bus.on('wave.start', () => {});
    bus.on('wave.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });

    // Caller emits wave.start before run().
    await bus.emit('wave.start', { waveIndex: 0, storyIds: [] });
    const result = await session.run({
      stories: [],
      dispatchFn: () => {
        throw new Error('should-never-be-called');
      },
      cap: 4,
    });
    await bus.emit('wave.end', { waveIndex: 0, outcomes: {} });

    assert.deepEqual(result.outcomes, {});
    assert.deepEqual(result.returns, {});
    assert.equal(result.waveIndex, 0);
    const records = readNdjson(writer.ledgerPath);
    const dispatchEmits = records.filter(
      (r) =>
        r.kind === 'emitted' &&
        (r.event === 'story.dispatch.start' ||
          r.event === 'story.dispatch.end'),
    );
    assert.equal(
      dispatchEmits.length,
      0,
      'empty wave must not emit any dispatch events',
    );
    // Caller's wave.start / wave.end pair landed.
    const waveStarts = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'wave.start',
    );
    const waveEnds = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'wave.end',
    );
    assert.equal(waveStarts.length, 1);
    assert.equal(waveEnds.length, 1);
  });

  it('single-story wave: exactly one dispatch.start + dispatch.end pair, outcome propagates', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const result = await session.run({
      stories: [{ id: 42 }],
      dispatchFn: async () => ({ status: 'done', sha: 'abc1234' }),
      cap: 1,
    });
    assert.deepEqual(result.outcomes, { 42: 'done' });
    assert.equal(result.returns[42].sha, 'abc1234');
    const records = readNdjson(writer.ledgerPath);
    const starts = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.start',
    );
    const ends = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.end',
    );
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].payload.storyId, 42);
    assert.equal(ends[0].payload.storyId, 42);
    assert.equal(ends[0].payload.outcome, 'done');
  });

  it('single-story wave with cap > stories.length: only one dispatch occurs', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    let calls = 0;
    const result = await session.run({
      stories: [{ id: 1 }],
      dispatchFn: async () => {
        calls += 1;
        return { status: 'done' };
      },
      cap: 8,
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.outcomes, { 1: 'done' });
  });

  it('malformed return (unknown outcome string) → typed failure, not silent skip', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const result = await session.run({
      stories: [{ id: 99 }],
      dispatchFn: async () => ({ status: 'partially-done' }),
      cap: 1,
    });
    assert.equal(result.outcomes[99], 'failed');
    assert.equal(result.returns[99].error.code, 'WAVE_MALFORMED_RETURN');
    // The schema-valid `failed` enum lands on the ledger — never the
    // raw 'partially-done' string.
    const records = readNdjson(writer.ledgerPath);
    const endRec = records.find(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.end',
    );
    assert.equal(endRec.payload.outcome, 'failed');
  });

  it('malformed return (missing both status and outcome) → typed failure', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const result = await session.run({
      stories: [{ id: 1 }],
      dispatchFn: async () => ({ unrelated: 'field' }),
      cap: 1,
    });
    assert.equal(result.outcomes[1], 'failed');
    assert.equal(result.returns[1].error.code, 'WAVE_MALFORMED_RETURN');
  });

  it('malformed return (null) → typed failure', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const result = await session.run({
      stories: [{ id: 1 }],
      dispatchFn: async () => null,
      cap: 1,
    });
    assert.equal(result.outcomes[1], 'failed');
    assert.equal(result.returns[1].error.code, 'WAVE_MALFORMED_RETURN');
  });

  it('child throw is recorded as failed outcome and does not abort sibling dispatches', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const dispatchFn = async (story) => {
      if (story.id === 2) {
        const err = new Error('child-blew-up');
        err.code = 'CHILD_BOOM';
        throw err;
      }
      return { outcome: 'done' };
    };
    const result = await session.run({ stories, dispatchFn, cap: 3 });
    assert.equal(result.outcomes[1], 'done');
    assert.equal(result.outcomes[2], 'failed');
    assert.equal(result.outcomes[3], 'done');
    assert.equal(result.returns[2].error.message, 'child-blew-up');
    assert.equal(result.returns[2].error.code, 'CHILD_BOOM');
  });

  it('legacy timeout-style return (`status: "timeout"`) is rejected as malformed and surfaces as `failed`', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const result = await session.run({
      stories: [{ id: 5 }],
      dispatchFn: async () => ({ status: 'timeout', reason: 'spawn-timeout' }),
      cap: 1,
    });
    // Story #2687 hard cutover: `status: 'timeout'` is no longer coerced;
    // parseChildReturn throws WAVE_MALFORMED_RETURN and the WaveSession
    // catch path surfaces a `failed` outcome with the original error
    // attached on `returns[id]` (the malformed payload is dropped).
    assert.equal(result.outcomes[5], 'failed');
    assert.equal(result.returns[5].outcome, 'failed');
    assert.equal(result.returns[5].error.code, 'WAVE_MALFORMED_RETURN');
    const records = readNdjson(writer.ledgerPath);
    const endRec = records.find(
      (r) => r.kind === 'emitted' && r.event === 'story.dispatch.end',
    );
    assert.equal(endRec.payload.outcome, 'failed');
  });

  it('wave outcomes cover exactly the input story IDs (AC-8 wave-completeness invariant)', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    const stories = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const dispatchFn = async (story) => {
      if (story.id === 2) throw new Error('boom');
      if (story.id === 3) return null;
      return { status: 'done' };
    };
    const result = await session.run({ stories, dispatchFn, cap: 4 });
    const outcomeIds = Object.keys(result.outcomes).map(Number).sort();
    const inputIds = stories.map((s) => s.id).sort();
    assert.deepEqual(outcomeIds, inputIds);
    // Every entry is a schema-valid enum value.
    for (const id of inputIds) {
      assert.ok(
        ['done', 'blocked', 'failed', 'skipped'].includes(result.outcomes[id]),
        `outcome for #${id} must be a schema-valid enum, got ${result.outcomes[id]}`,
      );
    }
  });

  it('empty wave with cap=1 returns immediately without touching dispatchFn', async () => {
    const bus = new Bus();
    bus.on('story.dispatch.start', () => {});
    bus.on('story.dispatch.end', () => {});
    const session = new WaveSession({ bus, waveIndex: 0 });
    let calls = 0;
    const result = await session.run({
      stories: [],
      dispatchFn: () => {
        calls += 1;
        return { outcome: 'done' };
      },
      cap: 1,
    });
    assert.equal(calls, 0);
    assert.deepEqual(result.outcomes, {});
  });
});
