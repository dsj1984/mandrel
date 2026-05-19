/**
 * tests/lib/story-init/dispatch-state-writer.test.js — Story #2535
 * (Epic #2527, Task #2545).
 *
 * Unit coverage for the dispatch-state writer that records a Story's
 * dispatch PID + worktree state under
 * `temp/epic-<epicId>/<storyId>/story-init.state.json`. The reconciler
 * (`lib/orchestration/epic-deliver-reconcile.js`) reads from the same
 * path; this writer is the producer side of that contract.
 *
 * Tests sandbox the repo root under `tmpdir` so the filesystem write is
 * fully isolated from the real repo's `temp/` tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildDispatchStatePayload,
  dispatchStateFilePath,
  writeDispatchStateFile,
} from '../../../.agents/scripts/lib/story-init/dispatch-state-writer.js';

let repoRoot;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-state-test-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('dispatchStateFilePath', () => {
  it('returns the canonical path under temp/epic-<id>/<storyId>/', () => {
    const p = dispatchStateFilePath({
      repoRoot: '/repo',
      epicId: 42,
      storyId: 100,
    });
    assert.equal(
      p,
      path.join('/repo', 'temp', 'epic-42', '100', 'story-init.state.json'),
    );
  });
});

describe('buildDispatchStatePayload', () => {
  it('includes the four required fields', () => {
    const payload = buildDispatchStatePayload({
      dispatchPid: 1234,
      branch: 'story-100',
      worktreePath: '/worktrees/story-100',
      startedAt: '2026-05-19T00:00:00.000Z',
    });
    assert.equal(payload.dispatchPid, 1234);
    assert.equal(payload.startedAt, '2026-05-19T00:00:00.000Z');
    assert.equal(payload.branch, 'story-100');
    assert.equal(payload.worktreePath, '/worktrees/story-100');
  });

  it('defaults startedAt to current ISO timestamp when omitted', () => {
    const before = Date.now();
    const payload = buildDispatchStatePayload({
      dispatchPid: 1,
      branch: 'story-1',
      worktreePath: '/wt',
    });
    const ts = Date.parse(payload.startedAt);
    assert.ok(!Number.isNaN(ts), 'startedAt must be ISO-parseable');
    assert.ok(ts >= before, 'startedAt must be >= test-start time');
    assert.ok(ts <= Date.now(), 'startedAt must be <= now');
  });
});

describe('writeDispatchStateFile', () => {
  it('creates the directory tree and writes the four required fields', () => {
    const result = writeDispatchStateFile({
      repoRoot,
      epicId: 7,
      storyId: 99,
      branch: 'story-99',
      worktreePath: '/abs/path/to/worktree-99',
      dispatchPid: 4242,
      startedAt: '2026-05-19T01:00:00.000Z',
    });

    assert.ok(fs.existsSync(result.path), 'state file should exist');
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.equal(parsed.dispatchPid, 4242);
    assert.equal(parsed.startedAt, '2026-05-19T01:00:00.000Z');
    assert.equal(parsed.branch, 'story-99');
    assert.equal(parsed.worktreePath, '/abs/path/to/worktree-99');
  });

  it('is idempotent — overwrites an existing state file', () => {
    writeDispatchStateFile({
      repoRoot,
      epicId: 7,
      storyId: 99,
      branch: 'story-99',
      worktreePath: '/wt',
      dispatchPid: 1111,
    });
    const second = writeDispatchStateFile({
      repoRoot,
      epicId: 7,
      storyId: 99,
      branch: 'story-99',
      worktreePath: '/wt',
      dispatchPid: 2222,
    });
    const parsed = JSON.parse(fs.readFileSync(second.path, 'utf8'));
    assert.equal(parsed.dispatchPid, 2222);
  });

  it('defaults dispatchPid to process.pid when omitted', () => {
    const result = writeDispatchStateFile({
      repoRoot,
      epicId: 1,
      storyId: 1,
      branch: 'story-1',
      worktreePath: '/wt',
    });
    assert.equal(result.payload.dispatchPid, process.pid);
  });

  it('throws on invalid epicId / storyId', () => {
    assert.throws(
      () =>
        writeDispatchStateFile({
          repoRoot,
          epicId: 0,
          storyId: 1,
          branch: 'b',
          worktreePath: '/wt',
        }),
      /epicId must be a positive integer/,
    );
    assert.throws(
      () =>
        writeDispatchStateFile({
          repoRoot,
          epicId: 1,
          storyId: -1,
          branch: 'b',
          worktreePath: '/wt',
        }),
      /storyId must be a positive integer/,
    );
  });

  it('throws on empty branch / worktreePath', () => {
    assert.throws(
      () =>
        writeDispatchStateFile({
          repoRoot,
          epicId: 1,
          storyId: 1,
          branch: '',
          worktreePath: '/wt',
        }),
      /branch must be a non-empty string/,
    );
    assert.throws(
      () =>
        writeDispatchStateFile({
          repoRoot,
          epicId: 1,
          storyId: 1,
          branch: 'b',
          worktreePath: '',
        }),
      /worktreePath must be a non-empty string/,
    );
  });
});
