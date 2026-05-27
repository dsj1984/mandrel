// tests/scripts/epic-plan-decompose.3tier-creation-diagnostics.test.js
//
// Story #3120 / Task #3132 — contract coverage for creation.js and
// diagnostics.js phase helpers under the 3-tier hierarchy (Epic #3078).
//
// Three guarantees pinned here:
//
//   1. `runStagedPasses` runs only the passes whose ticket type is
//      present. A 3-tier backlog (Feature + Story with inline
//      acceptance/verify, NO Tasks) creates the Feature and Story and
//      never invokes the task-creation pass.
//
//   2. `reportPartialFailure` (diagnostics.js) emits no log line that
//      mentions "Tasks" when the Epic carries only Feature + Story
//      children. The 3-tier shape must not surface a "missing Tasks"
//      warning that the 4-tier shape would also not have surfaced —
//      diagnostics is type-agnostic and counts all child types together.
//
//   3. `runStagedPasses` on a 4-tier backlog (Feature + Story + Task)
//      continues to fire all three passes in order. Regression guard
//      for the existing behavior — the 3-tier branch must not skip
//      Tasks when they are present.
//
// Run: node --test tests/scripts/epic-plan-decompose.3tier-creation-diagnostics.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../../.agents/scripts/lib/Logger.js';
import { runStagedPasses } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/creation.js';
import { reportPartialFailure } from '../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/diagnostics.js';

const EPIC_ID = 9120;

// Minimal provider stub: records every createTicket call and returns
// a monotonic id so subsequent passes can resolve parent_slug edges.
function buildRecordingProvider() {
  let nextId = 1000;
  const created = [];
  return {
    created,
    async createTicket(parentId, ticketData) {
      const id = ++nextId;
      created.push({
        id,
        parentId,
        title: ticketData.title,
        labels: ticketData.labels ?? [],
      });
      return { id, url: `https://example.test/issues/${id}` };
    },
    // runStagedPasses does not call these in the happy path, but the
    // attachAdaptiveConcurrencyHook helper probes _http. Provide an
    // explicit no-op so the hook detaches cleanly.
    _http: { onTransientFailure: null },
  };
}

describe('runStagedPasses — 3-tier (no Tasks) creation (Story #3120)', () => {
  it('creates Feature + Story when no Tasks are present, skips the task pass entirely', async () => {
    const provider = buildRecordingProvider();
    const ordered = [
      {
        type: 'feature',
        slug: 'f1',
        title: 'F1 — 3-tier feature',
        labels: ['type::feature'],
      },
      {
        type: 'story',
        slug: 's1',
        title: 'S1 — Story with inline acceptance',
        parent_slug: 'f1',
        labels: ['type::story'],
        // The renderer/validator already handles inline acceptance + verify
        // upstream; runStagedPasses only walks types and dispatches creates,
        // so we don't need to carry the structured body here.
      },
    ];
    const slugMap = new Map();

    await runStagedPasses({
      ordered,
      slugMap,
      epicId: EPIC_ID,
      provider,
      childIndex: new Map(),
      configuredCap: 2,
    });

    // Exactly two creates: the Feature first, then the Story rooted at
    // that Feature. No third create (no Task pass).
    assert.equal(provider.created.length, 2);
    assert.equal(provider.created[0].title, 'F1 — 3-tier feature');
    assert.equal(
      provider.created[1].title,
      'S1 — Story with inline acceptance',
    );
    // The Story's parent must resolve to the Feature's freshly minted id,
    // proving the slugMap propagated across passes even when no Task
    // pass runs.
    assert.equal(provider.created[1].parentId, provider.created[0].id);
  });

  it('emits no creates and no throws when every type bucket is empty (defensive)', async () => {
    const provider = buildRecordingProvider();
    await runStagedPasses({
      ordered: [],
      slugMap: new Map(),
      epicId: EPIC_ID,
      provider,
      childIndex: new Map(),
      configuredCap: 2,
    });
    assert.equal(provider.created.length, 0);
  });
});

