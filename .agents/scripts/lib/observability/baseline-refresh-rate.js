/**
 * baseline-refresh-rate.js — pure reporter for the per-Epic baseline-refresh
 * commit rate (Epic #1386, Story #1400).
 *
 * The "baseline-refresh discipline" (Story #1124, Tech Spec #902) requires
 * that every Story whose merge introduces baseline drift land an explicit
 * `baseline-refresh:` commit in the same close PR (or, post Story #1398,
 * fold the refresh into the close commit itself). The 90% target — that
 * at least 90% of merged Stories per Epic land without leaving baseline
 * drift behind — needs a measurable signal so retros can spot regressions
 * before they leak into `main`.
 *
 * This module exports a single pure function that takes a fixture of
 * commit records (one per Story-attributable commit on `epic/<id>` over
 * the trailing window) and returns:
 *
 *   - per-Epic counts of `baseline-refresh:` commits
 *   - per-Epic counts of merged Stories
 *   - per-Epic percentage of merged Stories that did NOT land a
 *     baseline-refresh commit (the "clean-merge" rate)
 *
 * The caller (analyze-execution.js) is responsible for shelling out to
 * `git log` and resolving each commit to its parent Epic ID — this
 * module touches no I/O so the test fixture can pin behavior without a
 * temp git repo or stubbed spawn.
 *
 * Default window is 4 weeks (28 days). Pass `windowDays` to override
 * (e.g., `windowDays: 14` for a fortnightly retro).
 *
 * Aligned with `perf-aggregator.js`: empty input yields a well-formed
 * empty payload, malformed records are silently skipped, the function
 * never throws on bad data.
 */

import { isObject } from '../json-utils.js';
import { RESOLVES_TRAILER_RE } from '../orchestration/resolves-token.js';

const BASELINE_REFRESH_PREFIX = 'baseline-refresh:';
const DEFAULT_WINDOW_DAYS = 28;

/**
 * Coerce an ISO-8601 date string to epoch ms. Returns NaN for malformed
 * input so the caller's window filter drops the record.
 */
