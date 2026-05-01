/**
 * EpicRunner collaborator factory.
 *
 * `createEpicRunnerCollaborators(ctx)` returns the full collaborator bag
 * consumed by the epic-runner phases. Construction order and injected
 * dependencies match the pre-split layout in `epic-runner.js` so parity
 * tests continue to pass unchanged.
 *
 * Returned object:
 *   notify, checkpointer, notificationHook, blockerHandler, launcher,
 *   gitAdapter, commitAssertion, waveObserver, frictionEmitter,
 *   progressReporter, columnSync, syncColumn (closure wrapping columnSync.sync
 *   with error-journal logging).
 */

import { notify } from '../../../notify.js';
import { getRunners } from '../../config/runners.js';
import { createFrictionEmitter } from '../friction-emitter.js';
import { BlockerHandler } from './blocker-handler.js';
import { Checkpointer } from './checkpointer.js';
import { ColumnSync } from './column-sync.js';
import { buildDefaultGitAdapter, CommitAssertion } from './commit-assertion.js';
import { NotificationHook } from './notification-hook.js';
import { ProgressReporter } from './progress-reporter.js';
import { StoryLauncher } from './story-launcher.js';
import { WaveObserver } from './wave-observer.js';

export function createEpicRunnerCollaborators(ctx, { errorJournal } = {}) {
  const { provider, config, logger } = ctx;
  const { epicRunner } = getRunners(config);
  const journal = errorJournal ?? ctx.errorJournal;

  const notifyFn =
    ctx.notify ??
    ((ticketId, payload) =>
      notify(ticketId, payload, { orchestration: config, provider }));
  const checkpointer = new Checkpointer({ ctx });
  const notificationHook = new NotificationHook({ ctx });
  const blockerHandler = new BlockerHandler({
    ctx,
    notificationHook,
    errorJournal: journal,
  });
  const launcher = new StoryLauncher({ ctx });
  const gitAdapter =
    ctx.gitAdapter ?? buildDefaultGitAdapter({ cwd: ctx.cwd ?? process.cwd() });
  const commitAssertion =
    ctx.commitAssertion ?? new CommitAssertion({ ctx, gitAdapter, logger });
  const waveObserver = new WaveObserver({ ctx, commitAssertion });
  const frictionEmitter = createFrictionEmitter({ provider, logger });
  const progressReporter = new ProgressReporter({
    ctx,
    intervalSec: Number(epicRunner.progressReportIntervalSec ?? 0),
    frictionEmitter,
  });
  const columnSync = new ColumnSync({ ctx });

  const journalSuffix = () => (journal?.path ? ` (see ${journal.path})` : '');
  const syncColumn = async (id, labels) => {
    try {
      await columnSync.sync(id, labels);
    } catch (err) {
      logger.warn?.(
        `[EpicRunner] column sync failed for #${id}: ${err.message}${journalSuffix()}`,
      );
      await journal?.record({
        module: 'EpicRunner',
        op: `columnSync.sync(#${id})`,
        error: err,
        recovery: 'swallowed',
      });
    }
  };

  return {
    notify: notifyFn,
    checkpointer,
    notificationHook,
    blockerHandler,
    launcher,
    gitAdapter,
    commitAssertion,
    waveObserver,
    frictionEmitter,
    progressReporter,
    columnSync,
    syncColumn,
    journal,
  };
}
