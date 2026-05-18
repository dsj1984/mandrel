// tests/lib/orchestration/lifecycle/activation/listener-registration.test.js
/**
 * Boot-time listener census for the reliability observers wired by
 * `registerReliabilityObservers` (Story #2314, Tasks #2324 + #2323).
 *
 * Acceptance contract:
 *   - After `registerReliabilityObservers({ bus, config, logger })` runs,
 *     the bus reports a `TimeoutWatchdog` instance as a wildcard
 *     subscriber. Story #2323 will extend the census to assert
 *     `HeartbeatMonitor` is also registered.
 *   - Per-event budgets are sourced from
 *     `config.delivery.lifecycle.timeouts`; the watchdog arms a timer
 *     for any phase whose `*.start` event lands and whose name appears
 *     in the budget map.
 *   - The registration helper is a no-op when `bus` is missing or does
 *     not expose `on()` / `emit()` — protects unit fixtures with a
 *     minimal collaborators bag.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EpicRunnerContext } from '../../../../../.agents/scripts/lib/orchestration/context.js';
import {
  createEpicRunnerCollaborators,
  registerReliabilityObservers,
} from '../../../../../.agents/scripts/lib/orchestration/epic-runner/factory.js';
import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { AcceptanceReconciler } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/acceptance-reconciler.js';
import { AutomergeArmer } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-armer.js';
import { AutomergePredicate } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';
import { Cleaner } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/cleaner.js';
import { Finalizer } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';
import {
  DEFAULT_HEARTBEAT_WARN_SECONDS,
  HeartbeatMonitor,
} from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/heartbeat-monitor.js';
import { TimeoutWatchdog } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/timeout-watchdog.js';
import { Watcher } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '.agents',
  'scripts',
  'lib',
  'orchestration',
  'epic-runner',
  'factory.js',
);

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Read the wildcard listener array out of the bus via its private slot.
 * The Bus class stores wildcard subscribers on `_wildcards` (see
 * `lib/orchestration/lifecycle/bus.js`). The boot-time census needs
 * direct visibility because there is no `bus.listeners('*')` public API.
 */
function wildcardCount(bus) {
  return bus._wildcards.length;
}

describe('registerReliabilityObservers — boot-time listener census', () => {
  it('registers TimeoutWatchdog and HeartbeatMonitor as wildcard subscribers', () => {
    const bus = new Bus();
    const before = wildcardCount(bus);
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: { 'acceptance.reconcile': 600, 'epic.finalize': 600 },
            heartbeatWarnSeconds: 60,
          },
        },
      },
      logger: quietLogger(),
    });
    assert.ok(observers, 'expected observers bag to be returned');
    assert.ok(
      observers.timeoutWatchdog instanceof TimeoutWatchdog,
      'expected a TimeoutWatchdog instance',
    );
    assert.ok(
      observers.heartbeatMonitor instanceof HeartbeatMonitor,
      'expected a HeartbeatMonitor instance',
    );
    assert.equal(
      wildcardCount(bus) - before,
      2,
      'both reliability observers should attach as wildcard subscribers',
    );
  });

  it('threads delivery.lifecycle.heartbeatWarnSeconds into the monitor', () => {
    const bus = new Bus();
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: {},
            heartbeatWarnSeconds: 30,
          },
        },
      },
      logger: quietLogger(),
    });
    assert.equal(observers.heartbeatMonitor.warnSeconds, 30);
  });

  it('falls back to the documented HeartbeatMonitor default when not configured', () => {
    const bus = new Bus();
    const observers = registerReliabilityObservers({
      bus,
      config: { delivery: { lifecycle: {} } },
      logger: quietLogger(),
    });
    assert.equal(
      observers.heartbeatMonitor.warnSeconds,
      DEFAULT_HEARTBEAT_WARN_SECONDS,
    );
  });

  it('threads delivery.lifecycle.timeouts into the watchdog', async () => {
    const bus = new Bus();
    const observers = registerReliabilityObservers({
      bus,
      config: {
        delivery: {
          lifecycle: {
            timeouts: { 'acceptance.reconcile': 1 },
          },
        },
      },
      logger: quietLogger(),
    });
    // Emitting `acceptance.reconcile.start` should arm the watchdog
    // because the budget is configured; absence of `epic.finalize` in
    // the map means a finalize start is silently skipped.
    await bus.emit('acceptance.reconcile.start', { epicId: 99 });
    assert.deepEqual(observers.timeoutWatchdog.armedPhases, [
      'acceptance.reconcile',
    ]);
    await bus.emit('epic.finalize.start', { epicId: 99 });
    assert.deepEqual(
      observers.timeoutWatchdog.armedPhases,
      ['acceptance.reconcile'],
      'epic.finalize must not arm without a configured budget',
    );
    observers.timeoutWatchdog.dispose();
  });

  it('tolerates a missing delivery.lifecycle block', () => {
    const bus = new Bus();
    const observers = registerReliabilityObservers({
      bus,
      config: {}, // no delivery.lifecycle
      logger: quietLogger(),
    });
    assert.ok(observers, 'should still register when config is bare');
    assert.ok(observers.timeoutWatchdog instanceof TimeoutWatchdog);
    assert.ok(observers.heartbeatMonitor instanceof HeartbeatMonitor);
    assert.equal(wildcardCount(bus), 2);
  });

  it('returns null for an unbusable bus argument', () => {
    assert.equal(registerReliabilityObservers({ bus: null }), null);
    assert.equal(registerReliabilityObservers({ bus: {} }), null);
    assert.equal(
      registerReliabilityObservers({ bus: { on: () => {} } }),
      null,
      'a bus missing emit() must be rejected',
    );
  });
});

