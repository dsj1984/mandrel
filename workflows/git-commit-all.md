---
description: Stage every untracked and modified file, then create a single conventional-commit on the current branch (no push).
---

# /git-commit-all [Message]

This is a compatibility alias for [`/git-push --no-push`](git-push.md) — it
stages and commits all outstanding changes without pushing. See
[`git-push.md`](git-push.md) for the canonical procedure, hook-failure guidance,
and the parallel-execution warning.

## Constraint

Follow every constraint in [`git-push.md`](git-push.md) — this alias does not
relax any of them.
