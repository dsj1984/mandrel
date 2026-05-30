// tests/lib/orchestration/lifecycle/activation/fixtures/clean-sprint.fixture.js
/**
 * Clean-sprint fixture for the activation validation suite
 * (Story #2343 / Task #2349, Epic #2306).
 *
 * Drives the production close-tail listener chain end-to-end against a
 * synthetic Epic. The fixture builds the same collaborator bag the
 * production runner would build via `createEpicRunnerCollaborators(ctx)`,
 * then replaces each listener's injected shell-out / spec-reconciler /
 * predicate function with a deterministic stub so the chain progresses
 * without touching git, gh, or the real acceptance-spec on disk.
 *
 * The fixture is intentionally side-effect-light: it returns the bus,
 * the resolved temp paths, and the collaborator handles so tests can:
 *
 *   1. Emit `epic.close.end` and let the chain run.
 *   2. Read the NDJSON ledger that the LedgerWriter persists under
 *      `<tempRoot>/epic-<id>/lifecycle.ndjson` BEFORE the Cleaner
 *      archives it (the fixture stubs Cleaner's rename to a no-op so the
 *      ledger stays put — this keeps the assertion surface trivial:
 *      one file path, all records, no archive walk).
 *   3. Inspect the AutomergeArmer's `ghPrViewAutoMergeFn` call log to
 *      confirm auto-merge was probed and reported armed via the listener
 *      path.
 *
 * The chain wired:
 *   AcceptanceReconciler (epic.close.end)
 *     → Finalizer (acceptance.reconcile.ok)
 *         → Watcher (pr.created)
 *             → AutomergePredicate (epic.watch.end)
 *                 → AutomergeArmer (epic.merge.ready)
 *                     → Cleaner (epic.merge.armed)
 *
 * All listeners are constructed by the production factory; stubs are
 * applied **after** construction by mutating the listener instances'
 * injected-function properties.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EpicRunnerContext } from '../../../../../../.agents/scripts/lib/orchestration/context.js';
import { createEpicRunnerCollaborators } from '../../../../../../.agents/scripts/lib/orchestration/epic-runner/factory.js';

/**
 * Default canonical PR URL the fixture threads through every listener.
 * Tests that need a different URL can pass `prUrl` in opts.
 */
export const DEFAULT_PR_URL = 'https://github.com/dsj1984/mandrel/pull/99999';

/**
 * Default Epic id. Pinned so the temp directory under tempRoot is
 * predictable across tests sharing the fixture.
 */
export const DEFAULT_EPIC_ID = 2306;

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Build a stub provider that satisfies every ticket round-trip the
 * close-tail chain makes. Returns no labels so `transitionTicketState`'s
 * cascade short-circuits on `agent::done` (no parent dependencies).
 *
 * Records every `updateTicket` call so tests can assert no spurious
 * blocker label flips occurred on the happy path.
 */
function buildStubProvider() {
  const updates = [];
  const provider = {
    async getTicket(id) {
      return { id, labels: [], body: '' };
    },
    async getTicketComments() {
      return [];
    },
    async getTicketDependencies() {
      return { blocks: [], blockedBy: [] };
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
      return { ok: true };
    },
    async postComment() {
      return { commentId: 1 };
    },
    async deleteComment() {
      return { ok: true };
    },
  };
  provider._updates = updates;
  return provider;
}

/**
 * Build the EpicRunnerContext the production factory expects. The
 * `dispatch`, `gitAdapter`, and `fetchImpl` slots are stubbed because the
 * close-tail chain does not touch them — they exist for completeness so
 * `EpicRunnerContext.validate()` accepts the bag.
 */
