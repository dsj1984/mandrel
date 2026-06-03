# Migrating from the Git submodule to the npm package

Mandrel used to ship as a **Git submodule** pinned to the `dist` branch:
consumers ran `git submodule add -b dist … .agents` and pulled framework
updates by advancing the submodule pointer. That distribution channel is
**retired**. The framework now ships as a versioned, provenance-signed npm
package, [`@mandrel/agents`](https://www.npmjs.com/package/@mandrel/agents),
and the `.agents/` working tree is **materialized from the installed package**
by `mandrel sync` (a plain file copy — never a symlink).

This guide is a **one-time migration** for an existing consumer that still has
`.agents/` wired in as a submodule. New projects should follow the cold-start
flow in [`.agents/README.md` § Activation](../.agents/README.md#activation)
instead — they never touch a submodule at all.

> **Why the change?** The `dist` branch had no version identity, no integrity
> attestation, and forced every consumer onto Git submodule ergonomics
> (`git submodule update --remote`, detached-HEAD foot-guns, no lockfile).
> The npm package pins an exact version in your lockfile, ships a Sigstore
> build-provenance statement proving the tarball was built from this repo's
> CI, and upgrades through the package manager you already use. See
> [`compatibility-matrix.md`](compatibility-matrix.md) for the supported
> OS / Node / package-manager combinations.

---

## Automated migration (give this to your agent)

If you run a coding agent in your consumer project, paste the **single,
self-contained prompt** below and let it perform the whole migration. It
embeds every step, so the agent does not need this file. The only mutations
are the submodule removal, the `@mandrel/agents` install, and the materialized
`./.agents/` tree — all reviewable in a PR — and the agent stops if
`mandrel doctor` is not green.

```text
You are migrating this project from the retired Mandrel **Git submodule**
(`.agents/` pinned to the `dist` branch) to the **`@mandrel/agents` npm
package**. Work on a NEW branch and open a PR — do not push to the default
branch, and do not bypass git hooks. If any step fails, or `mandrel doctor` is
not green at the end, STOP and report it — do not paper over it.

1. Preflight. Confirm `.agents/` is currently a submodule: check that
   `.gitmodules` contains a `[submodule ".agents"]` block (or that
   `git submodule status` lists `.agents`). If it is NOT a submodule, STOP and
   report that the project is already on the npm package — nothing to migrate.

2. Preserve local edits. Run `git -C .agents status --porcelain`. If it shows
   ANY changes, STOP and report them: hand edits inside `.agents/` are
   overwritten by `mandrel sync` and must first be moved into the project
   layer (root `.agentrc.json`, or the `.agents/local/` zone). Never discard
   them silently.

3. Deinitialize the submodule: `git submodule deinit -f .agents`.

4. Remove the gitlink and internal git data: run `git rm -f .agents`, then
   delete the submodule's internal git dir — `rm -rf .git/modules/.agents` on
   macOS/Linux, or `Remove-Item -Recurse -Force .git/modules/.agents` on
   Windows PowerShell.

5. Remove the `.gitmodules` entry. If `.agents` was the only submodule, the
   file is now empty — `git rm -f .gitmodules`. Otherwise edit `.gitmodules`,
   delete only the `[submodule ".agents"]` block, and `git add .gitmodules`.
   Also drop any leftover section from `.git/config`:
   `git config --remove-section submodule..agents` (ignore a "no such section"
   error).

6. Install the package, pinning an exact version in the lockfile:
   `npm install @mandrel/agents` (or `pnpm add @mandrel/agents` /
   `yarn add @mandrel/agents`). The package `postinstall` runs `mandrel sync`
   best-effort; if your install used `--ignore-scripts`, the next step runs it
   explicitly.

7. Materialize `./.agents/` and check health: `npx mandrel sync` (an
   idempotent plain-file copy), then `npx mandrel doctor`. Expect
   `✅  Ready (N/N checks passed)`. If doctor is not green, STOP and report
   which check failed.

8. Prune the stale `dist` remote-tracking ref left over from the submodule's
   `-b dist` checkout: `git remote prune origin`. This only cleans your local
   clone; it does not touch the upstream branch.

9. If `.claude/settings.json` has a `UserPromptSubmit` hook whose command is
   `node .agents/scripts/sync-claude-commands.js`, repoint it at the CLI:
   `npx mandrel sync-commands`. Leave every other hook untouched.

10. Commit everything on the branch: `git add -A`, then
    `git commit -m "build: migrate Mandrel from git submodule to @mandrel/agents npm package"`.

11. Verify, then open the PR and report results: `git submodule status` shows
    no `.agents` entry; `npm ls @mandrel/agents` resolves the pinned version;
    `git ls-files -s .agents | head -1` shows mode `100644` (a regular file),
    NOT `160000` (a gitlink); and `npx mandrel doctor` is green.
```

The manual, step-by-step version of the same migration follows below.

---

## Before you start

- Commit or stash any **local edits inside `.agents/`**. The submodule may
  contain changes you made on top of the pinned `dist` commit; `mandrel sync`
  overwrites `./.agents/` in place from the package payload, so anything you
  customized there must be migrated into your own project layer (root
  `.agentrc.json`, project skills, etc.) first.
- Note the framework version you are currently pinned to (read
  `.agents/VERSION`) so you can pick a target package version deliberately.
- Make sure your `gh` CLI is still authenticated — orchestration scripts and
  `mandrel doctor`'s `gh-auth` check read your token exactly as before.

The migration is **idempotent and reversible up to the submodule removal
commit**. Do it on a branch and open a PR so the diff is reviewable.

---

## Migration steps

### 1. Deinitialize the submodule

Tell Git to stop tracking `.agents/` as a submodule working tree. This empties
the working directory but leaves the `.gitmodules` entry and the gitlink in the
index — those come out in the next steps.

```bash
git submodule deinit -f .agents
```

### 2. Remove the submodule's gitlink and internal Git data

```bash
# Remove the gitlink (the special 160000-mode entry) from the index and tree.
git rm -f .agents

# Remove the submodule's internal Git directory so Git forgets it entirely.
rm -rf .git/modules/.agents
```

On Windows PowerShell, use `Remove-Item -Recurse -Force .git/modules/.agents`
instead of `rm -rf`.

### 3. Remove the `.gitmodules` entry

If `.agents/` was your only submodule, the file is now empty (or holds only an
orphaned `[submodule ".agents"]` block). Either delete the whole file or remove
just the stanza:

```bash
# If .agents was the only submodule, the file is now empty — delete it:
git rm -f .gitmodules

# Otherwise, edit .gitmodules and delete the [submodule ".agents"] block,
# then stage it:
#   git add .gitmodules
```

Also remove the matching `[submodule ".agents"]` section from `.git/config` if
your Git version left it behind:

```bash
git config --remove-section submodule..agents 2>/dev/null || true
```

### 4. Install the npm package

Add `@mandrel/agents` as a regular dependency with your project's package
manager. This pins an exact version in your lockfile.

```bash
npm install @mandrel/agents
# pnpm add @mandrel/agents
# yarn add @mandrel/agents
```

The package ships a `postinstall` hook that runs `mandrel sync` on a
best-effort basis, so on a normal install `./.agents/` is materialized for you.
If you install with `--ignore-scripts` (or your CI does), the postinstall is
skipped and you run `mandrel sync` yourself in the next step.

> **Pin a specific version** by appending `@<version>` (for example
> `npm install @mandrel/agents@1.43.0`). Upgrades are then a normal
> `npm install @mandrel/agents@<newer>` followed by `mandrel sync` — no
> `git submodule update`.

### 5. Materialize `./.agents/` with `mandrel sync`

`mandrel sync` copies the package's `.agents/` payload
(`node_modules/@mandrel/agents/.agents/`) into your project's `./.agents/`
directory as **plain regular files**. It is idempotent — rerun it any time to
re-materialize after an upgrade.

```bash
npx mandrel sync
# or, if the postinstall already ran, this is a no-op overwrite-in-place.
```

Run `npx mandrel sync --dry-run` first if you want to see exactly which files
would be written without touching disk.

After syncing, run the doctor to confirm the install is healthy:

```bash
npx mandrel doctor
```

A green `✅  Ready (N/N checks passed)` confirms `./.agents/` is materialized,
your consumer manifest was not polluted with framework runtime deps, the
slash commands are in sync, and `gh` is authenticated.

### 6. Delete the remote `dist`-tracking branch reference

Your local clone may still carry a remote-tracking ref for the retired `dist`
branch (left over from the submodule's `-b dist` checkout). It no longer
points at anything you consume — prune it so it stops showing up in
`git branch -a`:

```bash
# Prune any stale remote-tracking refs (including the old dist mirror).
git remote prune origin

# Or remove just the dist-tracking ref explicitly:
git branch -r -d origin/dist 2>/dev/null || true
```

You do **not** delete the upstream `dist` branch on `github.com/dsj1984/mandrel`
— that is the framework maintainers' concern, and the branch is already
retired upstream. This step only cleans up your local clone's leftover
reference to it.

### 7. Commit the migration

Stage the submodule removal, the new dependency, and the materialized
`./.agents/` tree (now plain files), then commit:

```bash
git add -A
git commit -m "build: migrate Mandrel from git submodule to @mandrel/agents npm package"
```

---

## Verifying the migration

| Check | Command | Expected |
| ----- | ------- | -------- |
| Submodule is gone | `git submodule status` | No `.agents` entry |
| No `.gitmodules` stanza | `grep -c '\.agents' .gitmodules` (if the file still exists) | No `[submodule ".agents"]` block |
| Package is installed | `npm ls @mandrel/agents` | Resolves to the version you pinned |
| `.agents/` is plain files | `git ls-files -s .agents \| head -1` | Mode `100644` (a regular file), **not** `160000` (a gitlink) |
| Install is healthy | `npx mandrel doctor` | `✅  Ready (N/N checks passed)` |

If `mandrel doctor` reports `.agents/` is not materialized, run
`npx mandrel sync` — that is the documented remedy for the
`--ignore-scripts` / sandboxed-CI path where the postinstall hook was
skipped.

---

## Migrating lifecycle hooks to the `mandrel` CLI

Separately from the distribution change, Epic #3435 moved the lifecycle
scripts out of bare `.agents/scripts/` invocations and behind the `mandrel`
CLI bin. If your project's `.claude/settings.json` wires the
`UserPromptSubmit` hook directly to the old sync script, repoint it at the CLI
subcommand as part of the migration.

Old hook command:

```json
{
  "type": "command",
  "command": "node .agents/scripts/sync-claude-commands.js"
}
```

New hook command:

```json
{
  "type": "command",
  "command": "npx mandrel sync-commands"
}
```

In context, the `UserPromptSubmit` block becomes:

```json
"hooks": {
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "npx mandrel sync-commands"
        }
      ]
    }
  ]
}
```

The bare-script path keeps working on older installs, but the CLI bin is the
stable, versioned entry point — migrate the hook when you upgrade to this
version or later. (Inside this framework repo itself the equivalent invocation
is `node bin/mandrel.js sync-commands`, because the repo runs its own bin
directly; consumers use the installed package bin via `npx mandrel`.)

---

## Upgrading after the migration

Once you are on the package, upgrades no longer involve Git at all. The
ongoing upgrade path is the **`mandrel update`** orchestrator — a single
command that advances `@mandrel/agents` to the newest non-major published
version and drives the whole post-bump cycle for you:

```bash
npx mandrel update
```

On a routine (non-major) bump, `mandrel update` runs four ordered steps:

1. **`npm update`** — bumps the `@mandrel/agents` dependency to the newest
   non-major version. The lockfile change is **left staged on disk, never
   committed** — `mandrel update` performs no `git` mutation, so you review
   and commit the bump yourself.
2. **`mandrel sync`** — re-materializes `./.agents/` from the freshly
   installed package payload (a plain file copy, never a symlink).
3. **migrations** — runs every version-keyed migration step in the
   `installed → target` range, in ascending version order. Each step is
   idempotent and prints an actionable line naming what it changed.
4. **`mandrel doctor`** — verifies the result against the check registry.
   `mandrel update` reports success **only when every doctor check passes**;
   a failing check makes it exit non-zero so an incomplete upgrade is never
   reported as done.

It then surfaces the target version's `docs/CHANGELOG.md` sections so the
release notes are in front of you. Preview the whole plan without writing
anything:

```bash
npx mandrel update --dry-run   # prints the resolved target + ordered steps
```

Because the version is in your lockfile, upgrades stay explicit, reviewable
in a PR diff, and reproducible across machines and CI.

### Major upgrades are gated

Mandrel lives on the **1.x** line and is released by `release-please` with
`always-bump-minor`, so routine work only ever advances the **minor** axis —
a major release is a deliberate, manual operator decision on the framework
side. `mandrel update` mirrors that: when the newest published version
crosses a major boundary (for example `1.x → 2.0`), it **refuses to apply
the bump automatically**. It prints the available version, points you at
[`upgrade-major.md`](upgrade-major.md), and exits non-zero **without
touching anything** (no `npm update`, no sync, no migrations, no doctor).
You cross the boundary deliberately by re-running with `--major`, runbook in
hand. Minor and patch bumps within the 1.x line are never gated.

Mandrel follows the hard-cutover contract documented in
[`.agents/rules/git-conventions.md` § Contract Cutovers](../.agents/rules/git-conventions.md)
(no shim layer, no parallel old-shape support), so read the release notes for
the target version before upgrading across a contract change.

### Running a migration on its own

You rarely need this — `mandrel update` runs migrations as part of its cycle
— but the migration runner is also exposed as a standalone command for
re-applying a step a prior upgrade missed, or for inspecting what a version
crossing would do before committing to it:

```bash
npx mandrel migrate --from <version> --to <version>
npx mandrel migrate --from <version> --to <version> --dry-run
```

Both `--from` and `--to` are required (they bound the
`from < version <= to` range the runner filters on). `--dry-run` reports
which in-range steps would apply or be skipped and writes nothing.

### The `.agents/local/` local-additions zone

`mandrel sync` overwrites `./.agents/` in place from the package payload, so
anything you edit directly inside a synced framework file is clobbered on the
next upgrade. The sanctioned home for hand-authored additions you want to
**survive every re-materialization** is the **`.agents/local/`** zone:

- `mandrel sync` never copies a payload file into `.agents/local/` (the
  published package ships none) and never prunes what you place there, so
  your local additions persist across every `mandrel sync` / `mandrel update`.
- `mandrel doctor`'s drift check treats `.agents/local/` as consumer-owned:
  hand edits there are expected and do not register as drift, whereas a hand
  edit to a synced framework file outside the zone is flagged so you move it
  into `.agents/local/` (or your project layer) before it is silently
  overwritten.

Keep project-specific skills, local workflow fragments, and other durable
customizations under `.agents/local/` rather than editing synced framework
files in place.
