---
description: >-
  Per-story git worktree isolation model — configuration, lifecycle,
  node_modules strategies, Windows notes, fallback mode, and human-reviewer
  guidance.
---

# Worktree-per-Story Lifecycle

Parallel epic execution can race when multiple story agents share one working
tree: rapid `git checkout` swaps cause `git add` to sweep another agent's WIP
into the wrong commit. Epic #229 moves each dispatched story into its own
`git worktree` at `.worktrees/story-<id>/` so branch swaps, staging, and reflog
activity are isolated per-story. The main checkout stays quiet.

This document is the operator and reviewer reference. See
[`epic-execute`](epic-execute.md) and [`story-deliver`](story-deliver.md)
for the broader execution flow and the Epic-229 Tech Spec for
architectural rationale.

## Configuration

All knobs live under `delivery.worktreeIsolation` in `.agentrc.json`:

```jsonc
{
  "orchestration": {
    "worktreeIsolation": {
      "enabled": true, // master switch; false = single-tree (v5.5.1)
      "root": ".worktrees", // relative to repo root; must stay inside it
      "nodeModulesStrategy": "per-worktree", // per-worktree | symlink | pnpm-store
      "primeFromPath": null, // required when strategy = "symlink"
      "allowSymlinkOnWindows": false, // explicit opt-in for symlink on win32
      "reapOnSuccess": true, // remove worktree after successful story merge
      "reapOnCancel": true, // remove worktree when story is cancelled
      "windowsPathLengthWarnThreshold": 240, // pre-flight warning threshold (MAX_PATH=260)
    },
  },
}
```

The schema is validated by `config-resolver.js`. Unknown strategies, `root`
values that escape the repo root, and shell-metacharacter injection in `root`
are all rejected at config-load time.

## Lifecycle

| Phase           | When                                                                          | What happens                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sweep**       | Dispatch-manifest build (`/epic-plan`) and `/epic-deliver` | Stale `*.lock` files under `.git/` (older than 5 min) are removed before GC.                                                                                |
| **GC**          | Dispatch-manifest build (`/epic-plan`) and `/epic-deliver` | Orphan `.worktrees/story-*` whose stories are closed are reaped if clean.                                                                                   |
| **Force-drain** | `/epic-plan` boot (`worktree-sweep.js` via `drainPendingCleanupAtBoot`), `story-close` post-merge (`forceDrainPendingCleanup`), `/epic-deliver` Phase 7 | Retries `.worktrees/.pending-cleanup.json` (`git worktree remove` then `fs.rm`); Windows-only escalation enumerates user-mode handle holders and `taskkill`s them before re-trying. |
| **Ensure**      | `story-init` (entry for `/story-deliver`)                  | `git worktree add .worktrees/story-<id>/` on the `story-<id>` branch.                                                                                       |
| **Run**         | During story execution                                                        | Agent runs inside the worktree; HEAD/reflog activity is isolated.                                                                                           |
| **Reap**        | After successful story merge (in `story-close`)                              | `git worktree remove` — refuses to delete dirty trees or unmerged branches.                                                                                 |

The `WorktreeManager` (`.agents/scripts/lib/worktree-manager.js`) is the single
authority for `ensure`, `reap`, `list`, `isSafeToRemove`, `gc`, `prune`, and
`sweepStaleLocks`. No other script may call `git worktree` directly.

Managed story worktrees are only eligible for `reap`/`gc` when the caller
provides the expected Epic branch, so cleanup cannot silently skip the merge
verification step.

### Stale-lock sweep

Even with per-story worktree isolation, the main repo's `.git/` dir is shared
state — `git worktree add/remove/prune`, `fetch`, auto-gc, and VSCode's git
extension all touch it. A crashed orchestrator can leave an orphaned
`.git/index.lock` (or `HEAD.lock`, `packed-refs.lock`, per-worktree
`index.lock`, etc.) that blocks the next run with a "another git process seems
to be running" error.

`sweepStaleLocks({ maxAgeMs = 300_000 })` removes well-known lock files whose
mtime exceeds the age threshold. Fresh locks (belonging to a legitimate
in-flight op) are skipped. It always runs immediately before `gc`, in the same
entry points (see table below).

### Sweep & GC entry points

Sweep and GC do **not** run at every Epic entry point — in particular,
`story-init` (the entry for `/story-deliver`) does not invoke them. The full
set of callers is:

| Entry point                                                           | Script / caller                                           | Runs sweep? | Runs GC? | Force-drain? | Notes                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | -------- | ------------ | --------------------------------------------------------------------------------------------------- |
| Dispatch manifest build (`/epic-plan` Phase 9)                        | `lib/orchestration/dispatch-pipeline.js::runWorktreeGc`   | ✅ Yes      | ✅ Yes   | ✅ Yes       | Called from `dispatch-engine.js::dispatch()`. Scoped to the epic being dispatched.                  |
| Spec / decompose CLI boot (`/epic-plan` helpers)                      | `drainPendingCleanupAtBoot` → `worktree-sweep.js`        | ✅ Yes*     | ❌ No    | ✅ Yes       | \*Drains the pending ledger then reaps `git worktree list` entries for done/closed Stories (`--force`). |
| Story merge (`/story-deliver` close)                                  | `story-close.js` (`drainPendingCleanupAfterClose`) | ❌ No       | ❌ No    | ✅ Yes       | Runs after the post-merge pipeline when worktree isolation is enabled.                              |
| Story close                                                           | `epic-deliver runner` (invoked by `story-close.js`)    | ✅ Yes      | ✅ Yes   | ✅ Yes       | Runs before branch deletion so reaping cannot collide with `git branch -D`.                         |
| Story init (`/story-deliver <storyId>`)                               | `story-init.js`                                    | ❌ No       | ❌ No    | ❌ No        | Story execution relies on the dispatch/close pair to clean up; it only creates its own worktree.    |
| Epic deliver wave loop (`/epic-deliver`)                              | `/epic-deliver` slash command + `lib/orchestration/epic-runner/*` | ❌ No       | ❌ No    | ❌ No        | Does not call `sweepStaleLocks` or `gc` directly; cleanup still flows through dispatch + close.     |
| `/drain-pending-cleanup` (operator-driven)                            | `drain-pending-cleanup.js`                                | n/a         | n/a      | ✅ Yes       | Standalone helper; same drain + Windows escalation as the `/epic-plan` and `/epic-deliver` paths.     |

Operator takeaway: if you need to force a sweep/GC without closing a story,
the most direct path is re-running `/epic-plan` (or rebuilding the dispatch
manifest via `dispatcher.js`) against the active epic. Running
`/story-deliver <storyId>` on its own does **not** clean up orphan worktrees
or stale locks.

## `.agents` copy (consumer projects)

In consumer projects `.agents/` is declared as a git submodule in `.gitmodules`.
When `git worktree add` creates `.worktrees/story-<id>/`, the worktree carries
its own gitlink entry for `.agents`, and `git worktree remove` then refuses to
reap it on the grounds that "there is a submodule inside the worktree."

`WorktreeManager.ensure()` resolves this at worktree creation by removing the
empty gitlink placeholder, recursively copying `<repoRoot>/.agents/` into the
worktree, and marking the `.agents` gitlink entry `skip-worktree` so routine
task commits do not accidentally stage submodule metadata changes. `reap()`
mirrors the teardown: clear `skip-worktree`, delete the copied directory, scrub
the gitlink, then `git worktree remove`.

The copy is a point-in-time snapshot taken at worktree creation. For epic-
length worktrees this is acceptable; if the root `.agents/` changes during an
epic, those updates do not propagate into existing worktrees. Recreate the
worktree (or add an explicit refresh step) if you need the update mid-epic.

The framework repo itself (where `.agents` is a regular tracked directory, not a
submodule) skips this behavior. Detection is automatic — keyed off whether
`.gitmodules` at repo root declares `.agents` as a submodule path.

> **Why copy instead of symlink:** the previous symlink/junction approach caused
> `git worktree remove` failures on Windows when junction targets didn't match
> exactly, and a mismatched junction risked the remove following it and wiping
> `<repoRoot>/.agents`. Plain directory copies have no such traversal risk and
> `git worktree remove` works without special cases.

## node_modules strategies

| Strategy       | Behavior                                                              | When to pick it                                                        |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `per-worktree` | Each worktree runs its own `npm/pnpm install`. Default.               | Correct everywhere. Choose for small repos or when disk is cheap.      |
| `symlink`      | Symlinks `<wt>/node_modules` → `<primeFromPath>/node_modules`.        | Large monorepos where install time dominates. Requires a primed donor. |
| `pnpm-store`   | Each worktree still runs `pnpm install --frozen-lockfile`; savings come from the shared content-addressable store, not from skipping install. | Repos already on pnpm. Gets most of symlink's speed without fragility. |

