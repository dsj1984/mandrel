/**
 * post-merge-close.js — drives everything that happens after the merge
 * commit lands on `epic/<id>`: post-merge pipeline (worktree reap, branch
 * cleanup, ticket cascade, health/manifest refresh, perf-summary via
 * analyze-execution.js), pending-cleanup drain reconciliation, phase-timer
 * state file cleanup, and final result-object assembly.
 *
 * Extracted from story-close.js (Story #956, Theme A finishing touch) so
 * the close orchestrator becomes a thin CLI shell.
 *
 * No retry logic, no merge logic, no validation logic — those live in
 * `merge-runner.js` and `pre-merge-validation.js` respectively. This helper
 * is purely the post-merge pipeline sequencing that previously lived
 * inline at the tail of `runStoryClose`.
 *
 * Epic #1030 Story #1046 — the legacy inline `phase-timings` structured
 * comment post was replaced by a `perf-summary` phase inside
 * post-merge-pipeline.js that shells out to `analyze-execution.js`. The
 * timer summary is written to a per-Story JSON file under
 * `temp/epic-<eid>/stories/story-<sid>/phase-timings.json` so the analyzer can
 * read it; this helper writes the file and hands the path to the pipeline.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { emitGhSpawnCount as defaultEmitGhSpawnCount } from '../../close-validation/telemetry.js';
import { storyArtifactPath, storyTempDir } from '../../config/temp-paths.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { clearActiveStoryEnv as defaultClearActiveStoryEnv } from '../../observability/active-story-env.js';
import {
  checkHeadAncestor,
  hasMergeCommitForStory,
  hasRebasedEquivalents,
} from '../../worktree/lifecycle/merge-reachability.js';
import { runPostMergePipeline as defaultRunPostMergePipeline } from '../post-merge-pipeline.js';
import { resolvesGrepArgs } from '../resolves-token.js';
import {
  drainPendingCleanupAfterClose as defaultDrainPendingCleanupAfterClose,
  reconcileCleanupState as defaultReconcileCleanupState,
} from './cleanup-reconciler.js';

/**
 * Assert that the Story branch was actually merged into the Epic branch
 * before allowing the post-merge pipeline to flip Story / Tasks to
 * `agent::done`. The contract: by the time `runPostMergeClose` is called,
 * `runFinalizeMerge` (or `runResumeMerge`) has already executed the
 * `git merge --no-ff` + push; this is a defensive readback that catches
 * the (rare) case where the merge runner returned but the merge commit is
 * not actually reachable from `epic/<id>` — e.g. a force-push from a
 * sibling process clobbered the tip between our merge and our push, and
 * the push's retry logic logged success while the remote silently dropped
 * us.
 *
 * Three-phase check mirrors `worktree/lifecycle/merge-reachability.js`:
 *   1. `git merge-base --is-ancestor` on the Story branch HEAD.
 *   2. Fallback `git log --grep=resolves #<storyId>` on the Epic branch
 *      (the `--no-ff` merge commit's subject is the durable proof).
 *   3. Fallback `git cherry <epicBranch> <storyBranch>` patch-id check
 *      (Story #3161) — every commit on the Story branch is patch-
 *      equivalent to a commit already on `epicBranch`. Surfaces the
 *      manual-recovery case where the operator rebased Story content
 *      directly onto the Epic so the diff is present as commits with
 *      different SHAs.
 *
 * Throws when no check passes — the caller's `try/finally` keeps the
 * Story at `agent::closing` so a `/story-execute --resume` can re-enter
 * the post-merge phase rather than re-running preflight.
 *
 * Story #2144 / Task #2155; Story #3161 extends with the rebased-
 * equivalents path.
 *
 * @param {object} args
 * @param {string} args.cwd        Main-repo working directory.
 * @param {string} args.storyBranch
 * @param {string} args.epicBranch
 * @param {string|number} args.storyId
 * @param {typeof defaultGitSpawn} [args.gitSpawn]
 * @returns {{ reachable: true, reason: string }}
 * @throws {Error} when the merge is not reachable from `epicBranch`.
 */
