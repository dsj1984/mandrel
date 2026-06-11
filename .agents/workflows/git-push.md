---
description: Commit all outstanding changes then push to the remote repository.
---

# /git-push [Message] [--no-push]

This workflow is the single source of truth for "stage + commit [+ push]"
ergonomics. It accepts an optional `[Message]` and an optional `--no-push` flag.

- **Default mode** — stage all outstanding changes, commit, then push the
  current branch to its upstream remote.
- **`--no-push` mode** — stage and commit only. Useful when you want to chain
  several commits or defer the push. `/git-commit-all` is a compatibility alias
  that maps to this mode.

## Steps

1. **Stage Changes**: Stage all new, modified, and deleted files.

   ```powershell
   git add .
   ```

2. **Commit Changes**: Commit the staged changes. If no message is provided, a
   generic timestamped message will be used.

   ```powershell
   git commit -m "[Message]"
   ```

3. **Push to Remote** _(skip when `--no-push` is set)_: Push the current branch
   to the upstream repository.

   ```powershell
   git push
   ```

## Troubleshooting

- **Hook Failures**: If `git commit` or `git push` fails due to Husky/pre-commit
  hooks (e.g., linting, formatting, or test failures), you MUST analyze the
  error output, fix the issues in the codebase, and then re-run the failed
  command.
- **Upstream Conflicts**: If the push is rejected because the remote contains
  work that you do not have locally, pull the latest changes first
  (`git pull --rebase`) and resolve any conflicts before pushing again.

## Constraint

Never use `--no-verify` to bypass quality gates. If a hook fails, identify and
fix the root cause (e.g., run `npm run format` or fix lint errors) before
attempting to commit or push again.

## ⚠️ Parallel Story Execution

Do **not** use this workflow from inside a parallel story-execution context
(`/deliver #<storyId>`). `git add .` sweeps any untracked files in the
working tree, which in a shared working directory may belong to another agent.
In that context, stage explicit paths only and confirm
`git branch --show-current` reports the expected `story-<id>` branch before
committing — see
[`helpers/worktree-lifecycle.md`](helpers/worktree-lifecycle.md) for the
shared-tree hazard and the worktree-isolation model that contains it.
