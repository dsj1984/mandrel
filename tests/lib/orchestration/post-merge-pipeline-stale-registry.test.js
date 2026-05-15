/**
 * post-merge-pipeline — stale-registry-entry handling (Story #1818).
 *
 * Covers the Windows post-reap path where `git worktree prune` lost a race
 * with a file lock on `.git/worktrees/<name>/`. The pipeline retries prune
 * with exponential backoff before declaring `still-registered`; if the
 * directory and branch are already cleaned up the phase reports the
 * `stale-registry-entry` outcome (operationally complete) and records a
 * pending-cleanup entry for the post-close drain.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { worktreeReapPhase } from '../../../.agents/scripts/lib/orchestration/post-merge-pipeline.js';

let prevCwd;
let workRoot;

function readFrictionSignals(epicId, storyId) {
  const p = path.join(
    workRoot,
    'temp',
    `epic-${epicId}`,
    `story-${storyId}`,
    'signals.ndjson',
  );
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function makeLogger() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error: (msg) => errors.push(msg),
    warn: (msg) => warnings.push(msg),
    info: () => {},
    debug: () => {},
  };
}

function makeWmFactory(overrides = {}) {
  const calls = { reap: [], list: 0, prune: 0 };
  const listSeq = Array.isArray(overrides.listSequence)
    ? [...overrides.listSequence]
    : null;
  const wm = {
    reap: async (storyId, opts) => {
      calls.reap.push({ storyId, opts });
      return overrides.reap;
    },
    list: async () => {
      calls.list += 1;
      if (listSeq) return listSeq.length > 0 ? listSeq.shift() : [];
      return overrides.list ?? [];
    },
    prune: async () => {
      calls.prune += 1;
      return { pruned: true };
    },
  };
  return { factory: () => wm, calls };
}

const FAST_SLEEP = () => Promise.resolve();

function callReapPhase(factory, overrides = {}) {
  return worktreeReapPhase({
    orchestration: { worktreeIsolation: { enabled: true, root: '.worktrees' } },
    storyId: 1,
    epicId: 9,
    epicBranch: 'epic/9',
    repoRoot: '/repo',
    progress: () => {},
    sleep: FAST_SLEEP,
    worktreeManagerFactory: factory,
    ...overrides,
  });
}

describe('worktreeReapPhase — stale registry retry', () => {
  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'post-merge-stale-'));
    prevCwd = process.cwd();
    process.chdir(workRoot);
  });

  afterEach(() => {
    if (prevCwd) process.chdir(prevCwd);
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('retries `worktree prune` with backoff and clears stale registry entry', async () => {
    const { factory, calls } = makeWmFactory({
      reap: { removed: true, path: '/repo/.worktrees/story-1' },
      listSequence: [[{ path: '/repo/.worktrees/story-1' }], []],
    });
    const logger = makeLogger();
    const sleepDelays = [];
    const result = await callReapPhase(factory, {
      logger,
      sleep: (ms) => {
        sleepDelays.push(ms);
        return Promise.resolve();
      },
      pathExistsFn: () => false,
    });
    assert.equal(result.status, 'removed');
    assert.equal(calls.prune, 1);
    assert.deepEqual(sleepDelays, [250]);
    assert.equal(
      logger.errors.filter((m) => m.includes('OPERATOR ACTION REQUIRED'))
        .length,
      0,
    );
    assert.equal(readFrictionSignals(9, 1).length, 0);
  });

  it('reports stale-registry-entry (operationally complete) when reap removed dir and deleted branch', async () => {
    const recorded = [];
    const { factory, calls } = makeWmFactory({
      reap: {
        removed: true,
        method: 'fs-rm-retry',
        path: '/repo/.worktrees/story-42',
        branchDeleted: true,
        remoteBranchDeleted: false,
      },
      list: [{ path: '/repo/.worktrees/story-42' }],
    });
    const logger = makeLogger();
    const result = await callReapPhase(factory, {
      storyId: 42,
      epicId: 7,
      epicBranch: 'epic/7',
      logger,
      pathExistsFn: () => false,
      recordPendingCleanupFn: (worktreeRoot, entry) => {
        recorded.push({ worktreeRoot, entry });
        return { ...entry, attempts: 0 };
      },
    });
    assert.deepEqual(
      {
        status: result.status,
        branchDeleted: result.branchDeleted,
        remoteBranchDeleted: result.remoteBranchDeleted,
        path: result.path,
        reason: result.reason,
        hasPendingCleanup: !!result.pendingCleanup,
      },
      {
        status: 'stale-registry-entry',
        branchDeleted: true,
        remoteBranchDeleted: false,
        path: '/repo/.worktrees/story-42',
        reason: 'stale-registry-entry',
        hasPendingCleanup: true,
      },
    );
    assert.deepEqual(recorded, [
      {
        worktreeRoot: path.join('/repo', '.worktrees'),
        entry: {
          storyId: 42,
          branch: 'story-42',
          path: '/repo/.worktrees/story-42',
          push: false,
        },
      },
    ]);
    assert.equal(
      logger.errors.filter((m) => m.includes('OPERATOR ACTION REQUIRED'))
        .length,
      0,
    );
    assert.ok(
      logger.warnings.some((m) =>
        m.includes('Scheduled for background prune via pending-cleanup'),
      ),
      `expected pending-cleanup warn, got: ${JSON.stringify(logger.warnings)}`,
    );
    assert.ok(
      calls.list >= 4,
      `expected at least 4 list calls (initial + 3 retries), got ${calls.list}`,
    );
    assert.equal(calls.prune, 3);
  });
});
