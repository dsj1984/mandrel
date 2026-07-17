// tests/fixtures/git-fixture.js
//
// Shared git-repo fixture for unit and integration tests.
//
// Provides a single `makeGitRepo()` helper that spins up a throwaway git
// repo with one committed file. Using `-c` flags on the `git commit`
// invocation avoids three separate `git config` round-trips, cutting
// fixture setup time meaningfully when dozens of test files share the helper.
//
// Usage:
//   import { makeGitRepo } from '../fixtures/git-fixture.js';
//   const dir = makeGitRepo();
//   // ... exercise the SUT against dir ...
//   rmSync(dir, { recursive: true, force: true });

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Env with every `GIT_*` variable dropped. When a test runs inside a git
 * hook (husky pre-push via coverage-capture), the parent git invocation
 * exports GIT_DIR — from a linked worktree, the shared
 * `<main>/.git/worktrees/<name>` path. A fixture `git init` under that env
 * re-initializes the shared gitdir and writes `core.bare=true` into the
 * MAIN checkout's `.git/config` (#4580). Scrub here so the fixture is safe
 * even when a single test file is run directly, bypassing the run-tests
 * wrapper's scrubbed env.
 */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

/**
 * Create a throwaway git repository in the OS temp directory with one
 * committed file (`baseline.json`) at HEAD.
 *
 * Optimizations over the naive pattern:
 *  - `git init -q -b main` — quiet flag suppresses the "Initialized…" noise;
 *    `-b main` sets the initial branch in one flag instead of a follow-up
 *    `git config init.defaultBranch` call.
 *  - Inline `-c` config flags on the `commit` invocation replace three
 *    separate `git config` round-trips (user.email, user.name,
 *    commit.gpgsign) with a single subprocess call.
 *
 * @param {object} [opts]
 * @param {string} [opts.prefix] - Temp-dir name prefix (default: 'git-fixture-').
 * @param {string} [opts.fileName] - File to create and commit (default: 'baseline.json').
 * @param {string} [opts.fileContent] - Content of the committed file
 *   (default: JSON `{ "floor": 40 }`).
 * @returns {string} Absolute path to the new repo directory.
 */
export function makeGitRepo({
  prefix = 'git-fixture-',
  fileName = 'baseline.json',
  fileContent = JSON.stringify({ floor: 40 }, null, 2),
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));

  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      env: CLEAN_ENV,
    });

  // -q suppresses "Initialized empty Git repository" noise.
  // -b main sets the initial branch without a follow-up config call.
  git('init', '-q', '-b', 'main');

  writeFileSync(path.join(dir, fileName), fileContent);
  git('add', fileName);

  // Inline -c flags avoid three separate `git config` subprocess round-trips.
  execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'seed',
    ],
    {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      env: CLEAN_ENV,
    },
  );

  return dir;
}