function toEpochMs(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Classify a commit by its subject line.
 *
 *   - `baseline-refresh:` prefix → refresh commit
 *   - subject containing `(resolves #N)` → Story-merge commit
 *   - everything else → ignored (chore commits, baseline-only fixes, etc.)
 *
 * The classification is deliberately disjoint: a `baseline-refresh:`
 * commit is never counted as a Story merge, and a Story merge is never
 * counted as a baseline-refresh — even if the subject happens to mention
 * both keywords. This matches the on-the-ground convention: refreshes
 * land as their own commit (or amended into the close), Stories land as
 * `feat: ... (resolves #N)`.
 */
function classifySubject(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return 'other';
  if (subject.startsWith(BASELINE_REFRESH_PREFIX)) return 'refresh';
  if (RESOLVES_TRAILER_RE.test(subject)) return 'story';
  return 'other';
}

/**
 * Compute the trailing-window cutoff in epoch ms. Exported on the
 * exported function via the `now` option so tests can pin the clock.
 */
function computeCutoffMs(nowMs, windowDays) {
  const days =
    Number.isFinite(windowDays) && windowDays > 0
      ? windowDays
      : DEFAULT_WINDOW_DAYS;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

/**
 * Pure reporter for the per-Epic baseline-refresh commit rate.
 *
 * @param {Iterable<{
 *   sha?: string,
 *   isoDate: string,
 *   subject: string,
 *   epicId: number | string | null,
 * }>} commits
 *   Commit records from the caller. Records missing `epicId` (the commit
 *   isn't on any Epic branch) are dropped. Records older than the window
 *   are also dropped. Order does not matter — the function aggregates by
 *   Epic regardless of input ordering.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowDays] — trailing window in days (default 28).
 * @param {() => Date | number} [opts.now] — clock injector for tests.
 *   Accepts either a Date or epoch-ms; defaults to `() => Date.now()`.
 *
 * @returns {{
 *   kind: 'baseline-refresh-rate',
 *   windowDays: number,
 *   generatedAt: string,
 *   cutoffAt: string,
 *   perEpic: Array<{
 *     epicId: number | string,
 *     storyMerges: number,
 *     baselineRefreshes: number,
 *     cleanMergeRate: number,
 *   }>,
 *   totals: {
 *     storyMerges: number,
 *     baselineRefreshes: number,
 *     cleanMergeRate: number,
 *   },
 * }}
 *
 * `cleanMergeRate` is the fraction of merged Stories that did NOT need a
 * baseline-refresh commit follow-up (or amend), in `[0, 1]` rounded to
 * 4 decimal places. The 90% target is `cleanMergeRate >= 0.9`. When
 * `storyMerges === 0`, the rate is `1` (vacuously clean — no Stories,
 * no drift) so a quiet Epic doesn't show up as red.
 */
export function computeBaselineRefreshRate(commits, opts = {}) {
  const nowFn = opts.now ?? (() => Date.now());
  const nowVal = nowFn();
  const nowMs = nowVal instanceof Date ? nowVal.getTime() : Number(nowVal);
  const windowDays =
    Number.isFinite(opts.windowDays) && opts.windowDays > 0
      ? Math.floor(opts.windowDays)
      : DEFAULT_WINDOW_DAYS;
  const cutoffMs = computeCutoffMs(nowMs, windowDays);

  // Map<epicId, { storyMerges, baselineRefreshes }>. Insertion order is
  // preserved so the output array is stable for snapshot-style assertions.
  const perEpic = new Map();
  const ensureBucket = (epicId) => {
    if (!perEpic.has(epicId)) {
      perEpic.set(epicId, { storyMerges: 0, baselineRefreshes: 0 });
    }
    return perEpic.get(epicId);
  };

  for (const raw of commits ?? []) {
    if (!isObject(raw)) continue;
    const epicId = raw.epicId;
    if (epicId == null || epicId === '') continue;
    const ts = toEpochMs(raw.isoDate);
    if (!Number.isFinite(ts)) continue;
    if (ts < cutoffMs) continue;

    const klass = classifySubject(raw.subject);
    if (klass === 'other') continue;

    const bucket = ensureBucket(epicId);
    if (klass === 'refresh') bucket.baselineRefreshes += 1;
    else if (klass === 'story') bucket.storyMerges += 1;
  }

  const perEpicRows = [];
  let totalStories = 0;
  let totalRefreshes = 0;
  for (const [epicId, counts] of perEpic) {
    const cleanMergeRate =
      counts.storyMerges === 0
        ? 1
        : Math.max(
            0,
            Math.min(
              1,
              (counts.storyMerges - counts.baselineRefreshes) /
                counts.storyMerges,
            ),
          );
    perEpicRows.push({
      epicId,
      storyMerges: counts.storyMerges,
      baselineRefreshes: counts.baselineRefreshes,
      cleanMergeRate: roundRate(cleanMergeRate),
    });
    totalStories += counts.storyMerges;
    totalRefreshes += counts.baselineRefreshes;
  }

  const totalsClean =
    totalStories === 0
      ? 1
      : Math.max(
          0,
          Math.min(1, (totalStories - totalRefreshes) / totalStories),
        );

  return {
    kind: 'baseline-refresh-rate',
    windowDays,
    generatedAt: new Date(nowMs).toISOString(),
    cutoffAt: new Date(cutoffMs).toISOString(),
    perEpic: perEpicRows,
    totals: {
      storyMerges: totalStories,
      baselineRefreshes: totalRefreshes,
      cleanMergeRate: roundRate(totalsClean),
    },
  };
}

function roundRate(rate) {
  if (!Number.isFinite(rate)) return 0;
  return Math.round(rate * 10000) / 10000;
}

// Exported for unit tests that want to assert the classifier directly
// without round-tripping through the aggregator.
export const __test__ = {
  classifySubject,
  computeCutoffMs,
  DEFAULT_WINDOW_DAYS,
};
