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
7. Execs `node .agents/scripts/check-windows-git-perf.js` to verify
   host-level git performance settings on Windows (`core.fsmonitor`,
   `feature.manyFiles`, per-repo `git maintenance` schedule). Warn-only;
   no-op on macOS / Linux. Prints the exact commands to run for any
   missing setting and exits 0 either way.

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

## Step 3.5 — Upgrade the stabilized-quality-gates surface (Epic #1386)

A framework bump that crosses the Epic #1386 boundary requires four
additive installs on the consumer project so the new gate behaviour is
actually wired into the consumer's commit / push / CI surfaces. The
installs share the same idempotent helpers
[`/agents-bootstrap-project`](agents-bootstrap-project.md) Step 7.5 uses,
so a project that already ran the bootstrap on a post-Epic #1386
framework version sees `no-change` everywhere here.

Run from the consumer repo root:

```bash
node -e "
  Promise.all([
    import('./.agents/scripts/lib/bootstrap/quality-bootstrap.js'),
    import('./.agents/scripts/lib/bootstrap/baselines-layout-migration.js'),
  ]).then(([qb, bm]) => {
    const root = process.cwd();
    const quality = qb.applyQualityBootstrap({ projectRoot: root });
    const baselines = bm.migrateBaselinesLayout({
      baselinesDir: require('node:path').join(root, 'baselines'),
      repoRoot: root,
    });
    console.log(JSON.stringify({ quality, baselines }, null, 2));
  });
"
```

The four `quality-bootstrap` outcomes:

1. **`helper`** — copies
   [`code-quality-guardrails.md`](helpers/code-quality-guardrails.md)
   into the project's `.agents/workflows/helpers/`. Reports
   `present-via-submodule` when `.agents/` is a submodule (the helper
   already lives upstream).
2. **`hook`** — installs `.husky/pre-commit` carrying the
   diff-scoped `quality:preview` invocation. **Custom hooks are
   preserved**: when a non-framework hook already exists the action is
   `custom-hook-skip` and the helper returns the recommended snippet
   the operator should append by hand. Print the notice and move on —
   never overwrite a custom hook silently.
3. **`scripts`** — backfills `quality:preview` and `quality:watch` in
   `package.json` only when the keys are absent. Existing operator
   values survive.
4. **`config`** — seeds `delivery.quality.codingGuardrails` and
   `delivery.quality.autoRefresh` defaults in `.agentrc.json`.
   Only missing keys are written — operator overrides survive.

The `baselines-layout-migration` step relocates per-Epic snapshots
into the `temp/epic/<id>/baselines/` namespace (Story #1467: ephemeral
scratch state, not committed, reaped on `/epic-deliver` merge with the
rest of the per-Epic temp tree):

- Loose `baselines/epic-<id>-{maintainability,crap}.json` files →
  moved under `temp/epic/<id>/baselines/`.
- Legacy `baselines/snapshots/<id>/{maintainability,crap}.json` trees →
  re-keyed under `temp/epic/<id>/baselines/`.
