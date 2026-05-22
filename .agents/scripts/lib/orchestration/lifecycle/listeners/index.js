// .agents/scripts/lib/orchestration/lifecycle/listeners/index.js
/**
 * Default listener-chain builder for the standalone `lifecycle-emit`
 * CLI surface (Story #2510, Epic #2501).
 *
 * `lib/orchestration/epic-runner/factory.js` already wires the full
 * close-tail chain when the production runner constructs an Epic. That
 * path stays canonical for the runner. This module mirrors the same
 * roster — in the same documented order — for callers that emit
 * lifecycle events OUTSIDE the runner (the `lifecycle-emit.js` CLI
 * shells in `/epic-deliver`'s Phase 6 / 7.5 / 8 markdown invocations).
 *
 * Canonical roster (registration order):
 *   1. LedgerWriter            (privileged hooks via `register(bus)`)
 *   2. AcceptanceReconciler    (epic.close.end → acceptance.reconcile.*)
 *   3. Finalizer               (acceptance.reconcile.{ok,waived} → pr.created)
 *   4. AutomergeArmer          (epic.merge.ready → epic.merge.armed)
 *   5. AutomergePredicate      (epic.watch.end → epic.merge.{ready,blocked})
 *   6. BranchCleaner           (epic.cleanup.start → branch reap)
 *   7. Cleaner                 (epic.merge.armed → epic.cleanup.* / epic.complete)
 *   8. CheckpointPointerWriter (every *.end → checkpoint.json)
 *
 * The bus contract requires LedgerWriter first: its `onEmitted` hook
 * lands the `emitted` ledger record on disk BEFORE any listener body
 * executes, so a crash mid-chain leaves a recoverable trail.
 *
 * Listeners whose constructors require collaborators that are not
 * available outside the runner (e.g. AutomergePredicate's `provider`,
 * BranchCleaner's `checkpointer`) are SKIPPED with a debug log rather
 * than constructed. This matches the factory's defensive guard pattern
 * — registration is best-effort; the chain still wires every listener
 * whose dependencies are satisfiable.
 *
 * Signature: `buildDefaultListenerChain({ bus, ledgerPath, repoRoot })`.
 * The Tech Spec for Epic #2501 (§ Story 4) fixes the public shape at
 * those three keys. `ledgerPath` is decomposed into `tempRoot` and
 * `epicId` so the listener constructors receive what they need;
 * `repoRoot` threads through as `cwd` for listeners that shell out
 * (`Finalizer`, `AutomergeArmer`).
 */

import path from 'node:path';

import { createLedgerWriter } from '../ledger-writer.js';
import { AcceptanceReconciler } from './acceptance-reconciler.js';
import { AutomergeArmer } from './automerge-armer.js';
import { AutomergePredicate } from './automerge-predicate.js';
import { BranchCleaner } from './branch-cleaner.js';
import { CheckpointPointerWriter } from './checkpoint-pointer-writer.js';
import { Cleaner } from './cleaner.js';
import { Finalizer } from './finalizer.js';

/**
 * Parse `temp/epic-<id>/lifecycle.ndjson` into `{ tempRoot, epicId }`.
 *
 * Throws when the input does not match the canonical layout. The
 * standalone `lifecycle-emit` CLI is the sole production caller and it
 * always feeds the canonical `epicLedgerPath(eid)` value, so a mismatch
 * here is a programmer error — surface it loudly.
 *
 * @param {string} ledgerPath
 * @returns {{ tempRoot: string, epicId: number }}
 */
export function parseLedgerPath(ledgerPath) {
  if (typeof ledgerPath !== 'string' || ledgerPath.length === 0) {
    throw new TypeError(
      'buildDefaultListenerChain: ledgerPath must be a non-empty string',
    );
  }
  const epicDir = path.dirname(ledgerPath);
  const tempRoot = path.dirname(epicDir);
  const epicDirName = path.basename(epicDir);
  const m = /^epic-(\d+)$/.exec(epicDirName);
  if (!m) {
    throw new Error(
      `buildDefaultListenerChain: ledgerPath does not match temp/epic-<id>/lifecycle.ndjson layout (got ${ledgerPath})`,
    );
  }
  const epicId = Number.parseInt(m[1], 10);
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new Error(
      `buildDefaultListenerChain: parsed epicId from ledgerPath is not a positive integer (got ${m[1]})`,
    );
  }
  return { tempRoot, epicId };
}

/**
 * Build and subscribe the canonical default listener chain onto the
 * supplied bus.
 *
 * @param {object} opts
 * @param {object} opts.bus Lifecycle bus instance (must expose `on`,
 *   `emit`, and the privileged `onEmitted` / `onCompleted` / `onFailed`
 *   hook seam).
 * @param {string} opts.ledgerPath Absolute or repo-relative path to the
 *   Epic's `lifecycle.ndjson`. Decomposed into `{ tempRoot, epicId }`
 *   for downstream constructors.
 * @param {string} opts.repoRoot Absolute path used as `cwd` for
 *   listeners that shell out (Finalizer, AutomergeArmer, BranchCleaner).
 * @param {object} [opts.provider] Ticketing provider. When omitted,
 *   AutomergePredicate is skipped (the listener constructor throws on
 *   a missing provider).
 * @param {object} [opts.config] Resolved agent config. Forwarded to the
 *   AcceptanceReconciler.
 * @param {object} [opts.checkpointer] Epic-run-state checkpoint reader.
 *   When omitted, BranchCleaner is skipped.
 * @param {object} [opts.logger] Logger surface (`debug`/`warn`/`error`).
 *
 * @returns {Promise<{
 *   ledgerWriter: object,
 *   acceptanceReconciler: object,
 *   finalizer: object,
 *   automergeArmer: object,
 *   automergePredicate: object|null,
 *   branchCleaner: object|null,
 *   cleaner: object,
 *   checkpointPointerWriter: object,
 *   order: string[]
 * }>}
 */
