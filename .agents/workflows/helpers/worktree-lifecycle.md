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
[`epic-deliver`](deliver-epic.md) and [`story-deliver`](deliver-stories.md)
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
| **Sweep**       | Dispatch-manifest build (`/plan`) and `/deliver` | Stale `*.lock` files under `.git/` (older than 5 min) are removed before GC.                                                                                |
| **GC**          | Dispatch-manifest build (`/plan`) and `/deliver` | Orphan `.worktrees/story-*` whose stories are closed are reaped if clean.                                                                                   |
| **Force-drain** | `/plan` boot (`worktree-sweep.js` via `drainPendingCleanupAtBoot`), `story-close` post-merge (`forceDrainPendingCleanup`), `/deliver` Phase 7 | Retries `.worktrees/.pending-cleanup.json` (`git worktree remove` then `fs.rm`); Windows-only escalation enumerates user-mode handle holders and `taskkill`s them before re-trying. |
| **Ensure**      | `story-init` (entry for `/deliver`)                  | `git worktree add .worktrees/story-<id>/` on the `story-<id>` branch.                                                                                       |
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
`story-init` (the entry for `/deliver`) does not invoke them. The full
set of callers is:

| Entry point                                                           | Script / caller                                           | Runs sweep? | Runs GC? | Force-drain? | Notes                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | -------- | ------------ | --------------------------------------------------------------------------------------------------- |
| Dispatch manifest build (`/plan` Phase 9)                        | `lib/orchestration/dispatch-pipeline.js::runWorktreeGc`   | ✅ Yes      | ✅ Yes   | ✅ Yes       | Called from `dispatch-engine.js::dispatch()`. Scoped to the epic being dispatched.                  |
| Spec / decompose CLI boot (`/plan` helpers)                      | `drainPendingCleanupAtBoot` → `worktree-sweep.js`        | ✅ Yes*     | ❌ No    | ✅ Yes       | \*Drains the pending ledger then reaps `git worktree list` entries for done/closed Stories (`--force`). |
| Story merge (`/deliver` close)                                  | `story-close.js` (`drainPendingCleanupAfterClose`) | ❌ No       | ❌ No    | ✅ Yes       | Runs after the post-merge pipeline when worktree isolation is enabled.                              |
| Story close                                                           | `epic-deliver runner` (invoked by `story-close.js`)    | ✅ Yes      | ✅ Yes   | ✅ Yes       | Runs before branch deletion so reaping cannot collide with `git branch -D`.                         |
| Story init (`/deliver <storyId>`)                               | `story-init.js`                                    | ❌ No       | ❌ No    | ❌ No        | Story execution relies on the dispatch/close pair to clean up; it only creates its own worktree.    |
| Epic deliver wave loop (`/deliver`)                              | `/deliver` slash command + `lib/orchestration/epic-runner/*` | ❌ No       | ❌ No    | ❌ No        | Does not call `sweepStaleLocks` or `gc` directly; cleanup still flows through dispatch + close.     |
| Drain pending-cleanup (operator-driven)                               | `drain-pending-cleanup.js` (run directly — see below)     | n/a         | n/a      | ✅ Yes       | Manual escape hatch; same drain + Windows escalation as the `/plan` and `/deliver` paths.   |

Operator takeaway: if you need to force a sweep/GC without closing a story,
the most direct path is re-running `/plan` (or rebuilding the dispatch
manifest via `dispatcher.js`) against the active epic. Running
`/deliver <storyId>` on its own does **not** clean up orphan worktrees
or stale locks.

## Draining the pending-cleanup ledger

`.worktrees/.pending-cleanup.json` accumulates entries when
`story-close.js` cannot remove a worktree on Windows because of an
EBUSY-class lock. Plan boot ([`drainPendingCleanupAtBoot`](../../scripts/epic-plan-spec.js) → [`worktree-sweep.js`](../../scripts/lib/orchestration/plan-runner/worktree-sweep.js))
retries the entries — but if the holder
is a long-lived user-mode process (a stranded test runner, a lingering
biome/tsc, a node REPL), the lock never clears and the entry pins.

[`drain-pending-cleanup.js`](../../scripts/drain-pending-cleanup.js)
runs the standard drain *and* enumerates handle holders via
PowerShell `Get-CimInstance Win32_Process`, terminating them with
`taskkill /T /F` before re-trying.

> **Not a slash command (decision overturned).** The drain is **not** a
> `/drain-pending-cleanup` slash command — it was demoted to a
> directly-runnable script (Story #3706, overturning the
> `docs/decisions.md` matrix row that originally kept it as a command).
> The three automatic callers — `/deliver` runner Phase 7,
> `story-close.js`, and `worktree-sweep.js` — invoke
> `drain-pending-cleanup.js` **directly**, so the demotion does not touch
> them. The manual path survives unchanged as
> `node .agents/scripts/drain-pending-cleanup.js`.

