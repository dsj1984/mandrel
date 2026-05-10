/**
 * Iterate-waves phase — the wave loop.
 *
 * Before the loop: flip Epic to `agent::executing`, initialize checkpoint,
 * run the version-bump-intent check.
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
import { checkVersionBumpIntent } from '../version-bump-intent.js';

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

  try {
    await checkVersionBumpIntent({
      provider,
      epicId,
      epicBody: epic.body ?? '',
      autoVersionBump: Boolean(ctx.autoVersionBump),
      logger,
    });
  } catch (err) {
    logger.warn?.(
      `[EpicRunner] version-bump-intent check failed: ${err.message}${journalSuffix()}`,
    );
    await journal?.record({
      module: 'EpicRunner',
      op: 'checkVersionBumpIntent',
      error: err,
      recovery: 'swallowed',
    });
  }

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
    const freshStates = await concurrentMap(
      waveStoryIds,
      async (id) => {
        try {
          const ticket = await provider.getTicket(id, { fresh: true });
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
      // current state alongside the action-required ping.
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
      const halt = await blockerHandler.halt(blockerInfo);
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
