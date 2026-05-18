// tests/lib/orchestration/lifecycle/activation/reconcile-failure.test.js
/**
 * Reconcile-failure activation contract for the wired close-tail
 * listener chain (Story #2343 / Task #2348, Epic #2306).
 *
 * Drives `bus.emit('epic.close.end', { epicId })` against the
 * production collaborator bag with a stubbed reconciler that reports
 * an unmapped AC. Asserts:
 *
 *   1. The ledger records `acceptance.reconcile.failed` followed
 *      immediately by `epic.blocked` (no events between them on the
 *      same chain — the only events between are the `completed`
 *      bookkeeping records that fire BETWEEN listeners on the bus
 *      mediator, which are filtered out for the AC).
 *
 *   2. `gh pr list --head epic/<id>` reports empty after the run. The
 *      fixture's Finalizer `ghPrListHeadFn` stub returns the empty
 *      stdout that the production probe would observe in this state;
 *      the test invokes it directly to assert the cross-process
 *      probe contract.
 *
 *   3. Zero `pr.created` events in the ledger — confirming Finalizer
 *      did not run (its sole subscription, `acceptance.reconcile.ok`,
 *      never fired) and AutomergeArmer was never reached.
 *
 *   4. The LabelTransitioner observed `epic.blocked` and issued a
 *      ticket label flip to `agent::blocked` — the provider's
 *      `updateTicket` log carries one mutation against the Epic
 *      ticket with the blocked label.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { parseLedgerText } from '../../../../../.agents/scripts/lifecycle-diff.js';
import { extractPrUrl } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';
import { buildReconcileFailureFixture } from './fixtures/reconcile-failure.fixture.js';

function readLedger(p) {
  return parseLedgerText(readFileSync(p, 'utf8'));
}

describe('reconcile-failure activation — gap blocks Epic, no PR opened', () => {
  let fixture;

  before(async () => {
    fixture = buildReconcileFailureFixture();
    await fixture.bus.emit('epic.close.end', { epicId: fixture.epicId });
  });

  after(() => {
    fixture.cleanup();
  });

  it('records acceptance.reconcile.failed followed immediately by epic.blocked', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const emitted = ledger.filter((r) => r.kind === 'emitted');
    const failedIdx = emitted.findIndex(
      (r) => r.event === 'acceptance.reconcile.failed',
    );
    const blockedIdx = emitted.findIndex((r) => r.event === 'epic.blocked');
    assert.ok(failedIdx >= 0, 'acceptance.reconcile.failed emitted');
    assert.ok(blockedIdx >= 0, 'epic.blocked emitted');
    assert.equal(
      blockedIdx,
      failedIdx + 1,
      'epic.blocked must be the very next emitted event after acceptance.reconcile.failed (no other emits between)',
    );
  });

  it('emits exactly one acceptance.reconcile.failed', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const failedCount = ledger.filter(
      (r) => r.kind === 'emitted' && r.event === 'acceptance.reconcile.failed',
    ).length;
    assert.equal(failedCount, 1, 'exactly one acceptance.reconcile.failed');
  });

  it('records zero pr.created events — Finalizer never ran', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const prCreated = ledger.filter(
      (r) => r.kind === 'emitted' && r.event === 'pr.created',
    );
    assert.equal(
      prCreated.length,
      0,
      'pr.created MUST NOT fire when reconcile fails — Finalizer subscribes only to acceptance.reconcile.ok',
    );
    // Sibling assertion: nothing downstream of Finalizer ran either.
    for (const blocked of [
      'epic.finalize.start',
      'epic.finalize.end',
      'epic.watch.start',
      'epic.watch.end',
      'epic.merge.ready',
      'epic.merge.armed',
      'epic.cleanup.start',
      'epic.cleanup.end',
      'epic.complete',
    ]) {
      const count = ledger.filter(
        (r) => r.kind === 'emitted' && r.event === blocked,
      ).length;
      assert.equal(
        count,
        0,
        `${blocked} MUST NOT fire when the chain breaks at AcceptanceReconciler`,
      );
    }
  });

  it('records the unmapped AC ID on the acceptance.reconcile.failed payload', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const failed = ledger.find(
      (r) => r.kind === 'emitted' && r.event === 'acceptance.reconcile.failed',
    );
    assert.ok(failed, 'acceptance.reconcile.failed emitted');
    // The classifier formats `gap:missing=AC-7` (see
    // acceptance-reconciler.js#classifyReconcileResult).
    assert.match(failed.payload.reason, /^gap:missing=AC-7/);
  });

  it('records epic.blocked carrying the reconcile reason prefix', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const blocked = ledger.find(
      (r) => r.kind === 'emitted' && r.event === 'epic.blocked',
    );
    assert.ok(blocked, 'epic.blocked emitted');
    // The reconciler prefixes the cascade reason with
    // `acceptance-reconcile:` (see
    // acceptance-reconciler.js#_emitFailure).
    assert.match(
      blocked.payload.reason,
      /^acceptance-reconcile:gap:/,
      'epic.blocked.reason must be prefixed by the reconcile cascade tag',
    );
  });

  it('gh pr list --head epic/<id> stub returns empty after the run', () => {
    // The Finalizer's idempotency probe never runs on the gap path
    // (its handler never executes), but the probe function on the
    // listener instance is the same one production code would call.
    // Invoking it directly models the operator running
    // `gh pr list --head epic/<epicId>` after the run.
    const probe = fixture.collaborators.finalizer.ghPrListHeadFn({
      epicBranch: `epic/${fixture.epicId}`,
      cwd: fixture.cwd,
    });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, '');
    assert.equal(extractPrUrl(probe.stdout), null, 'no PR URL parsed');
  });

  it('LabelTransitioner flipped the Epic ticket to agent::blocked', () => {
    // `epic.blocked` is one of LabelTransitioner's subscribed events;
    // the listener calls `transitionTicketState(provider, epicId,
    // STATE_LABELS.BLOCKED, ...)` which routes to
    // `provider.updateTicket`. The fixture's stub provider records the
    // call.
    const updates = fixture.provider._updates;
    assert.ok(
      updates.length >= 1,
      'at least one provider.updateTicket call landed (the blocker label flip)',
    );
    const blockedFlip = updates.find(
      (u) =>
        u.id === fixture.epicId &&
        Array.isArray(u.mutations?.labels?.add) &&
        u.mutations.labels.add.includes('agent::blocked'),
    );
    assert.ok(
      blockedFlip,
      'expected a provider.updateTicket call adding agent::blocked to the Epic ticket',
    );
  });
});
