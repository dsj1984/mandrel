/**
 * lib/orchestration/code-review.js — In-process Code Review module.
 *
 * Story #1155 (Epic #1142, 5.40.0) — extracted the helper-driven
 * `epic-code-review` invocation into a callable module so the
 * `/deliver` runner can run Phase D without spawning a child
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
 *   - `runCodeReview({ scope, ticketId, provider, logger, bus, ... })` →
 *       `{ status, severity, posted, report, halted, blockerReason }`.
 *
 * Behaviour:
 *   - Loads the configured review adapter via the factory; defaults to
 *     `native` when `delivery.codeReview.provider` is unset.
 *   - Always posts the unified `verification-results` structured comment on
 *     the Epic issue (the adapter never posts; the orchestrator owns
 *     persistence). Story #4411 (Epic #4405) unified the former
 *     `code-review` and `audit-results` findings contracts into this one
 *     `verification-results` marker.
 *   - Treats severity.critical > 0 as a halting blocker — the merged
 *     `/deliver` runner consults `halted` and refuses to advance
 *     to Phase E (retro) when set.
 *
 * Halting on critical findings is the in-process replacement for the
 * helper's "operator must remediate before /deliver" gate.
 */

import { hasSurvivingCritical } from '../audit-suite/findings.js';
import { resolveConfig } from '../config-resolver.js';
import { gitSpawn } from '../git-utils.js';
import { resolveDepth } from './review-depth.js';
import {
  countBySeverity,
  renderFindings,
} from './review-providers/findings-renderer.js';
import { createReviewProvider } from './review-providers/review-provider-factory.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Review depth tiers, ordered light → standard → deep. The depth is resolved
 * by the shared {@link resolveDepth} resolver from the judged risk envelope's
 * `overallLevel` **and** the mechanical changed-file count of the diff under
 * review, then threaded into the review provider's `runReview` input so a
 * high-risk *or* wide-footprint change gets a deeper pass than a low-risk
 * small one. Depth is an **input** signal only — it never changes the
 * `{ status, severity, posted, report, halted, blockerReason }` output
 * envelope nor the `code-review` structured-comment body (Story #3876,
 * extended by Story #3938).
 *
 * @typedef {import('./review-depth.js').ReviewDepth} ReviewDepth
 */

/**
 * Count the files changed in the `baseRef...headRef` diff via
 * `git diff --name-only`. Returns the file count, or `null` when the diff
 * cannot be enumerated (git failure, missing ref). A `null` count is the
 * neutral "width unknown" signal {@link resolveDepth} tolerates without
 * downgrading or escalating the depth. Best-effort — never throws.
 *
 * @param {{ baseRef: string, headRef: string, gitSpawnFn?: typeof gitSpawn }} args
 * @returns {number|null}
 */
function countChangedFiles({ baseRef, headRef, gitSpawnFn = gitSpawn }) {
  try {
    const result = gitSpawnFn(
      process.cwd(),
      'diff',
      `${baseRef}...${headRef}`,
      '--name-only',
    );
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') {
      return null;
    }
    return result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0).length;
  } catch {
    return null;
  }
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
 * Resolve the project base branch fallback used when a caller omits
 * `baseRef`.
 */
function resolveConfigBase(config) {
  return (
    config?.project?.baseBranch ?? config?.agentSettings?.baseBranch ?? 'main'
  );
}

/** Positive-integer override, else the supplied default. */
function resolveCommentTargetId(commentTargetId, fallback) {
  return Number.isInteger(commentTargetId) && commentTargetId > 0
    ? commentTargetId
    : fallback;
}

/**
 * Resolve the Story-scope envelope from the parameterized
 * `{ scope: 'story', ticketId, baseRef, headRef, commentTargetId }` shape.
 *
 * @returns {{
 *   scope: 'story',
 *   ticketId: number,
 *   baseRef: string,
 *   headRef: string,
 *   commentTargetId: number,
 *   epicIdForLedger: null,
 * }}
 */
function resolveStoryScope(opts, config) {
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
  return {
    scope: 'story',
    ticketId: opts.ticketId,
    baseRef: opts.baseRef ?? resolveConfigBase(config),
    headRef: opts.headRef,
    commentTargetId: resolveCommentTargetId(
      opts.commentTargetId,
      opts.ticketId,
    ),
    epicIdForLedger: null,
  };
}

/**
 * Resolve the Epic-scope envelope from the parameterized
 * `{ scope: 'epic', ticketId, baseRef, headRef, commentTargetId }` shape.
 * `headRef` defaults to `epic/<ticketId>` and `baseRef` to the project
 * base branch.
 *
 * @returns {{
 *   scope: 'epic',
 *   ticketId: number,
 *   baseRef: string,
 *   headRef: string,
 *   commentTargetId: number,
 *   epicIdForLedger: number,
 * }}
 */
