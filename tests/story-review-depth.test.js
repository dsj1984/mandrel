/**
 * story-review-depth.test.js
 *
 * Story #3940 — Epic-attached Story reviews inherit the parent Epic's review
 * depth. Pins the Story-scope seam that threads the Epic's judged
 * `planningRisk` through the locked-pipeline → `runStoryCodeReview` →
 * `runStoryReviewCore` → `runCodeReview` chain, where depth is resolved from
 * BOTH the inherited risk and the Story-scope (`epic/<id>...story-<id>`)
 * changed-file count.
 *
 * The seam has three asserted segments:
 *   1. Producer — `resolveParentEpicPlanningRisk` reads the parent Epic's
 *      `planningRisk` envelope off its `epic-plan-state` checkpoint via the
 *      shared `read` reader, degrading to `null` (never throwing) when the
 *      checkpoint is absent, unreadable, or the Story is not Epic-attached.
 *   2. Forwarding — `runStoryCodeReview` / `runStoryReviewCore` forward that
 *      envelope verbatim into `runCodeReview` as `planningRisk`, and omit the
 *      field entirely when the envelope is `null` (the standalone path).
 *   3. Depth resolution — driving the real `runCodeReview` with a Story-scope
 *      diff width: a Story under a high-risk Epic → `deep`; a small Story
 *      under a low-risk Epic → `light`; no checkpoint → `standard`
 *      (byte-identical to today).
 *
 * The halting contract is unchanged regardless of depth: a critical finding
 * still blocks the close, and depth never alters the output envelope.
 *
 * All I/O is injected — `readPlanState`, `runCodeReview`, the review provider,
 * the GitHub upserter, and the renderer are stubbed. No network, git, or
 * filesystem.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodeReview } from '../.agents/scripts/lib/orchestration/code-review.js';
import { DEFAULT_DIFF_WIDTH } from '../.agents/scripts/lib/orchestration/review-depth.js';
import {
  runStoryCodeReview,
  runStoryReviewCore,
} from '../.agents/scripts/lib/orchestration/story-close/phases/code-review.js';
import { resolveParentEpicPlanningRisk } from '../.agents/scripts/lib/orchestration/story-close/phases/locked-pipeline.js';

const noopProgress = () => {};

// --- Segment 1: producer — checkpoint → planningRisk envelope -------------

function makeFakeReadPlanState(planningRisk) {
  return async () => (planningRisk === null ? null : { planningRisk });
}

test('story-review-depth producer: high-risk Epic checkpoint yields the high envelope', async () => {
  const risk = await resolveParentEpicPlanningRisk({
    provider: {},
    epicId: 200,
    readPlanStateFn: makeFakeReadPlanState({ overallLevel: 'high' }),
  });
  assert.deepEqual(risk, { overallLevel: 'high' });
});

test('story-review-depth producer: missing checkpoint degrades to null', async () => {
  const risk = await resolveParentEpicPlanningRisk({
    provider: {},
    epicId: 200,
    readPlanStateFn: makeFakeReadPlanState(null),
  });
  assert.equal(risk, null);
});

test('story-review-depth producer: read failure degrades to null, never throws', async () => {
  const risk = await resolveParentEpicPlanningRisk({
    provider: {},
    epicId: 200,
    readPlanStateFn: async () => {
      throw new Error('provider exploded');
    },
  });
  assert.equal(risk, null);
});

test('story-review-depth producer: non-Epic-attached Story (null epicId) yields null without reading', async () => {
  let read = false;
  const risk = await resolveParentEpicPlanningRisk({
    provider: {},
    epicId: null,
    readPlanStateFn: async () => {
      read = true;
      return { planningRisk: { overallLevel: 'high' } };
    },
  });
  assert.equal(risk, null);
  assert.equal(
    read,
    false,
    'must short-circuit before reading when epicId is absent',
  );
});

// --- Segment 2: forwarding — planningRisk reaches runCodeReview -----------

function captureRunCodeReview(captured) {
  return async (opts) => {
    captured.opts = opts;
    return {
      status: 'ok',
      severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
      posted: true,
      halted: false,
      blockerReason: null,
    };
  };
}

test('story-review-depth forwarding: runStoryReviewCore forwards planningRisk to runCodeReview', async () => {
  const captured = {};
  await runStoryReviewCore({
    storyId: 3940,
    baseRef: 'epic/100',
    headRef: 'story-3940',
    provider: { kind: 'stub' },
    progress: noopProgress,
    planningRisk: { overallLevel: 'high' },
    runCodeReviewFn: captureRunCodeReview(captured),
  });
  assert.deepEqual(captured.opts.planningRisk, { overallLevel: 'high' });
});

test('story-review-depth forwarding: runStoryReviewCore omits planningRisk when null (standalone path)', async () => {
  const captured = {};
  await runStoryReviewCore({
    storyId: 3940,
    baseRef: 'main',
    headRef: 'story-3940',
    provider: { kind: 'stub' },
    progress: noopProgress,
    planningRisk: null,
    runCodeReviewFn: captureRunCodeReview(captured),
  });
  assert.ok(
    !('planningRisk' in captured.opts),
    'planningRisk must be absent from the runCodeReview input when null',
  );
});

test('story-review-depth forwarding: runStoryCodeReview threads planningRisk through to runCodeReview', async () => {
  const captured = {};
  const out = await runStoryCodeReview({
    storyId: 3940,
    epicBranch: 'epic/100',
    storyBranch: 'story-3940',
    provider: { kind: 'stub' },
    bus: { emit: async () => {} },
    progress: noopProgress,
    planningRisk: { overallLevel: 'low' },
    runCodeReviewFn: captureRunCodeReview(captured),
  });
  assert.equal(out.blocked, null);
  assert.equal(captured.opts.scope, 'story');
  assert.equal(captured.opts.ticketId, 3940);
  assert.equal(captured.opts.baseRef, 'epic/100');
  assert.equal(captured.opts.headRef, 'story-3940');
  assert.deepEqual(captured.opts.planningRisk, { overallLevel: 'low' });
});

// --- Segment 3: depth resolution end-to-end through runCodeReview ---------

function fakeResolveConfig() {
  return { project: { baseBranch: 'main' }, delivery: { codeReview: null } };
}

/**
 * A fake `gitSpawn` reporting `n` changed files for the Story-scope diff so the
 * depth resolver sees a deterministic width without a real git subprocess.
 * `n === null` models the "width unknown" case (diff cannot be enumerated).
 */
