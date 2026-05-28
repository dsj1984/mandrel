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

## Ticket hierarchy

> Mandrel uses a **3-tier ticket hierarchy** (Epic → Feature → Story),
> with acceptance criteria and verification steps inlined on the Story
> body (`acceptance[]` / `verify[]`). Epic-attached Stories are delivered
> via `/epic-deliver` (which fans out `helpers/epic-deliver-story` per
> wave); standalone Stories use `/story-deliver`. There is no `type::task`
> ticket layer, no per-Task `agent::*` lifecycle, and no `task-commit.js`
> ceremony. Commits land on `story-<storyId>` directly from the agent and
> reference the parent Story via `(refs #<storyId>)`. See
> [`.agents/instructions.md` § 5.D](.agents/instructions.md) and
> [`.agents/SDLC.md` § Ticket hierarchy](.agents/SDLC.md) for the full
> contract.
