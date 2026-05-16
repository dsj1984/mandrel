// tests/hook-chain-reflog-invariant.test.js
//
// Story #2014 — husky pre-commit / pre-push hook chain MUST NOT mutate
// the working tree's branch ref. The bug surfaced during Story #2011's
// execution where the local repo's HEAD reflog gained unexpected
// `checkout: moving from story-X to epic/Y` and `merge story-Z` entries
// around hook runs.
//
// This test file pins two layers of invariant:
//
//   1. **Unit guard** — every git surface reachable from the four hook
//      entry-point scripts (`quality-preview.js`, `check-baselines.js`,
//      `coverage-capture.js`) is stubbed at the spawn boundary and the
//      collected argv is asserted to contain only read-only git
//      subcommands. The mutating set is enumerated below; any addition
//      to that set MUST go through an explicit review.
//
//   2. **Reflog harness** — a throwaway git repo is initialised on a
//      feature branch, the actual hook scripts are spawned as child
//      processes with `cwd` pointed at the fixture, and the HEAD
//      reflog is compared before and after. Any `checkout: moving`
//      or `merge ` entry that appears during the run fails the test,
//      no matter which script wrote it.
//
// Both layers run on every CI invocation (Linux) and on the Windows
// dev host where the bug was originally observed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  __resetForTests as __resetGitBase,
  __setSpawnRunner,
  readBaseFromGit,
} from '../.agents/scripts/lib/baselines/git-base.js';
import { getChangedFiles } from '../.agents/scripts/lib/changed-files.js';
import { runCapture } from '../.agents/scripts/lib/coverage-capture.js';

// ---------------------------------------------------------------------------
// The mutating-subcommand set. Any first-arg in this list — when passed
// to `git` from a hook-reachable script — represents a regression of
// Story #2014. The list mirrors every git subcommand that can produce a
// `HEAD` reflog entry beyond the read-only surface the hooks actually
// need (`diff`, `show`, `rev-parse`, `merge-base --is-ancestor`).
// ---------------------------------------------------------------------------

const MUTATING_SUBCOMMANDS = Object.freeze([
  'checkout',
  'switch',
  'merge',
  'reset',
  'restore',
  'stash',
  'pull',
  'push',
  'commit',
  'cherry-pick',
  'rebase',
  'am',
  'apply',
]);

function assertSubcommandIsReadOnly(args, label) {
  const sub = args[0];
  assert.ok(
    !MUTATING_SUBCOMMANDS.includes(sub),
    `${label}: hook chain invoked mutating git subcommand "${sub}" (full argv: ${JSON.stringify(args)})`,
  );
}

// ---------------------------------------------------------------------------
// Unit guard — each hook-reachable git surface, with a stubbed spawn.
// ---------------------------------------------------------------------------

describe('hook chain unit guard: getChangedFiles (pre-commit + pre-push)', () => {
  it('invokes only `git diff` and never a mutating subcommand', () => {
    const calls = [];
    const mockGit = {
      gitSpawn: (_cwd, ...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    // quality-preview.js (pre-commit) calls getChangedFiles with --changed-since HEAD.
    getChangedFiles({ ref: 'HEAD', cwd: '/tmp/fake', git: mockGit });
    // coverage-capture.js (pre-push) calls it with --ref origin/main.
    getChangedFiles({ ref: 'origin/main', cwd: '/tmp/fake', git: mockGit });

    assert.equal(calls.length, 2);
    for (const args of calls) {
      assertSubcommandIsReadOnly(args, 'getChangedFiles');
      assert.equal(args[0], 'diff', 'getChangedFiles must use `git diff`');
    }
  });
});

describe('hook chain unit guard: readBaseFromGit (pre-push via check-baselines)', () => {
  afterEach(() => __resetGitBase());

  it('invokes only `git show` and never a mutating subcommand', () => {
    const calls = [];
    __setSpawnRunner({
      spawn: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: '{}', stderr: '' };
      },
    });

    // check-baselines drives this for every configured kind across the
    // pre-push gate. We exercise two kinds to cover the per-kind loop.
    readBaseFromGit('origin/main', 'baselines/maintainability.json');
    readBaseFromGit('origin/main', 'baselines/crap.json');

    assert.equal(calls.length, 2);
    for (const [cmd, ...args] of calls) {
      assert.equal(cmd, 'git');
      assertSubcommandIsReadOnly(args, 'readBaseFromGit');
      assert.equal(args[0], 'show', 'readBaseFromGit must use `git show`');
    }
  });
});

describe('hook chain unit guard: runCapture (pre-push, coverage capture)', () => {
  it('spawns npm, never git, when capturing coverage', () => {
    const calls = [];
    const mockRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    };
    runCapture({ cwd: '/tmp/fake', runner: mockRunner });
    assert.equal(calls.length, 1);
    const [cmd, ...args] = calls[0];
    assert.equal(cmd, 'npm', 'runCapture must spawn npm, not git');
    assert.deepEqual(args, ['run', 'test:coverage']);
  });
});

// ---------------------------------------------------------------------------
// Reflog harness — spawn the actual hook scripts against a real git fixture.
// ---------------------------------------------------------------------------

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

