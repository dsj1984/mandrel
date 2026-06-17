// .agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js
/**
 * AutomergePredicate — lifecycle listener that decides whether the Epic
 * PR is safe to auto-merge after the required-check watch settles.
 * Story #2256 / Task #2260 (Epic #2172); inlined from the now-deleted
 * legacy `automerge-predicate` module in Story #2415 (Epic #2307).
 *
 * Subscribes to:
 *   - `epic.automerge.start` (production path, Story #3901) → the
 *     `/deliver` Phase 8.5 boundary that the `lifecycle-emit.js`
 *     CLI actually fires. This event carries `prUrl` but NO
 *     `checkOutcomes` (Phase 8's `pr-watch-with-update.js` has already
 *     polled every required check to green before Phase 8.5 runs), so
 *     the CI-freshness gate is skipped and the verdict is decided by
 *     the structured-signal evaluator alone. Before Story #3901 the
 *     listener subscribed ONLY to `epic.watch.end`, which no production
 *     emitter fires — making the entire Phase 8.5 auto-merge gate a
 *     dead wire (epic-lifecycle-review.md §1.1).
 *   - `epic.watch.end` (test-only `Watcher` path) → carries an
 *     all-settled `checkOutcomes` map. Any non-passing required check
 *     is a hard block evaluated BEFORE the structured-signal evaluator.
 *
 * Either trigger evaluates the same verdict: if `evaluateAutoMergePredicate`
 * reports `clean: true` (no manual interventions, every Story done,
 * no story blockers, no critical/high review findings, machine-readable
 * "clean sprint" retro trailer), emit `epic.merge.ready`. Otherwise emit
 * `epic.merge.blocked` with a non-empty reason.
 *
 * Code-review parse-miss policy (Story #4222): a code-review comment that is
 * present but whose severity bullets cannot be parsed is treated as a DISTINCT
 * condition — surfaced via the `codeReviewUnparseable` signal — and FAILS OPEN
 * rather than blocking. Failing closed on a format miss is indistinguishable,
 * to the operator and to downstream telemetry, from a real disqualifying
 * finding; a parser miss must never masquerade as "the signal said no" inside
 * a generic `epic.merge.blocked`. Genuine critical/high findings still block,
 * because those require the counts to have parsed.
 *
 * Critical contract:
 *   - The verdict for any given input set is byte-identical to the
 *     pre-inlining legacy module's output — this file is its
 *     replacement. The merge-gate-ordering invariant
 *     (`epic.merge.armed` preceded by `epic.merge.ready`) depends on
 *     this listener being the sole emitter of `epic.merge.ready`.
 *
 *   - Required-check outcomes from `epic.watch.end` are a NEW input
 *     not present in the legacy verdict: any check that is not
 *     `'success'`, `'neutral'`, or `'skipped'` flips the verdict to
 *     `blocked` BEFORE the legacy evaluator is even consulted (because
 *     a red CI check is a hard block regardless of the structured
 *     signals).
 *
 * Idempotency contract (AC-10): per-instance `Set<string>` of
 * `${event}:${seqId}` keys. A repeat `(event, seqId)` short-circuits
 * without re-evaluating and emits nothing. The evaluator is read-only
 * on GitHub state, so re-running it is safe; the seqId guard is the
 * defence against double-emit.
 *
 * Side-effect firewall: the listener calls the read-only evaluator and
 * emits on the bus. It does NOT mutate labels, post comments, or call
 * `notify`. Downstream consumers (`AutomergeArmer` on
 * `epic.merge.ready`; LabelTransitioner / StructuredCommentPoster on
 * `epic.merge.blocked`) own those side effects.
 */

import * as epicRunStateStore from '../../epic-run-state-store.js';
import { findStructuredComment } from '../../ticketing.js';

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

