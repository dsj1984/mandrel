/**
 * Facade over `lib/worktree/lifecycle/`. Submodules share state only through
 * the `ctx` bag `WorktreeManager` builds.
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
