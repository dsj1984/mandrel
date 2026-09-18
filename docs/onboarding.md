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
├── .agents/                  # Distributed: the materialized payload
│   ├── instructions.md       # ★ Primary system prompt — load this first
│   ├── agents/               # Role-scoped spawn boot contexts (optional)
│   ├── audit-checklists/     # Generated per-lens audit checklists
│   ├── rules/                # Domain-agnostic coding/ops rules
│   ├── skills/               # Two-tier skill library (core/ + stack/)
│   ├── workflows/            # SDLC & audit slash-command workflows
│   ├── scripts/              # Deterministic JS tooling (orchestration engine)
│   ├── schemas/              # JSON Schemas for structured output validation
│   ├── templates/            # Planning prompt templates
│   ├── docs/                 # Shipped consumer reference docs (SDLC.md, configuration.md, execution-reference.md, quality-gates.md, workflows.md, agentrc-reference.json)
│   ├── runtime-deps.json     # Runtime dependencies the payload needs present
│   ├── starter-agentrc.json  # Bootstrap delta-seed — consumers copy to project root
│   └── README.md             # Detailed consumer user guide
├── bin/                      # Distributed: mandrel.js (CLI dispatcher) + postinstall.js
├── lib/                      # Distributed: cli/ subcommand impls + migrations/
├── .agentrc.json             # Root config for this repo (dogfooding)
├── baselines/                # Committed quality/ratchet baselines
├── docs/                     # Implementation plans and changelog
│   └── contributing/         # Contributor-only rules (known-tooling-behavior, test-seams, orchestration-error-handling, comment-policy)
├── scripts/                  # Contributor-only CLIs (lint/verify aggregates, CI ratchets) — not distributed
├── tests/                    # Framework tests
├── package.json              # Tooling: biome, markdownlint, husky
```

> **Key distinction:** the published package ships the three directories marked
> *Distributed* above — `.agents/`, `bin/`, and `lib/` — plus the single file
> `docs/CHANGELOG.md`, per the `files` array in
> [`package.json`](../package.json) (which also excludes the `__tests__`
> subtrees under `.agents/` and `lib/`). Only `.agents/` is *materialized* into
> the consumer's working tree (by `mandrel sync`); `bin/` and `lib/` stay in
> `node_modules/mandrel/` and back the `npx mandrel …` CLI. Everything else in
> this repository is internal development tooling.

---

## Getting Started (For Agents Working on This Repo)

1. **Load the system prompt:** Read
   [`.agents/instructions.md`](../.agents/instructions.md) in full before
   taking any action.

2. **Resolve configuration:** Settings are in
   [`.agentrc.json`](../.agentrc.json). This repository's file carries the
   `project`, `github`, and `delivery` sections; the full key set the schema
   accepts (including `planning`) is documented in
   [`.agents/docs/configuration.md`](../.agents/docs/configuration.md).
   Tech-stack context lives in [`architecture.md`](architecture.md) under the
   **Tech Stack** section, not in the JSON config.

3. **Activate skills and on-demand rules as needed:** Read the relevant
   `SKILL.md` from `.agents/skills/core/[name]/` (universal process skills) or
   `.agents/skills/stack/[category]/[name]/` (tech-stack-specific) before
   writing domain-specific code. Each `SKILL.md` leads with its Policy Capsule
   and points at a `reference.md` sibling for the long-form material — read the
   sibling only when the task needs that depth. The `.agents/rules/` set is
   likewise split into an always-on core (`security-baseline.md`,
   `git-conventions.md`) and an on-demand set (`testing-standards.md`,
   `api-conventions.md`, and the domain rules) read only when the task
   engages them. The rules that only govern mandrel's own tooling —
   `known-tooling-behavior.md`, `test-seams.md`,
   `orchestration-error-handling.md` and
   [`comment-policy.md`](contributing/comment-policy.md) — live under
   [`docs/contributing/`](contributing/) instead and do not ship. See
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
| Linter       | `biome` + `markdownlint` + the repo's own ratchets — `npm run lint` |
| Formatter    | `biome format` — **JavaScript and JSON only**; markdown is not formatted by `npm run format` (see below) |
| Git Hooks    | Husky — `pre-commit` runs version-sync, lint-staged, and the blocking `quality-preview.js --staged` MI/CRAP gate; `pre-push` runs the diff-scoped quality preview plus the coverage/CRAP ratchet |
| Node Version | >=22.22.1 <25                                                  |
| Package Mgr  | npm                                                            |
| Shell        | PowerShell (Windows) — use `;` not `&&` as statement separator |
| CI/CD        | GitHub Actions (`ci.yml`) — `Validate and Test` + `baselines` (required) and the advisory `Windows Smoke` leg |

**Markdown is not auto-formatted by `npm run format`.** That script is
`biome format --write .`, and [`biome.json`](../biome.json) declares only a
`javascript.formatter` — Biome ignores `.md` paths entirely, so the command
reports `Checked 0 files` for markdown and changes nothing. The only markdown
fixer wired up is `markdownlint-cli2 --fix`, which runs from
[`.lintstagedrc`](../.lintstagedrc) on **staged** `.md` files at commit time.
To fix a markdown file outside a commit, invoke it directly:

```bash
npx markdownlint-cli2 --fix path/to/file.md
```

### Key Commands

```text
npm run lint              # biome ci + markdownlint + the lifecycle/workflow-cli/
                          #   label-vocabulary/arch-cycles ratchets, then the
                          #   generated-doc drift gate (docs:check); if it fails
                          #   on drift, run docs:gen to regenerate