/**
 * Story #2315 / Task #2322 — close-tail registrar activation census.
 *
 * What this describe block pins:
 *   1. `createEpicRunnerCollaborators` returns an
 *      `acceptanceReconciler` on the collaborator bag, instantiated
 *      from the production listener class.
 *   2. The bus exposed on the same bag has at least one listener
 *      subscribed to `epic.close.end`. (We do not pin an exact count
 *      because the trace logger and checkpoint-pointer-writer also
 *      subscribe; the AC is "AcceptanceReconciler is among them".)
 *   3. Source-of-truth grep: `acceptance-reconciler.js` is imported
 *      exactly once in `factory.js`. Prevents accidental
 *      double-registration when future close-tail listeners are added.
 */

function buildAcceptanceCtx() {
  return new EpicRunnerContext({
    epicId: 2306,
    provider: {
      async getTicket(id) {
        return { id, labels: [] };
      },
    },
    config: {
      runners: {
        deliverRunner: {
          enabled: true,
          concurrencyCap: 1,
          storyRetryCount: 0,
          blockerTimeoutHours: 0,
        },
      },
    },
    logger: quietLogger(),
    cwd: '/nonexistent-listener-registration-test',
    fetchImpl: async () => ({ ok: true, status: 200 }),
    dispatch: async ({ plan }) =>
      plan.map((p) => ({ storyId: p.storyId, status: 'done' })),
    gitAdapter: async () => 1,
  });
}

describe('factory close-tail registrar — AcceptanceReconciler activation', () => {
  it('exposes acceptanceReconciler on the collaborator bag', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.ok(
      collaborators.acceptanceReconciler,
      'collaborators.acceptanceReconciler must be present',
    );
    assert.ok(
      collaborators.acceptanceReconciler instanceof AcceptanceReconciler,
      'collaborators.acceptanceReconciler must be an AcceptanceReconciler',
    );
  });

  it('subscribes AcceptanceReconciler to epic.close.end on the production bus', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    const closeEndListeners =
      collaborators.bus._listeners.get('epic.close.end') ?? [];
    assert.ok(
      closeEndListeners.length >= 1,
      'at least one listener subscribed to epic.close.end',
    );
    assert.ok(
      collaborators.acceptanceReconciler.events.includes('epic.close.end'),
      'AcceptanceReconciler.events advertises epic.close.end',
    );
  });

  it('AcceptanceReconciler fires on epic.close.end via the boot-time bus', async () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    // Replace the helper with a stub so the listener does not try to
    // touch the real spec reconciler (which would read a non-existent
    // Epic via the stub provider).
    collaborators.acceptanceReconciler.reconcileAcceptanceSpecFn =
      async () => ({
        status: 'waived',
      });

    await collaborators.bus.emit('epic.close.end', { epicId: 2306 });

    const classifications = collaborators.acceptanceReconciler.classifications;
    assert.equal(
      classifications.length,
      1,
      'reconciler classified exactly one epic.close.end',
    );
    assert.equal(classifications[0].outcome, 'skipped');
    assert.equal(classifications[0].reason, 'waiver');
  });

  it('imports acceptance-reconciler.js exactly once in factory.js', () => {
    const factorySource = readFileSync(FACTORY_PATH, 'utf8');
    const matches = factorySource.match(
      /from\s+['"][^'"]*listeners\/acceptance-reconciler\.js['"]/g,
    );
    assert.ok(matches, 'factory.js must import acceptance-reconciler.js');
    assert.equal(
      matches.length,
      1,
      'acceptance-reconciler.js must be imported exactly once',
    );
  });
});

