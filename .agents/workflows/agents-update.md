---
description: >-
  npm-era upgrade wraparound for a Mandrel consumer. Runs `mandrel update`
  (resolve newest non-major version → install → re-materialize `.agents/` →
  migrate → doctor → surface changelog) as the single mechanical step, then
  walks the operator through the judgment wraparound the CLI deliberately
  leaves unowned: reconcile `.agentrc.json`, install the Epic #1386
  quality-gate surface, refresh the harness permission allowlist, reconcile
  the consumer's `AGENTS.md` / runbooks against the surfaced changelog, and
  stage + commit the staged lockfile bump.
---

# /agents-update

> **Upgrade owner.** The mechanical upgrade is owned end to end by the
> [`mandrel update`](../../lib/cli/update.js) CLI under the npm distribution
> model (`@mandrelai/agents`, #3436/#3437). This workflow wraps that CLI: it
> runs `mandrel update`, then walks the operator through the
> **distribution-agnostic judgment steps** the CLI deliberately does **not**
> perform — config reconciliation, the Epic #1386 quality-gate installs, the
> permission-allowlist refresh, the consumer-side changelog reconciliation,
> and the stage-and-commit of the staged lockfile bump.

## Overview

`/agents-update` advances the consumer repo to the newest non-major
`@mandrelai/agents` release, re-materializes `.agents/`, and regenerates the
flat `.claude/commands/` tree (invoked as `/<name>`) against the new workflow
set — then reconciles the consumer's own config, harness allowlist, and
instructions against the change set the upgrade surfaced.

The upgrade contract:

- **The version only moves on explicit invocation.** `mandrel update`
  resolves the newest published version and bumps the dependency only when
  you run it. There is no `postinstall` hook and no background drift;
  teammates work against the exact `@mandrelai/agents` version pinned in the
  consumer's `package-lock.json` until someone runs this workflow and commits
  the result.
- **CI honours the committed lockfile.** Consumer CI runs `npm ci` against
  the committed `package-lock.json`, so it installs exactly the version the
  lockfile pins — never "whatever the registry's newest is today."
- **The major axis is gated.** `mandrel update` refuses to cross a major
  boundary (e.g. `1.x → 2.0`) without an explicit `--major`, printing a
  pointer to `docs/upgrade-major.md` and exiting non-zero without touching
  anything. Routine minor/patch bumps within the current major are never
  gated.
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
  prepends the `<!-- AUTO-GENERATED -->` header that
  `/agents-bootstrap-project` parity-checks. Nothing else copies workflow
  files.

> **Persona**: `devops-engineer` · **Skills**:
> `core/ci-cd-and-automation`, `core/documentation-and-adrs`

## Step 1 — Run the updater

Preview first, then apply. From the consumer repo root:

```bash
mandrel update --dry-run
mandrel update
```

`mandrel update --dry-run` resolves the newest non-major version and prints
the ordered step plan (`npm-update → runSync → runMigrations → doctor →
surface changelog`) without invoking any effectful seam — no dependency bump,
no sync, no migrations, no doctor, nothing written. Read the planned target
version before applying.

`mandrel update` (no flags) runs the live cycle:

1. **Resolve target** — the newest published `@mandrelai/agents` version (via
   the daily freshness cache in `temp/version-check.json`) and the currently
   installed version.
2. **Major gate** — if the newest version crosses a major boundary, the run
   declines, prints the `docs/upgrade-major.md` pointer, and exits non-zero
   without touching anything. Re-run with `--major` only after reviewing that
   runbook.
3. **No-op short-circuit** — already on the newest version ⇒ prints
   `Already up to date` and exits 0.
4. **Install** — bumps the dependency (default
   `npm install @mandrelai/agents@<target>`; pass
   `--install-cmd "<pm> <args>"` for a pnpm/yarn workspace). The lockfile
   change is left **staged** for review; the CLI never commits.
5. **runSync** — re-materializes `.agents/` from the freshly installed
   payload, which also regenerates the flat `.claude/commands/` tree via
   `sync-claude-commands.js`.
6. **runMigrations** — applies any version-keyed migration steps for the
   crossed range.
7. **doctor** — runs the check registry to verify the resulting install.
8. **Surface changelog** — prints the `docs/CHANGELOG.md` section(s) covering
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
[`helpers/agents-sync-config.md`](helpers/agents-sync-config.md).

If the helper prints `No changes required` with no advisories, the config
is already in sync — carry on. If it lists `[REDUNDANT]` rows, you may
optionally delete those keys from `.agentrc.json` by hand (commit
alongside the bump in Step 5) for a leaner config. If it exits non-zero,
fix the validation error and re-run before proceeding.

## Step 3.5 — Upgrade the stabilized-quality-gates surface (Epic #1386)

A framework bump that crosses the Epic #1386 boundary requires four
additive installs on the consumer project so the new gate behaviour is
actually wired into the consumer's commit / push / CI surfaces. The
installs share the same idempotent helpers
[`bootstrap.js`](../scripts/bootstrap.js) Step 7.5 uses,
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
`/story-deliver` or `/epic-deliver` run trips a fresh wave of
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

The maintenance cadence is **once per `/agents-update` invocation** —
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

`mandrel update` leaves the dependency bump **staged on disk** but never
commits. After reviewing the surfaced changelog, any `.agentrc.json`
reconciliation diff from Step 3, the `.claude/settings.json` allowlist
patch from Step 3.6, and the consumer instruction / runbook updates from
Step 4, stage and commit the bump (plus the reconciliation and consumer
edits, if any) from the consumer repo root:

```bash
git add package.json package-lock.json .agentrc.json .claude/settings.json AGENTS.md  # plus any runbook files touched in Step 4
git commit -m "chore: update @mandrelai/agents to v<NEW_VERSION>

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
> gitignored install artifact rebuilt by `mandrel sync`, depends on the
> consumer's own vendoring policy. Stage the `.agents/` / `.claude/`
> changes here only if the project commits its materialized tree.

## Troubleshooting

- **`a newer MAJOR version (X.0.0) is available`** — `mandrel update`
  hit the major gate and exited non-zero without touching anything. A
  major crossing is a breaking upgrade. Read `docs/upgrade-major.md`,
  then re-run `mandrel update --major` only after you have absorbed the
  migration steps that runbook describes.

- **`doctor reported failures: …`** — the dependency bumped and `.agents/`
  re-materialized, but a doctor check failed (and the run exited
  non-zero). Run `mandrel doctor` for the per-check remedies. The lockfile
  bump is already staged; fix the doctor finding (often a missing
  bootstrap install — Step 3.5 — or a stale `.agentrc.json` — Step 3)
  before committing in Step 5.

- **Install command failed / `npm install … exited <n>`** — the npm
  install step could not bump the dependency (network hiccup, registry
  auth gap, or a peer-dependency conflict). Resolve the underlying npm
  error and re-run `mandrel update`; it is idempotent — a clean re-run
  resumes from the resolve step and short-circuits if the install already
  landed.

- **Wrong package manager** — the default install is `npm install`. For a
  pnpm or yarn workspace, pass the package manager explicitly:
  `mandrel update --install-cmd "pnpm add @mandrelai/agents@<target>"`.
  The registry probe always stays on `npm view` (a PM-agnostic query); only
  the install seam honours the override.

## Constraints

- **Idempotent.** A second `mandrel update` immediately after a successful
  run resolves the same newest version, hits the no-op short-circuit, and
  prints `Already up to date` — exit 0, nothing bumped.
- **Non-major only by default.** The major axis is gated behind an explicit
  `--major`; routine minor/patch bumps within the current major apply
  without a gate.
- **No auto-commit.** `mandrel update` leaves the lockfile bump staged on
  disk and never runs git. The operator reviews the surfaced changelog and
  writes the commit message (Step 5) — the CLI does not know whether the
  bump is release-worthy for the consumer.
- **No framework-side version bump.** This workflow advances the
  *consumer's* pinned `@mandrelai/agents` version. It does not tag a release
  on the framework itself — that remains the framework maintainer's call via
  release-please.
