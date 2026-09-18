// tests/lib/worktree/git-hooks-commit.integration.test.js
//
// The regression test for the defect itself: a commit made from a LINKED
// WORKTREE must be subject to commitlint.
//
// This drives real git, a real `git worktree add`, the repository's own
// `.husky/commit-msg`, and the real commitlint binary — because every cheaper
// proxy passes while the bug is present. Asserting that shim files were copied
// says nothing about whether git ever consults them; only running `git commit`
// in the worktree and reading its exit code does.
//
// The test is built around an explicit control: before materialization it
// asserts the over-long subject COMMITS SUCCESSFULLY, which is the bug. If a
// future change made hooks reachable some other way, that control fails and
// tells you the test is no longer exercising what it claims to.
//
// Slow (spawns git and npx repeatedly) — integration tier only.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { materializeGitHooks } from '../../../.agents/scripts/lib/worktree/git-hooks.js';
import { seedGitIdentity } from '../../fixtures/git-fixture.js';

/** This checkout — the source of the husky shims and the commitlint binary. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// Strip every GIT_* var so the fixture's cwd wins: when this suite itself runs
// under a git hook, the parent git exports GIT_DIR / GIT_INDEX_FILE, which
// override execFileSync's `cwd` and would silently retarget the fixture at the
// real repository. That failure mode is exactly what this Story makes possible
// by making hooks fire during delivery, so it is guarded here first.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const HOOK_ENV = {
  ...CLEAN_ENV,
  PATH: `${path.join(REPO_ROOT, 'node_modules', '.bin')}${path.delimiter}${CLEAN_ENV.PATH ?? ''}`,
};

/** A subject over commitlint's 100-character `header-max-length`. */
const OVERLONG_SUBJECT = `fix: ${'x'.repeat(110)}`;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: CLEAN_ENV,
  });
}

/** Attempt a commit, returning the raw result instead of throwing. */
function tryCommit(cwd, subject) {
  return spawnSync('git', ['commit', '--allow-empty', '-m', subject], {
    cwd,
    encoding: 'utf8',
    env: HOOK_ENV,
  });
}

