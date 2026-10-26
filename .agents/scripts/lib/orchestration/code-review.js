/**
 * lib/orchestration/code-review.js — in-process Story-scope code review:
 * load the configured review adapter (default `native`), collect its
 * `Finding[]`, render and post the `verification-results` comment (adapters
 * never post), and report `halted` on any surviving critical finding.
 */

import picomatch from 'picomatch';
import { hasSurvivingCritical } from '../audit-suite/findings.js';
import { resolveConfig } from '../config-resolver.js';
import { PROJECT_ROOT } from '../project-root.js';
import { computeChangeSet } from './change-set.js';
import { remoteBaseRef } from './review-base-ref.js';
import { deriveChangeLevel, resolveDepth } from './review-depth.js';
import {
  appendReviewRun,
  markRepeats,
  readReviewHistory,
} from './review-history.js';
import { vetFindings } from './review-providers/critical-verifier.js';
import {
  collectProviderDegradations,
  degradationEnvelope,
} from './review-providers/degraded-gates.js';
import { findingInstances } from './review-providers/finding-identity.js';
import {
  countBySeverity,
  renderFindings,
} from './review-providers/findings-renderer.js';
import { loadReviewGuidance } from './review-providers/review-guidance.js';
import { createReviewProvider } from './review-providers/review-provider-factory.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Review depth (light → standard → deep), from the diff's sensitivity and
 * width. An input to `runReview` only; never changes the output envelope or
 * the posted comment.
 *
 * @typedef {import('./review-depth.js').ReviewDepth} ReviewDepth
 */

/**
 * Default base is remote-qualified so it cannot inherit local-ref drift; an
 * unfetched remote yields an unenumerable diff, which consumers fail safe on.
 */
function resolveConfigBase(config) {
  return remoteBaseRef(config?.project?.baseBranch ?? 'main');
}

/** Positive-integer override, else the supplied default. */
function resolveCommentTargetId(commentTargetId, fallback) {
  return Number.isInteger(commentTargetId) && commentTargetId > 0
    ? commentTargetId
    : fallback;
}

/**
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
 * Run a Story-scope review. `headRef` is required; `baseRef` defaults to
 * the remote base branch; `commentTargetId` (e.g. a PR number) overrides
 * the post target while `ticketId` still labels the header. `cwd` is the
 * reviewed repository the diff and claim grounding run in; unset, they fall
 * back to `process.cwd()`.
 *
 * @param {{
 *   scope?: 'story',
 *   ticketId: number,
 *   cwd?: string,
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
 *   verifier?: { spawnFn?: Function, probeFn?: Function, gitSpawnFn?: Function },
 *   historyDeps?: { config?: object, fsImpl?: object },
 *   deferPost?: boolean,
 * }} opts
 * @returns {Promise<{
 *   status: 'ok'|'no-changes'|'invalid',
 *   severity: { critical: number, high: number, medium: number, suggestion: number },
 *   findings?: Array<object>,
 *   providerName?: string,
 *   report?: string,
 *   posted: boolean,
 *   postedCommentId: number|null,
 *   commentTargetId: number,
 *   halted: boolean,
 *   criticalByProvider?: Record<string, number>,
 *   degraded: boolean, degradations: Array<object>,
 *   blockerReason: string|null,
 * }>}
 */
/**
 * Display name: the single entry's name, `chain[a,b]`, or `'native'`. An
 * unset chain names the entries the factory actually built, so a skipped
 * optional provider is not reported as having run.
 */
function resolveProviderName(codeReviewConfig, reviewProvider) {
  const configured = Array.isArray(codeReviewConfig?.providers)
    ? codeReviewConfig.providers
    : [];
  const providers =
    configured.length > 0 ? configured : (reviewProvider?.chain?.inline ?? []);
  if (providers.length === 1) {
    return providers[0]?.name ?? 'native';
  }
  if (providers.length > 1) {
    return `chain[${providers.map((p) => p?.name ?? '?').join(',')}]`;
  }
  return 'native';
}

/**
 * `opts.changedFiles` has three states: an array is used verbatim; `null`
 * means the caller already found the diff unenumerable (fail-safe tier, no
 * retry); absent means enumerate here. The close path always injects the
 * change set it derived, so the review scores the same files close routed.
 */
function resolveInjectedChangedFiles({ opts, baseRef, headRef }) {
  if (opts.changedFiles === undefined) {
    return computeChangeSet({
      baseRef,
      headRef,
      cwd: opts.cwd,
      gitSpawnFn: opts.gitSpawnFn,
    }).files;
  }
  return Array.isArray(opts.changedFiles) ? opts.changedFiles : null;
}

/**
 * Build the `runReview` input with its depth; an unenumerable diff yields
 * `standard`.
 */
