---
description: >-
  Bootstrap the local harness-side plumbing for an agent-protocols project:
  wire the `.claude/commands/` sync pipeline, ensure `package.json` scripts,
  create/merge `.claude/settings.json` hooks, ignore derived artefacts, and
  validate parity between workflows and slash commands. Idempotent — re-running
  on an already-bootstrapped project is a clean no-op.
---

# /agents-bootstrap-project

## Overview

`/agents-bootstrap-project` wires the **local** (per-clone, per-machine) harness
around the `agent-protocols` framework. It is the sibling of
[`/agents-bootstrap-github`](agents-bootstrap-github.md), which wires the
**remote** (GitHub-side) taxonomy.

After this workflow completes, the following invariants hold on the current
clone:

1. Claude Code sees every `.agents/workflows/*.md` file as a slash command.
2. Fresh clones auto-populate `.claude/commands/` via `npm install` (`prepare`
   lifecycle hook).
3. In-session edits to workflow files propagate to slash commands on the next
   prompt submit (`UserPromptSubmit` hook).
4. The derived `.claude/commands/` tree is gitignored, not committed.
5. Every workflow in `.agents/workflows/` has a matching generated entry in
   `.claude/commands/`.

`/agents-bootstrap-project` does **not** fetch workflow content, clone the
framework, or configure GitHub. It is strictly the local harness-side wiring.

> **Persona**: `devops-engineer` · **Skills**: `core/ci-cd-and-automation`,
> `core/documentation-and-adrs`

## Step 0 — Resolve paths and prerequisites

1. `[PROJECT_ROOT]` → the current working directory (must be a git worktree).
2. `[WORKFLOWS_DIR]` → `.agents/workflows/` (framework source of truth; must
   exist).
3. `[SYNC_SCRIPT]` → `.agents/scripts/sync-claude-commands.js` (the single
   authoritative writer; must exist).
4. `[COMMANDS_DIR]` → `.claude/commands/` (derived, gitignored).
5. `[PROJECT_PKG]` → `./package.json` (will be created if missing).
6. `[CLAUDE_SETTINGS]` → `.claude/settings.json` (will be created if missing).
7. `[GITIGNORE]` → `./.gitignore` (will be created if missing).

**Hard aborts:**

- If `[WORKFLOWS_DIR]` does not exist, abort — the framework files are not
  in place on this clone. Run the framework checkout first.
- If `[SYNC_SCRIPT]` does not exist, abort for the same reason.

**Soft aborts (prompt operator):**

- If `[PROJECT_ROOT]` is not a git repository, prompt:
  `Run 'git init' first? (recommended)`. Do not auto-init.

## Step 1 — Verify Node ≥ 20

[`.agents/scripts/sync-claude-commands.js`](../scripts/sync-claude-commands.js)
uses ESM imports and top-level `await`. Both require Node ≥ 20.

```bash
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20) { console.error('Node '+process.versions.node+' is below the required 20.x'); process.exit(1); }"
```

On failure, abort with a clear error message citing the detected version and
the requirement.

## Step 2 — Ensure `package.json` exists with the `sync:commands` + `prepare` wiring

### 2a. Create `[PROJECT_PKG]` if missing

If `package.json` does not exist at `[PROJECT_ROOT]`, create a minimal one:

```json
{
  "name": "<infer-from-dir-basename>",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

Then proceed to the merge.

### 2b. Merge the required `scripts` entries

Read `package.json`, then add — only if missing — the following fields:

| Path | Required value |
|------|---------------|
| `scripts."sync:commands"` | `node .agents/scripts/sync-claude-commands.js` |
| `scripts.prepare` | `node .agents/scripts/sync-claude-commands.js` *(see merge rule below)* |

**Merge rule for `scripts.prepare`:**

- If the key is **absent**, set it to `node .agents/scripts/sync-claude-commands.js`.
- If the key is **present** and already contains `sync-claude-commands.js`,
  leave it unchanged.
- If the key is **present** and does not contain the sync invocation, append
  it with ` && ` separator (e.g. existing `"husky"` becomes
  `"husky && node .agents/scripts/sync-claude-commands.js"`).
- Never overwrite an existing `prepare` script wholesale.

Write the merged `package.json` back with 2-space indentation and a trailing
newline.

## Step 3 — Wire the `UserPromptSubmit` hook in `.claude/settings.json`

### 3a. Create `[CLAUDE_SETTINGS]` if missing

If `.claude/settings.json` does not exist, create it with:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .agents/scripts/sync-claude-commands.js"
          }
        ]
      }
    ]
  }
}
```

### 3b. Merge the hook entry into an existing `.claude/settings.json`

If the file exists, parse it, then:

1. Ensure `hooks` is an object; initialize to `{}` if absent.
2. Ensure `hooks.UserPromptSubmit` is an array; initialize to `[]` if absent.
3. Scan every `hooks[].command` string within `UserPromptSubmit`. If any
   command already references `sync-claude-commands.js`, the hook is already
   wired — skip.
4. Otherwise, append a new group:

   ```json
   {
     "hooks": [
       { "type": "command", "command": "node .agents/scripts/sync-claude-commands.js" }
     ]
   }
   ```