function fakeGitSpawn(n = null) {
  if (n === null) {
    return () => ({ status: 1, stdout: '', stderr: 'no such ref' });
  }
  const stdout = Array.from({ length: n }, (_, i) => `file-${i}.js`).join('\n');
  return () => ({ status: 0, stdout, stderr: '' });
}

/**
 * Drive the real Story-scope `runCodeReview` (through `runStoryReviewCore`) with
 * an inherited `planningRisk` envelope and an injected Story-scope diff width,
 * capturing the `depth` the provider receives. Mirrors the locked-pipeline
 * handoff: the Epic's risk + the Story's own changed-file count fold into depth.
 */
async function captureStoryScopeDepth(planningRisk, changedFileCount = null) {
  const captured = {};
  await runStoryReviewCore({
    storyId: 3940,
    baseRef: 'epic/100',
    headRef: 'story-3940',
    provider: {},
    progress: noopProgress,
    planningRisk,
    runCodeReviewFn: (opts) =>
      runCodeReview({
        ...opts,
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
      }),
  });
  return captured.input;
}

test('story-review-depth resolution: Story under a high-risk Epic resolves to deep', async () => {
  const input = await captureStoryScopeDepth({ overallLevel: 'high' }, 1);
  // Small Story diff (1 file) but a high-risk Epic still earns a deep pass.
  assert.equal(input.depth, 'deep');
  assert.equal(input.scope, 'story');
});

test('story-review-depth resolution: small Story under a low-risk Epic resolves to light', async () => {
  const input = await captureStoryScopeDepth(
    { overallLevel: 'low' },
    DEFAULT_DIFF_WIDTH.softFiles,
  );
  assert.equal(input.depth, 'light');
});

test('story-review-depth resolution: no checkpoint (null risk) resolves to standard', async () => {
  // Width unknown + absent risk → standard, byte-identical to pre-#3940 review.
  const input = await captureStoryScopeDepth(null, null);
  assert.equal(input.depth, 'standard');
});

// --- Halting contract is depth-independent --------------------------------

test('story-review-depth: critical findings still block the close regardless of depth', async () => {
  const fakeRunCodeReview = async (opts) => {
    // depth was resolved/forwarded, but a critical finding must still halt.
    assert.deepEqual(opts.planningRisk, { overallLevel: 'high' });
    return {
      status: 'ok',
      severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
      posted: true,
      halted: true,
      blockerReason: 'code-review reported 1 critical blocker(s)',
    };
  };
  const out = await runStoryCodeReview({
    storyId: 3940,
    epicBranch: 'epic/100',
    storyBranch: 'story-3940',
    provider: { kind: 'stub' },
    bus: { emit: async () => {} },
    progress: noopProgress,
    planningRisk: { overallLevel: 'high' },
    runCodeReviewFn: fakeRunCodeReview,
  });
  assert.ok(out.blocked, 'critical findings must short-circuit the close');
  assert.equal(out.blocked.reason, 'code-review-critical');
  assert.equal(out.blocked.exitCode, 1);
});
