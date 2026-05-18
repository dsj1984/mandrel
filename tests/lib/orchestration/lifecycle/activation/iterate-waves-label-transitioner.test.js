// tests/lib/orchestration/lifecycle/activation/iterate-waves-label-transitioner.test.js
/**
 * Contract test — LabelTransitioner is the sole executing-state mutator
 * driven by the iterate-waves phase (Epic #2306 / Story #2316 /
 * Task #2321).
 *
 * Invariants pinned here:
 *   1. The iterate-waves phase performs ZERO direct
 *      `provider.updateTicket` / `provider.postComment` / etc. calls
 *      that would constitute a label or comment mutation. The provider
 *      stub records every method invocation; only `getTicket` (a
 *      read) is permitted from the phase body itself.
 *   2. Every label transition observed during a wave run originates
 *      from the LabelTransitioner listener — verified by injecting a
 *      recording `transitionTicketState` into the listener and
 *      asserting that the recorded call set matches the events the
 *      bus emitted (e.g. `wave.end` with a blocked outcome → one
 *      BLOCKED transition for that storyId, `epic.unblocked` → one
 *      EXECUTING transition for the Epic).
 *   3. Regression guard: if a future change reintroduces an inline
 *      `transitionTicketState(provider, ...)` call inside
 *      `phases/iterate-waves.js`, that call would land on the
 *      recording provider's `updateTicket` channel (or, in the
 *      legacy import shape, fail because the symbol is no longer
 *      imported). Either way this test fails fast: it asserts
 *      `recorderProvider.updateTicketCalls.length === 0` on the
 *      provider-channel and asserts the listener's recorded set is
 *      the complete set of executing-state mutations.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runIterateWavesPhase } from '../../../../../.agents/scripts/lib/orchestration/epic-runner/phases/iterate-waves.js';
import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LabelTransitioner } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/label-transitioner.js';
import { STATE_LABELS } from '../../../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Build a recording provider stub. Every method the phase or its
 * collaborators might invoke is wired through a `Proxy`-style getter
 * so any unexpected mutation surface (e.g. `addLabels`, `removeLabel`,
 * `updateTicket`, `postComment`) is captured rather than silently
 * dropped. The `getTicket` read returns the labels seeded by the
 * caller so the resume-skip filter inside iterate-waves does not
 * accidentally classify our test stories as already-done.
 */
function buildRecordingProvider(labelsById = {}) {
  const calls = {
    getTicketCalls: [],
    updateTicketCalls: [],
    postCommentCalls: [],
    addLabelsCalls: [],
    removeLabelCalls: [],
    deleteCommentCalls: [],
  };
  return {
    calls,
    async getTicket(id, opts) {
      calls.getTicketCalls.push({ id, opts });
      return { id, labels: labelsById[id] ?? [] };
    },
    async updateTicket(id, patch) {
      calls.updateTicketCalls.push({ id, patch });
      return { id };
    },
    async postComment(id, body) {
      calls.postCommentCalls.push({ id, body });
      return { id: 1 };
    },
    async addLabels(id, labels) {
      calls.addLabelsCalls.push({ id, labels });
    },
    async removeLabel(id, label) {
      calls.removeLabelCalls.push({ id, label });
    },
    async deleteComment(commentId) {
      calls.deleteCommentCalls.push({ commentId });
    },
  };
}

/**
 * Build the minimal collaborator bag the wave loop needs. Mirrors the
 * shape in `tests/lib/orchestration/lifecycle/phase-iterate-waves.test.js`
 * — kept independent so a refactor of that fixture does not silently
 * weaken this contract.
 */
function buildCollaborators({ bus, launcher }) {
  return {
    notify: () => {},
    epicRunStateStore: {
      async initialize() {},
      async read() {
        return null;
      },
      async write() {},
    },
    blockerHandler: {
      async halt() {
        return { resumed: false };
      },
    },
    blockerWait: async () => ({ resumed: false, reasonToStop: 'test' }),
    launcher,
    waveObserver: {
      async waveStart() {
        return { startedAt: '2025-01-01T00:00:00Z' };
      },
      async waveEnd({ stories }) {
        return { stories };
      },
    },
    progressReporter: {
      setPlan() {},
      setWave() {},
      start() {},
      async stop() {},
    },
    syncColumn: async () => {},
    journal: { async record() {} },
    bus,
  };
}

function buildSingleWaveState(storyIds) {
  const stories = storyIds.map((id) => ({ id }));
  let consumed = false;
  const scheduler = {
    totalWaves: 1,
    currentWave: 0,
    hasMoreWaves() {
      return !consumed;
    },
    nextWave() {
      consumed = true;
      this.currentWave = 1;
      return { index: 0, stories };
    },
    markWaveComplete() {},
  };
  return {
    scheduler,
    waves: [stories],
    epic: { id: 1, title: 't' },
  };
}

const ctxFixture = ({ provider, epicId = 9001 }) => ({
  epicId,
  provider,
  config: {
    orchestration: { runners: { deliverRunner: { concurrencyCap: 2 } } },
  },
  logger: { info() {}, warn() {}, debug() {} },
});

