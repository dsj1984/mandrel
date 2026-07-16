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

/** Capture the bus events emitted during a run. */
function makeBus() {
  const events = [];
  return {
    events,
    emit: async (name, payload) => {
      events.push({ name, payload });
    },
  };
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
    provider: {},
    bus: makeBus(),
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
  const EXPECTED_KEYS = [
    'status',
    'severity',
    'report',
    'posted',
    'postedCommentId',
    'commentTargetId',
    'halted',
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
