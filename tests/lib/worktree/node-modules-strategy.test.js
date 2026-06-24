import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyNodeModulesStrategy,
  cloneNodeModules,
  describeAttemptFailure,
  installDependencies,
  installRetryPolicy,
  isInstallSkippable,
  lockfileHash,
  probeReusedInstall,
  runInstallWithRetry,
  selectInstallCommand,
} from '../../../.agents/scripts/lib/worktree/node-modules-strategy.js';

test('selectInstallCommand: symlink strategy returns null', () => {
  assert.equal(selectInstallCommand('symlink', '/wt'), null);
});

test('selectInstallCommand: returns null when package.json is absent', () => {
  const fsLike = { existsSync: () => false };
  assert.equal(selectInstallCommand('per-worktree', '/wt', fsLike), null);
});

test('selectInstallCommand: pnpm-store always uses pnpm install --frozen-lockfile', () => {
  const fsLike = { existsSync: (p) => p.endsWith('package.json') };
  assert.deepEqual(selectInstallCommand('pnpm-store', '/wt', fsLike), {
    cmd: 'pnpm',
    args: ['install', '--frozen-lockfile'],
  });
});

test('selectInstallCommand: per-worktree picks pnpm/yarn/npm based on lock file', () => {
  const withFiles = (...names) => ({
    existsSync: (p) =>
      names.some((n) => p.endsWith(n)) || p.endsWith('package.json'),
  });
  assert.deepEqual(
    selectInstallCommand('per-worktree', '/wt', withFiles('pnpm-lock.yaml')),
    { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] },
  );
  assert.deepEqual(
    selectInstallCommand('per-worktree', '/wt', withFiles('yarn.lock')),
    { cmd: 'yarn', args: ['install', '--frozen-lockfile'] },
  );
  assert.deepEqual(selectInstallCommand('per-worktree', '/wt', withFiles()), {
    cmd: 'npm',
    args: ['ci'],
  });
});

test('selectInstallCommand: clone shares per-worktree PM detection', () => {
  const withFiles = (...names) => ({
    existsSync: (p) =>
      names.some((n) => p.endsWith(n)) || p.endsWith('package.json'),
  });
  assert.deepEqual(
    selectInstallCommand('clone', '/wt', withFiles('pnpm-lock.yaml')),
    { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] },
  );
  assert.deepEqual(
    selectInstallCommand('clone', '/wt', withFiles('yarn.lock')),
    { cmd: 'yarn', args: ['install', '--frozen-lockfile'] },
  );
  assert.deepEqual(selectInstallCommand('clone', '/wt', withFiles()), {
    cmd: 'npm',
    args: ['ci'],
  });
});

test('installRetryPolicy: pnpm gets 3 attempts and 5min timeout', () => {
  const p = installRetryPolicy('pnpm');
  assert.equal(p.maxAttempts, 3);
  assert.equal(p.timeoutMs, 300_000);
  assert.deepEqual(p.backoffMs, [0, 2_000, 5_000]);
});

test('installRetryPolicy: npm/yarn get 2 attempts and 2min timeout (Story #4249 in-ensure retry budget)', () => {
  const npm = installRetryPolicy('npm');
  assert.equal(npm.maxAttempts, 2);
  assert.equal(npm.timeoutMs, 120_000);
  const yarn = installRetryPolicy('yarn');
  assert.equal(yarn.maxAttempts, 2);
  assert.equal(yarn.timeoutMs, 120_000);
});

test('describeAttemptFailure: SIGTERM is reported as a timeout', () => {
  assert.equal(
    describeAttemptFailure({ signal: 'SIGTERM', status: null }, 60_000),
    'timeout after 60s',
  );
});

test('describeAttemptFailure: non-zero exit reports the status', () => {
  assert.equal(
    describeAttemptFailure({ signal: null, status: 7 }, 60_000),
    'exit 7',
  );
});

