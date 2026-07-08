// tests/lib/orchestration/git-cleanup-content-merged.integration.test.js
//
// Real-git round-trip tests for the Story #4395 content-equivalence signal
// (`probeContentEquivalent` + `planCleanup`'s `content-merged` detection).
// These spawn real git processes against a tmp repo and take longer than
// the mocked unit suite in tests/scripts/git-cleanup.test.js; excluded from
// `test:quick`, run under `test:integration` / `npm test`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { planCleanup } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/branches.js';
import { probeContentEquivalent } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes.js';

// Strip every GIT_* env var so the tmpdir cwd wins even when this suite
// runs inside a git hook (husky pre-push exports GIT_DIR / GIT_WORK_TREE /
// etc that would otherwise override execFileSync's `cwd`).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function run(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: CLEAN_ENV,
  });
}

function writeFile(repo, name, content) {
  fs.writeFileSync(path.join(repo, name), content);
}

describe('probeContentEquivalent + planCleanup content-merged (real git, Story #4395)', () => {
  let repo;

  beforeEach(() => {
    repo = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'git-cleanup-cm-')),
    );
    run(repo, 'init', '-b', 'main');
    run(repo, 'config', 'user.email', 'test@example.com');
    run(repo, 'config', 'user.name', 'Test');
    writeFile(repo, 'README.md', 'root\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reports equivalent: true for a squash-orphaned branch', () => {
    // Branch off main, add a feature commit.
    run(repo, 'checkout', '-b', 'story-100');
    writeFile(repo, 'feature.txt', 'hello from story-100\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'feat: add feature.txt');

    // Simulate a squash-merged Epic PR: apply the same diff on main via a
    // brand-new commit (no ancestry link back to story-100's tip).
    run(repo, 'checkout', 'main');
    run(repo, 'merge', '--squash', 'story-100');
    run(repo, 'commit', '-m', 'feat: Epic (squash of story-100)');

    // story-100 is neither a git ancestor of main (squash breaks ancestry)
    // nor associated with any PR — exactly the silent-skip shape.
    const out = probeContentEquivalent({
      cwd: repo,
      base: 'main',
      branch: 'story-100',
    });
    assert.equal(out.supported, true);
    assert.equal(out.equivalent, true);
  });

  it('reports equivalent: false for a branch with genuinely unmerged content', () => {
    run(repo, 'checkout', '-b', 'story-101');
    writeFile(repo, 'unmerged.txt', 'never landed on main\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'feat: add unmerged.txt');
    run(repo, 'checkout', 'main');

    const out = probeContentEquivalent({
      cwd: repo,
      base: 'main',
      branch: 'story-101',
    });
    assert.equal(out.supported, true);
    assert.equal(out.equivalent, false);
  });

  it('returns supported: false (inconclusive) when the simulated merge conflicts', () => {
    // Diverge both main and the branch on the same line of the same file
    // from a common ancestor so `merge-tree --write-tree` cannot
    // auto-resolve.
    writeFile(repo, 'shared.txt', 'base\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'chore: add shared.txt');

    run(repo, 'checkout', '-b', 'story-102');
    writeFile(repo, 'shared.txt', 'branch-version\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'chore: branch edits shared.txt');

    run(repo, 'checkout', 'main');
    writeFile(repo, 'shared.txt', 'main-version\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'chore: main edits shared.txt');

    const out = probeContentEquivalent({
      cwd: repo,
      base: 'main',
      branch: 'story-102',
    });
    assert.equal(out.supported, false);
  });

  it('planCleanup classifies the squash-orphaned branch as content-merged end-to-end', () => {
    run(repo, 'checkout', '-b', 'story-200');
    writeFile(repo, 'feature.txt', 'hello from story-200\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'feat: add feature.txt');
    run(repo, 'checkout', 'main');
    run(repo, 'merge', '--squash', 'story-200');
    run(repo, 'commit', '-m', 'feat: Epic (squash of story-200)');

    const plan = planCleanup({
      cwd: repo,
      baseBranch: 'main',
      prProbe: () => null, // no gh access in this fixture
      refExistsFn: () => false, // no origin remote configured
    });

    const candidate = plan.candidates.find((c) => c.branch === 'story-200');
    assert.ok(candidate, 'story-200 should be a reap candidate');
    assert.equal(candidate.detectedBy, 'content-merged');
  });

  it('planCleanup leaves a genuinely-unmerged branch skipped as not-merged end-to-end', () => {
    run(repo, 'checkout', '-b', 'story-201');
    writeFile(repo, 'unmerged.txt', 'still needs review\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'feat: add unmerged.txt');
    run(repo, 'checkout', 'main');

    const plan = planCleanup({
      cwd: repo,
      baseBranch: 'main',
      prProbe: () => null,
      refExistsFn: () => false,
    });

    assert.equal(
      plan.candidates.find((c) => c.branch === 'story-201'),
      undefined,
    );
    const skip = plan.skipped.find((s) => s.branch === 'story-201');
    assert.equal(skip.reason, 'not-merged');
    assert.ok(
      skip.lastCommitAt,
      'not-merged skip should carry a commit timestamp',
    );
  });
});
