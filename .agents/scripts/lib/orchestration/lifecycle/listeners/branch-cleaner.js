// .agents/scripts/lib/orchestration/lifecycle/listeners/branch-cleaner.js
/**
 * BranchCleaner — lifecycle listener that owns post-merge **branch** reap
 * for `/deliver`. Story #2398 (companion to Cleaner, which owns the
 * temp-tree archival half of end-of-Epic cleanup).
 *
 * Subscribes to:
 *   - `epic.cleanup.start` → and ONLY this event.
 *
 * Why `epic.cleanup.start` and not `epic.merge.armed`:
 *   Cleaner subscribes to `epic.merge.armed` and is the source of the
 *   `epic.cleanup.start → epic.cleanup.end → epic.complete` terminal
 *   sequence. The Bus runs listeners awaited and in registration order,
 *   so a BranchCleaner registered on `epic.cleanup.start` BEFORE Cleaner
 *   registers on `epic.merge.armed` will run synchronously inside
 *   Cleaner's emit chain, between the start and end events, and crucially
 *   BEFORE Cleaner's archive rename moves `temp/epic-<id>/` to
 *   `temp/archive/epic-<id>-<ts>/`. The state checkpoint that we read to
 *   enumerate Story branches lives on the Epic Issue (as the
 *   `epic-run-state` structured comment), not under `temp/`, so the
 *   ordering above is for symmetry with the existing Cleaner contract
 *   — both halves of cleanup observe the same temp tree as it exists at
 *   `epic.cleanup.start`.
 *
 * Side effects executed inside `handle()`:
 *   1. Read the `epic-run-state` checkpoint via the injected
 *      `checkpointer`. Skip with classification `no-state` when the
 *      checkpoint is missing or carries no Stories (a brand-new run
 *      that armed without ever finalising a wave should never reach
 *      `epic.cleanup.start`, but the guard keeps this listener
 *      idempotent under replay).
 *   2. Call `reapEpicBranches()` from `lib/orchestration/epic-cleanup.js`,
 *      which:
 *      - switches the main checkout off `epic/<id>` to the baseBranch
 *        when needed (so `git branch -D epic/<id>` isn't refused);
 *      - removes attached worktrees with the Windows file-lock fallback
 *        (worktree-remove → worktree-remove --force → fs.rm + prune);
 *      - deletes every `story-<id>` branch listed in the checkpoint plus
 *        the `epic/<id>` branch itself;
 *      - runs `git remote prune` to drop stale `<remote>/...` tracking
 *        refs left behind by `gh pr merge --delete-branch`;
 *      - deletes the `wt-branch` scratch ref left by `story-close.js`'s
 *        internal merge worktree when it is no longer checked out.
 *   3. Record one classification entry per invocation (`reaped`,
 *      `no-state`, `failed`, or `skipped-duplicate`) so failures surface
 *      in the lifecycle ledger alongside Cleaner's archival outcome.
 *
 * Idempotency contract: per-instance `Set<string>` of `${event}:${seqId}`
 * keys — repeat `(event, seqId)` invocation short-circuits and classifies
 * `skipped-duplicate`. Mirrors Cleaner's bus-level replay defence.
 *
 * Side-effect firewall: the listener mutates **local git state** (branch
 * refs, worktree paths, remote tracking refs) and nothing else. It does
 * NOT touch the temp tree, the ticketing provider (the checkpointer
 * `read()` is the only ticketing call and is read-only), or label state.
 * Label transitions stay with LabelTransitioner on `epic.complete`.
 *
 * Production failure mode: `reapEpicBranches()` aggregates per-branch
 * failures into the result envelope rather than throwing — a single
 * branch that won't reap (e.g. because the operator stashed unmerged
 * work onto it) must not block the rest of cleanup. The listener
 * therefore records `failed` as a classification with the failure
 * summary; orchestration callers that want hard-stop semantics can
 * inspect the classifications. Programmer errors in the listener's own
 * inputs (missing bus / non-numeric epicId / missing checkpointer)
 * throw at construction time per
 * `.agents/rules/orchestration-error-handling.md`.
 */

import { rmSync as defaultRmSync } from 'node:fs';

import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import { reapEpicBranches } from '../../epic-cleanup.js';

/**
 * BranchCleaner listener.
 */
