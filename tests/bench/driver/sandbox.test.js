// tests/bench/driver/sandbox.test.js
/**
 * Unit tests for bench/driver/sandbox.js — Story #4216.
 *
 * Verifies the ephemeral sandbox lifecycle:
 *   - provision clones the configured repo into a fresh temp workspace,
 *   - the control arm strips the materialized `.agents/` bundle,
 *   - teardown removes ONLY the ephemeral workspace,
 *   - the path-containment guard refuses to delete anything outside the
 *     ephemeral root (the strict-scoping safety contract),
 *   - withSandbox guarantees teardown even when the body throws.
 *
 * Every filesystem and git effect is INJECTED — no real clone, no real rm.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  assertInsideRoot,
  provisionSandbox,
  SANDBOX_DIR_PREFIX,
  teardownSandbox,
  withSandbox,
} from '../../../bench/driver/sandbox.js';

const ROOT = path.resolve('/tmp/ephemeral-root');

/**
 * Build an injected dep bundle with recording fakes. By default the workspace
 * is created under ROOT and every path "exists".
 */
function fakes(opts = {}) {
  const execCalls = [];
  const rmCalls = [];
  const existing = new Set(opts.existing ?? []);
  const created =
    opts.workspacePath ?? path.join(ROOT, `${SANDBOX_DIR_PREFIX}abc123`);

  const deps = {
    execFileFn: (cmd, args) => {
      execCalls.push({ cmd, args });
      if (opts.cloneThrows) {
        throw new Error('fatal: clone failed');
      }
      return '';
    },
    mkdtempFn: (prefixArg) => {
      // Real mkdtemp appends random chars; our fake returns a fixed path but
      // asserts the caller passed the expected <root>/<prefix> argument.
      assert.ok(prefixArg.startsWith(path.join(ROOT, SANDBOX_DIR_PREFIX)));
      return created;
    },
    existsFn: (p) => existing.has(path.resolve(p)),
    rmFn: (p, o) => {
      rmCalls.push({ path: path.resolve(p), opts: o });
    },
    statFn: () => ({ isDirectory: () => !opts.notADir }),
    logger: { info() {}, warn() {} },
  };
  return { deps, execCalls, rmCalls, created };
}

// ---------------------------------------------------------------------------
// assertInsideRoot — the load-bearing safety primitive
// ---------------------------------------------------------------------------

test('assertInsideRoot: accepts a proper descendant', () => {
  const ok = assertInsideRoot(ROOT, path.join(ROOT, 'ws-1'), 'ws');
  assert.equal(ok, path.join(ROOT, 'ws-1'));
});

test('assertInsideRoot: rejects the root itself', () => {
  assert.throws(() => assertInsideRoot(ROOT, ROOT, 'ws'), /resolves outside/);
});

test('assertInsideRoot: rejects ../ traversal escapes', () => {
  assert.throws(
    () => assertInsideRoot(ROOT, path.join(ROOT, '..', 'evil'), 'ws'),
    /resolves outside/,
  );
});

test('assertInsideRoot: rejects an absolute re-root to a real path', () => {
  assert.throws(
    () => assertInsideRoot(ROOT, '/Users/someone/real-repo', 'ws'),
    /resolves outside/,
  );
  assert.throws(() => assertInsideRoot(ROOT, '/', 'ws'), /resolves outside/);
});

test('assertInsideRoot: rejects empty root / target', () => {
  assert.throws(() => assertInsideRoot('', '/tmp/x', 'ws'), /non-empty root/);
  assert.throws(() => assertInsideRoot(ROOT, '', 'ws'), /non-empty target/);
});

// ---------------------------------------------------------------------------
// provisionSandbox
// ---------------------------------------------------------------------------

test('provisionSandbox: clones into a fresh temp workspace under the root', () => {
  const { deps, execCalls, created } = fakes();
  const handle = provisionSandbox(
    { repoUrl: 'https://github.com/acme/sandbox.git', ephemeralRoot: ROOT },
    deps,
  );

  assert.equal(handle.workspacePath, created);
  assert.equal(handle.ephemeralRoot, ROOT);
  assert.equal(handle.arm, 'mandrel');
  assert.equal(handle.agentsStripped, false);

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, 'git');
  assert.deepEqual(execCalls[0].args, [
    'clone',
    '--depth',
    '1',
    '--',
    'https://github.com/acme/sandbox.git',
    created,
  ]);
});

test('provisionSandbox: passes --branch when a ref is supplied', () => {
  const { deps, execCalls } = fakes();
  provisionSandbox(
    { repoUrl: 'u', ref: 'release/v2', ephemeralRoot: ROOT, depth: 3 },
    deps,
  );
  assert.deepEqual(execCalls[0].args.slice(0, 6), [
    'clone',
    '--depth',
    '3',
    '--branch',
    'release/v2',
    '--',
  ]);
});

