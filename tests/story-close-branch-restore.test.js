/**
 * story-close-branch-restore.test.js
 *
 * Story #2138 / Task #2141 — finally-block branch restore on story-close
 * failure. Pins the safety contract of `captureStartingBranch` and
 * `restoreStartingBranch`: a throw inside `runStoryCloseLocked` from a
 * clean tree returns the main-repo HEAD to the captured starting branch;
 * the same throw from a dirty destination tree logs an error and does
 * NOT switch the branch. Neither path is allowed to use
 * `git reset --hard` or `git checkout --force`.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import {
  captureStartingBranch,
  restoreStartingBranch,
} from '../.agents/scripts/story-close.js';

/**
 * Build a `gitSpawn` test double that returns scripted responses keyed
 * by the joined argv. Records every invocation so tests can assert the
 * exact `git` commands the helpers issued (and, crucially, the commands
 * they did NOT issue — `reset --hard`, `checkout --force`).
 */
function makeGitSpawn(scripts) {
  const calls = [];
  function gitSpawn(_cwd, ...args) {
    calls.push(args.join(' '));
    const key = args.join(' ');
    const next = scripts[key];
    if (!next) {
      throw new Error(`unexpected gitSpawn(${key})`);
    }
    return typeof next === 'function' ? next() : next;
  }
  return { gitSpawn, calls };
}

function makeLogger() {
  const lines = { warn: [], error: [], info: [] };
  return {
    logger: {
      warn: (msg) => lines.warn.push(msg),
      error: (msg) => lines.error.push(msg),
      info: (msg) => lines.info.push(msg),
    },
    lines,
  };
}

test('captureStartingBranch returns branch name on success', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': { status: 0, stdout: 'main\n', stderr: '' },
  });
  const out = captureStartingBranch('/repo', { gitSpawn });
  assert.deepStrictEqual(out, { ok: true, branch: 'main' });
});

test('captureStartingBranch flags detached HEAD as unsafe', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': { status: 0, stdout: 'HEAD', stderr: '' },
  });
  const out = captureStartingBranch('/repo', { gitSpawn });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'detached-head');
});

test('captureStartingBranch surfaces a rev-parse failure', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': {
      status: 128,
      stdout: '',
      stderr: 'not a git repo',
    },
  });
  const out = captureStartingBranch('/repo', { gitSpawn });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /rev-parse-failed/);
});

test('restoreStartingBranch: clean tree → git switch runs and reports restored', () => {
  // Simulate a throw inside runStoryCloseLocked that left HEAD on
  // `epic/2129` (i.e. the failing merge attempt). The captured starting
  // branch was `main`, the tree is clean, and the switch should succeed.
  const { gitSpawn, calls } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': {
      status: 0,
      stdout: 'epic/2129',
      stderr: '',
    },
    'status --porcelain': { status: 0, stdout: '', stderr: '' },
    'switch main': { status: 0, stdout: '', stderr: '' },
  });
  const { logger } = makeLogger();
  const out = restoreStartingBranch(
    { cwd: '/repo', captured: { ok: true, branch: 'main' } },
    { gitSpawn, logger },
  );
  assert.deepStrictEqual(out, { restored: true, branch: 'main' });
  // The restore path is allowed to call rev-parse, status, and switch only.
  // Any reset/checkout would be a contract violation.
  assert.deepStrictEqual(calls, [
    'rev-parse --abbrev-ref HEAD',
    'status --porcelain',
    'switch main',
  ]);
  for (const cmd of calls) {
    assert.doesNotMatch(cmd, /reset --hard|checkout --force/);
  }
});

test('restoreStartingBranch: dirty tree → refuses to switch, logs an error', () => {
  // Same scenario as above but the destination tree carries uncommitted
  // edits. The helper must NOT issue `git switch` (or any forced variant)
  // — clobbering local work is explicitly out-of-scope for the restore.
  const { gitSpawn, calls } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': {
      status: 0,
      stdout: 'epic/2129',
      stderr: '',
    },
    'status --porcelain': {
      status: 0,
      stdout: ' M src/foo.js\n?? scratch.txt',
      stderr: '',
    },
  });
  const { logger, lines } = makeLogger();
  const out = restoreStartingBranch(
    { cwd: '/repo', captured: { ok: true, branch: 'main' } },
    { gitSpawn, logger },
  );
  assert.deepStrictEqual(out, {
    restored: false,
    branch: 'main',
    reason: 'dirty-tree',
  });
  // No `git switch` call was issued.
  assert.ok(!calls.some((c) => c.startsWith('switch')));
  // No forced/destructive variant either.
  for (const cmd of calls) {
    assert.doesNotMatch(cmd, /reset --hard|checkout --force|switch --force/);
  }
  // Operator gets a clear error message naming the branch they should
  // manually switch to.
  assert.ok(lines.error.length >= 1);
  assert.match(lines.error[0], /dirty/);
  assert.match(lines.error[0], /main/);
});

test('restoreStartingBranch: already on captured branch → no-op success', () => {
  // When the throw happened before any branch mutation, HEAD is already
  // on the captured starting branch. Skip the switch entirely so the
  // dirty-tree guard does not fire on legitimate post-close edits the
  // operator wants to keep.
  const { gitSpawn, calls } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': { status: 0, stdout: 'main', stderr: '' },
  });
  const { logger } = makeLogger();
  const out = restoreStartingBranch(
    { cwd: '/repo', captured: { ok: true, branch: 'main' } },
    { gitSpawn, logger },
  );
  assert.deepStrictEqual(out, {
    restored: true,
    branch: 'main',
    reason: 'already-on-branch',
  });
  assert.deepStrictEqual(calls, ['rev-parse --abbrev-ref HEAD']);
});

test('restoreStartingBranch: failed capture short-circuits with skipped', () => {
  // A detached-HEAD capture (or any other ok:false envelope) must not
  // attempt a switch — there is no branch name to restore to.
  const { gitSpawn, calls } = makeGitSpawn({});
  const out = restoreStartingBranch(
    {
      cwd: '/repo',
      captured: { ok: false, reason: 'detached-head' },
    },
    { gitSpawn },
  );
  assert.strictEqual(out.restored, false);
  assert.strictEqual(out.skipped, true);
  assert.match(out.reason, /no-starting-branch/);
  assert.deepStrictEqual(calls, []);
});

test('restoreStartingBranch: surfaces a switch failure without throwing', () => {
  const { gitSpawn } = makeGitSpawn({
    'rev-parse --abbrev-ref HEAD': {
      status: 0,
      stdout: 'epic/2129',
      stderr: '',
    },
    'status --porcelain': { status: 0, stdout: '', stderr: '' },
    'switch main': {
      status: 1,
      stdout: '',
      stderr: 'fatal: invalid reference',
    },
  });
  const { logger, lines } = makeLogger();
  const out = restoreStartingBranch(
    { cwd: '/repo', captured: { ok: true, branch: 'main' } },
    { gitSpawn, logger },
  );
  assert.strictEqual(out.restored, false);
  assert.strictEqual(out.branch, 'main');
  assert.match(out.reason, /switch-failed/);
  assert.ok(lines.warn.length >= 1);
});
