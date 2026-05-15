# AGENTS.md

> **Canonical Instructions:** All behavioral rules, guardrails, and execution
> protocols are defined in [`.agents/instructions.md`](.agents/instructions.md).
> You **MUST** load and follow that file as your primary system prompt. This
> file provides repository-level onboarding context only — it does not redefine
> any rules.

---

## Project Overview

**Mandrel** is a Claude Code-first opinionated workflow framework with a
runtime-pluggable dispatcher: a framework of instructions, personas,
skills, and SDLC workflows that govern AI coding assistants. The
`.claude/` / hook / skill surface leans in on Claude Code as the
reference runtime; the dispatcher under `.agents/scripts/` stays
runtime-neutral behind the `IExecutionAdapter` boundary. The framework
is distributed as a Git submodule (via the `dist` branch) into consumer
projects' `.agents/` directories.

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
```

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
2. release-please opens a `chore(main): release X.Y.Z` PR. Review the
   auto-generated entry in `docs/CHANGELOG.md` and the bumps to
   `package.json` and `.agents/VERSION`.
3. Merge the release PR. The workflow creates the GitHub Release, tags
   `main` with `vX.Y.Z`, and mirrors a `dist-vX.Y.Z` tag onto the
   `dist` branch tip so submodule consumers can pin to the release.
   The existing `dist` sync in `ci.yml` propagates the new
   `.agents/VERSION` to consumers.

---

## Key Reference Documents

| Document                                             | Purpose                             |
| ---------------------------------------------------- | ----------------------------------- |
| [`.agents/instructions.md`](.agents/instructions.md) | **System prompt** — all agent rules |
| [`.agents/README.md`](.agents/README.md)             | Consumer user guide                 |
| [`.agents/SDLC.md`](.agents/SDLC.md)                 | End-to-end SDLC narrative           |
| [`.agentrc.json`](.agentrc.json)                     | Runtime configuration               |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md)             | Release history                     |
