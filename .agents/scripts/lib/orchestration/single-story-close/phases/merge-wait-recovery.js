/**
 * phases/merge-wait-recovery.js — the merge wait's answer to a PR `main`
 * moved under. DIRTY: sync in the Story worktree and push, spending the
 * BEHIND budget; any failure hands back a `failed` / `base-sync` outcome,
 * labels untouched. Un-armed: re-arm once per head SHA, behind the red-fix
 * guard and the arm policy.
 */

import { getCiDelivery } from '../../../config/ci.js';
import { syncBranchFromBase as defaultSyncBranchFromBase } from '../../../git/sync-from-base.js';
import { gitSpawn } from '../../../git-utils.js';
import {
  classifyGreenVerdict,
  readCiDigest as defaultReadCiDigest,
} from '../../ci-rerun-guard.js';
import { rearmAutoMerge as defaultRearmAutoMerge } from './auto-merge.js';
import { handleSyncFailure as defaultHandleSyncFailure } from './base-sync.js';
import { pushStoryBranch as defaultPushStoryBranch } from './push.js';
import { integrateRemoteStoryBranch as defaultIntegrateRemote } from './story-branch-catch-up.js';

/** The red-fix guard verdicts under which a re-arm is allowed. */
const REARM_VERDICTS = Object.freeze([
  'clean',
  'fix-at-source',
  'rerun-permitted',
]);

function defaultCurrentBranch(cwd) {
  const head = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  return head.status === 0 ? String(head.stdout ?? '').trim() : null;
}

/** Defaults for every seam this module reads off the wait's `ctx`. */
export function mergeWaitRecoverySeams({
  syncBranchFromBaseFn = defaultSyncBranchFromBase,
  pushStoryBranchFn = defaultPushStoryBranch,
  handleSyncFailureFn = defaultHandleSyncFailure,
  rearmAutoMergeFn = defaultRearmAutoMerge,
  readCiDigestFn = defaultReadCiDigest,
  integrateRemoteFn = defaultIntegrateRemote,
  currentBranchFn = defaultCurrentBranch,
} = {}) {
  return {
    integrateRemoteFn,
    currentBranchFn,
    syncBranchFromBaseFn,
    pushStoryBranchFn,
    handleSyncFailureFn,
    rearmAutoMergeFn,
    readCiDigestFn,
    rearmedHeads: new Set(),
  };
}

function isOpenDirty(probe) {
  return (
    probe?.state === 'OPEN' &&
    !probe?.mergedAt &&
    probe?.mergeStateStatus === 'DIRTY'
  );
}

function syncCwdOf(ctx) {
  return ctx.worktreePath ?? ctx.cwd;
}

function describeSyncFailure({
  storyId,
  prNumber,
  baseBranch,
  syncCwd,
  result,
}) {
  const files = result.conflictFiles ?? [];
  const evidence =
    files.length > 0
      ? `conflicting files = ${files.join(', ')}`
      : String(result.stderr ?? '')
          .trim()
          .slice(0, 300) || 'no detail';
  return (
    `PR #${prNumber} is DIRTY against origin/${baseBranch} and the merge-wait base sync ` +
    `could not land it (${result.kind}): ${evidence}. Labels unchanged — resolve it in the ` +
    `Story worktree ${syncCwd} (git merge --no-edit origin/${baseBranch}, fix, commit), ` +
    `then re-run close for Story #${storyId}.`
  );
}

/**
 * The Story worktree, resolved only when a DIRTY sync needs it, so a missing
 * one never stands between a resume and an already-merged PR.
 *
 * @returns {Promise<object|null>} a failed sync result, or null when ready.
 */
async function resolveDirtyWorktree(ctx) {
  const resolve = ctx.resolveWorktree;
  if (typeof resolve !== 'function') return null;
  ctx.resolveWorktree = null;
  try {
    ctx.worktreePath = await resolve();
    return null;
  } catch (err) {
    return {
      synced: false,
      kind: 'worktree-unavailable',
      stderr: String(err?.message ?? err),
    };
  }
}

/**
 * Merge only into `story-<id>`: with no worktree the sync runs in the main
 * checkout, which a `--wait` resume may find on `main` or anything else.
 *
 * @returns {object|null} a failed sync result, or null when on the branch.
 */
function refuseWrongTree(ctx) {
  const branch = ctx.currentBranchFn(syncCwdOf(ctx));
  if (branch === ctx.storyBranch) return null;
  return {
    synced: false,
    kind: 'wrong-tree',
    stderr: `${syncCwdOf(ctx)} has ${branch ?? 'no readable branch'} checked out, not ${ctx.storyBranch} — nothing was merged`,
  };
}

/**
 * `origin/<story>` first (a BEHIND update merged there only), then the base.
 *
 * @returns {Promise<object>} a `syncBranchFromBase`-shaped result.
 */
async function syncDirtyHead(ctx) {
  const unavailable = await resolveDirtyWorktree(ctx);
  if (unavailable) return unavailable;
  const wrongTree = refuseWrongTree(ctx);
  if (wrongTree) return wrongTree;
  const remote = ctx.integrateRemoteFn({
    cwd: syncCwdOf(ctx),
    storyBranch: ctx.storyBranch,
  });
  if (!remote.ok) {
    return { synced: false, kind: 'remote-diverged', stderr: remote.stderr };
  }
  return ctx.syncBranchFromBaseFn({
    cwd: syncCwdOf(ctx),
    baseBranch: ctx.baseBranch,
    log: (tag, msg) => ctx.progress?.(tag, msg),
  });
}

