---
name: hydrate-context
description: >-
  Hydrate a Story ticket into a structured ContextEnvelope (or the
  legacy `{ prompt }` stdout wrapper). Reads the ticket body, resolves the
  parent Epic, embeds the sectioned Epic body (acceptance-table section
  stripped), and assembles
  named sections with provenance and section-aware elision. Successor to
  the retired mandrel MCP `context.hydrate` tool.
allowed_tools:
  - Read
  - Bash
---

# hydrate-context

## Policy Capsule

- Invoke via `node .agents/scripts/hydrate-context.js --ticket <id> [--epic <id>]`; the wrapping CLI is the only supported entry point and delegates to `lib/orchestration/context-hydration-engine.js`.
- Treat the operation as strictly **read-only on GitHub** — never modify ticket bodies, never post comments, never apply labels.
- When `--epic` is omitted, parse the Epic ID from the ticket body's `Epic: #N` line; do not infer it from elsewhere.
- Surface `persona::*` and `skill::*` labels from the ticket into the composed prompt so the downstream executor can pin its sub-agent dispatch.
- Emit exactly one JSON object on stdout (`{ "prompt": "..." }` by default, or `{ "envelope": {...} }` with `--emit envelope`) and nothing else — no temp files, no diagnostic prints that would corrupt the envelope.
- Honour the engine's context-budget cap via section-aware elision (`elideEnvelope`): lower-priority sections drop or summarize before higher-priority ones. Never silently truncate mid-string.
- Do not persist the composed prompt to disk; forwarding is the caller's responsibility.

## Role

Context aggregator. Resolves a ticket's hierarchy (Story → Epic)
and stitches the Epic body — the single planning document, carrying the
folded Tech Spec sections — plus the Story body into a
single prompt the executor consumes. The Epic body is embedded with its
`## Acceptance Table` managed section stripped (close-time reconciliation
detail the executor does not need); there is no separate Tech Spec fetch
(Story #4324).

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

The engine assembles a typed **ContextEnvelope** (`lib/orchestration/context-envelope.js`) and serializes it for consumers:

| Field | Role |
| --- | --- |
| `schemaVersion` | Always `"1"` for the current contract. |
| `task` | `{ id, title, persona?, skills?, protocolVersion? }` from the ticket and labels. |
| `sections[]` | Named blocks (`protocolPolicy`, `persona`, `skillCapsules`, `hierarchy`, `acceptanceCriteria`, `verificationCommands`, `taskInstructions`) each with `priority`, `elideWhenOverBudget` (`drop` \| `summarize`), `content`, `estimatedTokens`, optional `source`. |
| `provenance[]` | Ticket snapshots: `{ id, version, hash, retrievedAt }` so auditors can cite what was fetched. |
| `budget` | `{ maxTokens, used, elided[] }` after `elideEnvelope` runs. |
| `warnings[]` | Non-fatal hydration notices (missing files, skipped skills, etc.). |

Default CLI stdout (backward-compatible wrapper):

```json
{ "prompt": "..." }
```

`prompt` is `envelopeToPrompt(envelope)` — sections joined in `SECTION_RENDER_ORDER`, not elision priority. For inspection or downstream tools that consume the typed shape:

```bash
node .agents/scripts/hydrate-context.js --ticket <id> --emit envelope
```

```json
{ "envelope": { "schemaVersion": "1", "task": { ... }, "sections": [ ... ], "provenance": [ ... ], "budget": { ... }, "warnings": [ ... ] } }
```

The Skill writes nothing else — no GitHub comments, no temp files.
Idempotence is trivial because the operation is read-only.

## Procedure

```bash
node .agents/scripts/hydrate-context.js --ticket <id> [--epic <id>]
```

Delegates to `hydrateContext` from
`lib/orchestration/context-hydration-engine.js`. The engine handles
provider I/O, body parsing, provenance stamping, and
`elideEnvelope` when `budget.used` exceeds `limits.maxTokenBudget`.

**Section-aware elision.** Each section carries a numeric `priority`
(lower drops first) and an `elideWhenOverBudget` policy (`drop` removes
the section; `summarize` keeps a head excerpt). Defaults live in
`DEFAULT_SECTION_PRIORITIES` and `DEFAULT_ELIDE_POLICIES` in
`context-envelope.js`. Elided section names are recorded in
`budget.elided`.

**Capsule-only skill loading.** Activated skills resolve through
`skills.index.json` and `loadSkillCapsule`, emitting only the Policy
Capsule (the skill's non-negotiables) plus a pointer instruction into the
`skillCapsules` section. Full `SKILL.md` bodies are never inlined into a
task prompt — the sub-agent reads the full playbook on demand via the
rendered `Read <path>` pointer. The full-body injection path, the
`fullSkillBodies` config flag, and the `skill::full` label were removed in
a hard cutover (Story #3863); the only residual full-body emission is the
defensive fallback when a `SKILL.md` is missing its capsule marker (a
malformed manifest), which also logs a warning.

## Constraints

- Do **not** modify ticket bodies or post comments. The Skill is
  strictly read-only on GitHub.
- Do **not** persist the composed prompt to disk. The caller is
  responsible for forwarding the stdout envelope to its consumer.
- Do **not** bypass the context-budget cap — honour `elideEnvelope`
  and the per-section policies; never silently truncate.
