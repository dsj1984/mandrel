import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { runFinalizePhase } from '../../../../../.agents/scripts/lib/orchestration/epic-runner/phases/finalize.js';

const _AGENT_LABELS_CACHE = (async () => {
  const m = await import(
    '../../../../../.agents/scripts/lib/label-constants.js'
  );
  return m.AGENT_LABELS;
})();

function buildCtx(overrides = {}) {
  return {
    epicId: 42,
    provider: { name: 'test-provider' },
    logger: { warn: () => {} },
    ...overrides,
  };
}

function buildCollaborators(overrides = {}) {
  return {
    notify: mock.fn(async () => {}),
    syncColumn: mock.fn(async () => {}),
    journal: {
      record: mock.fn(async () => {}),
      finalize: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

function buildBookends(result = { completed: true }) {
  return { run: mock.fn(async () => result) };
}

describe('runFinalizePhase — completed path', () => {
  it('flips Epic to REVIEW, syncs column, runs bookends, marks DONE on completed', async (t) => {
    // Mock transitionTicketState to succeed by intercepting via t.mock
    // We'll set up dependencies differently — see note below.
    const collaborators = buildCollaborators();
    collaborators.bookends = buildBookends({ completed: true });
    const ctx = buildCtx();
    const state = {
      completionState: 'completed',
      waveHistory: [{ wave: 1 }],
      bookends: collaborators.bookends,
    };
    state.bookends = collaborators.bookends;

    const result = await runFinalizePhase(ctx, collaborators, {
      ...state,
      bookends: collaborators.bookends,
    });

    assert.equal(result.epicId, 42);
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.waveHistory, [{ wave: 1 }]);
    assert.equal(result.bookendResult.completed, true);
    // syncColumn called twice on the completed+done path
    assert.equal(collaborators.syncColumn.mock.callCount(), 2);
    assert.equal(collaborators.journal.finalize.mock.callCount(), 1);
  });

  it('skips DONE-sync when bookends report not-completed', async () => {
    const collaborators = buildCollaborators();
    collaborators.bookends = buildBookends({ completed: false });
    const result = await runFinalizePhase(buildCtx(), collaborators, {
      completionState: 'completed',
      waveHistory: [],
      bookends: collaborators.bookends,
    });
    assert.equal(result.bookendResult.completed, false);
    // Only one syncColumn call (REVIEW), not the DONE follow-up
    assert.equal(collaborators.syncColumn.mock.callCount(), 1);
  });

  it('skips DONE-sync when bookends return null', async () => {
    const collaborators = buildCollaborators();
    collaborators.bookends = { run: mock.fn(async () => null) };
    const result = await runFinalizePhase(buildCtx(), collaborators, {
      completionState: 'completed',
      waveHistory: [],
      bookends: collaborators.bookends,
    });
    assert.equal(result.bookendResult, null);
    assert.equal(collaborators.syncColumn.mock.callCount(), 1);
  });
});

describe('runFinalizePhase — halted path', () => {
  it('syncs to BLOCKED, skips bookends, returns bookendResult: null', async () => {
    const collaborators = buildCollaborators();
    collaborators.bookends = buildBookends();
    const result = await runFinalizePhase(buildCtx(), collaborators, {
      completionState: 'halted',
      waveHistory: [],
      bookends: collaborators.bookends,
    });
    assert.equal(result.state, 'halted');
    assert.equal(result.bookendResult, null);
    // bookends.run NOT invoked
    assert.equal(collaborators.bookends.run.mock.callCount(), 0);
    assert.equal(collaborators.syncColumn.mock.callCount(), 1);
  });
});

describe('runFinalizePhase — defensive defaults', () => {
  it('finalize() is invoked even when nothing else throws', async () => {
    const collaborators = buildCollaborators();
    collaborators.bookends = buildBookends();
    await runFinalizePhase(buildCtx(), collaborators, {
      completionState: 'halted',
      waveHistory: [],
      bookends: collaborators.bookends,
    });
    assert.equal(collaborators.journal.finalize.mock.callCount(), 1);
  });

  it('omits journal entirely → no NPE on finalize chain', async () => {
    const collaborators = {
      notify: async () => {},
      syncColumn: async () => {},
      // journal absent
    };
    const result = await runFinalizePhase(buildCtx(), collaborators, {
      completionState: 'halted',
      waveHistory: [],
      bookends: buildBookends(),
    });
    assert.equal(result.state, 'halted');
  });

  it('uses AGENT_LABELS.BLOCKED on halted-sync', async () => {
    const labels = await _AGENT_LABELS_CACHE;
    const collaborators = buildCollaborators();
    collaborators.syncColumn = mock.fn(async (_id, lbls) => {
      assert.deepEqual(lbls, [labels.BLOCKED]);
    });
    await runFinalizePhase(buildCtx(), collaborators, {
      completionState: 'halted',
      waveHistory: [],
      bookends: buildBookends(),
    });
    assert.equal(collaborators.syncColumn.mock.callCount(), 1);
  });
});
