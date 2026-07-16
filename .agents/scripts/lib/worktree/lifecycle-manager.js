/**
 * worktree/lifecycle-manager.js — facade (Story 15, Epic #773).
 *
 * Public surface preserved byte-identically. Implementations live under
 * `lib/worktree/lifecycle/`:
 *
 *   - `creation.js`         — `ensure`
 *   - `registry-sync.js`    — `pathFor`, `list`, `prune`, `getWorktreeList`,
 *                             `invalidateWorktreeCache`, `findByPath`
 *   - `reap.js`             — `isSafeToRemove`,
 *                             `removeWorktreeWithRecovery`, `reap`
 *   - `gc.js`               — `gc`
 *   - `drift-detection.js`  — `sweepStaleLocks`
 *   - `pending-cleanup.js`  — `recordPendingCleanup`, `drainPendingCleanup`,
 *                             and the `.worktrees/.pending-cleanup.json`
 *                             manifest reader/writer
 *
 * Cross-submodule data flows exclusively through the explicit `ctx` bag built
 * by `WorktreeManager` (see `lib/worktree-manager.js`). Imports between
 * submodules are limited to pure function composition — e.g. `gc` calling
 * `reap` and `list` — so no submodule reaches into another's state.
 */

export { ensure } from './lifecycle/creation.js';
export { sweepStaleLocks } from './lifecycle/drift-detection.js';
export { gc } from './lifecycle/gc.js';
export {
  isSafeToRemove,
  reap,
  removeWorktreeWithRecovery,
} from './lifecycle/reap.js';
export {
  findByPath,
  getWorktreeList,
  invalidateWorktreeCache,
  list,
  pathFor,
  prune,
} from './lifecycle/registry-sync.js';
