// tests/lib/orchestration/lifecycle/resume-cleanup.test.js
/**
 * Contract test — crash/resume coverage for the cleanup phase
 * (Story #2259 / Task #2267, Epic #2172).
 *
 * The Cleaner is the terminal listener in the bus chain — it
 * archives `temp/epic-<id>/` and emits `epic.complete`. AC-10
 * (Cleaner idempotency) plus the Story #2259 brief require:
 *
 *   1. Two consecutive Cleaner invocations against the same
 *      `(event, seqId)` produce one archive, not two.
 *   2. Across a crash + resume (where the first process completed the
 *      archive but never returned cleanly), the second process
 *      observes the existing archive and short-circuits — it neither
 *      creates a second archive nor re-emits a duplicate
 *      `epic.complete` into the archived ledger.
 *
 * This file pins both invariants. The design pattern under test is
 * the listener's two-layer idempotency defence: a per-instance
 * `(event, seqId)` Set defeats bus-level replays, and the on-disk
 * `findExistingArchive` probe defeats cross-process re-runs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { Cleaner } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/cleaner.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function buildBusWithLedger({ epicId, tempRoot }) {
  const bus = new Bus();
  const writer = new LedgerWriter({ epicId, tempRoot });
  writer.register(bus);
  return { bus, writer };
}

function readLedgerRecords(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function countArchives(tempRoot, epicId) {
  const archiveRoot = path.join(tempRoot, 'archive');
  if (!fs.existsSync(archiveRoot)) return 0;
  return fs
    .readdirSync(archiveRoot)
    .filter((n) => n.startsWith(`epic-${epicId}-`)).length;
}

function findArchive(tempRoot, epicId) {
  const archiveRoot = path.join(tempRoot, 'archive');
  if (!fs.existsSync(archiveRoot)) return null;
  const match = fs
    .readdirSync(archiveRoot)
    .find((n) => n.startsWith(`epic-${epicId}-`));
  return match ? path.join(archiveRoot, match) : null;
}

describe('Cleaner crash/resume — same-process replay (within-bus)', () => {
  let tempRoot;
  const epicId = 2172;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-replay-'));
    fs.mkdirSync(path.join(tempRoot, `epic-${epicId}`), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('two consecutive invocations against the same (event, seqId) produce one archive and one epic.complete', async () => {
    // AC contract pinned by the Story #2259 brief: "Two consecutive
    // Cleaner invocations against the same (event, seqId) produce
    // one archive, not two."
    //
    // Why this scenario matters: the bus replay window (after the
    // `emitted` ledger record lands but before `completed` does)
    // can legitimately re-fire the same listener twice. The
    // listener's per-instance `Set<seqId>` guard defends against
    // that without producing a duplicate archive or duplicate
    // `epic.complete`.
    const { bus, writer } = buildBusWithLedger({ epicId, tempRoot });

    const cleaner = new Cleaner({
      bus,
      epicId,
      tempRoot,
      now: () => new Date('2026-05-17T22:00:00.000Z'),
      logger: quietLogger(),
    });
    cleaner.register();

    const ctx = {
      event: 'epic.merge.armed',
      seqId: 999,
      payload: { prUrl: 'https://github.com/o/r/pull/9' },
    };
    await cleaner.handle(ctx);
    await cleaner.handle(ctx);

    // Exactly one archive directory.
    assert.equal(
      countArchives(tempRoot, epicId),
      1,
      'exactly one archive across two consecutive invocations',
    );

    // Second invocation classified as duplicate.
    const dup = cleaner.classifications.find(
      (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
    );
    assert.ok(dup, 'second invocation classified as duplicate-seqId');

    // The ledger was written into temp/epic-<id>/lifecycle.ndjson
    // BEFORE the rename, so it now sits inside the archive
    // directory (the rename moved the dir wholesale).
    const archiveDir = findArchive(tempRoot, epicId);
    const ledger = readLedgerRecords(path.join(archiveDir, 'lifecycle.ndjson'));
    const completes = ledger.filter(
      (r) => r.event === 'epic.complete' && r.kind === 'emitted',
    );
    assert.equal(
      completes.length,
      1,
      'epic.complete recorded exactly once across the replayed (event, seqId)',
    );

    // The new source directory was recreated by the LedgerWriter on
    // the second invocation's bus.emit path BEFORE the seqId guard
    // fires — that recreation is benign because the seqId guard
    // short-circuits the listener body, so no new events are
    // emitted and the recreated directory is empty / has only the
    // bus-internal ledger header (which the LedgerWriter does not
    // write). The canonical lifecycle.ndjson is in the archive.
    // Sanity check: the writer's path resolution is stable.
    assert.equal(
      writer.ledgerPath,
      path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson'),
    );
  });
});

describe('Cleaner crash/resume — cross-process resume after archive completed', () => {
  let tempRoot;
  const epicId = 2172;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-xproc-'));
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('second process observes existing archive and does NOT re-archive nor duplicate epic.complete in the archived ledger', async () => {
    // Simulate a successful first run that completed the archive,
    // then a second process re-launching against the same Epic.
    // The first process's lifecycle.ndjson is now inside the
    // archive directory (rename moved it). The second process must:
    //   - detect the existing archive,
    //   - short-circuit so no SECOND archive directory is created,
    //   - leave the archived ledger untouched (so the canonical
    //     post-merge record still has exactly one epic.complete).
    fs.mkdirSync(path.join(tempRoot, `epic-${epicId}`), { recursive: true });
    {
      const proc1 = buildBusWithLedger({ epicId, tempRoot });
      const cleaner1 = new Cleaner({
        bus: proc1.bus,
        epicId,
        tempRoot,
        now: () => new Date('2026-05-17T22:00:00.000Z'),
        logger: quietLogger(),
      });
      cleaner1.register();
      await proc1.bus.emit('epic.merge.confirmed', {
        epicId: 2172,
        mergeCommitSha: 'sha',
        pollAttempts: 1,
        prUrl: 'https://github.com/o/r/pull/9',
      });
    }
    // Sanity: first process produced exactly one archive with one
    // epic.complete record.
    assert.equal(countArchives(tempRoot, epicId), 1);
    const archiveDir = findArchive(tempRoot, epicId);
    const archiveLedgerPath = path.join(archiveDir, 'lifecycle.ndjson');
    const archiveLedgerBefore = readLedgerRecords(archiveLedgerPath);
    const completesBefore = archiveLedgerBefore.filter(
      (r) => r.event === 'epic.complete' && r.kind === 'emitted',
    );
    assert.equal(completesBefore.length, 1);

    // === Second process: fresh bus, fresh Cleaner. ===
    const proc2 = buildBusWithLedger({ epicId, tempRoot });
    const cleaner2 = new Cleaner({
      bus: proc2.bus,
      epicId,
      tempRoot,
      now: () => new Date('2026-05-17T23:00:00.000Z'),
      logger: quietLogger(),
    });
    cleaner2.register();
    await proc2.bus.emit('epic.merge.confirmed', {
      epicId: 2172,
      mergeCommitSha: 'sha',
      pollAttempts: 1,
      prUrl: 'https://github.com/o/r/pull/9',
    });

    // Still exactly one archive directory.
    assert.equal(
      countArchives(tempRoot, epicId),
      1,
      'cross-process resume MUST NOT create a second archive',
    );

    // Archived ledger untouched — still exactly one epic.complete.
    const archiveLedgerAfter = readLedgerRecords(archiveLedgerPath);
    assert.deepEqual(
      archiveLedgerAfter,
      archiveLedgerBefore,
      'archived ledger must not be mutated by the resume process',
    );

    // Resume classification recorded existing-archive.
    const existing = cleaner2.classifications.find(
      (c) => c.outcome === 'existing-archive',
    );
    assert.ok(existing, 'resume classified as existing-archive');
    assert.equal(existing.archivedTo, archiveDir);
  });

  it('force-kill mid-archive (first-process rename throws): second process completes a single archive', async () => {
    // First process: rename throws (the kill happens inside the
    // OS rename call — for the test we simulate that as a thrown
    // EBUSY). The pre-rename emit chain completed, so the source
    // ledger carries cleanup.start / cleanup.end / epic.complete
    // (one of each). After the throw, the source remains on disk.
    fs.mkdirSync(path.join(tempRoot, `epic-${epicId}`), { recursive: true });
    let rename1Called = false;
    {
      const proc1 = buildBusWithLedger({ epicId, tempRoot });
      const cleaner1 = new Cleaner({
        bus: proc1.bus,
        epicId,
        tempRoot,
        renameFn: () => {
          rename1Called = true;
          const err = new Error('simulated force-kill mid-rename');
          err.code = 'EBUSY';
          throw err;
        },
        logger: quietLogger(),
      });
      cleaner1.register();
      await proc1.bus.emit('epic.merge.confirmed', {
        epicId: 2172,
        mergeCommitSha: 'sha',
        pollAttempts: 1,
        prUrl: 'https://github.com/o/r/pull/9',
      });
      // First proc tried to rename, but failed.
      assert.equal(rename1Called, true);
      // No archive yet.
      assert.equal(countArchives(tempRoot, epicId), 0);
      // archive-failed classification recorded.
      const failed = cleaner1.classifications.find(
        (c) => c.outcome === 'failed',
      );
      assert.ok(failed);
      assert.match(failed.reason, /archive-failed/);
    }

    // === Second process: fresh, with real renameSync. ===
    const proc2 = buildBusWithLedger({ epicId, tempRoot });
    const cleaner2 = new Cleaner({
      bus: proc2.bus,
      epicId,
      tempRoot,
      now: () => new Date('2026-05-17T23:00:00.000Z'),
      logger: quietLogger(),
    });
    cleaner2.register();
    await proc2.bus.emit('epic.merge.confirmed', {
      epicId: 2172,
      mergeCommitSha: 'sha',
      pollAttempts: 1,
      prUrl: 'https://github.com/o/r/pull/9',
    });

    // Exactly one archive directory at the end of the
    // interrupted+resumed sequence.
    assert.equal(
      countArchives(tempRoot, epicId),
      1,
      'exactly one archive directory after force-kill + resume',
    );

    const archived2 = cleaner2.classifications.find(
      (c) => c.outcome === 'archived',
    );
    assert.ok(archived2, 'second process recorded archived');
  });
});
