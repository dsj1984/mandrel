---
description: Bump the `.agents` submodule to its remote HEAD and report the change set.
---

# /agents-update

## Overview

`/agents-update` advances the consumer repo's `.agents/` submodule pointer to
the latest commit on its tracked branch, then regenerates
`.claude/commands/` against the new workflow set. It is the **only**
supported way to upgrade the framework inside a consumer project.

The upgrade contract:

- **The pointer only moves on explicit invocation.** There is no
  `postinstall` hook and no background drift. Teammates always work against
  the SHA recorded in the consumer repo's git history until someone runs
  this workflow and commits the result.
- **CI honours the committed SHA.** When `CI=true`, the script skips
  `--remote` so CI jobs check out exactly the pointer recorded in git —
  never "whatever HEAD happens to be today."
- **A dirty submodule worktree blocks the upgrade.** If `.agents/` has
  uncommitted changes, the workflow refuses to run before touching
  anything. Stash, commit, or discard inside `.agents/` first; the
  workflow does not perform recovery dances on the operator's behalf.
- **`.agents/workflows/` → `.claude/commands/` mirroring is delegated.**
  The only authoritative writer of `.claude/commands/` is
  [`sync-claude-commands.js`](../scripts/sync-claude-commands.js), which
  prepends the `<!-- AUTO-GENERATED -->` header that
  `/agents-bootstrap-project` parity-checks. This workflow invokes it
  after the pointer moves; nothing else copies workflow files.

> **Persona**: `devops-engineer` · **Skills**:
> `core/ci-cd-and-automation`, `core/documentation-and-adrs`

## Step 1 — Run the updater

From the consumer repo root (the parent of `.agents/`):

```bash
node .agents/scripts/update-self.js
```

The script:

1. Verifies `.agents/` is clean (`git -C .agents status --porcelain`).
2. Captures the current pointer as `OLD_SHA`.
3. Runs `git submodule update --init --force --remote .agents` with up to
   3 retries and a 2s backoff. `--remote` is dropped when `CI=true`.
4. Captures the post-update pointer as `NEW_SHA`.
5. Prints `OLD..NEW` and the shortlog of new commits (or
   `No changes` if the pointer did not move).
6. Execs `node .agents/scripts/sync-claude-commands.js` so
   `.claude/commands/` reflects the new workflow set.

## Step 2 — Expected output

A successful bump looks like:

```text
a1b2c3d4e5f6..9f8e7d6c5b4a
[update-self] New commits:
  9f8e7d6 feat: new workflow X
  a0b1c2d fix: tighten Y validation
  synced   agents-update.md
  synced   epic-plan.md
...
✔ 3 file(s) synced, 26 total commands in .claude/commands/
```

A no-op run (already up to date) looks like:

```text
[update-self] No changes — .agents/ already at 9f8e7d6c5b4a....
✔ 0 file(s) synced, 26 total commands in .claude/commands/
```

## Step 3 — Reconcile `.agentrc.json` against the new defaults

A framework bump can add or reshape fields in
`.agents/default-agentrc.json` (and the underlying schema). Run the
reconciliation helper so the consumer's `.agentrc.json` tracks the new schema
without losing any project-specific overrides.

Follow the procedure in
[`helpers/agents-sync-config.md`](helpers/agents-sync-config.md). It is a
schema-driven validate-then-merge:

- The project config is **validated** against the framework schema first;
  any failure aborts the run with a diagnostic so the operator can fix the
  underlying typo / missing required key.
- Required or template-defaulted keys missing from the project are **added**
  from the template (operator opt-in to new defaults).
- Every project value that validates is **preserved unconditionally** —
  including schema-valid optional keys the template does not declare.
- The helper emits an `ADDED` change report and never auto-commits.

If the helper reports `No changes required`, the config is already in
sync — carry on. Otherwise, review the change report before the
commit in Step 4.

## Step 4 — Commit the bump

The script never auto-commits. After reviewing the shortlog and any
`.agentrc.json` reconciliation diff from Step 3, stage and commit the
pointer move (plus the config reconciliation, if any) from the consumer
repo root:

```bash
git add .agents .agentrc.json
git commit -m "chore: bump .agents to <NEW_SHORT_SHA>

OLD..NEW: a1b2c3d4e5f6..9f8e7d6c5b4a

- feat: new workflow X
- fix: tighten Y validation"
```

Include the SHA range and, optionally, the shortlog so reviewers can see
what moved without re-running the updater. Omit `.agentrc.json` from the
`git add` if Step 3 reported `No changes required`.

## Troubleshooting

- **`fatal: needed a single revision`** — the submodule entry in
  `.gitmodules` does not pin a remote branch. Add
  `branch = main` (or the appropriate branch name) under the `.agents`
  entry:

  ```ini
  [submodule ".agents"]
    path = .agents
    url = https://github.com/dsj1984/agent-protocols.git
    branch = main
  ```

  Commit the `.gitmodules` change and re-run.

- **`.agents/ has uncommitted changes`** — the script refuses to run
  over an unclean submodule. `cd .agents && git status` shows what
  moved; commit it inside the submodule (if the change belongs
  upstream) or `git checkout -- .` to discard it (if it was
  accidental). Then re-invoke.

- **`failed after 3 attempts`** — retries are exhausted. The underlying
  cause is almost always a network hiccup reaching the framework
  remote, or (in CI) missing credentials for a private submodule URL.
  Re-invoke when connectivity is restored; the script is idempotent.

## Constraints

- **Idempotent.** A second invocation immediately after a successful run
  prints `No changes` and exits 0.
- **Stdlib only.** The script uses `node:child_process`, `node:fs`,
  `node:path`, and `node:timers/promises` — no new dependencies.
- **Windows-compatible.** `spawnSync` is invoked with explicit argument
  arrays; no shell strings, no bash-isms.
- **No auto-commit.** The operator reviews the shortlog and writes the
  commit message. The workflow does not know whether the pointer move
  is release-worthy.
- **No framework-side version bump.** This workflow moves the
  *consumer's* pointer. It does not tag a release on the framework
  itself — that remains the framework maintainer's call after they
  review the diff upstream.