npm run docs:gen          # Regenerate config/lifecycle/workflows docs
npm run skills:index      # Regenerate the skills index
npm run format            # biome format --write . — JavaScript/JSON only, NOT markdown
npm run format:check      # biome ci . — verify without modifying files
npm run test:quick        # TDD loop — excludes slow integration-style suites
npm run test:integration  # Real-git / hook-chain / long orchestration suites only
npm run test:e2e          # tests/e2e/** only — real npm pack + install, own CI job
npm test                  # Full suite minus the e2e tier
npm run test:profile      # Slow-test report → temp/test-profile.{tap,summary.txt}
npm run verify            # Full local gate: audit + lint + full tests + baselines
                          #   + dead-exports/context-budget ratchets
                          #   (true CI mirror; CI-only gates in docs/ci-contract.md)
```

The runner tiers are `full` (the `npm test` default), `quick`, `integration`
and `e2e`. `tests/e2e/**` belongs to the `e2e` tier and to no other one: those
suites `npm pack` this repository and `npm install` it into a temp consumer, so
they used to charge every `npm test` for a signal that only moves when the
release-shaped install path moves. `npm run test:e2e` runs them and a dedicated
CI job runs that per PR — and `run-coverage.js` still measures them, so the
coverage and CRAP baselines see exactly the surface they always did.

Use `test:quick` while iterating, `test:integration` before pushing when you
touched git/orchestration hooks, `test:e2e` when you touched the install /
update / sync path, and `npm run verify` when you want pre-PR confidence (audit + lint + full tests + baselines + the dead-exports and
context-budget ratchets; the arch-cycles ratchet rides along inside `lint`).
`npm run verify` is a **true CI mirror** for the gates it can prove locally,
but a small set of CI gates (action pinning, the TruffleHog secret scan, and
the `check-test-temp-hygiene.js` snapshot/assert bracket around the test run)
cannot be reproduced from a local working tree — those are catalogued in
[`ci-contract.md`](ci-contract.md), so a local green is necessary but not
sufficient. Pre-push runs only diff-scoped quality preview plus coverage/CRAP
ratchet; it does not run full lint or `npm test`. CI always runs the full
`npm test` suite.

### Where the CRAP / Maintainability gates fire

The same `delivery.quality.*` thresholds from [`.agentrc.json`](../.agentrc.json)
are enforced at four sites, earliest first:

| Site | Scope | Blocking? |
| --- | --- | --- |
| [`.husky/pre-commit`](../.husky/pre-commit) — `quality-preview.js --staged` | staged index paths only | **Yes** — a threshold violation exits non-zero and the commit is refused |
| [`.husky/pre-push`](../.husky/pre-push) — `quality-preview.js --changed-since origin/main` plus `crap:check` | diff against `origin/main` | **Yes** — the push is refused |
| Story close-validation (`single-story-close.js`) | the Story's whole change set | **Yes** — close stops |
| CI (`ci.yml`, push + PR) | diff-scoped — the `baselines` job reads the committed rows for the changed files | **Yes** — a required check fails |
| Nightly (`baseline-drift.yml`, 05:43 UTC) | **full-scope re-score** — every file, including ones no diff touched | **Yes** — the run fails and a `meta::baseline-drift` issue is filed |

`.husky/pre-commit` is the one most easily forgotten and the one that bites
first: it fires before any other gate, and a green `npm run lint` /
`npm test` / `check-baselines.js` run does **not** predict it, because none of
those measures per-file maintainability-index or CRAP deltas.

#### Hooks in a linked worktree

`core.hooksPath` is a **relative** path, and git resolves it against each
working tree's own root — not against the common git dir. The directory it
names is generated by husky's `prepare` script in the main checkout and is
self-ignored, so a linked worktree resolves the hooks path to a directory that
is not there and git runs no hook at all, silently. Story worktrees are
provisioned automatically during `worktree.bootstrap`. For a worktree the
orchestrator did not create, run this from inside it:

```bash
node scripts/provision-git-hooks.js
```

It is idempotent, and a no-op in a project with no hooks configured.

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

## The suite's child-process budget

`npm test` forks one process per test file, and the spawns those leaves make
dominate the suite's system time. Two instruments and one rule keep that
budget visible and honest (Story #5121).

### Measure it with `npm run test:census`

```bash
npm run test:census            # writes temp/census.json
```

`tests/fixtures/spawn-census.cjs` is a `--require` preload that counts every
`child_process` call per binary, aggregates across all ~700 processes, and
reports `nodeInSuite` (node children spawned *by test files*, excluding the
runner's own fan-out), `git`, `gh`, `npm`, and any standalone
`git config user.*` spawns. Read the numbers from the census rather than
re-deriving them; two audits hand-rolled this measurement and lost it both
times with the gitignored temp tree.

The script interpolates `$PWD` deliberately. A **relative** `--require` path is
inherited by children that run with a different `cwd`, where it fails to
resolve and kills the child before it runs a line — measured as 15 spurious
failures in one file.

### Build a fixture repo once, then copy it

A multi-commit fixture repo rebuilt in `beforeEach` is the costly shape. Build
it once in `before()` and hand each test an `fs` copy via
`copyGitRepo(pristine)` from `tests/fixtures/git-fixture.js`: each test still
gets a private directory it may freely mutate, for **no subprocess at all**.
One file went from 92 `git` spawns to 27 this way.

`copyGitRepo` is safe only for a locally-`git init`ed repo, whose
`.git/config` holds no absolute paths. Do **not** copy a **clone** (its
`remote.origin.url` is absolute, so the copy would fetch from the original) or a
linked worktree (its `gitdir:` / `commondir` pointers would dangle).

### Never trade coverage for a spawn count

Most of the suite's remaining `git` spawns are integration tests exercising
real git against git-manipulating production code — the spawn **is** the
subject under test, and so is a CLI's exit code in an exit-code contract test.
Those are not fixture waste and must not be converted to in-process calls or
mocks to make a number smaller. Hoist shared setup; leave the assertions alone.
A spawn census also records argv, not what the binary resolved to: a
`gh pr view 4890` line may well be a fake `gh` the test put on `PATH`, so
verify resolution before calling a spawn a network call.

## Contribution Workflow

1. Branch from `main`.
2. Make the change. Framework behaviour lives under `.agents/`; the operator
   CLI lives under `bin/` + `lib/` — both ship, so both carry the same
   quality gates.
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
| [`contributing/comment-policy.md`](contributing/comment-policy.md) | What a source comment may say, and the ratchets that hold it |