describe('runStagedPasses — 4-tier regression guard (Story #3120)', () => {
  it('runs all three passes in feature → story → task order when a 4-tier backlog is supplied', async () => {
    const provider = buildRecordingProvider();
    const ordered = [
      {
        type: 'feature',
        slug: 'f1',
        title: 'F1 — 4-tier feature',
        labels: ['type::feature'],
      },
      {
        type: 'story',
        slug: 's1',
        title: 'S1 — 4-tier story',
        parent_slug: 'f1',
        labels: ['type::story'],
      },
      {
        type: 'task',
        slug: 't1',
        title: 'T1 — 4-tier task',
        parent_slug: 's1',
        labels: ['type::task'],
        body: { goal: 'g', changes: ['c'], acceptance: ['a'], verify: ['v'] },
      },
    ];
    const slugMap = new Map();

    await runStagedPasses({
      ordered,
      slugMap,
      epicId: EPIC_ID,
      provider,
      childIndex: new Map(),
      configuredCap: 2,
    });

    // All three passes fire, in canonical order.
    assert.equal(provider.created.length, 3);
    assert.deepEqual(
      provider.created.map((c) => c.title),
      ['F1 — 4-tier feature', 'S1 — 4-tier story', 'T1 — 4-tier task'],
    );
    // Parent chain: feature → story → task, each resolved from the
    // slugMap built by the prior pass.
    assert.equal(provider.created[1].parentId, provider.created[0].id);
    assert.equal(provider.created[2].parentId, provider.created[1].id);
  });
});

describe('reportPartialFailure — 3-tier no "missing Tasks" warning (Story #3120)', () => {
  // Capture every Logger.error call without disturbing the singleton.
  function captureErrors() {
    const lines = [];
    const original = Logger.error;
    Logger.error = (msg) => {
      lines.push(String(msg));
    };
    return {
      lines,
      restore: () => {
        Logger.error = original;
      },
    };
  }

  it('does not emit any "Tasks" wording when the Epic has only Feature + Story children (3-tier)', async () => {
    const provider = {
      async getEpic() {
        return { id: EPIC_ID, labels: ['type::epic', 'agent::executing'] };
      },
      async getTickets() {
        // 3-tier: Feature + Story only, no Task children.
        return [
          { id: 9121, title: 'F1', labels: ['type::feature'], state: 'open' },
          { id: 9122, title: 'S1', labels: ['type::story'], state: 'open' },
        ];
      },
    };

    const cap = captureErrors();
    try {
      await reportPartialFailure({
        epicId: EPIC_ID,
        provider,
        err: new Error('decompose aborted mid-pass'),
      });
    } finally {
      cap.restore();
    }

    // The diagnostics surface must be 3-tier-clean: no warning that
    // implies Tasks should exist, no log line whose only purpose is to
    // observe the absence of Tasks.
    const taskMentions = cap.lines.filter((l) => /\btask(s)?\b/i.test(l));
    assert.deepEqual(
      taskMentions,
      [],
      `diagnostics emitted Task-mentioning lines under 3-tier:\n${taskMentions.join('\n')}`,
    );
    // The "to resume" hint is still emitted (cwd-hint contract).
    assert.ok(
      cap.lines.some((l) => /To resume/.test(l)),
      'reportPartialFailure must still emit the resume hint',
    );
    // The open-children count IS still emitted and reflects the 2 open
    // 3-tier children — proving the diagnostic surface is type-agnostic.
    assert.ok(
      cap.lines.some((l) => /Children currently open under Epic: 2/.test(l)),
      'reportPartialFailure must still report total open children',
    );
  });

  it('counts all child types together when both Story and Task children exist (4-tier regression)', async () => {
    const provider = {
      async getEpic() {
        return { id: EPIC_ID, labels: ['type::epic', 'agent::executing'] };
      },
      async getTickets() {
        return [
          { id: 9131, title: 'F1', labels: ['type::feature'], state: 'open' },
          { id: 9132, title: 'S1', labels: ['type::story'], state: 'open' },
          { id: 9133, title: 'T1', labels: ['type::task'], state: 'open' },
          { id: 9134, title: 'T2', labels: ['type::task'], state: 'closed' },
        ];
      },
    };

    const cap = captureErrors();
    try {
      await reportPartialFailure({
        epicId: EPIC_ID,
        provider,
        err: new Error('decompose aborted mid-pass'),
      });
    } finally {
      cap.restore();
    }

    // Open count excludes the closed Task — verifies the existing
    // filter contract is preserved.
    assert.ok(
      cap.lines.some((l) => /Children currently open under Epic: 3/.test(l)),
      'reportPartialFailure must count open children excluding closed ones',
    );
  });
});
