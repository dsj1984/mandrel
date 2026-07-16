# Release Operations Reference

> **Scope.** This document holds the release-plumbing reference prose for the
> Mandrel repo — the Release Checklist, the Install Matrix release gate,
> release topology, one-time PAT setup, npm Trusted Publisher (OIDC)
> configuration, and the major-version policy. It was relocated out of the
> always-`@`-imported [`AGENTS.md`](../AGENTS.md) (Story #4333) so the
> always-loaded session context stays lean; this material is consulted at
> release-plumbing time, not on every task. [`AGENTS.md`](../AGENTS.md)
> links here from its **Release Operations** section.

## Release Checklist

Releases are automated by
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action)
(see [`.github/workflows/release-please.yml`](../.github/workflows/release-please.yml)):

1. Land Conventional Commits on `main` (the rules in
   [`.agents/rules/git-conventions.md`](../.agents/rules/git-conventions.md)
   already enforce the commit-message contract).
2. release-please opens a release PR with auto-merge enabled (squash).
   Review the auto-generated entry in `docs/CHANGELOG.md` and the bump to
   `package.json` (the framework version SSOT) if you want; otherwise no
   operator action is needed. See [§ Release topology](#release-topology)
   below for the release-PR title/branch shape and the tag namespace.
3. CI fires on the release PR automatically (because release-please
   uses the operator-managed `RELEASE_PLEASE_TOKEN` PAT — see
   [§ One-time PAT setup](#one-time-pat-setup) below). Once
   `Validate and Test` passes, GitHub squash-merges the release PR,
   which triggers the workflow to create the GitHub Release, tag
   `main` with `mandrel-vX.Y.Z`, and run the `npm-publish` job, which
   publishes the root `mandrel` package to npm with build provenance
   (Sigstore), gated on the package's release output. This replaces the
   retired `dist`-branch mirror: consumers now install a versioned,
   provenance-signed package from npm (`npm install mandrel`, then
   `mandrel sync`) instead of pinning a Git submodule to the `dist`
   branch, and bootstrap a fresh project with `npx mandrel init`. The
   publish job authenticates via npm Trusted Publishing (OIDC) — see
   [§ npm Trusted Publisher (OIDC)](#npm-trusted-publisher-oidc) below.
4. **Breaking-change releases** document their migration steps in the
   **release PR body** release-please opens (which becomes the
   squash-commit body and the versioned
   [`docs/CHANGELOG.md`](CHANGELOG.md) entry on merge) so consumers
   find them on upgrade. Do **not** hand-maintain an `## Unreleased`
   section in `docs/CHANGELOG.md` — release-please is the sole writer of
   that file and generates version sections from Conventional Commit
   subjects; a bracket-less `## Unreleased` block is never promoted to a
   version and only strands the content.

### Install Matrix release gate (required checks on `main`)

The **Install Matrix** workflow
([`.github/workflows/install-matrix.yml`](../.github/workflows/install-matrix.yml))
proves the published-package consumer contract end to end (pack → install →
`mandrel sync` / `sync-commands` → assert materialization, a clean consumer
manifest, and a `mandrel doctor` ready verdict). It gates releases the same
way `lint` / `test` / `baselines` do — through **branch protection on the
release PR**, not through `release-please.yml`. To avoid the classic
required-check + path-filter deadlock, the workflow splits into two profiles:

- **Gate (required, always reports):** a 2-leg diagonal that runs on **every**
  `pull_request` to `main` and on `push` to `main`, with **no path filter** so
  the check always reports (including on the release PR, which only bumps
  `package.json`). The two gating job names — add **exactly these** to the
  branch-protection required-status-check set on `main`:
  - `install (npm / ubuntu-latest)`
  - `install (yarn / windows-latest)`

  Do **not** add the internal `select-matrix` setup job to branch protection —
  it is plumbing that emits the per-event matrix, not a gate.
- **Coverage (non-blocking):** all 6 legs
  (`{npm, pnpm, yarn} × {ubuntu-latest, windows-latest}`) run on a nightly
  `schedule` and on `workflow_dispatch` so pnpm and npm-on-Windows regressions
  are still caught (≤24h latency) without taxing every PR.

**Operator action (one-time, out-of-band).** Adding the two checks to branch
protection is a GitHub UI / `gh api` admin action; the workflow ships the
gate but cannot self-register as required. Add the two job names above to the
required-status-check set on `main` once.

### Release topology

`release-please-config.json` declares a **single** package — the root
`mandrel` package (`.`). This keeps release-please in **single-package
manifest mode**, which has two operator-visible consequences:

- **One release PR.** release-please opens a single PR that bumps the
  root package. The PR uses:
  - **Branch:** `release-please--branches--main`
  - **Title:** `chore: release main`

  There should be **exactly one** open release PR at a time. (The repo
  briefly ran a two-package topology when the `create-mandrel` launcher
  existed; that launcher was removed once `mandrel init` superseded it,
  reverting release-please to single-package mode. A package-set change
  can briefly orphan the prior release-PR branch shape — if you ever see
  two open `autorelease: pending` PRs, close the stale orphan and keep
  the live `release-please--branches--main` PR; it self-resolves on the
  next release run.)

- **Namespaced tags (`include-component-in-tag: true`).** The root
  `mandrel` package has `package-name: "mandrel"` with `component: ""`.
  Because `include-component-in-tag` is `true`, release-please prefixes
  the tag with the package name, so the root package's tags are
  **namespaced** as `mandrel-vX.Y.Z` (e.g. `mandrel-v1.44.0`). Releases
  through `v1.43.0` predate the namespaced topology and carry the older
  **bare `vX.Y.Z`** tags; the series became namespaced at
  `mandrel-v1.44.0`. The flag is kept on for tag continuity even though
  there is now only one package.

  [`release-please.yml`](../.github/workflows/release-please.yml) carries a
  single publish job gated on the package's release output. The output
  naming follows release-please-action's `setPathOutput` rule (verified
  against v5.0.0 `src/index.ts`): the root package (manifest path `.`)
  emits **un-prefixed** outputs (`release_created`, `tag_name`). There is
  **no** `.--release_created` output — gating the root publish on that
  string silently skips it on every release (the bug Story #3891's
  initial wiring shipped; fixed by reverting the root gate to the
  un-prefixed `release_created`). The `npm-publish` job checks out the
  repository root and runs `npm publish` against the root `package.json`,
  publishing **`mandrel`**, gated on
  `steps.release.outputs.release_created`. (The "any package released"
  boolean is the *plural* `releases_created`, which is intentionally
  **not** used as a gate here.) The job does not key off a tag pattern,
  so the `mandrel-*` tag series does not trigger a publish by tag.
  `ci.yml` triggers only on branch `push` / `pull_request` /
  `workflow_dispatch` events (it has **no** tag-driven step), so the tag
  series does not trigger CI directly.

### One-time PAT setup

GitHub's default `secrets.GITHUB_TOKEN` cannot trigger downstream
workflows on PRs it opens (an anti-recursion safeguard), so release
PRs opened under the default token never run the required
`Validate and Test` status check and stay stuck in `BLOCKED` forever.
Configure a Personal Access Token once to break the deadlock:

1. Create a fine-grained PAT at
   <https://github.com/settings/personal-access-tokens/new>:
   - **Resource owner:** `dsj1984`
   - **Repository access:** Only this repository (`mandrel`)
   - **Repository permissions:**
     - `Contents` → **Read and write**
     - `Pull requests` → **Read and write**
     - `Workflows` → **Read and write** (release-please-action requires
       this to update workflow files when needed)
     - `Issues` → **Read and write** (auto-close `Closes #` references)
   - **Expiration:** As long as you want — re-rotate at expiry.
2. Add the token as a repository secret named **`RELEASE_PLEASE_TOKEN`**
   at <https://github.com/dsj1984/mandrel/settings/secrets/actions>.
3. Re-run release-please (push any commit, or
   `gh workflow run release-please.yml --repo dsj1984/mandrel`). The
   refreshed PR will open under the PAT identity and `Validate and
   Test` will fire automatically.

Alternative: install a GitHub App with the same permissions and feed
its installation token in via the same secret name. Apps have a higher
ceiling on automation throughput than PATs.

### npm Trusted Publisher (OIDC)

The `npm-publish` job in
[`release-please.yml`](../.github/workflows/release-please.yml) authenticates
to the npm registry via **Trusted Publishing (OIDC)** — there is no stored
`NPM_TOKEN` secret. npm exchanges the GitHub Actions OIDC token (minted
per-run from the job's workflow identity) for short-lived publish
credentials, so there is nothing to rotate and no 2FA-bypass automation
token sitting in repo secrets.

1. Configure the **Trusted Publisher** at
   <https://www.npmjs.com/package/mandrel/access> (package Settings →
   Publishing access → Trusted Publisher → GitHub Actions):
   - **Organization or user:** `dsj1984`
   - **Repository:** `mandrel`
   - **Workflow filename:** `release-please.yml`
   - **Environment name:** (leave blank — the `npm-publish` job does not
     use a GitHub Environment)
2. No repository secret is needed. The publish job declares
   `id-token: write` (required for the OIDC token exchange) and the
   package sets `publishConfig.provenance: true`, so npm attaches a
   signed Sigstore provenance statement automatically as part of the same
   OIDC exchange.
3. Trusted Publishing requires **npm CLI >=11.5.1**. `.nvmrc` pins Node 22
   (which bundles an older npm), so the job runs
   `npm install -g npm@latest` after `npm ci` and before `npm publish` to
   pick up a CLI that supports the OIDC flow. Re-check this step is still
   needed if `.nvmrc` is ever bumped to a Node version that bundles a
   sufficiently new npm by default.

If the Trusted Publisher is not configured (or its repo/workflow fields
don't match), `npm publish` fails authentication and the package is not
published — release-please still tags `main` and creates the GitHub
Release regardless, so a publish failure here does not block the release
itself, only the npm artifact.

### Versioning policy

`release-please-config.json` sets **`"versioning": "always-bump-minor"`**.
Every release bumps the **minor** — the major is pinned at `2.x` and the
minor is effectively a serial:

| Commit signal | Bump |
| ------------- | ---- |
| `fix:` / `perf:` | **minor** |
| `feat:` | **minor** |
| `BREAKING CHANGE:` footer or `feat!:` / `fix!:` | **minor** |

**This is a deliberate cap, not the Conventional Commits default.** The
`AlwaysBumpMinor` strategy ignores commit types entirely and always returns
a minor bump, so two things follow and both are intended:

- **A breaking marker cannot cut a major.** The framework's churn is mostly
  workflow prose and internal orchestration scripts under `.agents/`. Those
  change shape often, but the package's actual consumer surface — the
  `mandrel` CLI (`sync` / `update` / `doctor`) and the materialized
  `.agents/` payload — is what a consumer imports. A `feat!:` on an operator
  slash-command flag was cutting a major for a change no consumer's code
  could break on. Majors are now **deliberate**, not incidental.
- **There are no patch releases.** A one-line `fix:` cuts `2.(n+1).0`, not
  `2.n.1`. That is the cost of the cap; the minor number is a serial, and
  the changelog — not the version — tells you what changed.

> **Keep marking breaking changes anyway.** `feat!:` / `BREAKING CHANGE:`
> still drive the changelog's breaking section, which is how consumers learn
> what to adjust. The cap changes the *number*, not the *signal*.

v2.0.0 was cut by landing the Story-collapse work with an explicit
`BREAKING CHANGE` changelog section and version files already at `2.0.0`.
Story #4540 then added the cap, after a `feat!:` retiring the `/deliver
--run` flag proposed 3.0.0.

#### The major only moves when the operator says so

That is the whole point of the cap, and it holds in both directions:

- **Nothing in commit history can cut a major.** Not `feat!:`, not a
  `BREAKING CHANGE:` footer, not any combination — `AlwaysBumpMinor` never
  consults commit types.
- **The operator can cut one at any time, in one step**, with no config
  change: land an empty commit carrying a `Release-As:` footer.

```bash
git commit --allow-empty -m "chore: release 3.0.0" -m "Release-As: 3.0.0"
```

`Release-As:` **wins over the cap** — it is not blocked by it. release-please
resolves the next version in this precedence
(`src/strategies/base.ts#buildNewVersion`):

1. the `release-as` **config** field, then
2. a **`Release-As:` commit footer**, then
3. *only if neither is present* — the versioning strategy (this cap).

So the trailer returns before `always-bump-minor` is ever reached. The
footer key is case-insensitive and must sit in the commit's footer block
(a blank line after the subject — the two `-m` flags above produce that).

> **Do not "temporarily remove the cap" to cut a major.** It is unnecessary —
> `Release-As:` already overrides it — and it is a trap: if the line is not
> re-added, accidental majors silently come back the next time anyone lands
> a `feat!:`.

The same trailer forces *any* version (skip a bump, re-cut after a mistaken
tag), since step 2 above bypasses commit analysis entirely. The manual
alternative is editing `package.json`, `.release-please-manifest.json`, and
`docs/CHANGELOG.md` directly on the release PR branch.

If majors should ever become automatic again, set `"versioning"` to
`"default"` (or drop the field) — that is the only change that re-enables
commit-driven majors.
