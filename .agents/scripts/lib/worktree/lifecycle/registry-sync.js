/**
 * worktree/lifecycle/registry-sync.js
 *
 * Worktree registry/cache helpers — lookup, list, prune, and the absolute-path
 * computation. Each helper accepts the shared lifecycle `ctx` bag holding
 * `repoRoot`, `git`, `platform`, `worktreeRoot`, and a mutable `listCache`
 * slot. Mutation is confined to `ctx.listCache`.
 */

import path from 'node:path';
import { parseWorktreePorcelain, samePath } from '../inspector.js';
import { validateStoryId } from './shared.js';

/**
 * Resolve the absolute worktree path for a given `storyId`. Accepts an
 * optional `{ git }` opts bag for API symmetry with `getWorktreeList`; the
 * path computation is pure and does not touch git, so the override is
 * accepted and ignored.
 *
 * @param {object} ctx
 * @param {number|string} storyId
 * @param {{ git?: object }} [_opts]
 */
export function pathFor(ctx, storyId, _opts = {}) {
  const n = validateStoryId(storyId);
  return path.join(ctx.worktreeRoot, `story-${n}`);
}

/**
 * Returns the cached worktree-list, re-running `git worktree list --porcelain`
 * when the cache is cold or older than 5s.
 *
 * The optional `git` override lets tests (or alternative runtime contexts)
 * inject a fake git interface without having to build the whole `ctx` bag.
 * When omitted, falls back to `ctx.git`, preserving the existing default.
 *
 * @param {object} ctx
 * @param {{ git?: { gitSpawn: Function } }} [opts]
 */
export function getWorktreeList(ctx, { git } = {}) {
  const now = Date.now();
  if (ctx.listCache.list && now - ctx.listCache.ts < 5_000) {
    return ctx.listCache.list;
  }
  const gitImpl = git ?? ctx.git;
  const res = gitImpl.gitSpawn(ctx.repoRoot, 'worktree', 'list', '--porcelain');
  if (res.status !== 0) return [];
  const parsed = parseWorktreePorcelain(res.stdout);
  ctx.listCache.list = parsed;
  ctx.listCache.ts = now;
  return parsed;
}

/**
 * Drop the cached worktree list. Accepts an optional `{ git }` opts bag for
 * API symmetry with `getWorktreeList`; the cache-invalidation itself does
 * not touch git, so the override is accepted and ignored.
 *
 * @param {object} ctx
 * @param {{ git?: object }} [_opts]
 */
export function invalidateWorktreeCache(ctx, _opts = {}) {
  ctx.listCache.list = null;
  ctx.listCache.ts = 0;
}

/**
 * Find a worktree record by its absolute path. Uses the shared cache via
 * `getWorktreeList`, so repeated calls within the 5-second TTL are free.
 *
 * @param {object} ctx - Lifecycle context bag (`repoRoot`, `git`, `platform`,
 *   `worktreeRoot`, `listCache`).
 * @param {string} absPath - Absolute filesystem path to match against the
 *   `path` field of each worktree record.
 * @returns {{ path: string, head: string|null, branch: string|null, bare: boolean, detached: boolean }|null}
 *   The matching worktree record, or `null` when no worktree lives at that path.
 */
export function findByPath(ctx, absPath) {
  return (
    getWorktreeList(ctx).find((r) => samePath(r.path, absPath, ctx.platform)) ??
    null
  );
}

/**
 * Unconditionally run `git worktree list --porcelain` and return the parsed
 * result. Unlike `getWorktreeList`, this bypasses the `listCache` and always
 * queries git — use it when a fresh snapshot is required (e.g. immediately
 * after an add/remove). Throws on non-zero git exit.
 *
 * @param {object} ctx - Lifecycle context bag (`repoRoot`, `git`, `platform`,
 *   `worktreeRoot`, `listCache`).
 * @returns {Promise<Array<{ path: string, head: string|null, branch: string|null, bare: boolean, detached: boolean }>>}
 */
export async function list(ctx) {
  const res = ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'list', '--porcelain');
  if (res.status !== 0) {
    throw new Error(`WorktreeManager: git worktree list failed: ${res.stderr}`);
  }
  return parseWorktreePorcelain(res.stdout);
}

/**
 * Run `git worktree prune` against the repo root and invalidate the list
 * cache on success. Returns a result object rather than throwing on failure
 * so callers can decide how to handle a partial prune.
 *
 * @param {object} ctx - Lifecycle context bag (`repoRoot`, `git`, `platform`,
 *   `worktreeRoot`, `listCache`).
 * @returns {{ pruned: true } | { pruned: false, reason: string }}
 *   `{ pruned: true }` when git exited 0; `{ pruned: false, reason }` with
 *   the stderr/stdout text (or `'worktree-prune-failed'`) otherwise.
 */
export function prune(ctx) {
  const res = ctx.git.gitSpawn(ctx.repoRoot, 'worktree', 'prune');
  if (res.status !== 0) {
    return {
      pruned: false,
      reason: res.stderr || res.stdout || 'worktree-prune-failed',
    };
  }
  invalidateWorktreeCache(ctx);
  return { pruned: true };
}
