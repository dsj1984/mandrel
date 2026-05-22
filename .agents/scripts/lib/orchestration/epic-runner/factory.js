/**
 * EpicRunner collaborator factory.
 *
 * `createEpicRunnerCollaborators(ctx)` returns the full collaborator bag
 * consumed by the epic-runner phases. Construction order and injected
 * dependencies match the pre-split layout in `epic-runner.js` so parity
 * tests continue to pass unchanged.
 *
 * Returned object:
 *   notify, epicRunStateStore, blockerHandler, launcher, gitAdapter,
 *   commitAssertion, waveObserver, progressReporter, journal, bus,
 *   plus the lifecycle listener instances.
 *
 * Story #2548 — Projects v2 Status column sync is owned by
 * `transitionTicketState` itself, so this factory no longer constructs
 * a `ColumnSync` or wires a `syncColumn` closure into the collaborator
 * bag. The iterate-waves phase relied on those mirror calls; with the
 * sync inlined into the state mutator, every label flip (Epic, Story,
 * Task) updates the board automatically.
 */

import { notify } from '../../../notify.js';
import { tempRootFrom } from '../../config/temp-paths.js';
import { appendEpicSignal } from '../../observability/signals-writer.js';
import * as epicRunStateStoreModule from '../epic-run-state-store.js';
import { createBus } from '../lifecycle/bus.js';
import { createLedgerWriter } from '../lifecycle/ledger-writer.js';
import { AcceptanceReconciler } from '../lifecycle/listeners/acceptance-reconciler.js';
import { AutomergeArmer } from '../lifecycle/listeners/automerge-armer.js';
import { AutomergePredicate } from '../lifecycle/listeners/automerge-predicate.js';
import { BlockerHandler as LifecycleBlockerHandler } from '../lifecycle/listeners/blocker-handler.js';
import { BranchCleaner } from '../lifecycle/listeners/branch-cleaner.js';
import { CheckpointPointerWriter } from '../lifecycle/listeners/checkpoint-pointer-writer.js';
import { Cleaner } from '../lifecycle/listeners/cleaner.js';
import { MergeWatcher } from '../lifecycle/listeners/merge-watcher.js';
import { Finalizer } from '../lifecycle/listeners/finalizer.js';
import { HeartbeatMonitor } from '../lifecycle/listeners/heartbeat-monitor.js';
import { InterventionRecorder } from '../lifecycle/listeners/intervention-recorder.js';
import { LabelTransitioner } from '../lifecycle/listeners/label-transitioner.js';
import { NotifyDispatcher } from '../lifecycle/listeners/notify-dispatcher.js';
import { ProgressReporter as LifecycleProgressReporter } from '../lifecycle/listeners/progress-reporter.js';
import { SignalsAppender } from '../lifecycle/listeners/signals-appender.js';
import { StructuredCommentPoster } from '../lifecycle/listeners/structured-comment-poster.js';
import { TimeoutWatchdog } from '../lifecycle/listeners/timeout-watchdog.js';
import { Watcher } from '../lifecycle/listeners/watcher.js';
import { createTraceLogger } from '../lifecycle/trace-logger.js';
import {
  transitionTicketState,
  upsertStructuredComment,
} from '../ticketing.js';
import { waitForEpicUnblock } from './blocker-wait.js';
import { buildDefaultGitAdapter, CommitAssertion } from './commit-assertion.js';
import { StoryLauncher } from './story-launcher.js';

