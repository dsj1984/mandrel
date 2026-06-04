/**
 * WorktreeManager — single authority over per-story git worktrees.
 *
 * This file is a thin facade over `lib/worktree/*`:
 *   - `lib/worktree/lifecycle-manager.js` — ensure / reap / list / gc / prune.
 *   - `lib/worktree/node-modules-strategy.js` — per-worktree / symlink / pnpm-store.
 *   - `lib/worktree/bootstrapper.js` — bootstrap-file copy.
 *   - `lib/worktree/inspector.js` — pure path + porcelain parsing helpers.
 *
 * External callers import `WorktreeManager` and `parseWorktreePorcelain` from
 * this module path; those exports are preserved verbatim so no other file in
 * the repo needs to change.
 *
 * No other script may call `git worktree` directly. All git calls flow
 * through the injected `ctx.git` (defaults to `./git-utils.js`). Paths are
 * resolved and asserted to live inside `repoRoot`, and callers cannot request
 * force removal; bounded internal fallbacks live in the lifecycle module.
 */

import path from 'node:path';
import * as defaultGit from './git-utils.js';
import { Logger } from './Logger.js';
import { assertPathContainment } from './path-security.js';
import {
  DEFAULT_WORKSPACE_FILES,
  provision as provisionWorkspace,
} from './workspace-provisioner.js';
import {
  maybeWarnWindowsPath,
  parseWorktreePorcelain,
} from './worktree/inspector.js';
import {
  ensure,
  gc,
  isSafeToRemove,
  list,
  pathFor,
  prune,
  reap,
  sweepStaleLocks,
} from './worktree/lifecycle-manager.js';

export { parseWorktreePorcelain };

export class WorktreeManager {
  /**
   * @param {object} opts
   * @param {string} opts.repoRoot        Absolute path to the main repo.
   * @param {object} [opts.config]        Resolved `orchestration.worktreeIsolation` config.
   * @param {object} [opts.logger]        Logger with info/warn/error (defaults to console-style).
   * @param {object} [opts.git]           Injected `{ gitSync, gitSpawn }` (defaults to git-utils).
   * @param {NodeJS.Platform} [opts.platform]  Defaults to `process.platform`.
   * @param {(phase: 'worktree-create'|'bootstrap'|'install') => void} [opts.onPhase]
   *   Optional phase-boundary callback fired from `ensure()` just before each
   *   internal phase (git worktree add, bootstrap-file copy, dependency
   *   install). Consumed by `story-init` to drive `phase-timer.mark()`
   *   so `[phase-timing]` log lines attribute wall-clock correctly to the
   *   sub-phases of worktree provisioning.
   */
  constructor({
    repoRoot,
    config = {},
    logger,
    git = defaultGit,
    platform = process.platform,
    fsRm,
    onPhase,
  }) {
    if (!repoRoot || typeof repoRoot !== 'string') {
      throw new Error('WorktreeManager: repoRoot is required');
    }
    this.repoRoot = path.resolve(repoRoot);
    this.config = {
      root: '.worktrees',
      nodeModulesStrategy: 'per-worktree',
      bootstrapFiles: DEFAULT_WORKSPACE_FILES.slice(),
      ...config,
    };
    this.logger = logger ?? {
      info: (m) => Logger.info(`[WorktreeManager] ${m}`),
      warn: (m) => Logger.warn(`[WorktreeManager] ⚠️ ${m}`),
      error: (m) => Logger.error(`[WorktreeManager] ❌ ${m}`),
    };
    this.git = git;
    this.platform = platform;
    this.fsRm = fsRm;
    this.onPhase = typeof onPhase === 'function' ? onPhase : null;

    const resolvedRoot = path.resolve(this.repoRoot, this.config.root);
    try {
      assertPathContainment(this.repoRoot, resolvedRoot, 'worktreeRoot');
    } catch {
      throw new Error(
        `WorktreeManager: worktreeRoot escapes repoRoot (root=${this.config.root})`,
      );
    }
    this.worktreeRoot = resolvedRoot;

    /** @type {{ list: Array|null, ts: number }} */
    this._worktreeListCache = { list: null, ts: 0 };
  }