**Warnings to surface to the operator:**

- If `.claude/settings.json` already has a `UserPromptSubmit` hook that uses a
  bare `cp` command (or `rsync`, or any non-Node writer for the commands
  directory), flag it. Do not auto-remove it — the operator decides whether
  the legacy hook is obsolete. Recommend they remove it so the Node script is
  the single writer.

Write the merged `.claude/settings.json` back with 2-space indentation and a
trailing newline.

## Step 4 — Ensure `.claude/commands/` is gitignored

### 4a. Create `[GITIGNORE]` if missing

If `.gitignore` does not exist, create it containing just:

```gitignore
.claude/commands/
```

### 4b. Merge the entry into an existing `.gitignore`

If the file exists and already contains a line matching `^\.claude/commands/?$`
(with or without trailing slash), skip. Otherwise append:

```gitignore

# Claude Code slash commands are generated from .agents/workflows/ — do not commit.
.claude/commands/
```

Leading blank line separates from any prior trailing block. Never rewrite
existing gitignore entries; append only.

## Step 5 — Seed `.claude/commands/` by running the sync

Invoke the script exactly as the hooks do:

```bash
node .agents/scripts/sync-claude-commands.js
```

The script creates `[COMMANDS_DIR]` if it does not exist, writes every
top-level `.md` from `[WORKFLOWS_DIR]` (with the auto-generated header),
removes any stale entries, and prints a summary.

On a fresh bootstrap this typically syncs 20+ files. On a repeat run, it syncs
zero.

## Step 6 — Validate parity between workflows and slash commands

Compare the two directories by file name:

```bash
diff \
  <(ls .agents/workflows/*.md 2>/dev/null | xargs -n1 -I{} basename {} .md | sort) \
  <(ls .claude/commands/*.md 2>/dev/null | xargs -n1 -I{} basename {} .md | sort)
```

Expected output: **empty diff**. Any asymmetry means the sync is broken — do
not report success until it is empty.

Also verify every file in `[COMMANDS_DIR]` begins with the auto-generated
header:

```bash
for f in .claude/commands/*.md; do
  head -n 1 "$f" | grep -q 'AUTO-GENERATED' || echo "MISSING HEADER: $f"
done
```

Any `MISSING HEADER` line is a failure — something bypassed the sync script.

## Step 7 — Optional: husky pre-commit wiring

Run this step **only if** the operator has husky available (auto-detect by
looking for `node_modules/husky/` or a `devDependencies.husky` entry). Skip
silently if husky is not already in the project — this workflow does not
install husky.

When husky is available:

1. Ensure `.husky/` directory exists; if not, prompt the operator to run
   `npx husky init` and re-invoke this workflow.
2. Check `.husky/pre-commit`. If the operator wants additional pre-commit
   checks (lint-staged, check-version-sync, etc.), suggest adding them here —
   but **do not** add a `sync-claude-commands.js` invocation. The
   `UserPromptSubmit` and `prepare` hooks already cover that case; duplicating
   it in pre-commit writes to a gitignored directory for no benefit (see the
   reasoning documented in [.agents/workflows/git-commit-all.md](git-commit-all.md)
   if further context is required).

Leave an existing `.husky/pre-commit` untouched unless the operator explicitly
asks for changes.

## Step 7.5 — Stabilized quality gates (Epic #1386)

After the husky scaffolding from Step 7 is in place, install the four
artefacts that catch CRAP / Maintainability drift at the keyboard rather
than at close-validation time. The single source of truth for what each
artefact does and where its thresholds live is
[`helpers/code-quality-guardrails.md`](helpers/code-quality-guardrails.md).

The four installs are encapsulated in
[`.agents/scripts/lib/bootstrap/quality-bootstrap.js`](../scripts/lib/bootstrap/quality-bootstrap.js)
so this workflow and [`/agents-update`](agents-update.md) drive them
through the same idempotent helper. Invoke the four steps from the
project root:

```bash
node -e "
  import('./.agents/scripts/lib/bootstrap/quality-bootstrap.js').then(m => {
    const r = m.applyQualityBootstrap({ projectRoot: process.cwd() });
    console.log(JSON.stringify(r, null, 2));
  });
"
```

Each step is idempotent and surfaces its outcome under its own key:

1. **`helper`** — copies
   [`helpers/code-quality-guardrails.md`](helpers/code-quality-guardrails.md)
   into the project's `.agents/workflows/helpers/` (no-op when `.agents/`
   is consumed as a submodule — the helper already lives there).
2. **`hook`** — installs `.husky/pre-commit` carrying the diff-scoped
   `quality:preview` invocation. When a custom (non-framework) hook
   already exists, the helper returns `custom-hook-skip` and emits a
   notice with the recommended snippet to merge in by hand. **Never**
   overwrite a custom hook silently; print the notice and move on.
3. **`scripts`** — adds `quality:preview` (default
   `node .agents/scripts/quality-preview.js --changed-since HEAD`) and
   `quality:watch` (`node .agents/scripts/quality-watch.js`) to
   `package.json` when missing. Existing values are preserved.
