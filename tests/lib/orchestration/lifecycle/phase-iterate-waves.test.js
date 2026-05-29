// tests/lib/orchestration/lifecycle/phase-iterate-waves.test.js
/**
 * Contract test for the iterate-waves phase emitting `wave.start` and
 * `wave.end` through the lifecycle bus (Story #2239 Task #2243).
 *
 * Invariants pinned here:
 *   1. A real wave run appends `wave.start` then `wave.end` to the
 *      NDJSON ledger with matching `seqId` monotonicity
 *      (start.seqId < end.seqId).
 *   2. `wave.end.outcomes` keys equal `wave.start.storyIds`
 *      (Acceptance Spec AC-8 — wave completeness).
 *   3. Empty wave still emits the wave.start+wave.end pair so the
 *      ledger pointer advances; outcomes is `{}` and storyIds is `[]`.
 *   4. Pre-emit invariant guard throws on a synthesized mismatch
 *      (the bus never sees a non-conformant payload).
 *   5. `assertWaveCompleteness` rejects both missing and extra keys.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runIterateWavesPhase } from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/iterate-waves.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { assertWaveCompleteness } from '../../../../.agents/scripts/lib/wave-runner/wave-checkpoint.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Build a minimal collaborator bag good enough for the wave loop.
 * Every collaborator returns/no-ops the bare minimum.
 */
function buildCollaborators({ bus, launcher, journalNoop = true } = {}) {
  return {
    notify: () => {},
    epicRunStateStore: {
      async initialize() {},
      async read() {
        return null;
      },
      async write() {},
    },
    blockerHandler: {
      async halt() {
        return { resumed: false };
      },
    },
    launcher,
    waveObserver: {
      async waveStart() {
        return { startedAt: '2025-01-01T00:00:00Z' };
      },
      async waveEnd({ stories }) {
        // Pass-through — no commit-assertion reclassification in tests.
        return { stories };
      },
    },
    progressReporter: {
      setPlan() {},
      setWave() {},
      start() {},
      async stop() {},
    },
    syncColumn: async () => {},
    journal: journalNoop ? { async record() {} } : null,
    bus,
  };
}

/**
 * Build a wave scheduler that yields one wave with the given story IDs.
 */
function buildSingleWaveState(storyIds, epic = { id: 1, title: 't' }) {
  const stories = storyIds.map((id) => ({ id }));
  let consumed = false;
  const scheduler = {
    totalWaves: 1,
    currentWave: 0,
    hasMoreWaves() {
      return !consumed;
    },
    nextWave() {
      consumed = true;
      this.currentWave = 1;
      return { index: 0, stories };
    },
    markWaveComplete() {},
  };
  return {
    scheduler,
    waves: [stories],
    epic,
  };
}

/**
 * Provider stub: returns labels per ticket id. By default no labels
 * (so no story is skipped as already-done).
 */
function buildProvider(labelsById = {}) {
  return {
    async getTicket(id) {
      return { id, labels: labelsById[id] ?? [] };
    },
  };
}

const ctxFixture = ({ provider, epicId = 7777 }) => ({
  epicId,
  provider,
  config: {
    orchestration: { runners: { deliverRunner: { concurrencyCap: 2 } } },
  },
  logger: { info() {}, warn() {}, debug() {} },
});

describe('lifecycle/phase-iterate-waves', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-iterwaves-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits wave.start then wave.end with matching seqId order and complete outcomes', async () => {
    const epicId = 8801;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    const launcher = {
      async launchWave(stories) {
        return stories.map((s) => ({ storyId: s.id, status: 'done' }));
      },
    };
    const state = buildSingleWaveState([101, 102, 103]);
    const provider = buildProvider();

    const result = await runIterateWavesPhase(
      ctxFixture({ provider, epicId }),
      buildCollaborators({ bus, launcher }),
      state,
    );

    assert.equal(result.completionState, 'completed');
    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    const startRec = emitted.find((r) => r.event === 'wave.start');
    const endRec = emitted.find((r) => r.event === 'wave.end');
    assert.ok(startRec, 'wave.start emitted');
    assert.ok(endRec, 'wave.end emitted');
    assert.ok(
      startRec.seqId < endRec.seqId,
      'wave.start.seqId precedes wave.end.seqId',
    );
    assert.deepEqual(startRec.payload.storyIds, [101, 102, 103]);
    assert.deepEqual(endRec.payload.outcomes, {
      101: 'done',
      102: 'done',
      103: 'done',
    });
    // No failed records.
    assert.equal(
      records.filter((r) => r.kind === 'failed').length,
      0,
      'no failed records on clean run',
    );
  });

  it('emits start+end pair for an empty wave and advances ledger pointer once', async () => {
    const epicId = 8802;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    const launcher = {
      async launchWave() {
        return [];
      },
    };
    const state = buildSingleWaveState([]);
    const provider = buildProvider();

    const result = await runIterateWavesPhase(
      ctxFixture({ provider, epicId }),
      buildCollaborators({ bus, launcher }),
      state,
    );

    assert.equal(result.completionState, 'completed');
    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    const waveEvents = emitted.filter(
      (r) => r.event === 'wave.start' || r.event === 'wave.end',
    );
    assert.equal(
      waveEvents.length,
      2,
      'empty wave still emits exactly one wave.start + one wave.end',
    );
    const endRec = waveEvents.find((r) => r.event === 'wave.end');
    assert.deepEqual(endRec.payload.outcomes, {});
    assert.deepEqual(
      waveEvents.find((r) => r.event === 'wave.start').payload.storyIds,
      [],
    );
  });

  it('skips emits silently when no bus is on collaborators (backward compat)', async () => {
    const launcher = {
      async launchWave(stories) {
        return stories.map((s) => ({ storyId: s.id, status: 'done' }));
      },
    };
    const state = buildSingleWaveState([201]);
    const provider = buildProvider();

    // No bus, no throw — the wave loop should complete with the
    // legacy launcher path only.
    const result = await runIterateWavesPhase(
      ctxFixture({ provider, epicId: 8803 }),
      buildCollaborators({ bus: null, launcher }),
      state,
    );
    assert.equal(result.completionState, 'completed');
  });
});

describe('assertWaveCompleteness', () => {
  it('passes when outcomes keys exactly match storyIds', () => {
    assertWaveCompleteness({
      waveIndex: 0,
      storyIds: [1, 2, 3],
      outcomes: { 1: 'done', 2: 'failed', 3: 'skipped' },
    });
  });

  it('throws WAVE_COMPLETENESS_VIOLATION when outcomes is missing a storyId', () => {
    assert.throws(
      () =>
        assertWaveCompleteness({
          waveIndex: 2,
          storyIds: [10, 11, 12],
          outcomes: { 10: 'done', 11: 'done' },
        }),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.equal(err.waveIndex, 2);
        assert.deepEqual(err.missing, [12]);
        assert.deepEqual(err.extra, []);
        return true;
      },
    );
  });

  it('throws when outcomes carries an extra storyId not in wave.start', () => {
    assert.throws(
      () =>
        assertWaveCompleteness({
          waveIndex: 0,
          storyIds: [1, 2],
          outcomes: { 1: 'done', 2: 'done', 3: 'done' },
        }),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.deepEqual(err.missing, []);
        assert.deepEqual(err.extra, [3]);
        return true;
      },
    );
  });

  it('passes on the empty-wave case ({} outcomes vs [] storyIds)', () => {
    assertWaveCompleteness({ waveIndex: 0, storyIds: [], outcomes: {} });
  });
});