function evaluateStateSignals(state, reasons) {
  const interventionCount = Array.isArray(state?.manualInterventions)
    ? state.manualInterventions.length
    : 0;
  if (!state) {
    reasons.push(
      'epic-run-state checkpoint missing — cannot certify clean run',
    );
  } else if (interventionCount > 0) {
    reasons.push(
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
    reasons.push(
      `${nonDoneStatuses.length} story(ies) not done (statuses: ${nonDoneStatuses.join(', ')})`,
    );
  }
  const storyBlockers = countStoryBlockers(stories);
  if (storyBlockers > 0) {
    reasons.push(
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
    reasons.push('code-review structured comment not found on Epic');
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
  if (severity.critical > 0) {
    reasons.push(`code-review has ${severity.critical} 🔴 Critical Blocker(s)`);
  }
  if (severity.high > 0) {
    reasons.push(`code-review has ${severity.high} 🟠 High Risk finding(s)`);
  }
  return { codeReviewFound, codeReviewUnparseable, severity };
}

function evaluateRetroSignals(retro, reasons) {
  const retroFound = !!retro && typeof retro.body === 'string';
  if (!retroFound) {
    reasons.push('retro structured comment not found on Epic');
    return { retroFound, retroCompact: false };
  }
  // Read the machine-readable verdict trailer instead of string-matching
  // the human-facing "🟢 Clean sprint" prose (Story #3901). A missing or
  // malformed trailer is a hard disqualifier — we never arm auto-merge on
  // a retro whose verdict we cannot read.
  const verdict = parseAutomergeVerdictTrailer(retro.body);
  if (!verdict) {
    reasons.push(
      'retro is missing the machine-readable automerge-verdict trailer (cannot certify clean sprint)',
    );
    return { retroFound, retroCompact: false };
  }
  const retroCompact = verdict.cleanSprint === true;
  if (!retroCompact) {
    reasons.push(
      'retro automerge-verdict trailer reports cleanSprint=false (full retro indicates friction / parked / interventions)',
    );
  }
  return { retroFound, retroCompact };
}

/**
 * Pure verdict-from-signals function. Composes the three signal sources into
 * a single `{ clean, reasons[] }` envelope. Exported for tests.
 *
 * @param {{
 *   state: object|null,
 *   codeReview: { body: string }|null,
 *   retro: { body: string }|null,
 * }} input
 * @returns {{
 *   clean: boolean,
 *   reasons: string[],
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
  const reasons = [];
  const stateSig = evaluateStateSignals(state, reasons);
  const reviewSig = evaluateCodeReviewSignals(codeReview, reasons);
  const retroSig = evaluateRetroSignals(retro, reasons);

  return {
    clean: reasons.length === 0,
    reasons,
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
 * @returns {Promise<{ clean: boolean, reasons: string[], signals: object }>}
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
  const codeReview = await findCommentFn(provider, epicId, 'code-review');
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
   * @param {Function} [opts.evaluatePredicateFn] override of
   *   `evaluateAutoMergePredicate` for tests.
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
    this.evaluatePredicateFn =
      opts.evaluatePredicateFn ?? evaluateAutoMergePredicate;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every `epic.watch.end` we observe lands here
     * with the outcome (`ready`, `blocked`, `skipped-duplicate`,
     * `failed`). Mirrors the Finalizer / Reconciler "no silent skip"
     * surface.
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
    // Gate 1 — required-check freshness. Any non-passing required
    // check is a hard block: short-circuit before consulting the
    // structured-signal evaluator so the operator sees the CI failure
    // as the reason, not a downstream signal.
    //
    // `checkOutcomes` is only present on the `epic.watch.end` payload
    // (the test-only `Watcher` path). The production `epic.automerge.start`
    // payload omits it because Phase 8 (`pr-watch-with-update.js`) has
    // already polled every required check to green before Phase 8.5 fires
    // (Story #3901). When the map is absent, skip this gate entirely
    // rather than treating an empty map as "all green by vacuous truth" —
    // CI greenness is proven upstream, not re-derived here.
    if (payload?.checkOutcomes !== undefined) {
      const failures = listFailingChecks(payload.checkOutcomes);
      if (failures.length > 0) {
        const reason = formatCheckFailureReason(failures);
        this.classifications.push({ event, seqId, outcome: 'blocked', reason });
        await this._emitBlocked(prUrl, reason);
        return;
      }
    }

    // Gate 2 — structured-signal verdict. Wraps
    // `evaluateAutoMergePredicate` so the verdict for any given input
    // set is IDENTICAL to what `epic-deliver-automerge.js` would have
    // produced before Wave 7. The classification surface logs the
    // first three reasons so operators don't have to dig into the
    // legacy CLI output to understand a block.
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

    if (verdict?.clean) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'ready',
        signals: verdict.signals,
      });
      try {
        await this.bus.emit('epic.merge.ready', {
          prUrl,
          reason: 'all required checks green; structured signals clean',
        });
      } catch (err) {
        this.logger.warn?.(
          `[AutomergePredicate] epic.merge.ready emit failed (swallowed): ${err?.message ?? err}`,
        );
      }
      return;
    }

    const reasons = Array.isArray(verdict?.reasons) ? verdict.reasons : [];
    const reason =
      reasons.length > 0
        ? reasons.slice(0, 3).join('; ') +
          (reasons.length > 3 ? `; +${reasons.length - 3} more` : '')
        : 'predicate dirty (no reasons reported)';
    this.classifications.push({ event, seqId, outcome: 'blocked', reason });
    await this._emitBlocked(prUrl, reason);
  }

  /**
   * Emit `epic.merge.blocked`. Helper carved out so the three blocking
   * paths (CI failure / predicate dirty / evaluator throw) share the
   * same emit shape.
   */
  async _emitBlocked(prUrl, reason) {
    try {
      await this.bus.emit('epic.merge.blocked', { prUrl, reason });
    } catch (err) {
      this.logger.warn?.(
        `[AutomergePredicate] epic.merge.blocked emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}
