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
/**
 * Pure: the uppercase conclusion of a check that GENUINELY concluded red, or
 * `null` when it did not.
 *
 * Red means `FAILURE` / `ERROR` only — never `CANCELLED` / `TIMED_OUT` /
 * `SKIPPED`, which are the superseded-push and sibling-invalidated runs a bare
 * rollup read miscounts (the #4695 / #4710 trap). A CheckRun carries the
 * verdict on `conclusion`; a legacy StatusContext carries it on `state`, so
 * both are read and the one that is red is the one returned.
 *
 * Extracted (Story #5266) because {@link deriveRequiredRunEvidence} and
 * {@link deriveRedHeadRuns} were carrying byte-identical copies of this test:
 * two places that must agree about what "red" means, and nothing making them.
 *
 * @param {{ conclusion?: string, state?: string }} [check]
 * @returns {string|null}
 */
function redConclusionOf(check) {
  const conclusion = String(check?.conclusion ?? '').toUpperCase();
  if (conclusion === 'FAILURE' || conclusion === 'ERROR') return conclusion;
  const state = String(check?.state ?? '').toUpperCase();
  if (state === 'FAILURE' || state === 'ERROR') return state;
  return null;
}

/**
 * Pure: a check's display name — the CheckRun's `name`, falling back to a
 * legacy StatusContext's `context`, and `null` when the projection carries
 * neither.
 *
 * A run with no readable name can never match an allowlist entry, so it always
 * blocks. That is the conservative direction for a gate whose whole purpose is
 * to stop a silent landing.
 *
 * @param {{ name?: string, context?: string }} [check]
 * @returns {string|null}
 */
