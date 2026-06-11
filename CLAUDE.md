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

> **Import order is not precedence.** The order these files are imported above
> is for loading convenience only; when two governance documents conflict, the
> authoritative resolution order is declared once in
> [`.agents/instructions.md` § 1.K — Precedence & Conflict Resolution](.agents/instructions.md)
> (local overrides → `instructions.md` → `rules/` → active persona → `skills/`,
> with security-baseline inviolable).

## Ticket hierarchy

> Mandrel uses a **2-tier ticket hierarchy** (Epic → Story),
> with acceptance criteria and verification steps inlined on the Story
> body (`acceptance[]` / `verify[]`). All delivery flows through
> `/deliver`, which routes Epic vs standalone-Story input — Epic-attached
> Stories are delivered as part of their Epic (the Epic path fans out
> `helpers/epic-deliver-story` per wave). There is no `type::task`
> ticket layer, no per-Task `agent::*` lifecycle, and no `task-commit.js`
> ceremony. Commits land on `story-<storyId>` directly from the agent and
> reference the parent Story via `(refs #<storyId>)`. See
> [`.agents/instructions.md` § 5.D](.agents/instructions.md) and
> [`.agents/docs/SDLC.md` § Ticket hierarchy](.agents/docs/SDLC.md) for the full
> contract.