test('runInstallWithRetry: succeeds on first attempt without sleeping', () => {
  const sleepCalls = [];
  const out = runInstallWithRetry({
    cmd: 'npm',
    args: ['ci'],
    cwd: '/wt',
    shell: false,
    policy: installRetryPolicy('npm'),
    spawnFn: () => ({ status: 0, stderr: '' }),
    sleepFn: (ms) => sleepCalls.push(ms),
    logger: { info: () => {}, warn: () => {} },
    strategy: 'per-worktree',
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 1);
  assert.deepEqual(sleepCalls, []);
});

test('runInstallWithRetry: retries pnpm up to maxAttempts before giving up', () => {
  let calls = 0;
  const out = runInstallWithRetry({
    cmd: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: '/wt',
    shell: false,
    policy: installRetryPolicy('pnpm'),
    spawnFn: () => {
      calls += 1;
      return { status: 1, stderr: 'boom' };
    },
    sleepFn: () => {},
    logger: { info: () => {}, warn: () => {} },
    strategy: 'pnpm-store',
  });
  assert.equal(calls, 3);
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 3);
});

test('runInstallWithRetry: a yarn consumer transient first-install failure retries with the yarn command, never npm ci (Story #4249)', () => {
  // selectInstallCommand resolves yarn for a yarn-lock worktree...
  const yarnSelection = selectInstallCommand('clone', '/wt', {
    existsSync: (p) => p.endsWith('yarn.lock') || p.endsWith('package.json'),
  });
  assert.deepEqual(yarnSelection, {
    cmd: 'yarn',
    args: ['install', '--frozen-lockfile'],
  });
  // ...and the in-ensure retry budget gives npm/yarn a real second attempt,
  // so a transient first failure retries with the SAME (correct) PM command.
  const seen = [];
  const out = runInstallWithRetry({
    cmd: yarnSelection.cmd,
    args: yarnSelection.args,
    cwd: '/wt',
    shell: false,
    policy: installRetryPolicy(yarnSelection.cmd),
    spawnFn: (cmd, args) => {
      seen.push({ cmd, args });
      return { status: seen.length === 1 ? 1 : 0, stderr: 'transient' };
    },
    sleepFn: () => {},
    logger: { info: () => {}, warn: () => {} },
    strategy: 'clone',
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(seen.length, 2);
  assert.ok(
    seen.every((s) => s.cmd === 'yarn'),
    'retry must reuse the detected PM command, not fall back to npm ci',
  );
});

test('runInstallWithRetry: succeeds on attempt 2 after one failure', () => {
  let calls = 0;
  const out = runInstallWithRetry({
    cmd: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: '/wt',
    shell: false,
    policy: installRetryPolicy('pnpm'),
    spawnFn: () => {
      calls += 1;
      return { status: calls === 1 ? 1 : 0, stderr: '' };
    },
    sleepFn: () => {},
    logger: { info: () => {}, warn: () => {} },
    strategy: 'pnpm-store',
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(calls, 2);
});

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

test('applyNodeModulesStrategy: per-worktree is a no-op', () => {
  assert.doesNotThrow(() =>
    applyNodeModulesStrategy(
      {
        config: { nodeModulesStrategy: 'per-worktree' },
        platform: 'linux',
        logger: quietLogger(),
        repoRoot: '/repo',
      },
      '/repo/.worktrees/story-1',
    ),
  );
});

test('applyNodeModulesStrategy: pnpm-store is a no-op (install runs later)', () => {
  assert.doesNotThrow(() =>
    applyNodeModulesStrategy(
      {
        config: { nodeModulesStrategy: 'pnpm-store' },
        platform: 'linux',
        logger: quietLogger(),
        repoRoot: '/repo',
      },
      '/repo/.worktrees/story-1',
    ),
  );
});

test('applyNodeModulesStrategy: symlink requires primeFromPath', () => {
  assert.throws(
    () =>
      applyNodeModulesStrategy(
        {
          config: { nodeModulesStrategy: 'symlink' },
          platform: 'linux',
          logger: quietLogger(),
          repoRoot: '/repo',
        },
        '/repo/.worktrees/story-1',
      ),
    /primeFromPath/,
  );
});

test('applyNodeModulesStrategy: symlink refuses on win32 without opt-in', () => {
  assert.throws(
    () =>
      applyNodeModulesStrategy(
        {
          config: { nodeModulesStrategy: 'symlink', primeFromPath: '.' },
          platform: 'win32',
          logger: quietLogger(),
          repoRoot: '/repo',
        },
        '/repo/.worktrees/story-1',
      ),
    /refuses on Windows/,
  );
});

test('applyNodeModulesStrategy: symlink errors when primeFromPath has no node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-'));
  assert.throws(
    () =>
      applyNodeModulesStrategy(
        {
          config: {
            nodeModulesStrategy: 'symlink',
            primeFromPath: 'donor',
            allowSymlinkOnWindows: true,
          },
          platform: 'linux',
          logger: quietLogger(),
          repoRoot: root,
        },
        path.join(root, 'story-1'),
      ),
    /has no node_modules/,
  );
});

test('applyNodeModulesStrategy: unknown strategy rejects', () => {
  assert.throws(
    () =>
      applyNodeModulesStrategy(
        {
          config: { nodeModulesStrategy: 'bogus' },
          platform: 'linux',
          logger: quietLogger(),
          repoRoot: '/repo',
        },
        '/repo/.worktrees/story-1',
      ),
    /unknown nodeModulesStrategy/,
  );
});

test('installDependencies: symlink reports skipped without running installer', () => {
  assert.deepEqual(
    installDependencies(
      {
        config: { nodeModulesStrategy: 'symlink' },
        platform: 'linux',
        logger: quietLogger(),
      },
      '/nonexistent',
    ),
    { status: 'skipped', reason: 'symlink-strategy' },
  );
});

test('installDependencies: no package.json in worktree reports skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-'));
  assert.deepEqual(
    installDependencies(
      {
        config: { nodeModulesStrategy: 'per-worktree' },
        platform: 'linux',
        logger: quietLogger(),
      },
      root,
    ),
    { status: 'skipped', reason: 'no-package-json' },
  );
});

