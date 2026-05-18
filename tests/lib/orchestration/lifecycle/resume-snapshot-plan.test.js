// tests/lib/orchestration/lifecycle/resume-snapshot-plan.test.js
/**
 * Crash/resume tests for the snapshot + plan phase lifecycle emits
 * (Story #2233 Task #2240; pins Acceptance Spec AC-3, resume
 * determinism).
 *
 * Pattern (canonical — reused by later phase-conversion Stories):
 *   1. Run the phase under a bus that crashes mid-flight, after
 *      `epic.X.start` lands in the ledger but BEFORE `epic.X.end` does.
 *      We simulate the kill by installing an onEmitted hook that throws
 *      when it sees the end-event seqId — the LedgerWriter has already
 *      appended the start record at that point, mirroring a real
 *      process kill where the kernel flushed the start append but lost
 *      the end append.
 *   2. Capture the partial ledger contents.
 *   3. Resume by starting a fresh bus + writer pointed at the SAME
 *      ledger path and re-running the phase to completion.
 *   4. Assert the final ledger is byte-identical (modulo `ts` and
 *      `seqId`) to an uninterrupted run of the same phase against the
 *      same provider fixture.
 *
 * Determinism modulo: the wall-clock `ts` strings differ between runs
 * by design; the per-run `seqId` numbering restarts from 1 in each new
 * Bus instance (the run-scoped counter is intentional — it's how the
 * resume coordinator distinguishes pre-kill and post-kill suffixes).
 * Every other field must match exactly.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runBuildWaveDagPhase } from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { runSnapshotPhase } from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/snapshot.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

/** Read NDJSON ledger into an array of typed records. */
function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Strip `ts` and `seqId` from a ledger record so two runs (one crashed,
 * one uninterrupted) can be compared structurally. These are the two
 * fields the contract intentionally allows to drift between runs;
 * everything else must be byte-identical or the resume guarantee is
 * broken.
 */
function structuralRecord(record) {
  const { ts: _ts, seqId: _seqId, ...rest } = record;
  return rest;
}

/** Build a fixture provider for snapshot crashes. */
function buildSnapshotProvider({ epicId, storyIds }) {
  return {
    async getTicket(id) {
      assert.equal(id, epicId);
      return {
        id: epicId,
        labels: ['type::epic', 'acceptance::n-a'],
        body: '',
      };
    },
    async getSubTickets(id) {
      assert.equal(id, epicId);
      return storyIds.map((sid) => ({ id: sid, labels: ['type::story'] }));
    },
  };
}

/** Build a fixture provider for plan-phase crashes. */
function buildPlanProvider({ stories }) {
  return {
    async getSubTickets() {
      return stories.map((s) => ({ ...s, labels: [...(s.labels ?? [])] }));
    },
  };
}

