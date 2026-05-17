// .agents/scripts/lib/orchestration/lifecycle/legacy-resume.js
/**
 * Legacy-resume adapter (Story #2266 / Task #2269, Epic #2172).
 *
 * One-shot migration path for Epics that were mid-flight when the
 * cutover from the legacy structured-comment checkpointer
 * (`epic-runner/checkpointer.js`, the `epic-run-state` comment shape)
 * to the lifecycle ledger landed. The adapter:
 *
 *   1. Detects the legacy snapshot shape: a `{ version, epicId,
 *      currentWave, totalWaves, concurrencyCap, phase, waves[], ... }`
 *      object as produced by `Checkpointer.write()` before this Story.
 *
 *   2. On first invocation (no existing `lifecycle.ndjson`) synthesizes
 *      equivalent `emitted` + `completed` ledger entries up to the
 *      phase boundary the snapshot recorded, so the resume coordinator
 *      sees a consistent prefix that matches what an uninterrupted run
 *      would have produced.
 *
 *   3. Is idempotent: a second invocation against the same snapshot —
 *      with the synthesized ledger already on disk — is a no-op. The
 *      adapter returns the same envelope and does NOT re-append.
 *
 * Side-effect firewall: filesystem read + filesystem write. No
 * provider IO, no bus emits, no GitHub state mutation. The on-disk
 * ledger remains the single source of truth; the adapter just lays
 * down the prefix that would have existed had the run started on the
 * ledger architecture.
 *
 * Wave-end synthesis: the legacy snapshot's `currentWave` is the
 * **next wave to run** (the runner persists the next phase to run,
 * not the just-completed phase — see `Checkpointer.setPhase` docs).
 * Therefore wave indices `[0, currentWave)` are the completed waves
 * that get synthesized as `wave.end` events. When the snapshot's
 * `phase === 'wave-loop'`, no further phase-end events are
 * synthesized — the next event the resume runner will record is the
 * next `wave.end` (or `close-validate.end` if all waves are done).
 *
 * Empty-prefix safety: if the legacy snapshot is at `phase === 'prepare'`
 * with `currentWave === 0`, the synthesized prefix is `[
 * epic.snapshot.end, epic.plan.end ]` — the two phase-end events that
 * Story #2233 wired through the bus. Nothing is lost; the runner
 * picks up at wave-loop entry as it would on a fresh start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DELIVER_PHASES, phaseIndex } from '../epic-runner/deliver-phases.js';

/**
 * Stable epoch used when the legacy snapshot did not carry a
 * `startedAt`. The synthesized timestamps walk forward from this base
 * in monotonic 1ms increments so the resulting ledger is
 * round-trippable (the same snapshot produces the same prefix
 * bit-for-bit).
 *
 * 2026-01-01T00:00:00.000Z is well before the cutover date and far
 * enough from `Date.now()` that synthesized records are visually
 * distinguishable from live records during reviews.
 */
const SYNTHESIS_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Default ledger path resolver. Mirrors `LedgerWriter.ledgerPath`.
 */
export function resolveLedgerPath({ tempRoot, epicId }) {
  if (typeof tempRoot !== 'string' || tempRoot.length === 0) {
    throw new TypeError('resolveLedgerPath: tempRoot must be a non-empty string');
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError('resolveLedgerPath: epicId must be a positive integer');
  }
  return path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson');
}

/**
 * Detect whether the supplied object is a legacy `epic-run-state`
 * snapshot. The shape was stable across all pre-cutover versions and
 * carried `version: 1` plus `epicId`, `phase`, and one of the
 * wave-tracking fields.
 *
 * Returns false for anything that is plainly not the legacy shape so
 * the adapter can be called from a wider integration site without a
 * pre-check.
 */
export function isLegacySnapshot(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.phase !== 'string' || value.phase.length === 0) return false;
  if (!Number.isInteger(value.epicId) || value.epicId < 1) return false;
  // The legacy snapshot carries either `version === 1` literally or
  // — for very old snapshots — omits the field entirely. We accept
  // both so the adapter can rescue every in-flight Epic.
  if (value.version !== undefined && value.version !== 1) return false;
  // A real legacy snapshot always carries `waves` as an array.
  if (!Array.isArray(value.waves)) return false;
  return true;
}

/**
 * Map a legacy `phase` string to the ordered list of phase-end
 * lifecycle events the resume coordinator expects to find in the
 * ledger BEFORE the resumed run continues. The list intentionally
 * matches the canonical ordering established by Stories #2233 (plan +
 * snapshot phases), #2250 (close-validate), #2252 (code-review +
 * retro), and #2254 (finalize). The wave-loop tail is generated
 * separately from `currentWave` because the count is data-driven.
 *
 * Returned event names are bare schema ids — payloads are filled in
 * by `synthesizePrefix`.
 */
