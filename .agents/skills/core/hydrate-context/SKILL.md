---
name: hydrate-context
description: >-
  Hydrate a Task or Story ticket into a single prompt string the executor
  can drop in front of an implementation request. Reads the ticket body,
  parses Feature / Epic hierarchy, fetches the Tech Spec + PRD, and
  composes a `{ prompt }` JSON envelope. Successor to the retired
  agent-protocols MCP `context.hydrate` tool.
allowed_tools:
  - Read
  - Bash
---

# hydrate-context

## Role

Context aggregator. Resolves a ticket's hierarchy (Task → Story →
Feature → Epic) and stitches the linked planning artifacts into a
single prompt the executor consumes.

## When to use

Whenever an Epic-scoped sub-agent needs the same context bundle the
human operator would assemble manually before opening the file editor.
The wrapping script `hydrate-context.js` is the CLI today; this Skill
documents the dispatch contract for callers that want to invoke via
the Skill tool.

## Inputs

- `--ticket <id>` — GitHub issue number to hydrate (required).
- `--epic <id>` (optional) — when omitted, parsed from the ticket
  body's `Epic: #N` line.

Persona and skill labels are read off the ticket
(`persona::*`, `skill::*`) and surfaced in the composed prompt so the
executor can pin its sub-agent dispatch.

## Outputs

A single JSON object on stdout:

```json
{ "prompt": "..." }
```

The Skill writes nothing else — no GitHub comments, no temp files.
Idempotence is trivial because the operation is read-only.

## Procedure

```bash
node .agents/scripts/hydrate-context.js --ticket <id> [--epic <id>]
```

Delegates to `hydrateContext` from
`lib/orchestration/context-hydration-engine.js`. The engine handles
provider I/O, body parsing, and the context-budget cap.

## Constraints

- Do **not** modify ticket bodies or post comments. The Skill is
  strictly read-only on GitHub.
- Do **not** persist the composed prompt to disk. The caller is
  responsible for forwarding the stdout envelope to its consumer.
- Do **not** bypass the context-budget cap in the engine — if the
  composed prompt would exceed the configured limit, the engine
  downgrades fields explicitly. Honour that contract; never silently
  truncate.