function headSha(cwd) {
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

/**
 * A fixture repository shaped like this one: a relative `core.hooksPath`
 * pointing at husky's generated shim directory, which is present in the main
 * checkout and absent from the tracked tree.
 */
function seedFixture() {
  const tmp = fs.realpathSync.native(makeTempDir('hooks-commit-'));
  const main = path.join(tmp, 'main');
  fs.mkdirSync(main, { recursive: true });

  // `npx --no` refuses to run a binary it can only see on PATH, so the
  // fixture needs commitlint resolvable locally. It is linked at the fixture
  // ROOT, above both checkouts, so the main tree and the worktree each find
  // it by the ordinary upward walk.
  const bin = path.join(tmp, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(
    fs.realpathSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'commitlint')),
    path.join(bin, 'commitlint'),
  );

  git(main, 'init', '-b', 'main');
  seedGitIdentity(main);

  // Only `commit-msg` is seeded. `pre-commit` and `pre-push` invoke this
  // repository's own gate chain, which has nothing to say about a fixture.
  fs.mkdirSync(path.join(main, '.husky'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, '.husky', 'commit-msg'),
    path.join(main, '.husky', 'commit-msg'),
  );

  // The shim directory is synthesized rather than copied from this checkout.
  // Copying would make the test depend on the checkout it runs in being
  // provisioned — and it runs inside worktrees, which is the very thing that
  // is not. The two-level shape is husky's and is kept deliberately: it is
  // what proves a materialized worktree runs its OWN `.husky/<hook>` rather
  // than the source checkout's.
  const shim = path.join(main, '.husky', '_');
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(
    path.join(shim, 'h'),
    [
      '#!/usr/bin/env sh',
      'n=$(basename "$0")',
      's=$(dirname "$(dirname "$0")")/$n',
      '[ ! -f "$s" ] && exit 0',
      'export PATH="node_modules/.bin:$PATH"',
      'sh -e "$s" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(shim, 'commit-msg'),
    '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
    { mode: 0o755 },
  );
  // husky self-ignores its shim dir; mirroring that keeps it out of the
  // tracked tree, which is what makes it absent from a linked worktree.
  fs.writeFileSync(path.join(shim, '.gitignore'), '*\n');

  // Rules inline rather than `extends`, so the fixture needs no module
  // resolution of its own. 100 mirrors config-conventional's default, which is
  // the limit the two unvalidated Story #4936 commits broke.
  fs.writeFileSync(
    path.join(main, 'package.json'),
    `${JSON.stringify({ name: 'hooks-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(main, 'commitlint.config.mjs'),
    "export default { rules: { 'header-max-length': [2, 'always', 100] } };\n",
  );

  git(main, 'config', 'core.hooksPath', '.husky/_');
  git(
    main,
    'add',
    '.husky/commit-msg',
    'package.json',
    'commitlint.config.mjs',
  );
  git(main, 'commit', '-m', 'chore: seed fixture');

  const worktree = path.join(tmp, 'wt');
  git(main, 'worktree', 'add', '-b', 'story-test', worktree);
  return { main, worktree };
}

test('a commit made from a linked worktree is subject to commitlint', {
  skip: process.platform === 'win32' ? 'POSIX sh hook execution' : false,
}, () => {
  const { main, worktree } = seedFixture();

  // The hooks directory git resolves from inside the worktree is genuinely
  // absent — the mechanism of the bug, asserted rather than assumed.
  assert.equal(
    fs.existsSync(path.join(worktree, '.husky', '_')),
    false,
    'fixture precondition: the shim dir must not be in the tracked tree',
  );

  // CONTROL — the bug. Without materialization the over-long subject lands.
  const before = headSha(worktree);
  const unguarded = tryCommit(worktree, OVERLONG_SUBJECT);
  assert.equal(
    unguarded.status,
    0,
    `control failed: the unguarded commit should have succeeded, so this test is no longer proving hooks were the missing piece.\n${unguarded.stderr}`,
  );
  assert.notEqual(headSha(worktree), before, 'control: HEAD should have moved');
  git(worktree, 'reset', '--hard', before);

  // The fix.
  const result = materializeGitHooks({ repoRoot: main, worktree });
  assert.equal(result.action, 'materialized');

  // THE ASSERTION THIS STORY EXISTS FOR.
  const guarded = tryCommit(worktree, OVERLONG_SUBJECT);
  assert.notEqual(
    guarded.status,
    0,
    'an over-long subject committed from a linked worktree must be rejected',
  );
  const output = `${guarded.stdout}${guarded.stderr}`;
  assert.match(
    output,
    /header must not be longer than 100 characters|header-max-length/,
    `rejection must come from commitlint, got:\n${output}`,
  );
  assert.equal(
    headSha(worktree),
    before,
    'a rejected commit must leave no commit object behind',
  );

  // And the gate still passes what it should — a hook that rejects
  // everything would satisfy the assertion above while breaking delivery.
  const valid = tryCommit(worktree, 'fix: keep conventional subjects working');
  assert.equal(
    valid.status,
    0,
    `a conventional subject must still commit:\n${valid.stdout}${valid.stderr}`,
  );
  assert.notEqual(headSha(worktree), before);
});

test('the standalone CLI provisions an existing worktree and is idempotent', {
  skip: process.platform === 'win32' ? 'POSIX sh hook execution' : false,
}, () => {
  const { worktree } = seedFixture();
  const cli = path.join(REPO_ROOT, 'scripts', 'provision-git-hooks.js');

  // Addressed by explicit path from somewhere else entirely — the shape an
  // operator uses when the worktree is not their shell's cwd.
  const first = spawnSync('node', [cli, worktree], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: CLEAN_ENV,
  });
  assert.equal(first.status, 0, first.stderr);
  const digest = JSON.parse(first.stdout);
  assert.equal(digest.action, 'materialized');
  assert.ok(digest.hooks.includes('commit-msg'));

  // And again with no arguments from inside the worktree: the owning checkout
  // is derived from --git-common-dir, which is what makes this runnable in a
  // harness worktree the orchestrator never registered.
  const second = spawnSync('node', [cli], {
    cwd: worktree,
    encoding: 'utf8',
    env: CLEAN_ENV,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).action, 'materialized');

  const rejected = tryCommit(worktree, OVERLONG_SUBJECT);
  assert.notEqual(
    rejected.status,
    0,
    'the CLI-provisioned worktree must be gated too',
  );
});
