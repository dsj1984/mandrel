// tests/contract/lifecycle/bus-sole-mutator.test.js
/**
 * Contract test for Story #2898 / Epic #2880 — the lifecycle bus is the
 * sole mutator of phase state across /epic-deliver's close-tail.
 *
 * Acceptance contract:
 *   1. Driving `runEpicDeliverCloseTail` against a sample Epic fixture
 *      records every phase transition through the lifecycle bus exactly
 *      once (no parallel duplicate emits, no skipped transitions).
 *   2. The close-tail issues NO direct `provider.updateTicket` calls
 *      while it runs — every label flip must travel through the bus so
 *      the LabelTransitioner listener owns the side effect. A direct
 *      mutation observed during the run fails the contract.
 *   3. The critical-findings halt path still routes its `epic.blocked`
 *      mutation through the bus (the fallback `provider.updateTicket`
 *      branch was deleted under this Story); the recorded ledger MUST
 *      contain exactly one `epic.blocked` event and the provider MUST
 *      NOT have been called with a label-update body.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runEpicDeliverCloseTail } from '../../../.agents/scripts/lib/orchestration/epic-deliver-close-tail.js';
import { Bus } from '../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { CHECKPOINT_SCHEMA_VERSION } from '../../fixtures/epic-run-state-store.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function quietLogger() {
  return { warn() {}, info() {}, debug() {}, error() {} };
}

/**
 * Build a recording provider that:
 *   - seeds an `epic-run-state` checkpoint comment so the close-tail's
 *     `read()` finds a resume cursor at the requested phase;
 *   - records every `updateTicket` call (so the test can assert the
 *     close-tail issues none directly — every label mutation must
 *     travel through the bus and the LabelTransitioner listener).
 */
function makeRecordingProvider(initialPhase, epicId) {
  const comments = new Map();
  const updateTicketCalls = [];
  let nextId = 1;
  if (initialPhase) {
    const marker = `<!-- ap:structured-comment type="epic-run-state" -->`;
    const payload = {
      version: CHECKPOINT_SCHEMA_VERSION,
      epicId,
      phase: initialPhase,
    };
    const body = `${marker}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    comments.set(epicId, [{ id: nextId++, body }]);
  }
  return {
    updateTicketCalls,
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const id = nextId++;
      const list = comments.get(ticketId) ?? [];
      list.push({ id, body: payload.body });
      comments.set(ticketId, list);
      return { commentId: id };
    },
    async deleteComment(id) {
      for (const [ticketId, list] of comments) {
        const next = list.filter((c) => c.id !== id);
        if (next.length !== list.length) comments.set(ticketId, next);
      }
    },
    async updateTicket(ticketId, body) {
      updateTicketCalls.push({ ticketId, body });
      return { ok: true };
    },
    async getTicket(id) {
      return { id, title: `Epic ${id}` };
    },
  };
}

describe('lifecycle bus is sole mutator of close-tail phase state', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-2898-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('records every phase transition exactly once on the bus with no parallel provider mutations', async () => {
    const epicId = 2880;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    const provider = makeRecordingProvider('close-validation', epicId);

    const result = await runEpicDeliverCloseTail({
      epicId,
      provider,
      bus,
      logger: quietLogger(),
      runWaveGateFn: async () => ({ exitCode: 0 }),
      runHierarchyGateFn: async () => ({ exitCode: 0 }),
      runCodeReviewFn: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        halted: false,
        posted: true,
      }),
      runRetroFn: async () => ({ ok: true, posted: true }),
      runFinalizeFn: async () => ({
        ffOk: true,
        pushed: true,
        prUrl: 'https://example.test/pr/1',
        postedHandoff: true,
      }),
    });

    assert.equal(result.completed, true, 'close-tail should complete cleanly');

    // Arrange: extract the emitted-event log from the ledger.
    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');

    // Act: assert that the umbrella phase-transition events fire EXACTLY
    // once. The bus is the sole writer; a duplicate emit would surface as
    // a count > 1 against any phase boundary.
    const eventCounts = new Map();
    for (const r of emitted) {
      eventCounts.set(r.event, (eventCounts.get(r.event) ?? 0) + 1);
    }
    // The close-tail orchestrator itself emits the two umbrella events
    // bracketing the close-tail run. Sub-phase events (`code-review.*`,
    // `retro.*`) are emitted by their respective runners — the injected
    // stubs in this test substitute the runner bodies, so those events
    // are not exercised here (the phase-close-tail unit suite pins them
    // against the real runners). The umbrella pair is sufficient to
    // prove the bus is the sole writer of close-tail-level phase state.
    const phaseTransitionEvents = ['epic.close.start', 'epic.close.end'];
    for (const event of phaseTransitionEvents) {
      assert.equal(
        eventCounts.get(event),
        1,
        `expected exactly one ${event} on the bus (got ${eventCounts.get(event) ?? 0})`,
      );
    }

    // Assert: the close-tail issued NO direct provider.updateTicket calls
    // during the run. Every label transition must travel through the bus
    // (and the LabelTransitioner listener) — direct mutations would be
    // the "parallel writes" path the Story #2898 cutover deleted.
    assert.equal(
      provider.updateTicketCalls.length,
      0,
      `close-tail must not issue direct provider.updateTicket calls; ` +
        `observed ${provider.updateTicketCalls.length}: ` +
        `${JSON.stringify(provider.updateTicketCalls)}`,
    );
  });

  it('routes critical-findings blocker through bus only (no direct updateTicket)', async () => {
    const epicId = 2881;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    const provider = makeRecordingProvider('close-validation', epicId);

    await assert.rejects(
      () =>
        runEpicDeliverCloseTail({
          epicId,
          provider,
          bus,
          logger: quietLogger(),
          runWaveGateFn: async () => ({ exitCode: 0 }),
          runHierarchyGateFn: async () => ({ exitCode: 0 }),
          runCodeReviewFn: async () => ({
            status: 'ok',
            severity: { critical: 2, high: 1, medium: 0, suggestion: 0 },
            halted: true,
            blockerReason: 'code-review reported 2 critical blocker(s)',
            posted: true,
          }),
          runRetroFn: async () => {
            throw new Error('runRetro must not be called on critical halt');
          },
          runFinalizeFn: async () => {
            throw new Error('runFinalize must not be called on critical halt');
          },
        }),
      /Phase D halted/,
    );

    // Assert: exactly one epic.blocked event in the ledger — the bus is
    // the sole mutator of the Epic's blocked state.
    const records = readNdjson(writer.ledgerPath);
    const blockedEmits = records.filter(
      (r) => r.kind === 'emitted' && r.event === 'epic.blocked',
    );
    assert.equal(
      blockedEmits.length,
      1,
      `expected exactly one epic.blocked emit; got ${blockedEmits.length}`,
    );
    assert.equal(blockedEmits[0].payload.reason, 'critical-findings');

    // Assert: no direct label flip happened on the provider. The deleted
    // fallback in `markEpicBlockedForCriticalReview` would have called
    // `provider.updateTicket(epicId, { labels: { add: [BLOCKED], … } })`;
    // after the Story #2898 cutover, that path is gone and the only
    // `provider.*` call from the helper is the friction `postComment`.
    assert.equal(
      provider.updateTicketCalls.length,
      0,
      `close-tail must not issue direct provider.updateTicket calls on ` +
        `the critical-findings path; observed: ` +
        `${JSON.stringify(provider.updateTicketCalls)}`,
    );
  });
});
