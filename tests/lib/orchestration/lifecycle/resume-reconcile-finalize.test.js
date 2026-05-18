// tests/lib/orchestration/lifecycle/resume-reconcile-finalize.test.js
/**
 * Crash/resume tests for the reconcile → finalize chain
 * (Story #2253 / Task #2258, Epic #2172).
 *
 * The lifecycle bus ships an `onEmitted` hook that lets LedgerWriter
 * persist the `emitted` line BEFORE downstream listeners run — that's
 * the durability invariant the resume contract leans on. When a kill
 * lands between `acceptance.reconcile.ok` and Finalizer's
 * `pr.created`, the resumed run must:
 *
 *   1. Find the existing PR via `gh pr list --head epic/<id>` and
 *      short-circuit `gh pr create` (no duplicate PR).
 *   2. Append fresh records to the SAME ledger; the resumed suffix is
 *      structurally identical to a clean run (modulo `ts` and per-run
 *      `seqId`).
 *
 * We exercise the kill-between-gates scenario by:
 *
 *   - Running the reconciler-only on a real bus + writer so the
 *     `acceptance.reconcile.ok` `emitted` line lands on disk.
 *   - Force-throwing from a synthetic listener BEFORE Finalizer would
 *     have run — simulating the kernel kill.
 *   - Restarting: fresh Bus + Writer pointed at the SAME ledger path,
 *     wiring up both the reconciler AND the finalizer. The probe
 *     stub returns a previously-opened PR; the finalize-fn would
 *     throw if called.
 *   - Asserting: exactly one `pr.created` lands across both runs;
 *     `runFinalize` was never called.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { AcceptanceReconciler } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js';
import { Finalizer } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';
import { parseLedgerText } from '../../../../.agents/scripts/lifecycle-diff.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function eventsIn(records, name) {
  return records.filter((r) => r.kind === 'emitted' && r.event === name);
}

describe('resume across reconcile → finalize kill window', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'resume-reconcile-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('kill between acceptance.reconcile.ok and pr.created: resume opens NO duplicate PR', async () => {
    // ── Run 1 — partial ────────────────────────────────────────────────
    // Drive the reconciler with NO Finalizer registered, so the
    // ledger lands `acceptance.reconcile.ok` but no `pr.created`. The
    // bus's onEmitted hook persists the .ok line synchronously before
    // any listener runs, so dropping the Finalizer mid-run is the
    // cleanest simulation of a kernel-kill between the durable .ok
    // record and Finalizer's pr.created emit.
    const bus1 = new Bus();
    const writer1 = new LedgerWriter({ epicId: 2172, tempRoot });
    writer1.register(bus1);

    const reconciler1 = new AcceptanceReconciler({
      bus: bus1,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'ok' }),
      logger: quietLogger(),
    });
    reconciler1.register();

    await bus1.emit('epic.close.end', { epicId: 2172 });

    const writerPath = writer1.ledgerPath;
    const partial = parseLedgerText(readFileSync(writerPath, 'utf8'));
    assert.equal(
      eventsIn(partial, 'acceptance.reconcile.ok').length,
      1,
      'partial ledger carries the reconcile.ok emitted line',
    );
    assert.equal(
      eventsIn(partial, 'pr.created').length,
      0,
      'partial ledger has no pr.created (the kill point)',
    );

    // ── Run 2 — resume ─────────────────────────────────────────────────
    // Fresh bus + writer pointed at the SAME ledger path. The
    // `gh pr list --head` probe returns the URL of the PR that the
    // previous attempt (in a real scenario) might have opened just
    // before the crash — we want the Finalizer to short-circuit.
    const existingUrl = 'https://github.com/owner/repo/pull/777';
    let runFinalizeCalls = 0;
    const bus2 = new Bus();
    const writer2 = new LedgerWriter({ epicId: 2172, tempRoot });
    writer2.register(bus2);
    assert.equal(writer2.ledgerPath, writerPath, 'same ledger path');

    const reconciler2 = new AcceptanceReconciler({
      bus: bus2,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'ok' }),
      logger: quietLogger(),
    });
    reconciler2.register();

    const finalizer2 = new Finalizer({
      bus: bus2,
      epicId: 2172,
      ghPrListHeadFn: ({ epicBranch }) => {
        assert.equal(epicBranch, 'epic/2172');
        return { status: 0, stdout: `${existingUrl}\n`, stderr: '' };
      },
      runFinalizeFn: async () => {
        runFinalizeCalls += 1;
        throw new Error(
          'runFinalize must NOT be called when an existing PR is detected',
        );
      },
      logger: quietLogger(),
    });
    finalizer2.register();

    await bus2.emit('epic.close.end', { epicId: 2172 });

    const full = parseLedgerText(readFileSync(writerPath, 'utf8'));
    const prEmits = eventsIn(full, 'pr.created');
    // Across both runs, exactly one pr.created emit (Run 1 crashed
    // before; Run 2's short-circuit emit is the only one).
    assert.equal(prEmits.length, 1, 'exactly one pr.created across both runs');
    assert.equal(prEmits[0].payload.prUrl, existingUrl);
    assert.equal(runFinalizeCalls, 0, 'runFinalize never called');

    // Resume also fires epic.finalize.end with the same URL.
    const finalizeEnd = eventsIn(full, 'epic.finalize.end');
    assert.ok(finalizeEnd.length >= 1);
    assert.equal(
      finalizeEnd[finalizeEnd.length - 1].payload.prUrl,
      existingUrl,
    );
  });

  it('clean run (no kill) produces a single pr.created and the lifecycle-diff invariant passes', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);

    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({ status: 'ok' }),
      logger: quietLogger(),
    });
    reconciler.register();

    const fresh = 'https://github.com/owner/repo/pull/55';
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({ prUrl: fresh }),
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const records = parseLedgerText(readFileSync(writer.ledgerPath, 'utf8'));
    const prEmits = eventsIn(records, 'pr.created');
    assert.equal(prEmits.length, 1);
    assert.equal(prEmits[0].payload.prUrl, fresh);

    // The reconcile-ordering rule passes on the durable ledger.
    const okIdx = records.findIndex(
      (r) => r.kind === 'emitted' && r.event === 'acceptance.reconcile.ok',
    );
    const prIdx = records.findIndex(
      (r) => r.kind === 'emitted' && r.event === 'pr.created',
    );
    assert.ok(
      okIdx < prIdx,
      'acceptance.reconcile.ok strictly precedes pr.created',
    );
  });
});
