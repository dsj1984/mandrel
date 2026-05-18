/**
 * phases/refresh.js — bounded baseline auto-refresh phase (Story #2460,
 * Epic #2453 — CLI thinning pilot).
 *
 * Pre-merge gates have passed; this phase regenerates baseline rows
 * scoped to the Story diff and folds them into HEAD via one canonical
 * `chore(baselines): refresh <kind> for story-<id>` commit per kind that
 * actually drifted. Failure modes are advisory: a regen / amend /
 * signal-write failure is logged but does not block the close.
 *
 * Public surface:
 *   - describeAutoRefreshOutcome(refreshResult)   ← exported (story-close.js re-export)
 *   - reportAutoRefreshOutcome(refreshResult, deps?)
 *   - runAutoRefreshSafely(args, deps?)
 */

import { Logger } from '../../../Logger.js';
import { runAutoRefresh } from '../auto-refresh-runner.js';

/**
 * Pure: render the AUTO-REFRESH status into a `{channel, message}` log
 * envelope, or `null` for statuses we don't surface. Extracted so the
 * branching lives behind a tested boundary.
 */
export function describeAutoRefreshOutcome(refreshResult) {
  if (
    refreshResult?.status === 'committed' ||
    refreshResult?.status === 'amended'
  ) {
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Committed bounded baseline drift on Story branch (${refreshResult.sha}).`,
    };
  }
  if (refreshResult?.status === 'refused') {
    const sig = refreshResult.dedup
      ? 'already present'
      : refreshResult.signalAppended
        ? 'appended'
        : 'not written';
    return {
      channel: 'progress',
      label: 'AUTO-REFRESH',
      message: `Refused — ${refreshResult.refusalReasons.length} cap breach(es); friction signal ${sig}.`,
    };
  }
  if (refreshResult?.status === 'failed') {
    return {
      channel: 'warn',
      message: `[auto-refresh] ${refreshResult.reason}: ${refreshResult.detail ?? ''}`,
    };
  }
  return null;
}

/**
 * Translate the structured outcome into a single log line via the
 * provided `progress` callback (so production wires `progressLog` and
 * tests can pin the channel + label).
 */
export function reportAutoRefreshOutcome(refreshResult, deps = {}) {
  const envelope = describeAutoRefreshOutcome(refreshResult);
  if (!envelope) return;
  const progress = deps.progress;
  const logger = deps.logger ?? Logger;
  if (envelope.channel === 'warn') logger.warn(envelope.message);
  else if (progress) progress(envelope.label, envelope.message);
}

/**
 * Story #1398 (Epic #1386) — bounded baseline auto-refresh. Pre-merge
 * gates have passed; regenerate baseline rows scoped to the Story diff
 * and amend them into HEAD if every row's delta is at or below the
 * configured caps. Failure modes are advisory.
 */
export async function runAutoRefreshSafely(args, deps = {}) {
  try {
    const refreshResult = await runAutoRefresh(args);
    reportAutoRefreshOutcome(refreshResult, deps);
  } catch (err) {
    Logger.warn(
      `[auto-refresh] runner threw: ${err?.stack || err?.message || err}`,
    );
  }
}
