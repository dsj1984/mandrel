# AGENTS.md

> **Canonical Instructions:** All behavioral rules, guardrails, and execution
> protocols are defined in [`.agents/instructions.md`](.agents/instructions.md).
> You **MUST** load and follow that file as your primary system prompt. This
> file provides repository-level onboarding context only — it does not redefine
> any rules.

---

## Project Overview

**Mandrel** is a Claude Code-first opinionated workflow framework: a
collection of instructions, personas, skills, and SDLC workflows that
govern AI coding assistants. The `.claude/` / hook / skill surface
leans in on Claude Code as the reference runtime, and the dispatcher
under `.agents/scripts/` treats the dispatch manifest (md + structured
comment) as the cross-runtime contract. The framework is distributed as
the [`@mandrel/agents`](https://www.npmjs.com/package/@mandrel/agents) npm
package and materialized into consumer projects' `.agents/` directories by
`mandrel sync`.

- **Current Version:** See [`.agents/VERSION`](.agents/VERSION)
- **License:** ISC

> **Ticket hierarchy.** Mandrel ships a **3-tier ticket hierarchy**
> (Epic → Feature → Story). Acceptance criteria and verification
> steps are inlined on the Story body (`acceptance[]` / `verify[]`).
> Epic-attached Stories are delivered via `/epic-deliver` (which fans
> out `helpers/epic-deliver-story` per wave); standalone Stories use
> `/story-deliver`. There is no `type::task` ticket layer and no
> per-Task commit ceremony. See
> [`.agents/SDLC.md` § Ticket hierarchy](.agents/SDLC.md) for the
> diagram and execution-model implications.

---

## Repository Layout

```text
mandrel/
├── .agents/                  # Distributed bundle (the "product")
│   ├── instructions.md       # ★ Primary system prompt — load this first
│   ├── personas/             # 12 role-specific behavior constraints
│   ├── rules/                # 8 domain-agnostic coding/ops rules
│   ├── skills/               # Two-tier skill library (core/ + stack/)
│   ├── workflows/            # SDLC & audit slash-command workflows
│   ├── scripts/              # Deterministic JS tooling (orchestration engine)
│   ├── schemas/              # JSON Schemas for structured output validation
│   ├── templates/            # Epic / planning prompt templates
│   ├── starter-agentrc.json # Bootstrap delta-seed — consumers copy to project root
│   ├── full-agentrc.json    # Exhaustive editor reference (every schema key)
│   ├── SDLC.md               # End-to-end SDLC narrative (/epic-plan + /epic-deliver)
│   └── README.md             # Detailed consumer user guide
├── .agentrc.json             # Root config for this repo (dogfooding)
├── docs/                     # Implementation plans and changelog
├── tests/                    # Framework tests
├── package.json              # Tooling: biome, markdownlint, husky
```

> **Key distinction:** Only `.agents/` is distributed to consumers. Everything
> else is internal development tooling.

---

## Getting Started (For Agents Working on This Repo)

1. **Load the system prompt:** Read
   [`.agents/instructions.md`](.agents/instructions.md) in full before taking
   any action.

2. **Resolve configuration:** Settings are in [`.agentrc.json`](.agentrc.json).
   See the `project`, `github`, `planning`, and `delivery` sections for
   project-specific values. Tech-stack context lives in
   [`docs/architecture.md`](docs/architecture.md) under the **Tech Stack**
   section, not in the JSON config.

3. **Adopt a persona when instructed:** Persona files live in
   `.agents/personas/`. Default is `engineer.md`.

4. **Activate skills as needed:** Read the relevant `SKILL.md` from
   `.agents/skills/core/[name]/` (universal process skills) or
   `.agents/skills/stack/[category]/[name]/` (tech-stack-specific) before
   writing domain-specific code.

---

## Development Standards

| Area         | Tool / Convention                                              |
| ------------ | -------------------------------------------------------------- |
| Language     | Markdown (prose), JavaScript ESM (scripts), JSON (config)      |
| Linter       | `biome` + `markdownlint` — run via `npm run lint`              |
| Formatter    | `biome` — run via `npm run format`                             |
| Git Hooks    | Husky + lint-staged (auto-lint `.md` files on commit)          |
| Node Version | >=22.22.1 <25                                                 |
| Package Mgr  | npm                                                            |
| Shell        | PowerShell (Windows) — use `;` not `&&` as statement separator |
| CI/CD        | GitHub Actions (`ci.yml`) — validates markdown + tests        |

### Key Commands

```text
npm run lint              # Check all markdown for lint errors
npm run format            # Auto-format all markdown files
npm run format:check      # Verify formatting without modifying files
npm run test:quick        # TDD loop — excludes slow integration-style suites
npm run test:integration  # Real-git / hook-chain / long orchestration suites only
npm test                  # Full suite (same as CI test gate)
npm run test:profile      # Slow-test report → temp/test-profile.{tap,summary.txt}
npm run verify            # Full local gate: lint + full tests + baselines
```

Use `test:quick` while iterating, `test:integration` before pushing when you
touched git/orchestration hooks, and `npm run verify` when you want pre-PR
confidence (lint + full tests + baselines). Pre-push runs only diff-scoped
quality preview plus coverage/CRAP ratchet; it does not run full lint or
`npm test`. CI always runs the full `npm test` suite.

### Slow-test profiling

`npm run test:profile` runs the full suite with the TAP reporter, writes
`temp/test-profile.tap` (raw machine output) and `temp/test-profile.summary.txt`
(human-readable top-20 slow tests and suites). Both paths are gitignored under
`temp/`. The command skips npm-test preflight (`SKIP_PREFLIGHT=1`) so timings
reflect the test runner; export `SKIP_PREFLIGHT=0` to include preflight.

Read the summary file to spot regressions: **suite** rows are parent `describe`
blocks (often whole files), **test** rows are leaf cases. Compare reports from
the same machine before and after an optimization. Optional flags:
`--out-dir <path>`, `--top <n>`, plus any `node --test` args after `--` (e.g.
`npm run test:profile -- --test-name-pattern "epic-execute"`).

---

## Contribution Workflow

1. Branch from `main`.
2. Make changes inside `.agents/` (the distributed product).
3. Commit — Husky will auto-lint and format staged `.md` files.
4. Open a PR against `main`. CI validates the change; once merged,
   release-please cuts the release that publishes `@mandrel/agents` to npm
   (see the Release Checklist below).

### Release Checklist

Releases are automated by
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action)
(see [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)):

