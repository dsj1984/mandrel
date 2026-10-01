/**
 * phases/worktree-restore.js — the Story worktree a close or a `--wait`
 * resume runs in, recreated from `story-<id>` when missing. Never falls back
 * to the main checkout while isolation is enabled.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { resolveWorktreeEnabled } from '../../../config/runtime.js';
import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import { Logger } from '../../../Logger.js';
import { WorktreeManager as DefaultWorktreeManager } from '../../../worktree-manager.js';

/** `<cwd>/<root>/story-<id>` when it exists on disk, else `null`. */
export function existingWorktreePath({
  cwd,
  wtIsolation,
  storyId,
  existsSync = nodeFs.existsSync,
}) {
  const root = wtIsolation?.root ?? '.worktrees';
  const candidate = path.resolve(cwd, root, `story-${storyId}`);
  return existsSync(candidate) ? candidate : null;
}

/** Fetch `story-<id>` from origin when no local ref exists; throws on failure. */
function ensureLocalStoryRef({ cwd, storyBranch, gitSpawn, progress }) {
  const local = gitSpawn(
    cwd,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${storyBranch}`,
  );
  if (local.status === 0) return;
  progress('WORKTREE', `Fetching origin ${storyBranch} (no local ref)...`);
  const fetched = gitSpawn(
    cwd,
    'fetch',
    'origin',
    `${storyBranch}:${storyBranch}`,
  );
  if (fetched.status !== 0) {
    throw new Error(
      `[worktree-restore] cannot recreate the ${storyBranch} worktree: no local ref, ` +
        `and \`git fetch origin ${storyBranch}\` failed: ${String(fetched.stderr ?? '').trim() || '(no stderr)'}`,
    );
  }
}

/**
 * The existing worktree, a recreated one, or `null` when isolation is off
 * and none exists. `cwd` is the MAIN checkout.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveStoryWorktree({
  cwd,
  config,
  storyId,
  storyBranch,
  progress,
  gitSpawn = defaultGitSpawn,
  WorktreeManager = DefaultWorktreeManager,
  existsSync,
  env = process.env,
}) {
  const wtIsolation = config?.delivery?.worktreeIsolation;
  const existing = existingWorktreePath({
    cwd,
    wtIsolation,
    storyId,
    ...(existsSync ? { existsSync } : {}),
  });
  if (existing) return existing;
  if (!resolveWorktreeEnabled({ config }, env)) return null;
  ensureLocalStoryRef({ cwd, storyBranch, gitSpawn, progress });
  const wm = new WorktreeManager({
    repoRoot: cwd,
    config: wtIsolation,
    logger: {
      info: (m) => progress('WORKTREE', m),
      warn: (m) => progress('WORKTREE', `⚠️ ${m}`),
      error: (m) => Logger.error(`[worktree-restore] ${m}`),
    },
  });
  const ensured = await wm.ensure(storyId, storyBranch);
  if (!ensured?.path) {
    throw new Error(
      `[worktree-restore] worktree isolation is enabled but the ${storyBranch} worktree ` +
        `could not be recreated (${ensured?.reason ?? 'no path returned'}) — refusing to run in the main checkout.`,
    );
  }
  progress(
    'WORKTREE',
    `♻️  Recreated the missing ${storyBranch} worktree at ${ensured.path}.`,
  );
  return ensured.path;
}
