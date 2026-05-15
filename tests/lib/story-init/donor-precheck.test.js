/**
 * Pure-helper tests for donor-precheck. The impure orchestration (lock
 * acquisition, npm ci) is exercised via spawnFn/waitFn injection.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __LOCK_DIRNAME,
  ensureDonorPrimed,
  planDonorAction,
  waitForLockClear,
} from '../../../.agents/scripts/lib/story-init/donor-precheck.js';

function fakeFs(present) {
  return {
    existsSync: (p) => present.has(p),
    mkdirSync: () => {},
    rmSync: () => {},
  };
}

test('planDonorAction: non-symlink strategy is skipped', () => {
  const out = planDonorAction({
    strategy: 'per-worktree',
    primeFromPath: '.',
    repoRoot: '/repo',
    fs: fakeFs(new Set()),
  });
  assert.deepEqual(out, { action: 'skip', reason: 'strategy-not-symlink' });
});

test('planDonorAction: symlink without primeFromPath is skipped', () => {
  const out = planDonorAction({
    strategy: 'symlink',
    primeFromPath: null,
    repoRoot: '/repo',
    fs: fakeFs(new Set()),
  });
  assert.deepEqual(out, { action: 'skip', reason: 'no-prime-from-path' });
});

test('planDonorAction: donor already has node_modules → skip', () => {
  const donor = path.resolve('/repo');
  const out = planDonorAction({
    strategy: 'symlink',
    primeFromPath: '.',
    repoRoot: '/repo',
    fs: fakeFs(new Set([path.join(donor, 'node_modules')])),
  });
  assert.deepEqual(out, { action: 'skip', reason: 'donor-already-primed' });
});

test('planDonorAction: donor missing node_modules → install', () => {
  const out = planDonorAction({
    strategy: 'symlink',
    primeFromPath: '.',
    repoRoot: '/repo',
    fs: fakeFs(new Set()),
  });
  assert.equal(out.action, 'install');
  assert.equal(out.donorPath, path.resolve('/repo'));
});

test('ensureDonorPrimed: skips when strategy is not symlink', () => {
  const spawnCalls = [];
  const out = ensureDonorPrimed({
    strategy: 'per-worktree',
    primeFromPath: '.',
    repoRoot: '/repo',
    spawnFn: (...args) => {
      spawnCalls.push(args);
      return { status: 0 };
    },
  });
  assert.equal(out.action, 'skip');
  assert.equal(out.reason, 'strategy-not-symlink');
  assert.equal(spawnCalls.length, 0);
});

test('ensureDonorPrimed: skips fast when donor already primed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  let elapsed = null;
  let calls = 0;
  const ts = [10, 12]; // 2ms elapsed
  const out = ensureDonorPrimed({
    strategy: 'symlink',
    primeFromPath: '.',
    repoRoot: root,
    spawnFn: () => {
      throw new Error('should not run install');
    },
    now: () => {
      const v = ts[calls] ?? ts[ts.length - 1];
      calls += 1;
      return v;
    },
  });
  elapsed = out.durationMs;
  assert.equal(out.action, 'skip');
  assert.equal(out.reason, 'donor-already-primed');
  assert.ok(elapsed < 50, `expected fast skip <50ms, got ${elapsed}ms`);
});

test('ensureDonorPrimed: missing donor node_modules runs npm ci once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-'));
  // Donor has no node_modules; precheck should install.
  const spawnCalls = [];
  // Simulate the installer creating node_modules so the post-finally state
  // is realistic.
  const spawnFn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, cwd: opts.cwd });
    fs.mkdirSync(path.join(root, 'node_modules'));
    return { status: 0 };
  };
  const out = ensureDonorPrimed({
    strategy: 'symlink',
    primeFromPath: '.',
    repoRoot: root,
    spawnFn,
  });
  assert.equal(out.action, 'installed');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'npm');
  assert.deepEqual(spawnCalls[0].args, ['ci']);
  assert.equal(spawnCalls[0].cwd, path.resolve(root));
  // Lock cleaned up.
  assert.equal(fs.existsSync(path.join(root, __LOCK_DIRNAME)), false);
});

test('ensureDonorPrimed: contended lock waits then skips when peer primed donor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-'));
  // Simulate peer holding the lock: pre-create the lock dir.
  fs.mkdirSync(path.join(root, __LOCK_DIRNAME));
  // The peer will appear to release the lock and prime node_modules by
  // the time waitFn returns.
  const waitFn = ({ lockPath }) => {
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'node_modules'));
    return true;
  };
  const out = ensureDonorPrimed({
    strategy: 'symlink',
    primeFromPath: '.',
    repoRoot: root,
    spawnFn: () => {
      throw new Error('should not run install when peer wins');
    },
    waitFn,
  });
  assert.equal(out.action, 'waited');
  assert.equal(out.donorPath, path.resolve(root));
});

test('ensureDonorPrimed: contended lock cleared without priming throws', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-'));
  fs.mkdirSync(path.join(root, __LOCK_DIRNAME));
  const waitFn = ({ lockPath }) => {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  };
  assert.throws(
    () =>
      ensureDonorPrimed({
        strategy: 'symlink',
        primeFromPath: '.',
        repoRoot: root,
        spawnFn: () => ({ status: 0 }),
        waitFn,
      }),
    /released .* without priming node_modules/,
  );
});

test('ensureDonorPrimed: install nonzero exit surfaces an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donor-'));
  assert.throws(
    () =>
      ensureDonorPrimed({
        strategy: 'symlink',
        primeFromPath: '.',
        repoRoot: root,
        spawnFn: () => ({ status: 7 }),
      }),
    /exited with status 7/,
  );
});

test('waitForLockClear: returns true when the lock is removed', () => {
  let calls = 0;
  const present = { exists: true };
  const fakefs = { existsSync: () => present.exists };
  const sleepFn = () => {
    calls += 1;
    if (calls === 2) present.exists = false;
  };
  const ok = waitForLockClear({
    lockPath: '/lock',
    fs: fakefs,
    sleepFn,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(ok, true);
});

test('waitForLockClear: returns false on timeout', () => {
  const fakefs = { existsSync: () => true };
  const tsSeq = [0, 5, 10, 15, 20];
  let i = 0;
  const now = () => tsSeq[Math.min(i++, tsSeq.length - 1)];
  const ok = waitForLockClear({
    lockPath: '/lock',
    fs: fakefs,
    sleepFn: () => {},
    pollIntervalMs: 1,
    timeoutMs: 10,
    now,
  });
  assert.equal(ok, false);
});