function resolveEpicScope(opts, config) {
  if (!Number.isInteger(opts.ticketId) || opts.ticketId <= 0) {
    throw new TypeError(
      'runCodeReview: ticketId is required (positive integer) when scope="epic".',
    );
  }
  return {
    scope: 'epic',
    ticketId: opts.ticketId,
    baseRef: opts.baseRef ?? resolveConfigBase(config),
    headRef: opts.headRef ?? `epic/${opts.ticketId}`,
    commentTargetId: resolveCommentTargetId(
      opts.commentTargetId,
      opts.ticketId,
    ),
    epicIdForLedger: opts.ticketId,
  };
}

/**
 * Dispatch the parameterized scope envelope
 * (`{ scope, ticketId, baseRef, headRef, commentTargetId }`) to the
 * matching pure resolver. `scope` defaults to `'epic'`.
 */
function resolveScopeEnvelope(opts, config) {
  return opts.scope === 'story'
    ? resolveStoryScope(opts, config)
    : resolveEpicScope(opts, config);
}

/**
 * In-process wrapper that the `/deliver` runner and the
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
 * Argument shape (parameterized, Epic or Story):
 *   `{ scope, ticketId, baseRef, headRef, [commentTargetId],
 *      provider, bus }`
 *   `scope` defaults to `'epic'`; `baseRef` defaults to the project base
 *   branch and (Epic scope only) `headRef` defaults to `epic/<ticketId>`.
 *   For `scope === 'story'`, `commentTargetId` overrides the post
 *   target (e.g. PR number) while `ticketId` continues to label the
 *   rendered header ("Story #N").
 *
 * @param {{
 *   scope?: 'epic'|'story',
 *   ticketId: number,
 *   baseRef?: string|null,
 *   headRef?: string|null,
 *   commentTargetId?: number|null,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function, fatal?: Function, createProgress?: Function },
 *   planningRisk?: { overallLevel?: ('low'|'medium'|'high'), axes?: Array<{ axis?: string, level?: string }> }|null,
 *   changedFileCount?: number|null,
 *   storyId?: number|null,
 *   bus?: object|null,
 *   now?: () => number,
 *   reviewProvider?: { runReview: Function },
 *   gitSpawnFn?: typeof gitSpawn,
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
/**
 * Resolve the human-facing provider name from the resolved code-review
 * config. Chain configs render as `chain[a,b,...]`; a single-provider
 * config renders its `provider` string; everything else falls back to
 * `'native'`. Story #4075 — extracted from `runCodeReview`.
 */
function resolveProviderName(codeReviewConfig) {
  const isChainConfig =
    codeReviewConfig &&
    Array.isArray(codeReviewConfig.providers) &&
    codeReviewConfig.providers.length > 0;
  if (isChainConfig) {
    return `chain[${codeReviewConfig.providers
      .map((p) => p?.name ?? '?')
      .join(',')}]`;
  }
  return (
    (codeReviewConfig && typeof codeReviewConfig.provider === 'string'
      ? codeReviewConfig.provider
      : null) ?? 'native'
  );
}

/**
 * Build the provider `runReview` input, resolving the review depth from the
 * judged risk envelope's `overallLevel` and the mechanical changed-file
 * count of the diff under review (Story #3876 / #3938). The depth is an
 * input-only signal (light → standard → deep) and never touches the output
 * envelope or the posted comment. Absent risk envelope + unknown width →
 * `standard`. Story #4075 — extracted from `runCodeReview`.
 */
function buildReviewInput({ opts, scope, ticketId, baseRef, headRef }) {
  const changedFileCount =
    typeof opts.changedFileCount === 'number'
      ? opts.changedFileCount
      : countChangedFiles({ baseRef, headRef, gitSpawnFn: opts.gitSpawnFn });
  // v2 Stage 2: review depth uses DEFAULT_DIFF_WIDTH (mechanical file count
  // of the diff under review). It is deliberately decoupled from the
  // planning model-capacity advisory (`DEFAULT_MODEL_CAPACITY`).
  const depth = resolveDepth({
    overallLevel: opts.planningRisk?.overallLevel,
    changedFileCount,
  });
  return {
    scope,
    ticketId,
    baseRef,
    headRef,
    labels: Array.isArray(opts.ticketLabels) ? opts.ticketLabels : [],
    depth,
  };
}

/**
 * Feature-detect manual-prompt providers (Story #2871). Legacy
 * single-adapter providers don't carry `getPromptMessages`, so the
 * empty-array fallback keeps the old snapshot byte-stable; a throw is
 * logged and degraded to empty.
 */
async function resolvePromptMessages(reviewProvider, reviewInput, logger) {
  if (typeof reviewProvider.getPromptMessages !== 'function') return [];
  try {
    const out = await reviewProvider.getPromptMessages(reviewInput);
    return Array.isArray(out) ? out : [];
  } catch (err) {
    logger?.warn?.(
      `[code-review] getPromptMessages threw; treating as empty. ${
        err?.message ?? err
      }`,
    );
    return [];
  }
}

