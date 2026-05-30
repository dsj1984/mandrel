// tests/lib/orchestration/lifecycle/close-end-no-cascade.test.js
/**
 * Regression test for Story #3367 — `epic.close.end` MUST NOT cascade
 * into the auto-merge arm + branch reap.
 *
 * The bug: the Finalizer emitted `epic.merge.ready`, the SOLE event
 * AutomergeArmer subscribes to. AutomergeArmer's `epic.merge.armed`
 * then drove MergeWatcher → Cleaner → `epic.cleanup.start` →
 * BranchCleaner, which force-deleted the `epic/<id>` branch (local +
 * remote) BEFORE the PR was merged, and bypassed the AutomergePredicate
 * disqualification gate entirely (it only ever fires on
 * `epic.watch.end`).
 *
 * The fix: the Finalizer stops at `epic.finalize.end`. The auto-merge
 * arm flows ONLY through the gated watch path
 * (`pr.created` → Watcher → `epic.watch.end` → AutomergePredicate →
 * `epic.merge.ready` → AutomergeArmer).
 *
 * These tests wire the canonical default listener chain via
 * `buildDefaultListenerChain` (the standalone `lifecycle-emit` surface
 * that the #1241 repro used), drive `epic.close.end` against a
 * waiver-bearing Epic so the Finalizer runs, and assert that NONE of
 * `epic.merge.armed`, `epic.cleanup.start`, or `epic.complete` ever
 * fire — i.e. the destructive cascade is unreachable from
 * `epic.close.end`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { epicLedgerPath } from '../../../../.agents/scripts/lib/config/temp-paths.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { Finalizer } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';
import { buildDefaultListenerChain } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/index.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

describe('epic.close.end does not cascade to cleanup/arm (Story #3367)', () => {
  it('firing epic.close.end never reaches AutomergeArmer / Cleaner / BranchCleaner', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'close-end-no-cascade-'));
    const epicId = 33670;
    const ledgerPath = epicLedgerPath(epicId, {
      project: { paths: { tempRoot } },
    });
    // Waiver-bearing Epic so AcceptanceReconciler classifies `.waived`
    // and the Finalizer runs through to PR open.
    const fakeProvider = {
      async getTicket(id) {
        return { id, labels: ['acceptance::n-a'], body: '' };
      },
    };
    // Checkpointer present so BranchCleaner is constructed + subscribed —
    // if anything reaches `epic.cleanup.start`, BranchCleaner would fire.
    const reapCalls = [];
    const fakeCheckpointer = {
      read: async () => {
        reapCalls.push(Date.now());
        return { epicId, waves: [{ stories: [{ id: 1 }] }] };
      },
    };

    const bus = new Bus();
    const seen = new Set();
    for (const ev of [
      'epic.merge.ready',
      'epic.merge.armed',
      'epic.merge.confirmed',
      'epic.cleanup.start',
      'epic.cleanup.end',
      'epic.complete',
    ]) {
      bus.on(ev, async () => {
        seen.add(ev);
      });
    }

    try {
      const chain = await buildDefaultListenerChain({
        bus,
        ledgerPath,
        repoRoot: process.cwd(),
        provider: fakeProvider,
        checkpointer: fakeCheckpointer,
        config: { __tag: 'fake' },
        logger: quietLogger(),
      });
      assert.ok(
        chain.branchCleaner,
        'BranchCleaner is wired (would fire if reached)',
      );

      // Drive the Finalizer deterministically: register a spy Finalizer
      // whose runFinalizeFn returns a PR url (the production Finalizer in
      // the chain bails on its default no-op runFinalizeFn). This proves
      // the Finalizer reaching PR-open does NOT propagate to the arm.
      const spyFinalizer = new Finalizer({
        bus,
        epicId,
        cwd: process.cwd(),
        ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
        runFinalizeFn: async () => ({
          prNumber: 7,
          prUrl: `https://github.com/o/r/pull/7`,
        }),
        logger: quietLogger(),
      });
      spyFinalizer.register();

      await bus.emit('epic.close.end', { epicId });

      // The destructive tail MUST be unreachable from epic.close.end.
      assert.ok(
        !seen.has('epic.merge.ready'),
        'epic.merge.ready MUST NOT fire from the close-end path (no Watcher/predicate ran)',
      );
      assert.ok(
        !seen.has('epic.merge.armed'),
        'epic.merge.armed MUST NOT fire — AutomergeArmer is unreachable from epic.close.end',
      );
      assert.ok(
        !seen.has('epic.cleanup.start'),
        'epic.cleanup.start MUST NOT fire — Cleaner is unreachable from epic.close.end',
      );
      assert.ok(
        !seen.has('epic.complete'),
        'epic.complete MUST NOT fire from the close-end path',
      );
      assert.equal(
        reapCalls.length,
        0,
        'BranchCleaner.checkpointer.read() MUST NOT be called — reap never reached',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('the gated watch path still arms: epic.watch.end → predicate → merge.ready → armer', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'close-end-arm-path-'));
    const epicId = 33671;
    const ledgerPath = epicLedgerPath(epicId, {
      project: { paths: { tempRoot } },
    });
    const fakeProvider = {
      async getTicket(id) {
        return { id, labels: [], body: '' };
      },
    };

    const bus = new Bus();
    const armed = [];
    bus.on('epic.merge.armed', async (ctx) => armed.push(ctx.payload));

    try {
      const chain = await buildDefaultListenerChain({
        bus,
        ledgerPath,
        repoRoot: process.cwd(),
        provider: fakeProvider,
        // No checkpointer → BranchCleaner skipped (we are only proving the
        // arm fires on the gated path, not the reap).
        config: { __tag: 'fake' },
        logger: quietLogger(),
      });

      // The chain's production AutomergePredicate + AutomergeArmer are
      // wired. Stub the armer's gh shell-outs so the arm "succeeds"
      // without touching the network: probe reports not-armed, arm
      // reports success.
      chain.automergeArmer.ghPrViewAutoMergeFn = () => ({
        status: 0,
        stdout: JSON.stringify({ autoMergeRequest: null }),
        stderr: '',
      });
      chain.automergeArmer.ghPrMergeAutoFn = () => ({
        status: 0,
        stdout: '',
        stderr: '',
      });
      // Force the predicate verdict clean so it emits epic.merge.ready.
      chain.automergePredicate.evaluatePredicateFn = async () => ({
        clean: true,
        reasons: [],
        signals: {},
      });
      // MergeWatcher subscribes to epic.merge.armed and would otherwise
      // poll real `gh pr view` on a 30s cadence. Stub it to observe an
      // immediate merge so the awaited emit chain does not block.
      chain.mergeWatcher.ghPrViewMergeFn = () => ({
        status: 0,
        stdout: JSON.stringify({
          mergeCommit: { oid: 'deadbeef' },
          mergedAt: new Date().toISOString(),
          number: 7,
        }),
        stderr: '',
      });
      chain.mergeWatcher.sleepFn = async () => {};

      await bus.emit('epic.watch.end', {
        prUrl: `https://github.com/o/r/pull/7`,
        checkOutcomes: { lint: 'success', test: 'success' },
      });

      assert.equal(
        armed.length,
        1,
        'the gated watch path still arms auto-merge exactly once',
      );
      assert.equal(armed[0].prUrl, `https://github.com/o/r/pull/7`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
