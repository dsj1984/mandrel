/**
 * plan-run-labels/reap.js — the one decision engine for reaping spent
 * `plan-run::<id>` cohort labels, shared by the close tail and the manual
 * sweep so the two cannot disagree. A reap failure is only ever a warning.
 *
 * @module lib/orchestration/plan-run-labels/reap
 */

import { PLAN_RUN_LABEL_PREFIX } from '../plan-persist/story-ops.js';

/**
 * - `all-closed`   — carries issues, every one closed. Reapable.
 * - `open-stories` — at least one issue still open. Never reapable.
 * - `unreferenced` — carries no issues. Reapable only under explicit opt-in,
 *   because an in-flight persist's freshly minted label looks exactly like this.
 */
export const REAP_REASONS = Object.freeze({
  ALL_CLOSED: 'all-closed',
  OPEN_STORIES: 'open-stories',
  UNREFERENCED: 'unreferenced',
});

/**
 * @param {unknown} name
 * @returns {boolean}
 */
function isPlanRunLabel(name) {
  return typeof name === 'string' && name.startsWith(PLAN_RUN_LABEL_PREFIX);
}

/**
 * Sorted, de-duplicated cohort label names from strings or `{ name }` rows.
 *
 * @param {Array<string|{ name?: string }>} [names]
 * @returns {string[]}
 */
function selectCohortLabels(names) {
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = typeof raw === 'string' ? raw : raw?.name;
    if (isPlanRunLabel(name)) seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Decide one label via the paginating read port. Any state other than
 * `closed` counts as open: an unknown state is never "safe to delete".
 *
 * @param {{ provider: object, label: string, includeUnreferenced?: boolean }} args
 * @returns {Promise<{
 *   label: string,
 *   reapable: boolean,
 *   reason: string,
 *   issueCount: number,
 *   openIssues: number[],
 * }>}
 */
async function decideCohortLabel({
  provider,
  label,
  includeUnreferenced = false,
}) {
  const result = await provider.listIssuesByLabel({
    state: 'all',
    labels: label,
  });
  const issues = Array.isArray(result) ? result : [];
  const open = issues.filter(
    (issue) => String(issue?.state ?? '').toLowerCase() !== 'closed',
  );
  if (issues.length === 0) {
    return {
      label,
      reapable: includeUnreferenced === true,
      reason: REAP_REASONS.UNREFERENCED,
      issueCount: 0,
      openIssues: [],
    };
  }
  if (open.length > 0) {
    return {
      label,
      reapable: false,
      reason: REAP_REASONS.OPEN_STORIES,
      issueCount: issues.length,
      openIssues: open
        .map((issue) => issue?.number)
        .filter((n) => Number.isInteger(n)),
    };
  }
  return {
    label,
    reapable: true,
    reason: REAP_REASONS.ALL_CLOSED,
    issueCount: issues.length,
    openIssues: [],
  };
}

/**
 * Sequential on purpose, for a deterministic label-ordered report.
 *
 * @param {{
 *   provider: object,
 *   labels: Array<string|{ name?: string }>,
 *   includeUnreferenced?: boolean,
 * }} args
 * @returns {Promise<Array<object>>} one decision per cohort label, name-sorted.
 */
async function evaluateCohortLabels({
  provider,
  labels,
  includeUnreferenced = false,
}) {
  const decisions = [];
  for (const label of selectCohortLabels(labels)) {
    decisions.push(
      await decideCohortLabel({ provider, label, includeUnreferenced }),
    );
  }
  return decisions;
}

/**
 * Decide, then (unless `check`) delete. A throwing delete is recorded in
 * `failed[]`, never propagated; an already-gone label counts as success.
 *
 * @param {{
 *   provider: object,
 *   labels: Array<string|{ name?: string }>,
 *   includeUnreferenced?: boolean,
 *   check?: boolean,
 *   onWarn?: ((message: string) => void)|null,
 * }} args
 * @returns {Promise<{
 *   check: boolean,
 *   decisions: Array<object>,
 *   reapable: string[],
 *   deleted: Array<{ label: string, existed: boolean }>,
 *   failed: Array<{ label: string, detail: string }>,
 * }>}
 */
async function reapCohortLabels({
  provider,
  labels,
  includeUnreferenced = false,
  check = false,
  onWarn = null,
}) {
  const decisions = await evaluateCohortLabels({
    provider,
    labels,
    includeUnreferenced,
  });
  const reapable = decisions.filter((d) => d.reapable).map((d) => d.label);
  const deleted = [];
  const failed = [];
  if (check !== true) {
    for (const label of reapable) {
      try {
        const outcome = await provider.deleteLabel(label);
        deleted.push({ label, existed: outcome?.deleted !== false });
      } catch (err) {
        const detail = String(err?.message ?? err);
        failed.push({ label, detail });
        onWarn?.(`could not delete cohort label "${label}": ${detail}`);
      }
    }
  }
  return { check: check === true, decisions, reapable, deleted, failed };
}

/**
 * Every state judgment is a fresh read; a Story not yet registered closed is
 * deferred to the manual sweep.
 *
 * @param {{
 *   storyId: number,
 *   provider: object,
 *   includeUnreferenced?: boolean,
 *   onWarn?: ((message: string) => void)|null,
 * }} args
 * @returns {Promise<object>} the {@link reapCohortLabels} envelope, plus
 *   `evaluated` — how many cohort labels the Story carried.
 */
export async function reapPlanRunLabelsForStory({
  storyId,
  provider,
  includeUnreferenced = false,
  onWarn = null,
}) {
  const ticket = await provider.getTicket(storyId);
  const labels = selectCohortLabels(ticket?.labels);
  if (labels.length === 0) {
    return {
      evaluated: 0,
      check: false,
      decisions: [],
      reapable: [],
      deleted: [],
      failed: [],
    };
  }
  const outcome = await reapCohortLabels({
    provider,
    labels,
    includeUnreferenced,
    onWarn,
  });
  return { evaluated: labels.length, ...outcome };
}

/**
 * Sweep every cohort label in the repository.
 *
 * @param {{
 *   provider: object,
 *   includeUnreferenced?: boolean,
 *   check?: boolean,
 *   onWarn?: ((message: string) => void)|null,
 * }} args
 * @returns {Promise<object>} the {@link reapCohortLabels} envelope, plus
 *   `totalLabels` (whole vocabulary) and `evaluated` (the cohort slice).
 */
export async function sweepCohortLabels({
  provider,
  includeUnreferenced = false,
  check = false,
  onWarn = null,
}) {
  const all = await provider.listLabels();
  const rows = Array.isArray(all) ? all : [];
  const labels = selectCohortLabels(rows);
  const outcome = await reapCohortLabels({
    provider,
    labels,
    includeUnreferenced,
    check,
    onWarn,
  });
  return { totalLabels: rows.length, evaluated: labels.length, ...outcome };
}

/** Test-only barrel, so `dead-exports --production` sees no unused exports. */
export const __testing = {
  isPlanRunLabel,
  selectCohortLabels,
  decideCohortLabel,
  evaluateCohortLabels,
  reapCohortLabels,
};
