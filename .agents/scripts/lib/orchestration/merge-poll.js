/**
 * merge-poll.js — merge-wait constants and check-rollup derivation for the
 * close path. `deriveChecksStatus` feeds `classifyMergeBlock`'s
 * `prProbe.checksStatus`.
 */

import { checkVerdict, classifyRollupEntry } from './check-state.js';

/** Fixed poll interval; default for `delivery.mergeWatch.maxBudgetSeconds`. */
export const DEFAULT_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_BUDGET_SECONDS = 3600;

/** Bounds every `gh` spawn so a hang degrades to the probe-error path. */
export const MERGE_WAIT_GH_TIMEOUT_MS = 60_000;

/**
 * Aggregate over EVERY check (the view rollup has no `isRequired`): `failure`
 * means "something is red", not "blocked" — see {@link failingChecksBlockMerge}.
 */
export function deriveChecksStatus(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return 'unknown';
  }
  let anyPending = false;
  for (const check of statusCheckRollup) {
    const verdict = checkVerdict(classifyRollupEntry(check));
    if (verdict === 'fail') return 'failure';
    if (verdict === 'pending') anyPending = true;
  }
  return anyPending ? 'still-running' : 'success';
}

/**
 * `mergedAt` counts even when `state` lags. A closed issue proves nothing.
 *
 * @param {{ state?: string|null, mergedAt?: string|null }|null|undefined} pr
 * @returns {boolean}
 */
export function isPrMerged(pr) {
  return pr?.state === 'MERGED' || Boolean(pr?.mergedAt);
}

/**
 * Red is `FAILURE` / `ERROR` only; `CANCELLED` / `TIMED_OUT` / `SKIPPED` are
 * superseded or sibling-invalidated runs.
 *
 * @param {{ conclusion?: string, state?: string }} [check]
 * @returns {string|null}
 */
export function redConclusionOf(check) {
  const conclusion = String(check?.conclusion ?? '').toUpperCase();
  if (conclusion === 'FAILURE' || conclusion === 'ERROR') return conclusion;
  const state = String(check?.state ?? '').toUpperCase();
  if (state === 'FAILURE' || state === 'ERROR') return state;
  return null;
}

/**
 * An unnamed run never matches an allowlist entry, so it always blocks.
 *
 * @param {{ name?: string, context?: string }} [check]
 * @returns {string|null}
 */
