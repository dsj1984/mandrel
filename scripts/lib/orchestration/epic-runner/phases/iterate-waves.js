/**
 * Iterate-waves phase — the wave loop.
 *
 * Before the loop: flip Epic to `agent::executing` and initialize checkpoint.
 *
 * Inside the loop: dispatch each wave via StoryLauncher, let WaveObserver
 * reclassify zero-delta stories, record wave history, checkpoint, and
 * delegate blocker halts to BlockerHandler. An unresumed halt short-circuits
 * the pipeline with a `halted` outcome.
 */

import { getRunners } from '../../../config/runners.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { concurrentMap } from '../../../util/concurrent-map.js';
import { DEFAULT_CONCURRENCY } from '../../concurrency.js';
import { STATE_LABELS, transitionTicketState } from '../../ticketing.js';
import {
  emitEpicProgress,
  emitEpicStarted,
  emitEpicUnblocked,
} from '../progress-reporter.js';

/**
 * Pull the set of Story IDs that the prior checkpoint marked as part of
 * a halted wave. Story #1795 — used by the resume-check cache pre-warm:
 * Stories appearing in this set are force-fresh-fetched on resume (the
 * operator may have hand-edited their labels during the blocker
 * window); every other Story serves its resume-check from the
 * provider's in-process cache.
 *
 * Tolerant of partial/legacy checkpoint shapes: a missing or
 * unparseable checkpoint returns an empty set so the resume-check
 * gracefully degrades to "use cache for all" — the existing
 * cold-start fallback inside `getTicket` still issues the real fetch.
 *
 * @param {object | null | undefined} checkpoint
 * @returns {Set<number>}
 */
export function collectHaltedStoryIds(checkpoint) {
  const halted = new Set();
  const waves = checkpoint?.waves;
  if (!Array.isArray(waves)) return halted;
  for (const wave of waves) {
    if (wave?.status !== 'halted') continue;
    const stories = Array.isArray(wave.stories) ? wave.stories : [];
    for (const story of stories) {
      const id =
        story?.storyId ??
        story?.id ??
        (typeof story === 'number' ? story : null);
      if (Number.isInteger(id) && id > 0) halted.add(id);
    }
  }
  return halted;
}