export function createEpicRunnerCollaborators(ctx, { errorJournal } = {}) {
  const { provider, config, logger } = ctx;
  const journal = errorJournal ?? ctx.errorJournal;

  // Wrapper forwards caller `opts` into `notify()` so structured-comment
  // mirrors can pass `{ skipComment: true }` to suppress the GitHub comment
  // (the upsert already wrote it) while still firing the webhook.
  const notifyFn =
    ctx.notify ??
    ((ticketId, payload, opts = {}) =>
      notify(ticketId, payload, { orchestration: config, provider, ...opts }));
  // Story #2409 — the legacy class-based checkpoint surface is replaced
  // by the function-based `epic-run-state-store` module. The collaborator
  // slot exposes a bag of provider/epicId-pre-bound functions so
  // iterate-waves keeps its `store.initialize({ totalWaves,
  // concurrencyCap })` call shape unchanged. The legacy class file under
  // `./checkpointer.js` is removed in a later Story (#2423); nothing
  // imports it from this factory anymore.
  const epicRunStateStore = {
    initialize: (opts) =>
      epicRunStateStoreModule.initialize({
        provider,
        epicId: ctx.epicId,
        ...opts,
      }),
    read: () => epicRunStateStoreModule.read({ provider, epicId: ctx.epicId }),
    write: (state) =>
      epicRunStateStoreModule.write({ provider, epicId: ctx.epicId, state }),
    setPhase: (nextPhase) =>
      epicRunStateStoreModule.setPhase({
        provider,
        epicId: ctx.epicId,
        nextPhase,
      }),
    appendIntervention: (entry) =>
      epicRunStateStoreModule.appendIntervention({
        provider,
        epicId: ctx.epicId,
        entry,
      }),
  };
  // Story #2241 / Task #2246 — the legacy BlockerHandler (label flip +
  // friction comment + notify + wait loop) is replaced by:
  //   * the lifecycle BlockerHandler listener (classifies story.blocked
  //     and cascades to epic.blocked / emits epic.unblocked),
  //   * the existing LabelTransitioner / StructuredCommentPoster /
  //     NotifyDispatcher listeners (own the side effects),
  //   * the `waitForEpicUnblock` helper (owns the wait loop).
  // The collaborator bag exposes `blockerWait` as a thin closure so
  // iterate-waves can poll without re-importing the helper, and
  // `blockerHandler` is the lifecycle listener instance so iterate-waves
  // can call `emitUnblocked` after the operator resumes.
  const launcher = new StoryLauncher({ ctx });
  const gitAdapter =
    ctx.gitAdapter ?? buildDefaultGitAdapter({ cwd: ctx.cwd ?? process.cwd() });
  const commitAssertion =
    ctx.commitAssertion ?? new CommitAssertion({ ctx, gitAdapter, logger });
  // Epic #2646 Story C (Task #2694) — the legacy `WaveObserver` writer
  // was retired. The `StructuredCommentPoster` lifecycle listener now
  // owns the `wave-<n>-start` / `wave-<n>-end` markers (rich body
  // inherited from the observer, including commit-assertion `done →
  // failed` reclassification detail). The phase still owns
  // commit-assertion application — it runs the reclassification before
  // emitting `wave.end` so the listener sees the post-assertion
  // outcomes.
  // Epic #2646 Story C (Task #2699) — the polling `ProgressReporter`
  // class that used to be wired here was retired. The bus-driven
  // `lifecycle/listeners/progress-reporter.js` listener (registered
  // below as `lifecycleProgressReporter`) consumes
  // `story.dispatch.end` + `wave.end` and writes the same
  // `epic-run-progress` structured comment — event-driven instead of
  // tick-driven. `delivery.deliverRunner.progressReportIntervalSec` is
  // now an inert tuning knob; the lifecycle listener fires on every
  // bus event, not on a wall-clock cadence.

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

  // Story #2266 / Task #2268 — register the CheckpointPointerWriter
  // EARLY, before any downstream named listener subscribes to a
  // `*.end` event. The pointer write is the resume cursor; advancing
  // it before the rest of the named-listener chain runs means a throw
  // from a later listener still leaves the pointer at the most
  // recently completed phase boundary. The bus mediator runs named
  // listeners in registration order, so this `.register()` MUST
  // remain before `registerIterateWavesListeners` / the side-effect
  // trio below.
  const checkpointPointerWriter = registerCheckpointPointerWriter({
    bus,
    epicId: ctx.epicId,
    tempRoot,
    logger,
  });

  // Story #2314 — register the reliability observers (TimeoutWatchdog,
  // HeartbeatMonitor) as wildcard subscribers. Per the Epic's canonical
  // listener ordering, observers run AFTER the trace/ledger writers (so
  // the audit trail records the emit before the observer reacts) and
  // BEFORE the named mutators (so a timeout-driven `epic.blocked` emit
  // races no later-registered handler that might mutate runner state).
  //
  // Both observers are wildcard subscribers (`bus.on('*', …)`); the
  // `wildcard-observer-firewall` lint rule already guarantees neither
  // file imports a state-mutating module. Returns the constructed
  // instances so the runner (or tests) can introspect armed timers and
  // observation cursors; `null` for unit fixtures that hand a minimal
  // collaborators bag.
  const reliabilityObservers = registerReliabilityObservers({
    bus,
    config,
    logger,
  });

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
  const lifecycleProgressReporter = registerLifecycleSideEffectListeners({
    bus,
    epicId: ctx.epicId,
    notify: notifyFn,
    config,
    logger,
  });
  // Story #2410 / Task #2416 — register the InterventionRecorder
  // listener. Subscribes to `intervention.recorded` and persists the
  // payload to the `epic-run-state` comment via
  // `epic-run-state-store.appendIntervention`. The persisted
  // `manualInterventions` array is what the auto-merge predicate reads
  // to disqualify Epics that hit a manual recovery during delivery.
  const interventionRecorder = registerInterventionRecorder({
    bus,
    provider,
    epicId: ctx.epicId,
    logger,
  });
  // Story #2315 / Task #2322 — register the close-tail chain
  // (AcceptanceReconciler → Finalizer → …) AFTER the observer +
  // mutator listener stack and BEFORE the BlockerHandler.
  // AcceptanceReconciler subscribes to `epic.close.end` and may emit
  // `epic.blocked` on a gap; placing its registration ahead of
  // BlockerHandler ensures the blocker cascade listener is already on
  // the bus when the reconciler fires its failure path. Wiring the
  // AcceptanceReconciler here closes the High-2 finding from Epic
  // #2306 (the listener existed but was never instantiated by the
  // production factory).
  //
  // Story #2319 / Task #2328 — extends the close-tail chain with
  // `Finalizer`, subscribed to `acceptance.reconcile.ok`. Registering
  // Finalizer immediately after AcceptanceReconciler keeps the
  // close-tail event order deterministic (reconciler emits `.ok`,
  // finalizer reacts) and ahead of the watcher / armer / cleaner
  // listeners that future Stories will wire here.
  const {
    acceptanceReconciler,
    finalizer,
    watcher,
    automergePredicate,
    automergeArmer,
    branchCleaner,
    mergeWatcher,
    cleaner,
  } = registerCloseTailChain({
    bus,
    epicId: ctx.epicId,
    cwd: ctx.cwd,
    provider,
    config,
    logger,
    tempRoot,
    checkpointer: epicRunStateStore,
  });
  // Story #2241 / Task #2246 — register the lifecycle BlockerHandler
  // listener. The instance is exposed on the collaborator bag so
  // iterate-waves can call `emitUnblocked()` after the wait loop
  // observes the operator's resume.
  const blockerHandler = registerBlockerHandler({
    bus,
    epicId: ctx.epicId,
    logger,
  });
  // Pre-bound wait-for-resume closure — pulls labels via the provider
  // and journals failures into the shared `journal` so iterate-waves
  // does not need to know about pollUntil internals.
  const blockerWait = (_info, signal) =>
    waitForEpicUnblock({
      epicId: ctx.epicId,
      labelFetcher: async (id) => (await provider.getTicket(id)).labels ?? [],
      pollIntervalMs: 30_000,
      logger,
      errorJournal: journal,
      signal,
    });

  return {
    notify: notifyFn,
    epicRunStateStore,
    blockerHandler,
    blockerWait,
    launcher,
    gitAdapter,
    commitAssertion,
    journal,
    bus,
    ledgerWriter,
    traceLogger,
    lifecycleProgressReporter,
    interventionRecorder,
    checkpointPointerWriter,
    reliabilityObservers,
    acceptanceReconciler,
    finalizer,
    watcher,
    automergePredicate,
    automergeArmer,
    branchCleaner,
    mergeWatcher,
    cleaner,
  };
}

