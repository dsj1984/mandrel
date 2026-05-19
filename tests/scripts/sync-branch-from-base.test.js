/**
 * tests/scripts/sync-branch-from-base.test.js — CLI runner coverage for
 * the operator-facing wrapper around `syncBranchFromBase` (Story #2580).
 *
 * Real git is never invoked — the suite injects fakes via the runner's
 * `injectedSync` / `injectedGitSync` seams.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseArgv,
  runSyncBranchFromBase,
} from '../../.agents/scripts/sync-branch-from-base.js';

test('parseArgv: extracts --branch / --base / --cwd', () => {
  const parsed = parseArgv([
    '--branch',
    'story-42',
    '--base',
    'main',
    '--cwd',
    '/repo',
  ]);
  assert.deepEqual(parsed, {
    branch: 'story-42',
    base: 'main',
    cwd: '/repo',
  });
});

test('parseArgv: returns nulls for unset flags', () => {
  const parsed = parseArgv([]);
  assert.deepEqual(parsed, { branch: null, base: null, cwd: null });
});

test('runSyncBranchFromBase: throws when branch is missing', async () => {
  await assert.rejects(
    () =>
      runSyncBranchFromBase({
        base: 'main',
        injectedGitSync: () => 'story-42',
        injectedSync: async () => ({ synced: true, kind: 'fast-forward' }),
      }),
    /--branch <branchName>/,
  );
});

test('runSyncBranchFromBase: throws when active branch mismatches --branch', async () => {
  await assert.rejects(
    () =>
      runSyncBranchFromBase({
        branch: 'story-42',
        base: 'main',
        cwd: '/repo',
        injectedGitSync: () => 'main',
        injectedSync: async () => ({ synced: true, kind: 'fast-forward' }),
      }),
    /Active branch is "main" but --branch is "story-42"/,
  );
});

test('runSyncBranchFromBase: returns success envelope on clean sync', async () => {
  const out = await runSyncBranchFromBase({
    branch: 'story-42',
    base: 'main',
    cwd: '/repo',
    injectedGitSync: () => 'story-42',
    injectedSync: async () => ({ synced: true, kind: 'merge-commit' }),
  });
  assert.equal(out.success, true);
  assert.equal(out.result.kind, 'merge-commit');
});

test('runSyncBranchFromBase: throws with conflict file list on conflict', async () => {
  await assert.rejects(
    () =>
      runSyncBranchFromBase({
        branch: 'story-42',
        base: 'main',
        cwd: '/repo',
        injectedGitSync: () => 'story-42',
        injectedSync: async () => ({
          synced: false,
          kind: 'conflict',
          conflictFiles: ['src/foo.js'],
        }),
      }),
    /sync failed \(conflict\).*src\/foo\.js/,
  );
});

test('runSyncBranchFromBase: throws with stderr on fetch-failed', async () => {
  await assert.rejects(
    () =>
      runSyncBranchFromBase({
        branch: 'story-42',
        base: 'main',
        cwd: '/repo',
        injectedGitSync: () => 'story-42',
        injectedSync: async () => ({
          synced: false,
          kind: 'fetch-failed',
          stderr: 'fatal: not a git repository',
        }),
      }),
    /sync failed \(fetch-failed\).*not a git repository/,
  );
});
