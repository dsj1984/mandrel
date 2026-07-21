# AGENTS.md

> **Canonical Instructions:** All behavioral rules, guardrails, and execution
> protocols are defined in [`.agents/instructions.md`](.agents/instructions.md).
> You **MUST** load and follow that file as your primary system prompt. This
> file provides repository-level orientation only — it does not redefine any
> rules, and conflicts resolve by the ordering in
> [`.agents/instructions.md` § 1.K](.agents/instructions.md).

---

## Project Overview

**Mandrel** is a Claude Code-first opinionated workflow framework: a
collection of instructions, skills, rules, and SDLC workflows that govern AI
coding assistants. The `.claude/` / hook / skill surface leans in on Claude
Code as the reference runtime, and the orchestration library under
`.agents/scripts/` treats the Story issue's body and structured comments as
the cross-runtime contract. The framework is distributed as the
[`mandrel`](https://www.npmjs.com/package/mandrel) npm package and
materialized into consumer projects' `.agents/` directories by
`mandrel sync`.

- **Current Version:** the `version` field of the root
  [`package.json`](package.json) (run `npm ls mandrel` in a consumer project)
- **License:** MIT

> **Key distinction:** Only `.agents/` is distributed to consumers. Everything
> else in this repository is internal development tooling.

---

## Working in this repo — read on demand

[`docs/onboarding.md`](docs/onboarding.md) carries the repository-level
reference this file used to inline: the repository layout, the getting-started
sequence, the development-standards and key-commands tables, slow-test
profiling, the contribution workflow, release operations, and the
reference-document index. Read it when you need one of those — it is linked,
not `@`-imported, so it is not re-paid on every session and subagent spawn.

Two orientation pointers are load-bearing often enough to keep here:

- **Configuration** lives in [`.agentrc.json`](.agentrc.json) (`project`,
  `github`, `planning`, `delivery`). Project-specific technology choices are
  deliberately kept out of it — the Tech Stack inventory lives under the
  **Tech Stack** heading in [`docs/architecture.md`](docs/architecture.md).
- **Skills and rules are read on demand**, not preloaded. Each `SKILL.md`
  leads with its Policy Capsule and points at a `reference.md` sibling for the
  long-form material; the `.agents/rules/` set splits into an always-on core
  and an on-demand set. See
  [`.agents/instructions.md` § 1.B / § 1.F](.agents/instructions.md).
