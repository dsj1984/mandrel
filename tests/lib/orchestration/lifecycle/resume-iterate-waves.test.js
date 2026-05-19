// tests/lib/orchestration/lifecycle/resume-iterate-waves.test.js
/**
 * Crash/resume tests for the iterate-waves phase lifecycle emits
 * (Story #2239 Task #2245; pins Acceptance Spec AC-3 / Repeatability
 * AC #4 — resume determinism).
 *
 * Pattern mirrors `resume-snapshot-plan.test.js`:
 *
 *   1. Run the phase under a bus that crashes mid-flight, after
 *      `wave.start` lands in the ledger but BEFORE `wave.end` does.
 *      Throwing inside a `wave.start` listener simulates the kernel
 *      kill window cleanly — the `emitted` line for `wave.start` has
 *      already been persisted by LedgerWriter's onEmitted hook before
 *      the throw, but the `completed` boundary never fires.
 *   2. Capture the partial ledger contents (proves the durable-on-disk
 *      invariant).
 *   3. Resume: fresh bus + writer pointed at the SAME ledger path,
 *      re-run the phase. AppendFileSync semantics put new records
 *      after the partial preamble.
 *   4. Compare the resumed suffix to an uninterrupted reference run
 *      (modulo `ts` and `seqId` per the resume contract) — they must
 *      be structurally identical. The lifecycle-diff guarantee from
 *      AC-4 holds: interrupted vs uninterrupted runs diverge only on
 *      the documented modulo fields.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runIterateWavesPhase } from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/iterate-waves.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Strip the run-scoped + wall-clock fields that intentionally vary
 * between runs:
 *   - `ts`         — wall-clock ISO timestamp.
 *   - `seqId`      — per-Bus monotonic counter, restarts each run.
 *   - `durationMs` inside `story.dispatch.end` payloads — wave-session
 *     measures wall-clock between submit and settle; two runs of the
 *     same fixture observe different setTimeout / promise resolution
 *     latencies and emit different ms counts. Stripping it lets us
 *     assert the rest of the payload is identical.
 *   - `startedAt`, `completedAt`, `durationMs` inside `wave.start` /
 *     `wave.end` payloads — Epic #2646 Story C added these to the
 *     payloads so the bus-driven `structured-comment-poster` can render
 *     the rich body the retired `wave-observer.js` used to own. Like
 *     `story.dispatch.end.durationMs` they are wall-clock and diverge
 *     across runs.
 */
function structuralRecord(record) {
  const { ts: _ts, seqId: _seqId, ...rest } = record;
  if (
    rest.event === 'story.dispatch.end' &&
    rest.payload &&
    typeof rest.payload === 'object'
  ) {
    const { durationMs: _durationMs, ...restPayload } = rest.payload;
    return { ...rest, payload: restPayload };
  }
  if (
    (rest.event === 'wave.start' || rest.event === 'wave.end') &&
    rest.payload &&
    typeof rest.payload === 'object'
  ) {
    const {
      startedAt: _startedAt,
      completedAt: _completedAt,
      durationMs: _waveDurationMs,
      ...restPayload
    } = rest.payload;
    return { ...rest, payload: restPayload };
  }
  return rest;
}

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
    commitAssertion: null,
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
  return { scheduler, waves: [stories], epic };
}

function buildProvider() {
  return {
    async getTicket(id) {
      return { id, labels: [] };
    },
  };
}

function ctxFixture({ provider, epicId }) {
  return {
    epicId,
    provider,
    config: {
      orchestration: { runners: { deliverRunner: { concurrencyCap: 2 } } },
    },
    logger: { info() {}, warn() {}, debug() {} },
  };
}

describe('lifecycle/resume-iterate-waves', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-resume-waves-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('partial ledger after a kill BEFORE wave.end is durable on disk', async () => {
    const epicId = 7001;
    const provider = buildProvider();
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    // Crash window: throw inside a wave.start listener. LedgerWriter
    // has already persisted the `emitted` line for wave.start by the
    // time this fires (onEmitted hook runs first), so we land in the
    // "start emitted, end never emitted" state the resume contract
    // depends on.
    bus.on('wave.start', () => {
      throw new Error('simulated-kill-after-wave-start');
    });

    const launcher = {
      async launchWave(stories) {
        return stories.map((s) => ({ storyId: s.id, status: 'done' }));
      },
    };
    const state = buildSingleWaveState([1, 2]);

    await assert.rejects(
      () =>
        runIterateWavesPhase(
          ctxFixture({ provider, epicId }),
          buildCollaborators({ bus, launcher }),
          state,
        ),
      { message: 'simulated-kill-after-wave-start' },
    );

    const partial = readNdjson(writer.ledgerPath);
    const startEmits = partial.filter(
      (r) => r.event === 'wave.start' && r.kind === 'emitted',
    );
    assert.equal(startEmits.length, 1, 'one emitted wave.start');
    const endEmits = partial.filter(
      (r) => r.event === 'wave.end' && r.kind === 'emitted',
    );
    assert.equal(endEmits.length, 0, 'no emitted wave.end (killed)');
    const startFails = partial.filter(
      (r) => r.event === 'wave.start' && r.kind === 'failed',
    );
    assert.equal(startFails.length, 1, 'one failed wave.start');
  });

  it('resume yields a ledger suffix structurally identical (modulo ts/seqId) to an uninterrupted run', async () => {
    const epicId = 7002;
    const provider = buildProvider();
    const launcher = {
      async launchWave(stories) {
        return stories.map((s) => ({ storyId: s.id, status: 'done' }));
      },
    };

    // Reference: uninterrupted run.
    const refBus = new Bus();
    const refWriter = new LedgerWriter({ epicId, tempRoot });
    refWriter.register(refBus);
    await runIterateWavesPhase(
      ctxFixture({ provider, epicId }),
      buildCollaborators({ bus: refBus, launcher }),
      buildSingleWaveState([10, 11]),
    );
    const reference = readNdjson(refWriter.ledgerPath).map(structuralRecord);
    // Clear the directory so the crashed run starts on a fresh ledger.
    rmSync(path.join(tempRoot, `epic-${epicId}`), {
      recursive: true,
      force: true,
    });

    // Crashed run.
    const crashBus = new Bus();
    const crashWriter = new LedgerWriter({ epicId, tempRoot });
    crashWriter.register(crashBus);
    crashBus.on('wave.start', () => {
      throw new Error('simulated-kill-after-wave-start');
    });
    await assert.rejects(() =>
      runIterateWavesPhase(
        ctxFixture({ provider, epicId }),
        buildCollaborators({ bus: crashBus, launcher }),
        buildSingleWaveState([10, 11]),
      ),
    );

    // Resume: fresh bus + writer at the SAME ledger path.
    const resumeBus = new Bus();
    const resumeWriter = new LedgerWriter({ epicId, tempRoot });
    resumeWriter.register(resumeBus);
    await runIterateWavesPhase(
      ctxFixture({ provider, epicId }),
      buildCollaborators({ bus: resumeBus, launcher }),
      buildSingleWaveState([10, 11]),
    );

    // The crashed run left 2 preamble records (emitted + failed for
    // wave.start). Drop them and compare the suffix.
    const all = readNdjson(resumeWriter.ledgerPath);
    const suffix = all.slice(2).map(structuralRecord);
    assert.deepEqual(suffix, reference);
  });
});
