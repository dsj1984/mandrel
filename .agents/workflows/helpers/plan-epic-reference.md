---
description: >-
  Reference companion to plan-epic.md — the recovery procedures, --resume
  mechanics, troubleshooting, and background rationale blocks moved out of the
  runtime core so every /plan run ingests only the step flow. Read on demand
  from the trigger-point pointers in plan-epic.md.
caller: plan-epic.md
---

# helpers/plan-epic-reference — Epic-planning reference & recovery

> **Not a slash command.** This file lives in `helpers/` and is a
> path-included reference module (not projected into the plugin command
> tree). [`plan-epic.md`](plan-epic.md) is the runtime core — the 3-step
> flow, commands, and gate contracts. This file holds the secondary material
> a run needs only when it hits an edge (a recovery path, a troubleshooting
> symptom) or wants the design rationale behind a persist guard.

## Persist guards — background rationale

The persist step's core carries only the commands and the ordered gate list.
The design rationale for its guards and managed sections lives here.

### Epic-lease preflight (workflow guard)

Before any mutation, `plan-persist.js` acquires the Epic-lease via the
assignee-as-lease primitive (`lib/orchestration/ticket-lease.js`). The lease
rides the Epic's single assignee: the operator (`github.operatorHandle` in
`.agentrc.json`) claims the Epic for the duration of the persist. The guard
**fails closed**: `/plan` emits no `story.heartbeat` during its run, so any
**foreign assignee** is treated as a live claim — the persist exits non-zero
and names the current owner, so two `/plan` runs cannot drive the same Epic
concurrently. Pass **`--steal`** to forcibly transfer a foreign claim once
you have confirmed the other run is dead. An **unassigned** Epic, or one
**already held by this operator**, is taken (or re-affirmed) silently. The
lease is released on every exit path — success, gate failure, and throw
alike.

### Idempotent managed sections

The persist is section-scoped and keyed on the Epic body: a re-run that
finds the requested sections already present
(`<!-- mandrel:tech-spec:start/end -->` /
`<!-- mandrel:acceptance-table:start/end -->`) short-circuits as
`already-planned` instead of duplicating content. Pass `--force` to
overwrite the managed sections in place (same Epic issue, refreshed section
bodies, one regeneration audit comment).

### One planning document

A `/plan` Epic run creates exactly **one** issue — the Epic. The planning
artifacts land as marker-delimited managed sections of the Epic body: the
Tech Spec (opening with `## Delivery Slicing`) inside
`<!-- mandrel:tech-spec:start/end -->`, and the Acceptance Spec's AC-ID
table (headed `## Acceptance Table`) inside
`<!-- mandrel:acceptance-table:start/end -->`. The `## Acceptance Table`
section captures the stable-ID acceptance criteria table
(`| AC ID | Outcome | Feature File | Scenario | Disposition |`) that drives
close-time reconciliation during `/deliver`. Operators may opt out for
refactor-only or docs-only Epics by applying the `acceptance::n-a` label to
the Epic — the authoring skill then skips the Acceptance Table and the
runtime gates honour the waiver. See
[SDLC § Acceptance Table — the second folded planning section](../../docs/SDLC.md#acceptance-table--the-second-folded-planning-section)
for the full lifecycle.

### Parallel-safe file naming (per-Epic tree)

Multiple Epics may be planned concurrently. Every temp file written in the
workflow lives under the per-Epic tree (`temp/epic-[Epic_ID]/<artifact>`) —
e.g. `temp/epic-[Epic_ID]/plan-context.json`,
`temp/epic-[Epic_ID]/techspec.md`, `temp/epic-[Epic_ID]/tickets.json`. The
directory namespace is the isolation boundary; basenames inside it are
stable. (The ideation entry, which has no Epic id yet, namespaces under
`temp/plan-ideation/<slug>/` instead.) Do **not** reuse bare flat names like
`temp/techspec.md`.

**Durability.** The per-Epic tree is durable across runs: `plan-persist.js`
cleans its temp files **only at terminal success**
([`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js)), so
a failed persist leaves every authored artifact in place for `--force` /
`--resume` reuse. Nothing else garbage-collects the tree.

## Persist — `--resume` recovery (secondary rate limit)

**Secondary rate limit on large Epics.** For backlogs over ~60 tickets,
GitHub's secondary rate limit (HTTP 403, body contains "secondary rate
limit") can trip mid-persist after ~80 issue creations. The http-client
retries automatically with a 30–120s backoff. If the run still aborts
(network drop, exhausted retries, etc.), resume from the partial backlog
with:

```bash
node .agents/scripts/plan-persist.js --epic [Epic_ID] --resume
```

`--resume` is idempotent: the managed sections short-circuit
`already-planned`, and the reconciler recovers the slug→issue map from its
per-slug state ledger (`temp/epic-[Epic_ID]/[Epic_ID].state.json`) —
reseeding from live GitHub state when the file is missing — so only the
genuinely-missing children are created; the existing tree is never
duplicated.

## Measurement — the G2 acceptance gate (Epic #4474)

The 3-step collapse is **measured, not asserted**. The acceptance bar the
next benchmark cohort reads as the gate:

- **Turns-per-plan ≤ ~15** at the epic rung (from the 55–72-turn 12-phase
  baseline). The turns proxy is the plan-metrics invocation ledger
  (`temp/epic-<id>/plan-metrics.json`) plus the host session's turn
  accounting — ledger records count CLI invocations from the parent
  session's perspective, not sub-agent turns.
- **Plan tokens ≤ ~1.5M** at the epic rung (from 7.3–8.9M) — owned by the
  host's session accounting (mandrel-bench `modelUsage`), not by any
  in-repo counter.
- **Unchanged validator coverage** — every deterministic gate of the
  retired pipeline still fires on the persist path: section gate, ticket
  validator, file-assumption, DAG, budget, draft reachability, inline
  healthcheck, mode-coherence. The enumerated receipt is
  `tests/contract/planning/plan-persist-validator-coverage.test.js`.

Where to read the measurement:

- The `plan-summary` structured comment on the Epic carries the
  plan-metrics roll-up line (invocations, per-CLI counts, span, critic
  skips) — no runner-disk access needed.
- `node .agents/scripts/analyze-execution.js --epic <id> --plan-metrics-json`
  prints the compact machine-readable envelope
  (`{ epicId, planMetrics, summaryLine }`) — local read-only, stdout-pure.

## Troubleshooting

- If `plan-context.js` fails, confirm the Epic exists and has a body with
  enough initial context (epic mode), or that the one-pager file is
  non-empty (ideation mode).
- If `plan-persist.js` rejects the tickets file, re-read the validator's
  error message — the most common causes are a ticket whose `type` is not
  `story`, a Story missing its inline `acceptance[]` / `verify[]` contract,
  a file-assumption declaration that contradicts the base branch, or a
  dependency cycle in the Story `depends_on` graph.
- If `plan-persist.js` refuses with a mode-coherence error, the risk
  verdict's `deliveryShape` contradicts the tickets payload — a `"single"`
  verdict with a `tickets.json` on disk (delete or re-shape it), or a
  fan-out verdict with no tickets authored.
- If the persist completed but the Epic is not on `agent::ready`, the
  inline healthcheck refused the flip — read the failing check's `reason`
  in the persist output, resolve it (or apply
  `planning::healthcheck-waived` for a triaged environmental failure), and
  re-run the persist.
