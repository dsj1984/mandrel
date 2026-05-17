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
import { tempRootFrom } from '../../config/temp-paths.js';
import { createBus } from '../lifecycle/bus.js';
import { createLedgerWriter } from '../lifecycle/ledger-writer.js';
import { LabelTransitioner } from '../lifecycle/listeners/label-transitioner.js';
import { StructuredCommentPoster } from '../lifecycle/listeners/structured-comment-poster.js';
import { createTraceLogger } from '../lifecycle/trace-logger.js';
import {
  transitionTicketState,
  upsertStructuredComment,
} from '../ticketing.js';
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
  // Story #2239 — when the lifecycle bus is wired, the
  // StructuredCommentPoster listener owns the `wave-<n>-start` /
  // `wave-<n>-end` markers on the Epic ticket. The legacy wave
  // observer still runs (for commit-assertion reclassification) but
  // its comment side effect is suppressed so the two writers don't
  // double-post diverging bodies for the same marker.
  const waveObserver = new WaveObserver({
    ctx,
    commitAssertion,
    suppressComments: true,
  });
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

  // Lifecycle bus wiring (Story #2233 — snapshot + plan phase conversions).
  // The bus runs in parallel with the legacy code path: phases still mutate
  // runner state directly, but they also emit through the bus so the
  // NDJSON ledger and companion markdown reflect the same run. Later
  // Stories cut iterate-waves over and remove the legacy duplications.
  //
  // Construction is gated on `ctx.epicId` being a positive integer (which
  // `EpicRunnerContext.validate()` enforces, but tests that bypass the
  // context construction by feeding `runSnapshotPhase` a hand-rolled `{}`
  // never reach this code path — they pass `{}` as collaborators directly).
  // We construct unconditionally here so the production runner always has
  // the bus available; phases skip emits when no `bus` is on collaborators.
  const bus = ctx.bus ?? createBus();
  const tempRoot = tempRootFrom(config);
  const ledgerWriter =
    ctx.ledgerWriter ??
    createLedgerWriter({
      epicId: ctx.epicId,
      tempRoot,
    });
  ledgerWriter.register(bus);
  const traceLogger =
    ctx.traceLogger ??
    createTraceLogger({
      ledgerPath: ledgerWriter.ledgerPath,
      epicId: ctx.epicId,
    });
  traceLogger.register(bus);

  // Phase-scoped listener registration. Snapshot + plan phases use the
  // privileged ledger seam for canonical persistence; named listeners
  // here are reserved for downstream side effects (column sync,
  // progress reporter mirrors, etc.). The Story #2233 cutover wires
  // the canonical persistence only — additional snapshot/plan-specific
  // named listeners will be added in follow-up Stories as more code
  // paths migrate off the legacy runner state. Keeping the registration
  // block here (rather than inline in each phase) is the single seam
  // future contributors edit when adding listeners.
  registerSnapshotListeners({ bus, logger });
  registerPlanListeners({ bus, logger });
  registerIterateWavesListeners({
    bus,
    provider,
    epicId: ctx.epicId,
    logger,
  });

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
    bus,
    ledgerWriter,
    traceLogger,
  };
}

/**
 * Register snapshot-phase listeners on the bus. The LedgerWriter is
 * already wired via the privileged hook seam, so this function is the
 * seam for future named listeners that need to react to snapshot events
 * (e.g. story-dispatch precomputation, manifest mirrors). For Story
 * #2233 the named-listener slot is intentionally empty — the
 * verification surface is the on-disk ledger that the writer hook
 * persists. The function exists (and the logger ping fires) so the
 * registration site is easy to grep for ("registerSnapshotListeners")
 * when later Stories add real listeners.
 */
function registerSnapshotListeners({ bus, logger }) {
  if (!bus || typeof bus.on !== 'function') return;
  logger?.debug?.(
    '[lifecycle] snapshot listeners registered (writer-only; named slot reserved)',
  );
}

/**
 * Register plan-phase listeners on the bus. See
 * `registerSnapshotListeners` for the rationale; same pattern, same
 * deferred-listener policy.
 */
function registerPlanListeners({ bus, logger }) {
  if (!bus || typeof bus.on !== 'function') return;
  logger?.debug?.(
    '[lifecycle] plan listeners registered (writer-only; named slot reserved)',
  );
}

/**
 * Register iterate-waves listeners on the bus (Story #2239 Task #2242):
 * LabelTransitioner and StructuredCommentPoster. Each listener owns
 * exactly one side effect (label flips / structured-comment upserts)
 * and is idempotent on `(event, seqId)` per the listeners/README.md
 * contract.
 *
 * Listeners are constructed only when both `bus` and `provider` are
 * present so unit fixtures that hand a minimal collaborators bag
 * (`{}`) continue to operate without listeners.
 */
function registerIterateWavesListeners({ bus, provider, epicId, logger }) {
  if (!bus || typeof bus.on !== 'function') return;
  if (!provider || !Number.isInteger(epicId)) return;
  const labelTransitioner = new LabelTransitioner({
    provider,
    epicId,
    transitionTicketState,
    logger,
  });
  labelTransitioner.register(bus);
  const commentPoster = new StructuredCommentPoster({
    provider,
    epicId,
    upsertStructuredComment,
    logger,
  });
  commentPoster.register(bus);
  logger?.debug?.(
    '[lifecycle] iterate-waves listeners registered (label-transitioner, structured-comment-poster)',
  );
}