// ---- probeReusedInstall (Story #4018: reuse must not defeat install retry) ----
// Story #4249: the freshness check is now keyed on a byte-exact lockfile hash,
// never mtime — so the fs facade serves file *contents*, not mtimes.

function probeFsLike({ files = [], contents = {} } = {}) {
  return {
    existsSync: (p) => files.some((f) => p.endsWith(f)),
    readFileSync: (p) => {
      const hit = Object.keys(contents).find((k) => p.endsWith(k));
      if (hit === undefined) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(contents[hit]);
    },
  };
}

test('probeReusedInstall: symlink strategy always skips', () => {
  assert.deepEqual(probeReusedInstall('symlink', '/wt', probeFsLike()), {
    status: 'skipped',
    reason: 'worktree-reused',
  });
});

test('probeReusedInstall: no package.json skips (nothing to install)', () => {
  assert.deepEqual(probeReusedInstall('per-worktree', '/wt', probeFsLike()), {
    status: 'skipped',
    reason: 'no-package-json',
  });
});

test('probeReusedInstall: missing node_modules after prior failed install reports failed', () => {
  const fsLike = probeFsLike({ files: ['package.json'] });
  assert.deepEqual(probeReusedInstall('per-worktree', '/wt', fsLike), {
    status: 'failed',
    reason: 'reuse-node-modules-missing',
  });
});

test('probeReusedInstall: node_modules without a completion marker reports failed', () => {
  const fsLike = probeFsLike({ files: ['package.json', 'node_modules'] });
  assert.deepEqual(probeReusedInstall('per-worktree', '/wt', fsLike), {
    status: 'failed',
    reason: 'reuse-install-incomplete',
  });
});

test('probeReusedInstall: completed install with a lockfile skips (reuse after success)', () => {
  const fsLike = probeFsLike({
    files: [
      'package.json',
      'node_modules',
      path.join('node_modules', '.package-lock.json'),
      'package-lock.json',
    ],
    contents: { 'package-lock.json': '{"lockfileVersion":3}' },
  });
  assert.deepEqual(probeReusedInstall('per-worktree', '/wt', fsLike), {
    status: 'skipped',
    reason: 'worktree-reused',
  });
});

test('probeReusedInstall: pnpm marker (.modules.yaml) counts as completed install', () => {
  const fsLike = probeFsLike({
    files: [
      'package.json',
      'node_modules',
      path.join('node_modules', '.modules.yaml'),
    ],
  });
  assert.deepEqual(probeReusedInstall('pnpm-store', '/wt', fsLike), {
    status: 'skipped',
    reason: 'worktree-reused',
  });
});

// ---- lockfileHash (Story #4249: byte-exact freshness key, never mtime) ----

test('lockfileHash: null when no lockfile is present', () => {
  assert.equal(lockfileHash('/wt', { existsSync: () => false }), null);
});

