---
description: >-
  npm-era upgrade wraparound for a Mandrel consumer. Runs `npx mandrel update`
  (resolve newest published version → install → re-materialize `.agents/` →
  migrate → doctor → surface changelog) as the single mechanical step, then
  walks the operator through the judgment wraparound the CLI deliberately
  leaves unowned: reconcile `.agentrc.json`, install the Epic #1386
  quality-gate surface, refresh the harness permission allowlist, reconcile
  the consumer's `AGENTS.md` / runbooks against the surfaced changelog, and
  stage + commit the staged lockfile bump.
---

# /mandrel-update

> **Upgrade owner.** The mechanical upgrade is owned end to end by the
> [`mandrel update`](../../lib/cli/update.js) CLI under the npm distribution
> model (`mandrel`, #3436/#3437). This workflow wraps that CLI: it
> runs `npx mandrel update`, then walks the operator through the
> **distribution-agnostic judgment steps** the CLI deliberately does **not**
> perform — config reconciliation, the Epic #1386 quality-gate installs, the
> permission-allowlist refresh, the consumer-side changelog reconciliation,
> and the stage-and-commit of the staged lockfile bump.

## Overview

`/mandrel-update` advances the consumer repo to the newest published
`mandrel` release, re-materializes `.agents/`, and regenerates the
flat `.claude/commands/` tree (invoked as `/<name>`) against the new workflow
set — then reconciles the consumer's own config, harness allowlist, and
instructions against the change set the upgrade surfaced.

The upgrade contract:

- **The version only moves on explicit invocation.** `mandrel update`
  resolves the newest published version and bumps the dependency only when
  you run it. There is no `postinstall` hook and no background drift;
  teammates work against the exact `mandrel` version pinned in the
  consumer's `package-lock.json` until someone runs this workflow and commits
  the result.
- **CI honours the committed lockfile.** Consumer CI runs `npm ci` against
  the committed `package-lock.json`, so it installs exactly the version the
  lockfile pins — never "whatever the registry's newest is today."
- **Majors apply like any other bump.** Mandrel ships hard cutovers
  (`.agents/rules/git-conventions.md` § Contract Cutovers), so a major
  crossing is applied directly — the surfaced changelog is the migration
  guide.
- **The CLI never commits.** The npm bump rewrites `package.json` /
  `package-lock.json` and leaves them **staged on disk** for operator review;
  `mandrel update` performs no `git add` / `git commit`. Staging and
  committing the bump (plus any consumer-side reconciliation) is Step 5 of
  this workflow.
- **`.agents/workflows/` → `.claude/commands/` projection is delegated.**
  `mandrel update`'s sync step re-materializes `.agents/`, and the only
  authoritative writer of the generated flat command tree
  (`.claude/commands/`) is
  [`sync-claude-commands.js`](../scripts/sync-claude-commands.js), which
  prepends the `<!-- AUTO-GENERATED -->` header. Nothing else copies workflow
  files.

> **Persona**: `devops-engineer` · **Skills**:
> `core/ci-cd-and-automation`, `core/documentation-and-adrs`

**Invocation form.** In a consumer project `mandrel` is a local
devDependency at `node_modules/.bin/mandrel` and is **not** on `PATH`, so a
bare `mandrel <subcommand>` fails with `command not found` before any of the
hardened CLI logic ([`lib/cli/update.js`](../../lib/cli/update.js)) runs.
Every **runnable** command in this workflow therefore uses the
`npx mandrel <subcommand>` form, matching [`README.md`](../../README.md).
Prose that names the CLI as a noun (e.g. "`mandrel update`'s sync step")
refers to the binary by name, not as a command to type — run it via the form
Step 0 selects. The exception is a project where `mandrel` is installed
**globally**: there, the bare form works and Step 0 says so.

## Step 0 — Detect the install state and pick the invocation form

Before running the updater, detect how `mandrel` resolves in this project and
route to the matching invocation form. Run from the consumer repo root:

```bash
# 1. Globally installed and on PATH?
command -v mandrel
# 2. Installed as a local devDependency?
ls node_modules/.bin/mandrel 2>/dev/null || npm ls mandrel
```

Three real states, three routes:

| State                                   | Detection                                                              | Invocation form                                                   |
| --------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Global install (on `PATH`)**          | `command -v mandrel` prints a path                                     | Bare `mandrel <subcommand>` works.                                |
| **Local devDependency (not on `PATH`)** | `command -v mandrel` is empty; `node_modules/.bin/mandrel` exists      | Use `npx mandrel <subcommand>` (resolves the local bin).          |
| **Not installed**                       | `command -v mandrel` empty **and** `node_modules/.bin/mandrel` absent  | Run `npm install -D mandrel` first, then `npx mandrel`.           |

The common consumer case is **local devDependency** — `npx mandrel` is the
default form the rest of this workflow uses. On a global install you may drop
the `npx` prefix; on a fresh project, install the package first. The `npx`
form is harmless on a global install too (it prefers the local bin and falls
back to a one-off fetch), so when unsure, use `npx mandrel`.

## Step 0.5 — First-run preflight (before any bump)

Before running the updater, run the first-run preflight. It catches three
day-0 failure modes — **wrong project**, a **dirty git index**, and being
**offline** — before `npx mandrel update` bumps anything. Run from the
consumer repo root:

```bash
node .agents/scripts/mandrel-update-preflight.js
```

The preflight runs three checks and prints a JSON envelope
(`{ ok, blocked, findings[] }`) on stdout plus a human-readable report:

| Check              | Severity            | What it verifies                                                                                                                                                       |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **consumer-shape** | **blocker** (exit 2) | `package.json` lists `mandrel` as a dependency **and** a `.agents/` directory exists. Hard-stops in the framework repo itself or any non-consumer project.             |
| **dirty-index**    | warn-only           | The git index has no pre-existing staged changes. `mandrel update` leaves the lockfile staged and Step 5 would otherwise sweep unrelated staged files into the commit. |
| **offline**        | warn-only           | The npm registry is reachable (`npm ping`), so the version probe in Step 1 will not fail with a confusing offline error.                                               |

Severity follows framework preflight conventions (cf.
[`epic-deliver-preflight.js`](../scripts/epic-deliver-preflight.js), the
`story-close` preflight): the **consumer-shape** check is a hard stop — the
script exits `2` and you MUST NOT proceed until it is resolved; **dirty-index**
and **offline** are warn-only and never block the run.

Routing:

- **Exit 0, `ok: true`** — all checks passed; proceed to Step 1.
- **Exit 0 with warnings** (`blocked: false`, non-empty `findings[]`) —
  review the warnings. For **dirty-index**, unstage unrelated changes
  (`git restore --staged <path>`) so they are not swept into the
  `chore: update mandrel` commit. For **offline**, restore connectivity
  before the version probe. Then proceed.
- **Exit 2, `blocked: true`** — the consumer-shape check failed. Stop. You
  are not in a Mandrel consumer project (wrong directory, the framework repo
  itself, or a project that never ran `mandrel sync`). `cd` into the consumer
  repo, or bootstrap one with `npm install -D mandrel && npx mandrel sync`,
  then re-run the preflight.

> **Scope.** The preflight is a **workflow-layer** guard; it deliberately
> lives outside [`lib/cli/update.js`](../../lib/cli/update.js), which stays
> git-free and side-effect-scoped. It composes cleanly with the Step 0
> invocation-form detection above — Step 0 picks *how* to call the updater;
> Step 0.5 verifies it is *safe* to call it at all.

## Step 1 — Run the updater

Preview first, then apply. From the consumer repo root:

```bash
npx mandrel update --dry-run
npx mandrel update
```

`npx mandrel update --dry-run` resolves the newest published version and
prints the ordered step plan (`npm-update → runSync → runMigrations → doctor →
surface changelog`) without invoking any effectful seam — no dependency bump,
no sync, no migrations, no doctor, nothing written. Read the planned target
version before applying.

`npx mandrel update` (no flags) runs the live cycle:

1. **Resolve target** — the newest published `mandrel` version (via
   the daily freshness cache in `temp/version-check.json`) and the currently
   installed version.
2. **No-op short-circuit** — already on the newest version ⇒ prints
   `Already up to date` and exits 0.
3. **Install** — bumps the dependency (default
   `npm install mandrel@<target>`; pass
   `--install-cmd "<pm> <args>"` for a pnpm/yarn workspace). The lockfile
   change is left **staged** for review; the CLI never commits.
4. **runSync** — re-materializes `.agents/` from the freshly installed
   payload, which also regenerates the flat `.claude/commands/` tree via
   `sync-claude-commands.js`.
5. **runMigrations** — applies any version-keyed migration steps for the
   crossed range.
6. **doctor** — runs the check registry to verify the resulting install.
7. **Surface changelog** — prints the `docs/CHANGELOG.md` section(s) covering
   the applied range `(current, target]`. Capture this output — Step 4
   reconciles the consumer's own instructions against it.

## Step 2 — Expected output

A successful bump ends with:

```text
Updating v1.44.0 → v1.46.0…
✅  Updated to v1.46.0. The lockfile bump is staged for review.

Changelog for v1.46.0:
## [1.46.0](…)
### Features
* new workflow X
### Bug Fixes
* tighten Y validation
```

A no-op run (already on the newest version) looks like:

```text
✅  Already up to date (v1.46.0 is the newest version).
```

A `--dry-run` preview looks like:

```text
mandrel update — planned upgrade v1.44.0 → v1.46.0
  1. npm-update
  2. runSync
  3. runMigrations
  4. doctor
  5. surface changelog
Dry run: no files written, no dependency bumped.
```

## Step 2.5 — Partial-upgrade recovery (**blocker — resolve before Step 5**)

`mandrel update` runs its post-install phases in order — **install** →
**sync** → **sync-commands** → **migrate** → **doctor** — and the install
phase bumps `package.json` / `package-lock.json` and leaves the change
**staged on disk** *before* any of the later phases run. By deliberate
design the CLI **never rolls back the install on failure** (the lockfile
bump is left staged for the operator — see the Out-of-Scope note in
[`lib/cli/update.js`](../../lib/cli/update.js)). So when a post-install
phase exits non-zero, you land in a **partially-upgraded state**:

- The lockfile bump to the new version is **already staged**, *and*
- `.agents/` may be **half-materialized** (sync failed midway), the flat
  `.claude/commands/` tree may be **out of sync** (sync-commands failed), a
  version-keyed migration may have **partially applied** (migrate failed), or
  the post-upgrade state failed validation (doctor failed).

This is the dangerous case the whole workflow exists to guard: the operator
is now **one `git commit` away** (Step 5) from recording a broken
half-upgrade as "done". `mandrel update` prints the per-phase manual remedy
to **stderr**, but a line buried in stderr is easy to scroll past and commit
right over. **Treat any post-install phase failure as an explicit blocker:
do not proceed to Step 5 (commit) until the failed phase is recovered and a
clean re-run reports success.**

When `npx mandrel update` exits non-zero, identify which phase failed (the
CLI's stderr names it) and run the matching manual remedy from the consumer
repo root. These commands match the hint strings
[`lib/cli/update.js`](../../lib/cli/update.js) emits verbatim — it is the
single source of truth, kept in lockstep with this table by the
`mandrel-update-recovery-drift` contract test
([`tests/bootstrap/mandrel-update-recovery-drift.test.js`](../../tests/bootstrap/mandrel-update-recovery-drift.test.js)):

| Failed phase      | Manual remedy                                            |
| ----------------- | ------------------------------------------------------- |
| **sync**          | `npx mandrel sync`                                       |
| **sync-commands** | `npm run sync:commands`                                  |
| **migrate**       | `npx mandrel migrate --from <cur> --to <target>`        |
| **doctor**        | `npx mandrel doctor` (then apply the per-check remedies) |

The exact stderr the CLI prints per failed phase — quoted verbatim from
[`lib/cli/update.js`](../../lib/cli/update.js) so the table above can never
drift from what the operator actually sees:

- **sync** — the .agents/ materialization may be incomplete. Run `mandrel
  sync` manually to restore.
- **sync-commands** — the .claude/commands/ tree may be out of sync. Run `npm
  run sync:commands` manually to restore.
- **migrate** — some migrations for v\<cur\> → v\<target\> may not have
  applied. Run `mandrel migrate --from <cur> --to <target>` manually to retry.
- **doctor** — upgraded to v\<target\> but doctor reported failures. → Run
  `mandrel doctor` for remedies.

> **`<cur>` / `<target>`** are the installed and resolved-newest version
> strings the CLI printed in Step 1 (e.g. `--from 1.44.0 --to 1.46.0`).
> Substitute the real values the failing run reported.

Recovery sequence:

1. **Run the matching remedy** for the failed phase from the table above.
2. **Re-run `npx mandrel update`.** It is idempotent — the install already
   landed, so a clean re-run short-circuits the bump and re-drives the
   post-install phases. Repeat the per-phase remedy until the run reports
   `✅  Updated to v<target>. The lockfile bump is staged for review.` (or
   `✅  Already up to date`).
3. **Only then proceed** to Step 3. The staged lockfile bump is safe to
   commit (Step 5) once — and only once — the post-install phases have all
   gone green.

> **Why not auto-rollback / `mandrel update --resume`?** A `--resume` flag
> that re-enters the cycle at the failed phase was **evaluated and
> deferred** (Story #4172, Out of Scope). The per-phase manual remedies
> above fully cover recovery: each failed phase has an exact, idempotent
> command, and re-running `npx mandrel update` already short-circuits the
> completed install and re-drives the remaining phases — so a dedicated
> resume entrypoint would add a parallel code path without covering any
> recovery case the manual remedies miss. If a future change makes the
> phases expensive enough that re-driving completed ones is wasteful,
> revisit `--resume` then; today it is unnecessary.

## Step 3 — Reconcile `.agentrc.json` against the new defaults

A framework bump can add or reshape fields in
`.agents/docs/agentrc-reference.json` (and the underlying schema). Run the
reconciliation helper to verify the consumer's `.agentrc.json` still
validates against the new schema, and to surface any project values that
already match framework defaults (and could therefore be safely deleted):

```bash
node .agents/scripts/sync-agentrc.js
```

The helper (Story #1995) is **default-aware** and **read-only**:

- The project config is **validated** against the framework schema. Any
  failure aborts the run with a diagnostic so the operator can fix the
  underlying typo / missing required key before proceeding.
- Optional keys missing from the project are **never auto-filled**. The
  runtime layers framework defaults at read time, so writing them into
  `.agentrc.json` only bloats the consumer's config diff without
  changing behaviour.
- Project values that deep-equal the framework default are flagged as
  `[REDUNDANT]` advisory rows — informational only; the file is never
  modified.

Full procedure reference:
[`helpers/mandrel-sync-config.md`](helpers/mandrel-sync-config.md).

If the helper prints `No changes required` with no advisories, the config
is already in sync — carry on. If it lists `[REDUNDANT]` rows, you may
optionally delete those keys from `.agentrc.json` by hand (commit
alongside the bump in Step 5) for a leaner config. If it exits non-zero,
fix the validation error and re-run before proceeding.

## Step 3.5 — Upgrade the stabilized-quality-gates surface (Epic #1386)

A framework bump that crosses the Epic #1386 boundary requires four
additive installs on the consumer project so the new gate behaviour is
actually wired into the consumer's commit / push / CI surfaces. The
installs share the same idempotent helpers the quality-gates phase of
[`bootstrap.js`](../scripts/bootstrap.js) uses,
so a project that already ran the bootstrap on a post-Epic #1386
framework version sees `no-change` everywhere here.

Run from the consumer repo root:

```bash
node .agents/scripts/apply-quality-bootstrap.js
```

The script (Story #4171) replaced the prior inline `node -e` heredoc — a
shell-fragile, untested block that silently drifted whenever the two helper
signatures moved (see
[`apply-quality-bootstrap.js`](../scripts/apply-quality-bootstrap.js)). It
runs the same two installs in order against `process.cwd()` —
`applyQualityBootstrap` then `migrateBaselinesLayout` — and prints the same
`{ quality, baselines }` JSON envelope to stdout. It is idempotent: a second
run is a no-op beyond reporting `no-change` on every install path.

The four `quality-bootstrap` outcomes:

1. **`helper`** — copies
   [`code-quality-guardrails.md`](helpers/code-quality-guardrails.md)
   into the project's `.agents/workflows/helpers/`. On the npm
   distribution the helper is materialized into `.agents/` by
   `mandrel update`'s sync step, so this typically reports a `no-change`
   present outcome.
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
scratch state, not committed, reaped on `/deliver` merge with the
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
guarantee `mandrel-update`'s idempotence contract requires.

## Step 3.6 — Refresh the harness permission allowlist (`/fewer-permission-prompts`)

A framework bump frequently introduces new helper scripts and `node
.agents/scripts/<name>.js` invocations the consumer's
`.claude/settings.json` allowlist has never seen. Left alone, the next
`/deliver` or `/deliver` run trips a fresh wave of
permission prompts that operators answer by hand — and those hand-tuned
allowlists drift across projects.

Run the harness skill that scans recent transcripts and emits an
additive allowlist patch for `.claude/settings.json`:

```text
/fewer-permission-prompts
```

The skill is supplied by the Claude Code harness (it is not a workflow
in this repo); invoke it as a slash command from the same Claude Code
session that just ran `mandrel update`. It:

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
  stage it alongside the version bump in Step 5.

The maintenance cadence is **once per `/mandrel-update` invocation** —
the same operator who just ran `mandrel update` is the one with the
freshest transcript context to review the proposed allowlist
diff. Skipping the step is fine when the bump introduces no new
scripts (the skill will report "no new high-frequency calls"), but the
step itself is non-optional: silence-by-omission is what produces the
hand-tuned drift this maintenance is meant to eliminate.

## Step 4 — Review the surfaced changelog and update consumer-side guidance

Framework upgrades change behaviour the consumer project's own
`AGENTS.md` (or `CLAUDE.md`) and project runbooks often encode — e.g.,
new validators that change what a planner is allowed to emit, new
ticket-body schemas downstream agents must produce, retired flags or
defaults the consumer's instructions still reference. The version bump is
the right moment to reconcile those, while the diff is in front of the
operator.

`mandrel update` already **surfaced the changelog** for the applied range
`(current, target]` in Step 1 — its final step prints every
`docs/CHANGELOG.md` section newer than the installed version and no newer
than the target. That printed range is your source of truth; you do not
need to fetch a CHANGELOG from anywhere, since the CLI emitted it inline.
If the upgrade output scrolled past, re-read the prior run's transcript or
open the framework's GitHub Releases page for the version headers the
bump spanned.

For each changelog entry between the installed and target versions, check
the consumer repo for guidance that has gone stale or guidance that should
now exist:

1. **Consumer `AGENTS.md` / `CLAUDE.md`.** If the changelog entry
   introduces a new contract the consumer instructions must reflect
   (e.g., "tasks must emit a structured 4-section body", "PRs must
   include `audit-snapshot:`"), update the consumer instructions so a
   fresh agent reading them in isolation produces output that passes
   the framework's new validators. Conversely, remove or rewrite
   instructions that contradict a tightened rule.
2. **Project-specific runbooks.** If the consumer has its own runbooks
   (e.g., `docs/RUNBOOK.md`, `docs/delivery-runner.md`) that paraphrase
   framework workflows, sweep them for renamed flags / changed exit
   codes / removed scripts.

Do not invent updates. If a changelog entry has no consumer-side
implication, note that explicitly in your scratch and move on — silence
is a valid review outcome. The goal is to leave the consumer
instructions and runbooks *consistent* with the new framework version,
not to manufacture churn.

Stage every consumer-side edit alongside the staged lockfile bump so the
upgrade and the reconciliation land in the same commit (Step 5). A
reviewer reading the bump should be able to see, in one diff, both
"the framework version moved" and "what we changed in our own files in
response."

## Step 5 — Commit the bump

> **Blocker check before you commit.** The staged lockfile bump is only safe
> to commit once every post-install phase has gone green. If `npx mandrel
> update` exited non-zero, you are in a partially-upgraded state — resolve it
> via [Step 2.5 — Partial-upgrade recovery](#step-25--partial-upgrade-recovery-blocker--resolve-before-step-5)
> (run the per-phase remedy, re-run the updater to success) **before** running
> the `git commit` below. Committing over a half-upgrade records a broken
> state as "done".

`mandrel update` leaves the dependency bump **staged on disk** but never
commits. After reviewing the surfaced changelog, any `.agentrc.json`
reconciliation diff from Step 3, the `.claude/settings.json` allowlist
patch from Step 3.6, and the consumer instruction / runbook updates from
Step 4, stage and commit the bump (plus the reconciliation and consumer
edits, if any) from the consumer repo root:

```bash
git add package.json package-lock.json .agentrc.json .claude/settings.json AGENTS.md  # plus any runbook files touched in Step 4
git commit -m "chore: update mandrel to v<NEW_VERSION>

Upgraded v<OLD_VERSION> → v<NEW_VERSION> via mandrel update.

- feat: new workflow X
- fix: tighten Y validation
- consumer: update AGENTS.md task-body schema reference"
```

Include the version range and, optionally, the surfaced changelog
highlights so reviewers can see what moved without re-running the
updater. Omit `.agentrc.json` from the `git add` if Step 3 reported
`No changes required`; omit `.claude/settings.json` if Step 3.6 produced
no accepted entries; omit the consumer-instruction paths if Step 4 was a
no-op.

> **Note:** `mandrel update`'s sync step also re-materializes `.agents/`
> (and the flat command tree under `.claude/commands/`). On the npm
> distribution `.agents/` is a
> materialized directory rebuilt from the installed package — whether the
> consumer commits the regenerated `.agents/` tree, or treats it as a
> gitignored install artifact rebuilt by `npx mandrel sync`, depends on the
> consumer's own vendoring policy. Stage the `.agents/` / `.claude/`
> changes here only if the project commits its materialized tree.

## Troubleshooting

- **`doctor reported failures: …`** — the dependency bumped and `.agents/`
  re-materialized, but a doctor check failed (and the run exited
  non-zero). This is one shape of the **partial-upgrade** failure mode —
  the lockfile bump is already staged, so it is a **blocker** you MUST
  resolve before the commit step (see
  [Step 2.5 — Partial-upgrade recovery](#step-25--partial-upgrade-recovery-blocker--resolve-before-step-5)).
  Run `npx mandrel doctor` for the per-check remedies; fix the doctor
  finding (often a missing bootstrap install — Step 3.5 — or a stale
  `.agentrc.json` — Step 3), re-run `npx mandrel update` until it reports
  success, and only then commit in Step 5.

- **A post-install phase failed (`sync` / `sync-commands` / `migrate`)** —
  the install bumped the lockfile but a later phase exited non-zero, leaving
  a partially-upgraded tree. Do not commit. Run the matching per-phase
  remedy and re-run the updater per
  [Step 2.5 — Partial-upgrade recovery](#step-25--partial-upgrade-recovery-blocker--resolve-before-step-5).

- **Install command failed / `npm install … exited <n>`** — the npm
  install step could not bump the dependency (network hiccup, registry
  auth gap, or a peer-dependency conflict). Resolve the underlying npm
  error and re-run `npx mandrel update`; it is idempotent — a clean re-run
  resumes from the resolve step and short-circuits if the install already
  landed.

- **Wrong package manager** — the default install is `npm install`. For a
  pnpm or yarn workspace, pass the package manager explicitly:
  `npx mandrel update --install-cmd "pnpm add mandrel@<target>"`.
  The registry probe always stays on `npm view` (a PM-agnostic query); only
  the install seam honours the override.

## Constraints

- **Idempotent.** A second `mandrel update` immediately after a successful
  run resolves the same newest version, hits the no-op short-circuit, and
  prints `Already up to date` — exit 0, nothing bumped.
- **No auto-commit.** `mandrel update` leaves the lockfile bump staged on
  disk and never runs git. The operator reviews the surfaced changelog and
  writes the commit message (Step 5) — the CLI does not know whether the
  bump is release-worthy for the consumer.
- **No framework-side version bump.** This workflow advances the
  *consumer's* pinned `mandrel` version. It does not tag a release
  on the framework itself — that remains the framework maintainer's call via
  release-please.
