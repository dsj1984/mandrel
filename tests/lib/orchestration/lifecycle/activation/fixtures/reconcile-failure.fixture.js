// tests/lib/orchestration/lifecycle/activation/fixtures/reconcile-failure.fixture.js
/**
 * Reconcile-failure fixture for the activation validation suite
 * (Story #2343 / Task #2348, Epic #2306).
 *
 * Drives the production close-tail listener chain against a synthetic
 * Epic whose linked acceptance-spec carries an unmapped AC row. The
 * fixture stubs `reconcileAcceptanceSpec` so the AcceptanceReconciler
 * sees `status: 'gap'`, emits `acceptance.reconcile.failed`, and then
 * emits `epic.blocked` — driving the LabelTransitioner to flip the
 * Epic ticket to `agent::blocked`. Finalizer is wired but its sole
 * subscription (`acceptance.reconcile.ok`) never fires, so no
 * `epic.finalize.*` and no `pr.created` events land in the ledger.
 *
 * Cross-process safety contract pinned by this fixture:
 *   - `gh pr list --head epic/<id>` (the Finalizer's idempotency probe)
 *     returns empty after the run. The probe is wired on the Finalizer
 *     instance so a test that calls it directly observes the empty
 *     result — this models the operator running
 *     `gh pr list --head epic/<id>` after a reconcile-failure run and
 *     seeing no PR opened.
 *
 * The fixture intentionally reuses the same context shape as
 * `clean-sprint.fixture.js`. Only the AcceptanceReconciler's helper is
 * tuned to return a gap; all other stubs remain in place so a future
 * refactor that accidentally widens Finalizer's subscription beyond
 * `acceptance.reconcile.ok` would be caught by the
 * "zero pr.created events" assertion in the test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EpicRunnerContext } from '../../../../../../.agents/scripts/lib/orchestration/context.js';
import { createEpicRunnerCollaborators } from '../../../../../../.agents/scripts/lib/orchestration/epic-runner/factory.js';

export const DEFAULT_EPIC_ID = 2306;

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

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

function buildContext({ epicId, cwd, tempRoot, provider }) {
  return new EpicRunnerContext({
    epicId,
    provider,
    config: {
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
 * Stub the close-tail chain for a reconcile-gap run. The
 * AcceptanceReconciler reports `status: 'gap'` carrying one unmapped
 * AC; every other listener is wired but should never be reached on
 * this path (Finalizer subscribes only to `.ok`, Watcher to
 * `pr.created`, etc.). Stubbing the downstream shell-outs as throwers
 * is the AC-grade defence against a future refactor that accidentally
 * widens a subscription: the throw would land in the ledger as a
 * `failed` record and the test would fail loudly rather than silently
 * skipping a regression.
 */
function applyReconcileFailureStubs(collaborators) {
  const counters = {
    reconcile: 0,
    finalize: 0,
    ghPrListHead: 0,
    ghPrChecks: 0,
    ghPrViewAutoMerge: 0,
    ghPrMergeAuto: 0,
  };

  // AcceptanceReconciler: spec has an unmapped AC row. The reconciler
  // returns `status: 'gap'` carrying the missing AC list; the listener
  // classifies that into `acceptance.reconcile.failed` and emits
  // `epic.blocked` immediately after.
  collaborators.acceptanceReconciler.reconcileAcceptanceSpecFn = async () => {
    counters.reconcile += 1;
    return {
      status: 'gap',
      satisfied: ['AC-1'],
      pending: [],
      missing: ['AC-7'],
    };
  };

  // Finalizer.runFinalizeFn — should NEVER be called on the gap path.
  // We replace it with a thrower so a regression that wires Finalizer to
  // `.failed` or `.skipped` would surface as a ledger `failed` record.
  collaborators.finalizer.runFinalizeFn = async () => {
    counters.finalize += 1;
    throw new Error(
      'Finalizer.runFinalizeFn must not be invoked on a reconcile-gap run',
    );
  };
  // gh pr list --head epic/<id> — stub returns empty (no PR open). The
  // test calls this directly after the run to assert the cross-process
  // probe shape; the listener itself never invokes it on the gap path
  // because Finalizer's handler never runs.
  collaborators.finalizer.ghPrListHeadFn = () => {
    counters.ghPrListHead += 1;
    return { status: 0, stdout: '', stderr: '' };
  };

  // Watcher.ghPrChecksFn — should NEVER be called (no pr.created).
  collaborators.watcher.sleepFn = async () => undefined;
  collaborators.watcher.ghPrChecksFn = () => {
    counters.ghPrChecks += 1;
    throw new Error(
      'Watcher.ghPrChecksFn must not be invoked on a reconcile-gap run',
    );
  };

  // AutomergeArmer probes — should NEVER be called (no epic.merge.ready).
  collaborators.automergeArmer.ghPrViewAutoMergeFn = () => {
    counters.ghPrViewAutoMerge += 1;
    throw new Error(
      'AutomergeArmer.ghPrViewAutoMergeFn must not be invoked on a reconcile-gap run',
    );
  };
  collaborators.automergeArmer.ghPrMergeAutoFn = () => {
    counters.ghPrMergeAuto += 1;
    throw new Error(
      'AutomergeArmer.ghPrMergeAutoFn must not be invoked on a reconcile-gap run',
    );
  };

  return { counters };
}

export function buildReconcileFailureFixture(opts = {}) {
  const epicId = opts.epicId ?? DEFAULT_EPIC_ID;
  const cwd =
    opts.cwd ??
    mkdtempSync(path.join(tmpdir(), `mandrel-reconcile-fail-cwd-${epicId}-`));
  const tempRoot =
    opts.tempRoot ??
    mkdtempSync(path.join(tmpdir(), `mandrel-reconcile-fail-temp-${epicId}-`));
  const provider = buildStubProvider();
  const ctx = buildContext({ epicId, cwd, tempRoot, provider });
  const collaborators = createEpicRunnerCollaborators(ctx);
  const stubs = applyReconcileFailureStubs(collaborators);
  const ledgerPath = path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson');
  const companionPath = path.join(tempRoot, `epic-${epicId}`, 'lifecycle.md');

  function cleanup() {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  return {
    epicId,
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
