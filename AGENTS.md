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
comment) as the cross-runtime contract. The framework is distributed
as a Git submodule (via the `dist` branch) into consumer projects'
`.agents/` directories.

- **Current Version:** See [`.agents/VERSION`](.agents/VERSION)
- **License:** ISC

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
   See the `agentSettings` and `orchestration` sections for project-specific
   values. Tech-stack context lives in
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
| CI/CD        | GitHub Actions (`ci.yml`) — validates markdown, syncs `dist`   |

### Key Commands

```text
npm run lint          # Check all markdown for lint errors
npm run format        # Auto-format all markdown files
npm run format:check  # Verify formatting without modifying files
npm test              # Run framework tests (node --test)
npm run test:profile  # Slow-test report → temp/test-profile.{tap,summary.txt}
```

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
4. Open a PR against `main`. CI validates and syncs to `dist` on merge.

### Release Checklist

Releases are automated by
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action)
(see [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml)):

1. Land Conventional Commits on `main` (the rules in
   [`.agents/rules/git-conventions.md`](.agents/rules/git-conventions.md)
   already enforce the commit-message contract).
2. release-please opens a `chore(main): release X.Y.Z` PR with
   auto-merge enabled (squash). Review the auto-generated entry in
   `docs/CHANGELOG.md` and the bumps to `package.json` and
   `.agents/VERSION` if you want; otherwise no operator action is
   needed.
3. CI fires on the release PR automatically (because release-please
   uses the operator-managed `RELEASE_PLEASE_TOKEN` PAT — see
   [§ One-time PAT setup](#one-time-pat-setup) below). Once
   `Validate and Test` passes, GitHub squash-merges the release PR,
   which triggers the workflow to create the GitHub Release, tag
   `main` with `vX.Y.Z`, and mirror a `dist-vX.Y.Z` tag onto `dist`.
   The existing `dist` sync in `ci.yml` propagates the new
   `.agents/VERSION` to consumers.

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
