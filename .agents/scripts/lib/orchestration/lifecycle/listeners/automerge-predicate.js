// .agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js
/**
 * AutomergePredicate — lifecycle listener that decides whether the Epic
 * PR is safe to auto-merge after the required-check watch settles.
 * Story #2256 / Task #2260 (Epic #2172); inlined from the now-deleted
 * legacy `automerge-predicate` module in Story #2415 (Epic #2307).
 * Rewritten in Story #4361 (Epic #4355) so green required CI is the
 * arming signal, gated by the `delivery.ci.autoMerge` policy.
 *
 * Subscribes to:
 *   - `epic.automerge.start` (production path, Story #3901) → the
 *     `/deliver` Phase 8.5 boundary that the `lifecycle-emit.js`
 *     CLI actually fires. This event carries `prUrl` but NO
 *     `checkOutcomes`. Before Story #4361 the listener trusted Phase 8
 *     (`pr-watch-with-update.js`) to have polled every required check to
 *     green and therefore skipped any CI probe on this path. That left a
 *     hole (Story #3901): if the Phase 8 watch was interrupted (host
 *     crash, `/loop` handoff, operator resume) the predicate could arm
 *     merge with red or pending required checks. Story #4361 closes it —
 *     the listener now runs a LIVE `gh pr checks --required` probe on
 *     `epic.automerge.start` and refuses to arm when any required check
 *     is not green, regardless of what Phase 8 believed.
 *   - `epic.watch.end` (test-only `Watcher` path) → carries an
 *     all-settled `checkOutcomes` map. Any non-passing required check
 *     is a hard block evaluated BEFORE the structured-signal evaluator.
 *     On this path the pre-supplied `checkOutcomes` map IS the CI truth,
 *     so no live probe is issued (the map is authoritative).
 *
 * Policy (`delivery.ci.autoMerge`, Story #4356 / #4361):
 *   - `"trust-ci"` (framework default) — green required CI is the arming
 *     signal. The ONLY structured conditions that block arming are an
 *     unresolved 🔴 critical (red) code-review finding or an
 *     `agent::blocked` state (a story-level blocker recorded in
 *     run-state, or a missing run-state checkpoint we cannot certify).
 *     Manual interventions, 🟠 warning-level findings, and a non-clean
 *     retro are RECORDED for audit (surfaced on the verdict and the
 *     classification log) but no longer block the merge.
 *   - `"strict"` — restores the prior clean-sprint predicate EXACTLY:
 *     zero manual interventions, every Story done, no story blockers,
 *     no 🔴/🟠 review findings, and a machine-readable `cleanSprint`
 *     retro trailer. Any dirty signal blocks.
 *
 * Code-review parse-miss policy (Story #4222): a code-review comment that is
 * present but whose severity bullets cannot be parsed is treated as a DISTINCT
 * condition — surfaced via the `codeReviewUnparseable` signal — and FAILS OPEN
 * rather than blocking. Failing closed on a format miss is indistinguishable,
 * to the operator and to downstream telemetry, from a real disqualifying
 * finding; a parser miss must never masquerade as "the signal said no" inside
 * a generic `epic.merge.blocked`. Genuine critical/high findings still block
 * (per policy), because those require the counts to have parsed.
 *
 * Idempotency contract (AC-10): per-instance `Set<string>` of
 * `${event}:${seqId}` keys. A repeat `(event, seqId)` short-circuits
 * without re-evaluating and emits nothing. The evaluator is read-only
 * on GitHub state, so re-running it is safe; the seqId guard is the
 * defence against double-emit.
 *
 * Side-effect firewall: the listener calls the read-only evaluator, runs
 * the read-only `gh pr checks` probe, and emits on the bus. It does NOT
 * mutate labels, post comments, or call `notify`. Downstream consumers
 * (`AutomergeArmer` on `epic.merge.ready`; LabelTransitioner /
 * StructuredCommentPoster on `epic.merge.blocked`) own those side
 * effects. AutomergeArmer remains the SOLE site that shells `gh pr merge`
 * (the merge-lockout lint in `check-lifecycle-lint.js` enforces this).
 */

import { spawnSync } from 'node:child_process';

import { hasSurvivingCritical } from '../../../audit-suite/findings.js';
import { getCiDelivery } from '../../../config/ci.js';
import { parsePrNumberFromUrl } from '../../../github-url.js';
import * as epicRunStateStore from '../../epic-run-state-store.js';
import { findStructuredComment } from '../../ticketing.js';
import { emitMergeUnlanded } from '../emit-merge-unlanded.js';
import { normalizeCheckState, RECOGNIZED_CHECK_STATES } from './watcher.js';

