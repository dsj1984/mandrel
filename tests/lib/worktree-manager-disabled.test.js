/**
 * Verifies that `WorktreeManager.ensure / .reap / .gc / .sweepStaleLocks`
 * are true no-ops when constructed with `config.enabled === false`. The
 * call sites in `story-init`, `story-close`, and
 * `post-merge-pipeline` already gate on `wtConfig?.enabled`, but a
 * defense-in-depth guard at the manager level protects against future
 * gating drift on the off-branch (e.g. CLAUDE_CODE_REMOTE web sessions).
 *
 * Each test injects a `git` adapter that fails the assertion on the first
 * call, so a regression that drops the guard surfaces as a hard error
 * rather than a silent fs/git side effect.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { WorktreeManager } from '../../.agents/scripts/lib/worktree-manager.js';

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function makeFailingGit() {
  const fail = (_cwd, ...args) => {
    throw new Error(
      `git unexpectedly invoked when worktree isolation is disabled: ${args.join(' ')}`,
    );
  };
  return { gitSync: fail, gitSpawn: fail };
}

function makeDisabledManager(overrides = {}) {
  return new WorktreeManager({
    repoRoot: process.cwd(),
    config: { enabled: false, ...overrides },
    logger: SILENT_LOGGER,
    git: makeFailingGit(),
  });
}

test('ensure() returns the disabled no-op shape and does not invoke git', () => {
  const wm = makeDisabledManager();
  const result = wm.ensure(123, 'story-123');
  assert.deepEqual(result, {
    path: null,
    created: false,
    skipped: true,
    reason: 'isolation-disabled',
  });
});

test('reap() returns the disabled no-op shape and does not invoke git', () => {
  const wm = makeDisabledManager();
  const result = wm.reap(123, { epicBranch: 'epic/1' });
  assert.deepEqual(result, {
    removed: false,
    skipped: true,
    reason: 'isolation-disabled',
    path: null,
  });
});

test('gc() returns empty arrays + skippedReason and does not invoke git', () => {
  const wm = makeDisabledManager();
  const result = wm.gc([1, 2, 3], { epicBranch: 'epic/1' });
  assert.deepEqual(result, {
    reaped: [],
    skipped: [],
    skippedReason: 'isolation-disabled',
  });
});

test('sweepStaleLocks() returns empty arrays + skippedReason and does no fs work', () => {
  const wm = makeDisabledManager();
  const result = wm.sweepStaleLocks({ maxAgeMs: 1 });
  assert.deepEqual(result, {
    removed: [],
    skipped: [],
    skippedReason: 'isolation-disabled',
  });
});

test('on-branch behaviour is preserved when enabled is undefined (existing tests rely on this)', () => {
  // Constructor defaults do not set `enabled`. A manager with no explicit
  // `enabled` value must NOT short-circuit — only `enabled === false`
  // triggers the no-op. This protects the dozens of fixtures across the
  // suite that build managers without setting the flag.
  const wm = new WorktreeManager({
    repoRoot: process.cwd(),
    config: {}, // no enabled key
    logger: SILENT_LOGGER,
    git: {
      gitSync: () => '',
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    },
  });
  assert.equal(wm._isDisabled(), false);
});

test('explicit enabled=true does not short-circuit', () => {
  const wm = new WorktreeManager({
    repoRoot: process.cwd(),
    config: { enabled: true },
    logger: SILENT_LOGGER,
    git: {
      gitSync: () => '',
      gitSpawn: () => ({ status: 0, stdout: '', stderr: '' }),
    },
  });
  assert.equal(wm._isDisabled(), false);
});
