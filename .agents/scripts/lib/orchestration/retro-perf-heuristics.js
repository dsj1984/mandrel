/**
 * lib/orchestration/retro-perf-heuristics.js — classify perf signals.
 *
 * Story #3042 / Task #3045 (Epic #3019). Pure functions that turn the
 * `epic-perf-report.waveParallelism` row shape (Story #3025) into a flat
 * list of perf signals. The retro renderer (`./retro/phases/compose-body.js`)
 * consumes the list to surface a `## Performance Signals` section and a
 * `## Recommended Follow-Ons` paste-ready stanza per signal.
 *
 * Signals (kinds):
 *
 *   - `low-utilisation` — any wave whose `utilisation < thresholds.utilisation`.
 *     One signal per offending wave. The signal carries the wave index and
 *     the observed utilisation so the renderer can name the offender.
 *
 *   - `high-bootstrap-share` — emitted when the summed `story-init` /
 *     bootstrap phase time across all waves exceeds
 *     `thresholds.bootstrapShare` of the cumulative `summedStoryMs`. This is
 *     a single signal across the whole report (not one per wave) because the
 *     framework remediation is an Epic-wide bootstrap-cost story, not a
 *     per-wave tweak. The signal payload carries the observed share.
 *
 *   - `cap-binding-run` — emitted when `>= thresholds.capBindingRunLength`
 *     consecutive waves report `capBinding: true`. One signal per maximal
 *     run, carrying the run's first/last wave index and the run length so
 *     the renderer can attribute the run-length back to the deliver-runner
 *     concurrency cap.
 *
 * Threshold contract (`.agentrc.json → delivery.retro.perfThresholds`):
 *
 *   - `utilisation`: number in [0, 1]. Default 0.6.
 *   - `bootstrapShare`: number in [0, 1]. Default 0.4.
 *   - `capBindingRunLength`: positive integer. Default 2.
 *
 * The function is total: it never throws on malformed input. A missing or
 * malformed `report` returns `[]`. A missing `thresholds` falls back to the
 * documented defaults.
 */

/**
 * Defaults mirroring `.agentrc.json → delivery.retro.perfThresholds` so
 * callers (and tests) can omit `thresholds` and get the same behaviour as
 * a resolved config with no overrides. Keep in lockstep with
 * `lib/config/runners.js` (or wherever the resolver default lives) and the
 * `agentrc.schema.json` defaults stanza.
 */
export const DEFAULT_RETRO_PERF_THRESHOLDS = Object.freeze({
  utilisation: 0.6,
  bootstrapShare: 0.4,
  capBindingRunLength: 2,
});

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function clampUnit(n, fallback) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  // Out-of-range values fall back to the documented default rather than
  // being clamped — operators wiring nonsensical thresholds should see the
  // safe default applied, not a silent 0/1 substitute that subtly changes
  // the heuristic.
  if (n < 0 || n > 1) return fallback;
  return n;
}

function positiveInt(n, fallback) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

/**
 * Resolve the threshold trio against the documented defaults. Exported for
 * the test surface so callers can verify the fallback semantics in
 * isolation.
 *
 * @param {object|null|undefined} thresholds
 * @returns {{ utilisation: number, bootstrapShare: number, capBindingRunLength: number }}
 */
export function resolvePerfThresholds(thresholds) {
  const src = isObject(thresholds) ? thresholds : {};
  return {
    utilisation: clampUnit(
      src.utilisation,
      DEFAULT_RETRO_PERF_THRESHOLDS.utilisation,
    ),
    bootstrapShare: clampUnit(
      src.bootstrapShare,
      DEFAULT_RETRO_PERF_THRESHOLDS.bootstrapShare,
    ),
    capBindingRunLength: positiveInt(
      src.capBindingRunLength,
      DEFAULT_RETRO_PERF_THRESHOLDS.capBindingRunLength,
    ),
  };
}

/**
 * Extract the validated `waveParallelism` rows from the report. Rows whose
 * `waveIndex` is not a non-negative integer are dropped (the schema requires
 * one, but the heuristics module must tolerate malformed historical reports).
 *
 * @param {object|null|undefined} report
 * @returns {Array<{ waveIndex: number, wallClockMs: number, summedStoryMs: number, utilisation: number, capBinding: boolean }>}
 */
function extractRows(report) {
  if (!isObject(report)) return [];
  const arr = Array.isArray(report.waveParallelism)
    ? report.waveParallelism
    : [];
  return arr
    .filter(
      (r) => isObject(r) && Number.isInteger(r.waveIndex) && r.waveIndex >= 0,
    )
    .map((r) => ({
      waveIndex: r.waveIndex,
      wallClockMs:
        typeof r.wallClockMs === 'number' && r.wallClockMs > 0
          ? r.wallClockMs
          : 0,
      summedStoryMs:
        typeof r.summedStoryMs === 'number' && r.summedStoryMs > 0
          ? r.summedStoryMs
          : 0,
      utilisation:
        typeof r.utilisation === 'number' && Number.isFinite(r.utilisation)
          ? r.utilisation
          : 0,
      capBinding: Boolean(r.capBinding),
    }));
}

