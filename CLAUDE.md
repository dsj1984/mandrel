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