export function phaseToCompletedEndEvents(phase) {
  if (phase === 'done') {
    return [
      'epic.snapshot.end',
      'epic.plan.end',
      'close-validate.end',
      'code-review.end',
      'retro.end',
      'epic.finalize.end',
    ];
  }
  const idx = phaseIndex(phase);
  if (idx < 0) return [];
  // Phases that have already COMPLETED are those whose index is less
  // than the current `phase` index (the legacy semantics store
  // `phase = the next phase to run`).
  const completedPhases = DELIVER_PHASES.slice(0, idx);
  const events = [];
  for (const completed of completedPhases) {
    switch (completed) {
      case 'prepare':
        events.push('epic.snapshot.end');
        events.push('epic.plan.end');
        break;
      case 'wave-loop':
        // wave-end events are generated from `currentWave`, not from
        // this mapping — see `synthesizePrefix`.
        break;
      case 'close-validation':
        events.push('close-validate.end');
        break;
      case 'code-review':
        events.push('code-review.end');
        break;
      case 'retro':
        events.push('retro.end');
        break;
      case 'finalize':
        events.push('epic.finalize.end');
        break;
      default:
        break;
    }
  }
  return events;
}

/**
 * Build the synthetic payload for a given event in the legacy-resume
 * prefix. Payloads carry the minimum schema-valid shape; downstream
 * consumers that care about full payload fidelity (the trace logger,
 * the lifecycle-diff CLI) read additional context from the structured
 * comment or recompute from the live run.
 *
 * The synthetic flag is intentionally NOT a payload field — the
 * schema's `additionalProperties: false` would reject it. Instead we
 * record the prefix's provenance in a marker file next to the ledger
 * (`legacy-resume.synthesized`) so a reviewer can grep for it.
 */
export function buildSyntheticPayload({ event, snapshot, waveIndex }) {
  const epicId = snapshot.epicId;
  switch (event) {
    case 'epic.snapshot.end':
      return { epicId, storyIds: [] };
    case 'epic.plan.end':
      return { waves: deriveWavesFromSnapshot(snapshot) };
    case 'wave.end':
      return { waveIndex, outcomes: {} };
    case 'close-validate.end':
      // close-validate.end is per-story in the live runner; the
      // legacy snapshot did not carry story IDs at this granularity,
      // so we synthesize a single per-epic synthetic record with
      // storyId set to the snapshot's epicId as a stand-in. The
      // schema requires `storyId: integer >= 1` and we use the
      // epicId as the only safe placeholder. This is acceptable for
      // resume because the actual close-validate output is regenerated
      // from the live run after the prefix is consumed.
      return { epicId, storyId: epicId, ok: true };
    case 'code-review.end':
      return { epicId, status: 'no-changes' };
    case 'retro.end':
      return { epicId, posted: false };
    case 'epic.finalize.end':
      return { epicId, prUrl: 'https://github.com/legacy/resume/pull/0' };
    default:
      return {};
  }
}

/**
 * Derive a `waves` array shape valid for `epic.plan.end.schema.json`
 * (`integer[][]`) from a legacy snapshot's `waves` field. Pre-cutover
 * `waves` entries were `{ index, storyIds }` records; we map them
 * back to the bare integer-array shape.
 */
export function deriveWavesFromSnapshot(snapshot) {
  if (!Array.isArray(snapshot.waves) || snapshot.waves.length === 0) {
    // No waves recorded yet — schema allows an empty array? No: the
    // schema requires `items: integer[]` but the outer array can be
    // empty. Return a single placeholder wave with the synthetic
    // epicId so the run can still emit a plan.end without faking
    // story IDs we don't have.
    return [[snapshot.epicId]];
  }
  return snapshot.waves.map((wave) => {
    if (Array.isArray(wave?.storyIds)) {
      const ints = wave.storyIds.filter((id) => Number.isInteger(id) && id >= 1);
      return ints.length > 0 ? ints : [snapshot.epicId];
    }
    return [snapshot.epicId];
  });
}

/**
 * Produce the full synthesized record list (emitted+completed pairs)
 * for a given snapshot. Exported for unit tests so the prefix shape
 * can be asserted without touching the filesystem.
 *
 * The returned records are paired: emitted record at index 2k,
 * completed at 2k+1. The pairing is the same shape `LedgerWriter`
 * produces during a live run.
 */
