// tests/lib/orchestration/lifecycle/wave-completeness.test.js
/**
 * Wave-completeness invariant tests (Story #2239 Task #2245; pins
 * Acceptance Spec AC-8 / Repeatability AC #5).
 *
 * The invariant: the key set of `wave.end.outcomes` MUST equal the
 * `wave.start.storyIds` set from the matching `wave.start` event.
 *
 * Layering: the JSON Schema at
 * `.agents/schemas/lifecycle/wave.end.schema.json` declares the shape
 * of `outcomes` (keys are storyId strings, values are the four
 * outcome enum strings) but cannot express cross-event constraints.
 * The phase-level `assertWaveCompleteness` guard fills that gap: an
 * iterate-waves run that would emit a mismatched `wave.end` throws
 * BEFORE the bus.emit call, so the bus and the ledger never see a
 * non-conformant payload. The guard is functionally equivalent to a
 * schema rejection from the operator's perspective.
 *
 * These tests cover:
 *   (a) The schema declarations themselves — value-enum + key-type
 *       are enforced by AJV.
 *   (b) The cross-event guard — `assertWaveCompleteness` rejects
 *       missing and extra keys with a typed `Error`.
 *   (c) End-to-end through the phase — an outcome map seeded with an
 *       extra storyId trips the guard before the emit and the bus
 *       never sees the bad payload.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  assertWaveCompleteness,
  runIterateWavesPhase,
} from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/iterate-waves.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

function buildCollaborators({ bus, launcher }) {
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
    journal: { async record() {} },
    bus,
  };
}

function buildSingleWaveState(storyIds) {
  const stories = storyIds.map((id) => ({ id }));
  let consumed = false;
  return {
    epic: { id: 1, title: 't' },
    waves: [stories],
    scheduler: {
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
    },
  };
}

function buildProvider() {
  return {
    async getTicket(id) {
      return { id, labels: [] };
    },
  };
}

describe('wave-completeness — schema layer', () => {
  it('wave.end schema rejects an outcomes value outside the enum', async () => {
    const bus = new Bus();
    await assert.rejects(
      () =>
        bus.emit('wave.end', {
          waveIndex: 0,
          // 'bogus' is not in the outcome enum.
          outcomes: { 1: 'bogus' },
        }),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        assert.equal(err.event, 'wave.end');
        return true;
      },
    );
  });

  it('wave.end schema rejects an integer outcomes value (must be a string)', async () => {
    const bus = new Bus();
    await assert.rejects(
      () =>
        bus.emit('wave.end', {
          waveIndex: 0,
          outcomes: { 1: 42 },
        }),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        return true;
      },
    );
  });
});

describe('wave-completeness — cross-event invariant guard', () => {
  it('rejects an emit attempt where outcomes is missing a storyId from wave.start.storyIds', () => {
    assert.throws(
      () =>
        assertWaveCompleteness({
          waveIndex: 0,
          storyIds: [1, 2, 3],
          outcomes: { 1: 'done', 2: 'done' },
        }),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.deepEqual(err.missing, [3]);
        return true;
      },
    );
  });

  it('rejects an emit attempt where outcomes carries an extra storyId', () => {
    assert.throws(
      () =>
        assertWaveCompleteness({
          waveIndex: 0,
          storyIds: [1, 2],
          outcomes: { 1: 'done', 2: 'done', 99: 'done' },
        }),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.deepEqual(err.extra, [99]);
        return true;
      },
    );
  });

  it('passes when keys exactly cover storyIds', () => {
    // Should not throw.
    assertWaveCompleteness({
      waveIndex: 0,
      storyIds: [1, 2, 3],
      outcomes: { 1: 'done', 2: 'failed', 3: 'skipped' },
    });
  });
});

describe('wave-completeness — end-to-end through iterate-waves', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-wavecomp-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('phase blows up before emit when wave-end reconciliation drops a storyId', async () => {
    const epicId = 8001;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    // Pathological waveObserver: drops one of the stories from the
    // reconciled result set. Could happen if a future commit-assertion
    // filter introduces a bug; the invariant guard exists precisely to
    // catch that regression at the bus boundary.
    const waveObserverDrops = {
      async waveStart() {
        return { startedAt: '2025-01-01T00:00:00Z' };
      },
      async waveEnd({ stories }) {
        // Return only the first story — simulates a downstream
        // reconciler silently dropping the second one. wave-session
        // populated outcomes for both, so seeding outcomes from
        // waveStartStoryIds + results-only would create a complete
        // set, but the *results* loop in iterate-waves only walks
        // the returned stories. Combined with the wave.start having
        // both ids, the outcomes set ends up complete IFF the
        // wave-session returns populate it. We verify the guard at
        // the unit level above; here we prove the guard's
        // ledger-protection invariant: if reconciliation diverges,
        // the bus never sees wave.end.
        return { stories: stories.slice(0, 1) };
      },
    };

    const launcher = {
      async launchWave(stories) {
        // Return rows for ALL inputs so the wave-session itself sees
        // a complete map; the mismatch will come from the dropped
        // waveObserver story plus a synthetic adapter that records
        // outcomes from the results array only.
        return stories.map((s) => ({ storyId: s.id, status: 'done' }));
      },
    };

    // Stub the phase's outcomes-seeding by injecting a custom
    // collaborators bag that bypasses the wave-session populate path:
    // we set `bus` but a `launcher` whose adapter doesn't go through
    // wave-session — this hits the legacy launcher.launchWave path,
    // which produces results that the waveObserver then drops to
    // create the violation. Achieve this by NOT passing wave-session
    // facade — but the phase always uses wave-session when a bus is
    // present. So instead, the cleanest way to provoke a violation
    // through the phase is to make the waveObserver's results
    // diverge from launcher's results AND inject a custom
    // wave-session factory that yields incomplete outcomes.
    const collaborators = {
      ...buildCollaborators({ bus, launcher }),
      waveObserver: waveObserverDrops,
      // Inject a wave-session factory that yields outcomes from
      // *only the reconciled* results — driving the cross-event
      // mismatch deterministically.
      waveSessionFactory: ({ waveIndex }) => ({
        async run({ stories }) {
          // Mirror the original adapter shape but only populate
          // outcomes for the first story so the assert downstream
          // trips against the wave-start storyIds set.
          const first = stories[0];
          return {
            waveIndex,
            outcomes: { [first.id]: 'done' },
            returns: {
              [first.id]: { storyId: first.id, status: 'done' },
            },
          };
        },
      }),
    };

    const state = buildSingleWaveState([501, 502]);

    await assert.rejects(
      () =>
        runIterateWavesPhase(
          {
            epicId,
            provider: buildProvider(),
            config: {
              orchestration: {
                runners: { deliverRunner: { concurrencyCap: 2 } },
              },
            },
            logger: { info() {}, warn() {}, debug() {} },
          },
          collaborators,
          state,
        ),
      (err) => {
        assert.equal(err.code, 'WAVE_COMPLETENESS_VIOLATION');
        assert.equal(err.waveIndex, 0);
        return true;
      },
    );

    const { readFileSync } = await import('node:fs');
    const records = readFileSync(writer.ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => l.length)
      .map((l) => JSON.parse(l));
    const endEmits = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'wave.end',
    );
    assert.equal(
      endEmits.length,
      0,
      'wave.end MUST NOT be emitted when the invariant guard rejects it',
    );
  });
});
