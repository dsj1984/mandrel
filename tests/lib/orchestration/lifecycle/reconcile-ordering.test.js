// tests/lib/orchestration/lifecycle/reconcile-ordering.test.js
/**
 * Repeatability invariant test for the reconcile → finalize gate
 * (Story #2253 / Task #2258, Epic #2172 review High-2).
 *
 * Asserts the cross-listener ordering contract that the lifecycle-diff
 * `--assert reconcile-ordering` check pins at PR-review time:
 *
 *   pr.created must be preceded by acceptance.reconcile.ok within the
 *   same run.
 *
 * Two ways of stating this contract:
 *   1. Healthy run with AcceptanceReconciler + Finalizer wired to a
 *      real `Bus` and `LedgerWriter`: the resulting NDJSON ledger MUST
 *      pass `assertReconcileOrdering`.
 *   2. Hand-rolled fixture ledger that emits `pr.created` BEFORE any
 *      `acceptance.reconcile.ok` line: `assertReconcileOrdering` MUST
 *      return `{ ok: false }` (the rule bites).
 *
 * Subscribers ordering — the Finalizer ONLY subscribes to
 * `acceptance.reconcile.ok`, so the contract is structurally
 * impossible to violate without an explicit Finalizer.handle() call
 * out of order. We exercise both the structural and the assertion
 * surfaces so a future refactor can't quietly weaken either.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { AcceptanceReconciler } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js';
import { Finalizer } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';
import {
  assertReconcileOrdering,
  parseLedgerText,
} from '../../../../.agents/scripts/lifecycle-diff.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

describe('reconcile-ordering invariant', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'reconcile-ordering-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lifecycle-diff --assert reconcile-ordering exits 0 for a healthy run', async () => {
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

    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({
        epicId: 2172,
        ffOk: true,
        pushed: true,
        prUrl: 'https://github.com/owner/repo/pull/42',
        prNumber: 42,
        postedHandoff: true,
      }),
      logger: quietLogger(),
    });
    finalizer.register();

    // Drive the close-tail emit; the reconciler picks it up and
    // cascades through to finalize.start → pr.created → finalize.end.
    await bus.emit('epic.close.end', { epicId: 2172 });

    const records = parseLedgerText(readFileSync(writer.ledgerPath, 'utf8'));
    const result = assertReconcileOrdering(records);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('lifecycle-diff --assert reconcile-ordering exits non-zero when invariant is violated', () => {
    // Hand-craft a ledger that emits pr.created WITHOUT a prior
    // acceptance.reconcile.ok — the rule's failing branch.
    const ledgerPath = path.join(tempRoot, 'violating.ndjson');
    const lines = [
      {
        kind: 'emitted',
        ts: '2026-05-17T00:00:00Z',
        seqId: 1,
        event: 'epic.close.end',
        payload: { epicId: 2172 },
      },
      {
        kind: 'emitted',
        ts: '2026-05-17T00:00:01Z',
        seqId: 2,
        event: 'pr.created',
        payload: {
          prUrl: 'https://github.com/o/r/pull/9',
          head: 'epic/2172',
          base: 'main',
        },
      },
    ];
    writeFileSync(
      ledgerPath,
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );

    const records = parseLedgerText(readFileSync(ledgerPath, 'utf8'));
    const result = assertReconcileOrdering(records);
    assert.equal(result.ok, false);
    assert.match(
      result.reason,
      /pr\.created.*without preceding acceptance\.reconcile\.ok/,
    );
  });

  it('emits acceptance.reconcile.ok BEFORE pr.created in the same run (seqId monotonic)', async () => {
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
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => ({
        prUrl: 'https://github.com/o/r/pull/3',
      }),
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const records = parseLedgerText(readFileSync(writer.ledgerPath, 'utf8'));
    const okRec = records.find(
      (r) => r.kind === 'emitted' && r.event === 'acceptance.reconcile.ok',
    );
    const prRec = records.find(
      (r) => r.kind === 'emitted' && r.event === 'pr.created',
    );
    assert.ok(okRec, 'acceptance.reconcile.ok was emitted');
    assert.ok(prRec, 'pr.created was emitted');
    assert.ok(
      okRec.seqId < prRec.seqId,
      `acceptance.reconcile.ok seqId=${okRec.seqId} must precede pr.created seqId=${prRec.seqId}`,
    );
  });

  it('failure path emits acceptance.reconcile.failed + epic.blocked and NO pr.created', async () => {
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 2172, tempRoot });
    writer.register(bus);

    const reconciler = new AcceptanceReconciler({
      bus,
      epicId: 2172,
      reconcileAcceptanceSpecFn: async () => ({
        status: 'gap',
        missing: ['AC-5'],
        pending: [],
      }),
      logger: quietLogger(),
    });
    reconciler.register();
    const finalizer = new Finalizer({
      bus,
      epicId: 2172,
      ghPrListHeadFn: () => ({ status: 0, stdout: '', stderr: '' }),
      runFinalizeFn: async () => {
        throw new Error('finalize should NOT run when reconcile failed');
      },
      logger: quietLogger(),
    });
    finalizer.register();

    await bus.emit('epic.close.end', { epicId: 2172 });

    const records = parseLedgerText(readFileSync(writer.ledgerPath, 'utf8'));
    const events = records
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    assert.ok(events.includes('acceptance.reconcile.failed'));
    assert.ok(events.includes('epic.blocked'));
    assert.ok(
      !events.includes('pr.created'),
      'no pr.created when reconciliation failed',
    );
    // The lifecycle-diff assertion vacuously passes when there's no
    // pr.created — that's the safety contract.
    const verdict = assertReconcileOrdering(records);
    assert.equal(verdict.ok, true);
  });
});
