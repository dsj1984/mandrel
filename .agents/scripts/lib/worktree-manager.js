/**
 * WorktreeManager — the single authority over per-story git worktrees, a
 * facade over `lib/worktree/*`. No other script may call `git worktree`.
 * Paths are asserted inside `repoRoot` and callers cannot request force
 * removal.
 */

import path from 'node:path';
import * as defaultGit from './git-utils.js';
import { Logger } from './Logger.js';
import { assertPathContainment } from './path-security.js';
import {
  DEFAULT_WORKSPACE_FILES,
  provision as provisionWorkspace,
} from './workspace-provisioner.js';
import { materializeGitHooks } from './worktree/git-hooks.js';
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
   * @param {string} opts.repoRoot
   * @param {object} [opts.config]        Resolved `orchestration.worktreeIsolation` config.
   * @param {object} [opts.logger]
   * @param {object} [opts.git]           Injected `{ gitSync, gitSpawn }`.
   * @param {NodeJS.Platform} [opts.platform]
   * @param {(phase: 'worktree-create'|'bootstrap'|'install') => void} [opts.onPhase]
   *   Fired before each `ensure()` phase, for wall-clock attribution.
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
   * Rebuilt per call so config mutations are seen; the cache slot is stable.
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
            // Windows MAX_PATH minus headroom; not an operator knob.
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
      provisionGitHooks: (wtPath) => {
        const result = materializeGitHooks({
          repoRoot: this.repoRoot,
          worktree: wtPath,
          gitImpl: this.git,
        });
        this.logger.info(
          result.action === 'materialized'
            ? `worktree.bootstrap hooks materialized path=${result.target} hooks=${result.hooks.length}`
            : `worktree.bootstrap hooks skipped reason=${result.reason}`,
        );
        return result;
      },
    };
  }

  pathFor(storyId) {
    return pathFor(this._ctx(), storyId);
  }

  /**
   * When disabled, mutating methods return no-op shapes and never touch fs or
   * git, whatever the caller's gating.
   */
  _isDisabled() {
    return this.config?.enabled === false;
  }

  /**
   * Idempotent.
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

  list() {
    return list(this._ctx());
  }

  isSafeToRemove(wtPath, opts) {
    return isSafeToRemove(this._ctx(), wtPath, opts);
  }

  prune() {
    return prune(this._ctx());
  }

  /** Rejects caller-requested force. */
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
