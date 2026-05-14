/**
 * Per-site concurrency caps for the `concurrentMap` adoption sites shipped
 * in v5.21.0 (Epic #553). Post-reshape (Epic #1720 Story #1739) the
 * `orchestration.runners.concurrency` config knob is gone — these are
 * framework-internal constants. The exported `resolveConcurrency` helper
 * is kept for call-site stability but always returns `DEFAULT_CONCURRENCY`.
 *
 * Fields:
 *   - `waveGate`: 0 means "uncapped" — wave-gate keeps the Promise.all
 *     shape it shipped with.
 *   - `commitAssertion`: 4 matches the former `WAVE_END_CONCURRENCY`
 *     constant inside `CommitAssertion`.
 *   - `progressReporter`: 8 matches the literal previously used inside
 *     `ProgressReporter.fire`.
 */

export const DEFAULT_CONCURRENCY = Object.freeze({
  waveGate: 0,
  commitAssertion: 4,
  progressReporter: 8,
});

/**
 * Return the per-site concurrency caps. The argument is accepted but
 * ignored — the caps are framework-internal constants post-reshape.
 *
 * @returns {Readonly<{ waveGate: number, commitAssertion: number, progressReporter: number }>}
 */
export function resolveConcurrency(_source) {
  return DEFAULT_CONCURRENCY;
}
