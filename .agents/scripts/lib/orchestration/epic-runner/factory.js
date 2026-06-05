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
 *
 * Story #3633 — The imperative `registerX` helpers are replaced by a
 * declarative `LISTENER_REGISTRY` and a generic `wireListeners` driver.
 * The canonical close-tail ordering (slot numbers) is now data, not prose
 * comments. Adding a listener is an array entry; the driver constructs in
 * slot order, evaluates `requires`, calls `build`, calls `register`, and
 * returns a name→instance map that `createEpicRunnerCollaborators` spreads
 * into the collaborator bag.
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
import { Finalizer } from '../lifecycle/listeners/finalizer.js';
import { HeartbeatMonitor } from '../lifecycle/listeners/heartbeat-monitor.js';
import { InterventionRecorder } from '../lifecycle/listeners/intervention-recorder.js';
import { LabelTransitioner } from '../lifecycle/listeners/label-transitioner.js';
import { MergeWatcher } from '../lifecycle/listeners/merge-watcher.js';
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

// ---------------------------------------------------------------------------
// Precondition helpers used in `requires` predicates of LISTENER_REGISTRY.
// ---------------------------------------------------------------------------

/** Returns true when `bus` exposes the required `on()` and `emit()` methods. */
function busOk(bus) {
  return (
    bus != null &&
    typeof bus.on === 'function' &&
    typeof bus.emit === 'function'
  );
}

/** Returns true when `n` is a positive integer (valid epicId). */
function intOk(n) {
  return Number.isInteger(n) && n >= 1;
}

/** Returns true when `s` is a non-empty string (valid tempRoot / cwd). */
function strOk(s) {
  return typeof s === 'string' && s.length > 0;
}

// ---------------------------------------------------------------------------
// Listener slot constants — canonical ordering that was previously encoded as
// prose comments (factory.js:159-167, 230-265, 497-572). Each integer is the
// relative position within the bus subscriber queue. Observers run before
// mutators, close-tail runs after mutators, BlockerHandler is last.
// ---------------------------------------------------------------------------
const SLOT = {
  CHECKPOINT_POINTER_WRITER: 10, // EARLY — advance resume cursor before side effects
  TIMEOUT_WATCHDOG: 20, // wildcard observer — after trace/ledger, before mutators
  HEARTBEAT_MONITOR: 21, // wildcard observer — paired with TimeoutWatchdog
  LABEL_TRANSITIONER: 40, // iterate-waves mutator
  STRUCTURED_COMMENT_POSTER: 41, // iterate-waves mutator
  LIFECYCLE_PROGRESS_REPORTER: 50, // side-effect trio
  SIGNALS_APPENDER: 51,
  NOTIFY_DISPATCHER: 52,
  INTERVENTION_RECORDER: 60,
  // Close-tail chain:
  //   AcceptanceReconciler < Finalizer < Watcher < AutomergePredicate
  //   < AutomergeArmer < BranchCleaner < MergeWatcher < Cleaner
  ACCEPTANCE_RECONCILER: 70,
  FINALIZER: 71,
  WATCHER: 72,
  AUTOMERGE_PREDICATE: 73,
  AUTOMERGE_ARMER: 74,
  BRANCH_CLEANER: 75,
  MERGE_WATCHER: 76,
  CLEANER: 77,
  BLOCKER_HANDLER: 80, // LAST — after the full close-tail chain
};