/**
 * Story #2319 / Task #2328 — Finalizer activation census.
 *
 * What this describe block pins:
 *   1. `createEpicRunnerCollaborators` exposes `finalizer` on the
 *      collaborator bag, instantiated from the production listener
 *      class.
 *   2. The bus on the same bag has at least one listener subscribed to
 *      `acceptance.reconcile.ok` (Finalizer's sole event).
 *   3. Source-of-truth grep: `finalizer.js` is imported exactly once in
 *      `factory.js`. Prevents accidental double-registration when
 *      future close-tail listeners are added.
 */
describe('factory close-tail registrar — Finalizer activation', () => {
  it('exposes finalizer on the collaborator bag', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.ok(
      collaborators.finalizer,
      'collaborators.finalizer must be present',
    );
    assert.ok(
      collaborators.finalizer instanceof Finalizer,
      'collaborators.finalizer must be a Finalizer',
    );
  });

  it('subscribes Finalizer to acceptance.reconcile.ok on the production bus', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    const reconcileOkListeners =
      collaborators.bus._listeners.get('acceptance.reconcile.ok') ?? [];
    assert.ok(
      reconcileOkListeners.length >= 1,
      'at least one listener subscribed to acceptance.reconcile.ok',
    );
    assert.ok(
      collaborators.finalizer.events.includes('acceptance.reconcile.ok'),
      'Finalizer.events advertises acceptance.reconcile.ok',
    );
  });

  it('imports finalizer.js exactly once in factory.js', () => {
    const factorySource = readFileSync(FACTORY_PATH, 'utf8');
    const matches = factorySource.match(
      /from\s+['"][^'"]*listeners\/finalizer\.js['"]/g,
    );
    assert.ok(matches, 'factory.js must import finalizer.js');
    assert.equal(
      matches.length,
      1,
      'finalizer.js must be imported exactly once',
    );
  });
});

/**
 * Story #2327 / Task #2331 — Watcher activation census.
 *
 * What this describe block pins:
 *   1. `createEpicRunnerCollaborators` exposes `watcher` on the
 *      collaborator bag, instantiated from the production listener
 *      class.
 *   2. The bus on the same bag has at least one listener subscribed to
 *      `pr.created` (Watcher's sole event).
 *   3. Source-of-truth grep: `watcher.js` is imported exactly once in
 *      `factory.js`. Prevents accidental double-registration when
 *      future close-tail listeners are added.
 */
describe('factory close-tail registrar — Watcher activation', () => {
  it('exposes watcher on the collaborator bag', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.ok(collaborators.watcher, 'collaborators.watcher must be present');
    assert.ok(
      collaborators.watcher instanceof Watcher,
      'collaborators.watcher must be a Watcher',
    );
  });

  it('subscribes Watcher to pr.created on the production bus', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    const prCreatedListeners =
      collaborators.bus._listeners.get('pr.created') ?? [];
    assert.ok(
      prCreatedListeners.length >= 1,
      'at least one listener subscribed to pr.created',
    );
    assert.ok(
      collaborators.watcher.events.includes('pr.created'),
      'Watcher.events advertises pr.created',
    );
  });

  it('imports watcher.js exactly once in factory.js', () => {
    const factorySource = readFileSync(FACTORY_PATH, 'utf8');
    const matches = factorySource.match(
      /from\s+['"][^'"]*listeners\/watcher\.js['"]/g,
    );
    assert.ok(matches, 'factory.js must import watcher.js');
    assert.equal(matches.length, 1, 'watcher.js must be imported exactly once');
  });
});

