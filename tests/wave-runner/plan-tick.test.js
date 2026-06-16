import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import { planTick } from '../../.agents/scripts/lib/wave-runner/tick.js';

/**
 * tests/wave-runner/plan-tick.test.js — `planTick(state, records, inFlight)`
 * is the PURE dispatch-decision core extracted from `tick(args)` (Story
 * #4183). These tests pin its contract directly against fixture records —
 * no provider stub, no checkpoint store, no signal emitter — proving the
 * decision logic is independently unit-testable now that the I/O is hoisted
 * into the `tick` coordinator. The signals the planner *wants* emitted come
 * back in the returned `signals` array (the coordinator drains them); the
 * function itself performs no emission.
 */

const ready = ['agent::ready', 'type::story'];

/** Build a minimal checkpoint carrying only the fields `planTick` reads. */
function state({ concurrencyCap = 3, stories } = {}) {
  return { epicId: 100, concurrencyCap, stories: stories ?? {} };
}

/** Build a fixture Story record (the shape `refetchStoryRecords` produces). */
function rec(
  id,
  { labels = ready, issueState = 'open', body = '', files } = {},
) {
  return {
    id,
    title: `Story #${id}`,
    body,
    labels,
    state: issueState,
    files,
    changes: undefined,
    changeset: undefined,
  };
}

describe('lib/wave-runner/planTick — pure dispatch planner', () => {
  it('dispatches every ready Story under the global cap (no wave barrier)', () => {
    const result = planTick(state({ concurrencyCap: 3 }), [rec(1), rec(2)], []);
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
    assert.equal(result.readyCount, 2);
  });

  it('caps the dispatch set at concurrencyCap (ascending id wins)', () => {
    const result = planTick(
      state({ concurrencyCap: 2 }),
      [rec(1), rec(2), rec(3), rec(4)],
      [],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1, 2],
    );
  });

  it('subtracts ledger in-flight Stories from remaining capacity', () => {
    // cap 2, Story 1 in flight (label not yet flipped) → one slot left.
    const result = planTick(
      state({ concurrencyCap: 2 }),
      [rec(1), rec(2)],
      [1],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
  });

  it('marks a ledger-in-flight ready Story as occupying a slot but never re-dispatches it', () => {
    // Story 1 is in flight per the ledger but still label-`ready` (mid
    // story-init). It must not be re-selected, and it consumes a slot so the
    // cap is respected — exactly the worst-failure-mode guard.
    const result = planTick(
      state({ concurrencyCap: 2 }),
      [rec(1), rec(2), rec(3)],
      [1],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    // cap 2 − 1 occupied (Story 1) = 1 slot → only Story 2; Story 1 not re-sent.
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
  });

  it('counts a label-executing Story missing from the ledger toward the cap', () => {
    // Story 1 carries agent::executing but the ledger is silent — it still
    // occupies a real slot. cap 2 − 1 = 1 → exactly one further dispatch.
    const result = planTick(
      state({ concurrencyCap: 2 }),
      [rec(1, { labels: [AGENT_LABELS.EXECUTING] }), rec(2), rec(3)],
      [],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.equal(result.nextAction.stories.length, 1);
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
  });

  it('withholds an overlapping Story (file-footprint co-dispatch guard)', () => {
    const result = planTick(
      state(),
      [rec(1, { files: ['lib/x.js'] }), rec(2, { files: ['lib/x.js'] })],
      [],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    // Lower id wins admission; the overlapping peer is withheld this beat.
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [1],
    );
  });

  it('withholds a ready Story whose dependency is not yet done', () => {
    // Story 2 depends on Story 1 (executing) → not eligible.
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.EXECUTING] }),
        rec(2, { body: 'blocked by #1' }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [1]);
  });

  it('dispatches a ready Story whose deps are done even while a sibling executes', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.EXECUTING] }),
        rec(3, { body: 'blocked by #1' }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [3],
    );
  });

  it('returns observe + blockedStories when any Story is agent::blocked', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.BLOCKED] }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [2]);
    assert.equal(result.blockedStories.length, 1);
    assert.equal(result.blockedStories[0].storyId, 2);
    assert.equal(result.blockedStories[0].reason, 'agent::blocked');
  });

  it('observes while a Story is executing and nothing else is ready', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.EXECUTING] }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.nextAction.waitingOn, [2]);
  });

  it('reports epic-complete when every Story is done', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.DONE] }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'epic-complete');
  });

  it('halts (never epic-complete) on a sibling dependency cycle', () => {
    const result = planTick(
      state(),
      [rec(1, { body: 'blocked by #2' }), rec(2, { body: 'blocked by #1' })],
      [],
    );
    assert.notEqual(result.nextAction.kind, 'epic-complete');
    assert.equal(result.nextAction.kind, 'halt');
    assert.equal(result.nextAction.reason, 'dependency-cycle');
    assert.deepEqual(result.nextAction.stuckStories, [1, 2]);
    assert.ok(Array.isArray(result.nextAction.cycle));
  });

  it('halts with unsatisfiable-dependency when some Stories are done but others are permanently gated', () => {
    // 1, 2 done; 3, 4 form an unsatisfiable cycle. done (2) < in-scope (4),
    // so the run must NOT collapse to epic-complete.
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.DONE] }),
        rec(3, { body: 'blocked by #4' }),
        rec(4, { body: 'blocked by #3' }),
      ],
      [],
    );
    assert.notEqual(result.nextAction.kind, 'epic-complete');
    assert.equal(result.nextAction.kind, 'halt');
    assert.ok(result.nextAction.stuckStories.includes(3));
    assert.ok(result.nextAction.stuckStories.includes(4));
  });

  it('treats a manually-closed Story (state=closed, no agent::done) as done', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: ['agent::ready'], issueState: 'closed' }),
        rec(2, { labels: ['agent::ready'], issueState: 'open' }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.deepEqual(
      result.nextAction.stories.map((s) => s.id),
      [2],
    );
  });

  it('surfaces failed Stories recorded on the checkpoint as gateFailures', () => {
    const result = planTick(
      state({
        stories: {
          1: { status: 'done' },
          2: { status: 'failed', title: 'broke the build' },
        },
      }),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.DONE] }),
      ],
      [],
    );
    const g = result.gateFailures.find((x) => x.storyId === 2);
    assert.ok(g);
    assert.equal(g.gate, 'unspecified');
    assert.equal(g.detail, 'broke the build');
  });
});