describe('lifecycle/activation/iterate-waves-label-transitioner', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-actlabel-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('LabelTransitioner is the sole label-mutation surface during a clean wave run', async () => {
    const epicId = 9001;
    const bus = new Bus();
    const provider = buildRecordingProvider();

    // Inject a recording transitionTicketState into LabelTransitioner.
    // Every executing-state mutation routed through the listener
    // lands here; nothing the phase does inline can reach this
    // recorder because the only path is bus → listener → injected fn.
    const transitionCalls = [];
    const listener = new LabelTransitioner({
      provider,
      epicId,
      transitionTicketState: async (p, ticketId, state) => {
        // Defense-in-depth: the recorder must observe the same
        // provider instance that was passed to the phase, proving the
        // listener is dispatching on the runtime provider rather than
        // a shadow object.
        assert.equal(p, provider, 'listener receives runtime provider');
        transitionCalls.push({ ticketId, state });
      },
    });
    listener.register(bus);

    const launcher = {
      async launchWave(stories) {
        return stories.map((s) => ({ storyId: s.id, status: 'done' }));
      },
    };
    const state = buildSingleWaveState([501, 502]);

    const result = await runIterateWavesPhase(
      ctxFixture({ provider, epicId }),
      buildCollaborators({ bus, launcher }),
      state,
    );

    assert.equal(result.completionState, 'completed');

    // (1) The phase MUST NOT mutate via the provider directly.
    // `updateTicket`, `postComment`, `addLabels`, `removeLabel`, and
    // `deleteComment` are the mutation surface of the ticketing
    // provider; the recorder shows zero hits across all five.
    assert.equal(
      provider.calls.updateTicketCalls.length,
      0,
      'phase performs zero provider.updateTicket calls (regression guard for inline transitionTicketState)',
    );
    assert.equal(
      provider.calls.postCommentCalls.length,
      0,
      'phase performs zero provider.postComment calls',
    );
    assert.equal(
      provider.calls.addLabelsCalls.length,
      0,
      'phase performs zero provider.addLabels calls',
    );
    assert.equal(
      provider.calls.removeLabelCalls.length,
      0,
      'phase performs zero provider.removeLabel calls',
    );
    assert.equal(
      provider.calls.deleteCommentCalls.length,
      0,
      'phase performs zero provider.deleteComment calls',
    );

    // (2) A clean-sprint wave (all stories `done`) produces NO label
    // transitions through the listener — `wave.end` with only `done`
    // outcomes is a no-op per `resolveTransition`. This proves the
    // listener is wired without firing spuriously.
    assert.equal(
      transitionCalls.length,
      0,
      'clean wave yields zero label transitions (wave.end with only done outcomes)',
    );
  });

  it('blocked outcome routes through LabelTransitioner only (one mutation per blocked storyId)', async () => {
    const epicId = 9002;
    const bus = new Bus();
    const provider = buildRecordingProvider();

    const transitionCalls = [];
    const listener = new LabelTransitioner({
      provider,
      epicId,
      transitionTicketState: async (_p, ticketId, state) => {
        transitionCalls.push({ ticketId, state });
      },
    });
    listener.register(bus);

    // Launcher returns one done + one blocked. After wave.end fires,
    // LabelTransitioner.handle should fan out exactly one BLOCKED
    // transition for the blocked storyId. The phase's halt path
    // would normally wait on `blockerWait`; our collaborator stub
    // returns `{ resumed: false }` so the loop short-circuits.
    const launcher = {
      async launchWave(stories) {
        return stories.map((s) => ({
          storyId: s.id,
          status: s.id === 601 ? 'blocked' : 'done',
          ...(s.id === 601 ? { detail: 'synthesized blocker' } : {}),
        }));
      },
    };
    const state = buildSingleWaveState([601, 602]);

    const result = await runIterateWavesPhase(
      ctxFixture({ provider, epicId }),
      buildCollaborators({ bus, launcher }),
      state,
    );

    // Halted on the blocked story; the wave-end label fan-out still
    // ran because the listener fires before the halt return.
    assert.equal(result.completionState, 'halted');

    // (1) Still zero direct provider mutations from the phase body.
    assert.equal(
      provider.calls.updateTicketCalls.length,
      0,
      'phase never calls provider.updateTicket inline (regression guard)',
    );

    // (2) The listener routed exactly one BLOCKED transition for the
    // blocked storyId. The story.blocked emit on the halt path would
    // also fire the listener, so we expect at least one and assert
    // that every recorded call targets the blocked story with
    // BLOCKED. (A done outcome must NOT appear here — wave.end's
    // resolver filters those.)
    assert.ok(
      transitionCalls.length >= 1,
      'listener recorded at least one transition for the blocked outcome',
    );
    for (const call of transitionCalls) {
      assert.equal(
        call.ticketId,
        601,
        'every recorded transition targets the blocked storyId',
      );
      assert.equal(
        call.state,
        STATE_LABELS.BLOCKED,
        'every recorded transition flips to BLOCKED',
      );
    }
  });

  it('epic.unblocked routes through LabelTransitioner only (executing-state flip on resume)', async () => {
    // This case is the analogue of the legacy inline `transitionTicket-
    // State(provider, epicId, EXECUTING)` call that lived at
    // phases/iterate-waves.js:145. After Story #2316 it MUST be the
    // listener that owns the flip when the Epic resumes from a
    // blocker. We emit `epic.unblocked` directly on the bus (not
    // through the phase) so the test is laser-focused on the
    // listener-surface contract.
    const epicId = 9003;
    const bus = new Bus();
    const provider = buildRecordingProvider();

    const transitionCalls = [];
    const listener = new LabelTransitioner({
      provider,
      epicId,
      transitionTicketState: async (_p, ticketId, state) => {
        transitionCalls.push({ ticketId, state });
      },
    });
    listener.register(bus);

    await bus.emit('epic.unblocked', { reason: 'operator resumed' });

    // Exactly one EXECUTING transition for the Epic, sourced from the
    // listener — no provider-channel mutations on the way.
    assert.deepEqual(transitionCalls, [
      { ticketId: epicId, state: STATE_LABELS.EXECUTING },
    ]);
    assert.equal(
      provider.calls.updateTicketCalls.length,
      0,
      'no provider-channel mutation on epic.unblocked',
    );
  });
});
