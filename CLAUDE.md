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
>
> **Ticket hierarchy** is Story-only (`type::story`). The contract is stated
> once in [`.agents/instructions.md` § 5.D](.agents/instructions.md) — that
> section is the source of truth and this file does not restate it. The
> narrative lives in
> [`.agents/docs/SDLC.md` § Ticket hierarchy](.agents/docs/SDLC.md).