/**
 * Construct and register the reliability observers
 * (Story #2314): `TimeoutWatchdog` and `HeartbeatMonitor`. Both
 * subscribers attach as wildcard observers (`bus.on('*', …)`) so the
 * firewall lint rule's coverage of every observer remains intact.
 *
 * Budgets and warn thresholds are resolved from
 * `config.delivery.lifecycle.timeouts` and
 * `config.delivery.lifecycle.heartbeatWarnSeconds` respectively. The
 * lifecycle schema gate (see `config-settings-schema.js`'s
 * `LIFECYCLE_SCHEMA`) validates these at startup; this function is
 * defensive about a missing block so unit fixtures with a minimal
 * `config` still construct the observers cleanly.
 *
 * Returns an object exposing the constructed instances so tests can
 * introspect armed timers / observation cursors; returns `null` for
 * unit fixtures that hand an unbusable collaborators bag.
 */
export function registerReliabilityObservers({ bus, config, logger }) {
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    return null;
  }
  const lifecycle = config?.delivery?.lifecycle ?? {};
  const timeouts =
    lifecycle.timeouts && typeof lifecycle.timeouts === 'object'
      ? lifecycle.timeouts
      : {};
  const timeoutWatchdog = new TimeoutWatchdog({ timeouts, logger });
  timeoutWatchdog.register(bus);
  // HeartbeatMonitor only consumes a positive-integer warn threshold.
  // Defer to the listener's documented default when no override is
  // configured — the constructor enforces the positivity guard so a
  // missing or invalid value never produces a non-functional monitor.
  const heartbeatOpts = { logger };
  if (Number.isInteger(lifecycle.heartbeatWarnSeconds)) {
    heartbeatOpts.warnSeconds = lifecycle.heartbeatWarnSeconds;
  }
  const heartbeatMonitor = new HeartbeatMonitor(heartbeatOpts);
  heartbeatMonitor.register(bus);
  logger?.debug?.(
    '[lifecycle] reliability observers registered (timeout-watchdog, heartbeat-monitor wildcards)',
  );
  return { timeoutWatchdog, heartbeatMonitor };
}

