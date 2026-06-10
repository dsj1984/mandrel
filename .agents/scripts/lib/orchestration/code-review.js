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
import { selectAuditStrategy } from '../dynamic-workflow/capability.js';
import {
  countBySeverity,
  renderFindings,
} from './review-providers/findings-renderer.js';
import { createReviewProvider } from './review-providers/review-provider-factory.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Review depth tiers, ordered light → standard → deep. The depth is derived
 * from the judged risk envelope's `overallLevel` and threaded into the review
 * provider's `runReview` input so a high-risk Epic gets a deeper review pass
 * than a low-risk one. Depth is an **input** signal only — it never changes
 * the `{ status, severity, posted, report, halted, blockerReason }` output
 * envelope nor the `code-review` structured-comment body (Story #3876).
 *
 * @typedef {'light'|'standard'|'deep'} ReviewDepth
 */

/**
 * Map a judged risk `overallLevel` to a review depth. Pure, total over the
 * three known levels; any unknown/absent level falls back to `standard` so a
 * malformed or missing envelope never silently downgrades the review to
 * `light` or escalates it to `deep`.
 *
 * @param {('low'|'medium'|'high'|string|null|undefined)} overallLevel
 * @returns {ReviewDepth}
 */
export function resolveReviewDepth(overallLevel) {
  switch (overallLevel) {
    case 'low':
      return 'light';
    case 'high':
      return 'deep';
    default:
      return 'standard';
  }
}

/**
 * The axes whose presence (at `high` risk) routes a specific post-delivery
 * audit lens. Mirrors the audit-workflow names under
 * `.agents/workflows/audit-*.md`. `security` routes the security lens;
 * `public-api` (the canonical architectural axis) routes the architecture
 * lens. Any other axis (or a low/medium-risk axis) contributes no lens
 * (Story #3876).
 *
 * Every key here MUST be a value in the `axis` enum of
 * `.agents/schemas/risk-verdict.schema.json` — the verdict-derived envelope
 * can only ever carry schema-valid axes, so a key absent from that enum is
 * unreachable dead routing (Story #3889 removed the unreachable
 * `architecture` key; the architectural axis is `public-api`).
 */
const AXIS_TO_LENS = Object.freeze({
  security: 'audit-security',
  'public-api': 'audit-architecture',
});

/**
 * Stable output order for routed lenses so a `security` + `public-api`
 * envelope always lists `audit-security` before `audit-architecture` and the
 * lens list is deterministic regardless of axis ordering in the verdict.
 */
const LENS_ORDER = Object.freeze(['audit-security', 'audit-architecture']);

/**
 * Resolve the set of post-delivery audit lenses a judged risk envelope routes.
 *
 * High-risk axes map to their audit lens via {@link AXIS_TO_LENS}; only axes
 * judged `high` contribute (a `low`/`medium` axis carries no lens). The result
 * is de-duplicated and stably ordered (security before architecture) so an
 * envelope listing the `public-api` axis more than once routes
 * `['audit-architecture']` once, not twice. A low-risk envelope — or any
 * envelope with no high-risk routed axis — resolves to an empty array (no
 * lens beyond the existing baseline gates).
 *
 * Pure function — no I/O, no side effects.
 *
 * @param {{ axes?: Array<{ axis?: string, level?: string }> }} [envelope]
 * @returns {string[]} Ordered, de-duplicated audit-lens identifiers.
 */
export function resolveAuditLenses(envelope = {}) {
  const axes = Array.isArray(envelope?.axes) ? envelope.axes : [];
  const matched = new Set();
  for (const entry of axes) {
    if (!entry || entry.level !== 'high') continue;
    const lens = AXIS_TO_LENS[entry.axis];
    if (lens) matched.add(lens);
  }
  return LENS_ORDER.filter((lens) => matched.has(lens));
}

/**
 * Build the post-delivery audit-lens execution plan for a judged risk
 * envelope. Each routed lens (see {@link resolveAuditLenses}) is paired with a
 * strategy decision from the **existing** `selectAuditStrategy` engine — no new
 * audit machinery is introduced. A low-risk envelope resolves to an empty
 * `lenses` array and runs no audit beyond the baseline gates (Story #3876).
 *
 * Pure with respect to the injected `selectAuditStrategyFn` (default is the
 * shared dynamic-workflow engine, which is itself pure over its snapshot).
 *
 * @param {{ axes?: Array<{ axis?: string, level?: string }> }} [envelope]
 * @param {{
 *   snapshot?: object,
 *   forceStrategy?: ('orchestrated'|'sequential'|null),
 *   selectAuditStrategyFn?: typeof selectAuditStrategy,
 * }} [opts]
 * @returns {{ lenses: string[], plan: Array<{ lens: string, strategy: string, reason: string, forced: boolean }> }}
 */
export function planAuditLenses(envelope = {}, opts = {}) {
  const {
    snapshot = {},
    forceStrategy = null,
    selectAuditStrategyFn = selectAuditStrategy,
  } = opts;
  const lenses = resolveAuditLenses(envelope);
  const plan = lenses.map((lens) => {
    const decision = selectAuditStrategyFn({ snapshot, forceStrategy });
    return {
      lens,
      strategy: decision.strategy,
      reason: decision.reason,
      forced: decision.forced,
    };
  });
  return { lenses, plan };
}

/**
 * Build the `code-review.end` payload from the normalized result envelope.
 * The runner result may carry a `report` field (full markdown body) which
 * is NOT included in the lifecycle payload: the schema's
 * `additionalProperties: false` forbids it, and the body can carry inline
 * severity counts that drift from the structured `severity` field. The
 * lifecycle ledger is the structured surface; the report is GitHub's
 * surface (posted via the structured comment).
 *
 * Story #2839: `epicId` is preserved verbatim in the lifecycle payload so
 * the `code-review.end` schema (additionalProperties: false, requires
 * `epicId`) stays unchanged. Story-scope invocations never reach this
 * helper — `runCodeReview` short-circuits the bus emit for `scope: 'story'`
 * because story-scope review sits outside the Epic lifecycle ledger.
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
 * Resolve the scope envelope from the (legacy `epicId` + optional
 * `baseBranch`) shape OR the (new `scope`/`ticketId`/`headRef`/
 * `commentTargetId`) shape into a single normalized record. Extracted to
 * keep `runCodeReview` body below the CRAP-cyclomatic ceiling.
 *
 * @param {{
 *   epicId?: number,
 *   scope?: 'epic'|'story',
 *   ticketId?: number,
 *   baseBranch?: string|null,
 *   baseRef?: string|null,
 *   headRef?: string|null,
 *   commentTargetId?: number|null,
 * }} opts
 * @param {object} config
 * @returns {{
 *   scope: 'epic'|'story',
 *   ticketId: number,
 *   baseRef: string,
 *   headRef: string,
 *   commentTargetId: number,
 *   epicIdForLedger: number|null,
 * }}
 */
function resolveScopeEnvelope(opts, config) {
  const explicitScope = opts.scope;
  const epicIdLegacy = opts.epicId;
  const configBase =
    config?.project?.baseBranch ?? config?.agentSettings?.baseBranch ?? 'main';

  if (explicitScope === 'story') {
    if (!Number.isInteger(opts.ticketId) || opts.ticketId <= 0) {
      throw new TypeError(
        'runCodeReview: ticketId is required (positive integer) when scope="story".',
      );
    }
    if (typeof opts.headRef !== 'string' || opts.headRef.length === 0) {
      throw new TypeError(
        'runCodeReview: headRef is required (non-empty string) when scope="story".',
      );
    }
    const baseRef = opts.baseRef ?? opts.baseBranch ?? configBase;
    const commentTargetId =
      Number.isInteger(opts.commentTargetId) && opts.commentTargetId > 0
        ? opts.commentTargetId
        : opts.ticketId;
    return {
      scope: 'story',
      ticketId: opts.ticketId,
      baseRef,
      headRef: opts.headRef,
      commentTargetId,
      epicIdForLedger: null,
    };
  }

  // Epic scope (default + legacy `epicId` callers).
  const effectiveEpicId =
    Number.isInteger(opts.ticketId) && opts.ticketId > 0
      ? opts.ticketId
      : epicIdLegacy;
  if (!Number.isInteger(effectiveEpicId) || effectiveEpicId <= 0) {
    throw new TypeError(
      'runCodeReview: epicId is required (positive integer).',
    );
  }
  const baseRef = opts.baseRef ?? opts.baseBranch ?? configBase;
  const headRef = opts.headRef ?? `epic/${effectiveEpicId}`;
  const commentTargetId =
    Number.isInteger(opts.commentTargetId) && opts.commentTargetId > 0
      ? opts.commentTargetId
      : effectiveEpicId;
  return {
    scope: 'epic',
    ticketId: effectiveEpicId,
    baseRef,
    headRef,
    commentTargetId,
    epicIdForLedger: effectiveEpicId,
  };
}

/**
 * In-process wrapper that the `/epic-deliver` runner and the
 * `/single-story-deliver` close path consume.
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
 * Story #2839 (Epic #2815) — accepts a parameterized scope envelope
 * so the standalone Story closer can request a Story-scope review
 * against `main`, post the structured findings comment to the PR
 * (via `commentTargetId`), and surface critical findings to the
 * caller as `halted: true`. Lifecycle bus emits are confined to
 * `scope: 'epic'` because the `code-review.end` schema requires
 * `epicId` and the ledger only spans Epic lifecycles.
 *
 * Argument shapes:
 *   - Legacy (Epic):
 *       `{ epicId, provider, bus, [baseBranch] }`
 *   - Parameterized (Epic or Story):
 *       `{ scope, ticketId, baseRef, headRef, [commentTargetId],
 *          provider, bus }`
 *     For `scope === 'story'`, `commentTargetId` overrides the post
 *     target (e.g. PR number) while `ticketId` continues to label the
 *     rendered header ("Story #N").
 *
 * @param {{
 *   epicId?: number,
 *   scope?: 'epic'|'story',
 *   ticketId?: number,
 *   baseRef?: string|null,
 *   headRef?: string|null,
 *   commentTargetId?: number|null,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function, fatal?: Function, createProgress?: Function },
 *   baseBranch?: string|null,
 *   planningRisk?: { overallLevel?: ('low'|'medium'|'high'), axes?: Array<{ axis?: string, level?: string }> }|null,
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
 *   postedCommentId: number|null,
 *   commentTargetId: number,
 *   halted: boolean,
 *   blockerReason: string|null,
 * }>}
 */
export async function runCodeReview(opts = {}) {
  const {
    provider,
    logger,
    bus,
    now = Date.now,
    reviewProvider: injectedReviewProvider,
    resolveConfigFn = resolveConfig,
    createReviewProviderFn = createReviewProvider,
    upsertCommentFn = upsertStructuredComment,
    renderFindingsFn = renderFindings,
  } = opts;

  const config = resolveConfigFn();
  const envelope = resolveScopeEnvelope(opts, config);
  const { scope, ticketId, baseRef, headRef, commentTargetId } = envelope;

  // Epic-scope lifecycle ledger requires `bus`; Story-scope sits outside
  // the Epic lifecycle so the bus is optional there. A caller without a
  // bus on the Story path still gets the full review semantics — only the
  // `code-review.start`/`.end` events are suppressed.
  const requiresBus = scope === 'epic';
  if (requiresBus && (!bus || typeof bus.emit !== 'function')) {
    throw new TypeError('runCodeReview: bus is required (object with emit()).');
  }
  const ledgerEnabled =
    scope === 'epic' && bus && typeof bus.emit === 'function';

  const startedAt = typeof now === 'function' ? now() : Date.now();
  if (ledgerEnabled) {
    await bus.emit('code-review.start', { epicId: envelope.epicIdForLedger });
  }

  try {
    const codeReviewConfig = config?.delivery?.codeReview ?? null;
    const isChainConfig =
      codeReviewConfig &&
      Array.isArray(codeReviewConfig.providers) &&
      codeReviewConfig.providers.length > 0;
    const providerName = isChainConfig
      ? `chain[${codeReviewConfig.providers
          .map((p) => p?.name ?? '?')
          .join(',')}]`
      : ((codeReviewConfig && typeof codeReviewConfig.provider === 'string'
          ? codeReviewConfig.provider
          : null) ?? 'native');
    const reviewProvider =
      injectedReviewProvider ?? createReviewProviderFn(codeReviewConfig);

    const scopeLabel = scope === 'epic' ? 'Epic' : 'Story';
    logger?.info?.(
      `[code-review] Running ${providerName} adapter for ${scopeLabel} #${ticketId} (${baseRef}...${headRef})...`,
    );

    const ticketLabels = Array.isArray(opts.ticketLabels)
      ? opts.ticketLabels
      : [];
    // Story #3876 — derive the review depth from the judged risk envelope's
    // `overallLevel` and thread it into the provider's `runReview` input. The
    // depth is an input-only signal: it tells the provider how thorough to be
    // (light → standard → deep) and never touches the output envelope or the
    // posted structured comment. Absent envelope → `standard` (the neutral
    // default), preserving the pre-change behaviour for callers that do not
    // pass a risk envelope.
    const depth = resolveReviewDepth(opts.planningRisk?.overallLevel);
    const reviewInput = {
      scope,
      ticketId,
      baseRef,
      headRef,
      labels: ticketLabels,
      depth,
    };

    const findings = await reviewProvider.runReview(reviewInput);

    if (!Array.isArray(findings)) {
      throw new TypeError(
        `[code-review] Review provider "${providerName}" returned a non-array; expected Finding[].`,
      );
    }

    // Story #2871 — feature-detect manual-prompt providers. Legacy
    // single-adapter providers don't carry `getPromptMessages`, so the
    // empty-array fallback keeps the old snapshot byte-stable.
    let promptMessages = [];
    if (typeof reviewProvider.getPromptMessages === 'function') {
      try {
        const out = await reviewProvider.getPromptMessages(reviewInput);
        promptMessages = Array.isArray(out) ? out : [];
      } catch (err) {
        logger?.warn?.(
          `[code-review] getPromptMessages threw; treating as empty. ${
            err?.message ?? err
          }`,
        );
        promptMessages = [];
      }
    }

    const severity = countBySeverity(findings);
    const halted = severity.critical > 0;
    const blockerReason = halted
      ? `code-review reported ${severity.critical} critical blocker(s)`
      : null;

    const report = renderFindingsFn({
      scope,
      ticketId,
      baseRef,
      headRef,
      findings,
      provider: providerName,
      promptMessages,
    });

    let posted = false;
    let postedCommentId = null;
    try {
      const postResult = await upsertCommentFn(
        provider,
        commentTargetId,
        'code-review',
        report,
      );
      posted = true;
      const rawId =
        typeof postResult?.commentId === 'number'
          ? postResult.commentId
          : typeof postResult?.id === 'number'
            ? postResult.id
            : null;
      postedCommentId = rawId;
      logger?.info?.(
        `[code-review] Posted structured comment to #${commentTargetId}.`,
      );
    } catch (err) {
      logger?.warn?.(
        `[code-review] Failed to upsert structured comment on #${commentTargetId}: ${err?.message ?? err}`,
      );
      posted = false;
    }

    const result = {
      status: 'ok',
      severity,
      report,
      posted,
      postedCommentId,
      commentTargetId,
      halted,
      blockerReason,
    };
    if (ledgerEnabled) {
      const endedAt = typeof now === 'function' ? now() : Date.now();
      await bus.emit(
        'code-review.end',
        buildCodeReviewEndPayload({
          epicId: envelope.epicIdForLedger,
          result,
          durationMs: Math.max(0, endedAt - startedAt),
        }),
      );
    }
    return result;
  } catch (err) {
    // Surface the closing boundary even on adapter throw — the ledger
    // must always show a matched start/end pair. `status: 'invalid'`
    // is the canonical "could not complete" value.
    if (ledgerEnabled) {
      const endedAt = typeof now === 'function' ? now() : Date.now();
      await bus.emit(
        'code-review.end',
        buildCodeReviewEndPayload({
          epicId: envelope.epicIdForLedger,
          result: { status: 'invalid' },
          durationMs: Math.max(0, endedAt - startedAt),
        }),
      );
    }
    throw err;
  }
}