/**
 * Build the `low-utilisation` signals — one per wave whose `utilisation` is
 * strictly below the threshold. Returns `[]` when no row crosses the gate.
 *
 * Waves with `summedStoryMs <= 0` are skipped unconditionally: when no
 * per-Story timing windows are present the computed utilisation is 0.0%
 * because the numerator is 0, not because the wave was genuinely idle.
 * Scoring unknown timing as low would flood the retro with non-actionable
 * follow-ons (Story #3850).
 */
function detectLowUtilisation(rows, threshold) {
  const out = [];
  for (const row of rows) {
    // Skip waves with no timing data — utilisation is unknown, not low.
    if (row.summedStoryMs <= 0) continue;
    if (row.utilisation < threshold) {
      out.push({
        kind: 'low-utilisation',
        waveIndex: row.waveIndex,
        utilisation: row.utilisation,
        threshold,
      });
    }
  }
  return out;
}

/**
 * Sum the bootstrap (story-init) phase time across per-Story summaries on the
 * report. Returns the absolute milliseconds. Falls back to 0 when no Story
 * summary in the report carries a `phaseTimingsMs['story-init']` entry — in
 * that case the share check necessarily returns no signal.
 */
function sumBootstrapMs(report) {
  if (!isObject(report)) return 0;
  const stories = Array.isArray(report.storyPerfSummaries)
    ? report.storyPerfSummaries
    : [];
  let total = 0;
  for (const s of stories) {
    if (!isObject(s)) continue;
    const timings = isObject(s.phaseTimingsMs) ? s.phaseTimingsMs : null;
    if (!timings) continue;
    const v = timings['story-init'];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      total += v;
    }
  }
  return total;
}

/**
 * Build the (at-most-one) `high-bootstrap-share` signal. Returns `[]` when
 * either the cumulative `summedStoryMs` is zero (no wave timing) or the
 * observed bootstrap share is at-or-below the threshold.
 */
function detectHighBootstrapShare(rows, report, threshold) {
  const totalStoryMs = rows.reduce((acc, r) => acc + r.summedStoryMs, 0);
  if (totalStoryMs <= 0) return [];
  const bootstrapMs = sumBootstrapMs(report);
  if (bootstrapMs <= 0) return [];
  const share = bootstrapMs / totalStoryMs;
  if (share <= threshold) return [];
  return [
    {
      kind: 'high-bootstrap-share',
      share,
      bootstrapMs,
      summedStoryMs: totalStoryMs,
      threshold,
    },
  ];
}

/**
 * Walk the rows in `waveIndex` order and emit one `cap-binding-run` signal
 * per maximal run of consecutive `capBinding: true` waves whose length is at
 * least `threshold`.
 */
function detectCapBindingRuns(rows, threshold) {
  const ordered = [...rows].sort((a, b) => a.waveIndex - b.waveIndex);
  const out = [];
  let runStart = null;
  let runLen = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const row = ordered[i];
    if (row.capBinding) {
      if (runStart === null) runStart = row.waveIndex;
      runLen += 1;
      // End of array? Flush the run.
      if (i === ordered.length - 1 && runLen >= threshold) {
        out.push({
          kind: 'cap-binding-run',
          fromWaveIndex: runStart,
          toWaveIndex: row.waveIndex,
          runLength: runLen,
          threshold,
        });
      }
    } else {
      if (runLen >= threshold && runStart !== null) {
        out.push({
          kind: 'cap-binding-run',
          fromWaveIndex: runStart,
          toWaveIndex: ordered[i - 1].waveIndex,
          runLength: runLen,
          threshold,
        });
      }
      runStart = null;
      runLen = 0;
    }
  }
  return out;
}

/**
 * Classify perf signals from an `epic-perf-report` payload.
 *
 * Always returns an array of signal objects. The array is empty when no
 * signal trips. The caller (retro renderer) is responsible for suppressing
 * the entire `## Performance Signals` and `## Recommended Follow-Ons`
 * sections when this returns `[]`.
 *
 * @param {object|null|undefined} report   `epic-perf-report` payload.
 * @param {object|null|undefined} thresholds  Optional override of
 *   `{ utilisation, bootstrapShare, capBindingRunLength }`. Defaults
 *   resolve via `DEFAULT_RETRO_PERF_THRESHOLDS`.
 * @returns {Array<object>} Signal list.
 */
export function classifyPerfSignals(report, thresholds) {
  const resolved = resolvePerfThresholds(thresholds);
  const rows = extractRows(report);
  if (rows.length === 0) return [];
  const signals = [];
  signals.push(...detectLowUtilisation(rows, resolved.utilisation));
  signals.push(
    ...detectHighBootstrapShare(rows, report, resolved.bootstrapShare),
  );
  signals.push(...detectCapBindingRuns(rows, resolved.capBindingRunLength));
  return signals;
}