export class BranchCleaner {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {number} opts.epicId
   * @param {{ read: () => Promise<object|null> }} opts.checkpointer
   *   Object exposing `read()` returning the `epic-run-state` checkpoint
   *   shape (epicId + waves[].stories[].id). Production passes the
   *   stateless `epic-run-state-store` module bound to `{provider, epicId}`;
   *   tests pass a fake.
   * @param {string} opts.cwd - Absolute path to the **main** checkout
   *   (not a worktree). `reapEpicBranches()` runs `git checkout`,
   *   `git branch -D`, and `git remote prune` against this directory.
   * @param {string} [opts.baseBranch='main'] - Branch to switch the main
   *   checkout to before reaping `epic/<id>`.
   * @param {string} [opts.remote='origin'] - Remote to prune.
   * @param {Function} [opts.gitSpawn] - Injectable git spawner for tests.
   * @param {Function} [opts.rmSyncFn] - Injectable filesystem remove for
   *   the worktree Windows-lock fallback.
   * @param {Function} [opts.spawnFn] - Injectable process spawner forwarded
   *   to `reapEpicBranches` for the Story #3367 open-PR guard probe
   *   (`gh pr list --head epic/<id> --state open`). Defaults to the real
   *   `spawnSync` inside `epic-cleanup.js`; tests inject a stub.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError('BranchCleaner requires a bus with on() and emit()');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('BranchCleaner requires a numeric epicId');
    }
    if (!opts.checkpointer || typeof opts.checkpointer.read !== 'function') {
      throw new TypeError(
        'BranchCleaner requires a checkpointer exposing read()',
      );
    }
    if (typeof opts.cwd !== 'string' || opts.cwd.length === 0) {
      throw new TypeError('BranchCleaner requires a non-empty cwd string');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.checkpointer = opts.checkpointer;
    this.cwd = opts.cwd;
    this.baseBranch = opts.baseBranch ?? 'main';
    this.remote = opts.remote ?? 'origin';
    this.gitSpawn = opts.gitSpawn ?? defaultGitSpawn;
    this.rmSyncFn = opts.rmSyncFn ?? defaultRmSync;
    // Story #3367 — forwarded to reapEpicBranches' open-PR guard probe.
    // `undefined` lets epic-cleanup.js fall back to its real `spawnSync`.
    this.spawnFn = opts.spawnFn;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every `epic.cleanup.start` observed lands
     * here with the outcome (`reaped`, `no-state`, `failed`,
     * `skipped-duplicate`). Mirrors Cleaner's "no silent skip" surface.
     */
    this.classifications = [];
    // Frozen tuple — BranchCleaner subscribes to EXACTLY one event.
    this.events = Object.freeze(['epic.cleanup.start']);
  }

  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped-duplicate',
      });
      this.logger.debug?.(`[BranchCleaner] skip duplicate ${key} (idempotent)`);
      return;
    }
    this._seen.add(key);

    let state;
    try {
      state = await this.checkpointer.read();
    } catch (err) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `checkpoint-read-failed:${err?.message ?? err}`,
      });
      this.logger.warn?.(
        `[BranchCleaner] checkpoint read failed: ${err?.message ?? err}`,
      );
      return;
    }

    if (!state || !Number.isInteger(state.epicId) || state.epicId < 1) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'no-state',
        reason: 'checkpoint-absent-or-empty',
      });
      this.logger.info?.(
        '[BranchCleaner] no epic-run-state checkpoint; nothing to reap.',
      );
      return;
    }

    const result = reapEpicBranches({
      state,
      cwd: this.cwd,
      gitSpawn: this.gitSpawn,
      rmSyncFn: this.rmSyncFn,
      baseBranch: this.baseBranch,
      remote: this.remote,
      spawnFn: this.spawnFn,
      logger: this.logger,
    });

    const summary = summarizeReap(result);
    if (result.ok) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'reaped',
        epicId: result.epicId,
        ...summary,
      });
      this.logger.info?.(
        `[BranchCleaner] reaped ${summary.branchesDeleted} branch(es) + ${summary.worktreesRemoved} worktree(s) for epic/${result.epicId}`,
      );
    } else {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: 'reap-failures',
        epicId: result.epicId,
        ...summary,
        failures: result.failures.map((f) => ({
          branch: f.branch,
          stderr: f.stderr ?? null,
        })),
      });
      this.logger.warn?.(
        `[BranchCleaner] ${result.failures.length} branch(es) failed to reap for epic/${result.epicId}`,
      );
    }
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}

/**
 * Pure: condense a `reapEpicBranches()` result into the counts that the
 * classification log carries. Exported for tests.
 *
 * @param {{ reaped: Array<object>, pruned: { pruned: string[] }|null, wtBranch: { deleted: boolean }|null }} result
 * @returns {{ branchesDeleted: number, worktreesRemoved: number, tracksPruned: number, wtBranchDeleted: boolean }}
 */
export function summarizeReap(result) {
  const reaped = Array.isArray(result?.reaped) ? result.reaped : [];
  return {
    branchesDeleted: reaped.filter((r) => r.branchDeleted).length,
    worktreesRemoved: reaped.filter(
      (r) => r.worktreeReaped && r.method !== 'no-worktree',
    ).length,
    tracksPruned: result?.pruned?.pruned?.length ?? 0,
    wtBranchDeleted: result?.wtBranch?.deleted === true,
  };
}