function gitInRepo(dir) {
  return (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
}

function makeHookFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hook-reflog-'));
  const run = gitInRepo(dir);
  run('init', '--initial-branch=main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  // Seed commit so HEAD resolves.
  writeFileSync(path.join(dir, 'README.md'), '# repro\n');
  run('add', 'README.md');
  run('commit', '-m', 'seed');
  // Feature branch where the hook chain runs — the bug manifested as a
  // surprise switch *away* from this branch.
  run('checkout', '-b', 'story-fixture');
  writeFileSync(path.join(dir, 'work.js'), 'export const noop = () => {};\n');
  run('add', 'work.js');
  run('commit', '-m', 'feat: add work module');
  return { dir, run };
}

function snapshotReflog(run) {
  // `%gs` is the reflog subject — the human-visible action verb
  // ("checkout: moving from ...", "commit: ...", "merge story-X: ...").
  const raw = run('reflog', 'show', '--format=%gs', 'HEAD');
  return raw.split('\n').filter((line) => line.length > 0);
}

function reflogDelta(before, after) {
  // Reflog grows at the *front* (newest first), so the new entries are
  // the prefix of `after` up to (but not including) `before[0]`.
  if (after.length <= before.length) return [];
  return after.slice(0, after.length - before.length);
}

function runHookScript(scriptRelPath, args, fixtureDir) {
  const absScript = path.join(repoRoot(), scriptRelPath);
  return spawnSync(process.execPath, [absScript, ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Strip GIT_* env vars so the parent test runner's hook env (if any)
    // can never leak in and pollute the fixture's HEAD.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    ),
  });
}

const FORBIDDEN_REFLOG_PATTERNS = [
  /^checkout: moving from .+ to .+$/,
  /^merge\b/,
  /^pull\b/,
  /^reset:\s+moving/,
];

function assertReflogClean(delta, label) {
  for (const entry of delta) {
    for (const pat of FORBIDDEN_REFLOG_PATTERNS) {
      assert.ok(
        !pat.test(entry),
        `${label}: forbidden HEAD reflog entry appeared: "${entry}" (delta: ${JSON.stringify(delta)})`,
      );
    }
  }
}

describe('hook chain reflog harness (pre-commit)', () => {
  let fixture;
  beforeEach(() => {
    fixture = makeHookFixture();
  });
  afterEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('quality-preview.js leaves HEAD reflog untouched', () => {
    const before = snapshotReflog(fixture.run);
    const headBefore = fixture.run('rev-parse', 'HEAD').trim();

    runHookScript(
      '.agents/scripts/quality-preview.js',
      ['--changed-since', 'HEAD', '--staged'],
      fixture.dir,
    );

    const after = snapshotReflog(fixture.run);
    const headAfter = fixture.run('rev-parse', 'HEAD').trim();
    assert.equal(headAfter, headBefore, 'quality-preview must not move HEAD');
    assertReflogClean(reflogDelta(before, after), 'quality-preview');
  });
});

describe('hook chain reflog harness (pre-push)', () => {
  let fixture;
  beforeEach(() => {
    fixture = makeHookFixture();
  });
  afterEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('check-baselines.js (--gate maintainability) leaves HEAD reflog untouched', () => {
    const before = snapshotReflog(fixture.run);
    const headBefore = fixture.run('rev-parse', 'HEAD').trim();

    runHookScript(
      '.agents/scripts/check-baselines.js',
      ['--gate', 'maintainability'],
      fixture.dir,
    );

    const after = snapshotReflog(fixture.run);
    const headAfter = fixture.run('rev-parse', 'HEAD').trim();
    assert.equal(headAfter, headBefore, 'check-baselines must not move HEAD');
    assertReflogClean(
      reflogDelta(before, after),
      'check-baselines maintainability',
    );
  });

  it('check-baselines.js (--gate crap) leaves HEAD reflog untouched', () => {
    const before = snapshotReflog(fixture.run);
    const headBefore = fixture.run('rev-parse', 'HEAD').trim();

    runHookScript(
      '.agents/scripts/check-baselines.js',
      ['--gate', 'crap'],
      fixture.dir,
    );

    const after = snapshotReflog(fixture.run);
    const headAfter = fixture.run('rev-parse', 'HEAD').trim();
    assert.equal(headAfter, headBefore, 'check-baselines must not move HEAD');
    assertReflogClean(reflogDelta(before, after), 'check-baselines crap');
  });

  it('coverage-capture.js (--skip-when-no-crap-files) leaves HEAD reflog untouched', () => {
    const before = snapshotReflog(fixture.run);
    const headBefore = fixture.run('rev-parse', 'HEAD').trim();

    runHookScript(
      '.agents/scripts/coverage-capture.js',
      ['--skip-when-no-crap-files', '--ref', 'main'],
      fixture.dir,
    );

    const after = snapshotReflog(fixture.run);
    const headAfter = fixture.run('rev-parse', 'HEAD').trim();
    assert.equal(headAfter, headBefore, 'coverage-capture must not move HEAD');
    assertReflogClean(reflogDelta(before, after), 'coverage-capture');
  });
});