/**
 * Outcomes that count as "this required check did not block the merge".
 * `'neutral'` and `'skipped'` are non-failures by GitHub's own
 * convention; `'success'` is the happy path.
 *
 * Pure — exported for tests.
 */
export const NON_FAILING_CHECK_OUTCOMES = Object.freeze(
  new Set(['success', 'neutral', 'skipped']),
);

/**
 * Reason categories emitted by the structured-signal evaluator. The
 * policy layer (`applyAutoMergePolicy`) decides which categories block
 * arming under each `delivery.ci.autoMerge` posture. Pure constant —
 * exported so the taxonomy is reviewable as code.
 *
 *   - `criticalReview` — an unresolved 🔴 critical (red) code-review
 *     finding. Blocks under BOTH policies.
 *   - `blockedState`   — an `agent::blocked` state (story-level blocker
 *     recorded in run-state, non-done stories, or a missing run-state
 *     checkpoint). Blocks under BOTH policies.
 *   - `warningReview`  — a 🟠 warning-level (high-risk) code-review
 *     finding. Blocks under `strict` only.
 *   - `intervention`   — a recorded manual intervention. Blocks under
 *     `strict` only.
 *   - `retro`          — a non-clean / missing retro verdict trailer.
 *     Blocks under `strict` only.
 */
export const REASON_CATEGORY = Object.freeze({
  CRITICAL_REVIEW: 'criticalReview',
  BLOCKED_STATE: 'blockedState',
  WARNING_REVIEW: 'warningReview',
  INTERVENTION: 'intervention',
  RETRO: 'retro',
});

/**
 * Categories that block arming under the default `"trust-ci"` policy.
 * Everything else is recorded for audit but does not block. Pure —
 * exported for tests.
 */
export const TRUST_CI_BLOCKING_CATEGORIES = Object.freeze(
  new Set([REASON_CATEGORY.CRITICAL_REVIEW, REASON_CATEGORY.BLOCKED_STATE]),
);

/**
 * Regex that extracts the machine-readable auto-merge verdict trailer
 * emitted by the retro body composer (`retro/phases/compose-body.js`,
 * Story #3901). Shape:
 *   `<!-- automerge-verdict: {"cleanSprint":true,"scorecard":{…}} -->`
 *
 * Reading a parsed JSON boolean replaces the pre-#3901 emoji
 * `.includes('🟢 Clean sprint')` string-match — a brittle prose scan
 * that false-positived on any retro that quoted the marker and
 * false-negatived on any compact-body copy edit. Pure — exported for
 * tests so the trailer contract is reviewable as code.
 */
export const AUTOMERGE_VERDICT_TRAILER_RE =
  /<!--\s*automerge-verdict:\s*(\{[\s\S]*?\})\s*-->/;

/**
 * Parse the machine-readable auto-merge verdict trailer out of a retro
 * body. Returns the decoded object on success, or `null` when the
 * trailer is absent or its JSON payload is malformed (a malformed
 * trailer is treated as "no verdict", which downstream disqualifies
 * the Epic rather than silently passing). Pure — exported for tests.
 *
 * @param {string} body
 * @returns {{ cleanSprint?: boolean, scorecard?: object } | null}
 */
