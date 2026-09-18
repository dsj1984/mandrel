// .agents/scripts/lib/orchestration/check-state.js
/**
 * check-state.js — the ONE check-state classifier, and the rerun rule that
 * reads it (Story #5383).
 *
 * Two readers observe CI checks on the close path, each on a different
 * GitHub data source, and they stay separate on purpose (each carries
 * workarounds for what its source cannot see):
 *
 *   - the merge wait reads the `gh pr view --json statusCheckRollup` rollup
 *     (`merge-poll.js#deriveChecksStatus`) — every check on the PR, as
 *     CheckRuns (`{status, conclusion}`) and legacy StatusContexts
 *     (`{state}`);
 *   - the recovery watch reads `gh pr checks --required --json
 *     name,state,bucket` (`pr-watch.js#reduceOutcomes`) — required checks
 *     only, as `{state, bucket}`.
 *
 * Before this module each reader normalised its own payload, so "what does
 * this GitHub state mean" was answered twice and drifted: a StatusContext
 * `ERROR` read as green on one side and red on the other. Now both readers
 * adapt their payload through a thin adapter below and hand the raw value to
 * {@link classifyCheckState}; {@link checkVerdict} is the one place a
 * canonical outcome becomes pass / fail / pending.
 *
 * Pure — no I/O.
 */

/**
 * Raw GitHub check vocabulary (lower-cased) → the canonical outcome
 * vocabulary. Covers the CheckRun `status` / `conclusion` values, the legacy
 * StatusContext `state` values, and the `gh pr checks` `bucket` values, so a
 * payload from either reader lands on the same outcome. A `Map`, not an
 * object literal, so a hostile key such as `constructor` cannot resolve to a
 * prototype member.
 */
const RAW_TO_OUTCOME = new Map([
  // Still running — the only non-terminal outcome.
  ['', 'pending'],
  ['pending', 'pending'],
  ['queued', 'pending'],
  ['in_progress', 'pending'],
  ['requested', 'pending'],
  ['waiting', 'pending'],
  ['expected', 'pending'],
  // Terminal outcomes.
  ['success', 'success'],
  ['completed', 'success'],
  ['pass', 'success'],
  ['failure', 'failure'],
  ['startup_failure', 'failure'],
  ['error', 'failure'],
  ['fail', 'failure'],
  ['neutral', 'neutral'],
  ['cancelled', 'cancelled'],
  ['cancel', 'cancelled'],
  ['timed_out', 'timed_out'],
  ['action_required', 'action_required'],
  ['stale', 'stale'],
  ['skipped', 'skipped'],
  ['skipping', 'skipped'],
]);

/**
 * Outcomes that do not block a merge. Mirrors the automerge predicate's
 * non-failing set, so "is this check green" has one definition.
 */
const NON_FAILING_OUTCOMES = new Set(['success', 'neutral', 'skipped']);

/**
 * Map one raw GitHub check value to the canonical outcome vocabulary
 * (`pending` | `success` | `failure` | `neutral` | `cancelled` | `timed_out`
 * | `action_required` | `stale` | `skipped`).
 *
 * An unrecognised value collapses to `skipped`, so a GitHub state nobody has
 * enumerated yet still maps into the vocabulary rather than wedging a poll
 * loop on a value it cannot reduce.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function classifyCheckState(raw) {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase();
  return RAW_TO_OUTCOME.get(key) ?? 'skipped';
}

/**
 * The one pass / fail / pending decision over a canonical outcome.
 *
 * @param {string} outcome A {@link classifyCheckState} result.
 * @returns {'pass'|'fail'|'pending'}
 */
export function checkVerdict(outcome) {
  if (outcome === 'pending') return 'pending';
  return NON_FAILING_OUTCOMES.has(outcome) ? 'pass' : 'fail';
}

/**
 * Adapter for a `statusCheckRollup` entry (the merge wait's source).
 *
 * A CheckRun carries its verdict on `conclusion` once it completes, and is in
 * flight while `status` is anything but `COMPLETED`. A legacy StatusContext
 * has no `status`/`conclusion` and carries its verdict on `state`.
 *
 * @param {{ status?: string, conclusion?: string, state?: string }} [check]
 * @returns {string} canonical outcome
 */
export function classifyRollupEntry(check) {
  const conclusion = String(check?.conclusion ?? '').trim();
  if (conclusion) return classifyCheckState(conclusion);
  const status = String(check?.status ?? '').trim();
  if (status && status.toUpperCase() !== 'COMPLETED') return 'pending';
  return classifyCheckState(check?.state ?? status);
}

/**
 * Adapter for a `gh pr checks --required` entry (the recovery watch's
 * source). `state` wins when populated; `bucket` is `gh`'s own terminal
 * classification and the fallback when it is not.
 *
 * @param {{ state?: string, bucket?: string }} [entry]
 * @returns {string} canonical outcome
 */
export function classifyRequiredCheck(entry) {
  return classifyCheckState(entry?.state || entry?.bucket || '');
}

/**
 * The rerun policy, stated once (Story #5383). Both merge-wait loops consult
 * it rather than each carrying half of an unwritten rule:
 *
 *   - A red **required** check is never re-run by automation. The fix is at
 *     source on a new head SHA (`rules/ci-remediation.md` § Verifier) — the
 *     recovery watch treats a same-SHA green as a forbidden rerun. The one
 *     exception is evidence-gated, not discretionary: a `file-ci-gap.js`
 *     verdict recorded for the current head SHA grants a single allowance
 *     (Story #5343).
 *   - A red **advisory** check may be re-run — the merge wait spends its
 *     `rerunAdvisory` allowance on it (Story #5266), because an advisory job
 *     that timed out says nothing about the change.
 *
 * Required-ness that is not positively `false` is treated as required: the
 * conservative direction for a rule whose job is to refuse a rerun.
 *
 * @param {{ required?: boolean, allowanceRecorded?: boolean }} [check]
 * @returns {boolean}
 */
export function isRerunPermitted({ required, allowanceRecorded = false } = {}) {
  if (required === false) return true;
  return allowanceRecorded === true;
}