export function assertMergeReachable({
  cwd,
  storyBranch,
  epicBranch,
  storyId,
  gitSpawn = defaultGitSpawn,
}) {
  const ctx = { repoRoot: cwd, git: { gitSpawn } };
  // Resolve the story branch's tip locally. The Story branch ref still
  // exists at this point — branch-cleanup phase (which deletes it) runs
  // after ticket-closure inside the post-merge pipeline.
  const headRes = gitSpawn(cwd, 'rev-parse', storyBranch);
  if (headRes.status !== 0) {
    // Branch ref already gone (e.g. a prior partial close deleted it) →
    // fall straight to the merge-commit grep, which is the durable proof
    // path. The cherry/patch-id fallback cannot run without the branch
    // ref, so we skip it on this path.
    if (hasMergeCommitForStory(ctx, storyBranch, epicBranch)) {
      return { reachable: true, reason: 'merge-commit-reachable' };
    }
    throw new Error(
      `story-close: merge verification failed for #${storyId} — ` +
        `branch ref \`${storyBranch}\` not resolvable and no \`(resolves #${storyId})\` merge commit on \`${epicBranch}\`. ` +
        `Story remains at \`agent::closing\`; re-run with \`--resume\` once the merge is on \`${epicBranch}\`.`,
    );
  }
  const headSha = headRes.stdout.trim();
  const ancestor = checkHeadAncestor(ctx, headSha, epicBranch);
  if (ancestor.outcome === 'ancestor') {
    return { reachable: true, reason: 'head-reachable-from-epic' };
  }
  if (hasMergeCommitForStory(ctx, storyBranch, epicBranch)) {
    return { reachable: true, reason: 'merge-commit-reachable' };
  }
  if (hasRebasedEquivalents(ctx, storyBranch, epicBranch)) {
    return { reachable: true, reason: 'rebased-equivalents' };
  }
  const headShort = headSha.slice(0, 7) || 'HEAD';
  throw new Error(
    `story-close: merge verification failed for #${storyId} — ` +
      `\`${storyBranch}\` head=${headShort} is not reachable from \`${epicBranch}\` ` +
      `and no \`(resolves #${storyId})\` merge commit found on \`${epicBranch}\` ` +
      `(ancestor=${ancestor.outcome}); patch-id equivalents not detected. ` +
      `Story remains at \`agent::closing\`; ` +
      `re-run with \`--resume\` once the merge is on \`${epicBranch}\`.`,
  );
}

/**
 * Resolve the actual squash/no-ff merge commit sha that landed on
 * `epicBranch` for the named Story. The story-close path uses
 * `git merge --no-ff` with a `(resolves #<id>)` subject; we grep the
 * Epic branch log for that subject and return the matching short sha.
 *
 * Falls back to the Story branch tip if the grep yields no hits (which
 * shouldn't happen on a successful merge, but the lifecycle emit must
 * never crash the close on a measurement-only failure). Returns `null`
 * if both lookups fail — the caller treats `null` as "skip the emit".
 *
 * Story #2241 / Task #2247.
 *
 * @param {{ cwd: string, epicBranch: string, storyBranch: string, storyId: number|string, gitSpawn?: typeof defaultGitSpawn }} args
 * @returns {string|null}
 */
export function resolveMergeSha({
  cwd,
  epicBranch,
  storyBranch,
  storyId,
  gitSpawn = defaultGitSpawn,
}) {
  // Use the durable `(resolves #N)` marker on the merge-commit subject.
  // `--all-match` is unnecessary because we grep a single literal string.
  const grep = gitSpawn(
    cwd,
    'log',
    '-n',
    '1',
    '--format=%H',
    ...resolvesGrepArgs(storyId),
    epicBranch,
  );
  if (grep.status === 0) {
    const sha = (grep.stdout || '').trim();
    if (sha.length >= 7) return sha;
  }
  // Fallback: Story branch tip. The branch ref still exists when we're
  // called from `runPostMergeClose` because branch cleanup is part of the
  // downstream pipeline that hasn't run yet.
  const tip = gitSpawn(cwd, 'rev-parse', storyBranch);
  if (tip.status === 0) {
    const sha = (tip.stdout || '').trim();
    if (sha.length >= 7) return sha;
  }
  return null;
}