export async function buildDefaultListenerChain(opts = {}) {
  const {
    bus,
    ledgerPath,
    repoRoot,
    provider = null,
    config = null,
    checkpointer = null,
    logger = console,
  } = opts;
  if (
    !bus ||
    typeof bus.on !== 'function' ||
    typeof bus.emit !== 'function' ||
    typeof bus.onEmitted !== 'function'
  ) {
    throw new TypeError(
      'buildDefaultListenerChain: bus must expose on/emit and the privileged onEmitted/onCompleted/onFailed seam',
    );
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError(
      'buildDefaultListenerChain: repoRoot must be a non-empty string',
    );
  }
  const { tempRoot, epicId } = parseLedgerPath(ledgerPath);

  const order = [];

  // 1. LedgerWriter — MUST be first. Uses the privileged hook seam, so
  // its registration call is `register(bus)` rather than a regular
  // `bus.on()` subscription. The bus contract guarantees `emitted`
  // lands on disk before any listener body executes.
  const ledgerWriter = createLedgerWriter({ epicId, tempRoot });
  ledgerWriter.register(bus);
  order.push('LedgerWriter');

  // 2. AcceptanceReconciler — gates Finalize on close-time AC coverage.
  const acceptanceReconciler = new AcceptanceReconciler({
    bus,
    epicId,
    cwd: repoRoot,
    provider,
    config,
    logger,
  });
  acceptanceReconciler.register();
  order.push('AcceptanceReconciler');

  // 3. Finalizer — opens the PR on acceptance.reconcile.ok or .waived
  //    (Story #2893 split waiver out of .skipped) via the bus-owned
  //    default (`composeBusOwnedFinalize`, Story #2894), which chains
  //    openOrLocatePr → closePlanningTickets → postHandoffComment and
  //    emits `epic.merge.ready` on success. The legacy
  //    `d1-default-no-op` blocker is gone; the listener constructed
  //    with no `runFinalizeFn` override always runs the real flow.
  //    The code-review / audit-results graduator steps (Stories
  //    #2555 / #2615) remain best-effort and are silently skipped
  //    when `provider` / `currentRepo` are not wired in. `currentRepo`
  //    is resolved from `config.github.{owner,repo}`; `frameworkRepo`
  //    from `config.github.frameworkRepo` when distinct, otherwise omitted.
  const currentRepo =
    config?.github?.owner && config?.github?.repo
      ? { owner: config.github.owner, repo: config.github.repo }
      : null;
  const frameworkRepo =
    config?.github?.frameworkRepo?.owner && config?.github?.frameworkRepo?.repo
      ? {
          owner: config.github.frameworkRepo.owner,
          repo: config.github.frameworkRepo.repo,
        }
      : null;
  const finalizer = new Finalizer({
    bus,
    epicId,
    cwd: repoRoot,
    provider,
    config,
    currentRepo,
    frameworkRepo,
    logger,
  });
  finalizer.register();
  order.push('Finalizer');

  // 4. AutomergeArmer — arms `gh pr merge --auto --squash --delete-branch`
  //    on epic.merge.ready.
  const automergeArmer = new AutomergeArmer({
    bus,
    cwd: repoRoot,
    logger,
  });
  automergeArmer.register();
  order.push('AutomergeArmer');

  // 5. AutomergePredicate — emits epic.merge.{ready,blocked} based on
  //    the runtime predicate evaluation. Requires a truthy `provider`;
  //    skip cleanly when the caller omitted one (lifecycle-emit CLI
  //    has no provider wired in by default).
  let automergePredicate = null;
  if (provider) {
    automergePredicate = new AutomergePredicate({
      bus,
      epicId,
      provider,
      logger,
    });
    automergePredicate.register();
    order.push('AutomergePredicate');
  } else {
    logger?.debug?.(
      '[lifecycle] buildDefaultListenerChain: skipping AutomergePredicate (no provider)',
    );
  }

  // 6. BranchCleaner — reaps story/epic branches on epic.cleanup.start.
  //    Requires a checkpointer exposing `read()`; skip cleanly when
  //    the caller omitted one.
  let branchCleaner = null;
  if (checkpointer && typeof checkpointer.read === 'function') {
    branchCleaner = new BranchCleaner({
      bus,
      epicId,
      checkpointer,
      cwd: repoRoot,
      logger,
    });
    branchCleaner.register();
    order.push('BranchCleaner');
  } else {
    logger?.debug?.(
      '[lifecycle] buildDefaultListenerChain: skipping BranchCleaner (no checkpointer)',
    );
  }

  // 7. Cleaner — archives temp/epic-<id>/ and emits the terminal
  //    epic.cleanup.start → .end → epic.complete sequence.
  const cleaner = new Cleaner({
    bus,
    epicId,
    tempRoot,
    logger,
  });
  cleaner.register();
  order.push('Cleaner');

  // 8. CheckpointPointerWriter — persists `{ lastCompletedSeqId, phase }`
  //    on every `*.end` event.
  const checkpointPointerWriter = new CheckpointPointerWriter({
    bus,
    epicId,
    tempRoot,
    logger,
  });
  checkpointPointerWriter.register();
  order.push('CheckpointPointerWriter');

  logger?.debug?.(
    `[lifecycle] buildDefaultListenerChain registered listeners: ${order.join(' → ')}`,
  );

  return {
    ledgerWriter,
    acceptanceReconciler,
    finalizer,
    automergeArmer,
    automergePredicate,
    branchCleaner,
    cleaner,
    checkpointPointerWriter,
    order,
  };
}
