// tests/contract/orchestration/review-depth-connectivity.test.js
//
// Contract tier (Story #3937): proves the epic code-review `depth` signal is a
// real, consumed wire from producer to provider — the boundary the prior
// "dead wiring" complexity-review flagged.
//
// The wire has three segments, each asserted here:
//   1. Producer — `resolveReviewDepthForEpic` reads the Epic's `planningRisk`
//      envelope off the `epic-plan-state` checkpoint (best-effort `readPlanState`)
//      and resolves the depth: high → deep, low → light, absent/malformed →
//      standard (the no-new-failure-mode default).
//   2. Pipeline — feeding that depth into `runCodeReview` (via `planningRisk`)
//      threads it into the provider's `runReview` input. high → 'deep',
//      low → 'light', absent → 'standard'.
//   3. Consumer — the LLM-backed providers render the depth marker into the
//      prompt/instructions they emit. The suite FAILS if any of them omits it.
//
// All I/O is injected: `readPlanState`, the review provider, the GitHub
// upserter, and the renderer are stubbed. No network, git, or filesystem.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveReviewDepthForEpic,
  runCodeReview,
} from '../../../.agents/scripts/lib/orchestration/code-review.js';
import { buildCodexReviewPrompt } from '../../../.agents/scripts/lib/orchestration/review-providers/codex.js';
import {
  DEPTH_DIRECTIVES,
  renderDepthDirective,
} from '../../../.agents/scripts/lib/orchestration/review-providers/review-depth.js';
import { buildSecurityReviewPrompt } from '../../../.agents/scripts/lib/orchestration/review-providers/security-review.js';
import { buildUltrareviewMessage } from '../../../.agents/scripts/lib/orchestration/review-providers/ultrareview.js';
import { DEFAULT_TASK_SIZING } from '../../../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';

// --- Producer segment: checkpoint → depth ---------------------------------

/**
 * Fake `readPlanState` mirroring the epic-audit-prepare test seam: returns a
 * checkpoint whose `planningRisk` is the supplied envelope, or `null` for a
 * missing checkpoint.
 */
function makeFakeReadPlanState(planningRisk) {
  return async () => (planningRisk === null ? null : { planningRisk });
}

test('producer: high-risk checkpoint → deep', async () => {
  const depth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: makeFakeReadPlanState({ overallLevel: 'high' }),
  });
  assert.equal(depth, 'deep');
});

test('producer: low-risk checkpoint → light', async () => {
  const depth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: makeFakeReadPlanState({ overallLevel: 'low' }),
  });
  assert.equal(depth, 'light');
});

test('producer: medium-risk checkpoint → standard', async () => {
  const depth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: makeFakeReadPlanState({ overallLevel: 'medium' }),
  });
  assert.equal(depth, 'standard');
});

test('producer: missing checkpoint → standard (Epic skipped /plan)', async () => {
  const depth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: makeFakeReadPlanState(null),
  });
  assert.equal(depth, 'standard');
});

test('producer: malformed planningRisk → standard', async () => {
  const depth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: makeFakeReadPlanState({ overallLevel: 'bogus' }),
  });
  assert.equal(depth, 'standard');
});

test('producer: read failure degrades to standard, never throws', async () => {
  const depth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: async () => {
      throw new Error('provider exploded');
    },
  });
  assert.equal(depth, 'standard');
});

// --- Pipeline segment: depth reaches the provider -------------------------

function fakeResolveConfig() {
  return { project: { baseBranch: 'main' }, delivery: { codeReview: null } };
}

/**
 * A fake `gitSpawn` that reports `n` changed files for the diff so the depth
 * resolver sees a deterministic width with no real git subprocess. The default
 * (`n === null`) reports a diff that cannot be enumerated (status 1), modelling
 * the producer-side "width unknown" case where depth is risk-only.
 */
function fakeGitSpawn(n = null) {
  if (n === null) {
    return () => ({ status: 1, stdout: '', stderr: 'no such ref' });
  }
  const stdout = Array.from({ length: n }, (_, i) => `file-${i}.js`).join('\n');
  return () => ({ status: 0, stdout, stderr: '' });
}

/**
 * Drive an epic-scope `runCodeReview` with a checkpoint-resolved depth and
 * capture the `runReview` input the provider receives. Mirrors the producer →
 * pipeline handoff: the depth resolved in segment 1 is what the Phase 5 helper
 * forwards as `planningRisk` to `runCodeReview`. `changedFileCount` injects the
 * mechanical diff width Story #3938 folds into the depth alongside the risk.
 */
async function captureProviderDepth(planningRisk, changedFileCount = null) {
  const captured = {};
  const bus = { emit: async () => {} };
  await runCodeReview({
    ticketId: 100,
    provider: {},
    bus,
    planningRisk,
    gitSpawnFn: fakeGitSpawn(changedFileCount),
    reviewProvider: {
      runReview: async (input) => {
        captured.input = input;
        return [];
      },
    },
    resolveConfigFn: fakeResolveConfig,
    upsertCommentFn: async () => ({ commentId: 1 }),
    renderFindingsFn: () => '## Code Review\n',
  });
  return captured.input;
}

