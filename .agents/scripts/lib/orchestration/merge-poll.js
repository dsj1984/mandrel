/**
 * merge-poll.js — merge-wait constants and check-rollup derivation owned by
 * the close path.
 *
 * Story #4545 — these three symbols used to live in the Epic-era
 * `lifecycle/listeners/merge-watcher.js`. That listener class had no
 * production caller after the v2.0.0 Story-only cutover, but it was not
 * importer-less: the live close path (`single-story-close/phases/confirm-merge.js`)
 * and `deliver-recover.js` both reached into it for the poll defaults and
 * `deriveChecksStatus`. Relocating them here lets the listener go without
 * leaving the close path importing a lifecycle module it does not otherwise
 * participate in.
 *
 * Sits beside `merge-block-class.js`, its sole consumer pairing:
 * `deriveChecksStatus` produces the `prProbe.checksStatus` value that
 * `classifyMergeBlock` reads.
 */

/**
 * Default poll interval and cumulative budget for the merge wait. The schema
 * in `.agents/schemas/agentrc.schema.json` exposes these as
 * `delivery.mergeWatch.intervalSeconds` (default 30) and
 * `delivery.mergeWatch.maxBudgetSeconds` (default 3600). Hard-coding the same
 * numbers here keeps the close path self-contained when no config is wired in
 * (e.g. unit tests).
 */
export const DEFAULT_INTERVAL_SECONDS = 30;
export const DEFAULT_MAX_BUDGET_SECONDS = 3600;

/**
 * Wall-clock bound for every `gh` subprocess the merge wait spawns (Story
 * #4710). The wait is now routinely unattended (`delivery.mergeWatch.mode:
 * "async"` runs it in a background invocation with no host tool ceiling), so
 * a hung `gh pr view` / `gh pr update-branch` used to strand the wait with no
 * terminal envelope, no label flip, and no friction record. Sixty seconds is
 * generous for a single API round-trip while staying inside the async probe
 * window; a timeout maps to the existing probe-error path, so the wait
 * degrades to conservative-pending / `api-race-other` semantics instead of
 * hanging. A framework constant by design — not config (Story #4710
 * Non-Goals).
 */
export const MERGE_WAIT_GH_TIMEOUT_MS = 60_000;

/**
 * Pure: derive an aggregate `checksStatus` (`success` | `still-running` |
 * `failure` | `unknown`) from a `statusCheckRollup` array (`gh pr view --json
 * statusCheckRollup` shape: `{ status, conclusion }` per check). Mirrors the
 * values `classifyMergeBlock` expects on `prProbe.checksStatus`.
 *
 * **Scope: EVERY check reported on the PR, required or not.** The rollup
 * carries no required-vs-optional discriminator (`gh`'s projection has no
 * `isRequired` field), so `failure` here means "something on this PR is red",
 * NOT "the merge is blocked". Use {@link failingChecksBlockMerge} before
 * treating a `failure` as terminal.
 */
export function deriveChecksStatus(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return 'unknown';
  }
  let anyPending = false;
  for (const check of statusCheckRollup) {
    const conclusion = String(check?.conclusion ?? '').toUpperCase();
    const status = String(check?.status ?? '').toUpperCase();
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(conclusion)) {
      return 'failure';
    }
    if (status !== 'COMPLETED') {
      anyPending = true;
    }
  }
  return anyPending ? 'still-running' : 'success';
}

/**
 * Pure: derive HEAD-ANCHORED per-run evidence from a `statusCheckRollup`
 * array, distinguishing a genuinely red required run from the pending /
 * superseded noise the aggregate {@link deriveChecksStatus} folds together.
 *
 * {@link deriveChecksStatus} returns `failure` the instant it sees ANY
 * non-passing conclusion — including a `CANCELLED` superseded-push run or a
 * sibling-invalidated run — even while the real required check is still
 * queued. Paired with `mergeStateStatus: BLOCKED` (the protected-branch steady
 * state while required checks run), that matched a merely *pending* PR and
 * hard-blocked Stories whose PRs merged untouched. This derivation reads the
 * two signals the fail-fast decision actually needs:
 *
 *   - `requiredRunFailed`   — a run on the head concluded `FAILURE` (or a
 *                             legacy status context is `FAILURE`/`ERROR`).
 *                             Deliberately NOT `CANCELLED`/`TIMED_OUT`/
 *                             `SKIPPED`: those are the superseded-push and
 *                             sibling-invalidated runs, not a red required
 *                             check.
 *   - `requiredRunInFlight` — any run on the head is still QUEUED /
 *                             IN_PROGRESS (a CheckRun whose status is not
 *                             `COMPLETED`, or a legacy status context still
 *                             `PENDING`/`EXPECTED`).
 *
 * Returns `null` when the rollup is absent or empty — the evidence is
 * unavailable and the caller must fall back to the consecutive-probe path
 * (a single evidence-free failing snapshot must never fail-fast).
 *
 * **Contract honesty (Story #4710).** The `requiredRun*` field names describe
 * what the evidence is USED to establish, not what this function reads: the
 * `gh pr view` rollup projection carries no `isRequired` discriminator, so
 * this derivation reads EVERY run on the head, required or not. On its own,
 * `requiredRunFailed: true` therefore means "a head run genuinely concluded
 * failure", and required-ness attribution is supplied downstream by
 * {@link requiredCheckFailedBlocksMerge}, which admits the verdict only when
 * `mergeStateStatus: BLOCKED` says GitHub itself gates the merge AND no
 * review-required signal offers a competing explanation for that BLOCKED
 * state. Do not treat this function's output as a required-only reading.
 *
 * @param {Array<{status?: string, conclusion?: string, state?: string}>} statusCheckRollup
 * @returns {{ requiredRunFailed: boolean, requiredRunInFlight: boolean } | null}
 */
