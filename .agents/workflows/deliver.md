---
description:
  Unified delivery entry point. Inspects the ticket type(s) and
  Epic-reference state of the supplied IDs, then routes to the Epic wave
  loop or the standalone multi-Story fan-out — preserving every flag and
  the parallel-delivery contract of the retired commands.
---

# /deliver [Epic ID] | [Story IDs...]

## Role

Router. `/deliver` owns input classification and path selection only — all
phase content lives in the two path helpers:

- [`helpers/deliver-epic.md`](helpers/deliver-epic.md) — the full Epic
  delivery loop (preflight, wave loop fanning out
  [`helpers/epic-deliver-story`](helpers/epic-deliver-story.md),
  close-validation, epic-audit, code-review, retro, finalize, watch,
  auto-merge gate, cleanup).
- [`helpers/deliver-stories.md`](helpers/deliver-stories.md) — the
  standalone multi-Story path (`stories-wave-tick.js` wave plan, operator
  confirmation, parallel fan-out to
  [`helpers/single-story-deliver`](helpers/single-story-deliver.md)).

## Input matrix (authoritative)

Fetch each supplied ID's labels and body (`type::*` label, `Epic: #N`
reference) before routing:

| Input | Route |
| --- | --- |
| Exactly one `type::epic` ID | **Epic path** — run [`helpers/deliver-epic.md`](helpers/deliver-epic.md) Phases 1–9 unchanged. |
| One or more `type::story` IDs, none carrying an `Epic: #N` reference | **Standalone path** — run [`helpers/deliver-stories.md`](helpers/deliver-stories.md) Phases 0–3. |
| Any Story carrying an `Epic: #N` reference | **Error**, naming the fix: `Story #<id> belongs to Epic #<n> — run /deliver <n>`. |
| Mixed Epic + Story IDs, or more than one Epic | **Error**: separate invocations — one `/deliver <epicId>` per Epic, one `/deliver <id> [<id>...]` for the standalone set. |

## Flags (forwarded per path)

| Path | Flags |
| --- | --- |
| Epic | `--skip-epic-audit`, `--skip-code-review`, `--skip-retro`, `--full-retro`, `--steal`, `--as <handle>` |
| Story | `--dep <from>:<to>`, `--yes`, `--concurrency <n>` |

A flag passed to the wrong path is reported once as a no-op warning and
ignored — never an error.

**Multi-Story parallel contract (preserved verbatim).**

```text
/deliver <id> <id> … --dep <from>:<to> --concurrency <n> --yes
```

behaves exactly as the retired multi-Story command did: the same
`stories-wave-tick.js` wave plan, the same operator confirmation gate
(suppressed by `--yes`), and the same parallel fan-out — one Agent call per
Story per wave, capped by the resolved `concurrencyCap` — to
[`helpers/single-story-deliver`](helpers/single-story-deliver.md).

## Procedure

1. **Parse args.** At least one positive-integer ID is required.
2. **Classify.** Fetch each ticket's labels + body and apply the input
   matrix above. Refuse ambiguous input with the matrix's error messages —
   never guess a route.
3. **Delegate.** Read the selected path helper **in full** and execute it
   from its entry phase, forwarding the absorbed flags. The helper's phase
   numbering, watchdogs, gates, and scripts are unchanged — this router
   adds no phase content.

## Constraints

- `/deliver` requires a planned ticket: an Epic at `agent::ready` (the
  Epic helper's preflight enforces this) or well-formed standalone Stories.
  Planning happens in [`/plan`](plan.md); the plan-review gate between the
  two commands is a hard boundary.
- The router performs no git or label mutations itself; the path helpers
  own every script invocation.

## See also

- [`/plan`](plan.md) — the unified planning entry point.
- [`helpers/deliver-epic.md`](helpers/deliver-epic.md) /
  [`helpers/deliver-stories.md`](helpers/deliver-stories.md) — the path
  helpers.