function buildContext({ epicId, cwd, tempRoot, provider }) {
  return new EpicRunnerContext({
    epicId,
    provider,
    config: {
      // Lifecycle budgets — present so registerReliabilityObservers wires
      // the watchdog with the documented production values.
      delivery: {
        lifecycle: {
          timeouts: {
            'acceptance.reconcile': 600,
            'epic.finalize': 600,
            'epic.watch': 1800,
          },
          heartbeatWarnSeconds: 60,
        },
      },
      // Point the LedgerWriter / Cleaner at our test-controlled tempRoot
      // so the fixture's assertions read from a known path and cleanup
      // is trivial (rm -rf <tempRoot>).
      project: { paths: { tempRoot } },
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
    cwd,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    dispatch: async ({ plan }) =>
      plan.map((p) => ({ storyId: p.storyId, status: 'done' })),
    gitAdapter: async () => 1,
    notify: async () => ({ ok: true }),
  });
}

/**
 * Apply the clean-sprint stub set to a freshly-built collaborator bag.
 * Each listener's injected shell-out is replaced with a function that
 * returns the deterministic happy-path result. The AutomergeArmer
 * probe sequence models the production crash-recovery contract:
 *   1st emit: probe sees NOT armed → listener calls `gh pr merge --auto`.
 *
 * Returns the call-counter bag so tests can assert exactly which side
 * effects fired.
 */
function applyCleanSprintStubs(collaborators, { prUrl }) {
  const counters = {
    reconcile: 0,
    finalize: 0,
    ghPrListHead: 0,
    ghPrChecks: 0,
    ghPrView: 0,
    ghPrUpdateBranch: 0,
    predicate: 0,
    ghPrViewAutoMerge: 0,
    ghPrMergeAuto: 0,
    ghPrViewMerge: 0,
    mergeWatcherSleeps: 0,
    renames: 0,
  };
  const calls = {
    ghPrViewAutoMerge: [],
    ghPrMergeAuto: [],
  };

  // AcceptanceReconciler: linked spec is OK (no gaps).
  collaborators.acceptanceReconciler.reconcileAcceptanceSpecFn = async () => {
    counters.reconcile += 1;
    return { status: 'ok', satisfied: ['AC-1'], pending: [], missing: [] };
  };

  // Finalizer: push + `gh pr create` succeed and return the canonical PR URL.
  // Idempotency probe (`gh pr list --head`) returns empty so the listener
  // proceeds to the create path rather than short-circuiting.
  collaborators.finalizer.runFinalizeFn = async () => {
    counters.finalize += 1;
    return {
      epicId: collaborators.finalizer.epicId,
      ffOk: true,
      pushed: true,
      prUrl,
      postedHandoff: true,
    };
  };
  collaborators.finalizer.ghPrListHeadFn = () => {
    counters.ghPrListHead += 1;
    return { status: 0, stdout: '', stderr: '' };
  };

  // Watcher: required-check probe returns one all-green check; merge
  // state is not BEHIND so the update-branch recovery never fires. The
  // sleepFn is a no-op so the test does not actually wait the
  // pollIntervalMs (which defaults to 10s).
  collaborators.watcher.sleepFn = async () => undefined;
  collaborators.watcher.ghPrChecksFn = () => {
    counters.ghPrChecks += 1;
    return {
      status: 0,
      stdout: JSON.stringify([
        { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
      ]),
      stderr: '',
    };
  };
  collaborators.watcher.ghPrViewFn = () => {
    counters.ghPrView += 1;
    return {
      status: 0,
      stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
      stderr: '',
    };
  };
  collaborators.watcher.ghPrUpdateBranchFn = () => {
    counters.ghPrUpdateBranch += 1;
    return { status: 0, stdout: '', stderr: '' };
  };

  // AutomergePredicate: structured signals report clean.
  collaborators.automergePredicate.evaluatePredicateFn = async () => {
    counters.predicate += 1;
    return {
      clean: true,
      reasons: [],
      signals: {
        manualInterventions: 0,
        waveStatuses: ['complete'],
        storyBlockers: 0,
        severity: {
          critical: 0,
          high: 0,
          medium: 0,
          suggestion: 0,
        },
        retroCompact: true,
        codeReviewFound: true,
        retroFound: true,
        stateFound: true,
      },
    };
  };

  // AutomergeArmer: first probe reports NOT armed, then the arm call
  // succeeds. After the arm, downstream callers (the test) can re-probe
  // and observe the armed state via the second probe response.
  let probeIdx = 0;
  const probeSequence = [
    { status: 0, stdout: '{"autoMergeRequest":null}', stderr: '' },
    {
      status: 0,
      stdout:
        '{"autoMergeRequest":{"mergeMethod":"SQUASH","enabledBy":{"login":"mandrel-bot"}}}',
      stderr: '',
    },
  ];
  collaborators.automergeArmer.ghPrViewAutoMergeFn = (args) => {
    counters.ghPrViewAutoMerge += 1;
    calls.ghPrViewAutoMerge.push(args);
    const next = probeSequence[Math.min(probeIdx, probeSequence.length - 1)];
    probeIdx += 1;
    return next;
  };
  collaborators.automergeArmer.ghPrMergeAutoFn = (args) => {
    counters.ghPrMergeAuto += 1;
    calls.ghPrMergeAuto.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };

  // MergeWatcher: stub the `gh pr view --json mergeCommit` probe so the
  // listener observes the PR as merged on the first poll. Without this
  // stub the listener would shell out to real `gh` against the fake PR
  // URL, never see a mergeCommit, and sleep `intervalSeconds` (default
  // 30s) up to `maxBudgetSeconds` (default 3600s = 1hr). Hardening
  // against that hang is what makes the clean-sprint chain runnable in
  // a unit test without burning real wall clock. The `sleepFn` override
  // is belt-and-braces — even if a future change drives multiple polls,
  // the test never actually waits.
  if (collaborators.mergeWatcher) {
    collaborators.mergeWatcher.ghPrViewMergeFn = () => {
      counters.ghPrViewMerge += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 1234,
          mergeCommit: { oid: 'a'.repeat(40) },
          mergedAt: '2026-05-23T00:00:00.000Z',
        }),
        stderr: '',
      };
    };
    collaborators.mergeWatcher.sleepFn = async () => {
      counters.mergeWatcherSleeps += 1;
    };
  }

  // BranchCleaner (Story #3367): stub the open-PR guard probe so the
  // listener never shells out to real `gh pr list` against the fake PR
  // URL. Report zero open PRs so the epic branch is reaped on the clean
  // path (the close-tail ledger assertions expect the full reap to run).
  if (collaborators.branchCleaner) {
    collaborators.branchCleaner.spawnFn = () => ({
      status: 0,
      stdout: '0\n',
      stderr: '',
    });
  }

  // Cleaner: stub the rename so the archive step does NOT move
  // `<tempRoot>/epic-<id>/` out from under the ledger reader. The
  // listener still emits the terminal `epic.cleanup.start →
  // epic.cleanup.end → epic.complete` sequence; only the on-disk move
  // is suppressed so tests can read the ledger at its original path.
  // The `existsFn` reports the source absent so the listener short-
  // circuits to the `no-source` branch without invoking renameFn.
  collaborators.cleaner.existsFn = () => false;
  collaborators.cleaner.renameFn = () => {
    counters.renames += 1;
  };
  // Pin the clock so the archive timestamp does not vary across replays
  // (deterministic-replay.test.js depends on this for byte-identity).
  collaborators.cleaner.now = () => new Date('2026-05-18T00:00:00.000Z');

  return { counters, calls, probeSequence };
}

