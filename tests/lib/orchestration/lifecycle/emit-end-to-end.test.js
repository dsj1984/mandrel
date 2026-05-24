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
import { Finalizer } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';
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
  it('emits acceptance.reconcile.{start,waived} for a waiver-bearing Epic', async () => {
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
        events.includes('acceptance.reconcile.waived'),
        'acceptance.reconcile.waived recorded (waiver path; Story #2893 split)',
      );
      assert.ok(
        !events.includes('acceptance.reconcile.skipped'),
        'acceptance.reconcile.skipped MUST NOT fire on the waiver path (Story #2893 split)',
      );

      // The waived record must carry the waiver reason.
      const waived = records.find(
        (r) =>
          r.event === 'acceptance.reconcile.waived' && r.kind === 'emitted',
      );
      assert.ok(waived, 'waived emitted record found');
      assert.equal(waived.payload.reason, 'waiver');
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

describe('lifecycle-emit end-to-end — full-roster PR-open fixture (Story #2531)', () => {
  it('fires Finalizer.createPullRequest exactly once and emits AutomergePredicate verdict per manualInterventions[]', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'lifecycle-emit-e2e-'));
    const epicId = 90003;
    const ledgerPath = epicLedgerPath(epicId, {
      project: { paths: { tempRoot } },
    });

    // Mocked provider — records every `createPullRequest` call so the
    // spy assertion can confirm Finalizer fired exactly once. The
    // `getTicket` stub returns the Epic with the waiver label so the
    // AcceptanceReconciler classifies as `.skipped` (waiver path); we
    // drive Finalizer directly off an explicit `acceptance.reconcile.ok`
    // emit below so the test owns the PR-open trigger deterministically.
    const createPullRequestCalls = [];
    const fakeProvider = {
      async getTicket(id) {
        return { id, labels: ['acceptance::n-a'], body: '' };
      },
      async createPullRequest(branchName, ticketId, baseBranch = 'main') {
        createPullRequestCalls.push({ branchName, ticketId, baseBranch });
        return { url: `https://example.test/${ticketId}/pr/1` };
      },
    };

    // Mocked checkpointer — BranchCleaner only needs a `read()` that
    // returns an object. Record reads so we can prove the chain
    // wiring honoured the checkpointer injection.
    const checkpointerReads = [];
    const fakeCheckpointer = {
      read: async () => {
        checkpointerReads.push(Date.now());
        return { phase: 'close-tail' };
      },
    };

    const fakeConfig = { __tag: 'fake-config' };

    const bus = new Bus();
    const mergeEmits = [];
    bus.on('epic.merge.ready', async (ctx) =>
      mergeEmits.push({ event: 'epic.merge.ready', payload: ctx.payload }),
    );
    bus.on('epic.merge.blocked', async (ctx) =>
      mergeEmits.push({ event: 'epic.merge.blocked', payload: ctx.payload }),
    );
    const prCreatedEmits = [];
    bus.on('pr.created', async (ctx) => prCreatedEmits.push(ctx.payload));

    try {
      // Wire the full canonical roster — provider + checkpointer +
      // config all present, so all eight listeners subscribe.
      const chain = await buildDefaultListenerChain({
        bus,
        ledgerPath,
        repoRoot: process.cwd(),
        provider: fakeProvider,
        checkpointer: fakeCheckpointer,
        config: fakeConfig,
        logger: quietLogger(),
      });
      assert.equal(
        chain.order.length,
        9,
        'all nine listeners subscribed (full roster; Story #2896 added MergeWatcher)',
      );

      // Register a parallel Finalizer with an injected `runFinalizeFn`
      // that calls our mocked `provider.createPullRequest`. This is
      // the spy seam — the chain's production Finalizer uses the
      // default no-op which would emit a `blocker` and skip the
      // `pr.created` emit, so the production wiring is exercised in
      // parallel (it lands a `blocker` classification) while the
      // injected Finalizer owns the happy-path `pr.created` emit.
      const spyFinalizer = new Finalizer({
        bus,
        epicId,
        cwd: process.cwd(),
        runFinalizeFn: async ({ epicId: eid }) => {
          const { url } = await fakeProvider.createPullRequest(
            `epic/${eid}`,
            eid,
            'main',
          );
          return { prUrl: url };
        },
        // Stub the `gh pr list` probe to report "no existing PR" so
        // the runFinalizeFn path runs instead of the short-circuit.
        ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
        logger: quietLogger(),
      });
      spyFinalizer.register();

      // Register a parallel AutomergePredicate driven by an injected
      // evaluator that consumes `state.manualInterventions[]`. The
      // fixture pins manualInterventions to a non-empty list so the
      // verdict is deterministically `blocked`.
      const fixtureState = {
        manualInterventions: [
          {
            ticketId: 2453,
            reason: 'host crashed mid-wave; resumed after manual cleanup',
            recordedAt: new Date().toISOString(),
          },
        ],
      };
      const blockingPredicate = new AutomergePredicate({
        bus,
        epicId,
        provider: fakeProvider,
        evaluatePredicateFn: async () => ({
          clean: fixtureState.manualInterventions.length === 0,
          reasons:
            fixtureState.manualInterventions.length > 0
              ? [
                  `manual interventions recorded (${fixtureState.manualInterventions.length}): #${fixtureState.manualInterventions[0].ticketId} — ${fixtureState.manualInterventions[0].reason}`,
                ]
              : [],
          signals: {
            interventionCount: fixtureState.manualInterventions.length,
            blockerEvents: 0,
            blockerEventTypes: [],
            blockerCorrelationIds: [],
          },
        }),
        logger: quietLogger(),
      });
      blockingPredicate.register();

      // Drive Finalizer by emitting the upstream `acceptance.reconcile.ok`.
      // Both the chain's production Finalizer and the spy Finalizer
      // subscribe; only the spy emits `pr.created` (the production one
      // bails on its default no-op `runFinalizeFn`).
      await bus.emit('acceptance.reconcile.ok', { baseRead: true });

      // Drive AutomergePredicate by emitting `epic.watch.end`. The
      // chain's production predicate fires (and emits its own verdict
      // through the runtime evaluator) AND the injected blocking
      // predicate fires; the spy captures whichever emits.
      await bus.emit('epic.watch.end', {
        prUrl: `https://example.test/${epicId}/pr/1`,
        checkOutcomes: { lint: 'success', test: 'success' },
      });

      // --- Finalizer spy: exactly one createPullRequest call ---
      assert.equal(
        createPullRequestCalls.length,
        1,
        `Finalizer.createPullRequest called exactly once (saw ${createPullRequestCalls.length})`,
      );
      assert.equal(createPullRequestCalls[0].branchName, `epic/${epicId}`);
      assert.equal(createPullRequestCalls[0].ticketId, epicId);

      // --- pr.created emit landed exactly once on the bus ---
      assert.equal(
        prCreatedEmits.length,
        1,
        `pr.created fired exactly once (saw ${prCreatedEmits.length})`,
      );
      assert.equal(
        prCreatedEmits[0].prUrl,
        `https://example.test/${epicId}/pr/1`,
      );

      // --- AutomergePredicate: exactly one of merge.ready/merge.blocked ---
      // The injected predicate sees a non-empty manualInterventions[]
      // → emits blocked. The production predicate's runtime evaluator
      // reads no on-disk run-state for this fixture; it may emit
      // either ready or blocked. The contract from the AC is: per
      // the fixture's manual-interventions state, AutomergePredicate
      // emits exactly one of merge.ready or merge.blocked per
      // predicate instance. The injected one is the deterministic
      // surface — assert it.
      const blocked = mergeEmits.filter(
        (e) => e.event === 'epic.merge.blocked',
      );
      assert.ok(
        blocked.length >= 1,
        `at least one epic.merge.blocked emit fired (saw ${blocked.length})`,
      );
      const interventionBlocked = blocked.find((e) =>
        /manual interventions/i.test(e.payload?.reason ?? ''),
      );
      assert.ok(
        interventionBlocked,
        `blocked emit cites manual interventions; saw ${blocked
          .map((e) => e.payload?.reason)
          .join(' | ')}`,
      );

      // --- Ledger persists pr.created plus epic.merge.blocked ---
      // LedgerWriter is wired through the privileged hook seam so
      // every emit lands on disk; the close-tail trace replays cleanly.
      const records = readLedger(ledgerPath);
      const events = records.map((r) => r.event);
      assert.ok(events.includes('pr.created'), 'pr.created recorded in ledger');
      assert.ok(
        events.includes('epic.merge.blocked'),
        'epic.merge.blocked recorded in ledger',
      );

      // --- Checkpointer was reachable from BranchCleaner subscription ---
      // BranchCleaner subscribes to `epic.cleanup.start`; we do not
      // drive that here (the test pins the AutomergePredicate path),
      // but the chain MUST have constructed BranchCleaner with our
      // injected checkpointer. Assert the chain handle exposes it.
      assert.ok(
        chain.branchCleaner,
        'BranchCleaner constructed with injected checkpointer',
      );
      assert.strictEqual(chain.branchCleaner.checkpointer, fakeCheckpointer);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('emits epic.merge.ready when manualInterventions[] is empty (clean fixture)', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'lifecycle-emit-e2e-'));
    const epicId = 90004;
    const ledgerPath = epicLedgerPath(epicId, {
      project: { paths: { tempRoot } },
    });

    const fakeProvider = {
      async getTicket(id) {
        return { id, labels: [], body: '' };
      },
    };

    const bus = new Bus();
    const mergeEmits = [];
    bus.on('epic.merge.ready', async (ctx) =>
      mergeEmits.push({ event: 'epic.merge.ready', payload: ctx.payload }),
    );
    bus.on('epic.merge.blocked', async (ctx) =>
      mergeEmits.push({ event: 'epic.merge.blocked', payload: ctx.payload }),
    );

    try {
      await buildDefaultListenerChain({
        bus,
        ledgerPath,
        repoRoot: process.cwd(),
        provider: fakeProvider,
        checkpointer: { read: async () => ({}) },
        config: { __tag: 'fake-config' },
        logger: quietLogger(),
      });

      // Inject a clean-verdict predicate. State has no manual
      // interventions → clean: true → `epic.merge.ready`.
      const cleanPredicate = new AutomergePredicate({
        bus,
        epicId,
        provider: fakeProvider,
        evaluatePredicateFn: async () => ({
          clean: true,
          reasons: [],
          signals: {
            interventionCount: 0,
            blockerEvents: 0,
            blockerEventTypes: [],
            blockerCorrelationIds: [],
          },
        }),
        logger: quietLogger(),
      });
      cleanPredicate.register();

      await bus.emit('epic.watch.end', {
        prUrl: `https://example.test/${epicId}/pr/1`,
        checkOutcomes: { lint: 'success', test: 'success' },
      });

      const ready = mergeEmits.filter((e) => e.event === 'epic.merge.ready');
      assert.ok(
        ready.length >= 1,
        `at least one epic.merge.ready emit fired on the clean fixture (saw ${ready.length})`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
