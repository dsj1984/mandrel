---
description: >-
  Helper doc for the signals-view.js debug viewer. Renders the signals
  span-tree for an Epic (and optionally a single Story) to the terminal.
  Read-only over `lib/signals/` — no remote writes, no state mutation, no
  auto-fixes. Dumb-terminal-safe (`console.log` only). Not a slash command —
  invoke the script directly when needed.
---

# signals span-tree viewer (helper)

> **Helper, not a slash command.** Files under `workflows/helpers/` are not
> projected into the mandrel plugin command tree. The signals subsystem itself
> (`lib/signals/`, writer, schema, detectors, NDJSON listeners) runs as
> part of the normal `/deliver` machinery — this viewer is for
> ad-hoc debugging when you need to inspect the span-tree directly.
> Invoke the backing script: `node .agents/scripts/signals-view.js <epic-id> [--story <id>]`.

## Overview

`signals-view.js` is the operator-facing viewer for the consolidated
signals stream. It reads `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` via
[`lib/signals/read`](../../scripts/lib/signals/read.js), builds an
in-memory span-tree via
[`lib/signals/buildSpanTree`](../../scripts/lib/signals/span-tree.js), and
prints an Epic → Story → Task → events tree to stdout.

It is distinct from `diagnose-friction.js` (per-Task signal capture that
wraps a shell command) and from `diagnose.js` (read of the checks
registry). This viewer is purely a formatter over an iterator — no
GitHub I/O, no commit creation, no label transitions.

```text
node .agents/scripts/signals-view.js <epic-id> [--story <id>]
  → signals.read({ epic, story? })
  → buildSpanTree(asyncIterator)
  → console.log lines (Epic → Story → Task → events)
  → exit 0 (always; missing-file path prints a friendly message)
```

## Arguments

| Argument         | Required | Description                                                                                                                            |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `<epic-id>`      | yes      | Positive integer Epic ID. The viewer resolves `temp/epic-<id>/` under the configured `project.paths.tempRoot`.                  |
| `--story <id>`   | no       | Positive integer Story ID. When set, the printed tree is narrowed to a single Story subtree under the Epic.                            |

## Flags (test-only)

| Flag                  | Description                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--temp-root <path>`  | Override the resolved `tempRoot`. Reserved for fixture-driven tests (see `tests/signals-view.test.js`); production callers omit this flag.   |

## Exit codes

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | Happy path **or** missing signals file. The missing-file path prints a friendly message ("No signals found for Epic #N"), never a stack trace. |
| `1`  | Bad arguments (non-integer `<epic-id>`, missing positional, malformed `--story`).             |

## Examples

```bash
# Render every Story under Epic #1181.
node .agents/scripts/signals-view.js 1181

# Narrow to a single Story subtree.
node .agents/scripts/signals-view.js 1181 --story 1438

# No signals yet — friendly message, exit 0.
node .agents/scripts/signals-view.js 9999
# → No signals found for Epic #9999.
```

## Phase steps

1. Parse `<epic-id>` and optional `--story <id>` from the slash-command
   arguments. Reject non-integer or non-positive inputs with exit 1 and
   the canonical usage line.
2. Invoke `node .agents/scripts/signals-view.js <epic-id> [--story <id>]`
   from the operator's working directory. The script resolves
   `tempRoot` from the project's `.agentrc.json` (or the framework
   default `'temp'`).
3. Read the Story-tree output as the canonical surface — no further
   parsing is needed; the script's stdout is the deliverable.

## Constraints

- **Never** writes to GitHub state (no label transitions, no comments).
  The viewer is purely read-side.
- **Never** mutates the working tree, including `temp/`. The on-disk
  signals files are owned by `signals-writer.js`; this viewer only
  reads them.
- **Never** uses Ink, blessed, or terminal-control escape sequences.
  Output goes through `console.log` exclusively so the viewer works on
  Windows + bash hosts (see [`helpers/parallel-tooling.md`](parallel-tooling.md)).
- **Always** honours the configured `project.paths.tempRoot`.
  Earlier post-merge work leaked to the real repo root regardless of
  test sandbox `tempRoot` (project memory: `phase_timings_uses_project_root`) —
  this viewer reads via [`lib/config/temp-paths.js`](../../scripts/lib/config/temp-paths.js)
  so the sandbox path always wins.

## See also

- [`.agents/scripts/signals-view.js`](../../scripts/signals-view.js) — the
  CLI implementation backing this helper.
- [`.agents/scripts/lib/signals/`](../../scripts/lib/signals/) — the
  shared reader + schema + span-tree barrel.
- [`tests/signals-view.test.js`](../../../tests/signals-view.test.js) —
  pinned output and tempRoot-honour contracts.
- [`tests/lib/signals/span-tree.test.js`](../../../tests/lib/signals/span-tree.test.js) —
  pure-function contract for the span-tree builder.