/**
 * @param {{
 *   config: object,
 *   storyId: number|string,
 *   epicId: number|string,
 *   story: object,
 *   storyBranch: string,
 *   epicBranch: string,
 *   cwd: string,
 *   projectRoot: string,
 *   provider: object,
 *   notify: Function,
 *   tasks: object[],
 *   skipDashboard: boolean,
 *   progress: Function,
 *   logger: object,
 *   phaseTimer: object,
 *   clearPhaseTimerState: Function,
 *   bus?: object|null,
 *   runPostMergePipeline?: typeof defaultRunPostMergePipeline,
 *   drainPendingCleanupAfterClose?: typeof defaultDrainPendingCleanupAfterClose,
 *   reconcileCleanupState?: typeof defaultReconcileCleanupState,
 *   writeFileFn?: typeof writeFile,
 *   mkdirFn?: typeof mkdir,
 * }} opts
 *   `config`: the resolved config wrapper returned by `resolveConfig()`.
 *   Used by downstream temp-paths helpers + signal writers so per-story
 *   artifacts honor the configured `tempRoot` instead of leaking under
 *   the framework `projectRoot` / `process.cwd()`.
 *   `bus`: optional lifecycle bus. When provided, the helper emits
 *   `story.merged` after the merge-reachability assertion clears (Story
 *   #2241 / Task #2247). Emit failures are swallowed — measurement-only
 *   artifacts must not withhold the close result.
 * @returns {Promise<object>} the final close result object.
 */