describe('lib/wave-runner/planTick — returns signals without emitting (no I/O)', () => {
  it('returns a wave-start signal on the run-opening dispatch', () => {
    const result = planTick(state(), [rec(1), rec(2)], []);
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.ok(result.signals.some((s) => s.kind === 'wave-start'));
    // The wave-start payload names every in-scope Story.
    const waveStart = result.signals.find((s) => s.kind === 'wave-start');
    assert.deepEqual(
      waveStart.stories.map((s) => s.id),
      [1, 2],
    );
  });

  it('returns NO wave-start when work is already in progress', () => {
    // Story 1 done, Story 2 ready → a dispatch, but not the run-opening one.
    const result = planTick(
      state(),
      [rec(1, { labels: [AGENT_LABELS.DONE] }), rec(2)],
      [],
    );
    assert.equal(result.nextAction.kind, 'dispatch');
    assert.equal(
      result.signals.some((s) => s.kind === 'wave-start'),
      false,
    );
  });

  it('returns a wave-complete signal when the run finishes', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.DONE] }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'epic-complete');
    assert.ok(result.signals.some((s) => s.kind === 'wave-complete'));
  });

  it('returns an empty signals array for an observe beat', () => {
    const result = planTick(
      state(),
      [
        rec(1, { labels: [AGENT_LABELS.DONE] }),
        rec(2, { labels: [AGENT_LABELS.EXECUTING] }),
      ],
      [],
    );
    assert.equal(result.nextAction.kind, 'observe');
    assert.deepEqual(result.signals, []);
  });

  it("does NOT attach the in-flight key (that is the coordinator's job)", () => {
    // planTick returns the bare nextAction; `withInFlight` is applied by the
    // coordinator. Asserting the absence keeps the seam honest.
    const result = planTick(state(), [rec(1)], []);
    assert.equal(Object.hasOwn(result.nextAction, 'in-flight'), false);
  });
});
