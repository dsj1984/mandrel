---
description: >-
  Helper procedure — reconcile the project's .agentrc.json against the
  framework schema (.agents/schemas/agentrc.schema.json) by validating the
  project config first, then merging in any missing keys the framework template
  has added. Preserves every project-side value that validates. Invoked by
  reference from /agents-update.
---

# agents-sync-config (helper)

> **Not a slash command.** Lives under `.agents/workflows/helpers/` so it is
> not synced into `.claude/commands/`. Invoked by reference from
> [`/agents-update`](../agents-update.md) after the submodule pointer moves;
> previously shipped as `/agents-sync-config`.
>
> **Configuration reference.** The full set of configurable keys, defaults,
> and required-vs-optional flags lives in
> [`docs/configuration.md`](../../../docs/configuration.md). This helper only
> documents the reconciliation procedure.

## Overview

This procedure performs a **schema-driven validate-then-merge** between the
project-local configuration (`.agentrc.json` at the repository root) and the
framework template (`.agents/default-agentrc.json`). The authoritative contract
is the schema (`.agents/schemas/agentrc.schema.json`, mirrored at runtime by the
AJV schemas in `.agents/scripts/lib/config-schema.js` /
`config-settings-schema.js`). Any project key that validates is preserved —
including optional keys the template does not declare.

This is a deliberate departure from the previous "structural diff against
template" behaviour, which silently stripped legitimate optional keys (e.g.
`orchestration.concurrency`, `storyMergeRetry`, `github.projectName`,
`agentSettings.quality.prGate`) on every sync.

The reconciliation rules are:

| Scenario                                                  | Behavior                                                |
| --------------------------------------------------------- | ------------------------------------------------------- |
| Project value validates against schema                    | **Preserve** unconditionally                            |
| Project value fails validation                            | **Abort** with a list of validation errors              |
| Required key missing in project                           | **Add** from template (or schema default if available)  |
| Optional key present in template, missing in project      | **Add** from template (operator opt-in to new defaults) |
| Optional key present in project, absent from template     | **Preserve** (schema-valid optional keys are not noise) |
| Object in both                                            | **Recurse** into nested keys with these same rules      |

> **Persona**: `devops-engineer` · **Skills**: `core/ci-cd-and-automation`,
> `core/documentation-and-adrs`

## Step 0 — Resolve File Paths

1. `[PROJECT_CONFIG]` → `.agentrc.json` at the repository root
2. `[TEMPLATE]` → `.agents/default-agentrc.json`
3. `[SCHEMA]` → `.agents/schemas/agentrc.schema.json`

If `[TEMPLATE]` or `[SCHEMA]` is missing, abort — the framework submodule is
not initialized correctly. If `[PROJECT_CONFIG]` is missing, create it by
copying `[TEMPLATE]` verbatim and skip to Step 4.

## Step 1 — Load Both Files

Parse `[PROJECT_CONFIG]` and `[TEMPLATE]` into memory. Preserve the top-level
key ordering of `[TEMPLATE]` as the canonical order for the output.

If either file fails to parse, abort and report the parse error with file path
and line number. Never attempt to silently "fix" malformed JSON.

## Step 2 — Validate the Project Config Against the Schema

Validate the loaded `[PROJECT_CONFIG]` against the runtime AJV validators
(which mirror `[SCHEMA]`):

- `getSettingsValidator()` from `.agents/scripts/lib/config-settings-schema.js`
  → applied to `agentSettings`.
- `getOrchestrationValidator()` from `.agents/scripts/lib/config-schema.js`
  → applied to `orchestration`.

If any validator returns errors:

1. Print a diagnostic block listing each error (`instancePath` + `message`).
2. **Abort** — do not silently strip the offending keys, do not write
   `[PROJECT_CONFIG]`, and do not proceed to Step 3. Operator must fix the
   project config (typo, wrong type, missing required key) and re-run.

The schema is authoritative. Keys absent from `[TEMPLATE]` but valid under the
schema (e.g. `orchestration.concurrency`, `agentSettings.quality.prGate`) pass
validation and survive untouched.

## Step 3 — Merge Missing Template Keys Into the Project Config

For every key the template defines that the project config does not, add it
using the template's value. Recurse into objects with the same rule — never
overwrite a key the project explicitly sets.

```text
mergeMissing(template, project):
  if template is an object AND project is an object:
    for each key K in template (preserve template's order):
      if K not in project:
        project[K] = deepCopy(template[K])      # add missing
      elif template[K] is an object AND project[K] is an object:
        mergeMissing(template[K], project[K])    # recurse
      # else: project value wins (already validated in Step 2)
    return project

  # arrays / scalars: project wins (validated in Step 2)
  return project
```

### Key semantics

- **Project values win for any key the project sets.** The merge only adds
  keys; it never replaces a project value with a template value.
- **Arrays are opaque, project-owned.** The merge does not append-merge array
  elements. Operators who want new defaults from the template must edit those
  arrays (`docsContextFiles`, `release.docs`, `planning.riskHeuristics`, etc.)
  manually.
- **Optional keys absent from the template are preserved.** Unlike the
  previous template-diff behaviour, the project may carry schema-valid keys
  (like `orchestration.concurrency` or `agentSettings.quality.prGate`) that the
  template never declares — they pass validation in Step 2 and survive merge
  in Step 3 because the project sets them.
- **`$schema` and top-level metadata** (`title`) follow the same rule as any
  other key: project wins if present, template fills in if absent.

## Step 4 — Build the Change Report

Collect a structured change log of every key the merge added:

```text
[ADDED]    <dot.path.to.field>           <value-preview>
[MOVED]    <dot.path.to.field>           <reason — only if a future story introduces a key relocation>
```

- Truncate value previews to 80 characters.
- Group the report by operation (`ADDED` first; later operations as the
  framework introduces them).
- If no keys were added, emit a single `No changes required` line and skip
  Step 5.

There is no `REMOVED` category. The previous procedure removed any project
key absent from the template; the schema-driven procedure never strips. If
the framework genuinely retires a key (i.e. the schema starts rejecting it),
Step 2 catches that as a validation error and the operator handles the
removal manually.

## Step 5 — Write the Reconciled Config

1. Serialize the merged object to JSON with **2-space indentation** and a
   trailing newline (matches the existing file's formatting).
2. Overwrite `[PROJECT_CONFIG]` atomically (write to a temp file in the same
   directory, then rename) so a crash mid-write cannot corrupt the config.
3. Re-parse the written file to confirm it is valid JSON.
4. Re-run Step 2's validators against the written file as a final
   self-check; abort and restore the prior version if validation now fails
   (this should be impossible — defensive guard against a buggy merge).

## Step 6 — Emit the Summary

Print the change report from Step 4 to stdout. Do **not** auto-commit the
change — the operator must review the diff first. Suggest the review command:

```powershell
git diff .agentrc.json
```

## Constraints

- **Never modify `[TEMPLATE]` or `[SCHEMA]`.** Both are read-only; the source
  of truth is the framework submodule.
- **Never invent values.** If a key is added from the template, use the
  template's exact value — do not substitute project-specific guesses (e.g.
  do not rewrite `[OWNER]` placeholders to the detected git remote).
- **Never silently strip.** A project key that fails validation aborts the
  run with a diagnostic; a project key that validates is preserved
  unconditionally even when absent from the template.
- **Idempotent.** Running this procedure twice back-to-back must produce no
  changes on the second run.
- **No partial writes.** If any step fails, leave `[PROJECT_CONFIG]`
  untouched.
- **Do not auto-commit.** The operator is responsible for reviewing the diff
  and committing.
