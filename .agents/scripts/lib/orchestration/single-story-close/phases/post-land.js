/**
 * phases/post-land.js — the script-owned land tail (Story #4543).
 *
 * Everything after "the PR merged and the Story is `agent::done`" used to be
 * prose in `helpers/deliver-story.md`: Step 5.5 resync, Step 6 cleanup, and
 * follow-up capture, each a separate CLI an agent may or may not have run.
 * Follow-up capture was the sharpest edge — it lived only on the standalone
 * `single-story-confirm-merge.js` path, which close-and-land (the DEFAULT)
 * is explicitly told to skip, so per-Story follow-ups were captured *never*
 * on the default path, and a belated manual confirm could not backfill (the
 * Story is already `agent::done`, so confirm short-circuits `noop` and the
 * capture's `action === 'done'` gate never opens).
 *
 * This module folds all four steps into one phase both landing surfaces
 * reach — the in-close wait (`phases/confirm-merge.js`) and the standalone
 * `single-story-confirm-merge.js` CLI — so the two paths cannot diverge and
 * "landed" means the whole tail ran.
 *
 * **Per-step booleans, not an aggregate.** {@link runPostLandTail} reports
 * each step's outcome individually. That is not bookkeeping fastidiousness:
 * the worktree-reap defect this repo fixed existed because a phase reported
 * an outcome it never checked, and a single `tailOk: true` bit invites that
 * class of bug straight back. A degraded step is visible in the terminal
 * envelope without failing an otherwise-healthy land.
 *
 * **Never throws.** The merge already landed — the code is on the base
 * branch. Failing the land because a Projects v2 mutation flaked would
 * report a false negative about work that is demonstrably done. Every step
 * is best-effort and records its own reason.
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
import {
  executeFastForward as defaultExecuteFastForward,
  planFastForward as defaultPlanFastForward,
} from '../../git-cleanup/phases/fast-forward.js';
import { reassertStatusColumn as defaultReassertStatusColumn } from '../../reassert-status-column.js';
import { captureStoryFollowUps as defaultCaptureStoryFollowUps } from '../../story-follow-ups.js';

/**
 * Lockfile that serializes the local-checkout git mutations of the land tail
 * across concurrent closes. Keyed on the **main checkout** (never a
 * worktree): every concurrent `single-story-close` runs its tail against the
 * same `cwd`, so anchoring the lock under that checkout's `.git` directory
 * makes them all contend on one file. `.git` is always present, is one per
 * checkout, and is never itself tracked, so it is a safe rendezvous home.
 *
 * @param {string} cwd Main checkout root.
 * @returns {string}
 */
function postLandLockPath(cwd) {
  return path.join(cwd, '.git', 'mandrel-post-land-tail.lock');
}

/**
 * Run one tail step, converting any throw into a `false` + reason. Keeps
 * each step's own body free of defensive boilerplate while guaranteeing the
 * module-level never-throws contract.
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
 * Capture the Story's follow-ups from its friction signal stream.
 *
 * Calls `captureStoryFollowUps` **directly** rather than through the
 * `captureFollowUpsAfterConfirm` action-gate wrapper: by the time the tail
 * runs, the merge is already confirmed, so re-deriving that fact from a
 * confirmation envelope's `action` field is the exact coupling that made
 * the default path skip capture entirely.
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
 *
 * A `skipped` envelope (`no-project`, `not-on-project`, `no-meta`) is a
 * **success**: the board the helper would defend does not exist, so there
 * is nothing to get wrong. Only a genuine `drifted` outcome — the helper
 * fired, polled, and still lost — degrades the step.
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

/**
 * Reap the local `story-<id>` ref. GitHub deletes the *remote* branch on
 * squash-merge (`--delete-branch`), but the local ref lingers in the main
 * checkout until something prunes it.
 *
 * An absent ref is a success, not a failure — the sweep is idempotent and
 * a previous run (or the init-time merged-sweep) may have already reaped it.
 */
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
 * Fast-forward local `baseBranch` so the next Story seeds from the tip that
 * now contains this merge. Reuses the same planner/executor pair
 * `single-story-init.js` imports (rather than shelling out to
 * `/git-cleanup`), which is the established in-process composition pattern.
 *
 * `already-up-to-date` is a success. A dirty tree is a legitimate, expected
 * skip on a shared checkout — another worker is mid-flight — so it degrades
 * the step's report without pretending the base moved.
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

