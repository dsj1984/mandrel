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
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  _currentSuiteTempRoot,
  makeTempDir,
} from '../../.agents/scripts/lib/test-temp.js';

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

/** Attempts `copyGitRepo` makes before it gives up: the copy, then one retry. */
const COPY_ATTEMPTS = 2;

/**
 * Entries a `git init` repository must have for a copy of it to be usable.
 * `objects` is the one the #5272 incident reported missing, and `HEAD` is
 * what makes a directory a repository rather than a directory of objects.
 */
const REPO_MARKERS = ['HEAD', 'objects'];

/** Cause reported when a copy succeeded but produced no repository. */
const NOT_A_REPO = `copy completed but left no usable repository (expected ${REPO_MARKERS.map(
  (marker) => `.git/${marker}`,
).join(' and ')})`;

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
  const dir = makeTempDir(prefix);

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

/**
 * Copy an already-built fixture repository — **with no subprocess at all**.
 *
 * This is the lever for the suite's git budget (Story #5121). The costly
 * fixture shape is a multi-commit repo rebuilt in `beforeEach`: one
 * `run-epilogue-base` fixture is 13 `git` spawns, and six tests paid it six
 * times over. Building it once per file in `before()` and handing each test a
 * filesystem copy replaces every rebuild with an `fs.cpSync` — the repo is a
 * directory of files, and duplicating it needs no git at all.
 *
 * Safe because a `git init` repository is position-independent: its
 * `.git/config` holds no absolute paths (unlike a linked worktree, whose
 * `gitdir:`/`commondir` pointers would break — do not use this on one).
 *
 * Use it whenever a test would otherwise mutate a shared fixture; read-only
 * tests can share the pristine directory directly.
 *
 * ## Why the copy is verified and retried
 *
 * `cpSync` alone reports whatever `ENOENT` it hit — one interior path, no
 * side, no cause. Incident #5272 was a required check going red on an
 * unrelated PR with `ENOENT … /.git/objects` and nothing to attribute it
 * to. So the copy is checked for a usable repository before it is handed
 * back, retried once against a freshly-minted destination (which
 * re-creates a suite root that has gone missing), and only then reported —
 * naming both paths and which of them survive. The happy path is
 * unchanged and still spawns nothing.
 *
 * The retry is for a *destination* that vanished, which is the failure the
 * re-mint can actually repair. A missing **source** is not: copying it again
 * produces the same `ENOENT` from the same cause, and the second attempt only
 * mints a second orphan destination and doubles the latency of a failure
 * already certain. So a source that is gone short-circuits to the report.
 *
 * @param {string} srcDir - a repo built by `makeGitRepo` or a local `git init`.
 * @param {object} [opts]
 * @param {string} [opts.prefix] - Temp-dir name prefix for the copy.
 * @param {() => string} [opts.mintDest] - Destination factory, one call per
 *   attempt. Defaults to `makeTempDir(prefix)`; a test overrides it to put a
 *   real missing directory in the first attempt's way and a real one in the
 *   retry's, which is the only way to stage a *transient* failure from
 *   outside the helper.
 * @returns {string} Absolute path to the copy.
 */
export function copyGitRepo(
  srcDir,
  { prefix = 'git-fixture-copy-', mintDest = () => makeTempDir(prefix) } = {},
) {
  let dst = null;
  let cause = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      dst = mintDest();
      cpSync(srcDir, dst, { recursive: true });
      if (isUsableRepo(dst)) return dst;
      cause = NOT_A_REPO;
    } catch (err) {
      cause = err.message;
    }
    // Only a vanished destination is worth a second pass; see above.
    if (!existsSync(srcDir)) break;
  }
  throw new Error(describeCopyFailure(srcDir, dst, cause, attempts));
}

/**
 * Whether `dir` looks like a working copy of a `git init` repository —
 * checked without a subprocess, so the happy path stays spawn-free
 * (Story #5121).
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isUsableRepo(dir) {
  const gitDir = path.join(dir, '.git');
  return REPO_MARKERS.every((marker) => existsSync(path.join(gitDir, marker)));
}

/**
 * Render one path as evidence: where it is, and whether it is still there.
 *
 * @param {string} label
 * @param {string|null} target
 * @returns {string}
 */
function describePath(label, target) {
  if (!target) return `${label}: <never created>`;
  return `${label}: ${target} (${existsSync(target) ? 'exists' : 'MISSING'})`;
}

/**
 * Build the message a twice-failed copy raises.
 *
 * A bare `cpSync` reports `ENOENT … /.git/objects` and nothing else: the
 * failing side is unrecoverable from it, which is why incident #5272 was
 * filed against the source repo's git when the destination was what had
 * vanished. Naming all three paths and which survive makes the next report
 * diagnosable from its first line.
 *
 * The attempt count is reported rather than assumed: a missing source stops
 * after one pass, and a message claiming two would send the next reader
 * looking for a retry that never ran.
 *
 * @param {string} srcDir
 * @param {string|null} dstDir
 * @param {string|null} cause
 * @param {number} attempts
 * @returns {string}
 */
function describeCopyFailure(srcDir, dstDir, cause, attempts) {
  const times = attempts === 1 ? '1 time' : `${attempts} times`;
  return [
    `[git-fixture] copyGitRepo failed ${times}: ${cause}`,
    describePath('source', srcDir),
    describePath('destination', dstDir),
    describePath('suite root', _currentSuiteTempRoot()),
  ].join('\n  ');
}

/**
 * Resolve a repository's config file, following the `gitdir:` pointer a linked
 * worktree leaves in place of a `.git` directory and the `commondir` pointer
 * that worktree's gitdir leaves in place of a config file.
 *
 * @param {string} repoDir
 * @returns {string} absolute path to the repo's `config`
 */
function gitConfigPath(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m);
    gitDir = path.resolve(repoDir, pointer[1].trim());
  }
  const commonDir = path.join(gitDir, 'commondir');
  if (existsSync(commonDir)) {
    gitDir = path.resolve(gitDir, readFileSync(commonDir, 'utf-8').trim());
  }
  return path.join(gitDir, 'config');
}

/**
 * Give a fixture repository a committer identity **without a subprocess**.
 *
 * Every fixture that commits needs `user.email`, `user.name` and
 * `commit.gpgsign=false`, and the obvious way to set them is three
 * `git config` calls. Across the suite that was 108 `git config user.*`
 * spawns per `npm test` (Story #5111) — process creations whose entire
 * product is four lines of INI in a file this process can already write.
 * `git config` is not doing anything here that `appendFileSync` cannot:
 * these are fresh repos, the keys are new, and no merge or normalization is
 * involved.
 *
 * Signing is disabled explicitly because an operator with `commit.gpgsign`
 * true in their global config would otherwise have every fixture commit
 * block on a passphrase prompt.
 *
 * @param {string} repoDir - a repository created by `git init` or `git clone`.
 * @param {object} [opts]
 * @param {string} [opts.email]
 * @param {string} [opts.name]
 */
export function seedGitIdentity(
  repoDir,
  { email = 'test@example.com', name = 'Test' } = {},
) {
  appendFileSync(
    gitConfigPath(repoDir),
    `[user]\n\temail = ${email}\n\tname = ${name}\n[commit]\n\tgpgsign = false\n`,
  );
}
