/**
 * worktree/bootstrapper.js
 *
 * File-copy helpers that prepare a freshly added worktree for the agent
 * (bootstrap files like `.env`). Under the npm-package distribution model
 * `.agents/` is a materialized, tracked directory in every checkout, so there
 * is no gitlink to scrub and no submodule snapshot to copy at create/reap time.
 *
 * All helpers receive an explicit `ctx` bag so they can be unit-tested without
 * instantiating `WorktreeManager`.
 */

import { provision } from '../workspace-provisioner.js';

/**
 * Copy untracked bootstrap files (default `.env`) from the repo
 * root into a freshly created worktree. Delegates to the central
 * `WorkspaceProvisioner`; kept as a named export so existing call sites keep
 * working.
 *
 * @param {{ repoRoot: string, config: { bootstrapFiles?: string[] }, logger: object }} ctx
 * @param {string} wtPath
 */
export function copyBootstrapFiles(ctx, wtPath) {
  const files = ctx.config?.bootstrapFiles;
  if (!Array.isArray(files) || files.length === 0) return;
  const logger = wrapBootstrapLogger(ctx.logger);
  provision({
    sourceRoot: ctx.repoRoot,
    targetWorktree: wtPath,
    files,
    logger,
  });
}

/**
 * Translate provisioner log lines into the `worktree.bootstrap …` prefix that
 * existing operators and log scrapers rely on.
 */
function wrapBootstrapLogger(inner) {
  const rewrite = (msg) =>
    String(msg).replace(/^workspace-provisioner:/, 'worktree.bootstrap');
  return {
    info: (m) => inner.info(rewrite(m)),
    warn: (m) => inner.warn(rewrite(m)),
    error: (m) => inner.error(rewrite(m)),
  };
}
