// tests/lib/orchestration/lifecycle/activation/cleaner-archival.test.js
/**
 * Activation contract for the Cleaner listener
 * (Story #2338 / Task #2344 / Epic #2306).
 *
 * The unit-level Cleaner suite (`listener-cleaner.test.js`) drives
 * `cleaner.handle(...)` directly with a hand-rolled ctx. This file pins
 * the load-bearing AC at the BUS-DRIVEN activation seam — the same
 * surface the production factory wires:
 *
 *   - After `bus.emit('epic.merge.armed', payload)`, the tmp tree's
 *     contents under `temp/epic-<id>/` are moved to the archive
 *     location at `temp/archive/epic-<id>-<ts>/`.
 *   - The ledger records `epic.cleanup.start → epic.cleanup.end →
 *     epic.complete` in that order with no Cleaner-emitted events in
 *     between. (Other listeners may interleave their own emits; this
 *     suite asserts the Cleaner-driven subsequence is contiguous.)
 *   - `epic.complete` is the LAST Cleaner-emitted event and carries
 *     `{ epicId, prUrl }`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { Cleaner } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/cleaner.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Build a fresh bus with a ledger recorder that captures every emit in
 * order. The recorder uses a wildcard subscriber so it observes events
 * from all sources — including the entry `epic.merge.armed` and the
 * three Cleaner-emitted events.
 */
function recordingBus() {
  const bus = new Bus();
  const ledger = [];
  bus.on('*', async (ctx) => {
    ledger.push({ event: ctx.event, seqId: ctx.seqId, payload: ctx.payload });
  });
  return { bus, ledger };
}

describe('Cleaner — bus-driven archival activation', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-activation-'));
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('after epic.merge.confirmed, archives temp/epic-<id>/ and emits start → end → complete in order', async () => {
    // Arrange: seed a realistic Epic temp tree.
    const epicId = 2306;
    const epicDir = path.join(tempRoot, `epic-${epicId}`);
    fs.mkdirSync(epicDir, { recursive: true });
    fs.writeFileSync(
      path.join(epicDir, 'lifecycle.ndjson'),
      '{"kind":"emitted","seqId":1,"event":"epic.snapshot.start"}\n',
    );
    fs.writeFileSync(
      path.join(epicDir, 'lifecycle.md'),
      '# Epic 2306 lifecycle\n',
    );

    const { bus, ledger } = recordingBus();
    const cleaner = new Cleaner({
      bus,
      epicId,
      tempRoot,
      now: () => new Date('2026-05-17T22:00:00.000Z'),
      logger: quietLogger(),
    });
    cleaner.register();

    const prUrl = 'https://github.com/dsj1984/mandrel/pull/9999';

    // Act. Story #2896 rebound Cleaner to `epic.merge.confirmed`;
    // the watcher emits this once the PR's mergeCommit goes non-null.
    // The Cleaner sources `epicId` from its constructor.
    await bus.emit('epic.merge.confirmed', {
      epicId,
      prUrl,
      prNumber: 9999,
      mergeCommitSha: 'deadbeef',
      mergedAt: '2026-05-17T22:00:00.000Z',
      pollAttempts: 1,
    });

    // Assert: source directory has moved.
    assert.equal(
      fs.existsSync(epicDir),
      false,
      'temp/epic-<id>/ MUST be moved to the archive after epic.merge.confirmed',
    );

    // Assert: archive destination exists at the expected path and
    // contains the seeded ledger files.
    const archiveDir = path.join(
      tempRoot,
      'archive',
      `epic-${epicId}-2026-05-17T22-00-00-000Z`,
    );
    assert.equal(
      fs.existsSync(archiveDir),
      true,
      'archive directory at temp/archive/epic-<id>-<ts>/ MUST exist',
    );
    assert.equal(
      fs.existsSync(path.join(archiveDir, 'lifecycle.ndjson')),
      true,
      'lifecycle.ndjson MUST be preserved under the archive directory',
    );
    assert.equal(
      fs.existsSync(path.join(archiveDir, 'lifecycle.md')),
      true,
      'lifecycle.md MUST be preserved under the archive directory',
    );

    // Assert: the ledger records the three Cleaner-emitted events
    // contiguously, in the canonical close-tail order. The entry
    // `epic.merge.confirmed` is observed once (delivered to the
    // wildcard recorder after the named Cleaner handler completes,
    // per the bus mediator's named-before-wildcard delivery
    // semantics).
    const events = ledger.map((e) => e.event);
    const cleanerSubsequence = [
      'epic.cleanup.start',
      'epic.cleanup.end',
      'epic.complete',
    ];
    const startIdx = events.indexOf('epic.cleanup.start');
    assert.notEqual(startIdx, -1, 'epic.cleanup.start MUST appear in ledger');
    assert.deepEqual(
      events.slice(startIdx, startIdx + cleanerSubsequence.length),
      cleanerSubsequence,
      'Cleaner-emitted events MUST appear contiguously in start → end → complete order',
    );
    assert.equal(
      events.filter((e) => e === 'epic.merge.confirmed').length,
      1,
      'entry epic.merge.confirmed observed exactly once in the ledger',
    );

    // Assert: the epic.complete record carries { epicId, prUrl }. The
    // Cleaner sources epicId from its constructor and re-emits it so
    // downstream listeners (LabelTransitioner) have the Epic ticket id.
    const completeRecord = ledger.find((e) => e.event === 'epic.complete');
    assert.ok(completeRecord, 'epic.complete MUST be recorded in the ledger');
    assert.deepEqual(completeRecord.payload, { epicId, prUrl });

    // Assert: the Cleaner's classification surface confirms the archive
    // outcome (the "no silent skip" invariant shared with the other
    // close-tail listeners).
    const archivedClassification = cleaner.classifications.find(
      (c) => c.outcome === 'archived',
    );
    assert.ok(
      archivedClassification,
      'Cleaner MUST record an `archived` classification for the happy path',
    );
    assert.equal(archivedClassification.archivedTo, archiveDir);
    assert.equal(archivedClassification.epicId, epicId);
  });
});
