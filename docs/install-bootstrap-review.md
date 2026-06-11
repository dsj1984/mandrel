# Install & Bootstrap Review — open findings

- **Original review:** 2026-06-10 at `mandrel` v1.54.0 (commit `a7ff890e`)
- **Re-verified:** 2026-06-11 at v1.59.0 (commit `9cdc39b6`) — every finding
  below was independently re-checked against current `main`; resolved findings
  were removed. The full original record is in this file's git history (added
  in `95fbaaf3`).
- **Scope:** the install/bootstrap surface — `bin/mandrel.js` +
  `bin/postinstall.js`, `lib/cli/*`, the `.agents/scripts/bootstrap.js` pipeline
  and `lib/bootstrap/` helpers, `agents-bootstrap-github.js`, npm packaging, the
  Install Matrix CI, and the getting-started docs.

## What resolved since the last review

- **The `create-mandrel` launcher was removed** (`mandrel init` superseded it —
  `e2d6dcf2`, [#4027](https://github.com/dsj1984/mandrel/pull/4027)). This
  retires the entire prior **P0** ("launcher never published / name
  squattable"), the launcher's floating-`latest` install, the launcher
  `package.json` engines duplication, and the launcher leg of the Install
  Matrix. `mandrel init` is the single advertised cold-start path and it works.
- **The bootstrap was rewritten** (Story #3690): the phased-approval manifest is
  gone, replaced by a plain summary + confirm loop with a phase-group consent
  model. This resolves the former **merge-methods `[y/N]` Enter-through trap**
  (there are no longer any `[Y/n]` accept-default prompts whose polarity the
  final gate inverted — the only yes/no prompt is a single, consistent `[y/N]`
  gate), and resolves the **`--dry-run` "doesn't render its manifest"** finding
  (`renderDryRunPlan` now prints a real per-section plan).

Everything numbered below is **still present at v1.59.0**.

---

## A. Correctness bugs

### A1. `mandrel update` ends with three quiet failures

All in [`lib/cli/update.js`](../lib/cli/update.js):

- **A1a — changelog surfacing can never work in a consumer.**
  `defaultSurfaceChangelog` ([update.js:436](../lib/cli/update.js)) reads
  `<packageRoot>/docs/CHANGELOG.md` (`resolveProjectRoot()` is the package
  root), but `docs/` is **not** in the npm `files` allowlist
  (`[".agents/", "bin/", "lib/"]` in [package.json](../package.json)). In an
  installed consumer the file does not exist, the `readFileSync` catch fires,
  and every real update logs "changelog not found … skipping".
- **A1b — the explicit update resolves through the 24h cache.**
  `defaultResolveTargetVersion` ([update.js:209](../lib/cli/update.js))
  delegates to `isStale`, which returns the cached `latestVersion` with **zero**
  network I/O whenever `checkedAt` is < 24h old. `runUpdate` short-circuits to
  "✅ Already up to date" off that stale answer without ever probing the
  registry.
- **A1c — it never runs `sync-commands` yet gates on `commands-in-sync`.**
  `STEP_PLAN` ([update.js:528](../lib/cli/update.js)) is
  `npm-update → runSync → runMigrations → doctor`; `runSync` copies `.agents/`
  payload only and never regenerates `.claude/commands/`. The doctor gate
  includes the **non-advisory** `commands-in-sync` check
  ([registry.js:805](../lib/cli/registry.js)), so an upstream-renamed workflow
  fails the update exit code even though the upgrade itself succeeded.
  (`mandrel init`'s bootstrap path runs the command sync, but only on the
  "configure" branch and only out-of-band.)

### A2. Package-root-vs-consumer-root anchoring

- The `runtime-deps` doctor check
  ([registry.js:344,371](../lib/cli/registry.js)) resolves from
  `resolveProjectRoot()` — inside `node_modules/mandrel` — so it always finds
  the co-located deps and can never fail where it matters, masking the pnpm
  isolated-layout breakage of the "scripts free-ride on consumer
  `node_modules`" contract.
- The version cache writes to `node_modules/mandrel/temp/version-check.json`
  ([update.js:210](../lib/cli/update.js),
  [registry.js:693](../lib/cli/registry.js)) — wiped by every reinstall.
- Contrast: `commands-in-sync` / `agents-materialized` / `agents-drift` are all
  anchored at `process.cwd()` (the consumer). These two were not.

### A3. `mandrel sync` never prunes and `agents-drift` only checks payload files

`runSync` ([sync.js:167–186](../lib/cli/sync.js)) enumerates source files only
with no deletion pass, and `runAgentsDrift`
([registry.js:591](../lib/cli/registry.js)) iterates only payload files and
never visits a consumer file that lacks a payload counterpart — so an
upstream-deleted file lingers (and keeps projecting its slash command) forever,
doctor all-green, contradicting both sync's "byte-identical" claim and the
hard-cutover doctrine.

### A4. Merge-methods gate silently disables auto-merge on a default repo

The polarity *trap* is resolved (no more inverted `[Y/n]`/`[y/N]` sequence), but
the underlying behavior remains: `TARGET_MERGE_METHODS`
([merge-methods.js:26–32](../.agents/scripts/lib/bootstrap/merge-methods.js))
targets squash-only + auto-merge + delete-on-merge, which differs from GitHub
repo defaults, so a default repo always shows drift. On decline / non-TTY the
gate returns `status: 'skipped', reason: 'hitl-declined'` and writes nothing
([merge-methods.js:93–98](../.agents/scripts/lib/bootstrap/merge-methods.js)),
leaving the auto-merge half of the `/deliver` pipeline disabled — which
surfaces weeks later as warn-only failures. Only `--assume-yes` pre-approves the
gate; an interactive operator who declines (or runs non-TTY) gets it silently
skipped.

## B. Unnecessary complexity and dead code

### B1. The preview/manifest layer is now partly vestigial

The Story #3690 rewrite removed the phased-approval consent screen, so the
project-side phase-group gate is now an **intentional** pass-through
([bootstrap.js:1123–1138](../.agents/scripts/bootstrap.js)), not a vestigial
one. Still dead/incomplete: `previewMutationManifest`
([manifest.js:264](../.agents/scripts/lib/bootstrap/manifest.js)) has no
production caller (only `applyProjectBootstrap({preview:true})`, never invoked
in production); and the manifest omits git init and repo creation, so the
uninstall ledger never records the most irreversible mutations. The manifest now
feeds only the uninstall ledger — either wire git-init/repo-create into it or
collapse it.

### B2. Confirmed dead code (all re-verified present)

- `--install-workflows` — parsed at
  [agents-bootstrap-github.js:572](../.agents/scripts/agents-bootstrap-github.js)
  and threaded into `runBootstrap` opts, but never read.
- `ensureCiWorkflow` ([agents-bootstrap-github.js:351](../.agents/scripts/agents-bootstrap-github.js))
  — zero production callers; the advertised branch-protection/CI story is
  unreachable on a default install.
- `ensureMainBranchProtection` ([agents-bootstrap-github.js:288](../.agents/scripts/agents-bootstrap-github.js))
  — kept only so the Epic #1142 contract tests stay green; `applyBranchProtection`
  is its real successor.
- `mandrel sync --force` — accepted but a documented no-op
  ([sync.js:20,140](../lib/cli/sync.js)).
- `__filenameForTests` ([uninstall.js:795](../lib/cli/uninstall.js)) —
  exported, zero importers.
- Stale `/agents-bootstrap-project` remediation hints — the slash command no
  longer exists, but the string is still emitted from **production** code in
  [gh-preflight.js:48,277](../.agents/scripts/lib/bootstrap/gh-preflight.js),
  [sync-agentrc.js:72](../.agents/scripts/lib/config/sync-agentrc.js),
  [errors/index.js:56](../.agents/scripts/lib/errors/index.js),
  [project-bootstrap.js:3](../.agents/scripts/lib/bootstrap/project-bootstrap.js)
  (header), and
  [agents-bootstrap-github.js:542](../.agents/scripts/agents-bootstrap-github.js)
  (comment), plus workflow docs.

> The prior "unreachable `--skip-github` notice" item is resolved — that code
> path was deleted in the rewrite; the notice at the old line range is now a
> reachable `provisionResources` skip notice.

### B3. Multiplied helpers

- **Five** independent lockfile-probe implementations:
  [update.js:295](../lib/cli/update.js),
  [project-bootstrap.js:161](../.agents/scripts/lib/bootstrap/project-bootstrap.js),
  [preflight.js:49](../.agents/scripts/lib/runtime-deps/preflight.js),
  [detect-stack.js:172](../.agents/scripts/lib/onboard/detect-stack.js),
  [node-modules-strategy.js:113](../.agents/scripts/lib/worktree/node-modules-strategy.js).
- **Four** `parseVersion`/`compareVersions` copies
  ([migrations/index.js:75](../lib/migrations/index.js),
  [migrate.js:87](../lib/cli/migrate.js),
  [update.js:118](../lib/cli/update.js),
  [capability.js:135](../.agents/scripts/lib/dynamic-workflow/capability.js))
  plus a fifth comparator (`parseVersionTuple`/`compareVersionTuples`) in
  [registry.js:641](../lib/cli/registry.js).
- [registry.js:474–514](../lib/cli/registry.js) still maintains
  "Mirrors `lib/cli/sync.js`" verbatim copies (`PACKAGE_NAME`, `LOCAL_ZONE_DIR`,
  `defaultResolvePackageRoot`, `listPayloadFiles`) instead of importing.
- [update.js](../lib/cli/update.js) carries two stacked DI layers and a
  `STEP_PLAN` whose dry-run printout hand-appends a fifth "surface changelog"
  step outside the constant ([update.js:671](../lib/cli/update.js)).

### B4. TypeScript is declared three incompatible ways

In [package.json](../package.json): a hard runtime dep
(`dependencies.typescript: ">=5.0.0"`, unbounded), a non-optional peer
(`peerDependenciesMeta.typescript.optional: false`), and a gracefully-degrading
optional `require('typescript')` in the one real consumer
([transpile.js:14–20](../.agents/scripts/lib/transpile.js), advisory at
[:66](../.agents/scripts/lib/transpile.js)). Every pure-JS consumer downloads
the TS compiler. Make it a truly optional peer.

### B5. `engines: ">=22.22.1 <25"` — unexplained patch floor, triplicated

A patch-specific floor with no recorded rationale, duplicated across
[package.json:73](../package.json), `REQUIRED_NODE_FLOOR` in
[project-bootstrap.js:116](../.agents/scripts/lib/bootstrap/project-bootstrap.js),
and its mirror in [registry.js:60](../lib/cli/registry.js) — while CI pins a
loose major-only `node-version: 22` (so CI never exercises the `.22.1` patch
requirement). Still a hard install error under pnpm/yarn for consumers on an
earlier 22.x.

### B6. CLI dispatcher surface gaps

In [bin/mandrel.js](../bin/mandrel.js) and `lib/cli/`:

- Bare `mandrel` prints only `Usage: mandrel <subcommand> [args]` with no
  subcommand list.
- `--help` / `--version` are treated as unknown subcommands (resolve to a
  missing `lib/cli/--help.js`, exit 1).
- `registry.js` (array default export) and `version-check.js` (no default
  export) are exposed via the convention-dispatched directory and exit 1 with
  "does not export a default function" — bogus subcommands.
- `uninstall`, `explain`, and `sync-commands` remain undocumented
  consumer-facing; `uninstall` is the only mutating command without `--dry-run`.
- No subcommand rejects unknown flags — commands membership-test specific flags
  (`argv.includes('--dry-run')`) and let everything else fall through, so
  `mandrel update --dryrun` (typo) performs a live install.

## C. Packaging & CI gaps

### C1. Tarball ships tests and dangles `main`

`npm pack --dry-run` ships **7** `__tests__` files in `lib/`
(`lib/cli/__tests__/*`, `lib/migrations/__tests__/*`), and `"main": "index.js"`
points at a file that does not exist at the package root.

### C2. The Install Matrix never exercises the real install paths

In [install-matrix.yml](../.github/workflows/install-matrix.yml): every leg
installs `--ignore-scripts` (lines 218–226), so postinstall materialization is
never tested; the `mandrel init` cold-start path is never run; and no leg
executes a single materialized `.agents/scripts/*.js` from the consumer root —
which would immediately expose the pnpm free-ride breakage that A2 is masking.

### C3. `knip` never scans `bin/` or `lib/`

[knip.json](../knip.json) covers `.agents/scripts/**`, `scripts/**`, `tests/**`,
and configs, but neither `bin/` nor `lib/` — so the entire npm-distribution
entry surface (`bin/mandrel.js`, `lib/cli/*`, `lib/migrations/*`) is invisible to
the dead-code gate. (It also runs `files: off`, so even scanned dirs report only
unused exports, not unused files.)

### C4. Doc nits

- [AGENTS.md:28](../AGENTS.md) says **"License: ISC"**, but
  [package.json](../package.json) `license` is **MIT** and the
  [LICENSE](../LICENSE) file is the MIT License. Fix the AGENTS.md line.
- The three-`.agentrc`-files table is maintained in two places —
  [configuration.md:727](../.agents/docs/configuration.md) and
  [.agents/README.md:793](../.agents/README.md) — content has converged but dual
  maintenance persists.
- Residual relic: [tests/check-version-sync.test.js](../tests/check-version-sync.test.js)
  still uses `create-mandrel` as a fixture sibling key (lines 21, 50, 80); it is
  harmless (the relevant case asserts sibling entries are ignored) but is dead
  vocabulary now that the launcher is gone.

---

## Go-forward recommendations

Numbered to match the findings above. Tiers: **P1** correctness (ship first),
**P2** complexity & consistency, **P3** packaging & CI.

1. **P1 (A1)** — Fix the `mandrel update` tail: add `docs/CHANGELOG.md` to the
   npm `files` allowlist (or drop the changelog-surfacing promise); bypass the
   24h cache on an explicit `update`; and insert a `sync-commands` step into
   `STEP_PLAN` before the doctor gate (or mark `commands-in-sync` advisory).
2. **P1 (A2/A3)** — Anchor the `runtime-deps` check and the version cache at
   `process.cwd()`; add a prune-or-flag-extras pass to `sync` / `agents-drift`.
3. **P1 (A4)** — Defuse the merge-methods skip: fold the merge-method change
   into the up-front consent question, or default-approve it under non-TTY with
   an explicit log line, so auto-merge is not silently left disabled.
4. **P2 (B1/B2/B3)** — Collapse or fully wire the manifest layer; delete the
   confirmed dead code, including all stale `/agents-bootstrap-project` hints;
   unify the lockfile / version-parse helpers and replace the registry↔sync
   verbatim mirrors with imports.
5. **P2 (B4/B5)** — Make TypeScript a truly optional peer; record or lower the
   `engines` floor and single-home it.
6. **P2 (B6)** — Round out the dispatcher: subcommand list, `--help` /
   `--version`, unknown-flag rejection, `uninstall --dry-run`; document
   `uninstall` / `explain` / `sync-commands`.
7. **P3 (C1)** — Exclude `lib/**/__tests__` from the tarball and fix or remove
   the dangling `main`.
8. **P3 (C2)** — Add one scripts-enabled npm leg asserting postinstall
   materialization, a `mandrel init` cold-start leg, and one materialized-script
   run from the consumer dir.
9. **P3 (C3)** — Extend `knip` to `bin/` and `lib/`.
10. **P3 (C4)** — Fix the AGENTS.md license line, single-home the agentrc table,
    and drop the `create-mandrel` fixture relic from the version-sync test.