/**
 * Upsert the rendered report as a structured comment. Posting failure is
 * non-fatal: it is logged and surfaced via `posted: false`. Story #4075 —
 * extracted from `runCodeReview`.
 */
async function postReviewComment({
  upsertCommentFn,
  provider,
  commentTargetId,
  report,
  logger,
}) {
  try {
    const postResult = await upsertCommentFn(
      provider,
      commentTargetId,
      'verification-results',
      report,
    );
    const postedCommentId =
      typeof postResult?.commentId === 'number'
        ? postResult.commentId
        : typeof postResult?.id === 'number'
          ? postResult.id
          : null;
    logger?.info?.(
      `[code-review] Posted structured comment to #${commentTargetId}.`,
    );
    return { posted: true, postedCommentId };
  } catch (err) {
    logger?.warn?.(
      `[code-review] Failed to upsert structured comment on #${commentTargetId}: ${err?.message ?? err}`,
    );
    return { posted: false, postedCommentId: null };
  }
}

/**
 * Run the review pipeline (resolve provider → runReview → prompt messages →
 * render → post comment) and shape the `status: 'ok'` result. Pure of the
 * lifecycle-boundary concern — `runCodeReview` owns the start/end emit pair.
 * Story #4075 — extracted to keep both bodies below the CC must-fix band.
 */
async function executeReviewPipeline({ opts, config, envelope }) {
  const {
    provider,
    logger,
    reviewProvider: injectedReviewProvider,
    createReviewProviderFn = createReviewProvider,
    upsertCommentFn = upsertStructuredComment,
    renderFindingsFn = renderFindings,
  } = opts;
  const { scope, ticketId, baseRef, headRef, commentTargetId } = envelope;

  const codeReviewConfig = config?.delivery?.codeReview ?? null;
  const providerName = resolveProviderName(codeReviewConfig);
  const reviewProvider =
    injectedReviewProvider ?? createReviewProviderFn(codeReviewConfig);

  logger?.info?.(
    `[code-review] Running ${providerName} adapter for ${scope === 'epic' ? 'Epic' : 'Story'} #${ticketId} (${baseRef}...${headRef})...`,
  );

  const reviewInput = buildReviewInput({
    opts,
    scope,
    ticketId,
    baseRef,
    headRef,
  });

  const findings = await reviewProvider.runReview(reviewInput);
  if (!Array.isArray(findings)) {
    throw new TypeError(
      `[code-review] Review provider "${providerName}" returned a non-array; expected Finding[].`,
    );
  }

  const promptMessages = await resolvePromptMessages(
    reviewProvider,
    reviewInput,
    logger,
  );

  const severity = countBySeverity(findings);
  const halted = hasSurvivingCritical(severity);
  const report = renderFindingsFn({
    scope,
    ticketId,
    baseRef,
    headRef,
    findings,
    provider: providerName,
    promptMessages,
  });

  const { posted, postedCommentId } = await postReviewComment({
    upsertCommentFn,
    provider,
    commentTargetId,
    report,
    logger,
  });

  return {
    status: 'ok',
    severity,
    report,
    posted,
    postedCommentId,
    commentTargetId,
    halted,
    blockerReason: halted
      ? `code-review reported ${severity.critical} critical blocker(s)`
      : null,
  };
}

export async function runCodeReview(opts = {}) {
  const { bus, now = Date.now, resolveConfigFn = resolveConfig } = opts;

  const config = resolveConfigFn();
  const envelope = resolveScopeEnvelope(opts, config);
  const { scope } = envelope;

  // Epic-scope lifecycle ledger requires `bus`; Story-scope sits outside
  // the Epic lifecycle so the bus is optional there. A caller without a
  // bus on the Story path still gets the full review semantics — only the
  // `code-review.start`/`.end` events are suppressed.
  if (scope === 'epic' && (!bus || typeof bus.emit !== 'function')) {
    throw new TypeError('runCodeReview: bus is required (object with emit()).');
  }
  const ledgerEnabled =
    scope === 'epic' && bus && typeof bus.emit === 'function';

  const startedAt = typeof now === 'function' ? now() : Date.now();
  // Emit the matched `code-review.end` boundary; the ledger must always
  // show a start/end pair (even on adapter throw, where `result` is the
  // canonical `{ status: 'invalid' }`).
  const emitEnd = async (result) => {
    if (!ledgerEnabled) return;
    const endedAt = typeof now === 'function' ? now() : Date.now();
    await bus.emit(
      'code-review.end',
      buildCodeReviewEndPayload({
        epicId: envelope.epicIdForLedger,
        result,
        durationMs: Math.max(0, endedAt - startedAt),
      }),
    );
  };

  if (ledgerEnabled) {
    await bus.emit('code-review.start', { epicId: envelope.epicIdForLedger });
  }

  try {
    const result = await executeReviewPipeline({ opts, config, envelope });
    await emitEnd(result);
    return result;
  } catch (err) {
    await emitEnd({ status: 'invalid' });
    throw err;
  }
}
