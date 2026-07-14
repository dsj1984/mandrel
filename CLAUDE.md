# Agent Protocols - Always-Loaded Context

@AGENTS.md
@.agentrc.json

## System Prompt

@.agents/instructions.md

## Global Rules (always active)

<!--
  Always-on core only, per .agents/instructions.md § 1.F. The on-demand
  rules (shell-conventions, testing-standards, orchestration-error-handling,
  and the domain rules) are read when the task engages them, not @-imported
  here — otherwise every root session (and every subagent it spawns) re-pays
  their bytes on every turn.
-->

@.agents/rules/security-baseline.md
@.agents/rules/git-conventions.md

> **Import order is not precedence.** The order these files are imported above
> is for loading convenience only; when two governance documents conflict, the
> authoritative resolution order is declared once in
> [`.agents/instructions.md` § 1.K — Precedence & Conflict Resolution](.agents/instructions.md)
> (local overrides → `instructions.md` → `rules/` → `skills/`, with
> security-baseline inviolable).

## Ticket hierarchy

> Mandrel uses a **Story-only** ticket model. Acceptance criteria and
> verification steps are inlined on the Story body (`acceptance[]` /
> `verify[]`); the folded Tech Spec lives in `## Spec`. `/plan` emits
> one or more `type::story` issues (default N=1); `/deliver` runs each
> Story via `helpers/deliver-story` on `story-<id>` → PR → `main`.
> There is no Epic parent tier and no `persona::*` label axis. See
> [`.agents/instructions.md` § 5.D](.agents/instructions.md) and
> [`.agents/docs/SDLC.md` § Ticket hierarchy](.agents/docs/SDLC.md).
