/**
 * EpicRunner collaborator factory.
 *
 * `createEpicRunnerCollaborators(ctx)` returns the full collaborator bag
 * consumed by the epic-runner phases. Construction order and injected
 * dependencies match the pre-split layout in `epic-runner.js` so parity
 * tests continue to pass unchanged.
 *
 * Returned object:
 *   notify, checkpointer, blockerHandler, launcher, gitAdapter,
 *   commitAssertion, waveObserver, progressReporter, columnSync,
 *   syncColumn (closure wrapping columnSync.sync with error-journal
 *   logging).
 */

import { notify } from '../../../notify.js';
import { getRunners } from '../../config/runners.js';
import { BlockerHandler } from './blocker-handler.js';
import { Checkpointer } from './checkpointer.js';
import { ColumnSync } from './column-sync.js';
import { buildDefaultGitAdapter, CommitAssertion } from './commit-assertion.js';
import { ProgressReporter } from './progress-reporter.js';
import { StoryLauncher } from './story-launcher.js';
import { WaveObserver } from './wave-observer.js';

export function createEpicRunnerCollaborators(ctx, { errorJournal } = {}) {
  const { provider, config, logger } = ctx;
  const { deliverRunner } = getRunners(config);
  const journal = errorJournal ?? ctx.errorJournal;

  // Wrapper forwards caller `opts` into `notify()` so structured-comment
  // mirrors can pass `{ skipComment: true }` to suppress the GitHub comment
  // (the upsert already wrote it) while still firing the webhook.
  const notifyFn =
    ctx.notify ??
    ((ticketId, payload, opts = {}) =>
      notify(ticketId, payload, { orchestration: config, provider, ...opts }));
  const checkpointer = new Checkpointer({ ctx });
  const blockerHandler = new BlockerHandler({
    ctx,
    notify: notifyFn,
    errorJournal: journal,
  });
  const launcher = new StoryLauncher({ ctx });
  const gitAdapter =
    ctx.gitAdapter ?? buildDefaultGitAdapter({ cwd: ctx.cwd ?? process.cwd() });
  const commitAssertion =
    ctx.commitAssertion ?? new CommitAssertion({ ctx, gitAdapter, logger });
  const waveObserver = new WaveObserver({ ctx, commitAssertion });
  const resolvedIntervalSec = Number(
    deliverRunner.progressReportIntervalSec ?? 0,
  );
  const userInterval =
    config?.delivery?.deliverRunner?.progressReportIntervalSec ??
    config?.deliverRunner?.progressReportIntervalSec ??
    config?.orchestration?.runners?.deliverRunner?.progressReportIntervalSec;
  logger?.info?.(
    `[ProgressReporter] interval=${resolvedIntervalSec}s source=${userInterval == null ? 'default' : 'config'}`,
  );
  const progressReporter = new ProgressReporter({
    provider,
    epicId: ctx.epicId,
    intervalSec: resolvedIntervalSec,
    logger,
    concurrency: ctx.concurrency?.progressReporter,
    cwd: ctx.cwd,
    config,
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
    blockerHandler,
    launcher,
    gitAdapter,
    commitAssertion,
    waveObserver,
    progressReporter,
    columnSync,
    syncColumn,
    journal,
  };
}