/**
 * Construct and register the close-tail listener chain (Story #2315 /
 * Task #2322; extended by Story #2319 / Task #2328, Story #2327 /
 * Task #2331, Story #2333 / Task #2337, and Story #2336 / Task #2341).
 * Registers, in canonical close-tail order:
 *
 *   1. `AcceptanceReconciler` — subscribes to `epic.close.end`; emits
 *      `acceptance.reconcile.{ok,waived,skipped,failed}` (and
 *      `epic.blocked` on a gap). Story #2893 split `.waived` out of
 *      `.skipped` so the Finalizer can route waived Epics to PR
 *      creation while empty-spec Epics still terminate without a PR.
 *   2. `Finalizer` — subscribes to `acceptance.reconcile.{ok,waived}`;
 *      emits `epic.finalize.{start,end}` and `pr.created`. Wired here AFTER
 *      AcceptanceReconciler so the bus invokes them in chain order;
 *      sequential-await semantics mean reconciler outcomes settle
 *      into the ledger before finalize side effects run.
 *   3. `Watcher` — subscribes to `pr.created`; resolves the required
 *      check name set at runtime via `gh pr checks` and emits
 *      `epic.watch.{start,end}`. Registered AFTER Finalizer so the bus
 *      delivers the freshly-emitted `pr.created` to Watcher in chain
 *      order.
 *   4. `AutomergePredicate` — subscribes to `epic.watch.end`; emits
 *      `epic.merge.{ready,blocked}`. Wired AFTER Watcher so the bus
 *      delivers the freshly-emitted `epic.watch.end` in chain order,
 *      and BEFORE the AutomergeArmer which subscribes to
 *      `epic.merge.ready`. The listener at
 *      `lib/orchestration/lifecycle/listeners/automerge-predicate.js`
 *      now owns `evaluateAutoMergePredicate` directly; the legacy
 *      `lib/orchestration/automerge-predicate.js` module was deleted
 *      in Story #2415 (Epic #2307).
 *   5. `AutomergeArmer` — subscribes to `epic.merge.ready` (and ONLY
 *      that event); probes `gh pr view --json autoMergeRequest` and
 *      issues `gh pr merge --auto --squash --delete-branch` exactly
 *      once per PR. Emits `epic.merge.armed`. Wired AFTER
 *      AutomergePredicate so the bus delivers the freshly-emitted
 *      `epic.merge.ready` in chain order, and BEFORE the Cleaner
 *      which subscribes to `epic.merge.armed`. This is the runtime
 *      closure of High-1 from the Epic #2172 review: auto-merge can
 *      no longer fire before the predicate's verdict.
 *   6. `BranchCleaner` — subscribes to `epic.cleanup.start` (and ONLY
 *      that event). Reads the `epic-run-state` checkpoint, then reaps
 *      every `story-<id>` + `epic/<id>` local branch, removes attached
 *      worktrees (with a Windows file-lock fallback), prunes stale
 *      `<remote>/...` tracking refs, and deletes the `wt-branch`
 *      scratch ref. Registered immediately before Cleaner so the
 *      subscription is live when Cleaner emits `epic.cleanup.start`
 *      inside its `epic.merge.armed` handler. The slot stays `null`
 *      for unit fixtures that omit the checkpointer.
 *   7. `Cleaner` — subscribes to `epic.merge.armed` (and ONLY that
 *      event). Archives `temp/epic-<id>/` under
 *      `temp/archive/epic-<id>-<ts>/` and emits the terminal sequence
 *      `epic.cleanup.start → epic.cleanup.end → epic.complete`.
 *      Registered LAST in the close-tail chain so every observer and
 *      mutator already wired on the bus sees the terminal events.
 *      Requires a non-empty `tempRoot`; the slot stays `null` for unit
 *      fixtures that omit it.
 *
 * The "close-tail chain" name is deliberately umbrella-shaped: future
 * close-time listeners register here in the same canonical slot —
 * after observers and mutators, before BlockerHandler.
 *
 * Returns the constructed listener bag so the collaborator bag can
 * expose each to tests. Returns the bag with `null` slots when the bus
 * or epicId is unusable so unit fixtures continue to operate without a
 * live bus.
 */