### When it runs automatically

| Trigger          | Caller                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| `/deliver`    | [`Cleaner` lifecycle listener](../../scripts/lib/orchestration/lifecycle/listeners/cleaner.js) at the close-tail cleanup phase (before `wm.gc()`)   |
| `/plan`     | [`drainPendingCleanupAtBoot`](../../scripts/epic-plan-spec.js) → [`worktree-sweep.js`](../../scripts/lib/orchestration/plan-runner/worktree-sweep.js) |
| Story merge close | [`story-close.js`](../../scripts/story-close.js) (`drainPendingCleanupAfterClose`) |

All automatic paths call `forceDrainPendingCleanup()` (or are folded into
`sweepStaleStoryWorktrees`, which calls it first).

### When to run it manually

- The end-of-epic banner reports `pending-cleanup persistent-lock: story-N, ...`.
- `git worktree list` shows `.worktrees/story-N/` for a closed Story.
- `npm run lint` fails because of a nested `biome.json` in a half-reaped
  worktree. The `worktree-residue-biome` self-healing check detects this
  failure mode.

### Manual usage

```bash
# Default: drain + escalate (kill holders on Windows)
node .agents/scripts/drain-pending-cleanup.js

# Passive drain only — retry Stage 1 without killing anything
node .agents/scripts/drain-pending-cleanup.js --no-escalate

# Inspect what would be killed without acting
node .agents/scripts/drain-pending-cleanup.js --dry-run

# Override the worktree root (rare)
node .agents/scripts/drain-pending-cleanup.js --worktree-root /tmp/wt
```

The script always exits 0 unless the config or runtime is broken; remaining
entries are reported on stderr and re-enter the next sweep.

### Escalation limitations

Escalation matches process `ExecutablePath` and `CommandLine`. **Kernel-held
handles are invisible to user-mode enumeration**:

- **Windows Search indexer** (`searchindexer.exe`) — does not record the
  worktree path in command line. Workaround: exclude `.worktrees/` in
  Search Options, or wait for the indexer to release after ~5 min idle.
- **Antivirus** (`MsMpEng.exe`, third-party AV) — same story. Add
  `.worktrees/` to scan exclusions if this recurs.
- **VSCode extension host** — files indexed by an open VSCode workspace.
  Closing the workspace tab releases handles.

When `findHoldersInPath()` returns `[]` for a stuck entry, the script
emits a `no user-mode holders` warning and leaves the entry for the next
sweep — by which time the indexer/AV has usually moved on.

### Drain constraints

- **Never** call `git worktree` directly from inside the drain helper —
  always go through `pending-cleanup.js` / `force-drain.js`. They
  enforce manifest atomicity and Stage-1/Stage-2/Stage-3 ordering.
- **Never** widen `findHoldersInPath()` to kill processes outside the
  worktree path. Match must be rooted at the worktree directory; a
  loose match risks terminating unrelated user processes.
- **Always** treat escalation as best-effort: PowerShell or `taskkill`
  failures must degrade to "leave the entry in the manifest" rather
  than throw — the next sweep retries.
- **Always** preserve the `escalate: false` opt-out path so the
  legacy `drainPendingCleanup` behaviour is reachable when an operator
  needs to inspect without acting.

### Last-resort manual recipe

When even escalation can't clear an entry, the pre-`ff34fa9` recipe still
works:

```bash
cd <main-checkout>
node -e "require('fs').rmSync('.worktrees/story-<id>', {recursive:true,force:true})"
git worktree prune
git branch -D story-<id>
git push origin --delete story-<id>
```

(Direct `rm -rf .worktrees/story-<id>` may be blocked by the global
`Bash(rm -rf *)` deny hook. The Node `fs.rmSync` fallback above avoids
that shell-pattern denial.)

## `.agents` materialization

`.agents/` is a regular tracked directory in every checkout — the framework
repo tracks it directly, and npm-installed consumers materialize it via
`mandrel sync`. Because it is not a git submodule, a per-story worktree
carries no `.agents` gitlink, so `git worktree add` and `git worktree remove`
need no special handling for it: the directory is created and reaped like any
other tracked path.

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
  place to read PRDs, Tech Specs, and run the `helpers/code-review.md`
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
  `/deliver` skips worktree creation entirely.
- **Inspect live worktrees**: `git worktree list --porcelain` on the main
  checkout. Each block shows `worktree <path>` / `branch refs/heads/story-<id>`.
