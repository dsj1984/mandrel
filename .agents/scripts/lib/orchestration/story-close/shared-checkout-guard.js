/**
 * shared-checkout-guard.js — cross-epic contention guard for the merge
 * phase's `git checkout <epicBranch>` in the shared main checkout
 * (Story #4460).
 *
 * `story-close.js`'s merge phase (`runFinalizeMerge` in `merge-runner.js`)
 * runs `git checkout <epicBranch>` directly in the shared main repo
 * checkout — `close-inputs.js` resolves `cwd` to `PROJECT_ROOT`, not an
 * isolated worktree. The only exclusivity guard around that shared
 * checkout is the per-Epic `epic-merge-lock.js` mutex, which only
 * serializes concurrent runs for the SAME epic. Nothing stops a
 * DIFFERENT epic's concurrently-running `story-close.js` from treating
 * the same shared checkout as scratch space at the same time.
 *
 * This was observed live: while delivering Epic #4425 Stories #4427/#4428,
 * the shared checkout repeatedly carried uncommitted stray changes
 * belonging to a concurrently-running Epic #4405 delivery (parked on
 * `epic/4405` with dirty edits), which blocked the `git checkout epic/4425`
 * merge step with a raw `error: Your local changes ... would be
 * overwritten by checkout`.
 *
 * `assertSharedCheckoutAvailable` runs immediately before that checkout
 * and fails fast with an actionable, story-close-specific diagnostic
 * instead of letting the raw git error surface. It COMPOSES with (does
 * not replace) the per-Epic lock: by the time this guard runs, the
 * caller's own epic lock is already held (acquired around the whole
 * close flow in `story-close.js`), so this guard only inspects OTHER
 * epics' lock files plus the tree's overall dirty state — it never
 * contends with same-epic concurrent runs, which continue to serialize
 * solely via `withEpicMergeLock` before this guard ever executes.
 *
 * Breadth trade-off (deliberate): the foreign-lock probe keys on the
 * OTHER epic's per-epic merge lock, which that run holds for its WHOLE
 * close flow — so any overlapping story-close of another epic trips this
 * guard even when that run never actually touches the shared checkout
 * during the overlap. The refusal is deterministic and loud (throws with
 * a diagnostic naming the holder pid), never a deadlock (no waiting),
 * and stale/dead-pid foreign locks are ignored via the pid-liveness
 * probe. Narrowing the window (a dedicated checkout-phase lock) was
 * considered and rejected: the coarse refusal is rare, cheap to retry,
 * and far simpler than a second lock tier.
 */

import { findForeignActiveEpicLock as defaultFindForeignActiveEpicLock } from '../../epic-merge-lock.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';

const MAX_LISTED_DIRTY_FILES = 20;

function describeForeignLock(foreign) {
  const acquired = Number.isFinite(foreign.acquiredAt)
    ? new Date(foreign.acquiredAt).toISOString()
    : 'an unknown time';
  return (
    `[story-close] shared-checkout guard: refusing to touch the shared main checkout — ` +
    `it is currently held by epic #${foreign.epicId}'s story-close merge phase ` +
    `(lock ${foreign.filePath}, pid ${foreign.pid}, acquired ${acquired}). ` +
    `Wait for that epic's story-close run to finish before retrying this merge. ` +
    `If you have independently confirmed that process is no longer running, remove ` +
    `the lock file by hand — never force a checkout past a live foreign lock. ` +
    `See .agents/rules/git-conventions.md § Shared-checkout contention (Story #4460).`
  );
}

function listDirtyFiles(porcelainOutput) {
  // `git status --porcelain` lines are `XY <path>` — a fixed 2-char status
  // column, a space, then the path. Strip only a trailing `\r` (Windows)
  // before slicing off that 3-char prefix; trimming the whole line first
  // would shift the slice offset whenever the status column starts with a
  // space (the common "unstaged modification" case), truncating the path.
  const lines = porcelainOutput
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
  const shown = lines
    .slice(0, MAX_LISTED_DIRTY_FILES)
    .map((line) => line.slice(3).trim() || line);
  const overflow = lines.length - shown.length;
  return overflow > 0
    ? `${shown.join(', ')}, … (+${overflow} more)`
    : shown.join(', ');
}

function describeDirtyCheckout({ cwd, epicId, currentBranch, dirtyFiles }) {
  return (
    `[story-close] shared-checkout guard: refusing to check out the epic branch for ` +
    `epic #${epicId} — the shared main checkout at ${cwd} is dirty (currently on ` +
    `\`${currentBranch}\`). Dirty files: ${dirtyFiles}. This usually means another ` +
    `epic's story-close run left uncommitted work in the shared checkout, or a prior ` +
    `run crashed mid-merge. Resolve manually (stash/commit/reset in ${cwd}) before ` +
    `retrying. See .agents/rules/git-conventions.md § Shared-checkout contention ` +
    `(Story #4460).`
  );
}

/**
 * Fail fast when the shared main checkout is not safely available for this
 * epic's merge-phase `git checkout <epicBranch>` — either because another
 * epic's story-close merge phase currently holds it (a live foreign lock),
 * or because it is simply dirty (regardless of whose branch is checked
 * out). Silent no-op when the checkout is clean and uncontended.
 *
 * @param {{
 *   cwd: string,
 *   epicId: number|string,
 *   gitSpawn?: typeof defaultGitSpawn,
 *   findForeignActiveEpicLock?: typeof defaultFindForeignActiveEpicLock,
 * }} opts
 * @throws {Error} with an actionable, story-close-specific diagnostic.
 */
/**
 * Foreign-lock-only variant for the RESUME merge path (Story #4460
 * follow-up): a resume legitimately re-enters a shared checkout that is
 * dirty with THIS story's own in-progress merge, so the dirty-tree half
 * of `assertSharedCheckoutAvailable` would false-positive there. The
 * cross-epic hazard — another epic's live merge phase holding the
 * checkout — still applies and is the only probe this variant runs.
 */
export function assertNoForeignEpicLock({
  cwd,
  epicId,
  findForeignActiveEpicLock = defaultFindForeignActiveEpicLock,
}) {
  const foreign = findForeignActiveEpicLock(epicId, { repoRoot: cwd });
  if (foreign) {
    throw new Error(describeForeignLock(foreign));
  }
}

export function assertSharedCheckoutAvailable({
  cwd,
  epicId,
  gitSpawn = defaultGitSpawn,
  findForeignActiveEpicLock = defaultFindForeignActiveEpicLock,
}) {
  const foreign = findForeignActiveEpicLock(epicId, { repoRoot: cwd });
  if (foreign) {
    throw new Error(describeForeignLock(foreign));
  }

  const statusRes = gitSpawn(cwd, 'status', '--porcelain');
  if (statusRes.status !== 0) {
    // Can't determine dirtiness from here — let the downstream checkout
    // surface whatever git itself reports rather than guessing.
    return;
  }
  const porcelain = statusRes.stdout || '';
  if (porcelain.trim().length === 0) return;

  const branchRes = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const currentBranch =
    branchRes.status === 0
      ? (branchRes.stdout || '').trim() || 'unknown'
      : 'unknown';

  throw new Error(
    describeDirtyCheckout({
      cwd,
      epicId,
      currentBranch,
      dirtyFiles: listDirtyFiles(porcelain),
    }),
  );
}
