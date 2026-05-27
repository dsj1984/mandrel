# Agent Protocols - Always-Loaded Context

@AGENTS.md
@.agentrc.json

## System Prompt

@.agents/instructions.md

## Default Persona (Engineer)

@.agents/personas/engineer.md

## Global Rules (always active)

@.agents/rules/git-conventions.md
@.agents/rules/orchestration-error-handling.md
@.agents/rules/security-baseline.md
@.agents/rules/shell-conventions.md
@.agents/rules/testing-standards.md

## 3-tier hierarchy (target shape — opt-in via `planning.hierarchy: '3-tier'`)

> The default ticket hierarchy here is 4-tier
> (Epic → Feature → Story → Task) — Task lifecycle, `task-commit.js`,
> and per-Task `agent::*` transitions are all active. Epic #3078
> introduces a target 3-tier shape (Epic → Feature → Story with inline
> acceptance/verify on the Story body) opt-in via the
> `planning.hierarchy` flag in `.agentrc.json`. While Epic #3078 is in
> flight, the default remains `'4-tier'` and both shapes are supported
> in parallel. After Epic #3078's destructive Feature 8 lands, the flag
> is removed and 3-tier becomes the only shape. See
> [`.agents/instructions.md` § 5.D](.agents/instructions.md) and
> [`.agents/SDLC.md` § 3-tier hierarchy](.agents/SDLC.md) for the full
> contract.