test('lockfileHash: identical lockfile bytes hash identically; a single byte change differs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const c = path.join(root, 'c');
  for (const d of [a, b, c]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(a, 'package-lock.json'), '{"v":1}');
  fs.writeFileSync(path.join(b, 'package-lock.json'), '{"v":1}');
  fs.writeFileSync(path.join(c, 'package-lock.json'), '{"v":2}');
  assert.equal(lockfileHash(a), lockfileHash(b));
  assert.notEqual(lockfileHash(a), lockfileHash(c));
});

// ---- isInstallSkippable (the single shared freshness predicate) ----

function skipFsLike({ files = [], contents = {} } = {}) {
  return {
    existsSync: (p) => files.some((f) => p.endsWith(f)),
    readFileSync: (p) => {
      const hit = Object.keys(contents).find((k) => p.endsWith(k));
      if (hit === undefined) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(contents[hit]);
    },
  };
}

test('isInstallSkippable: skips when marker present and lockfile byte-matches donor', () => {
  const fsLike = skipFsLike({
    files: [
      path.join('wt', 'node_modules'),
      path.join('wt', 'node_modules', '.package-lock.json'),
      path.join('wt', 'package-lock.json'),
      path.join('donor', 'package-lock.json'),
    ],
    contents: {
      [path.join('wt', 'package-lock.json')]: 'LOCK-A',
      [path.join('donor', 'package-lock.json')]: 'LOCK-A',
    },
  });
  assert.deepEqual(
    isInstallSkippable({ wtPath: '/wt', donorPath: '/donor', fsLike }),
    { skippable: true, reason: 'lockfile-match' },
  );
});

test('isInstallSkippable: forces install when worktree lockfile differs from donor', () => {
  const fsLike = skipFsLike({
    files: [
      path.join('wt', 'node_modules'),
      path.join('wt', 'node_modules', '.package-lock.json'),
      path.join('wt', 'package-lock.json'),
      path.join('donor', 'package-lock.json'),
    ],
    contents: {
      [path.join('wt', 'package-lock.json')]: 'LOCK-A',
      [path.join('donor', 'package-lock.json')]: 'LOCK-B',
    },
  });
  assert.deepEqual(
    isInstallSkippable({ wtPath: '/wt', donorPath: '/donor', fsLike }),
    { skippable: false, reason: 'lockfile-mismatch' },
  );
});

test('isInstallSkippable: forces install when node_modules is missing', () => {
  const fsLike = skipFsLike({ files: [] });
  assert.deepEqual(isInstallSkippable({ wtPath: '/wt', fsLike }), {
    skippable: false,
    reason: 'node-modules-missing',
  });
});

test('isInstallSkippable: forces install when the completion marker is absent', () => {
  const fsLike = skipFsLike({ files: [path.join('wt', 'node_modules')] });
  assert.deepEqual(isInstallSkippable({ wtPath: '/wt', fsLike }), {
    skippable: false,
    reason: 'install-incomplete',
  });
});

// ---- cloneNodeModules (copy-on-write clone with clean fall-back) ----
// The cp-driven cases are POSIX-only: on a real Windows host cloneNodeModules
// short-circuits to the per-worktree fallback BEFORE spawning cp (no reflink
// equivalent), so the clone/cp assertions are guarded with `{ skip }` on win32
// and the Windows behavior gets its own dedicated test below. The guard keys
// off the real `process.platform` because the capability branch in
// cloneNodeModules does too (ctx.platform is only a logging hint).
const POSIX_ONLY = { skip: process.platform === 'win32' };
const WIN_ONLY = { skip: process.platform !== 'win32' };

function cloneCtx({ repoRoot, platform = 'linux', primeFromPath } = {}) {
  return {
    repoRoot,
    platform,
    config: { nodeModulesStrategy: 'clone', primeFromPath },
    logger: quietLogger(),
  };
}

test(
  'cloneNodeModules: invokes cp reflink and reports cloned on success',
  POSIX_ONLY,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const wtPath = path.join(root, '.worktrees', 'story-1');
    fs.mkdirSync(wtPath, { recursive: true });
    const calls = [];
    const out = cloneNodeModules(cloneCtx({ repoRoot: root }), wtPath, {
      spawnFn: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0, stderr: '' };
      },
      fsLike: fs,
    });
    assert.deepEqual(out, { cloned: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'cp');
    // The CoW flag is host-OS specific: `-c` (clonefile) on darwin,
    // `--reflink=always` on linux. The capability branch keys off the real
    // `process.platform`, not the injected ctx.platform.
    const expectedFlag =
      process.platform === 'darwin' ? '-c' : '--reflink=always';
    assert.ok(
      calls[0].args.includes(expectedFlag),
      `expected cp args to include ${expectedFlag}, got ${calls[0].args.join(' ')}`,
    );
  },
);