/**
 * Story #2333 / Task #2337 — AutomergePredicate activation census.
 *
 * What this describe block pins:
 *   1. `createEpicRunnerCollaborators` exposes `automergePredicate` on
 *      the collaborator bag, instantiated from the production listener
 *      class.
 *   2. The bus on the same bag has at least one listener subscribed to
 *      `epic.watch.end` (AutomergePredicate's sole event).
 *   3. Source-of-truth grep: the **listener** at
 *      `lifecycle/listeners/automerge-predicate.js` is imported exactly
 *      once in `factory.js`, and no import of the now-deleted legacy
 *      `lib/orchestration/automerge-predicate.js` sibling path leaks
 *      back in. Prevents accidental dual-registration.
 */
describe('factory close-tail registrar — AutomergePredicate activation', () => {
  it('exposes automergePredicate on the collaborator bag', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.ok(
      collaborators.automergePredicate,
      'collaborators.automergePredicate must be present',
    );
    assert.ok(
      collaborators.automergePredicate instanceof AutomergePredicate,
      'collaborators.automergePredicate must be an AutomergePredicate',
    );
  });

  it('subscribes AutomergePredicate to epic.watch.end on the production bus', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    const watchEndListeners =
      collaborators.bus._listeners.get('epic.watch.end') ?? [];
    assert.ok(
      watchEndListeners.length >= 1,
      'at least one listener subscribed to epic.watch.end',
    );
    assert.ok(
      collaborators.automergePredicate.events.includes('epic.watch.end'),
      'AutomergePredicate.events advertises epic.watch.end',
    );
  });

  it('imports the lifecycle automerge-predicate.js listener exactly once and does not import the legacy module', () => {
    const factorySource = readFileSync(FACTORY_PATH, 'utf8');
    const listenerMatches = factorySource.match(
      /from\s+['"][^'"]*lifecycle\/listeners\/automerge-predicate\.js['"]/g,
    );
    assert.ok(
      listenerMatches,
      'factory.js must import the lifecycle AutomergePredicate listener',
    );
    assert.equal(
      listenerMatches.length,
      1,
      'lifecycle/listeners/automerge-predicate.js must be imported exactly once',
    );
    const legacyMatches = factorySource.match(
      /from\s+['"][^'"]*orchestration\/automerge-predicate\.js['"]/g,
    );
    assert.equal(
      legacyMatches,
      null,
      'factory.js must NOT import the (now-deleted) legacy lib/orchestration/automerge-predicate.js module path',
    );
  });
});

/**
 * Story #2336 / Task #2341 — AutomergeArmer activation census.
 *
 * What this describe block pins:
 *   1. `createEpicRunnerCollaborators` exposes `automergeArmer` on the
 *      collaborator bag, instantiated from the production listener
 *      class.
 *   2. The bus on the same bag has at least one listener subscribed to
 *      `epic.merge.ready` (AutomergeArmer's sole event) and ZERO
 *      AutomergeArmer-shaped subscriptions to `epic.watch.end` or
 *      `epic.merge.blocked` — those events MUST NOT trigger the arm.
 *   3. Source-of-truth grep: `automerge-armer.js` is imported exactly
 *      once in `factory.js`. Prevents accidental double-registration
 *      when future close-tail listeners are added.
 *
 * This is the runtime closure of High-1 from the Epic #2172 review:
 * without this listener wired into the production factory, the
 * predicate's `epic.merge.ready` emission has no consumer — auto-merge
 * silently never arms. With this listener wired and confirmed to
 * subscribe to `epic.merge.ready` ONLY, the predicate's verdict is the
 * sole gate.
 */
