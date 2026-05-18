// tests/lib/orchestration/lifecycle/emit-end-to-end.test.js
/**
 * Integration tests for the standalone lifecycle-emit surface
 * (Story #2510 / Task #2518, Epic #2501).
 *
 * The tests assemble a real bus, wire the canonical listener chain via
 * `buildDefaultListenerChain`, and emit `epic.close.end` against a
 * fixture Epic. They assert the on-disk ledger receives the documented
 * downstream events — proving the wiring is live end-to-end.
 *
 * Two paths are exercised:
 *
 *   1. Waiver path — the fake provider returns `acceptance::n-a` on the
 *      fixture Epic. The AcceptanceReconciler emits
 *      `acceptance.reconcile.start` + `acceptance.reconcile.skipped`
 *      and the bus persists both records to `lifecycle.ndjson`.
 *
 *   2. Predicate-blocked path — the AutomergePredicate listener is
 *      driven directly with `state.manualInterventions[]` non-empty.
 *      The listener emits `epic.merge.blocked` carrying the
 *      manual-intervention reason. A spy on `bus.on('epic.merge.blocked')`
 *      confirms the emit shape.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { epicLedgerPath } from '../../../../.agents/scripts/lib/config/temp-paths.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AutomergePredicate } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';
import { buildDefaultListenerChain } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/index.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Read the on-disk NDJSON ledger into an array of records. Empty when
 * the writer has not run yet.
 */
