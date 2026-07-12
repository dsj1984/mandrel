/**
 * ledger-diff.js — structural-diff and ordering-assertion helpers over a
 * lifecycle ledger (`temp/epic-<id>/lifecycle.ndjson`) for the
 * repeatability invariants.
 *
 * Relocated from the retired `.agents/scripts/lifecycle-diff.js` CLI
 * (#4482): the assertion helpers are the live surface — they pin the
 * cross-listener ordering contracts in the lifecycle invariant tests —
 * while the CLI wrapper had no workflow, script, or CI consumer.
 *
 * Invariants are derived from Tech Spec #2189 § Repeatability Acceptance
 * Criteria.
 */

/**
 * Parse an NDJSON lifecycle ledger into an array of records. Blank
 * lines tolerated; malformed JSON throws with line number. Duplicated
 * from `trace-logger.js` to keep the diff surface decoupled from the
 * listener surface.
 */
export function parseLedgerText(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_err) {
      throw new Error(
        `ledger-diff: malformed JSON in ledger on line ${i + 1}: ${line.slice(0, 80)}`,
      );
    }
  }
  return out;
}

/**
 * Project a single record into a comparison key. `ts` and `seqId` are
 * intentionally elided; the rest of the record is included so that the
 * structural shape (event order, payload contents, listener attribution
 * on failed records) is the diff surface.
 *
 * Exported for unit tests that pin the diff contract.
 */
export function projectRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const { ts: _ts, seqId: _seqId, ...rest } = rec;
  return rest;
}

/**
 * Structural diff of two ledger arrays. Returns an array of mismatch
 * descriptors (empty when identical modulo `ts`/`seqId`).
 */
export function diff(ledgerA, ledgerB) {
  const a = ledgerA.map(projectRecord);
  const b = ledgerB.map(projectRecord);
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    if (leftJson !== rightJson) {
      out.push({ index: i, left: left ?? null, right: right ?? null });
    }
  }
  return out;
}

/**
 * Assert: epic.merge.armed must be preceded by epic.merge.ready
 * (same run). Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function assertMergeGateOrdering(records) {
  let sawReady = false;
  let sawReadySeq = null;
  for (const rec of records) {
    if (rec.kind !== 'emitted') continue;
    if (rec.event === 'epic.merge.ready') {
      sawReady = true;
      sawReadySeq = rec.seqId;
    } else if (rec.event === 'epic.merge.armed') {
      if (!sawReady) {
        return {
          ok: false,
          reason: `epic.merge.armed at seqId=${rec.seqId} without preceding epic.merge.ready`,
        };
      }
      if (sawReadySeq != null && rec.seqId <= sawReadySeq) {
        return {
          ok: false,
          reason: `epic.merge.armed seqId=${rec.seqId} must be > epic.merge.ready seqId=${sawReadySeq}`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Assert: pr.created must be preceded by either acceptance.reconcile.ok
 * or acceptance.reconcile.waived in the same run. Story #2893 split the
 * waiver path out of `.skipped` so the Finalizer now subscribes to both
 * `.ok` and `.waived`; either is a valid predecessor for pr.created.
 * A reconcile.skipped (empty-spec only after #2893) or reconcile.failed
 * before pr.created remains a violation.
 */
export function assertReconcileOrdering(records) {
  let sawReconcileGate = false;
  let sawReconcileGateSeq = null;
  let sawReconcileGateEvent = null;
  for (const rec of records) {
    if (rec.kind !== 'emitted') continue;
    if (
      rec.event === 'acceptance.reconcile.ok' ||
      rec.event === 'acceptance.reconcile.waived'
    ) {
      sawReconcileGate = true;
      sawReconcileGateSeq = rec.seqId;
      sawReconcileGateEvent = rec.event;
    } else if (rec.event === 'pr.created') {
      if (!sawReconcileGate) {
        return {
          ok: false,
          reason: `pr.created at seqId=${rec.seqId} without preceding acceptance.reconcile.ok or acceptance.reconcile.waived`,
        };
      }
      if (sawReconcileGateSeq != null && rec.seqId <= sawReconcileGateSeq) {
        return {
          ok: false,
          reason: `pr.created seqId=${rec.seqId} must be > ${sawReconcileGateEvent} seqId=${sawReconcileGateSeq}`,
        };
      }
    }
  }
  return { ok: true };
}
