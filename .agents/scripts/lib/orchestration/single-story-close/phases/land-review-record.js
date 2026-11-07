/**
 * phases/land-review-record.js — the post-land step that guarantees a landed
 * PR carries a `verification-results` record: close's own post, else the
 * handoff deposit matching the merged head, else an `Unreviewed` marker.
 * Runs before the temp purge, which deletes the deposit.
 */

import { createGh } from '../../../gh-exec.js';
import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import {
  emitRuntimeFriction as defaultEmitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../observability/runtime-friction.js';
import { postReviewComment } from '../../code-review.js';
import { MERGE_WAIT_GH_TIMEOUT_MS } from '../../merge-poll.js';
import {
  probeHeldReviewDiff as defaultProbeHeldReviewDiff,
  readReviewDeposit as defaultReadReviewDeposit,
  depositAsComputedReview,
} from '../../review-deposit.js';
import {
  findStructuredComment as defaultFindStructuredComment,
  postStructuredComment as defaultPostStructuredComment,
  upsertStructuredComment as defaultUpsertStructuredComment,
} from '../../ticketing.js';
import { settleStoryScopeReview as defaultSettleStoryScopeReview } from './code-review.js';

const REVIEW_TYPE = 'verification-results';

/** The merged PR's head SHA and URL, through the merge wait's time-boxed gh. */
async function readPrHead({
  prNumber,
  gh = createGh(undefined, { timeoutMs: MERGE_WAIT_GH_TIMEOUT_MS }),
}) {
  const view = await gh.pr.view(prNumber, ['headRefOid', 'url']);
  const headSha = typeof view?.headRefOid === 'string' ? view.headRefOid : '';
  if (!headSha) throw new Error(`PR #${prNumber} reported no headRefOid`);
  return { headSha, url: typeof view?.url === 'string' ? view.url : null };
}

/** Digest equality alone: land-time matching keeps no-verdict deposits. */
function sameDiff(probed, deposit) {
  return Boolean(probed.diffDigest) && probed.diffDigest === deposit.diffDigest;
}

/** Head-SHA equality first: a merge-commit merge empties the three-dot diff. */
function matchDeposit(ctx, headSha) {
  const deposit = ctx.readDepositFn(Number(ctx.storyId), {
    config: ctx.config,
  });
  if (!deposit) return { deposit: null, reason: 'no-deposit' };
  if (deposit.headSha === headSha) return { deposit, reason: null };
  const probed = ctx.probeHeldReviewDiffFn({
    cwd: ctx.cwd,
    storyId: ctx.storyId,
    sha: headSha,
    baseBranch: ctx.baseBranch,
    gitSpawnFn: ctx.gitSpawnFn,
    config: ctx.config,
    readDepositFn: () => deposit,
  });
  return sameDiff(probed, deposit)
    ? { deposit, reason: null }
    : { deposit: null, reason: 'stale-deposit' };
}

/**
 * @param {{ storyId: number|string, reason: string, headSha: string }} args
 * @returns {string}
 */
function buildUnreviewedMarker({ storyId, reason, headSha }) {
  return [
    `## 🔬 Code Review — Story #${storyId}`,
    '',
    `**Unreviewed** (\`${reason}\`): this PR landed without close and no handoff review matches its merged head \`${headSha}\`.`,
    '',
    `Run \`node .agents/scripts/story-review-compute.js --story ${storyId}\` and read the diff before trusting this merge.`,
  ].join('\n');
}

/** A halt is a merged CRITICAL unless the reviewer never reached a verdict. */
function mergedOverCritical(deposit) {
  return Boolean(deposit.halted) && deposit.haltCause !== 'no-verdict';
}

async function postDeposit(ctx, deposit, pr) {
  const computed = depositAsComputedReview(deposit);
  computed.result.report =
    `> Computed at handoff for \`${deposit.headSha}\`; recorded at land because the Story landed without close.\n\n` +
    computed.result.report;
  const outcome = await ctx.settleStoryScopeReviewFn({
    computed,
    storyId: ctx.storyId,
    prUrl: pr.url ?? ctx.prUrl,
    prNumber: ctx.prNumber,
    provider: ctx.provider,
    progress: (tag, msg) => ctx.progress?.(tag, msg),
    postReportFn: (post) =>
      postReviewComment({
        ...post,
        upsertCommentFn: ctx.upsertStructuredCommentFn,
      }),
  });
  if (!outcome?.posted) return { ok: false, detail: 'post-failed' };
  await emit(ctx, RUNTIME_FRICTION_CATEGORIES.REVIEW_RECORDED_AT_LAND, {
    outcome: 'posted-from-deposit',
    headSha: pr.headSha,
    severity: deposit.severity,
  });
  if (mergedOverCritical(deposit)) {
    await emit(ctx, RUNTIME_FRICTION_CATEGORIES.REVIEW_CRITICAL_MERGED, {
      outcome: 'posted-from-deposit',
      headSha: pr.headSha,
      severity: deposit.severity,
    });
  }
  return { ok: true, detail: 'posted-from-deposit' };
}

async function postUnreviewed(ctx, reason, pr) {
  const outcome = `unreviewed-${reason}`;
  const body = buildUnreviewedMarker({
    storyId: ctx.storyId,
    reason,
    headSha: pr.headSha,
  });
  await ctx.upsertStructuredCommentFn(
    ctx.provider,
    ctx.prNumber,
    REVIEW_TYPE,
    body,
  );
  await ctx.postStructuredCommentFn(
    ctx.provider,
    ctx.storyId,
    'notification',
    `🔬 PR [#${ctx.prNumber}](${pr.url ?? ctx.prUrl}) landed **unreviewed** (\`${reason}\`) — run the Story-scope review before trusting the merge.`,
  );
  await emit(ctx, RUNTIME_FRICTION_CATEGORIES.REVIEW_RECORDED_AT_LAND, {
    outcome,
    headSha: pr.headSha,
  });
  return { ok: true, detail: outcome };
}

function emit(ctx, category, details) {
  return ctx.emitRuntimeFrictionFn({
    storyId: ctx.storyId,
    category,
    tool: 'runPostLandTail',
    details: { ...details, prNumber: ctx.prNumber },
    config: ctx.config,
  });
}

/**
 * @param {object} args
 * @returns {Promise<{ ok: boolean, detail: string }>} `ok` is false only when
 *   the record failed to post; a read failure throws for `step()` to degrade.
 */
export async function recordLandReview({
  storyId,
  prNumber,
  prUrl = null,
  gh,
  baseBranch,
  cwd,
  provider,
  config,
  progress,
  findStructuredCommentFn = defaultFindStructuredComment,
  readPrHeadFn = readPrHead,
  readDepositFn = defaultReadReviewDeposit,
  probeHeldReviewDiffFn = defaultProbeHeldReviewDiff,
  settleStoryScopeReviewFn = defaultSettleStoryScopeReview,
  upsertStructuredCommentFn = defaultUpsertStructuredComment,
  postStructuredCommentFn = defaultPostStructuredComment,
  emitRuntimeFrictionFn = defaultEmitRuntimeFriction,
  gitSpawnFn = defaultGitSpawn,
}) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: true, detail: 'no-pr' };
  }
  if (await findStructuredCommentFn(provider, prNumber, REVIEW_TYPE)) {
    return { ok: true, detail: 'already-recorded' };
  }
  const ctx = {
    storyId,
    prNumber,
    prUrl,
    baseBranch,
    cwd,
    provider,
    config,
    progress,
    readDepositFn,
    probeHeldReviewDiffFn,
    settleStoryScopeReviewFn,
    upsertStructuredCommentFn,
    postStructuredCommentFn,
    emitRuntimeFrictionFn,
    gitSpawnFn,
  };
  const pr = await readPrHeadFn({ prNumber, gh });
  const { deposit, reason } = matchDeposit(ctx, pr.headSha);
  progress?.(
    'POST-LAND',
    `🔬 PR #${prNumber} has no review record — posting ${deposit ? 'the handoff deposit' : `an unreviewed marker (${reason})`}.`,
  );
  return deposit
    ? postDeposit(ctx, deposit, pr)
    : postUnreviewed(ctx, reason, pr);
}
