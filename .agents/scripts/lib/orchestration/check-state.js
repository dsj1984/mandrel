// .agents/scripts/lib/orchestration/check-state.js
/**
 * check-state.js — the one CI check-state classifier and rerun rule; the
 * merge wait and recovery watch keep separate sources but adapt through here
 * so a GitHub state means the same on both sides. Pure.
 */

/** A `Map` so a key like `constructor` cannot hit a prototype member. */
const RAW_TO_OUTCOME = new Map([
  // Still running — the only non-terminal outcome.
  ['', 'pending'],
  ['pending', 'pending'],
  ['queued', 'pending'],
  ['in_progress', 'pending'],
  ['requested', 'pending'],
  ['waiting', 'pending'],
  ['expected', 'pending'],
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

const NON_FAILING_OUTCOMES = new Set(['success', 'neutral', 'skipped']);

/**
 * Unknown → `skipped`, so a new GitHub state cannot wedge a poll loop.
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
 * @param {string} outcome A {@link classifyCheckState} result.
 * @returns {'pass'|'fail'|'pending'}
 */
export function checkVerdict(outcome) {
  if (outcome === 'pending') return 'pending';
  return NON_FAILING_OUTCOMES.has(outcome) ? 'pass' : 'fail';
}

/**
 * CheckRun (`status`/`conclusion`) or legacy StatusContext (`state`).
 *
 * @param {{ status?: string, conclusion?: string, state?: string }} [check]
 * @returns {string}
 */
export function classifyRollupEntry(check) {
  const conclusion = String(check?.conclusion ?? '').trim();
  if (conclusion) return classifyCheckState(conclusion);
  const status = String(check?.status ?? '').trim();
  if (status && status.toUpperCase() !== 'COMPLETED') return 'pending';
  return classifyCheckState(check?.state ?? status);
}

/**
 * @param {{ state?: string, bucket?: string }} [entry]
 * @returns {string}
 */
export function classifyRequiredCheck(entry) {
  return classifyCheckState(entry?.state || entry?.bucket || '');
}

/**
 * A red required check is never re-run by automation (fix on a new head)
 * unless a `file-ci-gap.js` verdict is recorded for this head; an advisory
 * check may be. Anything not `required: false` counts as required.
 *
 * @param {{ required?: boolean, allowanceRecorded?: boolean }} [check]
 * @returns {boolean}
 */
export function isRerunPermitted({ required, allowanceRecorded = false } = {}) {
  if (required === false) return true;
  return allowanceRecorded === true;
}
