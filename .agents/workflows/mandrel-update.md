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
> model (#3436/#3437). This workflow wraps that CLI: it runs
> `npx mandrel update`, then walks the operator through the
> **distribution-agnostic judgment steps** the CLI deliberately does **not**
> perform — config reconciliation, the Epic #1386 quality-gate installs, the
> permission-allowlist refresh, the consumer-side changelog reconciliation,
> and the stage-and-commit of the staged lockfile bump.

The upgrade contract, in brief: the version only moves on explicit
invocation (no `postinstall` drift — teammates track the committed
lockfile pin, and CI's `npm ci` honours it); majors apply like any other
bump (Mandrel ships hard cutovers — the surfaced changelog is the
migration guide); the CLI **never commits** (the lockfile bump is left
staged for operator review); and the only authoritative writer of the
generated `.claude/commands/` tree is
[`sync-claude-commands.js`](../scripts/sync-claude-commands.js), invoked by
the CLI's sync step.

> **Persona**: `devops-engineer` · **Skills**:
> `core/ci-cd-and-automation`, `core/documentation-and-adrs`

## Step 0 — Detect the install state and pick the invocation form

In a consumer project `mandrel` is usually a local devDependency and **not**
on `PATH`, so the bare `mandrel <subcommand>` form fails before any CLI
logic runs. Detect and route:

- `command -v mandrel` prints a path → global install; the bare form works.
- `node_modules/.bin/mandrel` exists → local devDependency; use
  `npx mandrel <subcommand>` (the default form the rest of this workflow
  uses — it is harmless on a global install too).
- Neither → run `npm install -D mandrel` first, then `npx mandrel`.

## Step 0.5 — First-run preflight (before any bump)

```bash
node .agents/scripts/mandrel-update-preflight.js
```

Catches three day-0 failure modes before anything bumps, printing a JSON
envelope (`{ ok, blocked, findings[] }`) plus a human-readable report:

- **consumer-shape** — **blocker** (exit 2): `package.json` lists `mandrel`
  **and** `.agents/` exists. On failure, STOP — you are not in a consumer
  project (wrong directory, the framework repo itself, or a project that
  never ran `mandrel sync`). `cd` into the consumer repo or bootstrap one
  (`npm install -D mandrel && npx mandrel sync`), then re-run.
- **dirty-index** — warn-only: pre-existing staged changes would be swept
  into the Step 5 commit; `git restore --staged <path>` the unrelated ones.
- **offline** — warn-only: `npm ping` fails; restore connectivity before
  the version probe.

The preflight is a workflow-layer guard; it deliberately lives outside
[`lib/cli/update.js`](../../lib/cli/update.js), which stays git-free.

## Step 1 — Run the updater

Preview first, then apply, from the consumer repo root:

```bash
npx mandrel update --dry-run
npx mandrel update
```

The dry run resolves the newest published version and prints the ordered
step plan (`npm-update → runSync → runMigrations → doctor → surface
changelog`) without touching anything — read the planned target version
before applying. The live run drives those phases in order, leaves the
lockfile bump **staged** (never committed), and finishes by printing the
`docs/CHANGELOG.md` sections covering the applied range `(current, target]`.
**Capture that changelog output** — Step 4 reconciles the consumer's own
instructions against it. Already-newest is a clean no-op (`Already up to
date`, exit 0).

## Step 2.5 — Partial-upgrade recovery (**blocker — resolve before Step 5**)

The install phase stages the lockfile bump *before* the later phases run,
and by deliberate design the CLI **never rolls back the install on
failure**. So when a post-install phase (`sync` / `sync-commands` /
`migrate` / `doctor`) exits non-zero you land in a **partially-upgraded
state**: the bump is already staged while `.agents/` may be
half-materialized, the command tree out of sync, or a migration partially
applied — and the operator is one `git commit` away from recording a broken
half-upgrade as "done". **Treat any post-install phase failure as an
explicit blocker: do not proceed to Step 5 until the failed phase is
recovered and a clean re-run reports success.**

Identify the failed phase (the CLI's stderr names it) and run the matching
remedy. These commands match the hint strings
[`lib/cli/update.js`](../../lib/cli/update.js) emits verbatim — it is the
single source of truth, kept in lockstep with this table by
[`tests/bootstrap/mandrel-update-recovery-drift.test.js`](../../tests/bootstrap/mandrel-update-recovery-drift.test.js):

| Failed phase      | Manual remedy                                            |
| ----------------- | ------------------------------------------------------- |
| **sync**          | `npx mandrel sync`                                       |
| **sync-commands** | `npm run sync:commands`                                  |
| **migrate**       | `npx mandrel migrate --from <cur> --to <target>`        |
| **doctor**        | `npx mandrel doctor` (then apply the per-check remedies) |

The exact stderr the CLI prints per failed phase:

- **sync** — the .agents/ materialization may be incomplete. Run `mandrel
  sync` manually to restore.
- **sync-commands** — the .claude/commands/ tree may be out of sync. Run `npm
  run sync:commands` manually to restore.
- **migrate** — some migrations for v\<cur\> → v\<target\> may not have
  applied. Run `mandrel migrate --from <cur> --to <target>` manually to retry.
- **doctor** — upgraded to v\<target\> but doctor reported failures. → Run
  `mandrel doctor` for remedies.

(`<cur>` / `<target>` are the installed and resolved-newest version strings
the failing run reported.)

Recovery sequence: run the matching remedy, then **re-run
`npx mandrel update`** — it is idempotent (the install already landed, so a
clean re-run short-circuits the bump and re-drives the post-install
phases). Repeat until it reports success; only then proceed. A dedicated
`--resume` entrypoint was evaluated and deferred (Story #4172) — the
per-phase remedies plus the idempotent re-run already cover every recovery
case.

## Step 3 — Reconcile `.agentrc.json` against the new defaults

```bash
node .agents/scripts/sync-agentrc.js
```

The helper (Story #1995) is default-aware and **read-only**: it validates
the consumer config against the new schema (non-zero exit → fix the
validation error and re-run before proceeding), never auto-fills missing
optional keys (the runtime layers defaults at read time), and flags
project values that deep-equal the framework default as `[REDUNDANT]`
advisory rows you may optionally delete by hand (commit alongside the bump
in Step 5). Full procedure:
[`helpers/mandrel-sync-config.md`](helpers/mandrel-sync-config.md).

## Step 3.5 — Upgrade the stabilized-quality-gates surface (Epic #1386)

```bash
node .agents/scripts/apply-quality-bootstrap.js
```

Runs the same idempotent installs the quality-gates phase of
[`bootstrap.js`](../scripts/bootstrap.js) uses — `applyQualityBootstrap`
then `migrateBaselinesLayout` — and prints a `{ quality, baselines }` JSON
envelope. The four quality-bootstrap outcomes: **helper** (materialize
[`code-quality-guardrails.md`](helpers/code-quality-guardrails.md)),
**hook** (install the `.husky/pre-commit` diff-scoped `quality:preview`
invocation — a pre-existing **custom hook is never overwritten silently**;
the action is `custom-hook-skip` and the helper returns the snippet to
append by hand), **scripts** (backfill `quality:preview` /
`quality:watch` only when absent), **config** (seed missing
`delivery.quality.*` defaults — operator overrides survive). The baselines
step relocates per-Epic snapshots under `temp/epic/<id>/baselines/`; the
main-tracked root baselines are never touched. A second run reports
`no-change` on every path — the idempotence contract this workflow
requires.

## Step 3.6 — Refresh the harness permission allowlist

A framework bump frequently introduces new `node .agents/scripts/<name>.js`
invocations the consumer's `.claude/settings.json` allowlist has never
seen; left alone, the next delivery run trips a wave of hand-answered
permission prompts that drift across projects. From the same session that
ran the update, invoke the harness-supplied skill:

```text
/fewer-permission-prompts
```

Treat its output as a **PR-reviewable artifact**, not an auto-applied
change: reject anything granting write permissions, network egress, or
destructive shell-outs; accept only narrowly-scoped read-only entries;
apply the accepted subset to `.claude/settings.json` and stage it alongside
the bump. The cadence is once per `/mandrel-update` invocation — skipping
is fine when the bump introduces no new scripts, but the review itself is
non-optional.

## Step 4 — Review the surfaced changelog and update consumer-side guidance

Framework upgrades change behaviour the consumer's own `AGENTS.md` /
`CLAUDE.md` and runbooks often encode. Step 1 already printed the changelog
for the applied range — that output is your source of truth (re-read the
transcript or the GitHub Releases page if it scrolled past). For each entry
between the installed and target versions:

1. **Consumer `AGENTS.md` / `CLAUDE.md`.** Update instructions so a fresh
   agent reading them in isolation produces output that passes the
   framework's new validators; remove or rewrite instructions that
   contradict a tightened rule.
2. **Project-specific runbooks.** Sweep any docs that paraphrase framework
   workflows for renamed flags / changed exit codes / removed scripts.

Do not invent updates — silence is a valid review outcome. Stage every
consumer-side edit alongside the staged lockfile bump so the upgrade and
the reconciliation land in one reviewable commit.

## Step 5 — Commit the bump

> **Blocker check before you commit.** The staged lockfile bump is only safe
> to commit once every post-install phase has gone green. If `npx mandrel
> update` exited non-zero, resolve it via
> [Step 2.5 — Partial-upgrade recovery](#step-25--partial-upgrade-recovery-blocker--resolve-before-step-5)
> **before** the `git commit` below. Committing over a half-upgrade records
> a broken state as "done".

Stage and commit the bump plus everything the wraparound touched:

```bash
git add package.json package-lock.json .agentrc.json .claude/settings.json AGENTS.md  # plus any runbook files touched in Step 4
git commit -m "chore: update mandrel to v<NEW_VERSION>

Upgraded v<OLD_VERSION> → v<NEW_VERSION> via mandrel update.

- feat: new workflow X
- fix: tighten Y validation
- consumer: update AGENTS.md task-body schema reference"
```

Include the version range and, optionally, the surfaced changelog
highlights. Omit any path whose step was a no-op. Whether the consumer
commits the re-materialized `.agents/` / `.claude/commands/` trees or
gitignores them as install artifacts depends on the consumer's own
vendoring policy — stage them here only if the project commits its
materialized tree.

## Constraints

- **Idempotent.** A second `mandrel update` after a successful run hits the
  no-op short-circuit — exit 0, nothing bumped.
- **No auto-commit.** The CLI leaves the lockfile bump staged and never runs
  git; the operator writes the commit (Step 5).
- **No framework-side version bump.** This workflow advances the
  *consumer's* pinned version; framework releases remain the maintainer's
  call via release-please.
- **Wrong package manager?** The default install seam is `npm install`; for
  a pnpm/yarn workspace pass
  `--install-cmd "pnpm add mandrel@<target>"` (the registry probe stays on
  the PM-agnostic `npm view`).
