/**
 * post-rebase-reap.test.js — Story #1121 regression suite.
 *
 * Locks down the s-auto-reap-merge-base fix (Story #1121, parent of
 * Epic #1114) by reconstructing the exact post-rebase worktree shape that
 * produced five false-positive `unmerged-commits` reaps during Epic #1072.
 *
 * Two scenarios are exercised:
 *
 * 1. **Post-rebase, branch ref still ancestor.** A Story branch is rebased
 *    onto an Epic branch and merged with `--no-ff`. The branch ref still
 *    points at a commit reachable from the Epic, but the *content* of that
 *    commit differs from the original tip. Pre-fix, `isSafeToRemove`
 *    compared the local branch against the Epic and could read stale; the
 *    fix compares HEAD's SHA. Asserts `safe: true` with reason
 *    `head-reachable-from-epic`.
 *
 * 2. **Force-push variant.** After the merge, the Story branch is
 *    force-reset to a new commit that is *not* an ancestor of the Epic.
 *    The merge commit on the Epic still carries the
 *    `(resolves #<storyId>)` token from `merge-runner.js`, so the
 *    merge-commit fallback should still report the worktree as safe with
 *    reason `merge-commit-reachable`.
 *
 * Both tests use a freshly-init'd tmp git repo and run in well under 5s on
 * a typical developer machine (the Acceptance bar in #1131).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorktreeManager } from '../../../.agents/scripts/lib/worktree-manager.js';

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

// Strip GIT_* env vars so the tmp-repo cwd wins over a parent git invocation
// (matches the integration suite in worktree-manager.test.js).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function mkTmpRepo() {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rebase-')),
  );
  const run = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });
  run(tmp, 'init', '-b', 'main');
  run(tmp, 'config', 'user.email', 'test@example.com');
  run(tmp, 'config', 'user.name', 'Test');
  run(tmp, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
  run(tmp, 'add', '.');
  run(tmp, 'commit', '-m', 'init');
  return { tmp, run };
}

test('post-rebase scenario: HEAD reachable from epic after rebase + merge → safe', {
  timeout: 10_000,
}, async () => {
  const { tmp, run } = mkTmpRepo();
  const storyId = 1072;
  try {
    // Build epic branch with one commit ahead of main.
    run(tmp, 'branch', `epic/${storyId}`, 'main');
    run(tmp, 'checkout', `epic/${storyId}`);
    fs.writeFileSync(path.join(tmp, 'epic-base.txt'), 'epic base\n');
    run(tmp, 'add', '.');
    run(tmp, 'commit', '-m', 'epic: add base');

    // Create the worktree on a story branch off the epic tip.
    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      platform: process.platform,
    });
    const ensured = await wm.ensure(storyId, `story-${storyId}`);
    assert.equal(ensured.created, true);

    // Story commits work in the worktree.
    fs.writeFileSync(path.join(ensured.path, 'story.txt'), 'story v1\n');
    run(ensured.path, 'add', '.');
    run(ensured.path, 'commit', '-m', 'story: add feature');

    // Epic moves forward independently — sets up a non-trivial rebase.
    run(tmp, 'checkout', `epic/${storyId}`);
    fs.writeFileSync(path.join(tmp, 'epic-after.txt'), 'epic after\n');
    run(tmp, 'add', '.');
    run(tmp, 'commit', '-m', 'epic: advance');

    // Rebase the story branch onto the new epic tip — story HEAD now
    // points at a brand-new SHA whose tree includes both the epic
    // advance and the story content.
    run(ensured.path, 'rebase', `epic/${storyId}`);

    // Merge the rebased story into the epic with the same commit-message
    // shape that `merge-runner.js` produces (so the fallback grep would
    // still match if we exercised it).
    run(
      tmp,
      'merge',
      '--no-ff',
      `story-${storyId}`,
      '-m',
      `feat: post-rebase merge (resolves #${storyId})`,
    );

    // Pre-fix this could mis-classify because the branch ref equality
    // check could be brittle vs the merge commit. Post-fix:
    // `merge-base --is-ancestor HEAD epic` returns 0, so reason is
    // `head-reachable-from-epic`.
    const safety = await wm.isSafeToRemove(ensured.path, {
      epicRef: `epic/${storyId}`,
    });
    assert.equal(
      safety.safe,
      true,
      `expected safe; got reason=${safety.reason}`,
    );
    assert.equal(safety.reason, 'head-reachable-from-epic');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('force-push variant: HEAD diverges but merge commit on epic carries (resolves #<id>) → safe', {
  timeout: 10_000,
}, async () => {
  const { tmp, run } = mkTmpRepo();
  const storyId = 1072;
  try {
    run(tmp, 'branch', `epic/${storyId}`, 'main');

    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      platform: process.platform,
    });
    const ensured = await wm.ensure(storyId, `story-${storyId}`);
    assert.equal(ensured.created, true);

    // Story content + commit.
    fs.writeFileSync(path.join(ensured.path, 'story.txt'), 'story v1\n');
    run(ensured.path, 'add', '.');
    run(ensured.path, 'commit', '-m', 'story: feature');

    // Merge into epic with the resolves-token subject that the
    // merge-commit fallback grep keys off.
    run(tmp, 'checkout', `epic/${storyId}`);
    run(
      tmp,
      'merge',
      '--no-ff',
      `story-${storyId}`,
      '-m',
      `feat: integrate story (resolves #${storyId})`,
    );

    // Now force-rewrite the worktree's branch onto a *new* commit whose
    // history is unrelated to anything reachable from the epic. The
    // merge commit is still on the epic, but the worktree's HEAD is
    // not an ancestor of it. Pre-fix this returns `unmerged-commits`;
    // post-fix the merge-commit fallback grep finds the
    // `(resolves #<id>)` subject and reports
    // `merge-commit-reachable`.
    run(ensured.path, 'checkout', '--orphan', 'tmp-orphan');
    // node:fs.rmSync with force gracefully handles the README that the
    // orphan checkout leaves staged.
    fs.writeFileSync(path.join(ensured.path, 'orphan.txt'), 'rewrite\n');
    run(ensured.path, 'add', 'orphan.txt');
    run(ensured.path, 'commit', '-m', 'orphan: post-merge force-push');
    run(ensured.path, 'branch', '-f', `story-${storyId}`, 'HEAD');
    run(ensured.path, 'checkout', `story-${storyId}`);
    run(ensured.path, 'branch', '-D', 'tmp-orphan');

    const safety = await wm.isSafeToRemove(ensured.path, {
      epicRef: `epic/${storyId}`,
    });
    assert.equal(
      safety.safe,
      true,
      `expected safe via merge-commit fallback; got reason=${safety.reason}`,
    );
    assert.equal(safety.reason, 'merge-commit-reachable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
