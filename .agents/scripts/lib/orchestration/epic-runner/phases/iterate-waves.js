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

    if (failures.length) {
      const firstFailure = failures[0];
      await syncColumn(epicId, [AGENT_LABELS.BLOCKED]);
      const halt = await blockerHandler.halt({
        reason:
          firstFailure.status === 'blocked' ? 'story_blocked' : 'story_failed',
        storyId: firstFailure.storyId,
        detail: firstFailure.detail,
      });
      if (!halt.resumed) {
        return {
          ...state,
          waveHistory,
          completionState: 'halted',
        };
      }
      await syncColumn(epicId, [STATE_LABELS.EXECUTING]);
    }
  }

  return {
    ...state,
    waveHistory,
    completionState: 'completed',
  };
}
