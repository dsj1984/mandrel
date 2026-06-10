// tests/code-review.test.js
//
// Unit tier (Story #3876): the review-depth lever in `code-review.js` is pure
// control flow. These tests pin:
//   1. `resolveReviewDepth` — overallLevel → depth (low→light, high→deep,
//      medium/unknown→standard).
//   2. The depth is threaded into the review provider's `runReview` input.
//   3. The `{ status, severity, posted, report, halted, blockerReason }`
//      output envelope is byte-compatible with the pre-change shape regardless
//      of depth (depth is an input-only signal).
//   4. `severity.critical > 0` halts the run at every depth.
//
// `runReview` and the GitHub provider are mocked — this is pure logic, no I/O.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveReviewDepth,
  runCodeReview,
} from '../.agents/scripts/lib/orchestration/code-review.js';

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
 * Build a `runCodeReview` opts bag with all I/O seams stubbed. `findings` is
 * the array the mocked provider returns; `captured` collects the `runReview`
 * input so tests can assert the threaded depth.
 */
function buildOpts({ findings = [], captured = {}, planningRisk } = {}) {
  return {
    epicId: 100,
    provider: {},
    bus: makeBus(),
    planningRisk,
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

// --- resolveReviewDepth ---------------------------------------------------

test('resolveReviewDepth: low → light', () => {
  assert.equal(resolveReviewDepth('low'), 'light');
});

test('resolveReviewDepth: high → deep', () => {
  assert.equal(resolveReviewDepth('high'), 'deep');
});

test('resolveReviewDepth: medium → standard', () => {
  assert.equal(resolveReviewDepth('medium'), 'standard');
});

test('resolveReviewDepth: unknown / absent level → standard (neutral default)', () => {
  for (const level of [undefined, null, '', 'bogus']) {
    assert.equal(
      resolveReviewDepth(level),
      'standard',
      `expected standard for ${JSON.stringify(level)}`,
    );
  }
});

// --- Depth threaded into runReview input ----------------------------------

test('runCodeReview: threads a deep depth for a high-risk envelope', async () => {
  const captured = {};
  const opts = buildOpts({
    captured,
    planningRisk: { overallLevel: 'high' },
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'deep');
});

test('runCodeReview: threads a light depth for a low-risk envelope', async () => {
  const captured = {};
  const opts = buildOpts({
    captured,
    planningRisk: { overallLevel: 'low' },
  });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'light');
});

test('runCodeReview: defaults to standard depth when no risk envelope is supplied', async () => {
  const captured = {};
  const opts = buildOpts({ captured });
  await runCodeReview(opts);
  assert.equal(captured.input.depth, 'standard');
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
      buildOpts({ planningRisk: overallLevel ? { overallLevel } : undefined }),
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
    buildOpts({ findings, planningRisk: { overallLevel: 'high' } }),
  );
  const light = await runCodeReview(
    buildOpts({ findings, planningRisk: { overallLevel: 'low' } }),
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
      buildOpts({ findings, planningRisk: { overallLevel } }),
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
      buildOpts({ findings, planningRisk: { overallLevel } }),
    );
    assert.equal(result.halted, false);
    assert.equal(result.blockerReason, null);
  }
});