export async function runIterateWavesPhase(ctx, collaborators, state) {
  const { epicId, provider, config, logger } = ctx;
  const { concurrencyCap } = getRunners(config).deliverRunner;
  const {
    notify: notifyFn,
    checkpointer,
    blockerHandler,
    launcher,
    waveObserver,
    progressReporter,
    syncColumn,
    journal,
  } = collaborators;
  const journalSuffix = () => (journal?.path ? ` (see ${journal.path})` : '');
  const { scheduler, waves, epic } = state;

  progressReporter.setPlan({ waves });

  await transitionTicketState(provider, epicId, STATE_LABELS.EXECUTING, {
    notify: notifyFn,
  }).catch(async (err) => {
    logger.warn?.(
      `[EpicRunner] label flip failed: ${err.message}${journalSuffix()}`,
    );
    await journal?.record({
      module: 'EpicRunner',
      op: `transitionTicketState(#${epicId}, EXECUTING)`,
      error: err,
      recovery: 'swallowed',
    });
  });
  await syncColumn(epicId, [STATE_LABELS.EXECUTING]);

  await checkpointer.initialize({
    totalWaves: scheduler.totalWaves,
    concurrencyCap,
  });

  // Story #1795 — resume-check cache pre-warm.
  // Read the checkpoint once up-front and build a Set of story IDs that
  // were in a `halted` wave on the previous run. Those Stories may have
  // had their labels hand-edited by the operator during the resume
  // window, so the per-wave resume-check must still force-fresh them.
  // Every other Story serves the resume-check from the provider's
  // in-process cache — eliminating the `fresh: true` round-trip we
  // historically issued for every Story in every wave.
  const checkpoint = await checkpointer.read().catch(() => null);
  const haltedStoryIds = collectHaltedStoryIds(checkpoint);

  // Curated webhook fires: `epic-started` anchors the epic narrative; the
  // initial `epic-progress` puts the consumer at 0% with the full
  // story-count denominator. Both are fire-and-forget; webhook misconfig
  // must not block dispatch.
  const totalStories = waves.reduce(
    (acc, w) => acc + (Array.isArray(w) ? w.length : 0),
    0,
  );
  await emitEpicStarted({
    notify: notifyFn,
    epicId,
    totalWaves: scheduler.totalWaves,
    totalStories,
    title: epic?.title,
    logger,
  });
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: 0,
    total: totalStories,
    currentWave: 0,
    totalWaves: scheduler.totalWaves,
    phase: 'iterate-waves',
    openBlockers: [],
    logger,
  });

  // The framework no longer owns versioning (Epic #1720 — release tooling is
  // a consumer-project concern). The version-bump-intent module was removed
  // along with the schema knobs (`release.autoVersionBump` etc.) that drove
  // it; no replacement runs here.

  const waveHistory = [];
  while (scheduler.hasMoreWaves()) {
    const wave = scheduler.nextWave();
    logger.info?.(
      `[EpicRunner] Wave ${wave.index + 1}/${scheduler.totalWaves} dispatching ${wave.stories.length} stor${wave.stories.length === 1 ? 'y' : 'ies'}`,
    );
    const { startedAt } = await waveObserver.waveStart({
      index: wave.index,
      totalWaves: scheduler.totalWaves,
      stories: wave.stories,
    });

    progressReporter.setWave({
      index: wave.index,
      totalWaves: scheduler.totalWaves,
      stories: wave.stories,
      startedAt,
    });
    progressReporter.start();

    // Short-circuit stories that are already `agent::done` on resume.
    // Without this, the runner re-dispatches every Story in every wave after
    // a blocker halt — each spawn creates a fresh `story-<id>` branch +
    // `.worktrees/story-<id>/` checkout + `npm ci` before the sub-agent
    // notices the ticket is already closed and bails. Filter here so the
    // launcher only sees real work.
    const waveStoryIds = wave.stories.map((s) => s.id ?? s.storyId ?? s);
    // Story #1795 — resume-check now reads labels from the cache by
    // default. Only Stories that the checkpoint reports as halted on a
    // prior wave are force-refreshed, since they're the operator-resume
    // case where labels may have been hand-edited. Cold-start tickets
    // (cache miss) fall through to the underlying provider read, which
    // historically issued the same single fetch the legacy fresh:true
    // path did.
    const freshStates = await concurrentMap(
      waveStoryIds,
      async (id) => {
        try {
          const opts = haltedStoryIds.has(id) ? { fresh: true } : {};
          const ticket = await provider.getTicket(id, opts);
          return { id, labels: ticket?.labels ?? [] };
        } catch {
          return { id, labels: [] };
        }
      },
      {
        concurrency:
          ctx.concurrency?.progressReporter ??
          DEFAULT_CONCURRENCY.progressReporter,
      },
    );
    const doneIds = new Set(
      freshStates
        .filter((s) => s.labels.includes(AGENT_LABELS.DONE))
        .map((s) => s.id),
    );
    const toLaunch = wave.stories.filter(
      (s) => !doneIds.has(s.id ?? s.storyId ?? s),
    );
    const skippedResults = [...doneIds].map((storyId) => ({
      storyId,
      status: 'done',
      detail: 'already agent::done on resume; dispatch skipped',
    }));
    if (skippedResults.length) {
      logger.info?.(
        `[EpicRunner] Wave ${wave.index + 1}/${scheduler.totalWaves} skipping ${skippedResults.length} already-done stor${skippedResults.length === 1 ? 'y' : 'ies'}: ${[...doneIds].map((id) => `#${id}`).join(', ')}`,
      );
    }
    const spawned = toLaunch.length ? await launcher.launchWave(toLaunch) : [];
    const launchResults = [...skippedResults, ...spawned];
    await progressReporter.stop();

    scheduler.markWaveComplete(wave.index);
    const { stories: results = launchResults } = await waveObserver.waveEnd({
      index: wave.index,
      totalWaves: scheduler.totalWaves,
      startedAt,
      stories: launchResults,
    });
    const failures = results.filter(
      (r) => r.status === 'failed' || r.status === 'blocked',
    );

    waveHistory.push({
      index: wave.index,
      status: failures.length ? 'halted' : 'completed',
      stories: results,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    await checkpointer.write({
      currentWave: scheduler.currentWave,
      totalWaves: scheduler.totalWaves,
      waves: waveHistory,
    });

    // Wave-boundary `epic-progress` fire — sum done stories across the
    // committed wave history. Counts come from per-wave `results.status`
    // (the result type WaveObserver returned), not from re-querying
    // labels, so the snapshot matches what the operator just observed
    // settle. When there are failures we delay this fire until after the
    // blocker handler so `openBlockers` carries the actual reason instead
    // of being empty for one tick.
    const doneStoriesSoFar = waveHistory.reduce(
      (acc, w) =>
        acc + (w.stories ?? []).filter((s) => s?.status === 'done').length,
      0,
    );
    if (!failures.length) {
      await emitEpicProgress({
        notify: notifyFn,
        epicId,
        done: doneStoriesSoFar,
        total: totalStories,
        currentWave: scheduler.currentWave,
        totalWaves: scheduler.totalWaves,
        phase: 'iterate-waves',
        openBlockers: [],
        logger,
      });
    }

    if (failures.length) {
      const firstFailure = failures[0];
      const blockerInfo = {
        reason:
          firstFailure.status === 'blocked' ? 'story_blocked' : 'story_failed',
        storyId: firstFailure.storyId,
        detail: firstFailure.detail,
      };
      await syncColumn(epicId, [AGENT_LABELS.BLOCKED]);
      // Post-blocked progress refresh: BlockerHandler.halt fires the
      // `epic-blocked` notify itself; we follow up with an `epic-progress`
      // snapshot carrying the open blocker so a Slack consumer sees the
      // current state alongside the action-required ping. The progress
      // fire still runs on the no-resume path so the snapshot survives the
      // halted bail-out.
      const halt = await blockerHandler.halt(blockerInfo);
      await emitEpicProgress({
        notify: notifyFn,
        epicId,
        done: doneStoriesSoFar,
        total: totalStories,
        currentWave: scheduler.currentWave,
        totalWaves: scheduler.totalWaves,
        phase: 'iterate-waves',
        openBlockers: [
          { reason: blockerInfo.reason, storyId: blockerInfo.storyId },
        ],
        logger,
      });
      if (!halt.resumed) {
        return {
          ...state,
          waveHistory,
          completionState: 'halted',
        };
      }
      await syncColumn(epicId, [STATE_LABELS.EXECUTING]);
      // Post-unblocked: explicit `epic-unblocked` fire + an
      // `epic-progress` snapshot showing the cleared blocker list so the
      // consumer can drop the "🚧 open blocker" badge.
      await emitEpicUnblocked({
        notify: notifyFn,
        epicId,
        resolvedBlocker: blockerInfo,
        logger,
      });
      await emitEpicProgress({
        notify: notifyFn,
        epicId,
        done: doneStoriesSoFar,
        total: totalStories,
        currentWave: scheduler.currentWave,
        totalWaves: scheduler.totalWaves,
        phase: 'iterate-waves',
        openBlockers: [],
        logger,
      });
    }
  }

  return {
    ...state,
    waveHistory,
    completionState: 'completed',
  };
}