/**
 * Run the whole post-land tail. Never throws.
 *
 * Steps run **sequentially** and in this order deliberately: follow-up
 * capture and the status resync touch GitHub, while the ref reap and the
 * fast-forward mutate the local checkout — and the fast-forward must run
 * after the ref reap so `git branch -D` is not fighting a checkout that just
 * moved HEAD.
 *
 * **Cross-process serialization (Story #4622).** The two local-checkout
 * mutations — `stepRefCleanup` (`git branch -D`) and `stepBaseFastForward`
 * (fast-forward `baseBranch`) — run inside a best-effort cross-process lock
 * keyed on the main checkout. Under concurrent delivery (multiple
 * story-workers closing against one shared checkout + per-Story worktrees),
 * an unserialized tail races on the `main` ref and the worktree registry —
 * the `refCleanup:false` ("used by worktree") / `baseFastForward:false`
 * ("not-fast-forward") signature reported in swarm-os friction #579. The
 * GitHub-touching steps stay OUTSIDE the lock so a contended checkout never
 * delays them. The lock is never load-bearing: on sustained contention the
 * bounded wait expires and the mutations run anyway (proceeding is the same
 * best-effort contract every tail step already has).
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {string} args.storyBranch
 * @param {string} args.baseBranch
 * @param {string} args.cwd            The MAIN checkout (never the worktree).
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @param {Function} [args.captureStoryFollowUpsFn] Test seam.
 * @param {Function} [args.emitCloseRecoveredFrictionFn] Test seam.
 * @param {Function} [args.emitRecoveredFrictionMarkerFn] Test seam.
 * @param {Function} [args.reassertStatusColumnFn]  Test seam.
 * @param {Function} [args.gitSpawnFn]              Test seam.
 * @param {Function} [args.planFastForwardFn]       Test seam.
 * @param {Function} [args.executeFastForwardFn]    Test seam.
 * @param {Function} [args.acquireLockWithWaitFn]   Test seam.
 * @returns {Promise<{ followUps: boolean, statusResync: boolean, refCleanup: boolean, baseFastForward: boolean, details: Record<string, string|null> }>}
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
}) {
  progress?.('POST-LAND', `🧾 Running land tail for Story #${storyId}...`);

  // The close landed, so every friction incident on this Story's stream is
  // provably resolved. Emit the recovery markers BEFORE follow-up capture
  // reads the stream: the `landed` terminal envelope is emitted after this
  // whole tail, so a marker written there would arrive too late to net
  // anything out of the very run that produced the incident. Each emit is
  // conditional on an un-recovered record already present, so a Story that
  // never hit the incident gets no spurious (and bucket-suppressing) row.
  //   - `close-failed`         — Story #4649.
  //   - `story-blocked`        — a Story that blocked then reached
  //     `agent::done` (Story #4654); resolves the occurrence-1 force-file.
  //   - `merge-wait-exhausted` — a merge that spent its whole budget and
  //     landed on a later resume (Story #4654); the residual case the
  //     `frictionForTerminal` budget guard cannot suppress at the source.
  // Best-effort and never throws, exactly like every other tail step.
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

  const followUps = await step(
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
  );
  const statusResync = await step(
    () =>
      stepStatusResync({
        storyId,
        provider,
        config,
        progress,
        reassertStatusColumnFn,
      }),
    { name: 'status-column resync', progress },
  );
  // Local-checkout mutations: serialized behind a best-effort cross-process
  // lock (Story #4622). Acquire once, run both steps, release in `finally`.
  const lockCfg = config?.delivery?.postLandLock ?? {};
  const lock = await acquireLockWithWaitFn({
    lockPath: postLandLockPath(cwd),
    waitMs: lockCfg.waitMs,
    pollMs: lockCfg.pollMs,
    timeoutMs: lockCfg.timeoutMs,
    ownerId: `post-land-${storyId}`,
  });
  if (!lock.acquired) {
    // Never load-bearing: proceed anyway. The bounded wait already gave the
    // concurrent holder its window; blocking the land on a lock we could not
    // take would turn a best-effort damper into a false negative.
    progress?.(
      'POST-LAND',
      `⚠️ post-land lock not acquired (${lock.reason}); proceeding unserialized.`,
    );
  }
  let refCleanup;
  let baseFastForward;
  try {
    refCleanup = await step(
      () => stepRefCleanup({ cwd, storyBranch, progress, gitSpawnFn }),
      { name: 'local ref cleanup', progress },
    );
    baseFastForward = await step(
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
  } finally {
    if (lock.acquired) lock.release();
  }

  const tail = {
    followUps: followUps.ok,
    statusResync: statusResync.ok,
    refCleanup: refCleanup.ok,
    baseFastForward: baseFastForward.ok,
    details: {
      followUps: followUps.detail,
      statusResync: statusResync.detail,
      refCleanup: refCleanup.detail,
      baseFastForward: baseFastForward.detail,
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