export function synthesizePrefix({ snapshot, epoch = SYNTHESIS_EPOCH_MS }) {
  if (!isLegacySnapshot(snapshot)) {
    throw new TypeError('synthesizePrefix: snapshot is not a legacy shape');
  }
  const records = [];
  let seqId = 1;
  let tsMs = epoch;
  const tick = () => {
    const iso = new Date(tsMs).toISOString();
    tsMs += 1;
    return iso;
  };

  const emit = (event, payload) => {
    records.push({
      kind: 'emitted',
      seqId,
      ts: tick(),
      event,
      payload,
    });
    records.push({
      kind: 'completed',
      seqId,
      ts: tick(),
      event,
    });
    seqId += 1;
  };

  // Phase 1 — the prepare-phase boundaries (snapshot + plan) always
  // come first. If the legacy `phase === 'prepare'` then NEITHER
  // boundary has fired yet (`phase` is the next-to-run); the
  // phaseToCompletedEndEvents() helper already filters them out for
  // that case.
  const phaseEvents = phaseToCompletedEndEvents(snapshot.phase);

  for (const event of phaseEvents) {
    if (event === 'close-validate.end') {
      // close-validate.end fires AFTER all wave.end events. Defer.
      continue;
    }
    if (
      event === 'code-review.end' ||
      event === 'retro.end' ||
      event === 'epic.finalize.end'
    ) {
      // These come after close-validate.end. Defer until the wave
      // loop has been emitted.
      continue;
    }
    emit(event, buildSyntheticPayload({ event, snapshot }));
  }

  // Phase 2 — wave loop. The legacy `currentWave` field is the next
  // wave to run; waves `[0, currentWave)` are completed.
  const currentWave = Number.isInteger(snapshot.currentWave)
    ? snapshot.currentWave
    : 0;
  for (let waveIndex = 0; waveIndex < currentWave; waveIndex += 1) {
    emit('wave.end', buildSyntheticPayload({ event: 'wave.end', snapshot, waveIndex }));
  }

  // Phase 3 — close-tail boundaries (close-validate / code-review /
  // retro / finalize). Each fires only when the legacy phase advanced
  // past it.
  const phaseIdx = phaseIndex(snapshot.phase);
  const tail = [
    ['close-validation', 'close-validate.end'],
    ['code-review', 'code-review.end'],
    ['retro', 'retro.end'],
    ['finalize', 'epic.finalize.end'],
  ];
  for (const [phase, event] of tail) {
    const completedIdx = phaseIndex(phase);
    if (completedIdx >= 0 && completedIdx < phaseIdx) {
      emit(event, buildSyntheticPayload({ event, snapshot }));
    }
  }

  return records;
}

/**
 * Run the adapter. The function is the public entry point:
 *
 *   apply({ snapshot, tempRoot }) →
 *     {
 *       status: 'synthesized' | 'noop-existing-ledger' | 'noop-not-legacy',
 *       ledgerPath: string,
 *       recordsAppended: number,
 *     }
 *
 * Behaviour:
 *   - When `lifecycle.ndjson` already exists OR the marker file
 *     `legacy-resume.synthesized` exists, returns `noop-existing-ledger`
 *     without re-appending. This is the idempotency contract.
 *   - When `snapshot` is not a legacy-shape object, returns
 *     `noop-not-legacy` without touching the filesystem.
 *   - Otherwise creates the epic-scoped temp dir, writes every
 *     synthesized record as an NDJSON line, and drops the marker
 *     file to ensure a SECOND invocation against the same snapshot
 *     is a no-op even if the ledger was deleted between calls.
 */
export function apply({
  snapshot,
  tempRoot,
  // Injection hooks for tests — defaults read/write real fs.
  fs: fsHooks,
} = {}) {
  if (typeof tempRoot !== 'string' || tempRoot.length === 0) {
    throw new TypeError('apply: tempRoot must be a non-empty string');
  }
  const fsApi = {
    existsSync: fsHooks?.existsSync ?? existsSync,
    mkdirSync: fsHooks?.mkdirSync ?? mkdirSync,
    readFileSync: fsHooks?.readFileSync ?? readFileSync,
    writeFileSync: fsHooks?.writeFileSync ?? writeFileSync,
  };

  if (!isLegacySnapshot(snapshot)) {
    return {
      status: 'noop-not-legacy',
      ledgerPath: null,
      recordsAppended: 0,
    };
  }

  const ledgerPath = resolveLedgerPath({
    tempRoot,
    epicId: snapshot.epicId,
  });
  const epicDir = path.dirname(ledgerPath);
  const markerPath = path.join(epicDir, 'legacy-resume.synthesized');

  // Idempotency probe: the marker file is the authoritative signal.
  // We also short-circuit on an existing ledger (any non-empty
  // lifecycle.ndjson means we are past the cutover and have nothing
  // to do).
  if (fsApi.existsSync(markerPath)) {
    return {
      status: 'noop-existing-ledger',
      ledgerPath,
      recordsAppended: 0,
    };
  }
  if (fsApi.existsSync(ledgerPath)) {
    const existing = fsApi.readFileSync(ledgerPath, 'utf8');
    if (typeof existing === 'string' && existing.length > 0) {
      // Drop a marker so subsequent calls don't have to re-read the
      // (potentially large) ledger. Without this, a long-running run
      // would re-stat + re-read on every invocation.
      try {
        fsApi.writeFileSync(
          markerPath,
          `${new Date().toISOString()} ledger-already-present\n`,
          'utf8',
        );
      } catch (_err) {
        // Marker failure is non-fatal — we still return noop.
      }
      return {
        status: 'noop-existing-ledger',
        ledgerPath,
        recordsAppended: 0,
      };
    }
  }

  const records = synthesizePrefix({ snapshot });
  fsApi.mkdirSync(epicDir, { recursive: true });
  const ndjson = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  fsApi.writeFileSync(ledgerPath, ndjson, 'utf8');
  fsApi.writeFileSync(
    markerPath,
    `${new Date().toISOString()} synthesized=${records.length}\n`,
    'utf8',
  );

  return {
    status: 'synthesized',
    ledgerPath,
    recordsAppended: records.length,
  };
}
