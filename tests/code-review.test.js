// tests/code-review.test.js
//
// Unit tier (Story #3876, extended by #3938, re-based on the derived level by
// #4542): the review-depth lever in `code-review.js` is pure control flow.
// These tests pin:
//   1. The depth is resolved via the shared `resolveDepth` resolver from BOTH
//      signals `code-review.js` reads off the diff it already enumerates — the
//      changed files' sensitive-path intersection and their count — and
//      threaded into the review provider's `runReview` input (unremarkable+small
//      → light, sensitive → deep, unremarkable+wide → deep, unenumerable →
//      standard). No caller passes a risk envelope in: there is none.
//   2. The `{ status, severity, posted, report, halted, blockerReason }`
//      output envelope is byte-compatible with the pre-change shape regardless
//      of depth (depth is an input-only signal).
//   3. `severity.critical > 0` halts the run at every depth.
//
// `runReview`, the GitHub provider, and the git diff enumerator are mocked —
// this is pure logic, no I/O.

import assert from 'node:assert/strict';
import test from 'node:test';
import { runCodeReview } from '../.agents/scripts/lib/orchestration/code-review.js';
import { DEFAULT_DIFF_WIDTH } from '../.agents/scripts/lib/orchestration/review-depth.js';

// --- Test seams -----------------------------------------------------------

/** Minimal config resolver: native provider, default base branch. */
function fakeResolveConfig() {
  return { project: { baseBranch: 'main' }, delivery: { codeReview: null } };
}

/** A no-op structured-comment upserter returning a stable comment id. */
async function fakeUpsertComment() {
  return { commentId: 4242 };
}

/** A renderer that ignores findings and returns a fixed body. */
function fakeRenderFindings() {
  return '## Code Review\n\n(stub body)\n';
}

/**
 * A fake `gitSpawn` returning `n` changed files for the diff, so the depth
 * resolver sees a deterministic, injected width with no real git subprocess.
 */
function fakeGitSpawn(n) {
  const stdout = Array.from({ length: n }, (_, i) => `file-${i}.js`).join('\n');
  return () => ({ status: 0, stdout, stderr: '' });
}

/**
 * Build a `runCodeReview` opts bag with all I/O seams stubbed. `findings` is
 * the array the mocked provider returns; `captured` collects the `runReview`
 * input so tests can assert the threaded depth. `changedFiles` injects the diff
 * contents directly and `changedFileCount` the width (both bypassing the git
 * enumerator).
 */
function buildOpts({
  findings = [],
  captured = {},
  changedFiles,
  changedFileCount,
  gitSpawnFn,
} = {}) {
  return {
    ticketId: 100,
    headRef: 'story-100',
    provider: {},
    changedFiles,
    changedFileCount,
    gitSpawnFn,
    reviewProvider: {
      runReview: async (input) => {
        captured.input = input;
        return findings;
      },
    },
    resolveConfigFn: fakeResolveConfig,
    upsertCommentFn: fakeUpsertComment,
    renderFindingsFn: fakeRenderFindings,
  };
}

// --- Depth threaded into runReview input ----------------------------------