function registerCloseTailChain({
  bus,
  epicId,
  cwd,
  provider,
  config,
  logger,
  tempRoot,
  checkpointer,
}) {
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    return {
      acceptanceReconciler: null,
      finalizer: null,
      watcher: null,
      automergePredicate: null,
      automergeArmer: null,
      branchCleaner: null,
      mergeWatcher: null,
      cleaner: null,
    };
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    return {
      acceptanceReconciler: null,
      finalizer: null,
      watcher: null,
      automergePredicate: null,
      automergeArmer: null,
      branchCleaner: null,
      mergeWatcher: null,
      cleaner: null,
    };
  }
  const acceptanceReconciler = new AcceptanceReconciler({
    bus,
    epicId,
    cwd: cwd ?? process.cwd(),
    provider: provider ?? null,
    config: config ?? null,
    logger,
  });
  acceptanceReconciler.register();
  const finalizer = new Finalizer({
    bus,
    epicId,
    cwd: cwd ?? process.cwd(),
    logger,
  });
  finalizer.register();
  const watcher = new Watcher({
    bus,
    cwd: cwd ?? process.cwd(),
    logger,
  });
  watcher.register();
  // AutomergePredicate requires a truthy `provider` — its constructor
  // throws otherwise. The factory's collaborator pipeline always
  // supplies a provider in production (EpicRunnerContext enforces it),
  // but unit fixtures occasionally pass `null`. Guard so the rest of
  // the close-tail chain still wires cleanly in those cases.
  let automergePredicate = null;
  if (provider) {
    automergePredicate = new AutomergePredicate({
      bus,
      epicId,
      provider,
      logger,
    });
    automergePredicate.register();
  }
  // AutomergeArmer subscribes to `epic.merge.ready` (and ONLY that
  // event). Registered AFTER AutomergePredicate so the bus delivers
  // the freshly-emitted `epic.merge.ready` in chain order. This is
  // the sole production code path authorized to call `gh pr merge`
  // (the merge-lockout lint rule enforces the allow-list).
  const automergeArmer = new AutomergeArmer({
    bus,
    cwd: cwd ?? process.cwd(),
    logger,
  });
  automergeArmer.register();
  // Story #2398 — BranchCleaner subscribes to `epic.cleanup.start` (and
  // ONLY that event). Registered immediately before Cleaner so the
  // subscription is live by the time Cleaner emits `epic.cleanup.start`
  // inside its `epic.merge.armed` handler. The bus runs listeners
  // awaited and in registration order; BranchCleaner therefore reaps
  // every `story-<id>` + `epic/<id>` branch (plus attached worktrees,
  // stale tracking refs, and the `wt-branch` scratch ref) BEFORE
  // Cleaner moves `temp/epic-<id>/` under `temp/archive/`. The
  // listener requires a `checkpointer` (to read `epic-run-state` from
  // the Epic Issue) and a `cwd` that points at the main checkout; the
  // slot stays `null` for unit fixtures that omit either.
  let branchCleaner = null;
  if (checkpointer && typeof checkpointer.read === 'function') {
    branchCleaner = new BranchCleaner({
      bus,
      epicId,
      checkpointer,
      cwd: cwd ?? process.cwd(),
      logger,
    });
    branchCleaner.register();
  }
  // Story #2896 / Task #2907 — MergeWatcher subscribes to
  // `epic.merge.armed` (and ONLY that event). Registered between
  // AutomergeArmer and Cleaner so the bus delivers the freshly-emitted
  // `epic.merge.armed` in chain order, the watcher polls `gh pr view`
  // until `mergeCommit` is non-null, and emits `epic.merge.confirmed`
  // which Cleaner now subscribes to. The slot stays `null` for unit
  // fixtures that omit `tempRoot`.
  let mergeWatcher = null;
  if (typeof tempRoot === 'string' && tempRoot.length > 0) {
    const mergeWatchConfig = config?.delivery?.mergeWatch ?? {};
    mergeWatcher = new MergeWatcher({
      bus,
      epicId,
      tempRoot,
      cwd: cwd ?? process.cwd(),
      intervalSeconds: mergeWatchConfig.intervalSeconds,
      maxBudgetSeconds: mergeWatchConfig.maxBudgetSeconds,
      logger,
    });
    mergeWatcher.register();
  }
  // Story #2338 / Task #2345 — Cleaner archives temp/epic-<id>/ and
  // emits the terminal sequence. Story #2896 / Task #2912 rebound
  // this listener from `epic.merge.armed` to `epic.merge.confirmed`
  // so the Epic only transitions to its terminal state after the
  // MergeWatcher has observed the PR actually merging. Registered
  // LAST in the close-tail chain so every observer / mutator already
  // on the bus sees the terminal `epic.cleanup.start →
  // epic.cleanup.end → epic.complete` emit sequence. The listener
  // requires a non-empty `tempRoot`; production always threads the
  // resolved value through (see `tempRootFrom` in the collaborator
  // factory), but the slot stays `null` for unit fixtures that omit
  // it so the rest of the chain wires cleanly.
  let cleaner = null;
  if (typeof tempRoot === 'string' && tempRoot.length > 0) {
    cleaner = new Cleaner({
      bus,
      epicId,
      tempRoot,
      logger,
    });
    cleaner.register();
  }
  logger?.debug?.(
    '[lifecycle] close-tail chain registered (acceptance-reconciler → epic.close.end; finalizer → acceptance.reconcile.{ok,waived}; watcher → pr.created; automerge-predicate → epic.watch.end; automerge-armer → epic.merge.ready; branch-cleaner → epic.cleanup.start; merge-watcher → epic.merge.armed; cleaner → epic.merge.confirmed)',
  );
  return {
    acceptanceReconciler,
    finalizer,
    watcher,
    automergePredicate,
    automergeArmer,
    branchCleaner,
    mergeWatcher,
    cleaner,
  };
}

