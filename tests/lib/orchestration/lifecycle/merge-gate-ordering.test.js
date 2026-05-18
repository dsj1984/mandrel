// tests/lib/orchestration/lifecycle/merge-gate-ordering.test.js
/**
 * Contract test for the merge-gate-ordering invariant
 * (Story #2256 / Task #2263 / Epic #2172).
 *
 * Two invariants are asserted, both load-bearing for the merge-gate
 * safety chain that Wave 7 ships:
 *
 *   1. **Ordering**: every `epic.merge.armed` event in a lifecycle
 *      ledger MUST be preceded by an `epic.merge.ready` event from the
 *      same run. The Acceptance Predicate is the ONLY emitter of
 *      `epic.merge.ready`; the AutomergeArmer is the ONLY listener
 *      subscribed to it. If `epic.merge.armed` lands without a prior
 *      `epic.merge.ready`, the safety gate has been bypassed and the
 *      run is unsafe to merge.
 *
 *      This is asserted by `assertMergeGateOrdering` — a pure helper
 *      that walks a ledger record array and returns `{ ok, violations }`.
 *      The healthy fixture passes; a synthetic armed-before-ready
 *      ledger fails with a non-empty violation list.
 *
 *   2. **Sole caller**: the literal `gh pr merge` MUST appear in
 *      production code at exactly one path —
 *      `.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js`.
 *      This is the repo-wide grep that the merge-lockout ESLint rule
 *      (in `check-lifecycle-lint.js`) enforces; this test is the
 *      independent contract-tier backstop that catches drift if the
 *      lockout rule is accidentally loosened.
 *
 * Fixtures live inline (no on-disk artifacts) — both invariants are
 * checked against synthetic, well-typed ledger record arrays so the
 * test is hermetic and CI-stable.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findMergeLockoutViolations,
  stripComments,
} from '../../../../.agents/scripts/check-lifecycle-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');

/**
 * Pure: walk a ledger record array (chronological) and verify that
 * every `epic.merge.armed` event was preceded by an `epic.merge.ready`
 * event in the SAME run. Exported here as a local helper because the
 * ordering invariant has no production caller yet — the contract test
 * is the canonical consumer.
 *
 * Returns `{ ok: boolean, violations: Array<{ seqId, reason }> }`.
 */