1. Land Conventional Commits on `main` (the rules in
   [`.agents/rules/git-conventions.md`](.agents/rules/git-conventions.md)
   already enforce the commit-message contract).
2. release-please opens a **single combined** release PR with
   auto-merge enabled (squash). Review the auto-generated entry in
   `docs/CHANGELOG.md` and the bumps to `package.json` and
   `.agents/VERSION` if you want; otherwise no operator action is
   needed. See [§ Two-package release topology](#two-package-release-topology)
   below for the combined-PR title/branch shape and the tag namespace
   each package uses.
3. CI fires on the release PR automatically (because release-please
   uses the operator-managed `RELEASE_PLEASE_TOKEN` PAT — see
   [§ One-time PAT setup](#one-time-pat-setup) below). Once
   `Validate and Test` passes, GitHub squash-merges the release PR,
   which triggers the workflow to create the GitHub Release, tag
   `main` with `vX.Y.Z`, and run the `npm-publish` job — publishing
   `@mandrel/agents` to npm with build provenance (Sigstore) once the
   release is cut. This replaces the retired `dist`-branch mirror:
   consumers now install a versioned, provenance-signed package from npm
   (`npm install @mandrel/agents`, then `mandrel sync`) instead of pinning
   a Git submodule to the `dist` branch. The `npm-publish` job requires the
   `NPM_TOKEN` secret — see [§ npm publish token](#npm-publish-token) below.
4. **Breaking-change releases** ship a consumer-upgrade runbook under
   `docs/` (describing the migration steps and the major-version bump
   operator step). Link any future breaking-release runbook from
   this checklist and from the **release PR body** release-please opens
   (which becomes the squash-commit body and the versioned
   [`docs/CHANGELOG.md`](docs/CHANGELOG.md) entry on merge) so consumers
   find it on upgrade. Do **not** hand-maintain an `## Unreleased`
   section in `docs/CHANGELOG.md` — release-please is the sole writer of
   that file and generates version sections from Conventional Commit
   subjects; a bracket-less `## Unreleased` block is never promoted to a
   version and only strands the content.

#### Two-package release topology

`release-please-config.json` declares **two** packages — the root
`mandrel` package (`.`) and `create-mandrel` (the bootstrap CLI). This
puts release-please in **multi-package manifest mode**, which has two
operator-visible consequences:

- **One combined release PR.** With `separate-pull-requests` left at its
  default (`false`), release-please opens a **single** combined PR for
  both packages rather than one PR per package. The combined PR uses:
  - **Branch:** `release-please--branches--main`
  - **Title:** `chore: release main`

  This differs from the legacy single-package shape
  (`chore(main): release X.Y.Z` on
  `release-please--branches--main--components--mandrel`). When the
  package set changed from one to two, the old per-component PR was
  **orphaned** — release-please no longer manages that branch shape, so
  it does not auto-close it. If you ever see two open
  `autorelease: pending` PRs, the one on the per-component branch is the
  stale orphan; close it and keep the combined `release-please--branches--main`
  PR as the live one. There should be **exactly one** open release PR at
  a time.

- **Namespaced tags (`include-component-in-tag: true`).** Each package
  gets a distinct tag namespace so the two version series never collide:
  - **`mandrel` (root, `.`)** uses `component: ""`, so its tag stays the
    bare `vX.Y.Z` form (e.g. `v1.44.0`). The empty component preserves
    the historical `mandrel` tag series that the manifest is keyed off.
  - **`create-mandrel`** uses `component: "create-mandrel"`, so its tag
    is namespaced as `create-mandrel-vX.Y.Z` (e.g. `create-mandrel-v0.2.0`).

  The `npm-publish` job in
  [`release-please.yml`](.github/workflows/release-please.yml) checks out
  the repository root and runs `npm publish` against the root `package.json`
  — it publishes the **`mandrel` package only** and does not key off any
  tag pattern, so the namespaced `create-mandrel-*` tag never triggers a
  mandrel publish. `ci.yml` triggers only on branch `push` /
  `pull_request` / `workflow_dispatch` events (it has **no** tag-driven
  step), so neither tag series triggers CI directly.

#### One-time PAT setup

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

#### npm publish token

The `npm-publish` job in
[`release-please.yml`](.github/workflows/release-please.yml) authenticates
to the npm registry with an automation token (rather than OIDC trusted
publishing), so it needs a one-time secret:

1. Create an **automation** access token with publish rights on the
   `@mandrel` scope at <https://www.npmjs.com/settings/~/tokens>. The
   token owner must be able to publish under `@mandrel`; the first
   publish of the scoped package relies on `publishConfig.access:
   "public"` (already set in `package.json`) so the public registry
   accepts it.
2. Add it as a repository secret named **`NPM_TOKEN`** at
   <https://github.com/dsj1984/mandrel/settings/secrets/actions>.
3. No further setup is required: the job declares `id-token: write` and
   `package.json#publishConfig.provenance: true`, so npm attaches a
   signed Sigstore provenance statement automatically.

Without `NPM_TOKEN`, release-please still tags `main` and creates the
GitHub Release, but the `npm-publish` job fails and the package is not
published until the secret is configured and the job re-run.

#### Major-version policy

`release-please-config.json` sets `"versioning": "always-bump-minor"`,
which caps automatic bumps at the minor axis even when commits carry
`BREAKING CHANGE:` footers or `!` markers. Major versions require
**manual operator intervention**:

1. Land the breaking work on `main` as usual (Conventional Commits).
2. On the release PR that release-please opens, either:
   - **Edit `package.json`, `.agents/VERSION`, and `docs/CHANGELOG.md`
     in-place** on the release branch to set the major version
     (release-please will respect the edits and tag accordingly), OR
   - **Add a one-shot commit on `main`** with `Release-As: X.0.0` in
     the trailer — release-please will adopt that as the proposed
     version on its next run.

The cap is intentional: it prevents an inadvertent `BREAKING CHANGE:`
footer from auto-tagging a major release without an explicit human
decision.

---

## Key Reference Documents

| Document                                             | Purpose                             |
| ---------------------------------------------------- | ----------------------------------- |
| [`.agents/instructions.md`](.agents/instructions.md) | **System prompt** — all agent rules |
| [`.agents/README.md`](.agents/README.md)             | Consumer user guide                 |
| [`.agents/SDLC.md`](.agents/SDLC.md)                 | End-to-end SDLC narrative           |
| [`.agentrc.json`](.agentrc.json)                     | Runtime configuration               |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md)             | Release history                     |