export function parseAutomergeVerdictTrailer(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  const m = AUTOMERGE_VERDICT_TRAILER_RE.exec(body);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Reduce a `checkOutcomes` map to the list of names that did NOT pass.
 * Pure — exported for tests so the failure-classification rule is
 * reviewable as code. Returns `[]` for an all-green map.
 */
export function listFailingChecks(checkOutcomes) {
  const failures = [];
  for (const [name, outcome] of Object.entries(checkOutcomes ?? {})) {
    if (!NON_FAILING_CHECK_OUTCOMES.has(outcome)) {
      failures.push({ name, outcome });
    }
  }
  return failures;
}

/**
 * Format a non-empty failing-check list into a single-line `reason`
 * string for the `epic.merge.blocked` emit. Pure — exported for tests.
 */
export function formatCheckFailureReason(failures) {
  const parts = failures.slice(0, 5).map((f) => `${f.name}=${f.outcome}`);
  const suffix = failures.length > 5 ? `; +${failures.length - 5} more` : '';
  return `required checks not green: ${parts.join(', ')}${suffix}`;
}

/**
 * Default live `gh pr checks --required` probe. Mirrors the Watcher's
 * spawn shape (`--json name,state,bucket,workflow`) so the required-set
 * projection is identical. Pure-spawn helper — exported so tests can
 * stub the shell-out. Returns the raw spawn envelope; the caller
 * classifies the payload.
 *
 * @param {{ prUrl: string, cwd?: string, spawnFn?: typeof spawnSync }} opts
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function probeRequiredChecks({ prUrl, cwd, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'checks', prUrl, '--required', '--json', 'name,state,bucket'],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Classify a live `gh pr checks --required` probe envelope into a
 * `{ ok, reason, outcomes }` verdict. Pure — exported for tests.
 *
 *   - `ok: true`  → every required check is green (non-failing) AND the
 *     probe returned a parseable, non-empty required-check set.
 *   - `ok: false` → at least one required check is not green, the probe
 *     shelled out non-zero, or the payload could not be parsed. A probe
 *     we cannot read is a hard block: we NEVER arm merge on an
 *     unreadable CI signal (fail closed on the CI gate specifically —
 *     the opposite of the code-review parse-miss policy, because CI
 *     greenness is the whole point of the trust-ci arming signal).
 *
 * `gh pr checks --required` exits non-zero (status 8) when a required
 * check has failed OR is still pending, so a non-zero status is treated
 * as "not green" only when we cannot otherwise read a clean set from
 * stdout. We parse stdout first (it is populated even on the non-zero
 * exit) and classify from the outcomes.
 *
 * Story #4472 — checks-less repos. In a repo with zero required checks
 * (no branch protection, or protection that requires no status checks),
 * `gh pr checks --required` writes NOTHING to stdout and reports
 * `no checks reported on the <branch> branch` to stderr with a non-zero
 * exit. That is the SAME empty-parsed-set condition the outcomes loop
 * below already treats as green — there is simply nothing to gate on — so
 * we must not conflate it with a genuine probe failure (auth, network, no
 * PR). We detect the `no checks reported` stderr signature and return
 * green, UNLESS the consumer opted into `delivery.ci.requireChecks`, in
 * which case the absent CI gate is a deliberate hard block.
 *
 * @param {{ status: number, stdout: string, stderr: string }} probe
 * @param {{ requireChecks?: boolean }} [opts] When `requireChecks` is
 *   true, a checks-less repo fails closed instead of arming.
 * @returns {{ ok: boolean, reason: string|null, outcomes: Record<string, string> }}
 */
export function classifyRequiredChecksProbe(
  probe,
  { requireChecks = false } = {},
) {
  const stdout = String(probe?.stdout ?? '').trim();
  const stderr = String(probe?.stderr ?? '').trim();
  // Empty stdout: either a checks-less repo (green, nothing to gate on) or
  // a genuine probe failure. The `no checks reported` stderr signature
  // distinguishes them.
  if (stdout.length === 0) {
    const noChecksReported = /no checks reported/i.test(stderr);
    if (noChecksReported && !requireChecks) {
      // Zero required checks configured — matches the empty-parsed-set
      // "treated as green" branch below. Nothing to gate on.
      return { ok: true, reason: null, outcomes: {} };
    }
    if (noChecksReported && requireChecks) {
      return {
        ok: false,
        reason:
          'no required checks reported and delivery.ci.requireChecks is set — failing closed per policy',
        outcomes: {},
      };
    }
    return {
      ok: false,
      reason:
        `live required-check probe failed (status=${probe?.status ?? 'unknown'})` +
        (stderr ? `: ${stderr.slice(0, 200)}` : ''),
      outcomes: {},
    };
  }
  let entries;
  try {
    const parsed = JSON.parse(stdout);
    entries = Array.isArray(parsed) ? parsed : null;
  } catch {
    entries = null;
  }
  if (!entries) {
    return {
      ok: false,
      reason: 'live required-check probe returned an unparseable payload',
      outcomes: {},
    };
  }
  const outcomes = {};
  for (const e of entries) {
    if (e && typeof e === 'object' && typeof e.name === 'string') {
      const raw = String(e.state || e.bucket || '')
        .trim()
        .toLowerCase();
      // Fail closed on the arming probe: a token we have not enumerated
      // could be a genuinely-failing GitHub conclusion. normalizeCheckState
      // collapses unknowns to 'skipped' (safe for the watch path, unsafe
      // here), so map an unrecognized token to 'unknown' — which is not in
      // NON_FAILING_CHECK_OUTCOMES and therefore blocks arming.
      outcomes[e.name] = RECOGNIZED_CHECK_STATES.has(raw)
        ? normalizeCheckState(raw)
        : 'unknown';
    }
  }
  // An empty required set (no required checks configured) is treated as
  // green — there is nothing to gate on. This matches branch protection
  // that requires no status checks.
  const failing = [];
  for (const [name, outcome] of Object.entries(outcomes)) {
    // `pending` is NOT in NON_FAILING — a still-running required check
    // blocks arming (the Phase 8 watch was interrupted before green).
    if (!NON_FAILING_CHECK_OUTCOMES.has(outcome)) {
      failing.push({ name, outcome });
    }
  }
  if (failing.length > 0) {
    return { ok: false, reason: formatCheckFailureReason(failing), outcomes };
  }
  return { ok: true, reason: null, outcomes };
}

/**
 * Regex-parse the rendered severity bullets on the code-review markdown
 * body. Pure. Exported for tests.
 *
 * @param {string} body
 * @returns {{ critical: number|null, high: number|null, medium: number|null, suggestion: number|null }}
 */
export function parseSeverityCounts(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return { critical: null, high: null, medium: null, suggestion: null };
  }
  const match = (re) => {
    const m = body.match(re);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    critical: match(/🔴\s*Critical Blocker:\s*(\d+)/i),
    high: match(/🟠\s*High Risk:\s*(\d+)/i),
    medium: match(/🟡\s*Medium Risk:\s*(\d+)/i),
    suggestion: match(/🟢\s*Suggestion:\s*(\d+)/i),
  };
}

