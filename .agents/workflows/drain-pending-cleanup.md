---
description: >-
  Drain the worktree pending-cleanup ledger. Retries Stage 1 cleanup for
  every entry; on Windows, escalates stuck entries by terminating the
  user-mode processes holding handles inside the worktree path.
---

# Drain Pending Cleanup

`.worktrees/.pending-cleanup.json` accumulates entries when
`sprint-story-close.js` cannot remove a worktree on Windows because of an
EBUSY-class lock. The standard sweep ([`worktree-sweep.js`](../scripts/lib/orchestration/plan-runner/worktree-sweep.js))
retries the entries on subsequent `/sprint-plan` runs — but if the holder
is a long-lived user-mode process (a stranded test runner, a lingering
biome/tsc, a node REPL), the lock never clears and the entry pins.

This workflow drives [`drain-pending-cleanup.js`](../scripts/drain-pending-cleanup.js),
which runs the standard drain *and* enumerates handle holders via
PowerShell `Get-CimInstance Win32_Process`, terminating them with
`taskkill /T /F` before re-trying.

## When it runs automatically

| Trigger          | Caller                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| `/sprint-close`  | [`sprint-close.js`](../scripts/sprint-close.js) Phase 7 (before `wm.gc()`)   |
| `/sprint-plan`   | [`worktree-sweep.js`](../scripts/lib/orchestration/plan-runner/worktree-sweep.js) Stage 2 |

Both call `forceDrainPendingCleanup()` directly; no separate node
invocation. The CLI exists for operator-driven runs and for the rare case
where a sprint never reaches close (cancelled epic, crashed orchestrator).

## When to run it manually

- The end-of-sprint banner reports `pending-cleanup persistent-lock: story-N, ...`.
- `git worktree list` shows `.worktrees/story-N/` for a closed Story.
- `npm run lint` fails because of a nested `biome.json` in a half-reaped
  worktree (see [`feedback_orphan_worktree_biome_block.md`](../../memory/feedback_orphan_worktree_biome_block.md)).

## Usage

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

## Limitations

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

## Constraint

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

## Manual escape hatch

When even escalation can't clear an entry, the pre-`ff34fa9` recipe still
works (see [`feedback_sprint_story_close_reap.md`](../../memory/feedback_sprint_story_close_reap.md)):

```bash
cd <main-checkout>
node -e "require('fs').rmSync('.worktrees/story-<id>', {recursive:true,force:true})"
git worktree prune
git branch -D story-<id>
git push origin --delete story-<id>
```

(Direct `rm -rf .worktrees/story-<id>` is blocked by the global
`Bash(rm -rf *)` deny hook — see [`feedback_rm_rf_worktrees_hook.md`](../../memory/feedback_rm_rf_worktrees_hook.md).)
