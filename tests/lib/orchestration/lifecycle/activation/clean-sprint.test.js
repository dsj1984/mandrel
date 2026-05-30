// tests/lib/orchestration/lifecycle/activation/clean-sprint.test.js
/**
 * Clean-sprint activation contract for the wired close-tail listener
 * chain (Story #2343 / Task #2349, Epic #2306).
 *
 * Drives `bus.emit('epic.close.end', { epicId })` against the production
 * collaborator bag (via the clean-sprint fixture) and asserts:
 *
 *   1. The ledger records the full close-tail safety chain in canonical
 *      order with no extra events between. Because the bus is
 *      sequential-awaited, the order is depth-first: each `*.end` is
 *      emitted by its listener AFTER every transitively-triggered child
 *      listener has run to completion. The observed sequence is therefore
 *      acceptance.reconcile.ok → epic.finalize.start → pr.created →
 *      epic.watch.start → epic.watch.end → epic.merge.ready →
 *      epic.merge.armed → epic.cleanup.start → epic.cleanup.end →
 *      epic.complete → epic.finalize.end (epic.finalize.end fires last
 *      because Finalizer's handler awaits Watcher — which awaits every
 *      downstream listener — before reaching its own `.end` emit).
 *      Story #3367: the chain runs EXACTLY ONCE. The Finalizer no
 *      longer emits `epic.merge.ready`, so the dual-emit (one from the
 *      gated predicate, one from finalize) that previously recorded the
 *      arm + cleanup tail twice is gone. The sole `epic.merge.ready`
 *      emitter is AutomergePredicate (on the gated `epic.watch.end`).
 *
 *   2. The stubbed `gh pr view --json autoMergeRequest` probe is invoked
 *      exactly once via the AutomergeArmer listener path (one
 *      `epic.merge.ready` emit, from the predicate), confirming the
 *      arm path ran via the listener (not via a legacy CLI re-entry).
 *
 *   3. `gh pr merge --auto --squash --delete-branch` is issued exactly
 *      once across the run (AC-10 — at-most-once for irreversible ops).
 *
 *   4. The `lifecycle-diff --assert reconcile-ordering` and
 *      `--assert merge-gate-ordering` invariants pass against the
 *      resulting ledger. (The dedicated `lifecycle-diff-invariants.test.js`
 *      pins this from the CLI surface; this file pins it via the
 *      in-process assertion helpers so a single bus run validates both
 *      the in-process chain and the diff surface.)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { parseAutoMergeArmed } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js';
import {
  assertMergeGateOrdering,
  assertReconcileOrdering,
  parseLedgerText,
} from '../../../../../.agents/scripts/lifecycle-diff.js';
import {
  buildCleanSprintFixture,
  DEFAULT_PR_URL,
} from './fixtures/clean-sprint.fixture.js';

/**
 * Filter a parsed ledger down to the close-tail emit events. The
 * fixture's wildcard observers and registration-time debug emits do
 * not produce additional `emitted` records — the chain is exactly the
 * close-tail sequence — but the filter keeps the assertion crisp and
 * resilient to future no-op observer additions.
 */
const CLOSE_TAIL_EVENTS = Object.freeze([
  'epic.close.end',
  'acceptance.reconcile.start',
  'acceptance.reconcile.ok',
  'acceptance.reconcile.skipped',
  'acceptance.reconcile.failed',
  'epic.finalize.start',
  'pr.created',
  'epic.finalize.end',
  'epic.watch.start',
  'epic.watch.end',
  'epic.merge.ready',
  'epic.merge.blocked',
  'epic.merge.armed',
  'epic.cleanup.start',
  'epic.cleanup.end',
  'epic.complete',
  'epic.blocked',
]);

function readLedger(p) {
  return parseLedgerText(readFileSync(p, 'utf8'));
}

