---
description: >-
  Helper procedure — reconcile the project's .agentrc.json against the
  framework schema (.agents/schemas/agentrc.schema.json) by validating it and
  surfacing redundant keys (project values that already match framework
  defaults). The runtime layers defaults at read time, so the helper never
  auto-fills optional keys from the template. Invoked by reference from
  /mandrel-update.
---

# mandrel-sync-config (helper)

> **Not a slash command.** Lives under `.agents/workflows/helpers/` so it is
> not projected into the mandrel plugin command tree. Invoked by reference from
> [`/mandrel-update`](../mandrel-update.md) after a framework update; previously
> shipped as the standalone `/agents-sync-config` command (later demoted to a
> helper, then renamed alongside `/mandrel-update`). The reconciliation runs as part of the
> `mandrel update` upgrade path (bump → sync → migrate → doctor).
>
> **Configuration reference.** The full set of configurable keys, defaults,
> and required-vs-optional flags lives in
> [`docs/configuration.md`](../../docs/configuration.md). This helper only
> documents the reconciliation procedure.

## Overview

Story #1995 replaced the previous template-merge behaviour with a
**default-aware** reconciliation: the helper never adds optional keys to the
project config, because the runtime already layers framework defaults
underneath the project's values at read time. The only thing the helper
writes today is a structured report. The mechanical work is delegated to
[`.agents/scripts/sync-agentrc.js`](../../scripts/sync-agentrc.js).

The reconciliation rules:

| Scenario                                                  | Behavior                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Project value validates against schema                    | **Preserve** unconditionally                                                            |
| Project value fails validation                            | **Abort** with a list of validation errors                                              |
| Required key missing in project                           | **Abort via validator** — the schema catches it; the helper does not auto-fill         |
| Optional key missing in project                           | **Leave absent** — the runtime resolves the framework default at read time              |
| Project value deep-equals framework default               | **Emit `[REDUNDANT]` advisory** (informational only — the file is never modified)       |
| Identity placeholder paths (`github.owner` / `repo` / …)  | **Never flagged** — they carry no usable framework default                              |

The defaults source of truth is
[`.agents/docs/agentrc-reference.json`](../../docs/agentrc-reference.json), consulted via
[`getAgentrcDefaults()`](../../scripts/lib/config/defaults.js). A parity test
keeps that file aligned with the schema and the runtime accessors so the
"what counts as default" question has exactly one answer.

> **Why no auto-fill?** The runtime's `*_DEFAULTS` constants under
> `.agents/scripts/lib/config/*.js` already layer framework defaults
> underneath an absent project key — see
> [`config-resolver.js`](../../scripts/lib/config-resolver.js)'s
> `applyDefaults`. Writing those defaults into `.agentrc.json` only bloats
> the consumer repo's config diff without changing runtime behaviour.
>
> **Persona**: `devops-engineer` · **Skills**: `core/ci-cd-and-automation`,
> `core/documentation-and-adrs`

## Procedure

Run from the consumer repo root:

```bash
node .agents/scripts/sync-agentrc.js
```

The script:

1. Reads `.agentrc.json` from the working directory (`--cwd <path>` to
   override). When the file is missing, prints an error asking the
   operator to run `mandrel init` (new project) or
   `node .agents/scripts/bootstrap.js` (existing project) and exits 1.
2. Validates the parsed config against the framework AJV schema
   (`getAgentrcValidator()`). On any failure, prints a single-line error
   list and exits 1 — the operator must fix the typo / missing required
   key before re-running.
3. Walks every default leaf path. For each path where the project
   carries a value deep-equal to the framework default, prints a
   `[REDUNDANT]` advisory row. Advisories are informational — the
   project file is never modified.
4. Prints the summary line and exits 0.

### Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Config is valid (advisories may still appear)                                 |
| 1    | Config is missing, malformed JSON, or fails schema validation                 |

### Flags

| Flag           | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `--cwd <path>` | Project root (defaults to `process.cwd()`)                         |
| `--quiet`      | Suppress the per-key advisory rows (keep only the summary line)    |

## Sample output

```text
[sync-agentrc] ✅ No changes required.
[sync-agentrc] Advisories: 4 project key(s) match framework defaults — informational only.
  [REDUNDANT] project.paths.agentRoot = ".agents"
  [REDUNDANT] project.paths.docsRoot = "docs"
  [REDUNDANT] project.paths.tempRoot = "temp"
  [REDUNDANT] project.baseBranch = "main"
[sync-agentrc] Redundant keys are safe to delete — the runtime layers framework defaults at read time.
```

A clean config (or one whose every diverging value is intentional) prints
only the first line.

## Pruning redundant keys

The helper deliberately does **not** auto-strip redundant keys. Operators
who want a leaner `.agentrc.json` can delete the flagged paths by hand and
commit the diff alongside the framework bump. Runtime behaviour is
unchanged either way — the default layering happens in
[`config-resolver.js`](../../scripts/lib/config-resolver.js) at read time.

## Constraints

- **Never modifies `.agentrc.json`.** The helper is read-only today.
- **Never invents values.** When validation fails, the operator fixes the
  config; the helper does not auto-patch.
- **Never silently strips.** A project key that fails validation aborts the
  run with a diagnostic; a project key that validates is preserved
  unconditionally.
- **Idempotent.** Running the helper twice produces identical output.
- **Do not auto-commit.** Operator owns the review/commit decision.
