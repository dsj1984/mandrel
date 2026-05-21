/**
 * lib/orchestration/code-review.js — In-process Code Review module.
 *
 * Story #1155 (Epic #1142, 5.40.0) — extracted the helper-driven
 * `epic-code-review` invocation into a callable module so the
 * `/epic-deliver` runner can run Phase D without spawning a child
 * process or routing through an LLM-driven helper.
 *
 * Story #2831 (Epic #2815, Pluggable Code Review) — refactored to load
 * the review provider through `review-provider-factory`, call the
 * adapter's `runReview()` to collect a `Finding[]`, render the
 * structured-comment body via `findings-renderer`, and post the
 * comment through the GitHub provider here (the adapter is post-free
 * by design). The lifecycle events (`code-review.start`/`.end`)
 * preserve their previous payload shape so the ledger and listener
 * chain are unchanged.
 *
 * Public API:
 *   - `runCodeReview({ epicId, provider, logger, bus, ... })` →
 *       `{ status, severity, posted, report, halted, blockerReason }`.
 *
 * Behaviour:
 *   - Loads the configured review adapter via the factory; defaults to
 *     `native` when `delivery.codeReview.provider` is unset.
 *   - Always posts the structured `code-review` comment on the Epic
 *     issue (the adapter never posts; the orchestrator owns persistence).
 *   - Treats severity.critical > 0 as a halting blocker — the merged
 *     `/epic-deliver` runner consults `halted` and refuses to advance
 *     to Phase E (retro) when set.
 *
 * Halting on critical findings is the in-process replacement for the
 * helper's "operator must remediate before /epic-deliver" gate.
 */

import { resolveConfig } from '../config-resolver.js';
import {
  countBySeverity,
  renderFindings,
} from './review-providers/findings-renderer.js';
import { createReviewProvider } from './review-providers/review-provider-factory.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Build the `code-review.end` payload from the normalized result envelope.
 * The runner result may carry a `report` field (full markdown body) which
 * is NOT included in the lifecycle payload: the schema's
 * `additionalProperties: false` forbids it, and the body can carry inline
 * severity counts that drift from the structured `severity` field. The
 * lifecycle ledger is the structured surface; the report is GitHub's
 * surface (posted via the structured comment).
 */
function buildCodeReviewEndPayload({ epicId, result, durationMs }) {
  const payload = {
    epicId,
    status: result.status,
  };
  if (result.severity && typeof result.severity === 'object') {
    payload.severity = {
      critical: result.severity.critical ?? 0,
      high: result.severity.high ?? 0,
      medium: result.severity.medium ?? 0,
      suggestion: result.severity.suggestion ?? 0,
    };
  }
  if (typeof result.halted === 'boolean') payload.halted = result.halted;
  if (typeof result.posted === 'boolean') payload.posted = result.posted;
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    payload.durationMs = Math.floor(durationMs);
  }
  return payload;
}

/**
 * In-process wrapper that the `/epic-deliver` runner consumes.
 *
 * Story #2252 — emits `code-review.start` immediately on entry and
 * `code-review.end` immediately before returning the envelope (success
 * or halt). On runner throw, emits `code-review.end` with the canonical
 * structure (`status: 'invalid'`) before re-throwing so the ledger
 * always carries the closing boundary.
 *
 * Story #2831 — the runner loads its adapter through the factory; the
 * `reviewProvider` opt overrides the factory for tests. Severity is
 * derived from the `Finding[]` returned by the adapter (no separate
 * severity field on the runner result).
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function, fatal?: Function, createProgress?: Function },
 *   baseBranch?: string|null,
 *   storyId?: number|null,
 *   bus?: object|null,
 *   now?: () => number,
 *   reviewProvider?: { runReview: Function },
 *   resolveConfigFn?: typeof resolveConfig,
 *   createReviewProviderFn?: typeof createReviewProvider,
 *   upsertCommentFn?: typeof upsertStructuredComment,
 *   renderFindingsFn?: typeof renderFindings,
 * }} opts
 * @returns {Promise<{
 *   status: 'ok'|'no-changes'|'invalid',
 *   severity: { critical: number, high: number, medium: number, suggestion: number },
 *   report?: string,
 *   posted: boolean,
 *   halted: boolean,
 *   blockerReason: string|null,
 * }>}
 */
