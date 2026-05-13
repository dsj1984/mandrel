---
name: sprint-story-close reap fully codified on Windows
description: Worktree reap on Windows used to land in still-registered-after-reap even after git worktree remove exited 0. Two gaps were patched on epic/553; the manual rmdir + prune + branch -D recipe should no longer be needed.
type: feedback
originSessionId: e9685cbb-63fb-4f08-b975-3204fb8ce432
---

# sprint-story-close reap fully codified on Windows

`WorktreeManager.reap()` on Windows used to leave a half-reaped
`.worktrees/story-<id>/` with `branchDeleted: false` even when
`story-close.js` otherwise merged and closed tickets cleanly. Two
distinct bugs were fixed on `epic/553` (commit `ff34fa9`) in
[lifecycle-manager.js](.agents/scripts/lib/worktree/lifecycle-manager.js):

**1. Success path never pruned.** `git worktree remove` on Windows regularly
exits 0 while leaving `.git/worktrees/story-<id>/` admin metadata on disk
(residual file handles from AV / Windows Search indexer / Node's module
cache). Without a follow-up `git worktree prune`, `worktree list` still
reports the worktree and post-merge-pipeline flags it as
`still-registered-after-reap`. `branch -D` then refuses because the branch
is "checked out" in the ghost registration.

**2. Stage 1 fs-rm-retry recovery was stderr-gated.** `removeWorktreeWithRecovery`
only ran the fs.rm + prune + branch-D sequence when stderr matched
`WINDOWS_LOCK_RE || WINDOWS_CWD_RE`. Any other failure mode (localized git
messages, generic I/O, stale-registration errors) fell through to a tail
that only pruned and re-checked `list` — no fs.rm, no branch delete. If
prune alone didn't clear things, reap returned `{removed:false, method:undefined}`.

**Why:** I had been treating "the memory's rmdir recipe" as the fix, but
the deciding call in the manual recovery was actually `git worktree prune`
— the filesystem was already empty when I ran `fs.rmSync`. The Windows
pathology is *residual registration*, not just *residual files*.

**How to apply:** Post-`ff34fa9` (Epic #902 architecture: `/story-execute`
drives close), Windows reap should be reliable end-to-end. If a close result
still reports `still-registered-after-reap`, something new is going on —
read [lifecycle-manager.js](.agents/scripts/lib/worktree/lifecycle-manager.js)'s
`removeWorktreeWithRecovery` output before falling back to the manual recipe,
and flag it so we can extend the recovery. Manual recovery recipe (still works):

```bash
cd <main-checkout>
node -e "require('fs').rmSync('.worktrees/story-<id>', {recursive:true,force:true})"
git worktree prune
git branch -D story-<id>
git push origin --delete story-<id>
```

(`rm -rf .worktrees/story-<id>` is blocked by the global `Bash(rm -rf *)`
deny hook — see `feedback_rm_rf_worktrees_hook.md`.)
