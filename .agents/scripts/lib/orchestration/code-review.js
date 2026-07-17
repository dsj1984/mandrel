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
 * by design).
 *
 * v2.0.0 removed the Epic tier. The Epic-scope envelope and the
 * Epic-scoped `code-review.start` / `.end` lifecycle emits (whose schema
 * requires `epicId`) went with it; Story scope is the only scope and the
 * module no longer touches the lifecycle bus.
 *
 * Public API:
 *   - `runCodeReview({ ticketId, headRef, provider, logger, ... })` →
 *       `{ status, severity, posted, report, halted, blockerReason }`.
 *
 * Behaviour:
 *   - Loads the configured review adapter via the factory; defaults to
 *     a single `native` chain entry when `delivery.codeReview.providers`
 *     is unset or empty.
 *   - Always posts the unified `verification-results` structured comment on
 *     the target issue/PR (the adapter never posts; the orchestrator owns
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
import { computeChangeSet } from './change-set.js';
import { deriveChangeLevel, resolveDepth } from './review-depth.js';
import {
  countBySeverity,
  renderFindings,
} from './review-providers/findings-renderer.js';
import { createReviewProvider } from './review-providers/review-provider-factory.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Review depth tiers, ordered light → standard → deep. The depth is resolved
 * by the shared {@link resolveDepth} resolver from two observable properties of
 * the diff under review — whether its changed files touch a registered
 * sensitive path ({@link deriveChangeLevel}) and their mechanical count — then
 * threaded into the review provider's `runReview` input so a sensitive *or*
 * wide-footprint change gets a deeper pass than a small, unremarkable one.
 * Depth is an **input** signal only — it never changes the
 * `{ status, severity, posted, report, halted, blockerReason }` output
 * envelope nor the `verification-results` structured-comment body (Story #3876,
 * extended by Story #3938; re-based off the diff by Story #4542).
 *
 * @typedef {import('./review-depth.js').ReviewDepth} ReviewDepth
 */

/**
 * Resolve the project base branch fallback used when a caller omits
 * `baseRef`.
 */
function resolveConfigBase(config) {
  return config?.project?.baseBranch ?? 'main';
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
  };
}

/**
 * Resolve the scope envelope
 * (`{ scope, ticketId, baseRef, headRef, commentTargetId }`). v2.0.0
 * removed the Epic tier, so `'story'` is the only scope.
 */
function resolveScopeEnvelope(opts, config) {
  return resolveStoryScope(opts, config);
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
 * Story #2839 (Epic #2815) — the Story closer requests a Story-scope
 * review against `main`, posts the structured findings comment to the PR
 * (via `commentTargetId`), and surfaces critical findings to the caller
 * as `halted: true`.
 *
 * Argument shape:
 *   `{ ticketId, baseRef, headRef, [commentTargetId], provider }`
 *   `baseRef` defaults to the project base branch; `headRef` is required.
 *   `commentTargetId` overrides the post target (e.g. PR number) while
 *   `ticketId` continues to label the rendered header ("Story #N").
 *
 * @param {{
 *   scope?: 'story',
 *   ticketId: number,
 *   baseRef?: string|null,
 *   headRef?: string|null,
 *   commentTargetId?: number|null,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function, fatal?: Function, createProgress?: Function },
 *   changedFiles?: string[]|null,
 *   changedFileCount?: number|null,
 *   storyId?: number|null,
 *   reviewProvider?: { runReview: Function },
 *   gitSpawnFn?: import('./change-set.js').GitSpawnFn,
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
 * config. Multi-entry chains render as `chain[a,b,...]`; a single-entry
 * chain (including the unset/empty default) renders that entry's name;
 * everything else falls back to `'native'`.
 */
function resolveProviderName(codeReviewConfig) {
  const providers =
    codeReviewConfig && Array.isArray(codeReviewConfig.providers)
      ? codeReviewConfig.providers
      : [];
  if (providers.length === 1) {
    return providers[0]?.name ?? 'native';
  }
  if (providers.length > 1) {
    return `chain[${providers.map((p) => p?.name ?? '?').join(',')}]`;
  }
  return 'native';
}

/**
 * Resolve the change set the depth derivation reads (Story #4593).
 *
 * `opts.changedFiles` is an injection with three distinct states,
 * and the difference is load-bearing: an **array** is the change set to use
 * verbatim; an explicit **null** is a caller (`runStoryReviewCore`) reporting
 * that it already tried and the diff is unenumerable — re-running git here would
 * only fail again, so it degrades straight to the fail-safe tier; **absent**
 * means no caller enumerated at all, so the shared {@link computeChangeSet}
 * enumerator runs as the fallback (standalone CLI use). On the close path the
 * spine always injects, so the diff is enumerated exactly once per delivery and
 * this pillar can never disagree with the lens pass about what changed.
 */
function resolveInjectedChangedFiles({ opts, baseRef, headRef }) {
  if (opts.changedFiles === undefined) {
    return computeChangeSet({ baseRef, headRef, gitSpawnFn: opts.gitSpawnFn })
      .files;
  }
  return Array.isArray(opts.changedFiles) ? opts.changedFiles : null;
}

/**
 * Build the provider `runReview` input, resolving the review depth from the
 * diff under review: its changed files derive the change level (sensitive path
 * touched or not — Story #4542) and their count supplies the width. The depth
 * is an input-only signal (light → standard → deep) and never touches the
 * output envelope or the posted comment. An unenumerable diff → `standard`.
 * Story #4075 — extracted from `runCodeReview`.
 */
function buildReviewInput({ opts, scope, ticketId, baseRef, headRef }) {
  const changedFiles = resolveInjectedChangedFiles({ opts, baseRef, headRef });
  const changedFileCount =
    typeof opts.changedFileCount === 'number'
      ? opts.changedFileCount
      : (changedFiles?.length ?? null);
  // v2 Stage 2: review depth uses DEFAULT_DIFF_WIDTH (mechanical file count
  // of the diff under review). It is deliberately decoupled from the
  // planning model-capacity advisory (`DEFAULT_MODEL_CAPACITY`).
  const { level } = deriveChangeLevel({ changedFiles });
  const depth = resolveDepth({
    derivedLevel: level,
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
    `[code-review] Running ${providerName} adapter for Story #${ticketId} (${baseRef}...${headRef})...`,
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
  const { resolveConfigFn = resolveConfig } = opts;

  const config = resolveConfigFn();
  const envelope = resolveScopeEnvelope(opts, config);

  // No lifecycle-bus emit: the `code-review.start` / `.end` ledger pair was
  // Epic-scoped (its schema requires `epicId`), and v2.0.0 removed the Epic
  // tier. Story-scope review sits outside the lifecycle ledger entirely.
  return executeReviewPipeline({ opts, config, envelope });
}