4. **`config`** — seeds `agentSettings.quality.codingGuardrails`
   (cyclomatic flag/must-fix, MI-drop refactor ceiling, sibling-test
   toggle) and `agentSettings.quality.autoRefresh` (delta caps for the
   bounded auto-refresh that runs at story-close) in `.agentrc.json`.
   Only missing keys are written; project overrides survive.

Re-running the helper on an already-bootstrapped project produces zero
mutations. The workflow report (Step 10) names the per-step outcomes
returned by `applyQualityBootstrap`.

## Step 8 — Ensure `.mcp.json` is gitignored

MCP servers are loaded by Claude Code from a project-scoped `.mcp.json` at
the repo root. The file carries secrets and must stay out of git; the
operator authors it by hand using the upstream documentation for whichever
MCP servers they wire up.

Verify `.gitignore` contains a line matching `^\.mcp\.json$`. If absent,
append:

```gitignore

# Project-scoped MCP config carries secrets — keep out of git.
.mcp.json
```

## Step 9 — Verify host-level git perf settings (Windows)

Invoke the warn-only perf check:

```bash
node .agents/scripts/check-windows-git-perf.js
```

The script probes three settings that materially speed up the framework's
many per-Story git operations on Windows:

- `core.fsmonitor true` (global) — built-in FS monitor daemon.
- `feature.manyFiles true` (global) — commit-graph / untracked cache /
  sparse-index defaults.
- `git maintenance start` (per-repo schedule) — registers the current
  clone for background prefetch / commit-graph / incremental repack.

Behaviour:

- **No-op on non-Windows hosts.** Exits 0 silently on macOS / Linux.
- **Warn-only.** The script never mutates global git config; it prints
  the exact commands to run for any missing setting and exits 0 either
  way. The operator decides whether to apply them.

Apply the suggested commands once per host (the global flags) or once per
clone (`git maintenance start`). They are idempotent — re-running them is
safe.

## Step 10 — Report outcome

Emit a compact summary showing what was touched on this run:

```text
[agents-bootstrap-project]
  package.json        scripts.sync:commands  added | already present
  package.json        scripts.prepare        added | appended | already present
  .claude/settings.json  UserPromptSubmit    wired | merged | already present
  .gitignore             .claude/commands/   added | already present
  .gitignore             .mcp.json           added | already present
  .claude/commands/                          <N> file(s) synced from workflows
  parity check                               OK | <asymmetry details>
  windows git perf check                     OK | <N> warning(s) | skipped (non-windows)
  quality helper                             present-via-submodule | copied | already-present
  .husky/pre-commit                          created | already-present | custom-hook-skip
  package.json        quality:preview        added | already present
  package.json        quality:watch          added | already present
  .agentrc.json       quality.codingGuardrails  added | already present
  .agentrc.json       quality.autoRefresh    added | already present
```

If every row shows `already present` and parity is OK, print a single
confirmation line:

```text
✔ Project already bootstrapped. No changes applied.
```

## Constraints

- **Idempotent.** Running twice back-to-back must apply zero changes on the
  second run.
- **Additive merges only.** Never overwrite an existing `scripts.prepare`,
  `UserPromptSubmit` hook, or `.gitignore` entry wholesale. Merge in place.
- **Never write to `[WORKFLOWS_DIR]`.** The framework workflow content is
  read-only from this workflow's perspective; it is managed by the framework
  submodule/clone, not by the bootstrap.
- **Never commit `[COMMANDS_DIR]`.** It is derived and per-clone; the
  gitignore step is what keeps it out of git.
- **No network I/O.** This workflow is fully local. It does not install
  dependencies, fetch framework files, or call GitHub APIs — those are the
  responsibility of `/agents-bootstrap-github` and the initial framework
  checkout.
- **Fail loudly.** Step 6 parity failure or Step 1 Node-version failure must
  be a hard stop, not a warning.
- **Do not auto-commit.** The operator reviews the diff of `package.json`,
  `.claude/settings.json`, and `.gitignore` before committing.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Step 6 parity check reports files in `.claude/commands/` without a source | Workflow was renamed/deleted; sync script was not re-run cleanly. | Re-run Step 5; the script removes stale entries. |
| Step 6 parity check reports files in `.agents/workflows/` without a command | Sync script failed mid-run, or the file lives in a subdirectory (e.g. `helpers/`) and is intentionally excluded. | If top-level, re-run Step 5. If in `helpers/`, expected — helpers are not exposed as slash commands. |
| `npm install` does not populate `.claude/commands/` | `scripts.prepare` was not merged (older package manager, or `prepare` is being skipped via `--ignore-scripts`). | Re-run Step 2, and avoid `--ignore-scripts` on trusted clones. |
| Slash commands stale after editing a workflow file | `UserPromptSubmit` hook not wired, or settings file has a legacy `cp`-based entry that does not handle renames/deletions. | Re-run Step 3; remove any legacy `cp` entry. |
| New clone reports "Node 18 is below required 20.x" | Project uses an older Node. | Upgrade Node or use a Node version manager (nvm, fnm, volta). |