/** Friction through the pre-PR SYNC's own path, labels left alone. */
async function handBackDirty(ctx, probe, result) {
  const syncCwd = syncCwdOf(ctx);
  await ctx.handleSyncFailureFn({
    provider: ctx.provider,
    storyId: ctx.storyId,
    syncCwd,
    baseBranch: ctx.baseBranch,
    baseConfirmed: true,
    storyBranch: ctx.storyBranch,
    result,
    handBack: true,
    progress: (tag, msg) => ctx.progress?.(tag, msg),
  });
  return {
    confirmed: false,
    terminal: 'failed',
    phase: 'base-sync',
    reason: describeSyncFailure({
      storyId: ctx.storyId,
      prNumber: ctx.prNumber,
      baseBranch: ctx.baseBranch,
      syncCwd,
      result,
    }),
    prProbe: probe,
  };
}

/** @returns {{ ok: true }|{ ok: false, result: object }} */
function pushSynced(ctx) {
  try {
    ctx.pushStoryBranchFn({
      cwd: ctx.cwd,
      worktreePath: ctx.worktreePath ?? null,
      storyBranch: ctx.storyBranch,
      progress: (tag, msg) => ctx.progress?.(tag, msg),
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      result: { kind: 'push-failed', stderr: String(err?.message ?? err) },
    };
  }
}

/**
 * `null` when the PR is not DIRTY; else the next state and a `null` outcome
 * (synced and pushed) or the `failed` one.
 *
 * @returns {Promise<{ state: object, outcome: object|null }|null>}
 */
export async function settleDirtyPr(ctx, state, probe) {
  if (!isOpenDirty(probe)) return null;
  const budget = ctx.limits.updateAttempts;
  if (state.updatesUsed >= budget) {
    return {
      state,
      outcome: await handBackDirty(ctx, probe, {
        kind: 'conflict',
        conflictFiles: [],
        stderr: `the PR is still DIRTY after ${budget} merge-wait base sync(s) — the update budget is spent`,
      }),
    };
  }
  ctx.progress?.(
    'CONFIRM',
    `🔀 PR #${ctx.prNumber} is DIRTY — merging origin/${ctx.baseBranch} in the Story worktree ` +
      `(attempt ${state.updatesUsed + 1}/${budget}).`,
  );
  const result = await syncDirtyHead(ctx);
  // An already-current branch spends nothing: GitHub is still recomputing.
  const spent =
    result.kind === 'noop-already-current'
      ? state
      : { ...state, updatesUsed: state.updatesUsed + 1 };
  if (!result.synced) {
    return { state: spent, outcome: await handBackDirty(ctx, probe, result) };
  }
  const pushed = pushSynced(ctx);
  if (!pushed.ok) {
    return {
      state: spent,
      outcome: await handBackDirty(ctx, probe, pushed.result),
    };
  }
  ctx.progress?.(
    'CONFIRM',
    `✅ PR #${ctx.prNumber}: synced from origin/${ctx.baseBranch} (${result.kind}) and pushed — still waiting.`,
  );
  return { state: spent, outcome: null };
}

/** Re-arm only a PR close itself armed (`ctx.closeArmed`), never an operator's. */
function isUnarmedOpenPr(probe, ctx) {
  return (
    ctx.closeArmed === true &&
    probe?.state === 'OPEN' &&
    !probe?.mergedAt &&
    probe?.inMergeQueue !== true &&
    probe?.autoMergeArmed === false &&
    probe?.checksStatus !== 'failure'
  );
}

/** The red-fix guard: a CI digest recorded against this head blocks it. */
function rearmGuard(ctx, headSha) {
  const digest = ctx.readCiDigestFn({
    storyId: ctx.storyId,
    tempRoot: ctx.config?.project?.paths?.tempRoot ?? 'temp',
    cwd: ctx.cwd,
  });
  return classifyGreenVerdict({ digest, headSha });
}

/** Re-arm an open, un-armed, not-red PR once per head; never a terminal. */
export async function maybeRearmPr(ctx, probe) {
  const headSha = probe?.headSha;
  if (
    !isUnarmedOpenPr(probe, ctx) ||
    !headSha ||
    ctx.rearmedHeads.has(headSha)
  ) {
    return;
  }
  ctx.rearmedHeads.add(headSha);
  if (getCiDelivery(ctx.config).autoMerge === 'strict') return;
  const guard = rearmGuard(ctx, headSha);
  if (!REARM_VERDICTS.includes(guard.verdict)) {
    ctx.progress?.(
      'CONFIRM',
      `⏭  PR #${ctx.prNumber} has no auto-merge request, but it is not re-armed (${guard.verdict}: ${guard.reason}).`,
    );
    return;
  }
  const armed = await ctx
    .rearmAutoMergeFn({ cwd: ctx.cwd, prNumber: ctx.prNumber, gh: ctx.waitGh })
    .catch((err) => ({ enabled: false, reason: String(err?.message ?? err) }));
  ctx.progress?.(
    'CONFIRM',
    armed?.enabled
      ? `🔁 PR #${ctx.prNumber} lost its auto-merge request on head ${headSha.slice(0, 7)} — re-armed.`
      : `⚠️ PR #${ctx.prNumber} re-arm failed (${armed?.reason ?? 'unknown'}) — still waiting.`,
  );
}
