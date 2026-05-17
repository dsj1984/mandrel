// .agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js
/**
 * AutomergePredicate — lifecycle listener that decides whether the Epic
 * PR is safe to auto-merge after the required-check watch settles.
 * Story #2256 / Task #2260 (Epic #2172).
 *
 * Subscribes to:
 *   - `epic.watch.end` → evaluate the verdict. If every required
 *     check finished green AND the legacy `evaluateAutoMergePredicate`
 *     reports `clean: true` (no manual interventions, no incomplete
 *     waves, no story blockers, no critical/high review findings,
 *     compact retro), emit `epic.merge.ready`. Otherwise emit
 *     `epic.merge.blocked` with a non-empty reason.
 *
 * Critical contract:
 *   - The verdict for clean inputs is **identical** to the legacy
 *     `lib/orchestration/automerge-predicate.js` — this listener wraps
 *     `evaluateAutoMergePredicate` rather than re-implementing the
 *     signal evaluation. The merge-gate-ordering invariant
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
 * without re-evaluating and emits nothing. The legacy evaluator is
 * read-only on GitHub state, so re-running it is safe; the seqId guard
 * is the defence against double-emit.
 *
 * Side-effect firewall: the listener calls the read-only evaluator and
 * emits on the bus. It does NOT mutate labels, post comments, or call
 * `notify`. Downstream consumers (`AutomergeArmer` on
 * `epic.merge.ready`; LabelTransitioner / StructuredCommentPoster on
 * `epic.merge.blocked`) own those side effects.
 */

import { Checkpointer } from '../../epic-runner/checkpointer.js';
import { evaluateAutoMergePredicate as defaultEvaluateAutoMergePredicate } from '../../automerge-predicate.js';

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
  const parts = failures
    .slice(0, 5)
    .map((f) => `${f.name}=${f.outcome}`);
  const suffix = failures.length > 5 ? `; +${failures.length - 5} more` : '';
  return `required checks not green: ${parts.join(', ')}${suffix}`;
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
   *   legacy evaluator). Required for the read of run-state + structured
   *   comments.
   * @param {Function} [opts.evaluatePredicateFn] override of
   *   `evaluateAutoMergePredicate` for tests.
   * @param {Function} [opts.checkpointerFactory] override of the
   *   `Checkpointer` factory for tests.
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
      opts.evaluatePredicateFn ?? defaultEvaluateAutoMergePredicate;
    this.checkpointerFactory =
      opts.checkpointerFactory ?? ((deps) => new Checkpointer(deps));
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
    this.events = Object.freeze(['epic.watch.end']);
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
    const checkOutcomes = payload?.checkOutcomes ?? {};

    // Gate 1 — required-check freshness. Any non-passing required
    // check is a hard block: short-circuit before consulting the
    // legacy evaluator so the operator sees the CI failure as the
    // reason, not a downstream signal.
    const failures = listFailingChecks(checkOutcomes);
    if (failures.length > 0) {
      const reason = formatCheckFailureReason(failures);
      this.classifications.push({ event, seqId, outcome: 'blocked', reason });
      await this._emitBlocked(prUrl, reason);
      return;
    }

    // Gate 2 — legacy structured-signal verdict. Wraps
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
        checkpointerFactory: this.checkpointerFactory,
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

export function createAutomergePredicate(opts) {
  return new AutomergePredicate(opts);
}