test('pipeline: high → deep reaches the provider runReview input', async () => {
  const input = await captureProviderDepth({ overallLevel: 'high' });
  assert.equal(input.depth, 'deep');
});

test('pipeline: low → light reaches the provider runReview input', async () => {
  const input = await captureProviderDepth({ overallLevel: 'low' });
  assert.equal(input.depth, 'light');
});

test('pipeline: absent risk → standard reaches the provider runReview input', async () => {
  const input = await captureProviderDepth(undefined);
  assert.equal(input.depth, 'standard');
});

test('pipeline: low-risk Epic whose diff exceeds hardFiles → deep (width escalates risk)', async () => {
  // Story #3938 — the depth folds the mechanical diff width in alongside the
  // judged risk. A low-risk Epic that produced a wide change set (> hardFiles)
  // is escalated to a deep provider pass on width alone, closing the gap where
  // a wide low-risk Epic previously got a light review.
  const input = await captureProviderDepth(
    { overallLevel: 'low' },
    DEFAULT_TASK_SIZING.hardFiles + 1,
  );
  assert.equal(input.depth, 'deep');
});

test('pipeline: end-to-end, a high-risk checkpoint resolves and reaches the provider as deep', async () => {
  // Compose the two segments the way Phase 5 does: the producer resolves the
  // depth from the checkpoint, and the pipeline maps the same `planningRisk`
  // envelope into the provider input. Both must agree on `deep`.
  const planningRisk = { overallLevel: 'high' };
  const resolvedDepth = await resolveReviewDepthForEpic({
    epicId: 100,
    provider: {},
    readPlanState: makeFakeReadPlanState(planningRisk),
  });
  assert.equal(resolvedDepth, 'deep');
  const providerInput = await captureProviderDepth(planningRisk);
  assert.equal(providerInput.depth, resolvedDepth);
});

// --- Consumer segment: LLM providers render the depth marker --------------

const DEPTH_MARKER = 'Review depth:';

test('consumer: renderDepthDirective always carries the depth marker', () => {
  for (const depth of ['light', 'standard', 'deep', undefined, 'bogus']) {
    assert.ok(
      renderDepthDirective(depth).includes(DEPTH_MARKER),
      `directive for ${String(depth)} omits the depth marker`,
    );
  }
});

test('consumer: security-review prompt embeds the resolved depth directive', () => {
  const prompt = buildSecurityReviewPrompt({
    scope: 'epic',
    ticketId: 100,
    baseRef: 'main',
    headRef: 'epic/100',
    depth: 'deep',
  });
  assert.ok(
    prompt.includes(DEPTH_MARKER),
    'security-review prompt omits the depth marker',
  );
  assert.ok(
    prompt.includes(DEPTH_DIRECTIVES.deep),
    'security-review prompt omits the deep directive text',
  );
});

test('consumer: ultrareview suggestion embeds the resolved depth directive', () => {
  const message = buildUltrareviewMessage({
    scope: 'epic',
    ticketId: 100,
    baseRef: 'main',
    headRef: 'epic/100',
    depth: 'light',
  });
  assert.ok(
    message.includes(DEPTH_MARKER),
    'ultrareview suggestion omits the depth marker',
  );
  assert.ok(
    message.includes(DEPTH_DIRECTIVES.light),
    'ultrareview suggestion omits the light directive text',
  );
});

test('consumer: codex prompt embeds the resolved depth directive', () => {
  const prompt = buildCodexReviewPrompt({
    baseRef: 'main',
    headRef: 'epic/100',
    depth: 'deep',
  });
  assert.ok(
    prompt.includes(DEPTH_MARKER),
    'codex prompt omits the depth marker',
  );
  assert.ok(
    prompt.includes(DEPTH_DIRECTIVES.deep),
    'codex prompt omits the deep directive text',
  );
  // The slash command and --wait flag must survive the depth append.
  assert.ok(
    prompt.includes('/codex:review --base main --head epic/100 --wait'),
    'codex prompt dropped the slash-command invocation',
  );
});

test('consumer: an omitted depth still renders the standard marker (no silent drop)', () => {
  const prompt = buildSecurityReviewPrompt({
    scope: 'epic',
    ticketId: 100,
    baseRef: 'main',
    headRef: 'epic/100',
  });
  assert.ok(
    prompt.includes(DEPTH_DIRECTIVES.standard),
    'security-review prompt dropped the standard directive when depth was absent',
  );
});

// --- No new failure mode for absent/malformed risk ------------------------

test('absent planningRisk yields a passing review run (status ok, standard depth)', async () => {
  const captured = {};
  const result = await runCodeReview({
    ticketId: 100,
    provider: {},
    bus: { emit: async () => {} },
    // no planningRisk at all
    reviewProvider: {
      runReview: async (input) => {
        captured.input = input;
        return [];
      },
    },
    resolveConfigFn: fakeResolveConfig,
    upsertCommentFn: async () => ({ commentId: 1 }),
    renderFindingsFn: () => '## Code Review\n',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.halted, false);
  assert.equal(captured.input.depth, 'standard');
});