test('provisionSandbox: control arm strips a present .agents/ bundle', () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}ctrl`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    existing: [path.join(created, '.agents')],
  });
  const handle = provisionSandbox(
    { repoUrl: 'u', arm: 'control', ephemeralRoot: ROOT },
    deps,
  );
  assert.equal(handle.arm, 'control');
  assert.equal(handle.agentsStripped, true);
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, path.join(created, '.agents'));
  assert.equal(rmCalls[0].opts.recursive, true);
});

test('provisionSandbox: control arm with no .agents/ present is a no-op strip', () => {
  const { deps, rmCalls } = fakes({ existing: [] });
  const handle = provisionSandbox(
    { repoUrl: 'u', arm: 'control', ephemeralRoot: ROOT },
    deps,
  );
  assert.equal(handle.agentsStripped, false);
  assert.equal(rmCalls.length, 0);
});

test('provisionSandbox: a failed clone cleans up the partial workspace and rethrows', () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}fail`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    cloneThrows: true,
    existing: [created], // the partial dir exists and must be swept
  });
  assert.throws(
    () => provisionSandbox({ repoUrl: 'u', ephemeralRoot: ROOT }, deps),
    /git clone failed/,
  );
  // Cleanup must target only the (contained) partial workspace.
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, created);
});

test('provisionSandbox: rejects empty repoUrl and bad arm', () => {
  const { deps } = fakes();
  assert.throws(
    () => provisionSandbox({ repoUrl: '', ephemeralRoot: ROOT }, deps),
    /non-empty repoUrl/,
  );
  assert.throws(
    () =>
      provisionSandbox(
        { repoUrl: 'u', arm: 'nope', ephemeralRoot: ROOT },
        deps,
      ),
    /must be "mandrel" or "control"/,
  );
});

// ---------------------------------------------------------------------------
// teardownSandbox — strict-scoping safety
// ---------------------------------------------------------------------------

test('teardownSandbox: removes the workspace when it is inside the root', () => {
  const ws = path.join(ROOT, `${SANDBOX_DIR_PREFIX}live`);
  const { deps, rmCalls } = fakes({ existing: [ws] });
  const res = teardownSandbox({ workspacePath: ws, ephemeralRoot: ROOT }, deps);
  assert.equal(res.removed, true);
  assert.equal(res.workspacePath, ws);
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, ws);
  assert.equal(rmCalls[0].opts.recursive, true);
});

test('teardownSandbox: REFUSES to remove a path outside the ephemeral root', () => {
  const { deps, rmCalls } = fakes({ existing: ['/Users/me/real-mandrel'] });
  assert.throws(
    () =>
      teardownSandbox(
        { workspacePath: '/Users/me/real-mandrel', ephemeralRoot: ROOT },
        deps,
      ),
    /resolves outside the ephemeral sandbox root/,
  );
  // Critically: nothing was deleted.
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: REFUSES when workspace equals the root (would nuke the root)', () => {
  const { deps, rmCalls } = fakes({ existing: [ROOT] });
  assert.throws(
    () => teardownSandbox({ workspacePath: ROOT, ephemeralRoot: ROOT }, deps),
    /resolves outside/,
  );
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: REFUSES a ../ escape even if the path "exists"', () => {
  const escapePath = path.join(ROOT, '..', '..', 'etc');
  const { deps, rmCalls } = fakes({ existing: [path.resolve(escapePath)] });
  assert.throws(
    () =>
      teardownSandbox({ workspacePath: escapePath, ephemeralRoot: ROOT }, deps),
    /resolves outside/,
  );
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: no-op when the workspace is already gone', () => {
  const ws = path.join(ROOT, `${SANDBOX_DIR_PREFIX}gone`);
  const { deps, rmCalls } = fakes({ existing: [] });
  const res = teardownSandbox({ workspacePath: ws, ephemeralRoot: ROOT }, deps);
  assert.equal(res.removed, false);
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: refuses to remove a non-directory target', () => {
  const ws = path.join(ROOT, `${SANDBOX_DIR_PREFIX}file`);
  const { deps, rmCalls } = fakes({ existing: [ws], notADir: true });
  assert.throws(
    () => teardownSandbox({ workspacePath: ws, ephemeralRoot: ROOT }, deps),
    /not a directory/,
  );
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: rejects a malformed handle', () => {
  assert.throws(() => teardownSandbox(null, {}), /requires a sandbox handle/);
  assert.throws(
    () => teardownSandbox({ ephemeralRoot: ROOT }, {}),
    /requires workspacePath/,
  );
  assert.throws(
    () => teardownSandbox({ workspacePath: '/tmp/x' }, {}),
    /requires ephemeralRoot/,
  );
});

// ---------------------------------------------------------------------------
// withSandbox — teardown is guaranteed
// ---------------------------------------------------------------------------

test('withSandbox: runs the body then tears down', async () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}with`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    existing: [created],
  });
  let sawHandle = null;
  const result = await withSandbox(
    { repoUrl: 'u', ephemeralRoot: ROOT },
    (handle) => {
      sawHandle = handle;
      return 'body-result';
    },
    { provision: deps, teardown: deps },
  );
  assert.equal(result, 'body-result');
  assert.equal(sawHandle.workspacePath, created);
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, created);
});

test('withSandbox: tears down even when the body throws', async () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}boom`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    existing: [created],
  });
  await assert.rejects(
    withSandbox(
      { repoUrl: 'u', ephemeralRoot: ROOT },
      () => {
        throw new Error('body exploded');
      },
      { provision: deps, teardown: deps },
    ),
    /body exploded/,
  );
  // Teardown still happened.
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, created);
});
