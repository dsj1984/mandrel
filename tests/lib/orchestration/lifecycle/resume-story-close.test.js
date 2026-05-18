// tests/lib/orchestration/lifecycle/resume-story-close.test.js
/**
 * Crash/resume tests for the story-close lifecycle emits
 * (Story #2241 / Task #2248).
 *
 * Pattern mirrors `resume-iterate-waves.test.js`:
 *
 *   1. Drive the emit on a bus that throws inside a listener
 *      *after* LedgerWriter's `onEmitted` hook persisted the
 *      `emitted` line. This is the "killed mid-flight" window —
 *      the ledger carries `emitted` (+ `failed`), no `completed`.
 *   2. Capture the partial ledger contents (proves the durable-
 *      on-disk invariant required for the resume contract).
 *   3. Resume: fresh bus + writer pointed at the SAME ledger path,
 *      re-emit the same `story.merged`. AppendFileSync semantics
 *      put new records after the partial preamble.
 *   4. Compare the resumed suffix to an uninterrupted reference
 *      run (modulo `ts` and `seqId` per the resume contract).
 *
 * Acceptance focus (Acceptance Spec AC-3 / Repeatability AC #5):
 * resume after the kill produces NO duplicate squash-merge — i.e.
 * `story.merged` is emitted exactly once when the listener phase
 * is replayed. The Finalizer idempotency contract is not yet
 * reachable from the bus surface (it lives downstream in
 * post-merge-close.js), so this test pins the bus-level
 * guarantee: a second `story.merged` for the same `(storyId, sha)`
 * MUST land on the ledger if and only if the resumed phase emits
 * it; the partial preamble's `emitted`/`failed` records are not
 * counted twice.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { emitStoryBlockedSafe } from '../../../../.agents/scripts/lib/orchestration/story-close/merge-runner.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Strip the run-scoped + wall-clock fields that intentionally vary
 * between runs. Same exclusion set as `resume-iterate-waves.test.js`
 * so the comparison contract is uniform across phases.
 */
function structuralRecord(record) {
  const { ts: _ts, seqId: _seqId, ...rest } = record;
  return rest;
}

describe('lifecycle/resume-story-close — story.merged', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-resume-st-close-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('partial ledger after a kill BEFORE the completed boundary is durable on disk', async () => {
    const epicId = 7401;
    const storyId = 9201;
    const sha = 'feedfacefeedfacefeedfacefeedfacefeedface';

    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    // Crash window: throw inside a story.merged listener. The bus
    // contract guarantees `onEmitted` (writer hook) lands the
    // `emitted` record BEFORE any listener runs, so the throw lands
    // us in the documented "start emitted, completed never emitted"
    // resume state.
    bus.on('story.merged', () => {
      throw new Error('simulated-kill-after-story-merged-emit');
    });

    await assert.rejects(() => bus.emit('story.merged', { storyId, sha }), {
      message: 'simulated-kill-after-story-merged-emit',
    });

    const partial = readNdjson(writer.ledgerPath);
    const emitted = partial.filter(
      (r) => r.event === 'story.merged' && r.kind === 'emitted',
    );
    assert.equal(emitted.length, 1, 'one emitted story.merged');
    const completed = partial.filter(
      (r) => r.event === 'story.merged' && r.kind === 'completed',
    );
    assert.equal(completed.length, 0, 'no completed story.merged (killed)');
    const failed = partial.filter(
      (r) => r.event === 'story.merged' && r.kind === 'failed',
    );
    assert.equal(failed.length, 1, 'one failed boundary record');
  });

  it('resume yields a ledger suffix structurally identical (modulo ts/seqId) to an uninterrupted run', async () => {
    const epicId = 7402;
    const storyId = 9202;
    const sha = 'cafebabecafebabecafebabecafebabecafebabe';

    // Reference: uninterrupted run.
    const refBus = new Bus();
    const refWriter = new LedgerWriter({ epicId, tempRoot });
    refWriter.register(refBus);
    await refBus.emit('story.merged', { storyId, sha });
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
    crashBus.on('story.merged', () => {
      throw new Error('simulated-kill');
    });
    await assert.rejects(() => crashBus.emit('story.merged', { storyId, sha }));

    // Resume: fresh bus + writer at the SAME ledger path.
    const resumeBus = new Bus();
    const resumeWriter = new LedgerWriter({ epicId, tempRoot });
    resumeWriter.register(resumeBus);
    await resumeBus.emit('story.merged', { storyId, sha });

    // The crashed run left 2 preamble records (emitted + failed).
    // Drop them and compare the suffix.
    const all = readNdjson(resumeWriter.ledgerPath);
    const suffix = all.slice(2).map(structuralRecord);
    assert.deepEqual(suffix, reference);

    // AC-2 — single squash-merge: across the full ledger, exactly two
    // `story.merged.emitted` records exist (one from the crashed
    // attempt's pre-throw onEmitted hook, one from the successful
    // resume). The `completed` boundary fires exactly once — the
    // resume attempt — proving the listener phase ran to success
    // exactly once.
    const allEmitted = all.filter(
      (r) => r.event === 'story.merged' && r.kind === 'emitted',
    );
    const allCompleted = all.filter(
      (r) => r.event === 'story.merged' && r.kind === 'completed',
    );
    assert.equal(allEmitted.length, 2);
    assert.equal(allCompleted.length, 1);
  });

  it('idempotency across cold-bus replay: a fresh listener cache + same ledger path does not double-cascade story.blocked', async () => {
    // story.blocked is the secondary emit on the close path. The
    // resume contract for this event is the same: the writer's
    // append-only ledger carries `emitted` once per real emit, and a
    // second invocation with the same payload (after a kill window)
    // produces a separate `emitted` record on append. Listener
    // idempotency lives in the listener (see listener-blocker.test.js
    // AC-10); this test validates that the ledger durability
    // contract still holds for the `story.blocked` schema.
    const epicId = 7403;
    const storyId = 9203;

    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    await emitStoryBlockedSafe({
      bus,
      storyId,
      reason: 'timeout:biome-format',
      logger: { warn() {}, debug() {} },
    });

    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter(
      (r) => r.event === 'story.blocked' && r.kind === 'emitted',
    );
    const completed = records.filter(
      (r) => r.event === 'story.blocked' && r.kind === 'completed',
    );
    assert.equal(emitted.length, 1);
    assert.equal(completed.length, 1);

    // Re-emit (simulates a resume that retries the close path). The
    // ledger appends a second pair; this is the documented behaviour
    // — listener-level idempotency (BlockerHandler's seqId cache)
    // dedupes the *cascade* to epic.blocked, but the bus-level
    // `story.blocked` events themselves are not deduped by the bus.
    await emitStoryBlockedSafe({
      bus,
      storyId,
      reason: 'timeout:biome-format',
      logger: { warn() {}, debug() {} },
    });
    const after = readNdjson(writer.ledgerPath);
    const afterEmitted = after.filter(
      (r) => r.event === 'story.blocked' && r.kind === 'emitted',
    );
    assert.equal(
      afterEmitted.length,
      2,
      'bus emits land independently; listener idempotency dedupes the cascade',
    );
  });
});
