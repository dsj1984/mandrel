# AGENTS.md

> **Canonical Instructions:** All behavioral rules, guardrails, and execution
> protocols are defined in [`.agents/instructions.md`](.agents/instructions.md).
> You **MUST** load and follow that file as your primary system prompt. This
> file provides repository-level onboarding context only — it does not redefine
> any rules. When two governance documents conflict, resolve by the total
> ordering declared in
> [`.agents/instructions.md` § 1.K — Precedence & Conflict Resolution](.agents/instructions.md).

---

## Project Overview

**Mandrel** is a Claude Code-first opinionated workflow framework: a
collection of instructions, personas, skills, and SDLC workflows that
govern AI coding assistants. The `.claude/` / hook / skill surface
leans in on Claude Code as the reference runtime, and the dispatcher
under `.agents/scripts/` treats the dispatch manifest (md + structured
comment) as the cross-runtime contract. The framework is distributed as
the [`mandrel`](https://www.npmjs.com/package/mandrel) npm
package and materialized into consumer projects' `.agents/` directories by
`mandrel sync`.

- **Current Version:** the `version` field of the root
  [`package.json`](package.json) (run `npm ls mandrel` in a
  consumer project)
- **License:** MIT

> **Ticket hierarchy.** Mandrel ships a **Story-only** ticket model.
> Acceptance criteria and verification steps are inlined on the Story
> body (`acceptance[]` / `verify[]`); the folded Tech Spec lives in
> `## Spec` (with spill-to-doc when over budget). `/plan` emits one or
> more `type::story` issues (default N=1); `/deliver` runs each Story
> via `helpers/deliver-story` on `story-<id>` → PR → `main`. Optional
> `depends_on` / `plan-run::<id>` edges order rare multi-Story runs.
> There is no `type::epic` / `type::task` layer and no per-Task commit
> ceremony. See [`.agents/instructions.md` § 5.D](.agents/instructions.md)
> and [`.agents/docs/SDLC.md`](.agents/docs/SDLC.md) for the contract.

---

## Repository Layout

```text
mandrel/
├── .agents/                  # Distributed bundle (the "product")
│   ├── instructions.md       # ★ Primary system prompt — load this first
│   ├── personas/             # Role-specific behavior constraints
│   ├── rules/                # Domain-agnostic coding/ops rules
│   ├── skills/               # Two-tier skill library (core/ + stack/)
│   ├── workflows/            # SDLC & audit slash-command workflows
│   ├── scripts/              # Deterministic JS tooling (orchestration engine)
│   ├── schemas/              # JSON Schemas for structured output validation
│   ├── templates/            # Epic / planning prompt templates
│   ├── docs/                  # Shipped consumer reference docs (SDLC.md, configuration.md, agentrc-reference.json)
│   ├── starter-agentrc.json # Bootstrap delta-seed — consumers copy to project root
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

4. **Activate skills and on-demand rules as needed:** Read the relevant
   `SKILL.md` from `.agents/skills/core/[name]/` (universal process skills) or
   `.agents/skills/stack/[category]/[name]/` (tech-stack-specific) before
   writing domain-specific code. The `.agents/rules/` set is likewise split
   into an always-on core (`security-baseline.md`, `git-conventions.md`) and
   an on-demand set (`shell-conventions.md`, `testing-standards.md`,
   `orchestration-error-handling.md`, and the domain rules) read only when the
   task engages them. See
   [`.agents/README.md` § What to always-load vs read on-demand](.agents/README.md)
   and [`.agents/instructions.md` § 1.F](.agents/instructions.md) for the full
   split.

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
npm run lint              # Markdown lint + generated-doc drift gate (docs:check);
                          #   if it fails on drift, run docs:gen to regenerate
npm run docs:gen          # Regenerate config/lifecycle/workflows docs
npm run skills:index      # Regenerate the skills index
npm run format            # Auto-format all markdown files
npm run format:check      # Verify formatting without modifying files
npm run test:quick        # TDD loop — excludes slow integration-style suites
npm run test:integration  # Real-git / hook-chain / long orchestration suites only
npm test                  # Full suite (same as CI test gate)
npm run test:profile      # Slow-test report → temp/test-profile.{tap,summary.txt}
npm run verify            # Full local gate: audit + lint + full tests + baselines
                          #   (true CI mirror; CI-only gates in docs/ci-contract.md)
```

Use `test:quick` while iterating, `test:integration` before pushing when you
touched git/orchestration hooks, and `npm run verify` when you want pre-PR
confidence (audit + lint + full tests + baselines). `npm run verify` is a
**true CI mirror** for the gates it can prove locally, but a small set of CI
gates (action pinning, the TruffleHog secret scan, and the push-scoped
`BASELINE_SCOPE=full` maintainability run) cannot be reproduced from a local
working tree — those are catalogued in
[`docs/ci-contract.md`](docs/ci-contract.md), so a local green is necessary but
not sufficient. Pre-push runs only diff-scoped quality preview plus
coverage/CRAP ratchet; it does not run full lint or `npm test`. CI always runs
the full `npm test` suite.

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
   release-please cuts the release that publishes `mandrel` to npm
   (see the Release Checklist below).

### Release Operations

Release plumbing — the full Release Checklist, the Install Matrix release
gate, release topology, one-time PAT setup, npm Trusted Publisher (OIDC)
configuration, and the major-version policy — lives in
[`docs/release-operations.md`](docs/release-operations.md). It was moved
out of this always-`@`-imported file (Story #4333) so the always-loaded
session context stays lean; that material is consulted at release time,
not on every task.

#### One-time PAT setup

Provisioning the `RELEASE_PLEASE_TOKEN` PAT (the operator surface that also
authorizes workflow-file edits) is documented in
[`docs/release-operations.md` § One-time PAT setup](docs/release-operations.md#one-time-pat-setup).

---

## Key Reference Documents

| Document                                             | Purpose                             |
| ---------------------------------------------------- | ----------------------------------- |
| [`.agents/instructions.md`](.agents/instructions.md) | **System prompt** — all agent rules |
| [`.agents/README.md`](.agents/README.md)             | Consumer user guide                 |
| [`.agents/docs/SDLC.md`](.agents/docs/SDLC.md)       | End-to-end SDLC narrative           |
| [`.agentrc.json`](.agentrc.json)                     | Runtime configuration               |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md)             | Release history                     |