function readLedger(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('lifecycle-emit end-to-end — waiver path', () => {
  it('emits acceptance.reconcile.{start,skipped} for a waiver-bearing Epic', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'lifecycle-emit-e2e-'));
    const epicId = 90001;
    const ledgerPath = epicLedgerPath(epicId, {
      project: { paths: { tempRoot } },
    });
    // Fake provider — returns the Epic with the waiver label so the
    // AcceptanceReconciler classifies the run as `.skipped` (waiver).
    const fakeProvider = {
      async getTicket(id) {
        if (id === epicId) {
          return { id, labels: ['acceptance::n-a'], body: '' };
        }
        return null;
      },
    };

    const bus = new Bus();
    try {
      await buildDefaultListenerChain({
        bus,
        ledgerPath,
        repoRoot: process.cwd(),
        provider: fakeProvider,
        logger: quietLogger(),
      });

      await bus.emit('epic.close.end', { epicId });

      const records = readLedger(ledgerPath);
      const events = records.map((r) => r.event);

      // Every emit produces an `emitted` + `completed` pair, so the
      // event names appear twice. We just need each canonical event
      // present at least once.
      assert.ok(
        events.includes('epic.close.end'),
        'epic.close.end recorded in ledger',
      );
      assert.ok(
        events.includes('acceptance.reconcile.start'),
        'acceptance.reconcile.start recorded',
      );
      assert.ok(
        events.includes('acceptance.reconcile.skipped'),
        'acceptance.reconcile.skipped recorded (waiver path)',
      );

      // The skipped record must carry the waiver reason.
      const skipped = records.find(
        (r) =>
          r.event === 'acceptance.reconcile.skipped' && r.kind === 'emitted',
      );
      assert.ok(skipped, 'skipped emitted record found');
      assert.equal(skipped.payload.reason, 'waiver');

      // Finalizer subscribes ONLY to `acceptance.reconcile.ok`, so the
      // waiver path must NOT have triggered any pr.created emit.
      assert.equal(
        events.includes('pr.created'),
        false,
        'pr.created MUST NOT fire on the waiver path',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('lifecycle-emit end-to-end — AutomergePredicate blocked path', () => {
  it('emits epic.merge.blocked when state.manualInterventions[] is non-empty', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'lifecycle-emit-e2e-'));
    const epicId = 90002;
    const ledgerPath = epicLedgerPath(epicId, {
      project: { paths: { tempRoot } },
    });

    // Fake provider — minimal getTicket implementation for the Epic
    // (the predicate evaluator's stub reads no labels from it here;
    // the verdict comes from the injected `evaluatePredicateFn`).
    const fakeProvider = {
      async getTicket(id) {
        return { id, labels: [], body: '' };
      },
    };

    const bus = new Bus();
    // Spy: record every epic.merge.{ready,blocked} emit shape.
    const mergeEmits = [];
    bus.on('epic.merge.ready', async (ctx) =>
      mergeEmits.push({ event: 'epic.merge.ready', payload: ctx.payload }),
    );
    bus.on('epic.merge.blocked', async (ctx) =>
      mergeEmits.push({ event: 'epic.merge.blocked', payload: ctx.payload }),
    );

    try {
      // Wire the default chain so the ledger is persistent and the
      // close-tail listeners cooperate as in production. We do NOT
      // pass a checkpointer (BranchCleaner skipped) and the chain's
      // AutomergePredicate uses the production evaluator — we shadow
      // it below with a hand-built predicate carrying an injected
      // evaluator so the verdict is deterministic.
      await buildDefaultListenerChain({
        bus,
        ledgerPath,
        repoRoot: process.cwd(),
        provider: fakeProvider,
        logger: quietLogger(),
      });

      // Replace the chain's predicate with one whose evaluator
      // pretends `state.manualInterventions[]` is non-empty so the
      // verdict deterministically reports `blocked`. The chain's
      // production predicate is still subscribed; we register an
      // additional predicate alongside it to drive the blocked path
      // through the injected evaluator. The bus runs listeners in
      // registration order; both fire, and the spy captures whichever
      // verdict the additional predicate emits.
      const blockingPredicate = new AutomergePredicate({
        bus,
        epicId,
        provider: fakeProvider,
        evaluatePredicateFn: async () => ({
          clean: false,
          reasons: [
            'manual interventions recorded (1): #2453 — host crashed mid-wave',
          ],
          signals: {
            interventionCount: 1,
            blockerEvents: 0,
            blockerEventTypes: [],
            blockerCorrelationIds: [],
          },
        }),
        logger: quietLogger(),
      });
      blockingPredicate.register();

      // Drive the predicate by emitting `epic.watch.end`. The chain's
      // production predicate ALSO fires — its real evaluator will
      // attempt a `gh` shell-out that throws because there's no PR
      // url in the payload. The listener swallows that internally
      // (it emits `epic.merge.blocked` carrying the failure reason)
      // so the ledger still records a blocked emit either way.
      await bus.emit('epic.watch.end', {
        prUrl: 'https://example.com/pr/1',
        checkOutcomes: { lint: 'success', test: 'success' },
      });

      // At least one `epic.merge.blocked` emit must have fired.
      const blocked = mergeEmits.filter(
        (e) => e.event === 'epic.merge.blocked',
      );
      const ready = mergeEmits.filter((e) => e.event === 'epic.merge.ready');
      // The acceptance contract: when manualInterventions[] is non-empty
      // we MUST see at least one epic.merge.blocked emit. Either the
      // additional injected predicate or the production predicate (which
      // reads the runtime epic-run-state) may emit it; what matters is
      // the listener fired on the blocked path.
      assert.ok(
        blocked.length >= 1,
        `epic.merge.blocked fired at least once (ready=${ready.length}, blocked=${blocked.length})`,
      );
      // The injected predicate's evaluator returned a manual-intervention
      // reason — at least one blocked emit MUST carry a non-empty reason
      // (the schema enforces this, but assert the spy view too).
      for (const emit of blocked) {
        assert.ok(
          typeof emit.payload?.reason === 'string' &&
            emit.payload.reason.length > 0,
          'every epic.merge.blocked emit carries a non-empty reason',
        );
      }
      const interventionBlocked = blocked.find((e) =>
        /manual interventions/i.test(e.payload?.reason ?? ''),
      );
      assert.ok(
        interventionBlocked,
        `at least one blocked emit cites manual interventions; saw reasons: ${blocked
          .map((e) => e.payload?.reason)
          .join(' | ')}`,
      );

      // The ledger should also carry the blocked record (LedgerWriter
      // is wired through the privileged hook seam).
      const records = readLedger(ledgerPath);
      const events = records.map((r) => r.event);
      assert.ok(
        events.includes('epic.merge.blocked'),
        'epic.merge.blocked recorded in ledger',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
