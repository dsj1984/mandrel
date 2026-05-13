---
name: delete-epic-branches script misses flat story-NNNN naming
description: The delete-epic-branches.js matcher assumes hierarchical naming (story/epic-<id>/<n>) but this repo uses flat story-<n>, so the script's dry-run looks empty even when story branches still exist.
type: feedback
originSessionId: 7059fdb0-b3ab-4f39-b682-bd502e0c012c
---

# delete-epic-branches script misses flat story-NNNN naming

When cleaning up an epic, do not trust `delete-epic-branches.js --dry-run` as the only signal. Always also run `git branch -a | grep -i story` (and worktree-list) to catch flat `story-<n>` / `task-<n>` / `feature-<n>` branches that the script's regex misses.

**Why:** Observed on epic #1178 cleanup (2026-05-11). The script reported only `epic/1178` to delete, but four `story-1192/1193/1195/1197` branches were still present as active worktrees. The script's matcher (`story/epic-<id>/*`, `task/epic-<id>/*`, `feature/epic-<id>/*`) expects a hierarchical convention this repo doesn't use for its actual story branches.

**How to apply:** Before reporting an epic-cleanup "done," cross-check with `git branch -a | grep -E 'story|task|feature'` and `git worktree list`. If flat-named story branches exist, verify their issues are CLOSED on GitHub and the epic PR is MERGED, then `git worktree remove --force` each one and `git branch -D` the branch directly. No remote story branches exist for this convention (stories never get individual PRs — they roll into the epic branch).