test('runCodeReview: threads a deep depth for a narrow diff on a sensitive path', async () => {
  // The case the derivation exists for: one file, but it is an auth file.
  const captured = {};
  const opts = buildOpts({
    captured,
    changedFiles: ['src/auth/session.js'],
    changedFileCount: 1,
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'deep');
});

test('runCodeReview: threads a deep depth for a wide diff touching nothing sensitive', async () => {
  const captured = {};
  const opts = buildOpts({
    captured,
    changedFiles: ['docs/a.md'],
    changedFileCount: DEFAULT_DIFF_WIDTH.hardFiles + 1,
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'deep');
});

test('runCodeReview: threads a light depth for a small diff touching nothing sensitive', async () => {
  const captured = {};
  const opts = buildOpts({
    captured,
    changedFiles: ['docs/a.md'],
    changedFileCount: DEFAULT_DIFF_WIDTH.softFiles,
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'light');
});

test('runCodeReview: an unenumerable diff threads standard, never light', async () => {
  // gitSpawn fails → no changed files and no width → the fail-safe tier.
  const captured = {};
  const opts = buildOpts({
    captured,
    gitSpawnFn: () => ({ status: 1, stdout: '', stderr: 'no such ref' }),
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'standard');
});

test('runCodeReview: enumerates the diff via the injected gitSpawn', async () => {
  // A 40-file diff (> hardFiles 30) of unremarkable paths, read through the git
  // enumerator, escalates to deep — proving both signals come from the diff.
  const captured = {};
  const opts = buildOpts({ captured, gitSpawnFn: fakeGitSpawn(40) });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'deep');
});

test('runCodeReview: an explicit null changedFiles threads standard without re-enumerating', async () => {
  // Story #4593 — `null` is the spine reporting "I already tried; the diff is
  // unenumerable". Re-running git here would only fail again, so the fail-safe
  // tier must be reached without a second enumeration.
  const captured = {};
  let enumerated = false;
  const opts = buildOpts({
    captured,
    changedFiles: null,
    gitSpawnFn: () => {
      enumerated = true;
      return { status: 0, stdout: 'src/auth/token.js', stderr: '' };
    },
  });
  await runCodeReview(opts);
  assert.equal(enumerated, false, 'an explicit null must not re-enumerate');
  assert.equal(captured.input.depth, 'standard');
});

test('runCodeReview: derives the sensitive-path level from the enumerated diff', async () => {
  // No changedFiles injected: the level must come from what git reports.
  const captured = {};
  const opts = buildOpts({
    captured,
    gitSpawnFn: () => ({
      status: 0,
      stdout: 'src/auth/token.js\nREADME.md\n',
      stderr: '',
    }),
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'deep');
});

// --- Byte-compatible output envelope --------------------------------------

test('runCodeReview: output envelope keys are byte-compatible across depths', async () => {
  // `degraded` / `degradations` were added deliberately by Story #4839 so the
  // close pipeline can tell "a gate ran and found nothing" from "a gate never
  // ran". The invariant this test guards is unchanged: the key set must be
  // identical across every depth, and `depth` must never leak into it.
  // `findings` / `providerName` were added by Story #5480 so a worker can
  // deposit the held review close adopts. `verification` (Story #5919) is the
  // critical-verifier tally.
  const EXPECTED_KEYS = [
    'status',
    'severity',
    'findings',
    'providerName',
    'report',
    'posted',
    'postedCommentId',
    'commentTargetId',
    'halted',
    'criticalByProvider',
    'degraded',
    'degradations',
    'verification',
    'blockerReason',
  ].sort();

  for (const overallLevel of ['low', 'medium', 'high', undefined]) {
    const result = await runCodeReview(
      buildOpts({
        planningRisk: overallLevel ? { overallLevel } : undefined,
        changedFileCount: 2,
      }),
    );
    assert.deepEqual(
      Object.keys(result).sort(),
      EXPECTED_KEYS,
      `envelope keys drifted at level=${String(overallLevel)}`,
    );
    // The depth must not leak into the result envelope.
    assert.equal(
      Object.hasOwn(result, 'depth'),
      false,
      `depth leaked into the output envelope at level=${String(overallLevel)}`,
    );
  }
});

test('runCodeReview: identical findings yield an identical envelope regardless of depth', async () => {
  const findings = [
    { severity: 'medium', title: 'x', body: 'y', category: 'lint' },
  ];
  const deep = await runCodeReview(
    buildOpts({
      findings,
      planningRisk: { overallLevel: 'high' },
      changedFileCount: 1,
    }),
  );
  const light = await runCodeReview(
    buildOpts({
      findings,
      planningRisk: { overallLevel: 'low' },
      changedFileCount: 1,
    }),
  );
  assert.deepEqual(deep, light);
});

// --- Critical halting at every depth --------------------------------------

test('runCodeReview: severity.critical > 0 halts at every depth', async () => {
  const findings = [
    {
      severity: 'critical',
      title: 'Low Maintainability',
      body: 'refactor',
      category: 'maintainability',
    },
  ];
  for (const overallLevel of ['low', 'medium', 'high']) {
    const result = await runCodeReview(
      buildOpts({
        findings,
        planningRisk: { overallLevel },
        changedFileCount: 1,
      }),
    );
    assert.equal(
      result.halted,
      true,
      `expected halt at depth derived from level=${overallLevel}`,
    );
    assert.equal(result.severity.critical, 1);
    assert.match(result.blockerReason, /critical blocker/);
  }
});

test('runCodeReview: no critical findings does not halt at any depth', async () => {
  const findings = [
    { severity: 'high', title: 'Lint', body: 'fix', category: 'lint' },
  ];
  for (const overallLevel of ['low', 'medium', 'high']) {
    const result = await runCodeReview(
      buildOpts({
        findings,
        planningRisk: { overallLevel },
        changedFileCount: 1,
      }),
    );
    assert.equal(result.halted, false);
    assert.equal(result.blockerReason, null);
  }
});

// --- Deferred posting (Story #5473) ----------------------------------------

test('runCodeReview: deferPost computes and renders but never posts', async () => {
  const upserts = [];
  const findings = [
    { severity: 'critical', title: 't', file: 'a.js', line: 1, body: 'b' },
  ];
  const opts = {
    ...buildOpts({ findings, changedFiles: ['a.js'], changedFileCount: 1 }),
    deferPost: true,
    upsertCommentFn: async (...args) => {
      upserts.push(args);
      return { commentId: 1 };
    },
  };
  const out = await runCodeReview(opts);
  assert.equal(upserts.length, 0, 'nothing posted');
  assert.equal(out.posted, false);
  assert.equal(out.postedCommentId, null);
  assert.equal(out.report, fakeRenderFindings(), 'the report is held');
  assert.equal(out.halted, true, 'severity still scored');
});

test('postReviewComment: posts a held report to the given target', async () => {
  const { postReviewComment } = await import(
    '../.agents/scripts/lib/orchestration/code-review.js'
  );
  const upserts = [];
  const out = await postReviewComment({
    upsertCommentFn: async (_provider, target, type, body) => {
      upserts.push({ target, type, body });
      return { commentId: 77 };
    },
    provider: {},
    commentTargetId: 123,
    report: 'held body',
  });
  assert.deepEqual(upserts, [
    { target: 123, type: 'verification-results', body: 'held body' },
  ]);
  assert.deepEqual(out, { posted: true, postedCommentId: 77 });
});

// --- Reviewed-repository cwd (Story #5909) ---------------------------------

/** A git seam recording each call's cwd and verb; every probe succeeds. */
function recordingGit() {
  const calls = [];
  const fn = (cwd, verb) => {
    calls.push({ cwd, verb });
    return { status: 0, stdout: 'a.js', stderr: '' };
  };
  return { fn, calls };
}

const claimCritical = () => ({
  severity: 'critical',
  title: 't',
  body: 'b',
  claim: { kind: 'path-absent', path: 'a.js' },
});

test('runCodeReview: diff enumeration and claim grounding run in opts.cwd', async () => {
  const git = recordingGit();
  await runCodeReview({
    ...buildOpts({ findings: [claimCritical()], gitSpawnFn: git.fn }),
    cwd: '/reviewed/repo',
  });
  assert.deepEqual(
    git.calls.map((c) => c.verb),
    ['diff', 'rev-parse', 'cat-file'],
  );
  assert.ok(git.calls.every((c) => c.cwd === '/reviewed/repo'));
});

test('runCodeReview: without cwd, the diff and grounding fall back to process.cwd()', async () => {
  const git = recordingGit();
  await runCodeReview(
    buildOpts({ findings: [claimCritical()], gitSpawnFn: git.fn }),
  );
  assert.equal(git.calls.length, 3);
  assert.ok(git.calls.every((c) => c.cwd === process.cwd()));
});

test('runCodeReview: no claim-bearing critical spawns no head probe and records no degradation', async () => {
  const git = recordingGit();
  const out = await runCodeReview({
    ...buildOpts({
      findings: [{ severity: 'critical', title: 't', body: 'b' }],
      gitSpawnFn: git.fn,
    }),
    cwd: '/reviewed/repo',
  });
  assert.deepEqual(
    git.calls.map((c) => c.verb),
    ['diff'],
  );
  assert.equal(out.degraded, false);
});

// --- Critical verification summary (Story #5919) ---------------------------

test('runCodeReview: the verifier runs at the review depth and its tally rides the result', async () => {
  const spawned = [];
  const out = await runCodeReview({
    ...buildOpts({
      findings: [{ severity: 'critical', title: 't', body: 'b' }],
      changedFiles: ['a.js'],
      changedFileCount: 1,
    }),
    verifier: {
      probeFn: () => true,
      spawnFn: async (_f, args) => {
        spawned.push(args);
        return {
          status: 0,
          stdout: JSON.stringify({
            subtype: 'success',
            structured_output: {
              verdict: 'confirmed',
              evidence: { file: 'a.js', line: 1 },
              reason: 'real',
            },
          }),
          stderr: '',
        };
      },
      gitSpawnFn: () => ({ status: 0, stdout: 'x\n', stderr: '' }),
    },
  });
  assert.equal(spawned.length, 1, 'one verifier at light depth');
  assert.equal(out.verification.confirmed, 1);
  assert.equal(out.halted, true);
});

test('review deposit: carries the verification tally, and an older deposit without it still adopts', async () => {
  const { buildReviewDeposit, depositAsComputedReview } = await import(
    '../.agents/scripts/lib/orchestration/review-deposit.js'
  );
  const verification = {
    attempted: 2,
    confirmed: 0,
    refuted: 2,
    uncertain: 0,
    errored: 0,
  };
  const deposit = buildReviewDeposit({
    storyId: 1,
    headSha: 'abc',
    baseRef: 'origin/main',
    diffDigest: 'd',
    result: { severity: { critical: 0 }, verification },
  });
  assert.deepEqual(deposit.verification, verification);
  assert.deepEqual(
    depositAsComputedReview(deposit).result.verification,
    verification,
  );
  const { verification: _dropped, ...older } = deposit;
  const adopted = depositAsComputedReview(older).result;
  assert.equal(adopted.verification, null);
  assert.equal(adopted.status, 'ok');
});
