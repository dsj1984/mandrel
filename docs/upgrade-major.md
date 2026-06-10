# Dependency & upgrade management

This is the single reference for managing the `mandrel` framework
dependency over its lifecycle: the **major-version upgrade runbook**, the
**Renovate / Dependabot** consumer-bot configs that automate routine bumps,
and the **compatibility matrix** of supported OS / Node / package-manager
combinations.

- [Upgrading across a major version](#upgrading-across-a-major-version) —
  the breaking-change runbook the `mandrel update` major gate points you at.
- [Renovate / Dependabot integration](#renovate--dependabot-integration) —
  drop-in bot configs that auto-merge minor/patch and hold majors.
- [Compatibility matrix](#compatibility-matrix) — the supported install
  surface (OS × Node × package manager).

---

## Upgrading across a major version

This is the runbook the `mandrel update` **major gate** points you at. When the newest published `mandrel` crosses a major boundary (for example `1.x → 2.0`), `mandrel update` **refuses to apply it automatically** — it prints the available version, a pointer to this section, and exits non-zero without mutating anything. You cross the boundary deliberately, with this runbook in hand, by re-running with `--major`.

> **Why a major is gated.** Mandrel lives on the **1.x** line and is released by `release-please` with `versioning: always-bump-minor` — routine work only ever advances the **minor** axis, even when a commit carries a `BREAKING CHANGE:` footer. A **major release is a deliberate, manual operator decision** on the framework side ([AGENTS.md § Major-version policy](../AGENTS.md)): an operator sets the version explicitly via a `Release-As: X.0.0` trailer or an in-place version edit on the release PR. The consumer-side major gate is the mirror image of that manual step: just as a major release cannot be cut by reflex, a major upgrade cannot be **adopted** by reflex. Minor and patch bumps within the 1.x line are never gated — only the rare major crossing is.

---

### What "breaking" means here, in npm terms

Mandrel follows a **hard-cutover contract** ([`.agents/rules/git-conventions.md` § Contract Cutovers](../.agents/rules/git-conventions.md)): there is **no shim layer** and **no parallel old-shape support**. When a contract changes — a config shape, a baseline shape, a JSON schema, a lifecycle payload, a ticket label, a dispatch artifact, or the public API of a script — the change ships as a single in-tree migration that moves every producer and consumer in one pass. The old shape is deleted in the same release; it is not kept alive behind a flag for a deprecation window.

In npm terms this means:

- **The package version *is* the contract version.** Your lockfile pins an exact `mandrel` version, so you are always reading exactly one shape of every artifact — the one that ships in the version you installed. There is no "compatibility mode" to fall back to.
- **A major bump signals a hard cutover.** A `1.x → 2.0` crossing is the framework telling you that at least one contract shape changed with no backward-compatible reader. You adopt the new shape by upgrading the package; the **PR diff for the version bump is the migration boundary**.
- **Migrations run forward only.** `mandrel update` runs the version-keyed migration steps for the range you are crossing (each step is idempotent and prints what it changed and why). There is no down-migration: to revert, you pin the previous version in your lockfile and re-`sync`.

Because there is no shim, **read the target version's changelog before you cross**. The relevant `docs/CHANGELOG.md` sections ship inside the package payload and are surfaced by `mandrel update`; they map to Conventional-Commit types and call out the breaking entries.

---

### The `--major` upgrade procedure

Do this on a branch, in a clean working tree, so the whole upgrade is one reviewable PR.

#### 1. Confirm the gate fired and read the target

Running a plain update against a major surfaces the refusal:

```bash
npx mandrel update
# → declines: "a newer MAJOR version (2.0.0) is available; this is a breaking
#   upgrade. Review docs/upgrade-major.md, then re-run with --major." (exit 1)
```

Inspect the plan without writing anything:

```bash
npx mandrel update --major --dry-run
```

`--dry-run` reports the target version, which migration steps would run, and the major-gate decision — and writes nothing. Read the surfaced changelog for the breaking entries before continuing.

#### 2. Apply the major upgrade

```bash
npx mandrel update --major
```

With `--major`, `mandrel update` runs the full cycle and prints the breaking-change notes inline:

1. **npm install.** It installs `mandrel@<2.0.0>` via npm. The lockfile change is **left staged, never committed** — `mandrel update` performs no `git` mutation, matching the "operator commits the lockfile" contract.
2. **Re-materialize.** It runs `mandrel sync` so `./.agents/` reflects the new package payload (a plain file copy; your `.agents/local/` zone is never touched).
3. **Migrate.** It runs every version-keyed migration step in the `installed → target` range, in ascending version order. Each applied step prints an actionable `migrated: <file> — <what changed / why>` line. Migrations are idempotent, so a re-run is a safe no-op.
4. **Verify with doctor.** It runs `mandrel doctor` and reports success **only when every check passes**. A failing doctor makes `update` exit non-zero so you treat the upgrade as incomplete rather than done.
5. **Surface the changelog.** It prints the `docs/CHANGELOG.md` sections spanning the applied version range so the breaking entries are in front of you.

#### 3. Resolve anything the migrations could not

A hard cutover sometimes changes a shape that a migration step cannot infer automatically (for example, a renamed config key whose new value depends on a project decision). When that happens:

- The migration step's message names the file and the decision you need to make.
- `mandrel doctor` fails with a specific, file-named remedy (drift, schema mismatch, or a missing required key).

Make the edit the message asks for, then re-run `npx mandrel doctor` until it reports `✅  Ready (N/N checks passed)`. Re-running `mandrel update --major` is also safe — the npm install and migrations are idempotent.

#### 4. Commit the upgrade

Once doctor is green, stage and commit the lockfile bump, the re-materialized `./.agents/` tree, and any config edits the migrations required — as **one** reviewable commit:

```bash
git add -A
git commit -m "build: upgrade mandrel to 2.0.0"
```

Open a PR so the breaking diff is reviewed before it lands on your default branch.

---

### If a dependency bot opened the major PR

Renovate and Dependabot are configured to **hold** the `1.x → 2.0` major for manual review and never auto-merge it (see [Renovate / Dependabot integration](#renovate--dependabot-integration)). Do **not** merge a bot's major PR by clicking merge — that adopts the breaking shape without running migrations. Instead:

1. Close or ignore the bot's major PR (or leave it open as a reminder).
2. Follow the `--major` procedure above on your own branch, which runs the migrations and the doctor gate.
3. Merge **your** PR — the one with the migrated config and the green doctor — not the bot's bare version bump.

---

### Reverting

There is no down-migration. To roll back a major you adopted:

```bash
npm install mandrel@<previous-1.x-version>
npx mandrel sync
npx mandrel doctor
```

Then revert any config edits the forward migrations made (your version-control history of the upgrade PR is the record of what changed). Because the previous version's payload is a different contract shape, pin it explicitly in your lockfile and re-`sync` so `./.agents/` matches the version you rolled back to.

---

### Related documents

| Document | Purpose |
| --- | --- |
| [Renovate / Dependabot integration](#renovate--dependabot-integration) | Dependency-bot config that gates Mandrel bumps on `mandrel doctor` and holds majors for manual review |
| [Compatibility matrix](#compatibility-matrix) | Supported OS / Node / package-manager combinations |
| [AGENTS.md § Major-version policy](../AGENTS.md) | The framework-side manual major-release step this gate mirrors |
| [`.agents/rules/git-conventions.md` § Contract Cutovers](../.agents/rules/git-conventions.md) | The hard-cutover / no-shim policy a major expresses |

---

## Renovate / Dependabot integration

Mandrel ships as the npm package [`mandrel`](https://www.npmjs.com/package/mandrel), and the `.agents/` working tree is materialized from the installed package by `mandrel sync`. Because the framework is a regular versioned dependency pinned in your lockfile, framework upgrades can ride the **same dependency-update PRs** you already use for every other package — Renovate or Dependabot opens the bump, `mandrel doctor` gates it in CI, and you review and merge it like any other dependency PR.

This guide gives you a drop-in config for **both** bots. Pick whichever your project already runs — you do not need both. Each config:

- **Scopes to `mandrel`** so the rules here only govern the framework dependency (your other packages keep their existing update policy).
- **Runs `mandrel doctor` as the CI gate** so a bump only goes green when `.agents/` re-materializes cleanly, the consumer manifest is unpolluted, the slash commands are in sync, and `gh` is authenticated.
- **Respects the versioning model.** Mandrel lives on the **1.x** line and is released by `release-please` with `versioning: always-bump-minor`, so routine releases only advance the **minor** axis. A **major (1.x → 2.0) is a deliberate, manual operator decision** ([AGENTS.md § Major-version policy](../AGENTS.md)) and is the rare, runbook-backed event documented in [§ Upgrading across a major version](#upgrading-across-a-major-version) above. The bot configs below therefore let minor/patch bumps flow automatically but **always hold a major for manual review**.

> **These are example consumer configs.** They belong in the project that *depends on* `mandrel`, not in this repository. (This repository is the framework itself; its own root `renovate.json` governs Mandrel's own dependencies and is unrelated to the consumer examples here.) Copy the block for your bot into your consumer project root. The two configs below are also shipped verbatim as parseable example files at [`examples/renovate.json`](examples/renovate.json) and [`examples/dependabot.yml`](examples/dependabot.yml) so you can copy them straight from disk.

### The upgrade contract a bot PR follows

Whichever bot you use, the lifecycle of a Mandrel bump PR is the same:

1. The bot detects a newer `mandrel` on npm and opens a PR that bumps the version in `package.json` and the lockfile.
2. CI checks out the PR branch, installs dependencies, and runs `npx mandrel sync` followed by `npx mandrel doctor`.
3. `mandrel sync` re-materializes `./.agents/` from the new package payload; `mandrel doctor` verifies the result and **exits non-zero** if anything is wrong (drift, unmaterialized tree, stale slash commands).
4. A green `doctor` means the upgrade is clean — merge the PR. A red `doctor` means the upgrade needs attention before it lands.

> **The bot never commits your `.agents/` re-materialization.** It only bumps `package.json` + the lockfile. Running `mandrel sync` in CI is a **verification** step (it proves the new payload materializes cleanly); you re-materialize `./.agents/` locally with `mandrel sync` after you merge, or rely on the `postinstall` hook on your next install. Keep the CI checkout's working tree changes out of the merge — the PR's committed diff is the version bump alone.

A **major** bump (1.x → 2.0) is held for manual review by both configs below. When you are ready to adopt it, follow the [`--major` upgrade procedure](#the---major-upgrade-procedure) and run `mandrel update --major` locally rather than merging the bot PR blind.

### Renovate

Add a `renovate.json` (or a `renovate` key in `package.json`) to your consumer project root. This config isolates `mandrel` into its own package rule, auto-merges minor/patch once CI is green, and pins a major for manual review.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "description": "Mandrel framework: auto-merge minor/patch on the 1.x line once doctor passes in CI",
      "matchPackageNames": ["mandrel"],
      "matchUpdateTypes": ["minor", "patch"],
      "groupName": "mandrel",
      "automerge": true,
      "automergeType": "pr",
      "platformAutomerge": true
    },
    {
      "description": "Mandrel framework: hold the deliberate 1.x -> 2.0 major for manual review (see docs/upgrade-major.md)",
      "matchPackageNames": ["mandrel"],
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "labels": ["mandrel", "major-update"]
    }
  ]
}
```

The `mandrel doctor` gate is enforced by your CI workflow (Renovate respects your branch-protection required checks before `platformAutomerge` merges). Wire it once:

```yaml
# .github/workflows/mandrel-doctor.yml
name: mandrel-doctor
on:
  pull_request:
    paths:
      - "package.json"
      - "package-lock.json"
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx mandrel sync
      - run: npx mandrel doctor
```

With this in place a minor/patch Mandrel bump opens, runs `mandrel doctor`, and — if green — auto-merges; a major bump opens, runs `mandrel doctor`, and waits for you.

### Dependabot

Add a `.github/dependabot.yml` to your consumer project root. Dependabot has no per-package auto-merge knob in the config file, so the policy split (auto-merge minor/patch, hold majors) is expressed with `ignore` + a companion auto-merge workflow. The config below limits Dependabot to `mandrel` updates for the framework lifecycle (keep your existing entries for the rest of your dependencies):

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    allow:
      - dependency-name: "mandrel"
    labels:
      - "mandrel"
      - "dependencies"
    commit-message:
      prefix: "chore"
      include: "scope"
    # Hold the deliberate 1.x -> 2.0 major for manual review (see docs/upgrade-major.md).
    ignore:
      - dependency-name: "mandrel"
        update-types: ["version-update:semver-major"]
```

`ignore` with `version-update:semver-major` means Dependabot **never opens a PR for the major** — you adopt 1.x → 2.0 deliberately by running `mandrel update --major` locally per the [`--major` upgrade procedure](#the---major-upgrade-procedure). Minor and patch bumps open as normal PRs.

Gate every Mandrel bump on `mandrel doctor` with the same workflow shown in the Renovate section. To auto-merge the green minor/patch PRs, add an auto-merge workflow that fires once required checks pass:

```yaml
# .github/workflows/mandrel-automerge.yml
name: mandrel-automerge
on: pull_request
permissions:
  contents: write
  pull-requests: write
jobs:
  automerge:
    if: ${{ github.actor == 'dependabot[bot]' }}
    runs-on: ubuntu-latest
    steps:
      - uses: dependabot/fetch-metadata@v2
        id: meta
      - name: Enable auto-merge for Mandrel minor/patch
        if: >-
          steps.meta.outputs.dependency-names == 'mandrel' &&
          (steps.meta.outputs.update-type == 'version-update:semver-minor' ||
           steps.meta.outputs.update-type == 'version-update:semver-patch')
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The `mandrel doctor` workflow is the required check; `--auto` holds the merge until it goes green, so a failing doctor blocks the merge exactly as it does under Renovate.

### Verifying the config

Both example configs are plain JSON / YAML and parse without error. After dropping one into your consumer project:

- **Renovate:** run `npx --yes renovate-config-validator renovate.json` (or let the Renovate app validate on its first run and post to the Dependency Dashboard).
- **Dependabot:** push the file; GitHub validates `.github/dependabot.yml` on commit and surfaces parse errors in the repository's **Insights → Dependency graph → Dependabot** tab.
- **The gate:** open a throwaway PR that bumps `mandrel` and confirm the `mandrel-doctor` job runs and reports `✅  Ready (N/N checks passed)`.

For the supported OS / Node / package-manager combinations the doctor gate runs against, see the [Compatibility matrix](#compatibility-matrix) below.

---

## Compatibility matrix

This section is the source of truth for the **supported install surface** of the
[`mandrel`](https://www.npmjs.com/package/mandrel) package: the
operating systems, Node.js versions, and package managers that the framework is
tested and supported against.

A combination is **supported** only when it is exercised by the
[`Install Matrix`](../.github/workflows/install-matrix.yml) CI workflow, which
packs this repo into a tarball, installs it into a throwaway consumer project
with each package manager on each OS, materializes `./.agents/` via
`mandrel sync`, and asserts the golden-path invariants
(`./.agents/` materialized, consumer manifest unpolluted, `mandrel doctor`
ready). Combinations outside the matrix may work but carry no support guarantee.

### Supported OS × package manager

The install matrix runs every package manager against every OS:

| OS | npm | pnpm | yarn (classic) |
| -- | --- | ---- | -------------- |
| Linux (`ubuntu-latest`) | ✅ Supported | ✅ Supported | ✅ Supported |
| Windows (`windows-latest`) | ✅ Supported | ✅ Supported | ✅ Supported |
| macOS | ⚠️ Expected to work, not CI-gated | ⚠️ Expected to work, not CI-gated | ⚠️ Expected to work, not CI-gated |

- **Linux and Windows** are first-class: each `{npm, pnpm, yarn} × {linux,
  windows}` leg runs on every pull request that touches the install surface
  and on every push to `main`.
- **macOS** is not part of the CI matrix. The package payload is plain,
  cross-platform JavaScript and a copy-only `mandrel sync` (no symlinks, no
  native build steps), so macOS is expected to work, but it is not gated and
  regressions there are not caught automatically.

`yarn` refers to **classic yarn** (the Corepack default for the `yarn` shim).
Yarn Berry (PnP) is not exercised by the matrix; if you use Berry, install in
`node-modules` linker mode so `mandrel sync` can resolve the package root from
`node_modules/mandrel`.

### Supported Node.js versions

| Node.js | Status | Notes |
| ------- | ------ | ----- |
| 22.x (`>= 22.22.1`) | ✅ Supported | CI install matrix and the full test suite run on Node 22. |
| 23.x | ✅ Supported | Within the `engines` range; not separately CI-gated. |
| 24.x (`< 25`) | ✅ Supported | Within the `engines` range; not separately CI-gated. |
| < 22.22.1 | ❌ Unsupported | Below the `engines` floor — `npm` warns and orchestration preflight refuses. |
| >= 25 | ❌ Unsupported | Above the `engines` ceiling. |

The supported range is declared in the package's
[`engines`](../package.json) field as `>=22.22.1 <25` and enforced by the
bootstrap/orchestration preflight (Node major-version gate). The CI install
matrix pins **Node 22** as the representative tested version; 23 and 24 fall
within the declared range but are not separately gated.

### Package-manager notes

- **npm** — the reference package manager. `npm install mandrel`
  runs the `postinstall` hook (best-effort `mandrel sync`) automatically
  unless `--ignore-scripts` is set.
- **pnpm** — supported. Enable it via Corepack (`corepack enable`) and use
  `pnpm add mandrel`. `mandrel sync` resolves the package root from
  pnpm's `node_modules` layout, so it works under pnpm's symlinked store.
- **yarn (classic)** — supported. Enable via Corepack and use
  `yarn add mandrel`.

In all three cases, if the lifecycle scripts are skipped (`--ignore-scripts`
or the equivalent), run `npx mandrel sync` afterward to materialize
`./.agents/`, then `npx mandrel doctor` to confirm the install is healthy.

### What "supported" guarantees

For every ✅ combination, the install matrix proves, on every relevant CI run,
that:

1. `./.agents/` is materialized after install + `mandrel sync`.
2. The consumer's `package.json` is **not** mutated with framework runtime
   dependencies.
3. `mandrel doctor` returns a **ready** verdict.

If you hit a failure on a supported combination, it is a framework bug — open
an issue at <https://github.com/dsj1984/mandrel/issues> with your OS, Node
version, and package manager.