// ---------------------------------------------------------------------------
// Declarative listener registry.
//
// Each entry describes one lifecycle listener:
//   name     — key in the collaborator bag
//   slot     — integer ordering (see SLOT above); driver sorts by this
//   requires — predicate(shared) → boolean; listener skipped when false,
//              collaborator bag slot set to null
//   build    — factory(shared) → instance (must NOT call .register())
//   register — (instance, bus) → void; defaults to instance.register(bus)
//
// "shared" is the pre-built non-listener context bag passed by
// `createEpicRunnerCollaborators` into `wireListeners`.
// ---------------------------------------------------------------------------
const LISTENER_REGISTRY = [
  {
    name: 'checkpointPointerWriter',
    slot: SLOT.CHECKPOINT_POINTER_WRITER,
    // Story #2266 / Task #2268 — register EARLY so the pointer write
    // advances the resume cursor before any later handler reacts.
    requires: (shared) =>
      busOk(shared.bus) && intOk(shared.epicId) && strOk(shared.tempRoot),
    build: (shared) =>
      new CheckpointPointerWriter({
        bus: shared.bus,
        epicId: shared.epicId,
        tempRoot: shared.tempRoot,
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'timeoutWatchdog',
    slot: SLOT.TIMEOUT_WATCHDOG,
    // Story #2314 — wildcard observer; runs after trace/ledger writers,
    // before named mutators.
    requires: (shared) => busOk(shared.bus),
    build: (shared) => {
      const lifecycle = shared.config?.delivery?.lifecycle ?? {};
      const timeouts =
        lifecycle.timeouts && typeof lifecycle.timeouts === 'object'
          ? lifecycle.timeouts
          : {};
      return new TimeoutWatchdog({ timeouts, logger: shared.logger });
    },
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'heartbeatMonitor',
    slot: SLOT.HEARTBEAT_MONITOR,
    // Story #2314 — wildcard observer paired with TimeoutWatchdog.
    requires: (shared) => busOk(shared.bus),
    build: (shared) => {
      const lifecycle = shared.config?.delivery?.lifecycle ?? {};
      const opts = { logger: shared.logger };
      if (Number.isInteger(lifecycle.heartbeatWarnSeconds)) {
        opts.warnSeconds = lifecycle.heartbeatWarnSeconds;
      }
      return new HeartbeatMonitor(opts);
    },
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'labelTransitioner',
    slot: SLOT.LABEL_TRANSITIONER,
    // Story #2239 Task #2242 — iterate-waves label mutator.
    requires: (shared) =>
      busOk(shared.bus) && !!shared.provider && intOk(shared.epicId),
    build: (shared) =>
      new LabelTransitioner({
        provider: shared.provider,
        epicId: shared.epicId,
        transitionTicketState,
        logger: shared.logger,
      }),
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'structuredCommentPoster',
    slot: SLOT.STRUCTURED_COMMENT_POSTER,
    // Story #2239 Task #2244 — iterate-waves structured-comment mutator.
    requires: (shared) =>
      busOk(shared.bus) && !!shared.provider && intOk(shared.epicId),
    build: (shared) =>
      new StructuredCommentPoster({
        provider: shared.provider,
        epicId: shared.epicId,
        upsertStructuredComment,
        logger: shared.logger,
      }),
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'lifecycleProgressReporter',
    slot: SLOT.LIFECYCLE_PROGRESS_REPORTER,
    // Story #2239 Task #2244 — side-effect trio, progress reporter.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) => new LifecycleProgressReporter({ logger: shared.logger }),
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'signalsAppender',
    slot: SLOT.SIGNALS_APPENDER,
    // Story #2239 Task #2244 — side-effect trio, signals appender.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) =>
      new SignalsAppender({
        epicId: shared.epicId,
        appendEpicSignal,
        config: shared.config,
        logger: shared.logger,
      }),
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'notifyDispatcher',
    slot: SLOT.NOTIFY_DISPATCHER,
    // Story #2239 Task #2244 — side-effect trio, notify dispatcher.
    // Skipped when no notify function is available.
    requires: (shared) =>
      busOk(shared.bus) &&
      intOk(shared.epicId) &&
      typeof shared.notify === 'function',
    build: (shared) =>
      new NotifyDispatcher({
        epicId: shared.epicId,
        notify: shared.notify,
        appendEpicSignal,
        config: shared.config,
        logger: shared.logger,
      }),
    register: (instance, bus) => instance.register(bus),
  },
  {
    name: 'interventionRecorder',
    slot: SLOT.INTERVENTION_RECORDER,
    // Story #2410 / Task #2416 — subscribes to `intervention.recorded`.
    requires: (shared) =>
      busOk(shared.bus) && !!shared.provider && intOk(shared.epicId),
    build: (shared) =>
      new InterventionRecorder({
        provider: shared.provider,
        epicId: shared.epicId,
        logger: shared.logger,
      }),
    register: (instance, bus) => instance.register(bus),
  },
  // ---- Close-tail chain (Story #2315 and extensions) ---------------------
  {
    name: 'acceptanceReconciler',
    slot: SLOT.ACCEPTANCE_RECONCILER,
    // Story #2315 / Task #2322 — subscribes to `epic.close.end`.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) =>
      new AcceptanceReconciler({
        bus: shared.bus,
        epicId: shared.epicId,
        cwd: shared.cwd ?? process.cwd(),
        provider: shared.provider ?? null,
        config: shared.config ?? null,
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'finalizer',
    slot: SLOT.FINALIZER,
    // Story #2319 / Task #2328 — subscribes to `acceptance.reconcile.{ok,waived}`.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) =>
      new Finalizer({
        bus: shared.bus,
        epicId: shared.epicId,
        cwd: shared.cwd ?? process.cwd(),
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'watcher',
    slot: SLOT.WATCHER,
    // Story #2327 / Task #2331 — subscribes to `pr.created`.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) =>
      new Watcher({
        bus: shared.bus,
        cwd: shared.cwd ?? process.cwd(),
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'automergePredicate',
    slot: SLOT.AUTOMERGE_PREDICATE,
    // Story #2333 / Task #2337 — subscribes to `epic.watch.end`.
    // AutomergePredicate requires a truthy `provider`; its constructor
    // throws otherwise. Guard so the rest of the chain wires cleanly in
    // unit fixtures that omit provider.
    requires: (shared) =>
      busOk(shared.bus) && intOk(shared.epicId) && !!shared.provider,
    build: (shared) =>
      new AutomergePredicate({
        bus: shared.bus,
        epicId: shared.epicId,
        provider: shared.provider,
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'automergeArmer',
    slot: SLOT.AUTOMERGE_ARMER,
    // Story #2336 / Task #2341 — subscribes to `epic.merge.ready` ONLY.
    // Registered after AutomergePredicate so the predicate's verdict is
    // the sole gate before the arm.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) =>
      new AutomergeArmer({
        bus: shared.bus,
        cwd: shared.cwd ?? process.cwd(),
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'branchCleaner',
    slot: SLOT.BRANCH_CLEANER,
    // Story #2398 — subscribes to `epic.cleanup.start`. Requires a
    // checkpointer (to read epic-run-state) and a main-checkout cwd.
    // Registered before Cleaner so the subscription is live when Cleaner
    // emits `epic.cleanup.start` inside its `epic.merge.confirmed` handler.
    requires: (shared) =>
      busOk(shared.bus) &&
      intOk(shared.epicId) &&
      !!shared.checkpointer &&
      typeof shared.checkpointer.read === 'function',
    build: (shared) =>
      new BranchCleaner({
        bus: shared.bus,
        epicId: shared.epicId,
        checkpointer: shared.checkpointer,
        cwd: shared.cwd ?? process.cwd(),
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'mergeWatcher',
    slot: SLOT.MERGE_WATCHER,
    // Story #2896 / Task #2907 — subscribes to `epic.merge.armed`.
    // Registered between AutomergeArmer and Cleaner; the slot stays null
    // for unit fixtures that omit tempRoot.
    requires: (shared) =>
      busOk(shared.bus) && intOk(shared.epicId) && strOk(shared.tempRoot),
    build: (shared) => {
      const mergeWatchConfig = shared.config?.delivery?.mergeWatch ?? {};
      return new MergeWatcher({
        bus: shared.bus,
        epicId: shared.epicId,
        tempRoot: shared.tempRoot,
        cwd: shared.cwd ?? process.cwd(),
        intervalSeconds: mergeWatchConfig.intervalSeconds,
        maxBudgetSeconds: mergeWatchConfig.maxBudgetSeconds,
        logger: shared.logger,
      });
    },
    register: (instance) => instance.register(),
  },
  {
    name: 'cleaner',
    slot: SLOT.CLEANER,
    // Story #2338 / Task #2345 — subscribes to `epic.merge.confirmed`.
    // Registered LAST in the close-tail chain so every observer / mutator
    // already on the bus sees the terminal event sequence. The slot stays
    // null for unit fixtures that omit tempRoot.
    requires: (shared) =>
      busOk(shared.bus) && intOk(shared.epicId) && strOk(shared.tempRoot),
    build: (shared) =>
      new Cleaner({
        bus: shared.bus,
        epicId: shared.epicId,
        tempRoot: shared.tempRoot,
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
  {
    name: 'blockerHandler',
    slot: SLOT.BLOCKER_HANDLER,
    // Story #2241 / Task #2246 — registered AFTER the close-tail chain so
    // iterate-waves can call `emitUnblocked()` after the wait loop observes
    // the operator's resume.
    requires: (shared) => busOk(shared.bus) && intOk(shared.epicId),
    build: (shared) =>
      new LifecycleBlockerHandler({
        bus: shared.bus,
        epicId: shared.epicId,
        logger: shared.logger,
      }),
    register: (instance) => instance.register(),
  },
];

// ---------------------------------------------------------------------------
// wireListeners — generic driver for LISTENER_REGISTRY.
//
// Sorts entries by slot, evaluates `requires(shared)`, constructs via
// `build(shared)`, calls `entry.register(instance, bus)`, and returns a
// name→instance map. Entries whose `requires` returns false produce a null
// slot so the collaborator-bag key exists and downstream code checking
// `collaborators.X === null` continues to work.
// ---------------------------------------------------------------------------

/**
 * Wire all listeners from the registry onto the bus.
 *
 * @param {object} bus      - The lifecycle bus.
 * @param {object} shared   - Pre-built non-listener context bag.
 * @param {Array}  registry - Descriptor array (defaults to LISTENER_REGISTRY).
 * @returns {Record<string, object|null>} name→instance map.
 */
function wireListeners(bus, shared, registry = LISTENER_REGISTRY) {
  const sorted = [...registry].sort((a, b) => a.slot - b.slot);
  const result = {};
  for (const entry of sorted) {
    if (!entry.requires(shared)) {
      result[entry.name] = null;
      continue;
    }
    const instance = entry.build(shared);
    entry.register(instance, bus);
    result[entry.name] = instance;
  }
  return result;
}

export function createEpicRunnerCollaborators(ctx, { errorJournal } = {}) {
  const { provider, config, logger } = ctx;
  const journal = errorJournal ?? ctx.errorJournal;

  // Wrapper forwards caller `opts` into `notify()` so structured-comment
  // mirrors can pass `{ skipComment: true }` to suppress the GitHub comment
  // (the upsert already wrote it) while still firing the webhook.
  const notifyFn =
    ctx.notify ??
    ((ticketId, payload, opts = {}) =>
      notify(ticketId, payload, { config, provider, ...opts }));
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

  // Lifecycle bus wiring. After the Epic #2880 / Story #2898 hard cutover
  // the bus is the sole mutator of phase state: every phase emits through
  // the bus, and named listeners (LabelTransitioner, StructuredCommentPoster,
  // BlockerHandler, AcceptanceReconciler, Finalizer, MergeWatcher, Cleaner,
  // …) own the matching state side effects. There is no remaining branch
  // here that selects between bus-emit and a direct provider mutation — the
  // bus is unconditionally constructed and wired below.
  //
  // `ctx.bus` is honoured so tests can inject a recording bus and so
  // alternate harnesses (e.g. epic-deliver's outer composition) can share
  // a single bus across multiple sub-runners; absent that override the
  // factory constructs a fresh bus for this run.
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

  // Build the shared context bag passed to every registry entry.
  // `checkpointer` is `epicRunStateStore` — the BranchCleaner reads
  // `epic-run-state` from the Epic Issue via this handle.
  const shared = {
    bus,
    config,
    provider,
    epicId: ctx.epicId,
    cwd: ctx.cwd,
    logger,
    tempRoot,
    notify: notifyFn,
    checkpointer: epicRunStateStore,
  };

  // Story #3633 — wire all lifecycle listeners via the declarative registry.
  // The driver sorts entries by slot, evaluates `requires`, constructs via
  // `build`, calls `register`, and returns a name→instance map. Ordering
  // is captured in the SLOT constants above instead of prose comments.
  const listeners = wireListeners(bus, shared);

  logger?.debug?.(
    '[lifecycle] all listeners wired via declarative registry ' +
      '(checkpoint-pointer-writer, reliability-observers, iterate-waves, ' +
      'side-effects, intervention-recorder, close-tail chain, blocker-handler)',
  );

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
    blockerHandler: listeners.blockerHandler,
    blockerWait,
    launcher,
    gitAdapter,
    commitAssertion,
    journal,
    bus,
    ledgerWriter,
    traceLogger,
    lifecycleProgressReporter: listeners.lifecycleProgressReporter,
    interventionRecorder: listeners.interventionRecorder,
    checkpointPointerWriter: listeners.checkpointPointerWriter,
    // Expose reliability observers as a bag (or null for unit fixtures
    // whose bus does not satisfy busOk).
    reliabilityObservers:
      listeners.timeoutWatchdog != null && listeners.heartbeatMonitor != null
        ? {
            timeoutWatchdog: listeners.timeoutWatchdog,
            heartbeatMonitor: listeners.heartbeatMonitor,
          }
        : null,
    acceptanceReconciler: listeners.acceptanceReconciler,
    finalizer: listeners.finalizer,
    watcher: listeners.watcher,
    automergePredicate: listeners.automergePredicate,
    automergeArmer: listeners.automergeArmer,
    branchCleaner: listeners.branchCleaner,
    mergeWatcher: listeners.mergeWatcher,
    cleaner: listeners.cleaner,
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
 *
 * NOTE: kept as a named export for backward compatibility — the
 * `listener-registration.test.js` suite calls it directly to test
 * the reliability-observer construction path in isolation.
 */
export function registerReliabilityObservers({ bus, config, logger }) {
  if (!busOk(bus)) {
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
 * Construct and register the InterventionRecorder listener
 * (Story #2410 / Task #2416). Subscribes to `intervention.recorded` and
 * persists the payload to the epic-run-state structured comment via
 * `epic-run-state-store.appendIntervention`. Returns the constructed
 * instance so tests can introspect the seqId guard; returns `null` for
 * unit fixtures that supply an unbusable collaborators bag, an absent
 * provider, or a non-numeric epicId.
 *
 * NOTE: kept as a named export for backward compatibility. The factory
 * delegates to the LISTENER_REGISTRY entry for `interventionRecorder`.
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