/**
 * Push a categorized reason onto the reasons array. Each reason carries
 * a `category` (from `REASON_CATEGORY`) so the policy layer can decide
 * whether it blocks under the active posture, plus a human-facing
 * `message`. Pure helper.
 */
function pushReason(reasons, category, message) {
  reasons.push({ category, message });
}

function evaluateStateSignals(state, reasons) {
  const interventionCount = Array.isArray(state?.manualInterventions)
    ? state.manualInterventions.length
    : 0;
  if (!state) {
    // A missing checkpoint means we cannot certify the run at all — this
    // is a blocked-state condition (we do not know whether a Story is
    // blocked), so it blocks under BOTH policies.
    pushReason(
      reasons,
      REASON_CATEGORY.BLOCKED_STATE,
      'epic-run-state checkpoint missing — cannot certify clean run',
    );
  } else if (interventionCount > 0) {
    pushReason(
      reasons,
      REASON_CATEGORY.INTERVENTION,
      `manual interventions recorded (${interventionCount}): ${state.manualInterventions
        .map((i) => i.reason)
        .slice(0, 3)
        .join('; ')}${interventionCount > 3 ? '; …' : ''}`,
    );
  }
  // Story #4155 — the ready-set runtime records a flat per-Story status map
  // on the checkpoint (`stories: { [id]: { status, blockerCommentId? } }`)
  // instead of a per-wave `waves[]` history. The clean-run certification
  // reads it directly: a run is clean only when every Story reached `done`
  // and none carries a recorded blocker comment.
  const stories =
    state?.stories && typeof state.stories === 'object' ? state.stories : {};
  const storyStatuses = Object.values(stories).map(
    (s) => s?.status ?? 'pending',
  );
  const nonDoneStatuses = storyStatuses.filter((s) => s !== 'done');
  if (nonDoneStatuses.length > 0) {
    // A story not done is an unfinished / blocked run — blocks under both.
    pushReason(
      reasons,
      REASON_CATEGORY.BLOCKED_STATE,
      `${nonDoneStatuses.length} story(ies) not done (statuses: ${nonDoneStatuses.join(', ')})`,
    );
  }
  const storyBlockers = countStoryBlockers(stories);
  if (storyBlockers > 0) {
    // A recorded story-level blocker is the `agent::blocked` state — it
    // blocks under both policies.
    pushReason(
      reasons,
      REASON_CATEGORY.BLOCKED_STATE,
      `${storyBlockers} story-level blocker(s) recorded in run-state`,
    );
  }
  return { interventionCount, storyStatuses, storyBlockers };
}

/**
 * Count blockers in the flat per-Story `stories` status map: each Story with
 * a recorded `blockerCommentId` and each Story whose status is not `done`
 * contributes one blocker (matching the prior per-wave count semantics).
 *
 * @param {Record<string, { status?: string, blockerCommentId?: string }>} stories
 * @returns {number}
 */
function countStoryBlockers(stories) {
  let blockers = 0;
  for (const s of Object.values(stories ?? {})) {
    if (
      s &&
      typeof s.blockerCommentId === 'string' &&
      s.blockerCommentId.length > 0
    ) {
      blockers += 1;
    }
    if (s?.status && s.status !== 'done') {
      blockers += 1;
    }
  }
  return blockers;
}