export async function runPostMergeClose({
  config,
  storyId,
  epicId,
  story,
  storyBranch,
  epicBranch,
  cwd,
  projectRoot,
  provider,
  notify,
  tasks,
  skipDashboard,
  progress,
  logger,
  phaseTimer,
  clearPhaseTimerState,
  bus = null,
  runPostMergePipeline = defaultRunPostMergePipeline,
  drainPendingCleanupAfterClose = defaultDrainPendingCleanupAfterClose,
  reconcileCleanupState = defaultReconcileCleanupState,
  writeFileFn = writeFile,
  mkdirFn = mkdir,
  clearActiveStoryEnv = defaultClearActiveStoryEnv,
  emitGhSpawnCount = defaultEmitGhSpawnCount,
  assertMergeReachableFn = assertMergeReachable,
  resolveMergeShaFn = resolveMergeSha,
}) {
  const deliveryBlock = config?.delivery;
  // Story #2144 / Task #2155 — gate the post-merge pipeline behind a
  // merge-reachability assertion. The Story is at `agent::closing` at
  // this point; the assertion throws (and the Story stays at
  // `agent::closing`) when the merge runner returned without leaving a
  // reachable merge commit on `epic/<id>`. The `ticketClosurePhase` is
  // the single writer for the `agent::done` transition; gating its
  // pipeline entry is the cheapest way to guarantee the label sequence
  // is exactly `executing → closing → done` on a successful close and
  // `executing → closing` (sticky) on a killed close.
  const reachable = assertMergeReachableFn({
    cwd,
    storyBranch,
    epicBranch,
    storyId,
  });
  progress?.(
    'MERGE-CHECK',
    `Story #${storyId} merge verified (${reachable.reason})`,
  );

  // Story #2241 / Task #2247 — emit `story.merged` once the merge is
  // verified reachable. The bus is optional (legacy in-process callers
  // and unit fixtures pass `null`); when present the LedgerWriter has
  // already been wired by the caller so this emit lands in the same
  // epic-scoped NDJSON ledger the wave loop populates. The emit is
  // best-effort: a measurement-only failure (schema mismatch in a
  // future refactor, ledger I/O blip) must not withhold the merged
  // close result.
  if (bus) {
    try {
      const sha = resolveMergeShaFn({
        cwd,
        epicBranch,
        storyBranch,
        storyId,
      });
      if (sha) {
        await bus.emit('story.merged', {
          storyId: Number(storyId),
          sha,
        });
      } else {
        logger.warn?.(
          `[story-close] ⚠️ Could not resolve merge sha for #${storyId}; skipping story.merged emit.`,
        );
      }
    } catch (err) {
      logger.warn?.(
        `[story-close] ⚠️ story.merged emit failed for #${storyId} (swallowed): ${err?.message ?? err}`,
      );
    }
  }
  // Finish the timer up-front so the analyzer phase inside the pipeline
  // can read the summary from disk. None of the pipeline phases
  // (worktree-reap, branch-cleanup, ticket-closure, …) are tracked by
  // phase-timer.js — `mark('api-sync')` is the last marked phase — so
  // closing the timer here does not lose any spans.
  phaseTimer.mark('api-sync');
  const timingSummary = phaseTimer.finish();
  let phaseTimingsPath = null;
  try {
    const eid = Number(epicId);
    const sid = Number(storyId);
    const dir = storyTempDir(eid, sid, config);
    await mkdirFn(dir, { recursive: true });
    phaseTimingsPath = storyArtifactPath(
      eid,
      sid,
      'phase-timings.json',
      config,
    );
    await writeFileFn(phaseTimingsPath, JSON.stringify(timingSummary, null, 2));
  } catch (err) {
    phaseTimingsPath = null;
    logger.warn?.(
      `[story-close] ⚠️ Failed to write phase-timings JSON: ${err.message}`,
    );
  }

  // Throw-away gh-spawn-count emitter (Story #1795). Snapshots the
  // in-process gh-exec counter to disk so the analyzer child reads it
  // when authoring the `story-perf-summary` structured comment. Best-
  // effort: a write failure logs and resolves so the merge result is
  // never withheld on a measurement-only artifact.
  await emitGhSpawnCount({
    epicId,
    storyId,
    config,
    logger,
  });

  // Reap must precede branch cleanup: git refuses to delete a branch that
  // is still checked out by a live worktree. The pipeline runs the phases
  // in this order — see post-merge-pipeline.js. The `perf-summary` phase
  // inside the pipeline shells out to analyze-execution.js, which is the
  // single writer of the `<!-- structured:story-perf-summary -->` comment.
  // The pipeline phases take the resolved `delivery` block directly, same
  // as the cleanup-reconciler (Story #3986 — the legacy `orchestration`-keyed
  // input bag is gone).
  const pipelineState = await runPostMergePipeline({
    delivery: deliveryBlock,
    storyId,
    epicId,
    story,
    storyBranch,
    epicBranch,
    repoRoot: cwd,
    projectRoot,
    config,
    provider,
    notify,
    tasks,
    skipDashboard,
    progress,
    logger,
    phaseTimingsPath,
  });
  if (
    deliveryBlock?.worktreeIsolation?.enabled &&
    !pipelineState.worktreeReap
  ) {
    throw new Error(
      'story-close invariant violated: worktreeReap state missing while worktree isolation is enabled.',
    );
  }
  const pendingCleanupDrain = await drainPendingCleanupAfterClose({
    repoRoot: cwd,
    delivery: deliveryBlock,
    progress,
    logger,
  });
  const reconciledCleanup = reconcileCleanupState({
    storyId,
    worktreeReap: pipelineState.worktreeReap,
    branchCleanup: pipelineState.branchCleanup,
    pendingCleanupDrain,
  });
  const branchCleanup = reconciledCleanup.branchCleanup;
  const worktreeReap = reconciledCleanup.worktreeReap;
  const { closedTickets, cascadedTo, cascadeFailed } =
    pipelineState.ticketClosure;
  const manifestUpdated = pipelineState.manifestUpdated;

  try {
    clearPhaseTimerState({ mainCwd: cwd, storyId });
  } catch (err) {
    logger.warn?.(
      `[story-close] ⚠️ Failed to clear phase-timer state file: ${err.message}`,
    );
  }

  // Clear the trace-hook env vars (Story #1043). The worktree was
  // reaped above so the `.env.local` is already gone; this also
  // clears the vars on the parent process so any tooling invoked
  // *after* close — planning, dispatch, ad-hoc CLI — falls back to
  // the hook's no-op branch instead of polluting a stale Story
  // directory.
  try {
    clearActiveStoryEnv({ logger });
  } catch (err) {
    logger.warn?.(
      `[story-close] ⚠️ Failed to clear active-Story env: ${err.message}`,
    );
  }

  return {
    storyId,
    epicId,
    action: 'merged',
    merged: true,
    branchDeleted: branchCleanup.localDeleted && branchCleanup.remoteDeleted,
    branchLocalDeleted: branchCleanup.localDeleted,
    branchRemoteDeleted: branchCleanup.remoteDeleted,
    worktreeReap,
    pendingCleanupDrain,
    ticketsClosed: closedTickets,
    cascadedTo: cascadedTo ?? [],
    cascadeFailed: cascadeFailed ?? [],
    manifestUpdated,
  };
}
