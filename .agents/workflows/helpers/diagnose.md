---
description: >-
  Helper doc for the diagnose.js ad-hoc viewer. Runs the self-healing checks
  registry in read-only mode and prints findings. Not a slash command —
  invoke the script directly when needed.
---

# diagnose viewer (helper)

> **Helper, not a slash command.** Files under `workflows/helpers/` are not
> projected into the mandrel plugin command tree. The same `lib/checks/` registry runs
> automatically as preflight inside `/deliver`, `single-story-close`, and
> `npm test` — this viewer exists only for ad-hoc inspection. Invoke the
> backing script directly: `node .agents/scripts/diagnose.js [args]`.

## Overview

`diagnose.js` runs the checks registry assembled under
`.agents/scripts/lib/checks/` in read-only mode and surfaces every
finding declared on the requested scope. It is the operator-facing read
of the same registry that preflight guards (`/deliver`,
`single-story-close`), the retro hook, and `npm test` consult — but with
`autoFix: false` always, no remote GitHub writes, and no commits.

It is distinct from `diagnose-friction.js` (the per-Task signal capture
that wraps a shell command); this viewer is a stateless probe.

```text
node .agents/scripts/diagnose.js [--scope <scope>] [--fail-on-blocker] [--json]
  → assembleState({ scope })
  → runChecks({ scope, autoFix: false, state })
  → render table (default) OR single-line JSON (--json)
  → exit 0 (or 2 with --fail-on-blocker when a blocker is present)
```

## Flags

| Flag                 | Default      | Description                                                                                                                                                                                                          |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope <s>`        | `diagnose`   | Filter checks by declared scope. Use `all` to disable the filter and run every registered check. Other surface scopes (`deliver`, `single-story-close`, `retro`) are accepted verbatim — checks whose `scope[]` includes the value will fire. |
| `--fail-on-blocker`  | off          | Exit `2` when at least one finding has `severity === 'blocker'`. Without this flag the command always exits `0` even when blockers are present (it is by default an advisory read).                              |
| `--json`             | off          | Emit a single line of JSON shaped as `{ scope, findings: [...] }` to stdout in place of the human table. Findings preserve the registry's `Finding` shape (id, severity, scope, summary, fixCommand, detail?, autoCorrectable). |

## Exit codes

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | No blockers, OR `--fail-on-blocker` was not set. The default "advisory read" exit.            |
| `2`  | `--fail-on-blocker` was set AND at least one finding has `severity === 'blocker'`.            |
| `1`  | Internal error (registry load failure, bad flag, etc.). A missing check directory is NOT an error — it returns an empty findings set with exit `0`. |

## Examples

```bash
# Default advisory read against the `diagnose` scope.
node .agents/scripts/diagnose.js

# Run every registered check and emit JSON for downstream consumers.
node .agents/scripts/diagnose.js --scope all --json

# Use inside a preflight script that should block on a blocker.
node .agents/scripts/diagnose.js --scope single-story-close --fail-on-blocker
```

## Output shape

### Table (default)

A fixed-width plain-text table with five columns: `id`, `severity`,
`scope`, `summary`, `fix command`. The empty case still prints the header
plus a `(no findings)` marker so the output shape is stable across clean
and dirty states.

### JSON (`--json`)

Exactly one line. Schema:

```json
{
  "scope": "diagnose",
  "findings": [
    {
      "id": "stale-origin-main",
      "severity": "blocker",
      "scope": "single-story-close",
      "summary": "Local main is behind origin/main",
      "detail": "Fast-forward main before re-running single-story-close.",
      "fixCommand": "git fetch origin main; git merge --ff-only origin/main",
      "autoCorrectable": false
    }
  ]
}
```

The `findings` array is empty when no check fires on the requested scope.
Downstream consumers can rely on the single-line contract for `jq`
pipelines and CI-step parsing.

## Constraints

- **Never** auto-fixes. `diagnose.js` calls
  `runChecks({ autoFix: false })` unconditionally; even checks with
  `autoCorrect: 'auto'` print their `fixCommand` rather than execute it.
- **Never** writes to GitHub state (no label transitions, no comments).
  The registry's `refuse-and-print` and retro read-only invariants are
  preserved.
- **Never** mutates the working tree. State assembly is read-only
  (`existsSync`, `git rev-parse`, `process.env` presence checks).

## See also

- [`.agents/README.md` § Self-Healing Checks](../../README.md#self-healing-checks)
  — the canonical contract every check module must satisfy.
- [`.agents/scripts/diagnose.js`](../../scripts/diagnose.js) — the CLI
  implementation backing this helper.
- [`tests/diagnose-output.test.js`](../../../tests/diagnose-output.test.js)
  — pinned output and exit-code contracts.