  /**
   * Build the context bag shared by every lifecycle helper. Regenerated on
   * each call so mutating `this.config` between calls is respected, but the
   * cache slot is a stable object so all helpers see the same list.
   */
  _ctx() {
    return {
      repoRoot: this.repoRoot,
      config: this.config,
      logger: this.logger,
      git: this.git,
      platform: this.platform,
      worktreeRoot: this.worktreeRoot,
      listCache: this._worktreeListCache,
      fsRm: this.fsRm,
      onPhase: this.onPhase,
      maybeWarnWindowsPath: (wtPath) =>
        maybeWarnWindowsPath(
          {
            platform: this.platform,
            // Hardcoded post-reshape (Epic #1720 Story #1739). The value
            // tracks Windows MAX_PATH minus headroom for the worktree's own
            // path overhead — not a domain knob operators tune.
            threshold: 240,
            logger: this.logger,
          },
          wtPath,
        ),
      copyBootstrapFiles: (wtPath) => {
        const files = this.config?.bootstrapFiles;
        if (!Array.isArray(files) || files.length === 0) return;
        const wrapped = {
          info: (m) =>
            this.logger.info(
              String(m).replace(
                /^workspace-provisioner:/,
                'worktree.bootstrap',
              ),
            ),
          warn: (m) =>
            this.logger.warn(
              String(m).replace(
                /^workspace-provisioner:/,
                'worktree.bootstrap',
              ),
            ),
          error: (m) =>
            this.logger.error(
              String(m).replace(
                /^workspace-provisioner:/,
                'worktree.bootstrap',
              ),
            ),
        };
        return provisionWorkspace({
          sourceRoot: this.repoRoot,
          targetWorktree: wtPath,
          files,
          logger: wrapped,
        });
      },
    };
  }

  /** Absolute path for a given storyId. */
  pathFor(storyId) {
    return pathFor(this._ctx(), storyId);
  }

  /**
   * True when this manager was constructed with `config.enabled === false`.
   * The mutating lifecycle methods (`ensure`, `reap`, `gc`, `sweepStaleLocks`)
   * short-circuit to no-op shapes in that case so the off-branch never
   * touches fs or git regardless of caller-side gating drift.
   */
  _isDisabled() {
    return this.config?.enabled === false;
  }

  /**
   * Idempotently ensure a worktree exists at `.worktrees/story-<id>/` on `branch`.
   *
   * @param {number|string} storyId
   * @param {string} branch
   */
  ensure(storyId, branch) {
    if (this._isDisabled()) {
      return {
        path: null,
        created: false,
        skipped: true,
        reason: 'isolation-disabled',
      };
    }
    return ensure(this._ctx(), storyId, branch);
  }

  /** Enumerate all worktrees known to git. */
  list() {
    return list(this._ctx());
  }

  /** Check whether a worktree is safe to remove. */
  isSafeToRemove(wtPath, opts) {
    return isSafeToRemove(this._ctx(), wtPath, opts);
  }

  /** Prune stale git worktree registrations for directories that no longer exist. */
  prune() {
    return prune(this._ctx());
  }

  /** Remove the worktree for a given storyId. Rejects caller-requested force. */
  reap(storyId, opts) {
    if (this._isDisabled()) {
      return {
        removed: false,
        skipped: true,
        reason: 'isolation-disabled',
        path: null,
      };
    }
    return reap(this._ctx(), storyId, opts);
  }

  /** Sweep abandoned worktrees not in `openStoryIds`. */
  gc(openStoryIds, opts) {
    if (this._isDisabled()) {
      return { reaped: [], skipped: [], skippedReason: 'isolation-disabled' };
    }
    return gc(this._ctx(), openStoryIds, opts);
  }

  /** Sweep stale `*.lock` files under the shared `.git/` dir. */
  sweepStaleLocks(opts) {
    if (this._isDisabled()) {
      return { removed: [], skipped: [], skippedReason: 'isolation-disabled' };
    }
    return sweepStaleLocks(this._ctx(), opts);
  }
}