function evaluateCodeReviewSignals(codeReview, reasons) {
  const codeReviewFound = !!codeReview && typeof codeReview.body === 'string';
  const severity = codeReviewFound
    ? parseSeverityCounts(codeReview.body)
    : { critical: null, high: null, medium: null, suggestion: null };
  if (!codeReviewFound) {
    // A missing code-review comment is a soft signal — it does not, on
    // its own, prove a critical finding. Categorize it as a warning-level
    // reason so it blocks under `strict` (which demands the clean gate)
    // but not under `trust-ci` (which only blocks on a PARSED 🔴 count).
    pushReason(
      reasons,
      REASON_CATEGORY.WARNING_REVIEW,
      'code-review structured comment not found on Epic',
    );
    return { codeReviewFound, codeReviewUnparseable: false, severity };
  }
  // "Present but unparseable" is a DISTINCT condition from "present and says
  // no" (Story #4222). The canonical renderer
  // (`review-providers/findings-renderer.js`) always emits all four severity
  // bullets, so a body whose critical/high counts we cannot extract is a
  // FORMAT MISS, not a disqualifying signal. Failing closed here — pushing a
  // generic block reason — is indistinguishable, to the operator and to
  // downstream telemetry (the mandrel-bench Autonomy dimension), from a real
  // critical finding: it stalls an otherwise-clean unattended run for a
  // non-reason.
  //
  // Chosen policy: FAIL OPEN on an unparseable code-review body. We surface
  // the condition explicitly via the `codeReviewUnparseable` signal so
  // telemetry can tell a parser miss from a true HITL hand-off, but we do NOT
  // add a disqualifying `reasons[]` entry — the absence of a parseable
  // critical/high count cannot, on its own, block a run whose other signals
  // are clean. Genuine disqualifying review findings (critical > 0 /
  // high > 0) still block below, because those require the counts to have
  // parsed successfully.
  const codeReviewUnparseable =
    severity.critical === null || severity.high === null;
  if (codeReviewUnparseable) {
    return { codeReviewFound, codeReviewUnparseable, severity };
  }
  // Route the halt-on-critical decision through the single halting rule of
  // the unified verification-results contract (Story #4411) rather than a
  // re-derived `critical > 0` expression. The unparseable branch above has
  // already returned, so `severity.critical` is a concrete number here.
  if (hasSurvivingCritical(severity)) {
    pushReason(
      reasons,
      REASON_CATEGORY.CRITICAL_REVIEW,
      `code-review has ${severity.critical} 🔴 Critical Blocker(s)`,
    );
  }
  if (severity.high > 0) {
    pushReason(
      reasons,
      REASON_CATEGORY.WARNING_REVIEW,
      `code-review has ${severity.high} 🟠 High Risk finding(s)`,
    );
  }
  return { codeReviewFound, codeReviewUnparseable, severity };
}

function evaluateRetroSignals(retro, reasons) {
  const retroFound = !!retro && typeof retro.body === 'string';
  if (!retroFound) {
    pushReason(
      reasons,
      REASON_CATEGORY.RETRO,
      'retro structured comment not found on Epic',
    );
    return { retroFound, retroCompact: false };
  }
  // Read the machine-readable verdict trailer instead of string-matching
  // the human-facing "🟢 Clean sprint" prose (Story #3901). A missing or
  // malformed trailer is a hard disqualifier under `strict` — we never arm
  // strict-policy auto-merge on a retro whose verdict we cannot read.
  const verdict = parseAutomergeVerdictTrailer(retro.body);
  if (!verdict) {
    pushReason(
      reasons,
      REASON_CATEGORY.RETRO,
      'retro is missing the machine-readable automerge-verdict trailer (cannot certify clean sprint)',
    );
    return { retroFound, retroCompact: false };
  }
  const retroCompact = verdict.cleanSprint === true;
  if (!retroCompact) {
    pushReason(
      reasons,
      REASON_CATEGORY.RETRO,
      'retro automerge-verdict trailer reports cleanSprint=false (full retro indicates friction / parked / interventions)',
    );
  }
  return { retroFound, retroCompact };
}

/**
 * Pure verdict-from-signals function. Composes the three signal sources into
 * a single envelope. The `clean` boolean is the strict-policy verdict (true
 * iff there are zero reasons of any category) — it is preserved so the
 * `strict` policy restores the prior predicate EXACTLY. `reasons` is the
 * flat string[] of human-facing messages (byte-identical to the pre-#4361
 * output for the same inputs); `categorizedReasons` is the same list tagged
 * with a `REASON_CATEGORY` so the policy filter (`applyAutoMergePolicy`) can
 * narrow which reasons block per posture. Exported for tests.
 *
 * @param {{
 *   state: object|null,
 *   codeReview: { body: string }|null,
 *   retro: { body: string }|null,
 * }} input
 * @returns {{
 *   clean: boolean,
 *   reasons: string[],
 *   categorizedReasons: Array<{ category: string, message: string }>,
 *   signals: {
 *     manualInterventions: number,
 *     storyStatuses: string[],
 *     storyBlockers: number,
 *     severity: { critical: number|null, high: number|null, medium: number|null, suggestion: number|null },
 *     codeReviewUnparseable: boolean,
 *     retroCompact: boolean,
 *     codeReviewFound: boolean,
 *     retroFound: boolean,
 *     stateFound: boolean,
 *   },
 * }}
 */