function readRunName(check) {
  for (const value of [check?.name, check?.context]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export function deriveRequiredRunEvidence(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }
  let requiredRunFailed = false;
  let requiredRunInFlight = false;
  for (const check of statusCheckRollup) {
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
    if (redConclusionOf(check)) {
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
 * The one `mergeStateStatus` value that means the PR is mergeable **despite**
 * red runs — GitHub's own words are "mergeable with non-passing commit
 * status". It is the required-vs-advisory discriminator the rollup itself
 * cannot supply: under `UNSTABLE` the red runs are, by definition, not
 * required, so native auto-merge will land the PR over them.
 *
 * The exact complement of {@link MERGE_GATED_STATE}: `BLOCKED` means the red
 * run gates the merge (`failingChecksBlockMerge`), `UNSTABLE` means it does
 * not and only mandrel can stop the landing.
 */
const MERGE_ADVISORY_STATE = 'UNSTABLE';

/**
 * The fields a check projection can use to say, in its own words, WHY it went
 * red. A legacy StatusContext carries `description`; a GitHub Actions CheckRun
 * carries none of them in `gh pr view`'s fixed `statusCheckRollup` projection,
 * so the merge wait enriches the run with the check-run API's
 * `output.title` / `output.summary` before classifying (Story #5266). Both
 * shapes are read here so the projection has ONE text extractor.
 *
 * @param {object} [check] A rollup entry, or an enriched check-run record.
 * @returns {string|undefined} The joined text, or `undefined` when the record
 *   carries none — which is itself the signal that the run cannot be
 *   classified beyond "red".
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
 * Pure: the workflow run id behind a check run's `detailsUrl`
 * (`.../actions/runs/<runId>/job/<jobId>`), or `null` when the URL is absent
 * or shaped otherwise (a legacy StatusContext's `targetUrl`, a third-party
 * app's own page). A run with no id can never be re-run, which is why the
 * rerun path treats `null` as "nothing to re-run" rather than an error.
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
 * Pure: project the HEAD-ANCHORED runs that genuinely concluded red, naming
 * each one (Story #5096).
 *
 * Same red-ness test as {@link deriveRequiredRunEvidence} — `FAILURE` /
 * `ERROR` only, never `CANCELLED` / `TIMED_OUT` / `SKIPPED`, which are the
 * superseded-push and sibling-invalidated runs a bare rollup read miscounts
 * (the #4695 / #4710 trap) — but it returns the runs rather than a boolean, so
 * a block summary can name the offending job and the advisory allowlist can
 * match on it.
 *
 * `name` is the CheckRun's `name`, falling back to a legacy StatusContext's
 * `context`, and is `null` when the projection carries neither. A run with no
 * readable name can never match an allowlist entry, so it always blocks — the
 * conservative direction for a gate whose whole purpose is to stop a silent
 * landing.
 *
 * **Widened by Story #5266** from `{name, conclusion}` to carry what a red run
 * is classified and acted on by: `summary` (the run's own account of why it
 * failed — see {@link readRunSummary}), `runId` (the workflow run behind it,
 * so a rerun can be requested), and `completedAt` (the observation stamp that
 * tells a re-run's verdict apart from the stale pre-rerun one). Every added
 * field is OMITTED when the projection carries no value for it, so a run the
 * rollup describes as thinly as before still projects to exactly the old two
 * keys — and a thin run classifies as a violation, i.e. the pre-#5266 verdict.
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
 * Pure: drop the red runs a consumer has exempted via
 * `delivery.ci.advisoryAllowlist`, returning the ones that still block.
 *
 * Matching is exact on the run name. An unnamed run never matches (see
 * {@link deriveRedHeadRuns}).
 *
 * @param {Array<{ name: string|null, conclusion: string }>} redHeadRuns
 * @param {string[]} [allowlist]
 * @returns {Array<{ name: string|null, conclusion: string }>}
 */
export function selectBlockingRedRuns(redHeadRuns, allowlist = []) {
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
 * Pure: does this PR carry a genuinely red ADVISORY run — one that will NOT
 * stop GitHub from landing the PR, and therefore one only mandrel can act on?
 * (Story #5096.)
 *
 * The complement of {@link requiredCheckFailedBlocksMerge}. That predicate
 * answers "is a red REQUIRED check gating the merge" (`BLOCKED`); this one
 * answers "is a red NON-required check about to be merged straight past"
 * (`UNSTABLE`). The two are mutually exclusive by construction, so a red
 * required check keeps its existing `checks-failed` treatment untouched.
 *
 * **Fails OPEN by design.** `UNKNOWN`, `CLEAN`, `BEHIND`, or an absent
 * `mergeStateStatus` all return `false`. The asymmetry is the same one
 * {@link failingChecksBlockMerge} documents and is deliberate: failing to
 * block costs an unattended landing the operator can still revert, whereas
 * blocking wrongly strands a mergeable PR at `agent::blocked` that only an
 * operator can unpick. A transient `UNKNOWN` must never do the latter.
 *
 * @param {{ mergeStateStatus?: string, redHeadRuns?: Array<{name: string|null, conclusion: string}> }} [prProbe]
 * @param {string[]} [allowlist] `delivery.ci.advisoryAllowlist`.
 * @returns {boolean}
 */
export function advisoryCheckFailedBlocksArm(prProbe, allowlist = []) {
  if (
    String(prProbe?.mergeStateStatus ?? '').toUpperCase() !==
    MERGE_ADVISORY_STATE
  ) {
    return false;
  }
  return selectBlockingRedRuns(prProbe?.redHeadRuns, allowlist).length > 0;
}

/**
 * The two advisory-gate block classes (Story #5266). Both BLOCK — the gate's
 * verdict on whether to land is unchanged — but they authorise different acts,
 * which is the whole reason they are two:
 *
 *   - `advisory-gate-red`          A red advisory run that REPORTED a
 *                                   violation. The change is implicated;
 *                                   landing over it is a deliberate override.
 *   - `advisory-gate-inconclusive` A red advisory run that never finished — a
 *                                   scan or navigation timeout that reported
 *                                   no violation at all. Nothing here says the
 *                                   change is bad, so the proportionate remedy
 *                                   is to re-run the job, not to grant the
 *                                   permanent global exemption
 *                                   `advisoryAllowlist` is.
 */
export const ADVISORY_GATE_RED_CLASS = 'advisory-gate-red';
export const ADVISORY_GATE_INCONCLUSIVE_CLASS = 'advisory-gate-inconclusive';

/**
 * Text signatures of a run that FAILED WITHOUT FINISHING. Deliberately narrow:
 * the observed shape (Story #5266) is a `Navigation timeout of NNNN ms
 * exceeded` line with an empty violation set, and anything this list does not
 * recognise keeps the pre-#5266 `advisory-gate-red` verdict — the conservative
 * direction, since misreading a real violation as a timeout would offer the
 * operator a rerun for a finding that will come back every time.
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
/** An uncounted finding — enough on its own, because it names a verdict. */
const VIOLATION_WORD = /\bviolations?\b|\bfailed assertion/i;

/**
 * Pure: does this red run's own text report a VIOLATION (as opposed to saying
 * nothing, or saying it never got that far)?
 *
 * A counted phrase wins over the bare word so `0 violations found` — a scan
 * that completed cleanly and then died — is not read as a finding.
 *
 * Takes the text, not the run: its one caller has already established the
 * run says something, so a second empty-text guard here would be a branch no
 * input can reach.
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
 * Pure: classify ONE red advisory run as a genuine violation or an
 * unfinished job (Story #5266).
 *
 * A run whose projection carries no text at all classifies as `violation`:
 * absence of evidence is not evidence the job timed out, and `violation` is
 * the verdict every red advisory run already got before this Story.
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
 * Pure: the block class for a whole set of blocking runs.
 *
 * `advisory-gate-inconclusive` requires EVERY blocking run to be inconclusive.
 * One genuine violation beside a timeout is still a genuine violation, and the
 * operator must not be offered a rerun as the remedy for it.
 *
 * Module-private: {@link resolveAdvisoryGateVerdict} is the one door, so a
 * caller cannot take the class without the reason that matches it — and, being
 * the one door, it is also what normalises `blockingRuns` to an array, so
 * neither this nor {@link formatAdvisoryGateReason} re-guards the shape.
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
 * Pure: the advisory gate's whole verdict — class AND the reason text that
 * matches it (Story #5266). One function so a caller can never pair an
 * inconclusive class with the violation wording.
 *
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
 * Pure: the merge wait's advisory-gate decision, the sibling of
 * {@link decideMergeWaitFailFast} (Story #5096).
 *
 * Encapsulates the whole policy — the knob, the predicate, and the allowlist
 * projection — so the poll body carries a single assignment rather than three
 * decision points. `runMergePoll` sits above `check-cyclomatic`'s ceiling
 * already; every branch added inline there is a real regression, and this
 * policy has a natural home beside the predicate it consumes.
 *
 * Returns `null` when the wait should keep polling — the knob is off, the PR
 * is not in the advisory-red state, or every red run is allowlisted.
 *
 * The verdict it returns is provisional on the text the ROLLUP carried
 * (Story #5266): the caller may enrich the blocking runs with the check-run
 * API's output and re-resolve via {@link resolveAdvisoryGateVerdict} before
 * recording the block.
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
 * Format the one-line reason a `merge.unlanded` record and the operator-facing
 * block carry for an advisory-gate verdict, naming each offending job and its
 * conclusion.
 *
 * Story #5266 splits the wording by class: an unfinished job is reported as
 * one, because telling an operator a timed-out scan "concluded red" invites
 * them to grant a permanent `advisoryAllowlist` exemption for a transient
 * failure. Both wordings name the same three remedies — rerun, hand-merge,
 * allowlist — in the order proportionate to the class.
 *
 * Module-private for the same reason {@link deriveAdvisoryGateClass} is: the
 * class and the wording must travel together.
 *
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
