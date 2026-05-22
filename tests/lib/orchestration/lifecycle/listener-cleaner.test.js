// tests/lib/orchestration/lifecycle/listener-cleaner.test.js
/**
 * Unit tests for the lifecycle Cleaner listener
 * (Story #2259 / Task #2265, Epic #2172).
 *
 * Acceptance contract:
 *   - Subscribes to `epic.merge.confirmed` (and ONLY that event;
 *     rebound from `epic.merge.armed` by Story #2896, Epic #2880,
 *     so the Epic only transitions to its terminal state after the
 *     MergeWatcher has observed the PR actually merging on GitHub).
 *   - On a fresh run with a source `temp/epic-<id>/` directory,
 *     archives it under `temp/archive/epic-<id>-<ts>/` and emits
 *     `epic.cleanup.start` → `epic.cleanup.end` → `epic.complete` in
 *     that order.
 *   - `epic.complete` is the LAST event recorded — terminal of a
 *     successful Epic run.
 *   - On resume (source absent, archive present), short-circuits to a
 *     single emit sequence without creating a second archive
 *     directory.
 *   - Listener-level idempotency: repeat `(event, seqId)` emits
 *     nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  Cleaner,
  findExistingArchive,
  formatArchiveTimestamp,
  resolveArchiveDest,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/cleaner.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.cleanup.start', record('epic.cleanup.start'));
  bus.on('epic.cleanup.end', record('epic.cleanup.end'));
  bus.on('epic.complete', record('epic.complete'));
  return { bus, emits };
}

describe('formatArchiveTimestamp', () => {
  it('replaces `:` and `.` with `-` for filesystem-safe naming', () => {
    const ts = formatArchiveTimestamp(new Date('2026-05-17T21:55:09.123Z'));
    assert.equal(ts, '2026-05-17T21-55-09-123Z');
    // No colons (Windows-unsafe) or dots that would split file types.
    assert.equal(ts.includes(':'), false);
  });
});

describe('resolveArchiveDest', () => {
  it('builds <tempRoot>/archive/epic-<id>-<ts>', () => {
    const dest = resolveArchiveDest({
      tempRoot: '/t',
      epicId: 2172,
      now: new Date('2026-05-17T21:55:09.000Z'),
    });
    assert.equal(
      dest,
      path.join('/t', 'archive', 'epic-2172-2026-05-17T21-55-09-000Z'),
    );
  });
});

describe('findExistingArchive', () => {
  it('returns null when archive root is missing', () => {
    assert.equal(
      findExistingArchive({
        tempRoot: `/nonexistent-${Math.random().toString(36).slice(2)}`,
        epicId: 1,
      }),
      null,
    );
  });

  it('returns the first matching archive dir, sorted', () => {
    const fakeReaddir = (_dir, _opts) => [
      {
        name: 'epic-99-2024-01-01T00-00-00-000Z',
        isDirectory: () => true,
      },
      {
        name: 'epic-2172-2026-05-17T21-55-09-000Z',
        isDirectory: () => true,
      },
      {
        name: 'epic-2172-2026-05-17T21-56-09-000Z',
        isDirectory: () => true,
      },
      {
        name: 'unrelated',
        isDirectory: () => true,
      },
      {
        name: 'epic-2172-file.txt',
        isDirectory: () => false,
      },
    ];
    const found = findExistingArchive({
      tempRoot: '/t',
      epicId: 2172,
      readdirFn: fakeReaddir,
    });
    // Earliest timestamp comes first lexicographically.
    assert.equal(
      found,
      path.join('/t', 'archive', 'epic-2172-2026-05-17T21-55-09-000Z'),
    );
  });
});

describe('Cleaner (bus integration) — happy path', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-happy-'));
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('subscribes ONLY to epic.merge.confirmed', () => {
    const cleaner = new Cleaner({
      bus: new Bus(),
      epicId: 2172,
      tempRoot,
      logger: quietLogger(),
    });
    assert.deepEqual([...cleaner.events], ['epic.merge.confirmed']);
    assert.equal(cleaner.events.length, 1);
  });

  it('archives temp/epic-<id>/ and emits start → end → complete', async () => {
    // Arrange: build a realistic epic temp dir with a ledger + companion.
    const epicDir = path.join(tempRoot, 'epic-2172');
    fs.mkdirSync(epicDir, { recursive: true });
    fs.writeFileSync(
      path.join(epicDir, 'lifecycle.ndjson'),
      '{"kind":"emitted","seqId":1,"event":"epic.snapshot.start"}\n',
    );
    fs.writeFileSync(
      path.join(epicDir, 'lifecycle.md'),
      '# Epic 2172 lifecycle\n',
    );

    const { bus, emits } = recordingBus();
    const cleaner = new Cleaner({
      bus,
      epicId: 2172,
      tempRoot,
      now: () => new Date('2026-05-17T21:55:09.000Z'),
      logger: quietLogger(),
    });
    cleaner.register();

    // Act.
    await bus.emit('epic.merge.confirmed', {
      epicId: 2172,
      prUrl: 'https://github.com/o/r/pull/9',
      prNumber: 9,
      mergeCommitSha: 'deadbeef',
      mergedAt: '2026-05-17T21:55:09.000Z',
      pollAttempts: 1,
    });

    // Assert: temp/epic-2172/ moved.
    assert.equal(fs.existsSync(epicDir), false);

    // Assert: archive directory exists and contains the ledger files.
    const archiveDir = path.join(
      tempRoot,
      'archive',
      'epic-2172-2026-05-17T21-55-09-000Z',
    );
    assert.equal(fs.existsSync(archiveDir), true);
    assert.equal(
      fs.existsSync(path.join(archiveDir, 'lifecycle.ndjson')),
      true,
      'lifecycle.ndjson preserved in archive',
    );
    assert.equal(
      fs.existsSync(path.join(archiveDir, 'lifecycle.md')),
      true,
      'lifecycle.md preserved in archive',
    );

    // Assert: emit order — start → end → complete (the AC contract).
    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, [
      'epic.cleanup.start',
      'epic.cleanup.end',
      'epic.complete',
    ]);

    // Assert: epic.complete is the LAST event and carries epicId + prUrl.
    const last = emits[emits.length - 1];
    assert.equal(last.event, 'epic.complete');
    assert.deepEqual(last.payload, {
      epicId: 2172,
      prUrl: 'https://github.com/o/r/pull/9',
    });

    // Classification surface.
    const c = cleaner.classifications.find((cl) => cl.outcome === 'archived');
    assert.ok(c, 'classification recorded as archived');
    assert.equal(c.archivedTo, archiveDir);
  });
});

describe('Cleaner — resume contract (AC-10 Cleaner idempotency)', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-resume-'));
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('when source is absent and archive present, short-circuits without re-archiving', async () => {
    // Simulate: a prior process completed the rename, then crashed
    // BEFORE emitting epic.cleanup.end. The archive directory is on
    // disk; the source is not.
    const archiveDir = path.join(
      tempRoot,
      'archive',
      'epic-2172-2026-05-17T21-55-09-000Z',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'lifecycle.ndjson'),
      '{"kind":"emitted","seqId":1,"event":"epic.snapshot.start"}\n',
    );

    const { bus, emits } = recordingBus();
    let renameCalls = 0;
    const cleaner = new Cleaner({
      bus,
      epicId: 2172,
      tempRoot,
      now: () => new Date('2026-05-17T22:00:00.000Z'),
      renameFn: () => {
        renameCalls += 1;
      },
      logger: quietLogger(),
    });
    cleaner.register();

    await bus.emit('epic.merge.confirmed', {
      epicId: 2172,
      prUrl: 'https://github.com/o/r/pull/9',
      prNumber: 9,
      mergeCommitSha: 'cafefeed',
      mergedAt: '2026-05-17T22:00:00.000Z',
      pollAttempts: 1,
    });

    // No second archive directory was created — the existing one is
    // recorded and the listener proceeded straight to cleanup.end.
    const archives = fs
      .readdirSync(path.join(tempRoot, 'archive'))
      .filter((n) => n.startsWith('epic-2172-'));
    assert.equal(archives.length, 1, 'exactly one archive directory exists');
    assert.equal(renameCalls, 0, 'rename MUST NOT run when source is absent');

    const ordered = emits.map((e) => e.event);
    assert.deepEqual(ordered, [
      'epic.cleanup.start',
      'epic.cleanup.end',
      'epic.complete',
    ]);

    const c = cleaner.classifications.find(
      (cl) => cl.outcome === 'existing-archive',
    );
    assert.ok(c, 'classification recorded as existing-archive');
    assert.equal(c.archivedTo, archiveDir);
  });
});

describe('Cleaner — listener-level idempotency', () => {
  it('repeat (event, seqId) is recorded as duplicate and emits nothing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-dup-'));
    try {
      fs.mkdirSync(path.join(tempRoot, 'epic-2172'));
      fs.writeFileSync(
        path.join(tempRoot, 'epic-2172', 'lifecycle.ndjson'),
        '{}\n',
      );

      const bus = new Bus();
      const completeEmits = [];
      bus.on('epic.cleanup.start', async () => {});
      bus.on('epic.cleanup.end', async () => {});
      bus.on('epic.complete', async (ctx) =>
        completeEmits.push({ seqId: ctx.seqId }),
      );

      const cleaner = new Cleaner({
        bus,
        epicId: 2172,
        tempRoot,
        logger: quietLogger(),
      });
      cleaner.register();

      const ctx = {
        event: 'epic.merge.confirmed',
        seqId: 500,
        payload: { prUrl: 'https://github.com/o/r/pull/9' },
      };
      await cleaner.handle(ctx);
      await cleaner.handle(ctx);

      assert.equal(completeEmits.length, 1, 'epic.complete emitted once');
      const dup = cleaner.classifications.find(
        (c) => c.outcome === 'skipped' && c.reason === 'duplicate-seqId',
      );
      assert.ok(dup);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
