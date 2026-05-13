---
name: Push epic branch before re-running close after a merge-conflict detour
description: Close rebases story onto origin/epic — stale origin makes the rebase pick different conflicts than the local merge
type: feedback
originSessionId: a61f5925-3b6d-4828-a004-671686865359
---

# Push epic branch before re-running close after a merge-conflict detour

`story-close.js` runs `git rebase story-<id> onto origin/epic/<id>` before the merge. If you've already resolved the merge locally (e.g. committed a merge commit by hand after a conflict) but **haven't pushed** the epic branch, `origin/epic/<id>` is behind `epic/<id>` and the rebase replays story commits on the stale base — producing different conflicts than the ones you resolved locally, and leaving the repo mid-rebase with new `<<<<<<<` markers in files.

**Why:** After a manual merge-conflict recovery, the next close attempt loops indefinitely: rebase conflicts (because origin is old), then merge says "Already up to date" with local but the script's rebase step has already failed. Aborting and retrying reproduces the same trap.

**How to apply:** When you've hand-resolved a merge on the epic branch after close aborted, `git push origin epic/<id>` **before** re-running `story-close.js`. Then the in-script rebase targets a matching origin and becomes a no-op; the merge step reports "Already up to date" and the script advances to branch cleanup / ticket cascades. If you see a stuck rebase mid-run, `git rebase --abort` and push origin first.