export function deriveRequiredRunEvidence(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }
  let requiredRunFailed = false;
  let requiredRunInFlight = false;
  for (const check of statusCheckRollup) {
    const conclusion = String(check?.conclusion ?? '').toUpperCase();
    const status = String(check?.status ?? '').toUpperCase();
    const state = String(check?.state ?? '').toUpperCase();
    // In flight: a CheckRun not yet COMPLETED, or a legacy StatusContext still
    // PENDING/EXPECTED. `status` is empty on a StatusContext, so it degrades to
    // the `state` branch rather than counting as in-flight.
    if (status && status !== 'COMPLETED') {
      requiredRunInFlight = true;
    } else if (state === 'PENDING' || state === 'EXPECTED') {
      requiredRunInFlight = true;
    }
    // Genuinely red: FAILURE / ERROR only. CANCELLED / TIMED_OUT / SKIPPED are
    // the superseded / sibling-invalidated noise a bare rollup miscounts.
    if (
      conclusion === 'FAILURE' ||
      conclusion === 'ERROR' ||
      state === 'FAILURE' ||
      state === 'ERROR'
    ) {
      requiredRunFailed = true;
    }
  }
  return { requiredRunFailed, requiredRunInFlight };
}

/**
 * The one `mergeStateStatus` value that means GitHub itself is gating the
 * merge. See {@link failingChecksBlockMerge}.
 */
const MERGE_GATED_STATE = 'BLOCKED';

/**
 * Pure: does the PR's RED check status actually gate the merge?
 *
 * `deriveChecksStatus` aggregates the whole rollup, so it reports `failure`
 * for a red check of any kind. Branch protection — and therefore GitHub
 * native auto-merge — gates only on REQUIRED checks. A red optional check
 * (an advisory bot, or a `CANCELLED` superseded workflow run, which the
 * rollup derivation counts as a failure) says nothing about whether the PR
 * will land: auto-merge lands it regardless. Treating that as terminal is
 * what stranded a Story `agent::blocked` on a PR that merged anyway.
 *
 * `mergeStateStatus` is GitHub's own verdict, computed against the live
 * branch-protection rules, so it supplies the required-vs-optional
 * discrimination the rollup lacks:
 *
 *   - `BLOCKED`  — merging is gated. With red checks observed, the red
 *                  required check is the gate.
 *   - `UNSTABLE` — "mergeable with non-passing commit status": the red
 *                  checks are NOT required. Auto-merge will land it.
 *   - `CLEAN` / `BEHIND` / `UNKNOWN` / absent — not evidence that the red
 *     check gates the merge.
 *
 * Deliberately conservative: only `BLOCKED` returns `true`. A transient
 * `UNKNOWN` (GitHub has not finished computing the merge state) or a token
 * that cannot see the field degrades to "keep waiting" — the caller's poll
 * budget still bounds the wait and the budget-exhausted classification still
 * fires. The asymmetry is intentional: failing to fail fast costs poll time,
 * whereas failing fast wrongly costs a merged-but-`agent::blocked` strand
 * that only an operator can unpick.
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
 * Pure: does HEAD-ANCHORED evidence establish that a REQUIRED check is
 * genuinely red — enough to fail-fast the merge wait as `checks-failed`?
 *
 * This is the single gated decision Story #4695 adds, and the named predicate
 * a downstream async-confirm Story imports rather than reopening the poll
 * loop's classification internals. It layers on {@link failingChecksBlockMerge}
 * (the rollup-`failure` + `mergeStateStatus: BLOCKED` gate) the head-anchored
 * refinement the raw gate lacked: classify `checks-failed` ONLY when a run
 * genuinely concluded failure AND none is still in flight. A red rollup while
 * a required run is queued/in-progress is the protected-branch pending steady
 * state, not a failure.
 *
 * The evidence is read from `prProbe.requiredRunEvidence` (the
 * {@link deriveRequiredRunEvidence} output threaded through the probe). When it
 * is absent — older `gh`, an API error, or a probe that never carried a rollup
 * — this returns `false`: the caller's consecutive-probe fallback owns that
 * path, because a single evidence-free failing snapshot must never fail-fast.
 *
 * **Review-required softening (Story #4710).** The rollup evidence cannot
 * prove the red run is a REQUIRED check (see
 * {@link deriveRequiredRunEvidence}), so when the probe carries a competing
 * explanation for the `BLOCKED` merge state — `reviewDecision:
 * 'REVIEW_REQUIRED'`, i.e. a required approval is missing — this predicate
 * declines the `checks-failed` verdict. A red *optional* check beside a
 * missing required review used to fail-fast as `checks-failed` and send the
 * operator to fix a check that was never gating the merge; with the review
 * signal present, classification falls through to the
 * `branch-protection-human-required` branch, which names the gate GitHub
 * actually attributes. When a genuinely red required check coexists with a
 * missing review, both are true blocks and the human-required verdict is
 * still an honest one — the conservative direction (see
 * {@link failingChecksBlockMerge} on why failing to fail fast is the cheap
 * error).
 *
 * @param {{ checksStatus?: string, mergeStateStatus?: string,
 *   reviewDecision?: string,
 *   requiredRunEvidence?: { requiredRunFailed?: boolean, requiredRunInFlight?: boolean } }} [prProbe]
 * @returns {boolean}
 */
