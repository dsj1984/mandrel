/**
 * Per-site concurrency caps for the `concurrentMap` adoption sites shipped
 * in v5.21.0 (Epic #553). Read from `orchestration.runners.concurrency` (Epic
 * #773 Story 7 grouped shape) with fall-backs to the exact v5.21.0 constants
 * so omitting the config block preserves pre-tuning behaviour bit-for-bit.
 *
 * Fields:
 *   - `waveGate`: 0 means "uncapped" — wave-gate keeps the
 *     Promise.all shape it shipped with. Positive values cap the three
 *     per-section ticket-read batches via `concurrentMap`.
 *   - `commitAssertion`: default 4 matches the former
 *     `WAVE_END_CONCURRENCY` constant inside `CommitAssertion`.
 *   - `progressReporter`: default 8 matches the literal previously used
 *     inside `ProgressReporter.fire`.
 */

export const DEFAULT_CONCURRENCY = Object.freeze({
  waveGate: 0,
  commitAssertion: 4,
  progressReporter: 8,
});

function coerceNonNegativeInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

function coercePositiveInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 1 ? n : fallback;
}

/**
 * Resolve the concurrency caps from a raw orchestration config block.
 * Accepts the surrounding `orchestration` object (which carries the grouped
 * `runners.concurrency` sub-block post-Story-7) or an already-narrowed
 * concurrency block (caller convenience).
 *
 * @param {{ runners?: { concurrency?: object } } | { waveGate?: number, commitAssertion?: number, progressReporter?: number } | null | undefined} source
 * @returns {Readonly<{ waveGate: number, commitAssertion: number, progressReporter: number }>}
 */
export function resolveConcurrency(source) {
  const cfg =
    source && typeof source === 'object' && source !== null
      ? (source.runners?.concurrency ?? source)
      : null;
  const safe = cfg && typeof cfg === 'object' ? cfg : {};
  return Object.freeze({
    waveGate: coerceNonNegativeInt(
      Number(safe.waveGate),
      DEFAULT_CONCURRENCY.waveGate,
    ),
    commitAssertion: coercePositiveInt(
      Number(safe.commitAssertion),
      DEFAULT_CONCURRENCY.commitAssertion,
    ),
    progressReporter: coercePositiveInt(
      Number(safe.progressReporter),
      DEFAULT_CONCURRENCY.progressReporter,
    ),
  });
}