function buildReviewInput({ opts, scope, ticketId, baseRef, headRef }) {
  const changedFiles = resolveInjectedChangedFiles({ opts, baseRef, headRef });
  const changedFileCount =
    typeof opts.changedFileCount === 'number'
      ? opts.changedFileCount
      : (changedFiles?.length ?? null);
  // Width is the diff's file count, decoupled from planning model capacity.
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
 * Optional `getPromptMessages`; absent or throwing yields `[]`.
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
 * Posting failure is non-fatal and surfaces as `posted: false`. Also posts a
 * `deferPost` review's held report.
 */
export async function postReviewComment({
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

/** A `deferPost` review holds its report for the caller to post. */
async function postUnlessDeferred(opts, post) {
  if (opts.deferPost) return { posted: false, postedCommentId: null };
  return postReviewComment(post);
}

/**
 * Which review provider(s) raised the critical findings left after
 * grounding. Findings a chain stamped with `provider` are tallied per entry;
 * otherwise the one provider owns every critical.
 *
 * @param {{ findings: Array<object>, providerName: string,
 *   severity: { critical: number } }} args
 * @returns {Record<string, number>}
 */
function resolveCriticalByProvider({ findings, providerName, severity }) {
  if (!findings.some((f) => typeof f?.provider === 'string')) {
    return severity.critical > 0 ? { [providerName]: severity.critical } : {};
  }
  const tally = {};
  for (const f of findings) {
    if (f?.severity !== 'critical') continue;
    const name = f.provider ?? providerName;
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

/** Tally, halt verdict and per-provider criticals of grounded findings. */
function scoreFindings(findings, providerName) {
  const severity = countBySeverity(findings);
  const halted = hasSurvivingCritical(severity);
  return {
    severity,
    halted,
    criticalByProvider: resolveCriticalByProvider({
      findings,
      providerName,
      severity,
    }),
    blockerReason: halted
      ? `code-review reported ${severity.critical} critical blocker(s)`
      : null,
  };
}

/**
 * Drop findings whose file, or every instance file, matches a `skipPaths`
 * glob. Config only: guidance prose cannot reach this.
 */
function applySkipPaths(findings, skipPaths) {
  if (!Array.isArray(skipPaths) || skipPaths.length === 0) {
    return { findings, skipped: 0 };
  }
  const isSkipped = picomatch(skipPaths, { dot: true });
  const kept = findings.filter((f) => {
    const files = findingInstances(f).map((i) => i.file);
    return !(files.length > 0 && files.every((file) => isSkipped(file)));
  });
  return { findings: kept, skipped: findings.length - kept.length };
}

/**
 * The Story's review history seam. An injected review provider runs without
 * one unless `opts.historyDeps` is given, so tests never share a history.
 */
function resolveHistoryDeps(opts, config) {
  if (opts.historyDeps) return opts.historyDeps;
  return opts.reviewProvider ? null : { config };
}

/** Mark the findings an earlier run of this Story already raised. */
function markAgainstHistory(findings, ticketId, historyDeps) {
  if (!historyDeps) return findings;
  return markRepeats(findings, readReviewHistory(ticketId, historyDeps));
}

/** Best-effort: a history write failure never fails the review. */
function recordRun({ ticketId, headRef, findings, historyDeps, logger }) {
  if (!historyDeps) return;
  try {
    appendReviewRun(ticketId, { headSha: headRef, findings }, historyDeps);
  } catch (err) {
    logger?.warn?.(
      `[code-review] Could not record the review history: ${err?.message ?? err}`,
    );
  }
}

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
  const reviewProvider =
    injectedReviewProvider ?? createReviewProviderFn(codeReviewConfig);
  const providerName = resolveProviderName(codeReviewConfig, reviewProvider);

  logger?.info?.(
    `[code-review] Running ${providerName} adapter for Story #${ticketId} (${baseRef}...${headRef})...`,
  );

  const guidance = loadReviewGuidance({
    codeReviewConfig,
    root: opts.cwd ?? PROJECT_ROOT,
  });
  const reviewInput = {
    ...buildReviewInput({ opts, scope, ticketId, baseRef, headRef }),
    guidance: guidance.guidance,
  };

  const rawFindings = await reviewProvider.runReview(reviewInput);
  if (!Array.isArray(rawFindings)) {
    throw new TypeError(
      `[code-review] Review provider "${providerName}" returned a non-array; expected Finding[].`,
    );
  }

  const promptMessages = await resolvePromptMessages(
    reviewProvider,
    reviewInput,
    logger,
  );

  // Degraded gates ride beside the findings, never inside them.
  const vetted = await vetFindings({
    findings: rawFindings,
    reviewInput,
    opts,
    degradations: [
      ...(await collectProviderDegradations(reviewProvider, logger)),
      ...(guidance.degradation ? [guidance.degradation] : []),
    ],
  });
  const { degradations, verification } = vetted;
  const skip = applySkipPaths(vetted.findings, codeReviewConfig?.skipPaths);
  const historyDeps = resolveHistoryDeps(opts, config);
  const findings = markAgainstHistory(skip.findings, ticketId, historyDeps);
  const scored = scoreFindings(findings, providerName);
  const report = renderFindingsFn({
    scope,
    ticketId,
    baseRef,
    headRef,
    findings,
    provider: providerName,
    promptMessages,
    degradations,
    verification,
    skipped: skip.skipped,
  });
  recordRun({ ticketId, headRef, findings, historyDeps, logger });

  const { posted, postedCommentId } = await postUnlessDeferred(opts, {
    upsertCommentFn,
    provider,
    commentTargetId,
    report,
    logger,
  });

  return {
    status: 'ok',
    severity: scored.severity,
    findings,
    providerName,
    report,
    posted,
    postedCommentId,
    commentTargetId,
    halted: scored.halted,
    criticalByProvider: scored.criticalByProvider,
    ...degradationEnvelope(degradations),
    verification,
    blockerReason: scored.blockerReason,
  };
}

export async function runCodeReview(opts = {}) {
  const { resolveConfigFn = resolveConfig } = opts;

  const config = resolveConfigFn();
  const envelope = resolveStoryScope(opts, config);

  return executeReviewPipeline({ opts, config, envelope });
}