describe('clean-sprint activation — full close-tail ledger ordering', () => {
  let fixture;

  before(async () => {
    fixture = buildCleanSprintFixture();
    // Drive the chain. `bus.emit` is sequential-awaited, so by the time
    // this resolves the entire close-tail chain has settled.
    await fixture.bus.emit('epic.close.end', { epicId: fixture.epicId });
  });

  after(() => {
    fixture.cleanup();
  });

  it('records the canonical close-tail emit sequence with no extra events between', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const emittedEvents = ledger
      .filter(
        (r) => r.kind === 'emitted' && CLOSE_TAIL_EVENTS.includes(r.event),
      )
      .map((r) => r.event);

    // The expected order pins the actual production emit order. The
    // bus is sequential-awaited: when Finalizer emits `pr.created`,
    // Watcher (subscribed to that event) runs to completion before
    // control returns to Finalizer. Watcher in turn emits
    // `epic.watch.start`/`.end`, which drives AutomergePredicate →
    // AutomergeArmer → Cleaner — and Cleaner emits the terminal
    // `epic.cleanup.*` + `epic.complete` sequence. Only when that whole
    // depth-first chain unwinds does control return to Finalizer's
    // handler so it can emit `epic.finalize.end`. The Tech Spec's
    // notation "epic.finalize.end + pr.created" describes the pair
    // Finalizer emits (textually adjacent in its handler), but the bus
    // records the chain in the depth-first order the listeners actually
    // run — `epic.finalize.end` therefore lands LAST.
    // Story #3367 — the chain runs EXACTLY ONCE. Previously the
    // Finalizer emitted `epic.merge.ready` after `epic.finalize.end`,
    // which re-drove the arm + cleanup tail a SECOND time (bypassing the
    // AutomergePredicate disqualification gate). The Finalizer now stops
    // at `epic.finalize.end`; the sole `epic.merge.ready` emitter is
    // AutomergePredicate, fired depth-first from `pr.created` → Watcher
    // → `epic.watch.end`. `epic.finalize.end` still lands LAST because
    // Finalizer's handler awaits the entire Watcher-rooted subtree before
    // reaching its own `.end` emit. `epic.merge.confirmed` (MergeWatcher)
    // sits between `epic.merge.armed` and `epic.cleanup.start` but is not
    // in CLOSE_TAIL_EVENTS, so it is filtered out of this assertion.
    const expected = [
      'epic.close.end',
      'acceptance.reconcile.start',
      'acceptance.reconcile.ok',
      'epic.finalize.start',
      'pr.created',
      'epic.watch.start',
      'epic.watch.end',
      'epic.merge.ready',
      'epic.merge.armed',
      'epic.cleanup.start',
      'epic.cleanup.end',
      'epic.complete',
      'epic.finalize.end',
    ];
    assert.deepEqual(
      emittedEvents,
      expected,
      'close-tail ledger must record the canonical chain in order, with no extra events between',
    );

    // Strict monotonicity on seqIds — the bus assigns a fresh seqId per
    // emit, so each event in the chain MUST have a seqId strictly
    // greater than its predecessor.
    const closeTailRecords = ledger.filter(
      (r) => r.kind === 'emitted' && CLOSE_TAIL_EVENTS.includes(r.event),
    );
    for (let i = 1; i < closeTailRecords.length; i += 1) {
      assert.ok(
        closeTailRecords[i].seqId > closeTailRecords[i - 1].seqId,
        `seqId monotonicity violated between ${closeTailRecords[i - 1].event} (seqId=${closeTailRecords[i - 1].seqId}) and ${closeTailRecords[i].event} (seqId=${closeTailRecords[i].seqId})`,
      );
    }
  });

  it('records no acceptance.reconcile.failed and no epic.blocked on the clean path', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const emittedEvents = ledger
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    assert.equal(
      emittedEvents.filter((e) => e === 'acceptance.reconcile.failed').length,
      0,
      'no acceptance.reconcile.failed on a clean sprint',
    );
    assert.equal(
      emittedEvents.filter((e) => e === 'epic.blocked').length,
      0,
      'no epic.blocked on a clean sprint',
    );
    assert.equal(
      emittedEvents.filter((e) => e === 'epic.merge.blocked').length,
      0,
      'no epic.merge.blocked on a clean sprint',
    );
  });

  it('records pr.created carrying the canonical PR URL', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const prCreated = ledger.find(
      (r) => r.kind === 'emitted' && r.event === 'pr.created',
    );
    assert.ok(prCreated, 'pr.created emitted');
    assert.equal(prCreated.payload.prUrl, DEFAULT_PR_URL);
    assert.equal(prCreated.payload.head, `epic/${fixture.epicId}`);
    assert.equal(prCreated.payload.base, 'main');
  });

  it('records epic.complete carrying the canonical PR URL — the terminal event', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const complete = ledger.find(
      (r) => r.kind === 'emitted' && r.event === 'epic.complete',
    );
    assert.ok(complete, 'epic.complete emitted');
    assert.equal(complete.payload.epicId, fixture.epicId);
    assert.equal(complete.payload.prUrl, DEFAULT_PR_URL);
  });

  it('confirms stubbed gh pr view --json autoMergeRequest probes exactly once via the listener path', () => {
    // Story #3367 — there is now exactly ONE `epic.merge.ready` emit
    // (from AutomergePredicate, fired depth-first from `pr.created`),
    // so the AutomergeArmer cross-process probe
    // (`gh pr view --json autoMergeRequest`) runs ONCE:
    //   probeSequence[0] returns `autoMergeRequest: null`, so the
    //   listener issues `gh pr merge --auto`.
    // Net effect on GitHub: `gh pr merge --auto` is invoked exactly
    // once, which is the AC-10 at-most-once contract.
    assert.equal(
      fixture.stubs.counters.ghPrViewAutoMerge,
      1,
      'AutomergeArmer probed gh pr view --json autoMergeRequest exactly once (single epic.merge.ready emit)',
    );
    assert.equal(
      fixture.stubs.counters.ghPrMergeAuto,
      1,
      'AutomergeArmer issued gh pr merge --auto exactly once (AC-10 at-most-once)',
    );
    // The single probe reported NOT armed, which is why the arm fired.
    const armProbe = fixture.stubs.probeSequence[0];
    assert.ok(
      !parseAutoMergeArmed(armProbe.stdout),
      'the gh pr view --json autoMergeRequest probe reported autoMergeRequest is null (un-armed), triggering the arm',
    );
    assert.equal(
      fixture.stubs.calls.ghPrMergeAuto.length,
      1,
      'exactly one ghPrMergeAuto call captured in the spy log',
    );
    assert.equal(fixture.stubs.calls.ghPrMergeAuto[0].prUrl, DEFAULT_PR_URL);
  });

  it('satisfies lifecycle-diff --assert reconcile-ordering against the ledger', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const result = assertReconcileOrdering(ledger);
    assert.equal(result.ok, true, result.reason ?? 'reconcile-ordering passes');
  });

  it('satisfies lifecycle-diff --assert merge-gate-ordering against the ledger', () => {
    const ledger = readLedger(fixture.ledgerPath);
    const result = assertMergeGateOrdering(ledger);
    assert.equal(
      result.ok,
      true,
      result.reason ?? 'merge-gate-ordering passes',
    );
  });
});