/**
 * Construct and register the CheckpointPointerWriter listener
 * (Story #2266 / Task #2268). The writer subscribes to every `*.end`
 * event, persists `{ lastCompletedSeqId, phase }` to
 * `temp/epic-<id>/checkpoint.json`, and self-emits `checkpoint.written`
 * exactly once per observed `*.end`. Returns the instance so tests can
 * introspect the pointer path; returns `null` for unit fixtures that
 * supply an unbusable collaborators bag.
 */
function registerCheckpointPointerWriter({ bus, epicId, tempRoot, logger }) {
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    return null;
  }
  if (!Number.isInteger(epicId) || epicId < 1) return null;
  if (typeof tempRoot !== 'string' || tempRoot.length === 0) return null;
  const writer = new CheckpointPointerWriter({
    bus,
    epicId,
    tempRoot,
    logger,
  });
  writer.register();
  logger?.debug?.(
    '[lifecycle] checkpoint-pointer-writer registered (every *.end → temp/epic-<id>/checkpoint.json)',
  );
  return writer;
}

/**
 * Construct and register the lifecycle BlockerHandler listener
 * (Story #2241 / Task #2246). The listener owns story.blocked →
 * epic.blocked cascade plus the matching epic.unblocked emit. Returns
 * the instance so iterate-waves can drive `emitUnblocked()` after the
 * wait loop observes the operator's resume. Returns `null` for unit
 * fixtures that supply an unbusable collaborators bag.
 */