export function deriveAutoMergeVerdict({ state, codeReview, retro }) {
  const categorizedReasons = [];
  const stateSig = evaluateStateSignals(state, categorizedReasons);
  const reviewSig = evaluateCodeReviewSignals(codeReview, categorizedReasons);
  const retroSig = evaluateRetroSignals(retro, categorizedReasons);

  return {
    // `clean` is the STRICT verdict: no reason of any category. This is the
    // exact pre-#4361 predicate, preserved so `strict` policy is unchanged.
    clean: categorizedReasons.length === 0,
    // Flat string[] — byte-identical to the pre-#4361 reason messages.
    reasons: categorizedReasons.map((r) => r.message),
    categorizedReasons,
    signals: {
      manualInterventions: stateSig.interventionCount,
      storyStatuses: stateSig.storyStatuses,
      storyBlockers: stateSig.storyBlockers,
      severity: reviewSig.severity,
      codeReviewUnparseable: reviewSig.codeReviewUnparseable,
      retroCompact: retroSig.retroCompact,
      codeReviewFound: reviewSig.codeReviewFound,
      retroFound: retroSig.retroFound,
      stateFound: !!state,
    },
  };
}

/**
 * Apply the `delivery.ci.autoMerge` policy to a categorized verdict.
 * Returns the EFFECTIVE arming decision plus the split of blocking vs.
 * recorded-only reasons. Pure — exported for tests.
 *
 *   - `"strict"`   → every reason blocks (identical to the pre-#4361
 *     `clean` verdict). `recordedReasons` is empty.
 *   - `"trust-ci"` → only `criticalReview` / `blockedState` reasons
 *     block; the rest (interventions, warnings, retro) land in
 *     `recordedReasons` for audit and do NOT gate the merge.
 *
 * @param {{ clean: boolean, categorizedReasons: Array<{ category: string, message: string }> }} verdict
 * @param {'trust-ci'|'strict'} policy
 * @returns {{
 *   arm: boolean,
 *   policy: 'trust-ci'|'strict',
 *   blockingReasons: Array<{ category: string, message: string }>,
 *   recordedReasons: Array<{ category: string, message: string }>,
 * }}
 */
export function applyAutoMergePolicy(verdict, policy) {
  const reasons = Array.isArray(verdict?.categorizedReasons)
    ? verdict.categorizedReasons
    : [];
  if (policy === 'strict') {
    return {
      arm: reasons.length === 0,
      policy: 'strict',
      blockingReasons: reasons,
      recordedReasons: [],
    };
  }
  // trust-ci (default): only critical-review and blocked-state reasons gate.
  const blockingReasons = [];
  const recordedReasons = [];
  for (const r of reasons) {
    if (TRUST_CI_BLOCKING_CATEGORIES.has(r.category)) {
      blockingReasons.push(r);
    } else {
      recordedReasons.push(r);
    }
  }
  return {
    arm: blockingReasons.length === 0,
    policy: 'trust-ci',
    blockingReasons,
    recordedReasons,
  };
}

/**
 * Join a categorized reason list into a single-line `reason` string for
 * the `epic.merge.blocked` emit / classification log. Pure.
 */
function formatReasons(reasons, prefix = '') {
  const messages = reasons.map((r) => r.message);
  const head = messages.slice(0, 3).join('; ');
  const suffix = messages.length > 3 ? `; +${messages.length - 3} more` : '';
  return `${prefix}${head}${suffix}`;
}

/**
 * IO-bound entry. Loads all three signal sources from the structured-comment
 * surface on the Epic ticket and hands them to `deriveAutoMergeVerdict`.
 * DI-friendly via the `findCommentFn` and `readRunStateFn` hooks; both
 * default to the production stack (the `epic-run-state-store.read` function
 * replaces the previous `checkpointerFactory` indirection introduced by the
 * now-deleted `Checkpointer` class).
 *
 * @param {{
 *   provider: object,
 *   epicId: number,
 *   findCommentFn?: typeof findStructuredComment,
 *   readRunStateFn?: typeof epicRunStateStore.read,
 * }} opts
 * @returns {Promise<{ clean: boolean, reasons: object[], signals: object }>}
 */
export async function evaluateAutoMergePredicate({
  provider,
  epicId,
  findCommentFn = findStructuredComment,
  readRunStateFn = epicRunStateStore.read,
}) {
  if (!provider)
    throw new TypeError('evaluateAutoMergePredicate: provider required');
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'evaluateAutoMergePredicate: epicId must be a positive integer',
    );
  }

  // Sequential awaits (not Promise.all) — the lifecycle lint surface forbids
  // Promise.all under `lib/orchestration/lifecycle/**` because parallelizing
  // listener invocations breaks bus repeatability. This evaluator is read-
  // only IO, but the rule is directory-scoped; sequencing here is a
  // cheap concession for living inside the listener tree.
  const state = await readRunStateFn({ provider, epicId });
  const codeReview = await findCommentFn(
    provider,
    epicId,
    'verification-results',
  );
  let retro = await findCommentFn(provider, epicId, 'retro');
  if (!retro) {
    retro = await findCommentFn(provider, epicId, 'retro-partial');
  }

  return deriveAutoMergeVerdict({ state, codeReview, retro });
}

