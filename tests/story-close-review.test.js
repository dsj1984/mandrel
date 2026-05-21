/**
 * story-close-review.test.js
 *
 * Story #2840 (Epic #2815 — Pluggable Code Review + Story-Level Review).
 * Pins the `runStoryCodeReview` phase that `story-close.js` injects
 * between the close-validation gate chain and the merge into
 * `epic/<id>`:
 *
 *   - invokes `runCodeReview` with `scope: 'story'`, the Story
 *     ticket id, the Story branch as `headRef`, and the Epic branch
 *     as `baseRef`,
 *   - returns `{ blocked: <envelope> }` with `exitCode: 1` and
 *     `reason: 'code-review-critical'` when the review reports any
 *     critical finding (Story merge is refused),
 *   - returns `{ blocked: null }` and lets the close proceed when the
 *     review reports only non-critical findings (the structured
 *     comment is posted by `runCodeReview` itself; this phase only
 *     drives the gate decision),
 *   - swallows adapter throws into `{ blocked: null }` so a wiring
 *     failure does not strand the Story.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runStoryCodeReview } from '../.agents/scripts/lib/orchestration/story-close/phases/code-review.js';

function makeRecordingProgress() {
  const calls = [];
  return {
    calls,
    fn: (tag, msg) => calls.push({ tag, msg }),
  };
}

function makeRecordingBus() {
  const events = [];
  return {
    events,
    emit: async (ev, payload) => {
      events.push({ ev, payload });
    },
  };
}

const baseArgs = {
  storyId: 2840,
  epicBranch: 'epic/2815',
  storyBranch: 'story-2840',
  provider: { kind: 'github-stub' },
};

test('runStoryCodeReview calls runCodeReview with scope=story, baseRef=epic branch, headRef=story branch', async () => {
  const calls = [];
  const fakeRunCodeReview = async (opts) => {
    calls.push(opts);
    return {
      status: 'ok',
      severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
      posted: true,
      halted: false,
      blockerReason: null,
    };
  };
  const progress = makeRecordingProgress();
  const bus = makeRecordingBus();

  const out = await runStoryCodeReview({
    ...baseArgs,
    bus,
    progress: progress.fn,
    runCodeReviewFn: fakeRunCodeReview,
  });

  assert.equal(out.blocked, null);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.scope, 'story');
  assert.equal(call.ticketId, 2840);
  assert.equal(call.headRef, 'story-2840');
  assert.equal(call.baseRef, 'epic/2815');
  assert.equal(call.provider, baseArgs.provider);
});

test('runStoryCodeReview returns blocked envelope on critical findings (exitCode=1, reason=code-review-critical)', async () => {
  const fakeRunCodeReview = async () => ({
    status: 'ok',
    severity: { critical: 2, high: 1, medium: 0, suggestion: 0 },
    posted: true,
    halted: true,
    blockerReason: 'code-review reported 2 critical blocker(s)',
  });
  const progress = makeRecordingProgress();
  const bus = makeRecordingBus();

  const out = await runStoryCodeReview({
    ...baseArgs,
    bus,
    progress: progress.fn,
    runCodeReviewFn: fakeRunCodeReview,
  });

  assert.ok(out.blocked, 'critical findings must short-circuit the close');
  assert.equal(out.blocked.success, false);
  assert.equal(out.blocked.status, 'blocked');
  assert.equal(out.blocked.phase, 'closing');
  assert.equal(out.blocked.reason, 'code-review-critical');
  assert.equal(out.blocked.exitCode, 1);
  assert.equal(out.blocked.storyId, 2840);
  assert.equal(out.blocked.severity.critical, 2);
  assert.equal(out.blocked.severity.high, 1);
  assert.equal(out.blocked.posted, true);
  assert.match(out.blocked.blockerReason, /2 critical/);
});

test('runStoryCodeReview emits story.blocked on the bus when critical findings halt the close', async () => {
  const fakeRunCodeReview = async () => ({
    status: 'ok',
    severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
    posted: true,
    halted: true,
    blockerReason: 'code-review reported 1 critical blocker(s)',
  });
  const progress = makeRecordingProgress();
  const bus = makeRecordingBus();

  await runStoryCodeReview({
    ...baseArgs,
    bus,
    progress: progress.fn,
    runCodeReviewFn: fakeRunCodeReview,
  });

  const blocked = bus.events.find((e) => e.ev === 'story.blocked');
  assert.ok(
    blocked,
    'story.blocked lifecycle event must fire on critical halt',
  );
  assert.equal(blocked.payload.storyId, 2840);
  assert.equal(blocked.payload.reason, 'code-review-critical');
});

test('runStoryCodeReview returns blocked=null on non-critical findings (close proceeds)', async () => {
  const fakeRunCodeReview = async () => ({
    status: 'ok',
    severity: { critical: 0, high: 3, medium: 2, suggestion: 5 },
    posted: true,
    halted: false,
    blockerReason: null,
  });
  const progress = makeRecordingProgress();
  const bus = makeRecordingBus();

  const out = await runStoryCodeReview({
    ...baseArgs,
    bus,
    progress: progress.fn,
    runCodeReviewFn: fakeRunCodeReview,
  });

  assert.equal(out.blocked, null);
  // No story.blocked lifecycle event when the gate passes.
  assert.equal(
    bus.events.find((e) => e.ev === 'story.blocked'),
    undefined,
  );
});

test('runStoryCodeReview swallows runCodeReview throws and returns blocked=null (close proceeds)', async () => {
  const fakeRunCodeReview = async () => {
    throw new Error('adapter network failure');
  };
  const progress = makeRecordingProgress();
  const bus = makeRecordingBus();

  const out = await runStoryCodeReview({
    ...baseArgs,
    bus,
    progress: progress.fn,
    runCodeReviewFn: fakeRunCodeReview,
  });

  assert.equal(out.blocked, null);
});