function registerBlockerHandler({ bus, epicId, logger }) {
  if (!bus || typeof bus.on !== 'function') return null;
  if (!Number.isInteger(epicId) || epicId < 1) return null;
  const listener = new LifecycleBlockerHandler({ bus, epicId, logger });
  listener.register();
  logger?.debug?.(
    '[lifecycle] blocker-handler listener registered (story.blocked → epic.blocked / .unblocked)',
  );
  return listener;
}

/**
 * Construct and register the InterventionRecorder listener
 * (Story #2410 / Task #2416). Subscribes to `intervention.recorded` and
 * persists the payload to the epic-run-state structured comment via
 * `epic-run-state-store.appendIntervention`. Returns the constructed
 * instance so tests can introspect the seqId guard; returns `null` for
 * unit fixtures that supply an unbusable collaborators bag, an absent
 * provider, or a non-numeric epicId.
 */
export function registerInterventionRecorder({
  bus,
  provider,
  epicId,
  logger,
}) {
  if (!bus || typeof bus.on !== 'function') return null;
  if (!provider) return null;
  if (!Number.isInteger(epicId) || epicId < 1) return null;
  const listener = new InterventionRecorder({
    provider,
    epicId,
    logger,
  });
  listener.register(bus);
  logger?.debug?.(
    '[lifecycle] intervention-recorder listener registered (intervention.recorded → epic-run-state-store.appendIntervention)',
  );
  return listener;
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
/**
 * Register the side-effect listener trio for the iterate-waves phase
 * (Story #2239 Task #2244): LifecycleProgressReporter, SignalsAppender,
 * NotifyDispatcher. Returns the constructed
 * `LifecycleProgressReporter` so the runner (or tests) can read its
 * snapshot without re-scanning the ledger.
 *
 * Listeners are constructed only when both `bus` and a usable `notify`
 * function are present. The signals-writer and notify exports are
 * imported up-top — no late wiring beyond the bus surface.
 */
function registerLifecycleSideEffectListeners({
  bus,
  epicId,
  notify: notifyFn,
  config,
  logger,
}) {
  if (!bus || typeof bus.on !== 'function') return null;
  if (!Number.isInteger(epicId)) return null;
  const reporter = new LifecycleProgressReporter({ logger });
  reporter.register(bus);
  const signalsAppender = new SignalsAppender({
    epicId,
    appendEpicSignal,
    config,
    logger,
  });
  signalsAppender.register(bus);
  if (typeof notifyFn === 'function') {
    const notifyDispatcher = new NotifyDispatcher({
      epicId,
      notify: notifyFn,
      appendEpicSignal,
      config,
      logger,
    });
    notifyDispatcher.register(bus);
  }
  logger?.debug?.(
    '[lifecycle] side-effect listeners registered (progress-reporter, signals-appender, notify-dispatcher)',
  );
  return reporter;
}

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