/**
 * Build a freshly-wired clean-sprint fixture and return the bus,
 * collaborator handles, and the resolved temp paths.
 *
 * Callers are responsible for invoking the returned `cleanup()` to
 * remove the temp directory.
 */
export function buildCleanSprintFixture(opts = {}) {
  const epicId = opts.epicId ?? DEFAULT_EPIC_ID;
  const prUrl = opts.prUrl ?? DEFAULT_PR_URL;
  const cwd =
    opts.cwd ??
    mkdtempSync(path.join(tmpdir(), `mandrel-clean-sprint-cwd-${epicId}-`));
  const tempRoot =
    opts.tempRoot ??
    mkdtempSync(path.join(tmpdir(), `mandrel-clean-sprint-temp-${epicId}-`));
  const provider = buildStubProvider();
  const ctx = buildContext({ epicId, cwd, tempRoot, provider });
  const collaborators = createEpicRunnerCollaborators(ctx);
  const stubs = applyCleanSprintStubs(collaborators, { prUrl });
  const ledgerPath = path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson');
  const companionPath = path.join(tempRoot, `epic-${epicId}`, 'lifecycle.md');

  function cleanup() {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best effort; the OS will sweep the tmp dir eventually
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  return {
    epicId,
    prUrl,
    cwd,
    tempRoot,
    ledgerPath,
    companionPath,
    provider,
    ctx,
    collaborators,
    bus: collaborators.bus,
    stubs,
    cleanup,
  };
}