describe('lifecycle/resume-snapshot-plan', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-resume-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('snapshot — partial ledger after a kill BEFORE epic.snapshot.end is durable on disk', async () => {
    const epicId = 6001;
    const provider = buildSnapshotProvider({ epicId, storyIds: [6010, 6011] });
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    // Install a SECOND onEmitted hook that throws as soon as it sees
    // `epic.snapshot.end`. Hooks run sequentially after the writer's
    // hook, so by the time we throw, the `emitted` line for
    // snapshot.end is already on disk. To get a *true* partial state
    // (start emitted, end NOT emitted), we throw inside an event
    // listener registered for `epic.snapshot.start` AFTER the bus has
    // persisted the start record — so the snapshot.end emit is never
    // attempted. That is the cleanest analogue to a process kill
    // between the two emits.
    bus.on('epic.snapshot.start', () => {
      throw new Error('simulated-kill-after-start');
    });

    await assert.rejects(
      () => runSnapshotPhase({ epicId, provider }, { bus }, {}),
      { message: 'simulated-kill-after-start' },
    );

    const partial = readNdjson(writer.ledgerPath);
    // We expect: emitted(start) + failed(start). NO emitted(end), NO
    // completed records for start (the throw routes through the
    // failed-boundary, not the completed-boundary).
    const startEmits = partial.filter(
      (r) => r.event === 'epic.snapshot.start' && r.kind === 'emitted',
    );
    assert.equal(startEmits.length, 1, 'one emitted record for start');
    const endEmits = partial.filter(
      (r) => r.event === 'epic.snapshot.end' && r.kind === 'emitted',
    );
    assert.equal(endEmits.length, 0, 'no emitted record for end (killed)');
    const startFails = partial.filter(
      (r) => r.event === 'epic.snapshot.start' && r.kind === 'failed',
    );
    assert.equal(startFails.length, 1, 'one failed record for start');
  });

  it('snapshot — resume produces a final ledger structurally-identical (modulo ts/seqId) to an uninterrupted run', async () => {
    const epicId = 6002;
    const provider = buildSnapshotProvider({ epicId, storyIds: [6020, 6021] });

    // Uninterrupted reference run.
    const refBus = new Bus();
    const refWriter = new LedgerWriter({ epicId, tempRoot });
    refWriter.register(refBus);
    await runSnapshotPhase({ epicId, provider }, { bus: refBus }, {});
    const referenceFinal = readNdjson(refWriter.ledgerPath).map(
      structuralRecord,
    );
    // Tear down reference ledger so the resume scenario writes into a
    // clean directory.
    rmSync(path.join(tempRoot, `epic-${epicId}`), {
      recursive: true,
      force: true,
    });

    // Crashed run.
    const crashBus = new Bus();
    const crashWriter = new LedgerWriter({ epicId, tempRoot });
    crashWriter.register(crashBus);
    crashBus.on('epic.snapshot.start', () => {
      throw new Error('simulated-kill-after-start');
    });
    await assert.rejects(() =>
      runSnapshotPhase({ epicId, provider }, { bus: crashBus }, {}),
    );

    // Resume: fresh bus + writer pointed at the SAME ledger path. The
    // appendFileSync semantics in LedgerWriter mean records land at the
    // tail of the existing file.
    const resumeBus = new Bus();
    const resumeWriter = new LedgerWriter({ epicId, tempRoot });
    resumeWriter.register(resumeBus);
    await runSnapshotPhase({ epicId, provider }, { bus: resumeBus }, {});

    // The resumed ledger has two extra preamble records from the
    // crash (the `emitted` + `failed` lines from the killed run).
    // Drop them; the suffix that the resumed bus produced must match
    // the uninterrupted reference run structurally.
    const resumedAll = readNdjson(resumeWriter.ledgerPath);
    const suffix = resumedAll.slice(2).map(structuralRecord);
    assert.deepEqual(suffix, referenceFinal);
  });

  it('plan — partial ledger after a kill BEFORE epic.plan.end is durable on disk', async () => {
    const epicId = 6003;
    const provider = buildPlanProvider({
      stories: [
        { id: 6030, labels: ['type::story'], body: '' },
        { id: 6031, labels: ['type::story'], body: '' },
      ],
    });
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    bus.on('epic.plan.start', () => {
      throw new Error('simulated-kill-after-plan-start');
    });

    await assert.rejects(
      () => runBuildWaveDagPhase({ epicId, provider }, { bus }, {}),
      { message: 'simulated-kill-after-plan-start' },
    );

    const partial = readNdjson(writer.ledgerPath);
    const startEmits = partial.filter(
      (r) => r.event === 'epic.plan.start' && r.kind === 'emitted',
    );
    assert.equal(startEmits.length, 1);
    const endEmits = partial.filter(
      (r) => r.event === 'epic.plan.end' && r.kind === 'emitted',
    );
    assert.equal(endEmits.length, 0);
    const startFails = partial.filter(
      (r) => r.event === 'epic.plan.start' && r.kind === 'failed',
    );
    assert.equal(startFails.length, 1);
  });

  it('plan — resume produces a final ledger structurally-identical (modulo ts/seqId) to an uninterrupted run', async () => {
    const epicId = 6004;
    const provider = buildPlanProvider({
      stories: [
        { id: 6040, labels: ['type::story'], body: '' },
        { id: 6041, labels: ['type::story'], body: '' },
      ],
    });

    // Reference.
    const refBus = new Bus();
    const refWriter = new LedgerWriter({ epicId, tempRoot });
    refWriter.register(refBus);
    await runBuildWaveDagPhase({ epicId, provider }, { bus: refBus }, {});
    const reference = readNdjson(refWriter.ledgerPath).map(structuralRecord);
    rmSync(path.join(tempRoot, `epic-${epicId}`), {
      recursive: true,
      force: true,
    });

    // Crashed.
    const crashBus = new Bus();
    const crashWriter = new LedgerWriter({ epicId, tempRoot });
    crashWriter.register(crashBus);
    crashBus.on('epic.plan.start', () => {
      throw new Error('simulated-kill-after-plan-start');
    });
    await assert.rejects(() =>
      runBuildWaveDagPhase({ epicId, provider }, { bus: crashBus }, {}),
    );

    // Resume.
    const resumeBus = new Bus();
    const resumeWriter = new LedgerWriter({ epicId, tempRoot });
    resumeWriter.register(resumeBus);
    await runBuildWaveDagPhase({ epicId, provider }, { bus: resumeBus }, {});

    const all = readNdjson(resumeWriter.ledgerPath);
    const suffix = all.slice(2).map(structuralRecord);
    assert.deepEqual(suffix, reference);
  });
});