export function assertMergeGateOrdering(records) {
  const violations = [];
  const reportedSeqIds = new Set();
  let readySeen = false;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    // Only `completed` records count as a fully-landed ready emit —
    // `emitted` alone (without `completed`) means the bus crashed
    // mid-handler, and a `failed` record means the listener threw.
    // Neither is a safe predecessor for an arm.
    if (r.event === 'epic.merge.ready' && r.kind === 'completed') {
      readySeen = true;
    }
    if (r.event === 'epic.merge.armed' && r.kind !== 'failed') {
      const seqKey = String(r.seqId ?? '');
      if (!readySeen && !reportedSeqIds.has(seqKey)) {
        reportedSeqIds.add(seqKey);
        violations.push({
          seqId: r.seqId ?? null,
          reason: 'epic.merge.armed without preceding epic.merge.ready',
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Build a synthetic healthy ledger: pr.created → epic.watch.start →
 * epic.watch.end → epic.merge.ready → epic.merge.armed. Each record
 * has the minimum shape the assertion walks.
 */
function healthyLedger() {
  return [
    { kind: 'emitted', event: 'pr.created', seqId: 1 },
    { kind: 'completed', event: 'pr.created', seqId: 1 },
    { kind: 'emitted', event: 'epic.watch.start', seqId: 2 },
    { kind: 'completed', event: 'epic.watch.start', seqId: 2 },
    { kind: 'emitted', event: 'epic.watch.end', seqId: 3 },
    { kind: 'completed', event: 'epic.watch.end', seqId: 3 },
    { kind: 'emitted', event: 'epic.merge.ready', seqId: 4 },
    { kind: 'completed', event: 'epic.merge.ready', seqId: 4 },
    { kind: 'emitted', event: 'epic.merge.armed', seqId: 5 },
    { kind: 'completed', event: 'epic.merge.armed', seqId: 5 },
  ];
}

/**
 * Synthetic bypassed ledger — `epic.merge.armed` lands WITHOUT a
 * preceding `epic.merge.ready`. The invariant must reject this.
 */
function armedWithoutReadyLedger() {
  return [
    { kind: 'emitted', event: 'pr.created', seqId: 1 },
    { kind: 'completed', event: 'pr.created', seqId: 1 },
    { kind: 'emitted', event: 'epic.merge.armed', seqId: 2 },
    { kind: 'completed', event: 'epic.merge.armed', seqId: 2 },
  ];
}

describe('assertMergeGateOrdering (lifecycle invariant)', () => {
  it('returns ok:true for a healthy fixture', () => {
    const out = assertMergeGateOrdering(healthyLedger());
    assert.equal(out.ok, true);
    assert.deepEqual(out.violations, []);
  });

  it('flags an armed-before-ready ledger as a violation', () => {
    const out = assertMergeGateOrdering(armedWithoutReadyLedger());
    assert.equal(out.ok, false);
    assert.equal(out.violations.length, 1);
    assert.match(
      out.violations[0].reason,
      /epic\.merge\.armed without preceding epic\.merge\.ready/,
    );
  });

  it('flags an armed event that only follows a FAILED ready emit', () => {
    // `kind: 'failed'` records mean the ready handler threw; the
    // matching `armed` afterwards is still a violation because no
    // green-path ready was ever completed.
    const ledger = [
      { kind: 'emitted', event: 'epic.merge.ready', seqId: 1 },
      { kind: 'failed', event: 'epic.merge.ready', seqId: 1 },
      { kind: 'emitted', event: 'epic.merge.armed', seqId: 2 },
    ];
    const out = assertMergeGateOrdering(ledger);
    assert.equal(out.ok, false);
    assert.equal(out.violations.length, 1);
  });

  it('passes when ready precedes armed even with intervening events', () => {
    const ledger = [
      { kind: 'emitted', event: 'epic.merge.ready', seqId: 1 },
      { kind: 'completed', event: 'epic.merge.ready', seqId: 1 },
      { kind: 'emitted', event: 'notification.emitted', seqId: 2 },
      { kind: 'emitted', event: 'checkpoint.written', seqId: 3 },
      { kind: 'emitted', event: 'epic.merge.armed', seqId: 4 },
    ];
    const out = assertMergeGateOrdering(ledger);
    assert.equal(out.ok, true);
  });
});

describe('merge-gate-ordering: gh pr merge appears only in automerge-armer.js', () => {
  it('repo-wide grep confirms the literal is confined to the armer', () => {
    // The lint backstop already enforces this at `npm run lint`
    // time; this contract test calls the same helper independently
    // so a future divergence between lint and contract is caught.
    // Match the SCRIPTS_DIR scope the production lint runner uses
    // (`check-lifecycle-lint.js` main()) so the contract test
    // checks the same surface the merge-lockout rule enforces.
    const violations = findMergeLockoutViolations(SCRIPTS_DIR, {
      read: readFileSync,
    });
    assert.equal(
      violations.length,
      0,
      `expected zero merge-lockout violations; got ${violations.length}:\n${violations
        .map((v) => `  ${v.file}:${v.line} — ${v.hint}`)
        .join('\n')}`,
    );
  });

  it('automerge-armer.js itself DOES contain the literal (production sanity)', () => {
    // The whole point of the lockout is that ONE file legitimately
    // calls `gh pr merge`. If the armer doesn't carry the literal
    // anymore, the safety chain is broken in the other direction —
    // the listener can't arm. This sanity assertion catches a
    // pathological refactor that deletes the call site.
    const armerPath = path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'lifecycle',
      'listeners',
      'automerge-armer.js',
    );
    const text = readFileSync(armerPath, 'utf8');
    const stripped = stripComments(text);
    assert.match(
      stripped,
      /gh.*pr.*merge/,
      'automerge-armer.js MUST contain a gh pr merge call site',
    );
  });
});
