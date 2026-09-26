// tests/scripts/story-review-compute.test.js
//
// Story #5480 — the worker computes the Story-scope review at push time and
// deposits it, keyed on the diff digest, for close to adopt. The CLI posts
// nothing, takes no full-suite lock, and exits 0 whatever the findings; it
// fails only on a provider throw.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { storyReviewDepositPath } from '../../.agents/scripts/lib/config/temp-paths.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  computeStoryReviewDeposit,
  parseArgv,
  runStoryReviewComputeCli,
} from '../../.agents/scripts/story-review-compute.js';

/** The deposit as close reads it off disk, or `null` when absent. */
function readReviewDeposit(storyId, { config }) {
  try {
    return JSON.parse(
      readFileSync(storyReviewDepositPath(storyId, config), 'utf8'),
    );
  } catch {
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'story-review-compute.js',
);

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const DIFF = 'diff --git a/a.js b/a.js\n+const a = 1;';
const CLEAN = { critical: 0, high: 0, medium: 0, suggestion: 0 };

let tempRoot;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-story-review-compute-');
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const configFor = () => ({
  project: { baseBranch: 'main', paths: { tempRoot } },
});

/** Answers the branch + base probes and the diff; records every call. */
function gitStub({ branchSha = HEAD_SHA, diff = DIFF } = {}) {
  const calls = [];
  const fn = (_cwd, ...args) => {
    calls.push(args);
    const miss = { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'diff') {
      return diff === null ? miss : { status: 0, stdout: diff, stderr: '' };
    }
    if (args[0] !== 'rev-parse') return miss;
    const ref = `${args.at(-1)}`;
    if (ref.startsWith('origin/')) {
      return { status: 0, stdout: 'feedface\n', stderr: '' };
    }
    return branchSha
      ? { status: 0, stdout: `${branchSha}\n`, stderr: '' }
      : miss;
  };
  fn.calls = calls;
  return fn;
}

function reviewDouble({ severity = CLEAN } = {}) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return {
      status: 'ok',
      severity,
      findings:
        severity.critical > 0
          ? [{ severity: 'critical', title: 'Null deref', body: 'boom' }]
          : [],
      providerName: 'chain[native,code-review]',
      report: `report for ${opts.headRef}`,
      posted: false,
      postedCommentId: null,
      commentTargetId: opts.ticketId,
      halted: severity.critical > 0,
      criticalByProvider:
        severity.critical > 0 ? { 'code-review': severity.critical } : {},
      degraded: true,
      degradations: [{ gate: 'lint', reason: 'skipped' }],
      blockerReason: null,
    };
  };
  fn.calls = calls;
  return fn;
}

describe('parseArgv', () => {
  test('reads --story as a positive integer and an optional --cwd', () => {
    assert.deepEqual(parseArgv(['--story', '5480', '--cwd', '/w']), {
      storyId: 5480,
      cwd: '/w',
    });
    assert.deepEqual(parseArgv(['--story', 'x']), { storyId: null, cwd: null });
  });
});

describe('computeStoryReviewDeposit', () => {
  test('writes the held review keyed on the diff digest, posting nothing (AC-1)', async () => {
    const config = configFor();
    const gitSpawnFn = gitStub();
    const runCodeReviewFn = reviewDouble();
    const outcome = await computeStoryReviewDeposit(
      { storyId: 5480, cwd: '/work', config },
      { gitSpawnFn, runCodeReviewFn, nowIso: () => '2026-09-26T00:00:00Z' },
    );
    assert.equal(outcome.written, true);
    assert.equal(outcome.path, storyReviewDepositPath(5480, config));

    const [opts] = runCodeReviewFn.calls;
    assert.equal(opts.deferPost, true, 'computes without posting');
    assert.equal(opts.headRef, HEAD_SHA, 'reviews the pinned SHA');
    assert.equal(opts.baseRef, 'origin/main');
    assert.equal(opts.commentTargetId, undefined, 'no post target');

    const deposit = JSON.parse(readFileSync(outcome.path, 'utf8'));
    assert.equal(deposit.storyId, 5480);
    assert.equal(deposit.headSha, HEAD_SHA);
    assert.equal(
      deposit.diffDigest,
      createHash('sha256').update(DIFF, 'utf8').digest('hex'),
    );
    assert.deepEqual(deposit.severity, CLEAN);
    assert.deepEqual(deposit.findings, []);
    assert.equal(deposit.report, `report for ${HEAD_SHA}`);
    assert.equal(deposit.provider, 'chain[native,code-review]');
    assert.deepEqual(deposit.degradations, [
      { gate: 'lint', reason: 'skipped' },
    ]);
    assert.equal(deposit.createdAt, '2026-09-26T00:00:00Z');
    assert.deepEqual(readReviewDeposit(5480, { config }), deposit);

    // The digest is of the exact diff the provider spawns.
    const diffCall = gitSpawnFn.calls.find((a) => a[0] === 'diff');
    assert.deepEqual(diffCall, [
      'diff',
      '--no-color',
      `origin/main...${HEAD_SHA}`,
    ]);
  });

  test('an unresolvable branch or unreadable diff writes nothing and runs no review', async () => {
    const config = configFor();
    for (const git of [gitStub({ branchSha: null }), gitStub({ diff: null })]) {
      const runCodeReviewFn = reviewDouble();
      const outcome = await computeStoryReviewDeposit(
        { storyId: 5480, cwd: '/work', config },
        { gitSpawnFn: git, runCodeReviewFn },
      );
      assert.equal(outcome.written, false);
      assert.equal(runCodeReviewFn.calls.length, 0);
    }
    assert.equal(readReviewDeposit(5480, { config }), null);
  });
});

describe('runStoryReviewComputeCli', () => {
  test('a CRITICAL is reported, deposited, and never fails the run (AC-1)', async () => {
    const config = configFor();
    let out = '';
    const outcome = await runStoryReviewComputeCli(
      ['--story', '5480', '--cwd', '/work'],
      {
        resolveConfigImpl: () => config,
        stdout: { write: (s) => (out += s) },
        gitSpawnFn: gitStub(),
        runCodeReviewFn: reviewDouble({ severity: { ...CLEAN, critical: 1 } }),
      },
    );
    assert.equal(outcome.written, true);
    assert.equal(outcome.deposit.halted, true);
    assert.match(out, /critical=1/);
    assert.match(out, /CRITICAL: fix, commit and re-push/);
    assert.equal(readReviewDeposit(5480, { config }).severity.critical, 1);
  });

  test('a provider throw rejects — the only non-zero path', async () => {
    await assert.rejects(
      runStoryReviewComputeCli(['--story', '5480'], {
        resolveConfigImpl: configFor,
        stdout: { write: () => {} },
        gitSpawnFn: gitStub(),
        runCodeReviewFn: async () => {
          throw new Error('provider exploded');
        },
      }),
      /provider exploded/,
    );
  });

  test('a missing --story is a usage error', async () => {
    await assert.rejects(
      runStoryReviewComputeCli([], { stdout: { write: () => {} } }),
      /--story <id> is required/,
    );
  });
});

describe('CLI surface (AC-7)', () => {
  test('--help prints the usage block and does no work', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /story-review-compute\.js --story <id>/);
    assert.match(res.stdout, /--cwd <path>/);
  });

  test('the CLI takes no full-suite lock', () => {
    const source = readFileSync(CLI, 'utf8');
    assert.doesNotMatch(source, /full-suite-lock/);
  });
});