Symlink strategy:

- `primeFromPath` (relative to repo root) must exist and contain `node_modules`.
- On Windows, `allowSymlinkOnWindows: true` is required — symlink semantics vary
  by Windows version and may demand admin rights.
- `nodeModulesStrategy: "symlink"` without `primeFromPath` is a config error.

`pnpm-store` strategy — install is **not** eliminated:

- `installDependencies` in `lib/worktree/node-modules-strategy.js` runs
  `pnpm install --frozen-lockfile` in every new worktree regardless of
  strategy (symlink is the only strategy that truly skips install).
- The speed-up vs. `per-worktree` comes from pnpm's global
  content-addressable store at `~/.local/share/pnpm/store` (or the platform
  equivalent) — reused packages are hard-linked into the worktree instead of
  re-downloaded and re-extracted. First-run on a cold store is no faster than
  `per-worktree`, and `epic-plan-healthcheck.js` primes the store in the
  main checkout to avoid paying that cost in parallel story windows.

## Windows notes

- **`core.longpaths=true`** is set on each new worktree to lift the 260-char
  MAX_PATH ceiling. Some older build tools still truncate even with this flag;
  the pre-flight warning below catches those cases before a build breaks.
- **Long-path warning**: when `worktreePath.length + 80` exceeds
  `windowsPathLengthWarnThreshold` (default 240), `WorktreeManager` emits a
  warning locally and the dispatcher posts an `⚠️` comment on the Epic issue.
  Relocate `delivery.worktreeIsolation.root` to a shorter prefix (e.g.
  `C:\w`) if you see this.
- **`packed-refs` contention**: two worktrees fetching concurrently can collide
  on `.git/packed-refs.lock`. `gitFetchWithRetry` (`git-utils.js`) retries that
  specific failure up to 3 times with 250/500/1000 ms backoff. Unrelated fetch
  failures surface immediately — no retry.

## Fallback: single-tree mode

Set `delivery.worktreeIsolation.enabled: false` (or omit the block) to
restore v5.5.1 single-tree behavior:

- No `git worktree add` / `remove` calls.
- `assert-branch.js` and `computeStoryWaves` focus-area serialization remain in
  place as the primary race guards.
- All existing v5.5.1 tests pass in this mode.

Pick single-tree mode when:

- The runner lacks disk/space for parallel `node_modules` trees and pnpm is
  unavailable.
- Windows path limits are unsolvable via the long-path guard.
- You need a minimal-risk environment to debug an unrelated dispatcher issue.

## Reviewer guidance

Human reviewers should **keep using the main checkout** — not a worktree:

- The Epic branch accumulates the cumulative diff for code review; that lives on
  the main checkout, not in any per-story worktree.
- Opening a worktree in an IDE can mislead: the working directory looks like the
  main repo but carries a different HEAD. The main checkout is the canonical
  place to read PRDs, Tech Specs, and run the `helpers/epic-code-review.md`
  procedure.
- `git worktree list --porcelain` on the main checkout enumerates any still
  in-flight story worktrees if you need to inspect one — prefer read-only
  operations (`git log`, `git show`) when you do.

## Constraint

- **Never** call `git worktree` directly — always go through `WorktreeManager`.
  It enforces `storyId`/`branch` validation and path-traversal checks.
- **Only** let `WorktreeManager` pass `--force` after its safety checks have
  established the Story worktree is removable and the plain Windows lock/cwd
  retry has exhausted. Dirty unmerged work must still refuse deletion.
- **Never** commit the `.worktrees/` directory. It must be gitignored.
- **Always** use the main checkout for code review — not a per-story worktree.
- **Always** respect `delivery.worktreeIsolation.enabled: false` as a
  first-class fallback mode, not a degraded one. v5.5.1 single-tree guards
  (`assert-branch.js`, focus-area serialization) remain the primary defense in
  that mode.

## Operator escape hatches

- **Force-remove a worktree**: if a worktree is wedged beyond the framework's
  bounded retry path (e.g. from a crashed agent), operators can manually run
  `git worktree remove --force <path>`. Confirm there is no uncommitted work
  first.
- **Disable temporarily**: flip `enabled: false` in `.agentrc.json`. The next
  `/story-deliver` skips worktree creation entirely.
- **Inspect live worktrees**: `git worktree list --porcelain` on the main
  checkout. Each block shows `worktree <path>` / `branch refs/heads/story-<id>`.
