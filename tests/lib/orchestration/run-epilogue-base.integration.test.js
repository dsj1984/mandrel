// tests/lib/orchestration/run-epilogue-base.integration.test.js
//
// Real-git round-trip for the Story #4550 structural defect: the plan-run
// audit roster diffed `origin/main...HEAD` from a checkout whose HEAD *is*
// origin/main (or an ancestor of it), so the three-dot merge-base was HEAD
// and the changed-file set was empty by construction — never a race, and not
// fixable by reordering branch cleanup.
//
// These spawn real git processes against a tmp repo, so they are excluded
// from `test:quick` and run under `test:integration` / `npm test`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  resolveRunBaseSha,
  runPlanRunEpilogue,
} from '../../../.agents/scripts/lib/orchestration/run-epilogue.js';

// Strip every GIT_* env var so the tmpdir cwd wins even when this suite runs
// inside a git hook (husky exports GIT_DIR / GIT_WORK_TREE, which would
// otherwise override execFileSync's `cwd`).
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

function commitFile(repo, name, content, subject) {
  fs.writeFileSync(path.join(repo, name), content);
  run(repo, 'add', '.');
  run(repo, 'commit', '-m', subject);
}

/**
 * A provider stub that satisfies the epilogue's ticketing surface. Story
 * bodies are irrelevant to the audit-roster step under test.
 */
function stubProvider(comments) {
  return {
    getTicket: async (id) => ({
      id,
      title: `Story ${id}`,
      body: '',
      labels: [],
    }),
    getTicketComments: async () => [],
    postComment: async (ticketId, payload) => {
      comments.push({ ticketId, body: payload.body });
      return { commentId: comments.length };
    },
    deleteComment: async () => {},
  };
}