export function requiredCheckFailedBlocksMerge(prProbe) {
  if (!failingChecksBlockMerge(prProbe)) return false;
  if (prProbe?.reviewDecision === 'REVIEW_REQUIRED') return false;
  const evidence = prProbe?.requiredRunEvidence;
  if (!evidence || typeof evidence.requiredRunFailed !== 'boolean') {
    return false;
  }
  return (
    evidence.requiredRunFailed === true && evidence.requiredRunInFlight !== true
  );
}

/**
 * Pure: the merge wait's single fail-fast decision (Story #4710 — extracted
 * from the two near-verbatim inline blocks in `runConfirmMergePhase`'s poll
 * loop, beside its sibling predicates).
 *
 * Encapsulates the Story #4695 evidence policy in one place:
 *
 *   - **Per-run evidence available** — decide on this single probe via
 *     {@link requiredCheckFailedBlocksMerge}; a required run still in flight
 *     (or only superseded / non-required noise red) resets the counter and
 *     keeps polling.
 *   - **Evidence unavailable** (older `gh`, API error, empty rollup) — require
 *     TWO consecutive failing probes at least one poll interval apart, then
 *     synthesize the evidence shape the classifier's gate reads so both paths
 *     classify `checks-failed` through the same predicate.
 *
 * Returns the next counter value alongside the verdict; the caller owns the
 * mutable counter and the terminal side effects. When `failFast` is `true`,
 * `prProbe` is the evidence-stamped probe to hand to the classifier and
 * `evidencePath` names which path fired (`per-run` | `consecutive-probe`) for
 * the `merge.unlanded` telemetry.
 *
 * @param {object} args
 * @param {object} args.probe The current poll's {@code readPrWaitProbe} result.
 * @param {number} args.consecutiveRequiredFailSnapshots Evidence-free failing
 *   probes observed so far.
 * @returns {{ failFast: boolean, consecutiveRequiredFailSnapshots: number,
 *   prProbe?: object, evidencePath?: 'per-run'|'consecutive-probe' }}
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
      return {
        failFast: true,
        consecutiveRequiredFailSnapshots: 0,
        evidencePath: 'per-run',
        prProbe: { ...probe, evidencePath: 'per-run' },
      };
    }
    // A required run is still in flight, only non-required / superseded runs
    // are red, or a missing required review owns the BLOCKED state: the
    // protected-branch steady state, not a failure. Keep polling.
    return { failFast: false, consecutiveRequiredFailSnapshots: 0 };
  }
  const next = consecutiveRequiredFailSnapshots + 1;
  // Synthesize the evidence the classifier's gate reads, so the
  // consecutive-probe path classifies `checks-failed` through the SAME
  // predicate as the per-run path (including its review-required softening).
  const synthesized = {
    ...probe,
    requiredRunEvidence: {
      requiredRunFailed: true,
      requiredRunInFlight: false,
    },
    evidencePath: 'consecutive-probe',
  };
  if (next >= 2 && requiredCheckFailedBlocksMerge(synthesized)) {
    return {
      failFast: true,
      consecutiveRequiredFailSnapshots: next,
      evidencePath: 'consecutive-probe',
      prProbe: synthesized,
    };
  }
  return { failFast: false, consecutiveRequiredFailSnapshots: next };
}
