# Workflow authoring guide

This directory is the **single source of truth** for the slash-command
surface exposed by Claude Code in this repo. Each top-level `.md` file is
synced into `.claude/commands/<name>.md` by
[`sync-claude-commands.js`](../scripts/sync-claude-commands.js). Files
under `helpers/` are **not** synced — they are path-included modules that
parent workflows read by relative path (see `task-execute.md` referenced
from `story-execute.md` for the canonical example).

If you are looking for an end-user reference for an individual workflow,
read the workflow file itself — every workflow is a self-contained
contract. This README documents conventions that span workflows.

## Frontmatter

Every workflow begins with a YAML-ish frontmatter block delimited by
`---` lines. The parser in
[`lib/audit-suite/frontmatter.js`](../scripts/lib/audit-suite/frontmatter.js)
reads it as a flat key/value map; nested structures are not supported.

```yaml
---
description: <one-paragraph summary surfaced in the skill index>
recommendedModel: haiku | sonnet | opus   # optional
dispatchModel:    haiku | sonnet | opus   # optional
---
```

### `description` (recommended)

A one-paragraph summary that is surfaced in skill indexes and `/help`-style
listings. Keep it under ~280 characters; the audit-suite summary helpers
truncate after three sentences. Missing frontmatter falls back to the
file's first prose paragraph.

### Model hints

Two **optional** fields let a workflow author declare model intent without
forcing the harness to encode any per-task model logic. Both fields accept
exactly the three Anthropic model shortnames — `haiku`, `sonnet`, or
`opus`. Arbitrary strings are rejected by the frontmatter lint.

| Field | Read by | Effect |
| :--- | :--- | :--- |
| `recommendedModel` | Skill index, human readers | Advisory only. The harness never enforces it. Use it to signal "this workflow is reasoning-heavy" or "this workflow is mechanical" to operators reading the index. |
| `dispatchModel` | The workflow's own body, when it fans out via the `Agent` tool | When the dispatching workflow emits `Agent` calls, the value is passed as the `model:` argument on each call. |

Both fields are optional. A workflow with neither field set behaves
**exactly** as today — no `model:` argument is emitted on the `Agent`
calls it dispatches, and the call inherits the parent agent's model.

#### Precedence

When more than one source declares a model for a given `Agent` call, the
precedence is authoritative:

1. **Per-call body literal.** A `model: <hint>` literal written into a
   specific `Agent` call in the workflow body wins. Use this when one
   leg of a fan-out needs a different model than the rest.
2. **Workflow `dispatchModel`.** The dispatching workflow's frontmatter
   value applies to every `Agent` call the workflow emits that does not
   have its own per-call override.
3. **Inherit from parent.** When neither of the above is set, no
   `model:` argument is emitted. The `Agent` tool resolves the model
   from the sub-agent definition's frontmatter (if `subagent_type` is
   set) and ultimately from the parent agent. This is today's
   behaviour, preserved by default.

#### Unset preserves current behaviour

Workflows that declare nothing keep today's runtime exactly. This is the
hedge against future model improvements: when Anthropic ships a new model
(Sonnet 5, faster Haiku, new Opus), unset workflows pick it up
automatically without a sweep of edits or a central registry update.

#### Workflow frontmatter vs. sub-agent definition frontmatter

The Claude Code `Agent` tool reads `model` from **two** distinct places,
and this README's `dispatchModel` is a **third** surface. Authors who
conflate them will be surprised:

- **Sub-agent definition frontmatter.** Files under `.claude/agents/`
  (when present) carry their own frontmatter. The `Agent` tool resolves
  `model` from the definition's frontmatter when `subagent_type` is set.
- **`Agent`-call `model:` argument.** A literal `model:` written into a
  specific `Agent` invocation. Wins over the definition frontmatter.
- **Workflow `dispatchModel` (this convention).** Read by the workflow's
  **own** body, applied as the `model:` argument on every `Agent` call
  the workflow emits.

Putting `model:` on a *workflow's* frontmatter does **not** flip the
workflow's own runtime model — workflows run inside the parent agent's
loop, not as a separate sub-agent. The workflow frontmatter only affects
the `Agent` calls the workflow makes outward. To flip the running model
of a sub-agent, edit the sub-agent definition (or pass `model:` on the
`Agent` call that spawns it). To declare what model a workflow's
fan-out should use, set `dispatchModel`.

## Helpers vs. top-level workflows

- **Top-level `.md` files** are synced to `.claude/commands/<name>.md` and
  exposed as slash commands. Filenames double as the slash-command names.
- **`helpers/*.md`** are read inline by parent workflows via relative-path
  references (e.g. `helpers/task-execute.md` from `story-execute.md`).
  They are **not** exposed as slash commands. The sync script
  intentionally skips this directory.

## Where to start when adding a new workflow

1. Drop a new `.md` file at the top level of this directory.
2. Add a frontmatter block with at least `description`. Optionally
   declare `recommendedModel` and/or `dispatchModel` per the rules above.
3. Run `npm run sync:commands` to mirror the file into `.claude/commands/`.
4. If your workflow fans out parallel sub-agents and you want them to run
   on a specific model, set `dispatchModel` rather than repeating
   `model:` on every `Agent` call.
