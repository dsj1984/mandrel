# AGENTS.md

Mandrel is a Claude Code-first workflow framework: instructions, skills,
rules, and SDLC workflows that govern AI coding assistants. It ships as the
[`mandrel`](https://www.npmjs.com/package/mandrel) npm package, which
`mandrel sync` materializes into a consumer project's `.agents/` directory.

## Always-loaded context

@.agentrc.json
@.agents/instructions.md
@.agents/rules/security-baseline.md
@.agents/rules/git-conventions.md

`.agents/instructions.md` is the canonical system prompt. This file adds
repository orientation only; where the two disagree, the ordering in
`.agents/instructions.md` § 1.K decides.

## What ships vs. what is internal

The published package is the `files` array in [`package.json`](package.json):
`.agents/`, `bin/`, `lib/`, and `docs/CHANGELOG.md`. Everything else in this
repository (`tests/`, `scripts/`, `baselines/`, the rest of `docs/`) is
development tooling for Mandrel itself. A change under `.agents/`, `bin/`, or
`lib/` reaches consumers; weigh it accordingly.

## Where things live

- **Configuration:** [`.agentrc.json`](.agentrc.json) (`project`, `github`,
  `delivery`). Every accepted key is documented in
  [`.agents/docs/configuration.md`](.agents/docs/configuration.md).
- **Tech Stack:** the **Tech Stack** section of
  [`docs/architecture.md`](docs/architecture.md). Technology choices are kept
  out of `.agentrc.json` on purpose.
- **Skills and rules:** read on demand, not preloaded. Each `SKILL.md` opens
  with its Policy Capsule; `.agents/rules/` splits into the always-on core
  imported above and an on-demand set.
- **Everything else:** [`docs/onboarding.md`](docs/onboarding.md) covers the
  repository layout, getting started, key commands, slow-test profiling, the
  contribution workflow, and release operations. Read it when you need one of
  those.
