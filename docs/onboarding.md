# Repository Onboarding

Repository-level reference for agents and humans working **on** Mandrel
itself. Read it when you need the layout, a command, or a development
standard — it is deliberately **not** part of the always-loaded context
closure ([`AGENTS.md`](../AGENTS.md) points here instead of inlining it), so a
task that does not need this material does not pay for it, and neither does
any subagent it spawns.

Behavioral rules are **not** here. They live in
[`.agents/instructions.md`](../.agents/instructions.md), which is the
authoritative system prompt.

---

## Repository Layout

```text
mandrel/
├── .agents/                  # Distributed bundle (the "product")
│   ├── instructions.md       # ★ Primary system prompt — load this first
│   ├── agents/               # Role-scoped spawn boot contexts (optional)
│   ├── rules/                # Domain-agnostic coding/ops rules
│   ├── skills/               # Two-tier skill library (core/ + stack/)
│   ├── workflows/            # SDLC & audit slash-command workflows
│   ├── scripts/              # Deterministic JS tooling (orchestration engine)
│   ├── schemas/              # JSON Schemas for structured output validation
│   ├── templates/            # Planning prompt templates
│   ├── docs/                 # Shipped consumer reference docs (SDLC.md, configuration.md, agentrc-reference.json)
│   ├── starter-agentrc.json  # Bootstrap delta-seed — consumers copy to project root
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
   [`.agents/instructions.md`](../.agents/instructions.md) in full before
   taking any action.

2. **Resolve configuration:** Settings are in
   [`.agentrc.json`](../.agentrc.json). See the `project`, `github`,
   `planning`, and `delivery` sections for project-specific values.
   Tech-stack context lives in [`architecture.md`](architecture.md) under the
   **Tech Stack** section, not in the JSON config.

3. **Activate skills and on-demand rules as needed:** Read the relevant
   `SKILL.md` from `.agents/skills/core/[name]/` (universal process skills) or
   `.agents/skills/stack/[category]/[name]/` (tech-stack-specific) before
   writing domain-specific code. Each `SKILL.md` leads with its Policy Capsule
   and points at a `reference.md` sibling for the long-form material — read the
   sibling only when the task needs that depth. The `.agents/rules/` set is
   likewise split into an always-on core (`security-baseline.md`,
   `git-conventions.md`) and an on-demand set (`shell-conventions.md`,
   `testing-standards.md`, `orchestration-error-handling.md`, and the domain
   rules) read only when the task engages them. See
   [`.agents/README.md` § What to always-load vs read on-demand](../.agents/README.md)
   and [`.agents/instructions.md` § 1.F](../.agents/instructions.md) for the
   full split. There is no `.agents/personas/` pack and no `persona::*` label
   axis — role framing comes from instructions, rules, skills, and optional
   `.agents/agents/` boot contexts.

---

## Development Standards

| Area         | Tool / Convention                                              |
| ------------ | -------------------------------------------------------------- |
| Language     | Markdown (prose), JavaScript ESM (scripts), JSON (config)      |
| Linter       | `biome` + `markdownlint` — run via `npm run lint`              |
| Formatter    | `biome` — run via `npm run format`                             |
| Git Hooks    | Husky + lint-staged (auto-lint `.md` files on commit)          |
| Node Version | >=22.22.1 <25                                                  |
| Package Mgr  | npm                                                            |
| Shell        | PowerShell (Windows) — use `;` not `&&` as statement separator |
| CI/CD        | GitHub Actions (`ci.yml`) — validates markdown + tests         |

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
                          #   + dead-exports/context-budget ratchets
                          #   (true CI mirror; CI-only gates in docs/ci-contract.md)
```

Use `test:quick` while iterating, `test:integration` before pushing when you
touched git/orchestration hooks, and `npm run verify` when you want pre-PR
confidence (audit + lint + full tests + baselines + the dead-exports and
context-budget ratchets; the arch-cycles ratchet rides along inside `lint`).
`npm run verify` is a **true CI mirror** for the gates it can prove locally,
but a small set of CI gates (action pinning, the TruffleHog secret scan, and
the push-scoped `BASELINE_SCOPE=full` maintainability run) cannot be
reproduced from a local working tree — those are catalogued in
[`ci-contract.md`](ci-contract.md), so a local green is necessary but not
sufficient. Pre-push runs only diff-scoped quality preview plus coverage/CRAP
ratchet; it does not run full lint or `npm test`. CI always runs the full
`npm test` suite.

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
`npm run test:profile -- --test-name-pattern "single-story"`).

---

## Contribution Workflow

1. Branch from `main`.
2. Make changes inside `.agents/` (the distributed product).
3. Commit — Husky will auto-lint and format staged `.md` files.
4. Open a PR against `main`. CI validates the change; once merged,
   release-please cuts the release that publishes `mandrel` to npm.

### Release Operations

Release plumbing — the full Release Checklist, the Install Matrix release
gate, release topology, one-time PAT setup (including the
`RELEASE_PLEASE_TOKEN` operator surface that also authorizes workflow-file
edits), npm Trusted Publisher (OIDC) configuration, and the major-version
policy — lives in [`release-operations.md`](release-operations.md). It is
consulted at release time, not on every task.

---

## Key Reference Documents

| Document                                                    | Purpose                             |
| ----------------------------------------------------------- | ----------------------------------- |
| [`.agents/instructions.md`](../.agents/instructions.md)     | **System prompt** — all agent rules |
| [`.agents/README.md`](../.agents/README.md)                 | Consumer user guide                 |
| [`.agents/docs/SDLC.md`](../.agents/docs/SDLC.md)           | End-to-end SDLC narrative           |
| [`.agentrc.json`](../.agentrc.json)                         | Runtime configuration               |
| [`CHANGELOG.md`](CHANGELOG.md)                              | Release history                     |
| [`claude-coupling-review.md`](claude-coupling-review.md)    | Where the Claude Code coupling lives |