export function readRunName(check) {
  for (const value of [check?.name, check?.context]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * @param {{ status?: string, state?: string }} [check]
 * @returns {boolean}
 */
export function isRunInFlight(check) {
  const status = String(check?.status ?? '').toUpperCase();
  // `status` is empty on a StatusContext, so it falls to the `state` branch.
  if (status) return status !== 'COMPLETED';
  const state = String(check?.state ?? '').toUpperCase();
  return state === 'PENDING' || state === 'EXPECTED';
}

/**
 * Head-anchored evidence; `null` on an empty rollup (the caller falls back
 * to consecutive probes). Reads EVERY run — the unscoped rule used when
 * GitHub's required attribution is unavailable (see `required-checks.js`).
 *
 * @param {Array<{status?: string, conclusion?: string, state?: string}>} statusCheckRollup
 * @returns {{ requiredRunFailed: boolean, requiredRunInFlight: boolean } | null}
 */
export function deriveRequiredRunEvidence(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }
  return {
    requiredRunFailed: statusCheckRollup.some(
      (c) => redConclusionOf(c) !== null,
    ),
    requiredRunInFlight: statusCheckRollup.some(isRunInFlight),
  };
}

/** The `mergeStateStatus` meaning GitHub itself gates the merge. */
const MERGE_GATED_STATE = 'BLOCKED';

/**
 * Does the red status gate the merge? Only `BLOCKED` (GitHub's verdict
 * against live protection rules) says so; `UNKNOWN` keeps waiting, since a
 * wrong fail-fast strands a merged PR while waiting only costs poll time.
 *
 * @param {{ checksStatus?: string, mergeStateStatus?: string }} [prProbe]
 * @returns {boolean}
 */
export function failingChecksBlockMerge(prProbe) {
  if (prProbe?.checksStatus !== 'failure') return false;
  return (
    String(prProbe?.mergeStateStatus ?? '').toUpperCase() === MERGE_GATED_STATE
  );
}

/**
 * A missing review competes as the explanation for `BLOCKED`.
 *
 * @param {{ reviewDecision?: string }} [prProbe]
 * @returns {boolean}
 */
function reviewOwnsBlockedState(prProbe) {
  return prProbe?.reviewDecision === 'REVIEW_REQUIRED';
}

export const CHECKS_FAILED_CLASS = 'checks-failed';

/**
 * @param {{ mergeStateStatus?: string }} [prProbe]
 * @param {string} [evidencePath]
 * @returns {string}
 */
export function formatChecksFailedReason(prProbe, evidencePath) {
  return `a required check failed (mergeStateStatus=${prProbe?.mergeStateStatus ?? 'n/a'}${evidencePath ? `, evidence=${evidencePath}` : ''})`;
}

/**
 * A genuinely red REQUIRED check: gated, no review owns `BLOCKED`, a run is
 * red and none in flight — with GitHub attribution, a required run is red and
 * no re-run of it is in flight. No evidence → false (consecutive-probe path).
 *
 * @param {{ checksStatus?: string, mergeStateStatus?: string,
 *   reviewDecision?: string,
 *   requiredRunEvidence?: { requiredRunFailed?: boolean, requiredRunInFlight?: boolean } }} [prProbe]
 * @returns {boolean}
 */
export function requiredCheckFailedBlocksMerge(prProbe) {
  if (!failingChecksBlockMerge(prProbe) || reviewOwnsBlockedState(prProbe)) {
    return false;
  }
  const evidence = prProbe?.requiredRunEvidence;
  if (!evidence || typeof evidence.requiredRunFailed !== 'boolean') {
    return false;
  }
  return (
    evidence.requiredRunFailed === true && evidence.requiredRunInFlight !== true
  );
}

/**
 * Red runs are not required: auto-merge lands over them unless mandrel stops it.
 */
const MERGE_ADVISORY_STATE = 'UNSTABLE';

/**
 * The run's own account of why it went red (rollup or enriched check-run).
 *
 * @param {object} [check] A rollup entry, or an enriched check-run record.
 * @returns {string|undefined} `undefined` when the record carries no text.
 */
export function readRunSummary(check) {
  const parts = [];
  for (const field of ['description', 'title', 'summary', 'text']) {
    for (const value of [check?.[field], check?.output?.[field]]) {
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
    }
  }
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

/**
 * `null` means "nothing to re-run".
 *
 * @param {string} [detailsUrl]
 * @returns {number|null}
 */
export function parseWorkflowRunId(detailsUrl) {
  if (typeof detailsUrl !== 'string') return null;
  const match = /\/actions\/runs\/(\d+)/.exec(detailsUrl);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Red head runs. Optional fields are omitted when absent; `completedAt`
 * separates a rerun's verdict from the stale one.
 *
 * @param {Array<{name?: string, context?: string, status?: string, conclusion?: string, state?: string, detailsUrl?: string, completedAt?: string, description?: string, output?: object}>} statusCheckRollup
 * @returns {Array<{ name: string|null, conclusion: string, summary?: string, runId?: number, completedAt?: string }>}
 */
export function deriveRedHeadRuns(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) return [];
  const red = [];
  for (const check of statusCheckRollup) {
    const conclusion = redConclusionOf(check);
    if (!conclusion) continue;
    const summary = readRunSummary(check);
    const runId = parseWorkflowRunId(check?.detailsUrl);
    const completedAt = check?.completedAt;
    red.push({
      name: readRunName(check),
      conclusion,
      ...(summary ? { summary } : {}),
      ...(runId ? { runId } : {}),
      ...(typeof completedAt === 'string' && completedAt
        ? { completedAt }
        : {}),
    });
  }
  return red;
}

/**
 * Red runs not exempted by the allowlist (exact name match).
 *
 * @param {Array<{ name: string|null, conclusion: string }>} redHeadRuns
 * @param {string[]} [allowlist]
 * @returns {Array<{ name: string|null, conclusion: string }>}
 */
function selectBlockingRedRuns(redHeadRuns, allowlist = []) {
  if (!Array.isArray(redHeadRuns) || redHeadRuns.length === 0) return [];
  const exempt = new Set(
    (Array.isArray(allowlist) ? allowlist : [])
      .filter((entry) => typeof entry === 'string' && entry)
      .map((entry) => entry),
  );
  if (exempt.size === 0) return [...redHeadRuns];
  return redHeadRuns.filter((run) => !(run?.name && exempt.has(run.name)));
}

/**
 * A red advisory run about to be merged past (`UNSTABLE`). Fails open on any
 * other state: a wrong block strands a PR; a miss is a revertable landing.
 *
 * @param {{ mergeStateStatus?: string, redHeadRuns?: Array<{name: string|null, conclusion: string}> }} [prProbe]
 * @param {string[]} [allowlist] `delivery.ci.advisoryAllowlist`.
 * @returns {boolean}
 */
function advisoryCheckFailedBlocksArm(prProbe, allowlist = []) {
  if (
    String(prProbe?.mergeStateStatus ?? '').toUpperCase() !==
    MERGE_ADVISORY_STATE
  ) {
    return false;
  }
  return selectBlockingRedRuns(prProbe?.redHeadRuns, allowlist).length > 0;
}

/**
 * Both block; `-inconclusive` (never finished, e.g. a timeout) warrants a
 * rerun rather than a permanent allowlist exemption.
 */
export const ADVISORY_GATE_RED_CLASS = 'advisory-gate-red';
export const ADVISORY_GATE_INCONCLUSIVE_CLASS = 'advisory-gate-inconclusive';

/**
 * Deliberately narrow: misreading a violation as a timeout offers a rerun
 * that fails every time.
 */
const INCONCLUSIVE_MARKERS = Object.freeze([
  /navigation timeout/i,
  /timeout of \d+\s*m?s exceeded/i,
  /\btimed out\b/i,
  /\betimedout\b/i,
  /\bdid not (?:finish|complete)\b/i,
  /\b(?:scan|crawl|audit) (?:incomplete|aborted|interrupted)\b/i,
]);

/** A counted finding — `0 violations` is explicitly NOT one. */
const VIOLATION_COUNT =
  /\b(\d+)\s+(?:violation|error|issue|failure|problem|finding)s?\b/i;
const VIOLATION_WORD = /\bviolations?\b|\bfailed assertion/i;

/**
 * A counted phrase wins over the bare word.
 *
 * @param {string} text A non-empty run summary.
 * @returns {boolean}
 */
function reportsViolations(text) {
  const counted = VIOLATION_COUNT.exec(text);
  if (counted) return Number.parseInt(counted[1], 10) > 0;
  return VIOLATION_WORD.test(text);
}

/**
 * No text is a `violation`: absence of evidence is not a timeout.
 *
 * @param {{ summary?: string }} [run]
 * @returns {'violation'|'inconclusive'}
 */
function classifyAdvisoryRedRun(run) {
  const text = typeof run?.summary === 'string' ? run.summary : '';
  if (!text || reportsViolations(text)) return 'violation';
  return INCONCLUSIVE_MARKERS.some((marker) => marker.test(text))
    ? 'inconclusive'
    : 'violation';
}

/**
 * Inconclusive only when EVERY run is. Private: the class travels with its
 * reason via {@link resolveAdvisoryGateVerdict}.
 *
 * @param {Array<{ summary?: string }>} runs
 * @returns {string} one of the two advisory classes above
 */
function deriveAdvisoryGateClass(runs) {
  if (runs.length === 0) return ADVISORY_GATE_RED_CLASS;
  return runs.every((run) => classifyAdvisoryRedRun(run) === 'inconclusive')
    ? ADVISORY_GATE_INCONCLUSIVE_CLASS
    : ADVISORY_GATE_RED_CLASS;
}

/**
 * @param {{ blockingRuns?: Array<object>, rerunAllowance?: number }} [args]
 * @returns {{ blockClass: string, blockingRuns: Array<object>, reason: string }}
 */
export function resolveAdvisoryGateVerdict({
  blockingRuns,
  rerunAllowance = 0,
} = {}) {
  const runs = Array.isArray(blockingRuns) ? blockingRuns : [];
  const blockClass = deriveAdvisoryGateClass(runs);
  return {
    blockClass,
    blockingRuns: runs,
    reason: formatAdvisoryGateReason(runs, { blockClass, rerunAllowance }),
  };
}

/**
 * `null` means keep polling. Reflects rollup text only; the caller may enrich
 * and re-resolve.
 *
 * @param {object} args
 * @returns {{ blockingRuns: Array<object>, reason: string, blockClass: string } | null}
 */
export function decideAdvisoryGateBlock({
  probe,
  blockOnAdvisoryFailure,
  advisoryAllowlist,
  rerunAllowance = 0,
}) {
  if (!blockOnAdvisoryFailure) return null;
  if (!advisoryCheckFailedBlocksArm(probe, advisoryAllowlist)) return null;
  const blockingRuns = selectBlockingRedRuns(
    probe?.redHeadRuns,
    advisoryAllowlist,
  );
  return resolveAdvisoryGateVerdict({ blockingRuns, rerunAllowance });
}

/**
 * @param {Array<{ name: string|null, conclusion: string }>} runs
 * @param {{ blockClass: string, rerunAllowance: number }} options
 * @returns {string}
 */
function formatAdvisoryGateReason(runs, { blockClass, rerunAllowance }) {
  const named =
    runs
      .map(
        (run) =>
          `${run?.name ?? '(unnamed run)'} → ${run?.conclusion ?? 'FAILURE'}`,
      )
      .join(', ') || '(none named)';
  const spent =
    rerunAllowance > 0
      ? `The rerun allowance (${rerunAllowance}) is already spent on this head. `
      : '';
  if (blockClass === ADVISORY_GATE_INCONCLUSIVE_CLASS) {
    return (
      'A non-required (advisory) check FAILED WITHOUT FINISHING on the PR ' +
      'head — it reported no violation, so nothing here says the change is ' +
      'bad — and GitHub reports the PR mergeable anyway ' +
      '(mergeStateStatus=UNSTABLE), so native auto-merge would land it over ' +
      `the failure. Unfinished advisory job(s): ${named}. ` +
      `${spent}Re-run the job (--rerun-advisory <n>, or ` +
      'delivery.ci.rerunAdvisory), merge by hand to land over it ' +
      'deliberately, or exempt the job via delivery.ci.advisoryAllowlist.'
    );
  }
  return (
    'A non-required (advisory) check concluded red on the PR head, and GitHub ' +
    'reports the PR mergeable anyway (mergeStateStatus=UNSTABLE) — native ' +
    'auto-merge would land it over the failure. Red advisory job(s): ' +
    `${named}. ${spent}Merge by hand to land over it ` +
    'deliberately, re-run the job (--rerun-advisory <n>, or ' +
    'delivery.ci.rerunAdvisory), or exempt the job via ' +
    'delivery.ci.advisoryAllowlist.'
  );
}

/**
 * Fail-fast: decide on per-run evidence, else require two consecutive
 * failing probes. The verdict is carried to the terminal, never re-derived.
 *
 * @param {object} args
 * @param {object} args.probe The current poll's {@code readPrWaitProbe} result.
 * @param {number} args.consecutiveRequiredFailSnapshots Evidence-free failing
 *   probes observed so far.
 * @returns {{ failFast: boolean, consecutiveRequiredFailSnapshots: number,
 *   blockClass?: string, reason?: string, prProbe?: object,
 *   evidencePath?: 'per-run'|'consecutive-probe' }}
 */
export function decideMergeWaitFailFast({
  probe,
  consecutiveRequiredFailSnapshots,
}) {
  if (!failingChecksBlockMerge(probe)) {
    return { failFast: false, consecutiveRequiredFailSnapshots: 0 };
  }
  if (probe?.requiredRunEvidence) {
    if (requiredCheckFailedBlocksMerge(probe)) {
      return checksFailedVerdict(probe, 'per-run', 0);
    }
    // In flight, only non-required red, or review owns BLOCKED: keep polling.
    return { failFast: false, consecutiveRequiredFailSnapshots: 0 };
  }
  const next = consecutiveRequiredFailSnapshots + 1;
  if (next >= 2 && !reviewOwnsBlockedState(probe)) {
    return checksFailedVerdict(probe, 'consecutive-probe', next);
  }
  return { failFast: false, consecutiveRequiredFailSnapshots: next };
}

function checksFailedVerdict(
  probe,
  evidencePath,
  consecutiveRequiredFailSnapshots,
) {
  return {
    failFast: true,
    consecutiveRequiredFailSnapshots,
    evidencePath,
    blockClass: CHECKS_FAILED_CLASS,
    reason: formatChecksFailedReason(probe, evidencePath),
    prProbe: { ...probe, evidencePath },
  };
}