test(
  'cloneNodeModules: falls back (no throw) on unsupported-fs / cross-volume cp failure',
  POSIX_ONLY,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const wtPath = path.join(root, '.worktrees', 'story-2');
    fs.mkdirSync(wtPath, { recursive: true });
    const out = cloneNodeModules(cloneCtx({ repoRoot: root }), wtPath, {
      spawnFn: () => ({ status: 1, stderr: 'cp: clone failed (unsupported)' }),
      fsLike: fs,
    });
    assert.deepEqual(out, { cloned: false, reason: 'clone-command-failed' });
  },
);

test(
  'cloneNodeModules: falls back when the donor has no node_modules',
  POSIX_ONLY,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    const wtPath = path.join(root, '.worktrees', 'story-3');
    fs.mkdirSync(wtPath, { recursive: true });
    let spawned = false;
    const out = cloneNodeModules(cloneCtx({ repoRoot: root }), wtPath, {
      spawnFn: () => {
        spawned = true;
        return { status: 0 };
      },
      fsLike: fs,
    });
    assert.deepEqual(out, {
      cloned: false,
      reason: 'donor-node-modules-missing',
    });
    assert.equal(spawned, false, 'cp must not run when the donor is unprimed');
  },
);

test(
  'cloneNodeModules: Windows short-circuits to per-worktree fallback without spawning cp',
  WIN_ONLY,
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const wtPath = path.join(root, '.worktrees', 'story-w');
    fs.mkdirSync(wtPath, { recursive: true });
    let spawned = false;
    const out = cloneNodeModules(cloneCtx({ repoRoot: root }), wtPath, {
      spawnFn: () => {
        spawned = true;
        return { status: 0 };
      },
      fsLike: fs,
    });
    assert.deepEqual(out, { cloned: false, reason: 'windows-unsupported' });
    assert.equal(spawned, false, 'cp must not run on Windows');
  },
);

test('applyNodeModulesStrategy: clone is wired through (no throw regardless of host)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  // No donor node_modules → clone falls back cleanly without throwing.
  assert.doesNotThrow(() =>
    applyNodeModulesStrategy(
      {
        config: { nodeModulesStrategy: 'clone' },
        platform: 'linux',
        logger: quietLogger(),
        repoRoot: root,
      },
      path.join(root, '.worktrees', 'story-9'),
    ),
  );
});

// ---- installDependencies: clone install-skip vs forced install ----

test('installDependencies: clone skips the install when lockfile matches donor + marker present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  // Donor (repoRoot) lockfile.
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'LOCK-A');
  // Worktree carries a matching lockfile + a completed-install marker.
  const wtPath = path.join(root, '.worktrees', 'story-10');
  const nm = path.join(wtPath, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(wtPath, 'package.json'), '{}');
  fs.writeFileSync(path.join(wtPath, 'package-lock.json'), 'LOCK-A');
  fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');

  const res = installDependencies(
    {
      config: { nodeModulesStrategy: 'clone' },
      platform: 'linux',
      logger: quietLogger(),
      repoRoot: root,
    },
    wtPath,
  );
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'clone-lockfile-match');
});

test('installDependencies: clone does NOT skip when worktree lockfile differs from donor (no package.json → install path reached, not clone-skip)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'DONOR-LOCK');
  // A worktree with no package.json short-circuits at selectInstallCommand
  // (returns null) BEFORE the clone skip-gate, so we instead prove the
  // mismatch decision at the predicate level (covered above by
  // `isInstallSkippable: forces install when worktree lockfile differs`).
  // Here we assert the clone skip-gate is byte-exact: a worktree whose marker
  // is present but whose lockfile mismatches the donor is NOT reported as a
  // clone-lockfile-match skip.
  const wtPath = path.join(root, '.worktrees', 'story-11');
  const nm = path.join(wtPath, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(wtPath, 'package-lock.json'), 'DIFFERENT-LOCK');
  fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');

  const skip = isInstallSkippable({
    wtPath,
    donorPath: root,
    fsLike: fs,
  });
  assert.deepEqual(skip, { skippable: false, reason: 'lockfile-mismatch' });
});
