---
description: >-
  Reference companion to plan-epic.md — the recovery procedures, --resume
  mechanics, troubleshooting, and background rationale blocks moved out of the
  runtime core so every /plan run ingests only the phase flow. Read on demand
  from the trigger-point pointers in plan-epic.md.
caller: plan-epic.md
---

# helpers/plan-epic-reference — Epic-planning reference & recovery

> **Not a slash command.** This file lives in `helpers/` and is a
> path-included reference module (not projected into the plugin command
> tree). [`plan-epic.md`](plan-epic.md) is the runtime core — the phase
> flow, commands, and gate contracts. This file holds the secondary
> material a run needs only when it hits an edge (a recovery path, a
> troubleshooting symptom) or wants the design rationale behind a phase.
> Each section below is reached from a one-line pointer at its trigger
> point in the core.

## Phase 7 — background rationale

The Phase 7 (Tech Spec & Acceptance Spec) core carries only the commands and
the gate contract. The design rationale for the phase's guards and managed
sections lives here.

### Epic-lease preflight (workflow guard)

Before any Phase 7 mutation, `epic-plan-spec.js` acquires the Epic-lease via
the assignee-as-lease primitive (`lib/orchestration/ticket-lease.js`, wired
through `lib/orchestration/epic-plan-lease-guard.js`). The lease rides the
Epic's single assignee: the operator (`github.operatorHandle` in
`.agentrc.json`) claims the Epic for the duration of the plan. The guard
**fails closed**: `/plan` emits no `story.heartbeat` during its run
(heartbeats are a delivery-time signal), so there is no live-heartbeat source
to judge a concurrent plan's liveness from. Any **foreign assignee** is
therefore treated as a live claim — the persist half **exits non-zero and
names the current owner**, so two `/plan` runs cannot drive the same Epic
concurrently. Pass **`--steal`** to forcibly transfer a foreign claim once you
have confirmed the other run is dead. An **unassigned** Epic, or one **already
held by this operator**, is taken (or re-affirmed) silently. The lease is
**released after Phase 8** (decompose) completes.

### Idempotent managed sections

The persist half is section-scoped and keyed on the Epic body: a re-run that
finds the requested sections already present
(`<!-- mandrel:tech-spec:start/end -->` /
`<!-- mandrel:acceptance-table:start/end -->`) short-circuits as
`already-planned` instead of duplicating content. Pass `--force` to overwrite
the managed sections in place (same Epic issue, refreshed section bodies).

### One planning document

A `/plan` Epic run creates exactly **one** issue — the Epic. The planning
artifacts land as marker-delimited managed sections of the Epic body: the Tech
Spec (opening with `## Delivery Slicing`) inside
`<!-- mandrel:tech-spec:start/end -->`, and the Acceptance Spec's AC-ID table
(headed `## Acceptance Table`) inside
`<!-- mandrel:acceptance-table:start/end -->`. The PRD artifact class was
retired (Story #4314) — its one novel section, **User Stories**, lives inline
in the Epic body as a `## User Stories` section — and Story #4324 retired the
`context::tech-spec` / `context::acceptance-spec` ticket classes the same way.
The `## Acceptance Table` section captures the stable-ID acceptance criteria
table (`| AC ID | Outcome | Feature File | Scenario | Disposition |`) that
drives close-time reconciliation during `/deliver` Phase 6. Operators may opt
out for refactor-only or docs-only Epics by applying the `acceptance::n-a`
label to the Epic ticket — when present, the `epic-plan-spec-author` skill
skips the Acceptance Table output and the runtime gates (start gate, finalize
reconciler) honour the waiver — the section need not be authored when the
waiver is set. See [SDLC § Acceptance Table — the second folded planning
section](../../docs/SDLC.md#acceptance-table--the-second-folded-planning-section)
for the full lifecycle.

### Parallel-safe file naming (per-Epic tree)

Multiple Epics may be planned or decomposed concurrently. Every temp file
written in the workflow lives under the per-Epic tree
(`temp/epic-[Epic_ID]/<artifact>`) — e.g.
`temp/epic-[Epic_ID]/planner-context.json`,
`temp/epic-[Epic_ID]/techspec.md`,
`temp/epic-[Epic_ID]/decomposer-context.json`,
`temp/epic-[Epic_ID]/tickets.json`. The directory namespace is the isolation
boundary; basenames inside it are stable. Do **not** reuse bare flat names
like `temp/techspec.md` or the legacy `temp/<artifact>-epic-<id>.<ext>` shape
— both have been retired.

**Durability.** The per-Epic tree is durable across runs: only the wrapper
scripts perform intra-phase cleanup of files they wrote in the same invocation
(see [`lib/plan-phase-cleanup.js`](../../scripts/lib/plan-phase-cleanup.js)).
Nothing else garbage-collects the tree, so cross-Epic artifacts — retros, perf
reports, signals, manifests — accumulate until an operator explicitly removes
them.

## Phase 8 — `--resume` recovery (secondary rate limit)

The Phase 8 (Work Breakdown Decomposition) core carries the normal-path and
`--force` persist commands. The `--resume` recovery path — reached when a
large decomposition aborts mid-persist — lives here.

**Secondary rate limit on large Epics.** For backlogs over ~60 tickets,
GitHub's secondary rate limit (HTTP 403, body contains "secondary rate limit")
can trip mid-decomposition after ~80 issue creations. The http-client retries
automatically with a 30–120s backoff and the decomposer drops `concurrencyCap`
to 1 for the rest of the run on the first observation. If the run still aborts
(network drop, exhausted retries, etc.), resume from the partial backlog with:

```bash
node .agents/scripts/epic-plan-decompose.js --epic [Epic_ID] \
  --tickets temp/epic-[Epic_ID]/tickets.json --resume
```

`--resume` is idempotent: the reconciler recovers the slug→issue map from
`temp/epic-[Epic_ID]/[Epic_ID].state.json`, and when that file is missing or
incomplete it **reseeds the map from live GitHub state** by matching each spec
slug against the open children of the Epic by title. Slugs that resolve to an
existing open child diff as Updates/no-ops; only the genuinely-missing children
are created — the existing tree is never duplicated. To force-throttle from the
first call on a known-large Epic, set `(framework constant: decomposer
concurrency): 1` in `.agentrc.json`.

## Troubleshooting

- If `epic-plan-spec.js --emit-context` fails, confirm the Epic exists and
  has a body with enough initial context.
- If `epic-plan-decompose.js` rejects the tickets file, re-read the
  validator's error message — the most common causes are a ticket whose
  `type` is not `story`, a Story missing its inline `acceptance[]` /
  `verify[]` contract, or a dependency cycle in the Story `depends_on`
  graph.
- If decomposition persisted the tickets but the Epic is not on `agent::ready`,
  you likely called `runDecomposePhase` from `epic-plan-decompose.js`
  directly without completing the persist flow — only the CLI surface
  (`node epic-plan-decompose.js --tickets ...`) drives the full
  reconciler pipeline and flips the lifecycle label. Apply `agent::ready`
  by hand and re-run via the CLI next time.
