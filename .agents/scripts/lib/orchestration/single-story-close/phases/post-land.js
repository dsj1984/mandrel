/**
 * phases/post-land.js — the land tail, the one seam both landing surfaces
 * (the in-close wait and the standalone confirm CLI) reach, so "landed"
 * means the whole tail ran on either.
 *
 * Reports per-step booleans, never one aggregate bit, so a step cannot claim
 * an outcome it never checked. Never throws: the merge already landed, and a
 * flaky step must degrade the report, not the land.
 */

import path from 'node:path';

import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import { Logger } from '../../../Logger.js';
import {
  emitCloseRecoveredFriction as defaultEmitCloseRecoveredFriction,
  emitRecoveredFrictionMarker as defaultEmitRecoveredFrictionMarker,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../observability/runtime-friction.js';
import { acquireLockWithWait as defaultAcquireLockWithWait } from '../../../single-story-sweep/sweep-lock.js';
import { purgeStoryTempArtifacts as defaultPurgeStoryTempArtifacts } from '../../../temp-retention.js';
import { rollUpEpicForStory as defaultRollUpEpicForStory } from '../../epic-rollup.js';
import {
  executeFastForward as defaultExecuteFastForward,
  planFastForward as defaultPlanFastForward,
} from '../../git-cleanup/phases/fast-forward.js';
import { reapPlanRunLabelsForStory as defaultReapPlanRunLabelsForStory } from '../../plan-run-labels/reap.js';
import { reassertStatusColumn as defaultReassertStatusColumn } from '../../reassert-status-column.js';
import { releaseStoryLease as defaultReleaseStoryLease } from '../../single-story-lease-guard.js';
import { captureStoryFollowUps as defaultCaptureStoryFollowUps } from '../../story-follow-ups.js';

/**
 * Under the MAIN checkout's `.git`, so every concurrent close contends on one file.
 *
 * @param {string} cwd Main checkout root.
 * @returns {string}
 */
function postLandLockPath(cwd) {
  return path.join(cwd, '.git', 'mandrel-post-land-tail.lock');
}

/**
 * Converts any throw into `{ ok: false, detail }`.
 *
 * @template T
 * @param {() => Promise<{ ok: boolean, detail?: string|null }>} run
 * @param {{ name: string, progress?: Function }} ctx
 * @returns {Promise<{ ok: boolean, detail: string|null }>}
 */
async function step(run, { name, progress }) {
  try {
    const outcome = await run();
    if (!outcome.ok) {
      progress?.(
        'POST-LAND',
        `⚠️ ${name} degraded (land stands): ${outcome.detail ?? 'no detail'}`,
      );
    }
    return { ok: Boolean(outcome.ok), detail: outcome.detail ?? null };
  } catch (err) {
    const detail = String(err?.message ?? err);
    Logger.warn(`[post-land] ${name} threw (land stands): ${detail}`);
    progress?.('POST-LAND', `⚠️ ${name} threw (land stands): ${detail}`);
    return { ok: false, detail };
  }
}

/**
 * Calls capture directly, not via the `action`-gated wrapper: the merge is
 * already confirmed, and that gate never opens on an already-done Story.
 */
async function stepFollowUps({
  storyId,
  provider,
  config,
  cwd,
  progress,
  captureStoryFollowUpsFn,
}) {
  const result = await captureStoryFollowUpsFn({
    storyId,
    provider,
    config,
    cwd,
    progress,
  });
  return {
    ok: result?.ok === true,
    detail: result?.ok === true ? null : (result?.reason ?? 'capture-failed'),
  };
}

/**
 * Re-assert the Projects v2 Status column against the bot's late write.
 * `skipped` (no board) is success; only `drifted` degrades.
 */
async function stepStatusResync({
  storyId,
  provider,
  config,
  progress,
  reassertStatusColumnFn,
}) {
  const outcome = await reassertStatusColumnFn({
    provider,
    ticketId: storyId,
    config,
    logger: {
      info: (m) => progress?.('POST-LAND', m),
      warn: (m) => progress?.('POST-LAND', `⚠️ ${m}`),
    },
  });
  if (outcome?.status === 'synced' || outcome?.status === 'skipped') {
    return { ok: true, detail: null };
  }
  return {
    ok: false,
    detail: `status column ${outcome?.status ?? 'unknown'} (target=${outcome?.column ?? 'n/a'}, attempts=${outcome?.attempts ?? 0})`,
  };
}

/** Reap the local `story-<id>` ref; already absent is success. */
async function stepRefCleanup({ cwd, storyBranch, progress, gitSpawnFn }) {
  const exists = gitSpawnFn(
    cwd,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${storyBranch}`,
  );
  if (exists.status !== 0) {
    progress?.('POST-LAND', `⏭  local ${storyBranch} already absent.`);
    return { ok: true, detail: null };
  }
  const del = gitSpawnFn(cwd, 'branch', '-D', storyBranch);
  if (del.status !== 0) {
    return { ok: false, detail: `git branch -D failed: ${del.stderr ?? ''}` };
  }
  progress?.('POST-LAND', `🧹 reaped local ${storyBranch}.`);
  return { ok: true, detail: null };
}

/**
 * Fast-forward local `baseBranch` so the next Story seeds from this merge. A
 * dirty shared checkout is an expected skip that degrades the report.
 */
async function stepBaseFastForward({
  cwd,
  baseBranch,
  progress,
  planFastForwardFn,
  executeFastForwardFn,
}) {
  const plan = planFastForwardFn({ cwd, baseBranch });
  if (!plan.runnable && plan.reason === 'already-up-to-date') {
    progress?.('POST-LAND', `⏭  local ${baseBranch} already up to date.`);
    return { ok: true, detail: null };
  }
  const ff = executeFastForwardFn({
    cwd,
    baseBranch,
    plan,
    logger: {
      info: (m) => progress?.('POST-LAND', m),
      warn: (m) => progress?.('POST-LAND', `⚠️ ${m}`),
    },
  });
  if (ff.applied) {
    progress?.(
      'POST-LAND',
      `⏩ fast-forwarded ${baseBranch} by ${ff.behind} commit(s).`,
    );
    return { ok: true, detail: null };
  }
  return {
    ok: false,
    detail: `fast-forward skipped: ${ff.reason ?? plan.reason ?? 'unknown'}`,
  };
}

/** Only errors degrade; a config-disabled purge is success. */
async function stepTempPurge({ storyId, config, purgeStoryTempArtifactsFn }) {
  const result = await purgeStoryTempArtifactsFn({ storyId, config });
  const errors = result?.errors ?? [];
  return { ok: errors.length === 0, detail: errors.join('; ') || null };
}

/**
 * Release the lease only once the merge is confirmed: the claim is the
 * ticket's record of who owns in-flight work. Idempotent (no-ops for a
 * non-owner); a `released: false` no-op is success, only a throw degrades.
 */
async function stepLeaseRelease({
  storyId,
  provider,
  config,
  progress,
  releaseStoryLeaseFn,
}) {
  const outcome = await releaseStoryLeaseFn({ provider, storyId, config });
  progress?.(
    'POST-LAND',
    outcome?.released
      ? `🔓 Story #${storyId} lease released (merge confirmed).`
      : `⏭  Story #${storyId} lease not released (${outcome?.reason ?? 'unknown'}).`,
  );
  return {
    ok: true,
    detail: outcome?.released ? null : (outcome?.reason ?? null),
  };
}

/** Named in the reap warning so the remedy is in the message. */
const REAP_SWEEP_REMEDY = 'node .agents/scripts/prune-plan-run-labels.js';

/**
 * Roll up the container Epic; here because only this seam fires for both
 * single- and multi-Story runs. Reported in `tail` (unlike the label reap):
 * a wrong Epic state is visible and actionable.
 *
 * @returns {Promise<{ ok: boolean, detail: string|null }>}
 */
async function stepEpicRollup({
  storyId,
  provider,
  config,
  progress,
  rollUpEpicForStoryFn,
}) {
  const outcome = await rollUpEpicForStoryFn({ storyId, provider, config });
  for (const epicId of outcome?.closed ?? []) {
    progress?.(
      'POST-LAND',
      `🗃️  Closed container Epic #${epicId} — every child Story landed.`,
    );
  }
  const failures = (outcome?.epics ?? []).filter((e) => e?.detail);
  return {
    ok: failures.length === 0,
    detail: failures.length
      ? failures.map((e) => `#${e.epicId}: ${e.detail}`).join('; ')
      : null,
  };
}

/**
 * Reap the Story's cohort labels (the run epilogue never sees them). Not
 * reported in `tail`: nothing reads a cohort label, so a failure only warns.
 * Never reaps a zero-issue label — it may be one a persist just minted.
 */
async function stepPlanRunLabelReap({
  storyId,
  provider,
  progress,
  reapPlanRunLabelsForStoryFn,
}) {
  const warn = (message) =>
    progress?.(
      'POST-LAND',
      `⚠️ plan-run label reap: ${message} — sweep the pile with ` +
        `"${REAP_SWEEP_REMEDY}".`,
    );
  const outcome = await reapPlanRunLabelsForStoryFn({
    storyId,
    provider,
    onWarn: warn,
  });
  const reaped = outcome?.deleted?.length ?? 0;
  if (reaped > 0) {
    progress?.(
      'POST-LAND',
      `🏷️  Reaped ${reaped} spent plan-run label(s): ` +
        `${outcome.deleted.map((d) => d.label).join(', ')}.`,
    );
  }
  return {
    ok: (outcome?.failed?.length ?? 0) === 0,
    detail: outcome?.failed?.length
      ? outcome.failed.map((f) => f.label).join(', ')
      : null,
  };
}

/**
 * The local-checkout mutations (ref reap first, then fast-forward) under a
 * cross-process lock on the main checkout, since concurrent closes race on
 * the base ref and worktree registry. Best-effort: on timeout they run anyway.
 */
async function runLockedLocalSteps({
  storyId,
  storyBranch,
  baseBranch,
  cwd,
  config,
  progress,
  gitSpawnFn,
  planFastForwardFn,
  executeFastForwardFn,
  acquireLockWithWaitFn,
}) {
  const lockCfg = config?.delivery?.postLandLock ?? {};
  const lock = await acquireLockWithWaitFn({
    lockPath: postLandLockPath(cwd),
    waitMs: lockCfg.waitMs,
    pollMs: lockCfg.pollMs,
    timeoutMs: lockCfg.timeoutMs,
    ownerId: `post-land-${storyId}`,
  });
  if (!lock.acquired) {
    progress?.(
      'POST-LAND',
      `⚠️ post-land lock not acquired (${lock.reason}); proceeding unserialized.`,
    );
  }
  try {
    const refCleanup = await step(
      () => stepRefCleanup({ cwd, storyBranch, progress, gitSpawnFn }),
      { name: 'local ref cleanup', progress },
    );
    const baseFastForward = await step(
      () =>
        stepBaseFastForward({
          cwd,
          baseBranch,
          progress,
          planFastForwardFn,
          executeFastForwardFn,
        }),
      { name: 'base fast-forward', progress },
    );
    return { refCleanup, baseFastForward };
  } finally {
    if (lock.acquired) lock.release();
  }
}

/**
 * Run the post-land tail: friction markers, then the GitHub steps and the
 * locked local steps concurrently, then temp purge, then lease release.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.storyBranch
 * @param {string} args.baseBranch
 * @param {string} args.cwd            The MAIN checkout (never the worktree).
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @param {Function} [args.captureStoryFollowUpsFn]
 * @param {Function} [args.emitCloseRecoveredFrictionFn]
 * @param {Function} [args.emitRecoveredFrictionMarkerFn]
 * @param {Function} [args.reassertStatusColumnFn]
 * @param {Function} [args.gitSpawnFn]
 * @param {Function} [args.planFastForwardFn]
 * @param {Function} [args.executeFastForwardFn]
 * @param {Function} [args.acquireLockWithWaitFn]
 * @param {Function} [args.purgeStoryTempArtifactsFn]
 * @param {Function} [args.releaseStoryLeaseFn]
 * @param {Function} [args.reapPlanRunLabelsForStoryFn]
 * @param {Function} [args.rollUpEpicForStoryFn]
 * @returns {Promise<{ followUps: boolean, statusResync: boolean, refCleanup: boolean, baseFastForward: boolean, tempPurge: boolean, leaseRelease: boolean, epicRollup: boolean, details: Record<string, string|null> }>}
 */
export async function runPostLandTail({
  storyId,
  storyBranch,
  baseBranch,
  cwd,
  provider,
  config,
  progress,
  captureStoryFollowUpsFn = defaultCaptureStoryFollowUps,
  emitCloseRecoveredFrictionFn = defaultEmitCloseRecoveredFriction,
  emitRecoveredFrictionMarkerFn = defaultEmitRecoveredFrictionMarker,
  reassertStatusColumnFn = defaultReassertStatusColumn,
  gitSpawnFn = defaultGitSpawn,
  planFastForwardFn = defaultPlanFastForward,
  executeFastForwardFn = defaultExecuteFastForward,
  acquireLockWithWaitFn = defaultAcquireLockWithWait,
  purgeStoryTempArtifactsFn = defaultPurgeStoryTempArtifacts,
  releaseStoryLeaseFn = defaultReleaseStoryLease,
  reapPlanRunLabelsForStoryFn = defaultReapPlanRunLabelsForStory,
  rollUpEpicForStoryFn = defaultRollUpEpicForStory,
}) {
  progress?.('POST-LAND', `🧾 Running land tail for Story #${storyId}...`);

  // The land resolves this Story's friction incidents. Mark them recovered
  // BEFORE follow-up capture reads the stream; each emit fires only over an
  // un-recovered record, so no spurious rows.
  await emitCloseRecoveredFrictionFn({ storyId, config });
  await emitRecoveredFrictionMarkerFn({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
    config,
  });
  await emitRecoveredFrictionMarkerFn({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED,
    config,
  });

  // The GitHub steps are independent of each other and of the local
  // lock-held mutations, so all of them run concurrently.
  const [followUps, statusResync, , epicRollup, local] = await Promise.all([
    step(
      () =>
        stepFollowUps({
          storyId,
          provider,
          config,
          cwd,
          progress,
          captureStoryFollowUpsFn,
        }),
      { name: 'follow-up capture', progress },
    ),
    step(
      () =>
        stepStatusResync({
          storyId,
          provider,
          config,
          progress,
          reassertStatusColumnFn,
        }),
      { name: 'status-column resync', progress },
    ),
    step(
      () =>
        stepPlanRunLabelReap({
          storyId,
          provider,
          progress,
          reapPlanRunLabelsForStoryFn,
        }),
      { name: 'plan-run label reap', progress },
    ),
    step(
      () =>
        stepEpicRollup({
          storyId,
          provider,
          config,
          progress,
          rollUpEpicForStoryFn,
        }),
      { name: 'epic rollup', progress },
    ),
    runLockedLocalSteps({
      storyId,
      storyBranch,
      baseBranch,
      cwd,
      config,
      progress,
      gitSpawnFn,
      planFastForwardFn,
      executeFastForwardFn,
      acquireLockWithWaitFn,
    }),
  ]);
  const { refCleanup, baseFastForward } = local;

  // After every step that reads the temp artifacts; `signals.ndjson` survives.
  const tempPurge = await step(
    () => stepTempPurge({ storyId, config, purgeStoryTempArtifactsFn }),
    { name: 'temp purge', progress },
  );

  const leaseRelease = await step(
    () =>
      stepLeaseRelease({
        storyId,
        provider,
        config,
        progress,
        releaseStoryLeaseFn,
      }),
    { name: 'lease release', progress },
  );

  const tail = {
    followUps: followUps.ok,
    statusResync: statusResync.ok,
    refCleanup: refCleanup.ok,
    baseFastForward: baseFastForward.ok,
    tempPurge: tempPurge.ok,
    leaseRelease: leaseRelease.ok,
    epicRollup: epicRollup.ok,
    details: {
      followUps: followUps.detail,
      statusResync: statusResync.detail,
      refCleanup: refCleanup.detail,
      baseFastForward: baseFastForward.detail,
      tempPurge: tempPurge.detail,
      leaseRelease: leaseRelease.detail,
      epicRollup: epicRollup.detail,
    },
  };
  const degraded = Object.entries(tail)
    .filter(([k, v]) => k !== 'details' && v === false)
    .map(([k]) => k);
  progress?.(
    'POST-LAND',
    degraded.length === 0
      ? `✅ Land tail complete for Story #${storyId} (all steps ok).`
      : `✅ Land tail complete for Story #${storyId} — degraded: ${degraded.join(', ')} (the merge stands).`,
  );
  return tail;
}
