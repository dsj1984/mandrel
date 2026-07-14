// .agents/scripts/lib/orchestration/lifecycle/listeners/index.js
/**
 * Default listener-chain builder for the standalone `lifecycle-emit`
 * CLI surface (Story #2510, Epic #2501).
 *
 * This is the SOLE production wiring path for the close-tail listener
 * roster. (The in-process `epic-runner/factory.js` that previously
 * mirrored this roster for an in-session runner was deleted with the
 * dead epic-runner stratum in Story #3908; the host-LLM-drives-CLIs
 * model reaches every close-tail listener through the `lifecycle-emit.js`
 * CLI shells in `/deliver`'s Phase 6 / 7.5 / 8 markdown invocations,
 * which call this builder.)
 *
 * Canonical roster (registration order):
 *   1. LedgerWriter            (privileged hooks via `register(bus)`)
 *   2. AutomergeArmer          (epic.merge.ready → epic.merge.armed)
 *   3. AutomergePredicate      (epic.watch.end → epic.merge.{ready,blocked})
 *   4. MergeWatcher            (epic.merge.armed → epic.merge.confirmed)
 *   5. LabelTransitioner       (epic.complete → ticket flips to agent::done)
 *   6. CheckpointPointerWriter (every *.end → checkpoint.json)
 *
 * The bus contract requires LedgerWriter first: its `onEmitted` hook
 * lands the `emitted` ledger record on disk BEFORE any listener body
 * executes, so a crash mid-chain leaves a recoverable trail.
 *
 * Listeners whose constructors require collaborators that are not
 * available outside the runner (e.g. AutomergePredicate's `provider`) are
 * SKIPPED with a debug log rather than constructed. Registration is
 * best-effort; the chain still wires every listener whose dependencies are
 * satisfiable.
 *
 * Signature: `buildDefaultListenerChain({ bus, ledgerPath, repoRoot })`.
 * The Tech Spec for Epic #2501 (§ Story 4) fixes the public shape at
 * those three keys. `ledgerPath` is decomposed into `tempRoot` and
 * `epicId` so the listener constructors receive what they need;
 * `repoRoot` threads through as `cwd` for listeners that shell out.
 *
 * Maintainability exemption (refs #3685): this module is listed under
 * `delivery.quality.gates.maintainability.ignoreGlobs` in `.agentrc.json`.
 * Its sole content is a linear, low-branching listener-registration
 * sequence; the maintainability index mis-gauges that shape (the same
 * reason the declarative `config-settings-schema*` files are exempt).
 * Splitting the sequence across sibling builder modules purely to clear
 * the floor would add indirection without making the wiring easier to
 * read, so the debt is carried explicitly here rather than hidden behind
 * a blanket low floor.
 */

import path from 'node:path';

import { createLedgerWriter } from '../ledger-writer.js';
import { AutomergeArmer } from './automerge-armer.js';
import { AutomergePredicate } from './automerge-predicate.js';
import { CheckpointPointerWriter } from './checkpoint-pointer-writer.js';
import { LabelTransitioner } from './label-transitioner.js';
import { MergeWatcher } from './merge-watcher.js';

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
 * @param {object} [opts.config] Resolved agent config. Forwarded to surviving
 *   listeners that consult delivery settings.
 * @param {object} [opts.logger] Logger surface (`debug`/`warn`/`error`).
 * @param {boolean} [opts.headless] Explicit must-land signal (Story
 *   #4427), threaded straight through to `MergeWatcher`. Defaults to
 *   `false` (attended-mode behavior unchanged). `lifecycle-emit.js`
 *   resolves this from its own `--headless` runtime flag — an explicit
 *   input, never an ambient global.
 *
 * @returns {Promise<{
 *   ledgerWriter: object,
 *   automergeArmer: object,
 *   automergePredicate: object|null,
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
    logger = console,
    headless = false,
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

  // 2. AutomergeArmer — arms `gh pr merge --auto --squash --delete-branch`
  //    on epic.merge.ready. Story #4472: `headless` gates the direct-merge
  //    fallback's terminal escalation (a genuine arm failure emits
  //    `merge.unlanded` + `epic.blocked` in a `--yes` run instead of
  //    returning silently); `epicId` scopes the `merge.unlanded` ledger row.
  const automergeArmer = new AutomergeArmer({
    bus,
    epicId,
    cwd: repoRoot,
    headless,
    logger,
  });
  automergeArmer.register();
  order.push('AutomergeArmer');

  // 3. AutomergePredicate — emits epic.merge.{ready,blocked} based on
  //    the runtime predicate evaluation. Requires a truthy `provider`;
  //    skip cleanly when the caller omitted one (lifecycle-emit CLI
  //    has no provider wired in by default). `config` selects the
  //    `delivery.ci.autoMerge` posture (trust-ci default vs strict) and
  //    `cwd` (repoRoot) is where the live `gh pr checks --required`
  //    probe shells out (Story #4361).
  let automergePredicate = null;
  if (provider) {
    automergePredicate = new AutomergePredicate({
      bus,
      epicId,
      provider,
      config,
      cwd: repoRoot,
      headless,
      logger,
    });
    automergePredicate.register();
    order.push('AutomergePredicate');
  } else {
    logger?.debug?.(
      '[lifecycle] buildDefaultListenerChain: skipping AutomergePredicate (no provider)',
    );
  }

  // 4. MergeWatcher (Story #2896, Epic #2880) — polls `gh pr view`
  //    after `epic.merge.armed` until the PR's mergeCommit is
  //    non-null, then emits `epic.merge.confirmed`. Cleaner now
  //    waits on the confirmed event rather than the armed event so
  //    the Epic only transitions to its terminal state after the
  //    merge is actually observed on GitHub. Reads `intervalSeconds`
  //    and `maxBudgetSeconds` from `config.delivery.mergeWatch.*`
  //    when supplied; otherwise uses the listener's framework
  //    defaults (30s / 3600s).
  const mergeWatchConfig = config?.delivery?.mergeWatch ?? {};
  const mergeWatcher = new MergeWatcher({
    bus,
    epicId,
    tempRoot,
    cwd: repoRoot,
    intervalSeconds: mergeWatchConfig.intervalSeconds,
    maxBudgetSeconds: mergeWatchConfig.maxBudgetSeconds,
    headless,
    logger,
  });
  mergeWatcher.register();
  order.push('MergeWatcher');

  // 5. LabelTransitioner — flips the ticket to `agent::done` (and
  //    closes it as completed, idempotently) on the terminal
  //    `epic.complete` event. Requires a truthy `provider`; skip
  //    cleanly when the caller omitted one — the same guard pattern as
  //    AutomergePredicate. Restores the contract the Cleaner /
  //    BranchCleaner / MergeWatcher docstrings have referenced since
  //    the original listener was deleted with the epic-runner stratum
  //    (#3936): without this registration the flip had NO owner and
  //    cleanly-merged Epics stranded at `agent::executing`.
  let labelTransitioner = null;
  if (provider) {
    labelTransitioner = new LabelTransitioner({
      bus,
      epicId,
      provider,
      logger,
    });
    labelTransitioner.register();
    order.push('LabelTransitioner');
  } else {
    logger?.debug?.(
      '[lifecycle] buildDefaultListenerChain: skipping LabelTransitioner (no provider)',
    );
  }

  // 6. CheckpointPointerWriter — persists `{ lastCompletedSeqId, phase }`
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
    automergeArmer,
    automergePredicate,
    mergeWatcher,
    labelTransitioner,
    checkpointPointerWriter,
    order,
  };
}
