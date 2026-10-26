/**
 * Story #5909 — a Story-scope review grounds claims and enumerates its diff
 * in the reviewed repository, not the process cwd. Every case runs from this
 * checkout against a separate temporary repository whose commits this
 * checkout cannot resolve.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';
import { computeStoryScopeReview } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/code-review.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const PATH_CLAIM = 'db/0398.sql';

function git(cwd, ...args) {
  const out = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}

/** A repository whose `origin/main` is a base commit and whose head adds `PATH_CLAIM`. */
function reviewedRepo() {
  const dir = makeTempDir('review-cwd-');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(path.join(dir, 'db'));
  writeFileSync(path.join(dir, PATH_CLAIM), 'select 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'add migration');
  return { dir, headSha: git(dir, 'rev-parse', 'HEAD') };
}

const pathAbsentCritical = () => ({
  severity: 'critical',
  title: 'Migration missing',
  body: 'b',
  file: PATH_CLAIM,
  claim: { kind: 'path-absent', path: PATH_CLAIM },
});

/** Stubs every non-git seam of `runCodeReview`; git runs for real. */
function reviewSeams(findings) {
  return {
    reviewProvider: { runReview: async () => findings },
    resolveConfigFn: () => ({
      project: { baseBranch: 'main' },
      delivery: { codeReview: null },
    }),
    upsertCommentFn: async () => ({ commentId: 1 }),
    renderFindingsFn: () => 'report',
  };
}

test('the close compute path grounds a path-absent claim in the reviewed repository', async () => {
  const { dir, headSha } = reviewedRepo();
  const { result } = await computeStoryScopeReview({
    cwd: dir,
    storyId: 5909,
    headRef: headSha,
    baseBranch: 'main',
    deferPost: true,
    provider: null,
    runCodeReviewFn: (opts) =>
      runCodeReview({ ...opts, ...reviewSeams([pathAbsentCritical()]) }),
    progress: () => {},
  });
  assert.deepEqual(result.changeSet.files, [PATH_CLAIM]);
  assert.equal(result.findings[0].severity, 'suggestion');
  assert.equal(
    result.findings[0].ungrounded,
    `git cat-file found ${PATH_CLAIM}`,
  );
  assert.equal(result.halted, false);
  assert.equal(result.degraded, false);
});

test('a head this repository cannot resolve keeps the critical and records a degradation', async () => {
  const { dir } = reviewedRepo();
  const foreignHead = git(process.cwd(), 'rev-parse', 'HEAD');
  const out = await runCodeReview({
    ticketId: 5909,
    cwd: dir,
    headRef: foreignHead,
    provider: {},
    changedFiles: [],
    deferPost: true,
    ...reviewSeams([pathAbsentCritical()]),
  });
  assert.equal(out.findings[0].severity, 'critical');
  assert.equal(out.halted, true);
  assert.equal(out.degraded, true);
  assert.deepEqual(
    out.degradations.filter((d) => d.gate === 'claim-grounding'),
    [
      {
        tool: 'claim-grounding',
        gate: 'claim-grounding',
        surface: 'head-ref',
        reason: `head ${foreignHead} not resolvable in ${dir}`,
      },
    ],
  );
});

test('a cwd outside any repository records the same degradation', async () => {
  const dir = makeTempDir('review-cwd-bare-');
  const out = await runCodeReview({
    ticketId: 5909,
    cwd: dir,
    headRef: 'HEAD',
    provider: {},
    changedFiles: [],
    deferPost: true,
    ...reviewSeams([pathAbsentCritical()]),
  });
  assert.equal(out.halted, true);
  assert.match(
    out.degradations.map((d) => d.reason).join('\n'),
    new RegExp(
      `head HEAD not resolvable in ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
});