- Committed `baselines/epic/<id>/{maintainability,crap}.json` snapshots
  (the shape Story #1396 introduced) → moved out to
  `temp/epic/<id>/baselines/` and the now-empty committed tree is staged
  for removal via `git rm -r --quiet --ignore-unmatch baselines/epic/<id>`
  so the next commit prunes the tracked tree.
- The main-tracked `baselines/{maintainability,crap}.json` files at
  the root are **not** touched — they remain the `main`-baseline
  contract for the framework.

A second run produces `no-change` on every install path, which is the
guarantee `agents-update`'s idempotence contract requires.

## Step 3.6 — Refresh the harness permission allowlist (`/fewer-permission-prompts`)

A framework bump frequently introduces new helper scripts and `node
.agents/scripts/<name>.js` invocations the consumer's
`.claude/settings.json` allowlist has never seen. Left alone, the next
`/story-execute` or `/epic-deliver` run trips a fresh wave of
permission prompts that operators answer by hand — and those hand-tuned
allowlists drift across projects.

Run the harness skill that scans recent transcripts and emits an
additive allowlist patch for `.claude/settings.json`:

```text
/fewer-permission-prompts
```

The skill is supplied by the Claude Code harness (it is not a workflow
in this repo); invoke it as a slash command from the same Claude Code
session that just bumped the submodule. It:

1. Reads recent transcripts under `.claude/projects/.../`.
2. Buckets repeated read-only Bash + MCP tool calls by frequency.
3. Proposes a prioritized additive allowlist patch (project
   `.claude/settings.json`) — never removes existing entries.

Treat the skill's output as a **PR-reviewable artifact**, not an
auto-applied change:

- Read every proposed entry. Reject anything that grants write
  permissions, network egress, or shells out to a destructive
  command (`rm`, `git push --force`, `gh release delete`, ...).
- Accept only narrowly-scoped read-only entries
  (`Bash(node .agents/scripts/<name>.js *)`, `Bash(gh issue view *)`,
  `mcp__github__get_*`, etc.).
- Apply the accepted subset by editing `.claude/settings.json` and
  stage it alongside the submodule bump in Step 5.

The maintenance cadence is **once per `/agents-update` invocation** —
the same operator who just moved the framework pointer is the one with
the freshest transcript context to review the proposed allowlist
diff. Skipping the step is fine when the bump introduces no new
scripts (the skill will report "no new high-frequency calls"), but the
step itself is non-optional: silence-by-omission is what produces the
hand-tuned drift this maintenance is meant to eliminate.

## Step 4 — Review the CHANGELOG and update consumer-side guidance

Framework upgrades change behaviour the consumer project's own
`AGENTS.md` (or `CLAUDE.md`) and project runbooks often encode — e.g.,
new validators that change what a planner is allowed to emit, new
ticket-body schemas downstream agents must produce, retired flags or
defaults the consumer's instructions still reference. The pointer move is
the right moment to reconcile those, while the diff is in front of the
operator.

Read [`docs/CHANGELOG.md`](../../docs/CHANGELOG.md) inside the bumped
`.agents/` submodule. Focus on every entry between `OLD_SHA` and
`NEW_SHA` (the shortlog from Step 1 names the version headers to scan).
For each entry, check the consumer repo for guidance that has gone
stale or guidance that should now exist:

1. **Consumer `AGENTS.md` / `CLAUDE.md`.** If the changelog entry
   introduces a new contract the consumer instructions must reflect
   (e.g., "tasks must emit a structured 4-section body", "PRs must
   include `audit-snapshot:`"), update the consumer instructions so a
   fresh agent reading them in isolation produces output that passes
   the framework's new validators. Conversely, remove or rewrite
   instructions that contradict a tightened rule.
2. **Project-specific runbooks.** If the consumer has its own runbooks
   (e.g., `docs/RUNBOOK.md`, `docs/orchestration.md`) that paraphrase
   framework workflows, sweep them for renamed flags / changed exit
   codes / removed scripts.

Do not invent updates. If a changelog entry has no consumer-side
implication, note that explicitly in your scratch and move on — silence
is a valid review outcome. The goal is to leave the consumer
instructions and runbooks *consistent* with the new framework version,
not to manufacture churn.

Stage every consumer-side edit alongside the submodule pointer move so
the bump and the reconciliation land in the same commit (Step 5). A
reviewer reading the bump should be able to see, in one diff, both
"the framework moved" and "what we changed in our own files in
response."

## Step 5 — Commit the bump

The script never auto-commits. After reviewing the shortlog, any
`.agentrc.json` reconciliation diff from Step 3, the
`.claude/settings.json` allowlist patch from Step 3.6, and the consumer
instruction / runbook updates from Step 4, stage and commit the
pointer move (plus the reconciliation and consumer edits, if any)
from the consumer repo root:

```bash
git add .agents .agentrc.json .claude/settings.json AGENTS.md  # plus any runbook files touched in Step 4
git commit -m "chore: bump .agents to <NEW_SHORT_SHA>

OLD..NEW: a1b2c3d4e5f6..9f8e7d6c5b4a

- feat: new workflow X
- fix: tighten Y validation
- consumer: update AGENTS.md task-body schema reference"
```

Include the SHA range and, optionally, the shortlog so reviewers can see
what moved without re-running the updater. Omit `.agentrc.json` from the
`git add` if Step 3 reported `No changes required`; omit
`.claude/settings.json` if Step 3.6 produced no accepted entries; omit
the consumer-instruction paths if Step 4 was a no-op.

## Troubleshooting

- **`fatal: needed a single revision`** — the submodule entry in
  `.gitmodules` does not pin a remote branch. Add
  `branch = main` (or the appropriate branch name) under the `.agents`
  entry:

  ```ini
  [submodule ".agents"]
    path = .agents
    url = https://github.com/dsj1984/mandrel.git
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