export async function runCodeReview(opts = {}) {
  const {
    epicId,
    provider,
    logger,
    baseBranch = null,
    bus,
    now = Date.now,
    reviewProvider: injectedReviewProvider,
    resolveConfigFn = resolveConfig,
    createReviewProviderFn = createReviewProvider,
    upsertCommentFn = upsertStructuredComment,
    renderFindingsFn = renderFindings,
  } = opts;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runCodeReview: epicId is required (positive integer).',
    );
  }
  // Epic #2646 Story C (Task #2700) — `bus` is now a hard input.
  if (!bus || typeof bus.emit !== 'function') {
    throw new TypeError('runCodeReview: bus is required (object with emit()).');
  }

  const startedAt = typeof now === 'function' ? now() : Date.now();
  await bus.emit('code-review.start', { epicId });

  try {
    const config = resolveConfigFn();
    const codeReviewConfig = config?.delivery?.codeReview ?? null;
    const providerName =
      (codeReviewConfig && typeof codeReviewConfig.provider === 'string'
        ? codeReviewConfig.provider
        : null) ?? 'native';
    const reviewProvider =
      injectedReviewProvider ?? createReviewProviderFn(codeReviewConfig);

    const resolvedBaseRef =
      baseBranch ??
      config?.project?.baseBranch ??
      config?.agentSettings?.baseBranch ??
      'main';
    const headRef = `epic/${epicId}`;

    logger?.info?.(
      `[code-review] Running ${providerName} adapter for Epic #${epicId} (${resolvedBaseRef}...${headRef})...`,
    );

    const findings = await reviewProvider.runReview({
      scope: 'epic',
      ticketId: epicId,
      baseRef: resolvedBaseRef,
      headRef,
    });

    if (!Array.isArray(findings)) {
      throw new TypeError(
        `[code-review] Review provider "${providerName}" returned a non-array; expected Finding[].`,
      );
    }

    const severity = countBySeverity(findings);
    const halted = severity.critical > 0;
    const blockerReason = halted
      ? `code-review reported ${severity.critical} critical blocker(s)`
      : null;

    const report = renderFindingsFn({
      scope: 'epic',
      ticketId: epicId,
      baseRef: resolvedBaseRef,
      headRef,
      findings,
      provider: providerName,
    });

    let posted = false;
    try {
      await upsertCommentFn(provider, epicId, 'code-review', report);
      posted = true;
      logger?.info?.(
        `[code-review] Posted structured comment to Epic #${epicId}.`,
      );
    } catch (err) {
      logger?.warn?.(
        `[code-review] Failed to upsert structured comment on Epic #${epicId}: ${err?.message ?? err}`,
      );
      posted = false;
    }

    const envelope = {
      status: 'ok',
      severity,
      report,
      posted,
      halted,
      blockerReason,
    };
    const endedAt = typeof now === 'function' ? now() : Date.now();
    await bus.emit(
      'code-review.end',
      buildCodeReviewEndPayload({
        epicId,
        result: envelope,
        durationMs: Math.max(0, endedAt - startedAt),
      }),
    );
    return envelope;
  } catch (err) {
    // Surface the closing boundary even on adapter throw — the ledger
    // must always show a matched start/end pair. `status: 'invalid'`
    // is the canonical "could not complete" value.
    const endedAt = typeof now === 'function' ? now() : Date.now();
    await bus.emit(
      'code-review.end',
      buildCodeReviewEndPayload({
        epicId,
        result: { status: 'invalid' },
        durationMs: Math.max(0, endedAt - startedAt),
      }),
    );
    throw err;
  }
}
