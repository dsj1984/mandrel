// tests/lib/worktree-manager.integration.test.js
//
// Real-git round-trip tests for WorktreeManager. These tests spawn real git
// processes against a tmp repo and take O(seconds); they are excluded from the
// `test:quick` TDD loop and run only under `test:integration` / `npm test`.
// The pure-mock unit suite lives in worktree-manager.test.js.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorktreeManager } from '../../.agents/scripts/lib/worktree-manager.js';

// Strip every GIT_* env var so the integration tests' tmpdir cwd wins.
// When this suite runs inside a git hook (e.g. husky pre-push) the parent
// git invocation exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / etc.
// that override execFileSync's `cwd`, breaking fixture isolation.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

// ─────────────────── Integration test (real git) ───────────────────

test('integration: round-trips worktree add and remove on a real repo', async () => {
  // Canonicalize via realpathSync.native so paths are in long-name form
  // before WorktreeManager registers them with git. On Windows GH Actions
  // os.tmpdir() can return the 8.3 short form (C:\Users\RUNNER~1\…); git
  // and Node may report the same directory differently downstream, which
  // breaks samePath()-based idempotence checks. The native realpath
  // variant calls Windows' GetFinalPathNameByHandle, which expands short
  // segments; the JS realpathSync does not.
  const tmp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wt-int-')),
  );
  const run = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });
  try {
    run(tmp, 'init', '-b', 'main');
    run(tmp, 'config', 'user.email', 'test@example.com');
    run(tmp, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
    run(tmp, 'add', '.');
    run(tmp, 'commit', '-m', 'init');

    const wm = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
      platform: process.platform,
    });

    const ensured = await wm.ensure(42, 'story-42');
    assert.equal(ensured.created, true);
    assert.ok(fs.existsSync(ensured.path));

    const again = await wm.ensure(42, 'story-42');
    assert.equal(again.created, false, 'ensure must be idempotent');

    const list = await wm.list();
    assert.ok(list.some((r) => r.branch === 'story-42'));

    // Main branch fully contains story-42 (no new commits on story-42 yet).
    const reaped = await wm.reap(42, { epicBranch: 'main' });
    assert.equal(reaped.removed, true, `reap failed: ${reaped.reason}`);
    assert.equal(fs.existsSync(ensured.path), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// v5.11.5 regression: `_findByPath` used case-sensitive `===` on paths, so
// when the caller handed WorktreeManager a repoRoot with a different drive-
// letter case than git's porcelain output (common on Windows when a shell
// cwd uses `c:\...` while git stored `C:\...`), reap returned
// `not-a-worktree` silently and the worktree was never cleaned up. The
// integration test below is skipped off-win32 because only Windows exposes
// drive letters.
test('integration: reap() tolerates drive-letter-case mismatch on repoRoot (v5.11.5 regression)', {
  skip: process.platform !== 'win32',
}, async () => {
  // Canonicalize via realpathSync.native so the baseline path is
  // long-name form. The test then deliberately flips the drive-letter
  // case below to exercise the v5.11.5 regression — that flip stays
  // load-bearing — but we want the *base* path consistent with what git
  // will report so the reap() drive-case path-comparison branch is the
  // only difference under test.
  const tmp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wt-case-')),
  );
  const run = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });
  try {
    run(tmp, 'init', '-b', 'main');
    run(tmp, 'config', 'user.email', 'test@example.com');
    run(tmp, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# test\n');
    run(tmp, 'add', '.');
    run(tmp, 'commit', '-m', 'init');

    // Create the worktree through a WorktreeManager whose repoRoot drive
    // letter matches git's native reporting (uppercase on Windows).
    const setup = new WorktreeManager({
      repoRoot: tmp,
      logger: SILENT_LOGGER,
    });
    const ensured = await setup.ensure(1337, 'story-1337');
    assert.equal(ensured.created, true);

    // Flip the drive letter on the repoRoot that close() will construct.
    // This mirrors a shell invoking story-close.js with `--cwd
    // c:\repo` while git still stores `C:\repo`.
    const driveLetter = tmp[0];
    const flipped =
      driveLetter === driveLetter.toUpperCase()
        ? driveLetter.toLowerCase() + tmp.slice(1)
        : driveLetter.toUpperCase() + tmp.slice(1);
    assert.notEqual(flipped, tmp, 'expected a different-case path');

    const wm = new WorktreeManager({
      repoRoot: flipped,
      logger: SILENT_LOGGER,
    });

    const reaped = await wm.reap(1337, { epicBranch: 'main' });
    assert.equal(
      reaped.removed,
      true,
      `reap returned ${reaped.reason} — drive-case mismatch regressed`,
    );
    assert.equal(fs.existsSync(ensured.path), false);

    const still = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: tmp,
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.ok(
      !/story-1337/.test(still),
      'worktree still registered after reap',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