describe('factory close-tail registrar — AutomergeArmer activation', () => {
  it('exposes automergeArmer on the collaborator bag', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.ok(
      collaborators.automergeArmer,
      'collaborators.automergeArmer must be present',
    );
    assert.ok(
      collaborators.automergeArmer instanceof AutomergeArmer,
      'collaborators.automergeArmer must be an AutomergeArmer',
    );
  });

  it('subscribes AutomergeArmer to epic.merge.ready on the production bus', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    const readyListeners =
      collaborators.bus._listeners.get('epic.merge.ready') ?? [];
    assert.ok(
      readyListeners.length >= 1,
      'at least one listener subscribed to epic.merge.ready',
    );
    assert.deepEqual(
      collaborators.automergeArmer.events,
      ['epic.merge.ready'],
      'AutomergeArmer.events must advertise epic.merge.ready and ONLY epic.merge.ready',
    );
  });

  it('does NOT subscribe AutomergeArmer to epic.watch.end or epic.merge.blocked', () => {
    // Defensive census: the safety invariant is that auto-merge fires
    // ONLY after the predicate's clean verdict. If a future refactor
    // accidentally adds a second subscription, this assertion catches
    // it before the production bus ships.
    assert.equal(
      AutomergeArmer.prototype.events,
      undefined,
      'events is an instance property, not on the prototype',
    );
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.equal(
      collaborators.automergeArmer.events.includes('epic.watch.end'),
      false,
      'AutomergeArmer MUST NOT subscribe to epic.watch.end',
    );
    assert.equal(
      collaborators.automergeArmer.events.includes('epic.merge.blocked'),
      false,
      'AutomergeArmer MUST NOT subscribe to epic.merge.blocked',
    );
  });

  it('imports automerge-armer.js exactly once in factory.js', () => {
    const factorySource = readFileSync(FACTORY_PATH, 'utf8');
    const matches = factorySource.match(
      /from\s+['"][^'"]*lifecycle\/listeners\/automerge-armer\.js['"]/g,
    );
    assert.ok(matches, 'factory.js must import automerge-armer.js');
    assert.equal(
      matches.length,
      1,
      'automerge-armer.js must be imported exactly once',
    );
  });
});

/**
 * Story #2338 / Task #2345 — Cleaner activation census.
 *
 * What this describe block pins:
 *   1. `createEpicRunnerCollaborators` exposes `cleaner` on the
 *      collaborator bag, instantiated from the production listener
 *      class.
 *   2. The bus on the same bag has at least one listener subscribed to
 *      `epic.merge.armed` (Cleaner's sole event). The advertised
 *      `events` tuple is the single-element `['epic.merge.armed']`.
 *   3. Source-of-truth grep: `cleaner.js` is imported exactly once in
 *      `factory.js`. Prevents accidental double-registration when
 *      future close-tail listeners are added.
 *
 * This is the runtime closure of the AC for Story #2338: without the
 * listener wired into the production factory, the AutomergeArmer's
 * `epic.merge.armed` emission has no consumer — the temp tree never
 * archives and the terminal `epic.complete` never fires.
 */
describe('factory close-tail registrar — Cleaner activation', () => {
  it('exposes cleaner on the collaborator bag', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    assert.ok(collaborators.cleaner, 'collaborators.cleaner must be present');
    assert.ok(
      collaborators.cleaner instanceof Cleaner,
      'collaborators.cleaner must be a Cleaner',
    );
  });

  it('subscribes Cleaner to epic.merge.armed on the production bus', () => {
    const collaborators = createEpicRunnerCollaborators(buildAcceptanceCtx());
    const armedListeners =
      collaborators.bus._listeners.get('epic.merge.armed') ?? [];
    assert.ok(
      armedListeners.length >= 1,
      'at least one listener subscribed to epic.merge.armed',
    );
    assert.deepEqual(
      [...collaborators.cleaner.events],
      ['epic.merge.armed'],
      'Cleaner.events must advertise epic.merge.armed and ONLY epic.merge.armed',
    );
  });

  it('imports cleaner.js exactly once in factory.js', () => {
    const factorySource = readFileSync(FACTORY_PATH, 'utf8');
    const matches = factorySource.match(
      /from\s+['"][^'"]*lifecycle\/listeners\/cleaner\.js['"]/g,
    );
    assert.ok(matches, 'factory.js must import cleaner.js');
    assert.equal(matches.length, 1, 'cleaner.js must be imported exactly once');
  });
});
