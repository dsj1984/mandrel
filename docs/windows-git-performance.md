# Git Performance (Windows)

The framework drives many Git operations per Story (worktree create, fetch,
status, branch deletes). Windows hosts benefit measurably from enabling the
file-system monitor and the many-files feature, plus the per-repository
maintenance schedule.

## Global settings (run once)

```bash
git config --global core.fsmonitor true
git config --global feature.manyFiles true
```

`core.fsmonitor true` enables the built-in file-system monitor daemon so
`git status` and friends skip the full `lstat` walk on large worktrees.
`feature.manyFiles true` opts the user into the modern many-files
defaults (commit-graph, untracked cache, sparse index where applicable).

## Per-repository maintenance

```bash
git maintenance start
```

Schedules background prefetch, commit-graph, loose-object cleanup, and
incremental repack. Run it once per repository clone (or per worktree
parent directory on a multi-checkout setup). The schedule is registered
with the OS scheduler — no manual cron required.

## When to re-run

Re-run `git maintenance start` after:

- Cloning the repo on a new machine.
- A long offline period (the schedule will silently miss windows).
- Worktree-isolation changes that move where `.git` lives (e.g. moving
  to a bare repo + worktree layout).

Re-running the global `core.fsmonitor` / `feature.manyFiles` settings is
idempotent and safe — `git config --global` simply overwrites the value.