/**
 * AutomergePredicate listener.
 */
export class AutomergePredicate {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {number} opts.epicId
   * @param {object} opts.provider GitHub provider (passed through to the
   *   evaluator). Required for the read of run-state + structured
   *   comments.
   * @param {object} [opts.config] Resolved agent config. Read for the
   *   `delivery.ci.autoMerge` policy and the `delivery.ci.requireChecks`
   *   fail-closed-without-checks policy via `getCiDelivery`. Defaults to the
   *   framework defaults (`trust-ci` / `requireChecks: false`) when omitted.
   * @param {boolean} [opts.headless] When true (a `/deliver --yes` run), a
   *   predicate refusal escalates to an explicit `merge.unlanded` +
   *   `epic.blocked` terminal instead of silently parking on the
   *   operator-merges path (Story #4472). Defaults to `false` (attended).
   * @param {string} [opts.cwd] Working directory for the live
   *   `gh pr checks --required` probe. Defaults to `process.cwd()`.
   * @param {Function} [opts.evaluatePredicateFn] override of
   *   `evaluateAutoMergePredicate` for tests.
   * @param {Function} [opts.probeRequiredChecksFn] override of
   *   `probeRequiredChecks` for tests.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError(
        'AutomergePredicate requires a bus with on() and emit()',
      );
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('AutomergePredicate requires a numeric epicId');
    }
    if (!opts.provider) {
      throw new TypeError('AutomergePredicate requires a provider');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.provider = opts.provider;
    this.cwd = opts.cwd ?? process.cwd();
    // Resolve the merge posture + fail-closed policy once at construction.
    // `getCiDelivery` applies the framework defaults (`trust-ci` /
    // `requireChecks: false`) for any omitted field.
    const ci = getCiDelivery(opts.config ?? null);
    this.policy = ci.autoMerge;
    this.requireChecks = ci.requireChecks;
    this.headless = opts.headless === true;
    this.evaluatePredicateFn =
      opts.evaluatePredicateFn ?? evaluateAutoMergePredicate;
    this.probeRequiredChecksFn =
      opts.probeRequiredChecksFn ?? probeRequiredChecks;
    // Injected for tests so the headless terminal escalation can be
    // observed without touching disk.
    this.emitMergeUnlandedFn = opts.emitMergeUnlandedFn ?? emitMergeUnlanded;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every event we observe lands here with the
     * outcome (`ready`, `blocked`, `skipped-duplicate`, `failed`).
     * Mirrors the Finalizer / Reconciler "no silent skip" surface.
     */
    this.classifications = [];
    this.events = Object.freeze(['epic.automerge.start', 'epic.watch.end']);
  }

  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(
        `[AutomergePredicate] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const prUrl = payload?.prUrl;
    if (typeof prUrl !== 'string' || prUrl.length === 0) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: 'no-pr-url',
      });
      return;
    }
    // Gate 1 — required-check freshness. Any non-passing required check is
    // a hard block: short-circuit before consulting the structured-signal
    // evaluator so the operator sees the CI failure as the reason, not a
    // downstream signal.
    //
    // Two sources of CI truth:
    //   (a) `epic.watch.end` (test-only Watcher path) carries a settled
    //       `checkOutcomes` map — that map is authoritative, so we classify
    //       it directly and issue NO live probe.
    //   (b) `epic.automerge.start` (production Phase 8.5) carries no map.
    //       Story #4361: we run a LIVE `gh pr checks --required` probe here
    //       so an interrupted Phase 8 watch cannot arm merge on red/pending
    //       required checks (closes the Story #3901 hole).
    if (payload?.checkOutcomes !== undefined) {
      const failures = listFailingChecks(payload.checkOutcomes);
      if (failures.length > 0) {
        const reason = formatCheckFailureReason(failures);
        this.classifications.push({ event, seqId, outcome: 'blocked', reason });
        await this._emitBlocked(prUrl, reason);
        return;
      }
    } else {
      // Live probe — production path. Fail closed on any non-green,
      // pending, or unreadable required-check result.
      let probeVerdict;
      try {
        const probe = this.probeRequiredChecksFn({ prUrl, cwd: this.cwd });
        probeVerdict = classifyRequiredChecksProbe(probe, {
          requireChecks: this.requireChecks,
        });
      } catch (err) {
        probeVerdict = {
          ok: false,
          reason: `live required-check probe threw: ${err?.message ?? err}`,
          outcomes: {},
        };
      }
      if (!probeVerdict.ok) {
        const reason = probeVerdict.reason ?? 'required checks not green';
        this.classifications.push({ event, seqId, outcome: 'blocked', reason });
        await this._emitBlocked(prUrl, reason);
        return;
      }
    }

    // Gate 2 — structured-signal verdict, filtered by the merge policy.
    let verdict;
    try {
      verdict = await this.evaluatePredicateFn({
        provider: this.provider,
        epicId: this.epicId,
      });
    } catch (err) {
      const reason = `predicate-threw:${err?.message ?? err}`;
      this.classifications.push({ event, seqId, outcome: 'failed', reason });
      this.logger.warn?.(
        `[AutomergePredicate] evaluator threw (swallowed): ${err?.message ?? err}`,
      );
      // Conservative: a thrown evaluator is treated as blocked rather
      // than ready — we never arm auto-merge on uncertain signals.
      await this._emitBlocked(prUrl, reason);
      return;
    }

    const decision = applyAutoMergePolicy(verdict, this.policy);
    // Surface recorded-but-non-blocking reasons for audit even when the
    // trust-ci policy arms anyway (interventions / warnings / non-clean
    // retro). These never gate the merge but must not be silently dropped.
    const recorded = decision.recordedReasons ?? [];

    if (decision.arm) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'ready',
        policy: decision.policy,
        signals: verdict.signals,
        ...(recorded.length > 0
          ? { recordedReasons: recorded.map((r) => r.message) }
          : {}),
      });
      if (recorded.length > 0) {
        this.logger.info?.(
          `[AutomergePredicate] arming under ${decision.policy}; recorded (non-blocking): ${formatReasons(recorded)}`,
        );
      }
      try {
        await this.bus.emit('epic.merge.ready', {
          prUrl,
          reason: `all required checks green; ${decision.policy} policy signals clear`,
        });
      } catch (err) {
        this.logger.warn?.(
          `[AutomergePredicate] epic.merge.ready emit failed (swallowed): ${err?.message ?? err}`,
        );
      }
      return;
    }

    const blocking = decision.blockingReasons ?? [];
    const reason =
      blocking.length > 0
        ? formatReasons(blocking)
        : 'predicate dirty (no reasons reported)';
    this.classifications.push({
      event,
      seqId,
      outcome: 'blocked',
      policy: decision.policy,
      reason,
      ...(recorded.length > 0
        ? { recordedReasons: recorded.map((r) => r.message) }
        : {}),
    });
    await this._emitBlocked(prUrl, reason);
  }

  /**
   * Emit `epic.merge.blocked`. Helper carved out so the blocking paths
   * (CI failure / predicate dirty / evaluator throw) share the same emit
   * shape.
   *
   * Story #4472 — must-land coverage of predicate refusal. In a headless
   * (`/deliver --yes`) run there is no operator to act on a bare
   * `epic.merge.blocked` (nothing in the listener chain consumes it), so
   * the run would silently park on the operator-merges path. When
   * `this.headless`, we additionally attribute the refusal to the
   * lifecycle ledger via `merge.unlanded` (blockClass `predicate-refused`)
   * and drive the explicit `epic.blocked` terminal — the same
   * escalation the MergeWatcher performs on post-arm budget exhaustion —
   * so the Epic transitions to `agent::blocked` with an operator-visible
   * reason instead of stalling.
   */
  async _emitBlocked(prUrl, reason) {
    try {
      await this.bus.emit('epic.merge.blocked', { prUrl, reason });
    } catch (err) {
      this.logger.warn?.(
        `[AutomergePredicate] epic.merge.blocked emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
    if (!this.headless) return;
    // Ledger attribution — best-effort; a failed append must NOT mask the
    // epic.blocked transition below.
    try {
      const prNumber = parsePrNumberFromUrl(prUrl);
      if (Number.isInteger(prNumber) && prNumber > 0) {
        this.emitMergeUnlandedFn({
          scope: 'epic',
          ticketId: this.epicId,
          prNumber,
          blockClass: 'predicate-refused',
          reason,
          elapsedSeconds: 0,
        });
      }
    } catch (err) {
      this.logger.warn?.(
        `[AutomergePredicate] emitMergeUnlanded failed (swallowed): ${err?.message ?? err}`,
      );
    }
    try {
      await this.bus.emit('epic.blocked', {
        reason: `merge-predicate:refused`,
      });
    } catch (err) {
      this.logger.warn?.(
        `[AutomergePredicate] epic.blocked emit on predicate refusal failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}
