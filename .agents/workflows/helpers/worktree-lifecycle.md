---
description: >-
  Per-story git worktree isolation model — configuration, lifecycle,
  node_modules strategies, Windows notes, fallback mode, and human-reviewer
  guidance.
---

# Worktree-per-Story Lifecycle

Parallel Story delivery can race when multiple agents share one working
tree: rapid `git checkout` swaps cause `git add` to sweep another agent's WIP
into the wrong commit. Each Story runs in its own `git worktree` at
`.worktrees/story-<id>/` so branch swaps, staging, and reflog activity are
isolated per-Story. The main checkout stays quiet.

This document is the operator and reviewer reference. See
[`/deliver`](../deliver.md) and [`helpers/deliver-story`](deliver-story.md)
for the broader execution flow.

## Configuration

All knobs live under `delivery.worktreeIsolation` in `.agentrc.json`. The
**key list, types, and accepted enum values are not restated here** — the
runtime schema in `config-resolver.js` validates them and
[`.agents/docs/configuration.md`](../../docs/configuration.md) is generated
from it, so a copy in this file could only drift out of agreement with the
thing that actually enforces it. Read the generated table for the shape.

What that table cannot tell you is which knob to reach for, so this document
covers the judgement instead, each in its own section below:

- `enabled` — the master switch; see [Fallback: single-tree mode](#fallback-single-tree-mode).
- `nodeModulesStrategy`, `primeFromPath`, `allowSymlinkOnWindows` — see
  [node_modules strategies](#node_modules-strategies).
- `root` — where worktrees materialize; see [Windows notes](#windows-notes)
  for the long-path constraint on it.
- `reapOnSuccess` — drives the **Reap** phase in the lifecycle table below.
- `bootstrapFiles` — untracked, per-developer files (local env, MCP, and
  `.agentrc.local.json` / `instructions.local.md` overrides) copied into each
  new worktree, because a worktree checkout carries only tracked content and
  would otherwise boot without the operator's local configuration.

Config-load rejects unknown strategies, `root` values that escape the repo
root, and shell-metacharacter injection in `root`.

## Lifecycle

| Phase           | When                                                                          | What happens                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sweep**       | Operator-driven (`WorktreeManager.sweepStaleLocks`)                           | Stale `*.lock` files under `.git/` (older than 5 min) are removed before GC.                                                                                |
| **GC**          | Operator-driven (`WorktreeManager.gc`)                                        | Orphan `.worktrees/story-*` whose Stories are closed are reaped if clean.                                                                                   |
| **Force-drain** | Operator-driven (`drain-pending-cleanup.js`)                                  | Retries `.worktrees/.pending-cleanup.json` (`git worktree remove` then `fs.rm`); Windows-only escalation enumerates user-mode handle holders and `taskkill`s them before re-trying. |
| **Ensure**      | `single-story-init.js` (entry for `/deliver`)                                 | `git worktree add .worktrees/story-<id>/` on the `story-<id>` branch.                                                                                       |
| **Run**         | During Story execution                                                        | Agent runs inside the worktree; HEAD/reflog activity is isolated.                                                                                           |
| **Reap**        | After successful Story merge (in `single-story-close`)                        | `git worktree remove` — refuses to delete dirty trees or unmerged branches.                                                                                 |

The `WorktreeManager` (`.agents/scripts/lib/worktree-manager.js`) is the single
authority for `ensure`, `reap`, `list`, `isSafeToRemove`, `gc`, `prune`, and
`sweepStaleLocks`. No other script may call `git worktree` directly.

Managed Story worktrees are only eligible for `reap`/`gc` when the Story is
merged (or otherwise confirmed closed) so cleanup cannot silently drop an
unlanded branch.

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

Under the v2 single-Story delivery loop, `sweepStaleLocks` and `gc`
remain `WorktreeManager` methods but have **no automatic caller** — the
wave-era dispatch/close hooks that invoked them were deleted with the
epic-runner. The lifecycle surfaces that do run automatically are:

| Entry point                       | Script / caller                                                      | What it cleans                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Story init (`/deliver <storyId>`) | `single-story-init.js` boot sweep (`sweepMergedStoryBranches`)        | Merged/closed `story-*` branches (local + origin) from prior runs; it then creates only its own worktree.                 |
| Story close (`/deliver` close)    | `single-story-close.js` worktree-reap phase (`WorktreeManager.reap`)  | The per-Story worktree; on a Windows EBUSY-class lock the entry is deferred into `.worktrees/.pending-cleanup.json`.       |
| Drain pending-cleanup (operator)  | `drain-pending-cleanup.js` (run directly — see below)                 | The pending-cleanup ledger, with optional Windows handle-holder escalation. This is the only path that drains the ledger. |

Operator takeaway: if worktrees or stale locks accumulate, run
`node .agents/scripts/drain-pending-cleanup.js` — nothing in the
`/plan` → `/deliver` loop force-sweeps or GCs on your behalf.

## Draining the pending-cleanup ledger

`.worktrees/.pending-cleanup.json` accumulates entries when
`single-story-close.js` cannot remove a worktree on Windows because of
an EBUSY-class lock. If the holder is a long-lived user-mode process (a
stranded test runner, a lingering biome/tsc, a node REPL), the lock
never clears and the entry pins.

[`drain-pending-cleanup.js`](../../scripts/drain-pending-cleanup.js)
runs the standard drain *and* enumerates handle holders via
PowerShell `Get-CimInstance Win32_Process`, terminating them with
`taskkill /T /F` before re-trying.

> **Not a slash command (decision overturned).** The drain is **not** a
> `/drain-pending-cleanup` slash command — it was demoted to a
> directly-runnable script (Story #3706, overturning the
> `docs/decisions.md` matrix row that originally kept it as a command).
> The wave-era automatic callers were deleted with the epic-runner in
> the v2 cutover, so the drain is now operator-driven:
> `node .agents/scripts/drain-pending-cleanup.js`.

### When to run it manually

- The close output reports `pending-cleanup persistent-lock: story-N, ...`.
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
  `per-worktree`. Operators can prime the store once in the main
  checkout (`pnpm install --frozen-lockfile`) to avoid paying first-run
  cost in parallel story windows.

## Windows notes

- **`core.longpaths=true`** is set on each new worktree to lift the 260-char
  MAX_PATH ceiling. Some older build tools still truncate even with this flag;
  the pre-flight warning below catches those cases before a build breaks.
- **Long-path warning**: when `worktreePath.length + 80` exceeds
  `windowsPathLengthWarnThreshold` (default 240), `WorktreeManager` emits a
  warning locally.
  Relocate `delivery.worktreeIsolation.root` to a shorter prefix (e.g.
  `C:\w`) if you see this.
- **`packed-refs` contention**: two worktrees fetching concurrently can collide
  on `.git/packed-refs.lock`. `gitFetchWithRetry` (`git-utils.js`) retries that
  specific failure up to 3 times with 250/500/1000 ms backoff. Unrelated fetch
  failures surface immediately — no retry.

## Harness-worktree ⇄ consumer-lint-ignore interaction (Story #152)

Mandrel's own worktree isolation (above) always roots story worktrees at
`delivery.worktreeIsolation.root` (default `.worktrees/` at the repo root).
That path is separate from **the host IDE/CLI harness's own worktree
mechanism** — for example Claude Code, when it manages an agent session as a
git worktree, nests it at `.claude/worktrees/<name>/`. A mandrel delivery
agent can be invoked from *either* location depending on how the operator's
harness composes with `/deliver`: mandrel's own `.worktrees/story-<id>/` when
`worktreeIsolation.enabled` drives the checkout, or a harness-level
`.claude/worktrees/<name>/` when the harness itself provides the isolated
working directory mandrel runs inside.

This matters because a consumer's `pre-push` (or `pre-commit`) lint step is
commonly configured with an ignore glob that excludes noisy agent-tooling
directories, e.g. a Biome `files.includes` entry like `"!**/.claude"`. When
the *agent's CWD itself* resolves under `.claude/worktrees/<name>/`, a
lint invocation scoped to `.` (`biome check .`, or equivalent) resolves
every candidate path as living under the ignored `.claude` prefix — the glob
matches zero files, and tools that treat zero-match as failure (Biome's
default `check` behavior without `--no-errors-on-unmatched`) exit non-zero
with something like `No files were processed in the specified paths`. This
is a **false negative**: the changed files were never actually linted
against, and the hook is not reporting a real defect. It is functionally
distinct from a `pre-push` rejection caused by a genuine lint violation, and
must not be treated the same way.

**Do not resolve this by bypassing the push hook.**
[`rules/git-conventions.md`](../../rules/git-conventions.md) § "Push
Validation & Reliability" prohibits skipping hooks without explicit operator
authorization, and that prohibition is not weakened by this interaction —
the zero-match failure is a **consumer-tooling gap**, not a framework
authorization the agent gets to grant itself.

**Sanctioned resolution path:**

1. **Recognize the signature.** A `pre-push`/`pre-commit` failure whose
   message is a zero-match error (`No files were processed`, `0 files
   matched`, or equivalent for the consumer's linter) — not a reported
   violation in a specific file — combined with an agent CWD under
   `.claude/worktrees/` (or any other harness-managed path a consumer's lint
   config ignores) is this known interaction, not a real lint failure.
2. **Fix it in the consumer, not the agent invocation.** The remedy lives in
   the consumer's own lint command, mirroring what its `lint-staged` config
   (if present) likely already does for the same reason: make the zero-match
   case a no-op instead of a failure. For Biome:
   `biome check --no-errors-on-unmatched .`. Other linters have an
   equivalent flag (e.g. ESLint's `--no-error-on-unmatched-pattern`). This is
   a one-line consumer-side change, typically to `.husky/pre-push` or the
   `package.json` script it invokes.
3. **Escalate through the normal HITL path**, per
   [`.agents/instructions.md` § 1.J](../../instructions.md), if the agent
   cannot edit the consumer's hook/lint config directly (e.g. it sits outside
   the Story's scope). Transition to `agent::blocked`, name the zero-match
   signature and the one-line remedy in the blocker summary, and let the
   operator apply the consumer-side fix or explicitly authorize a one-time
   hook-skip per [`rules/git-conventions.md`](../../rules/git-conventions.md)
   § "Push Validation & Reliability". Explicit operator authorization is the
   *only* circumstance under which a hook may be skipped — never as an
   agent's unilateral default when this signature is recognized.
4. **Do not relocate mandrel's own worktrees to work around a harness-level
   path.** `delivery.worktreeIsolation.root` controls where *mandrel*
   materializes `story-<id>` worktrees (default `.worktrees/`, already
   outside `.claude/`) and is unrelated to where the host harness places its
   own session worktree. Changing `worktreeIsolation.root` does not fix this
   interaction when the false negative originates from the harness's path,
   not mandrel's.

## Fallback: single-tree mode

Set `delivery.worktreeIsolation.enabled: false` (or omit the block) to
restore v5.5.1 single-tree behavior:

- No `git worktree add` / `remove` calls.
- The native `git branch --show-current` pre-commit check and
  `computeStoryWaves` focus-area serialization remain in place as the primary
  race guards.
- All existing v5.5.1 tests pass in this mode.

Pick single-tree mode when:

- The runner lacks disk/space for parallel `node_modules` trees and pnpm is
  unavailable.
- Windows path limits are unsolvable via the long-path guard.
- You need a minimal-risk environment to debug an unrelated dispatcher issue.

## Reviewer guidance

Human reviewers should **keep using the main checkout** — not a worktree:

- Each Story's diff is reviewed on its PR on GitHub (`story-<id>` → `main`);
  no local branch accumulates a cumulative diff for review.
- Opening a worktree in an IDE can mislead: the working directory looks like the
  main repo but carries a different HEAD. The main checkout is the canonical
  place to run the `helpers/code-review.md` procedure.
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
  (the `git branch --show-current` pre-commit check, focus-area serialization)
  remain the primary defense in that mode.

## Operator escape hatches

- **Force-remove a worktree**: if a worktree is wedged beyond the framework's
  bounded retry path (e.g. from a crashed agent), operators can manually run
  `git worktree remove --force <path>`. Confirm there is no uncommitted work
  first.
- **Disable temporarily**: flip `enabled: false` in `.agentrc.json`. The next
  `/deliver` skips worktree creation entirely.
- **Inspect live worktrees**: `git worktree list --porcelain` on the main
  checkout. Each block shows `worktree <path>` / `branch refs/heads/story-<id>`.