describe('run-epilogue combined landed diff (real git, Story #4550)', () => {
  let repo;
  /** The commit `main` pointed at before the run's first Story landed. */
  let preRunBase;

  beforeEach(() => {
    repo = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'run-epilogue-base-')),
    );
    run(repo, 'init', '-b', 'main');
    run(repo, 'config', 'user.email', 'test@example.com');
    run(repo, 'config', 'user.name', 'Test');

    commitFile(repo, 'README.md', 'root\n', 'chore: init');
    commitFile(
      repo,
      'pre-run.txt',
      'before the run\n',
      'chore: pre-run commit',
    );

    // This is the commit `main` pointed at before the run's Stories landed.
    preRunBase = run(repo, 'rev-parse', 'HEAD').trim();

    // The run's two Stories land as squash-merges. `normalizePrTitle` in the
    // close pipeline guarantees the `(#<storyId>)` suffix on the PR title,
    // and GitHub uses the PR title as the squash subject on main.
    commitFile(
      repo,
      'story-101.txt',
      'from 101\n',
      'fix(cli): first story of the run (#101) (#900)',
    );
    commitFile(
      repo,
      'story-102.txt',
      'from 102\n',
      'feat(core): second story of the run (#102) (#901)',
    );

    // A later, unrelated commit that merely *mentions* the Story ids in prose
    // — the earliest-merge walk must not be fooled into anchoring on it, and
    // the bare `#101` substring must not out-rank the `(#101)` marker.
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n');
    run(repo, 'add', '.');
    run(
      repo,
      'commit',
      '-m',
      'docs: follow-up',
      '-m',
      'Supersedes the analysis in #101 and #102.',
    );

    // Simulate the post-land main checkout: `origin/main` exists as a
    // remote-tracking ref and HEAD *equals* it. This is exactly the state in
    // which the old `origin/main...HEAD` diff returned zero files.
    run(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('pins the structural bug: `origin/main...HEAD` is empty where the real diff is not', () => {
    // The old implementation's exact range, at the real post-land state.
    const oldRange = execFileSync(
      'git',
      ['diff', '--name-only', 'origin/main...HEAD'],
      { cwd: repo, encoding: 'utf8', env: CLEAN_ENV },
    ).trim();
    assert.equal(
      oldRange,
      '',
      'the old origin/main...HEAD range must be empty — that IS the defect',
    );

    // The run demonstrably changed files, so an empty set is not the truth.
    const realDiff = execFileSync(
      'git',
      ['diff', '--name-only', `${preRunBase}...origin/main`],
      { cwd: repo, encoding: 'utf8', env: CLEAN_ENV },
    ).trim();
    assert.ok(
      realDiff.includes('story-101.txt') && realDiff.includes('story-102.txt'),
      'the run really did change files',
    );
  });

  it('resolves the pre-run base from the earliest landed merge of the run', () => {
    const base = resolveRunBaseSha({ stories: [101, 102], cwd: repo });
    assert.equal(base.resolved, true);
    assert.equal(base.baseSha, preRunBase);
    assert.equal(
      base.storyId,
      101,
      'earliest merge in the run belongs to #101',
    );
  });

  it('is order-independent — the run Story order does not move the base', () => {
    const base = resolveRunBaseSha({ stories: [102, 101], cwd: repo });
    assert.equal(base.resolved, true);
    assert.equal(base.baseSha, preRunBase);
  });

  it('reports the run real changed files with HEAD == origin/main (the regression)', async () => {
    const comments = [];
    const result = await runPlanRunEpilogue({
      planRunId: 'fixture-run',
      stories: [101, 102],
      provider: stubProvider(comments),
      config: {
        github: { owner: 'o', repo: 'r' },
        project: { baseBranch: 'main' },
      },
      cwd: repo,
    });

    const roster = result.results.find((r) => r.kind === 'audit-roster');
    assert.ok(roster, 'audit-roster step ran');
    assert.equal(roster.baseResolution.resolved, true);
    assert.equal(roster.baseResolution.baseSha, preRunBase);
    assert.deepEqual(
      [...roster.changedFiles].sort(),
      ['later.txt', 'story-101.txt', 'story-102.txt'],
      'the combined landed diff names the files the run actually changed',
    );
    assert.equal(roster.changedFileCount, 3);

    const body = comments.find((c) =>
      /plan-run-audit-roster/.test(c.body),
    )?.body;
    assert.ok(body, 'roster comment posted');
    assert.match(body, /Combined landed diff/);
    assert.match(body, /story-101\.txt/);
    assert.doesNotMatch(
      body,
      /Changed files considered: 0/,
      'the silent zero-file line must be gone',
    );
  });

  it('does not depend on the Story branches still existing', async () => {
    // Materialize and then reap the Story branches — the epilogue must be
    // indifferent (candidate strategy 3 in the Spec would break here).
    run(repo, 'branch', 'story-101', preRunBase);
    run(repo, 'branch', '-D', 'story-101');

    const result = await runPlanRunEpilogue({
      planRunId: 'fixture-run',
      stories: [101, 102],
      provider: stubProvider([]),
      config: { project: { baseBranch: 'main' } },
      cwd: repo,
    });
    const roster = result.results.find((r) => r.kind === 'audit-roster');
    assert.equal(roster.baseResolution.resolved, true);
    assert.ok(roster.changedFiles.includes('story-101.txt'));
  });

  it('reports an unresolvable base explicitly rather than a zero-file set', async () => {
    const comments = [];
    const result = await runPlanRunEpilogue({
      planRunId: 'fixture-run',
      // Story ids that never landed on this base ref.
      stories: [777, 778],
      provider: stubProvider(comments),
      config: { project: { baseBranch: 'main' } },
      cwd: repo,
    });

    const roster = result.results.find((r) => r.kind === 'audit-roster');
    assert.equal(roster.baseResolution.resolved, false);
    assert.match(roster.baseResolution.reason, /#777, #778/);
    assert.equal(
      roster.changedFileCount,
      null,
      'null — not 0 — so "could not compute" never reads as "nothing changed"',
    );
    assert.equal(roster.changedFiles, null);

    const body = comments.find((c) =>
      /plan-run-audit-roster/.test(c.body),
    )?.body;
    assert.match(body, /Combined landed diff unavailable/);
    assert.match(body, /NOT "zero files changed"/);
  });
});

// ---------------------------------------------------------------------------
// Real-history fixture: plan-run fbcec023 (Stories #4530, #4531).
//
// This run is the one the defect was reproduced on. Its commits are immutable
// history, so the expectations below are stable — `HEAD_AT_RUN_END` pins the
// base ref to what `origin/main` actually was when the epilogue fired, rather
// than to a moving `origin/main`.
// ---------------------------------------------------------------------------
describe('run-epilogue against real plan-run fbcec023 (Story #4550)', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
  /** `main` before the run's first Story (#4530) landed. */
  const PRE_RUN_BASE = 'c9491739';
  /** `main` after the run's last Story (#4531) landed — the epilogue's headRef. */
  const HEAD_AT_RUN_END = 'fe0c7ce3';

  function hasFixtureHistory() {
    try {
      execFileSync('git', ['cat-file', '-e', `${PRE_RUN_BASE}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: CLEAN_ENV,
      });
      return true;
    } catch {
      // Shallow clone — the fixture commits are not fetched. CI uses
      // fetch-depth: 0, so this only trips on a local shallow checkout.
      return false;
    }
  }

  it('derives the pre-run base c9491739 from the run stories, not from HEAD', {
    skip: hasFixtureHistory()
      ? false
      : 'shallow clone — fixture history absent',
  }, () => {
    const base = resolveRunBaseSha({
      stories: [4530, 4531],
      cwd: REPO_ROOT,
      baseRef: HEAD_AT_RUN_END,
    });
    assert.equal(base.resolved, true);
    assert.ok(
      base.baseSha.startsWith(PRE_RUN_BASE),
      `expected base ${PRE_RUN_BASE}, got ${base.baseSha}`,
    );
    assert.equal(base.storyId, 4530, '#4530 landed first in the run');

    // The run's real combined diff — 56 files, versus the 0 the old
    // `origin/main...HEAD` range reported when this epilogue actually ran.
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', `${base.baseSha}...${HEAD_AT_RUN_END}`],
      { cwd: REPO_ROOT, encoding: 'utf8', env: CLEAN_ENV },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(changed.length, 56, 'the 56 files the run really changed');
  });
});
