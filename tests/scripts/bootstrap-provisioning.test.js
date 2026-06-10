/**
 * bootstrap-provisioning.test — Story #3690.
 *
 * Exercises the cold-start provisioning phase (`provisionResources`) and the
 * install-ledger recording phase (`recordLedger`) of the collapsed bootstrap
 * orchestrator through their network-free paths:
 *
 *   - local `git init` + initial commit on a blank folder (real git in a
 *     temp dir — the function's own I/O boundary; no remote ever contacted),
 *   - idempotent re-run on an already-initialized repo,
 *   - loud failure (`exit: 1`) when git initialization is impossible,
 *   - the `--skip-github` guard that suppresses repo/project creation,
 *   - the existing-remote early return (no `gh` spawned),
 *   - applied-group resolution for the install ledger, including the
 *     github-admin demotion on a failed/errored GitHub bootstrap.
 *
 * Every GitHub-touching branch (`gh repo create`, `gh project create`,
 * `gh project link`) is structurally unreachable in these fixtures: either
 * `--skip-github` is set, the origin remote already resolves, or the
 * project answer is blank.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  provisionResources,
  recordLedger,
} from '../../.agents/scripts/bootstrap.js';
import { LEDGER_RELATIVE_PATH } from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import { PHASE_GROUPS } from '../../.agents/scripts/lib/bootstrap/manifest.js';

const ANSWERS = Object.freeze({
  owner: 'acme',
  repo: 'widget',
  baseBranch: 'main',
  operatorHandle: 'octo',
  projectNumber: '',
});

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-prov-'));
  tmpDirs.push(dir);
  return dir;
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('provisionResources — local git provisioning (no network)', () => {
  it('initializes git with a first commit on a blank folder and honours --skip-github', async () => {
    const dir = makeTmpDir();
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: { 'skip-github': true },
      creation: { newRepo: true, newProject: true },
      answers: { ...ANSWERS },
    };
    const res = await provisionResources(state);
    assert.equal(res.ok, true);
    assert.equal(state.gitInitialized, true);
    // A real repo with a resolvable HEAD on the requested base branch.
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], dir).status, 0);
    assert.equal(git(['rev-parse', '--verify', 'HEAD'], dir).status, 0);
    assert.equal(git(['branch', '--show-current'], dir).stdout.trim(), 'main');
    // --skip-github: no remote was wired, nothing was created on GitHub.
    assert.notEqual(git(['remote', 'get-url', 'origin'], dir).status, 0);
  });

  it('is idempotent on an already-initialized repo with commits', async () => {
    const dir = makeTmpDir();
    // Arrange a real repo with one commit.
    await provisionResources({
      projectRoot: dir,
      gitInitialized: false,
      flags: { 'skip-github': true },
      creation: { newRepo: false, newProject: false },
      answers: { ...ANSWERS },
    });
    const headBefore = git(['rev-parse', 'HEAD'], dir).stdout.trim();
    // Act — re-run on the initialized repo.
    const res = await provisionResources({
      projectRoot: dir,
      gitInitialized: true,
      flags: { 'skip-github': true },
      creation: { newRepo: false, newProject: false },
      answers: { ...ANSWERS },
    });
    assert.equal(res.ok, true);
    // No second commit was created.
    assert.equal(git(['rev-parse', 'HEAD'], dir).stdout.trim(), headBefore);
  });

  it('halts with exit 1 when git initialization is impossible', async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'not-a-directory');
    fs.writeFileSync(filePath, 'plain file', 'utf8');
    const res = await provisionResources({
      projectRoot: filePath,
      gitInitialized: false,
      flags: { 'skip-github': true },
      creation: { newRepo: false, newProject: false },
      answers: { ...ANSWERS },
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });

  it('does NOT stage a pre-existing .env into the cold-start initial commit (Story #3894)', async () => {
    // Arrange — a cold-start folder that already carries secret-bearing files
    // BEFORE any .gitignore is seeded (gitignore seeding runs two phases later
    // in executeBootstrap, not in provisionResources).
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, '.env'),
      'GITHUB_TOKEN=ghp_supersecret\n',
      'utf8',
    );
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"servers":{}}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# real project\n', 'utf8');

    // Act — the cold-start provisioning phase (git init + initial commit).
    const res = await provisionResources({
      projectRoot: dir,
      gitInitialized: false,
      flags: { 'skip-github': true },
      creation: { newRepo: true, newProject: true },
      answers: { ...ANSWERS },
    });
    assert.equal(res.ok, true);

    // Assert — the initial commit is EMPTY: no tracked files at all, so the
    // immediately-following `gh repo create --push` cannot leak the secret.
    const tracked = git(['ls-files'], dir).stdout.trim();
    assert.equal(tracked, '', 'initial commit must track zero files');
    // The secret file is untracked (still present on disk, never committed).
    const status = git(['status', '--porcelain', '--', '.env'], dir).stdout;
    assert.match(status, /^\?\? \.env$/m);
    // HEAD resolves (the push has a commit to upload).
    assert.equal(git(['rev-parse', '--verify', 'HEAD'], dir).status, 0);
  });

  it('returns ok on an existing repo with a wired origin remote without spawning gh', async () => {
    const dir = makeTmpDir();
    await provisionResources({
      projectRoot: dir,
      gitInitialized: false,
      flags: { 'skip-github': true },
      creation: { newRepo: false, newProject: false },
      answers: { ...ANSWERS },
    });
    git(
      ['remote', 'add', 'origin', 'https://example.invalid/acme/widget.git'],
      dir,
    );
    // skip-github NOT set: the no-creation path must early-return at the
    // existing-remote check and the blank project answer — no gh call.
    const res = await provisionResources({
      projectRoot: dir,
      gitInitialized: true,
      flags: {},
      creation: { newRepo: false, newProject: false },
      answers: { ...ANSWERS },
    });
    assert.equal(res.ok, true);
    assert.equal(
      git(['remote', 'get-url', 'origin'], dir).stdout.trim(),
      'https://example.invalid/acme/widget.git',
    );
  });
});

describe('recordLedger — applied phase groups', () => {
  function ledgerState(dir, { flags = {}, github } = {}) {
    return {
      projectRoot: dir,
      flags,
      answers: { ...ANSWERS },
      approvedGroups: new Set(Object.values(PHASE_GROUPS)),
      report: github === undefined ? {} : { github },
    };
  }

  function readLedger(dir) {
    return JSON.parse(
      fs.readFileSync(path.join(dir, LEDGER_RELATIVE_PATH), 'utf8'),
    );
  }

  it('records every approved group when the GitHub bootstrap succeeded', () => {
    const dir = makeTmpDir();
    const state = ledgerState(dir, {
      github: {
        branchProtection: { status: 'configured' },
        mergeMethods: { status: 'configured' },
      },
    });
    const res = recordLedger(state);
    assert.equal(res.ok, true);
    assert.equal(state.report.ledger.written, true);
    assert.ok(
      state.report.ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
    );
    assert.ok(fs.existsSync(path.join(dir, LEDGER_RELATIVE_PATH)));
    assert.ok(readLedger(dir));
  });

  it('drops the github-admin group when the GitHub bootstrap errored', () => {
    const dir = makeTmpDir();
    const state = ledgerState(dir, { github: { error: 'gh exploded' } });
    recordLedger(state);
    assert.equal(state.report.ledger.written, true);
    assert.ok(
      !state.report.ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
    );
  });

  it('drops the github-admin group when a sub-mutation failed', () => {
    const dir = makeTmpDir();
    const state = ledgerState(dir, {
      github: {
        branchProtection: { status: 'failed' },
        mergeMethods: { status: 'configured' },
      },
    });
    recordLedger(state);
    assert.ok(
      !state.report.ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
    );
  });

  it('omits github-admin entries entirely under --skip-github', () => {
    const dir = makeTmpDir();
    const state = ledgerState(dir, { flags: { 'skip-github': true } });
    recordLedger(state);
    assert.equal(state.report.ledger.written, true);
    assert.ok(readLedger(dir));
    assert.ok(
      !state.report.ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
    );
  });
});
