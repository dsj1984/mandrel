---
description: >-
  Drive an Epic from `agent::ready` to a merged pull request against `main`.
  The ten-phase flow runs the wave loop, close-validation, epic-audit,
  code-review, retro, finalize, watch-and-iterate, conditional auto-merge,
  and local branch cleanup. When the run is end-to-end clean (zero manual
  interventions, zero 🔴/🟠 review findings, compact retro) the PR
  auto-merges via `gh pr merge --squash --delete-branch`; otherwise the
  workflow falls back to the operator-merges-button path so a human
  inspects the surface area.
---

# helpers/deliver-epic — Epic delivery path (invoked by /deliver)

> **Runtime core.** This file is the always-ingested Epic-delivery path:
> phase flow, commands, gate contracts, and return shapes. The recovery
> procedures, historical rationale, and troubleshooting detail live in the
> sibling [`deliver-epic-reference.md`](deliver-epic-reference.md); each
> moved procedure keeps a one-line pointer at its trigger point below. The
> reference is not projected to `.claude/commands/` — it is consulted on
> demand.

## Overview

This helper is the **Epic delivery path** behind `/deliver` — the router
delegates to it once per Epic ID, either as the sole route (single-Epic
input) or as one **Epic segment** of the sequential segment plan `/deliver`
composes over mixed Epic / standalone-Story input (Epic segments run in
input order, after the standalone segment; see
[`deliver.md`](../deliver.md)). Each invocation opens a PR against `main`
and auto-merges when every signal certifies a clean run; otherwise it falls
back to the operator-merges-button path.

```text
/deliver <epicId>
  → Phase 1 — prepare              (epic-deliver-prepare.js)
  → Phase 2 — ready-set loop       (wave-tick.js → dispatch ready set → observe → re-tick)
  → Phase 3 — close-validation     (lint + test + ratchets on epic/<id>)
  → Phase 4 — epic-audit           (helpers/epic-audit.md — change-set audits via selectAudits)
  → Phase 5 — code-review          (helpers/code-review.md with scope: epic)
  → Phase 6 — retro                (.agents/scripts/lib/orchestration/retro-runner.js)
  → Phase 6.5 — integration gate   (whole-product navigability + journey suite; @pending ≠ green for surface-adding Epics — blocks finalize)
  → Phase 7 — finalize             (lifecycle-emit → epic.close.end → open PR to main)
  → Phase 8 — watch-and-iterate    (poll `gh pr checks`; fix locally until green)
  → Phase 8.5 — auto-merge gate    (lifecycle-emit → epic.automerge.start)
  → Phase 9 — cleanup              (BranchCleaner + Cleaner lifecycle listeners on epic.cleanup.start / epic.merge.armed; fire via lifecycle-emit → epic.merge.armed)
```

The argument is always a single Epic ID (`type::epic`) — multi-Epic or
mixed input is segmented by the `/deliver` router before this helper runs.
Story IDs go to
[`helpers/deliver-stories`](deliver-stories.md) (standalone) or the
[`helpers/epic-deliver-story`](epic-deliver-story.md) helper
(Epic-attached, invoked by this workflow's fan-out); Tasks are not directly
executable.
Story dispatch is in-session via the Agent tool — no subprocess is
spawned.

---

## Arguments

```text
/deliver <epicId> [--skip-epic-audit] [--skip-code-review] [--skip-retro] [--full-retro] [--skip-integration-gate]
```

- `epicId` — must carry `type::epic`. Otherwise STOP and tell the operator
  to use `/deliver <id>` (standalone Story) or open the parent Epic.
- `--skip-epic-audit` — skip Phase 4 (log the override). Use only when the
  change-set audits are known to be irrelevant (e.g., docs-only Epic).
- `--skip-code-review` — skip Phase 5 (log the override).
- `--skip-retro` — skip Phase 6 (use sparingly).
- `--full-retro` — force the six-section retro regardless of manifest
  cleanliness. `--skip-retro` wins over `--full-retro`.
- `--skip-integration-gate` — skip Phase 6.5 (log the override). The
  explicit operator override for the post-wave integration gate,
  consistent with `--skip-epic-audit`. Skipping the gate is recorded as a
  manual intervention and disqualifies auto-merge, exactly like the other
  `--skip-*` overrides.

Every other runtime modifier is sourced from the Epic's labels or from
`delivery.deliverRunner` in `.agentrc.json`.

---

## Contract

- **Idempotent by checkpoint.** Re-runs resume from `epic-run-state`.
- **Single pause point.** Only `agent::blocked` halts execution. No
  clarifying questions — if stuck, flip to `agent::blocked`, post a
  friction comment, park.
- **Flat Story dispatch by design.** Host LLM fans out per-Story Agent
  calls directly with `subagent_type: general-purpose`. Keeping Story
  dispatch flat — the host owns the single fan-out level — is a
  **design choice**, not a harness constraint: the wave aggregator, idle
  watchdog, and merge-lock all assume one host-owned dispatch level. As of
  Claude Code 2.1.202 a level-1 sub-agent **does** carry the `Agent` tool
  and can nest further (verified depth 2, announced max depth 5; see
  [#2870](https://github.com/dsj1984/mandrel/issues/2870)), so a Story
  worker may itself fan out for its own sub-work within that depth budget —
  the Epic wave loop nonetheless stays flat by choice, not because nesting
  is unavailable.
- **Operator-merges-PR exit.** Phase 7 opens the PR; the workflow
  never merges to `main` itself. Phase 8.5 may fire auto-merge when
  every signal is clean.
- **Lifecycle bus is the runner model.** Phase transitions, ticket
  state flips, structured comments, and notifications are emitted as
  typed events on the in-session lifecycle bus; a fixed roster of
  listeners performs the side effects. Phase 7, 8.5, and 9 each fire
  exactly one lifecycle event via the generic
  [`lifecycle-emit.js`](../../scripts/lifecycle-emit.js) CLI
  (`--event epic.close.end` / `--event epic.automerge.start` /
  `--event epic.merge.armed`); the matching listener chain runs the
  bus-driven side effects (acceptance reconcile, automerge-armer,
  branch cleanup). The append-only NDJSON ledger at
  `temp/epic-<id>/lifecycle.ndjson` is the resume target. See
  [`docs/LIFECYCLE.md`](../../../docs/LIFECYCLE.md) for the bus
  contract, event taxonomy, ledger format, and listener model.

> **Hierarchy.** `/deliver` operates over the 2-tier hierarchy
> (Epic → Story). The fan-out is one `Agent` tool call per
> Story per wave (§ 2b); Story branches merge into `epic/<id>` with
> `--no-ff` via `story-close.js`; the close-validation chain
> (Phase 3), epic-audit, code-review, retro, finalize, and auto-merge
> gates all operate on Story-level units.
> [`helpers/epic-deliver-story`](epic-deliver-story.md) runs a
> single Story-implementation phase per Story against the Story's
> inline `acceptance[]` / `verify[]` fields. See
> [`.agents/instructions.md` § 5.D](../../instructions.md) and
> [`.agents/docs/SDLC.md` § Ticket hierarchy](../../docs/SDLC.md) for the full
> contract.

---

## Phase 1 — Prepare the Epic run

### Phase 1 prelude — Delivery preflight (Story #2899 / F13)

Before `epic-deliver-prepare.js` seeds the checkpoint, run
`epic-deliver-preflight.js` so the operator (and any reviewer reading the
Epic ticket) sees the estimated Story count, install cost, dependency depth,
GitHub API request volume, and Claude Max quota burn for the run that is
about to fan out. **Preflight always runs before Story fan-out.**

```bash
node .agents/scripts/epic-deliver-preflight.js --epic <epicId> --post
```

The CLI upserts a `delivery-preflight` structured comment on the Epic
(idempotent across re-runs) and prints a JSON envelope on stdout with
the canonical metric keys `storyCount`, `installCostSeconds`,
`dependencyDepth` (the longest dependency chain — the ready-set wall-clock
floor, replacing the retired wave count), `githubApiRequests`,
`claudeQuotaTokens`, plus a `breaches` array describing any
`delivery.preflight.max*` thresholds the estimate exceeds.

**Breach handling.** When `breaches` is non-empty, the workflow MUST
flip the Epic to `agent::blocked`, surface the envelope in chat for the
operator, and halt before Phase 1's `epic-deliver-prepare.js` call.
Resume after the operator unblocks (raising the threshold in
`.agentrc.json`, splitting the Epic, or accepting the cost) by re-running
`/deliver <epicId>` — the preflight is idempotent and the second
run upserts the same comment in place.

Threshold defaults live in `delivery.preflight.*` in `.agentrc.json`
(all keys default to "no cap" — the gate is opt-in until an operator
configures `maxStories` etc.).

### Phase 1 main — Seed the wave plan

```bash
node .agents/scripts/epic-deliver-prepare.js --epic <epicId> [--steal] [--as <handle>]
```

Validates `type::epic`, enumerates `type::story` descendants, parses
`blocked by #N` plus explicit `dependencies`, computes the dependency DAG
(to enumerate the open Story set), and upserts the `epic-run-state`
checkpoint in the per-Story-status shape (a flat `stories` map seeded at
`pending`, plus the global `concurrencyCap`). Treat the printed JSON as
`state`: `{ epicId, storyCount, concurrencyCap, stories, checkpointInitializedAt, docsDigestPath }`.
`stories` is the flat dispatch hint (`{ storyId, worktree, title }` per open
Story); the ready-set `tick` (Phase 2) decides which to dispatch on each
beat. `docsDigestPath` is the repo-relative path to the per-Epic docs digest
(`temp/epic-<epicId>/docs-digest.md`) that prepare writes from
`project.docsContextFiles` — thread it into every child prompt (§ 2b, item 6).
It is `null` when the project configured no `docsContextFiles` (no digest is
written). Flip the Epic to `agent::executing` (idempotent) after the CLI
returns.

**No spec-ticket linkage to resolve (Story #4324).** The Tech Spec lives
as managed sections of the Epic body itself — there is no separate
Tech-Spec issue id in the envelope and no `--tech-spec` flag to thread
into the per-Story `story-init.js` invocations. Story agents receive the
Tech Spec via context hydration, which embeds the Epic body (with the
`## Acceptance Table` section stripped) directly into each Story prompt.

> **Preflight guards + acceptance-table start gate.** Before the snapshot
> phase runs — and before any worktree is created — prepare runs two
> **fail-closed** guards (checkout safety + Epic lease), then the snapshot
> phase asserts the Epic carries an `acceptance::n-a` waiver or a
> `## Acceptance Table` section. Both throw on failure. See
> [`deliver-epic-reference.md` § Phase 1 — Preflight guards](deliver-epic-reference.md#phase-1--preflight-guards-story-3482--f-workflow-guards)
> for the remediation detail (dirty-tree recovery, `--steal`, waiver
> options).

---

## Phase 2 — Ready-set loop

The scheduler lives in
[`lib/wave-runner/tick.js`](../../scripts/lib/wave-runner/tick.js) — a thin
**Epic adapter over the ready-set core**
([`lib/wave-runner/ready-set.js`](../../scripts/lib/wave-runner/ready-set.js)).
One stateless `tick({ epic })` call re-derives readiness from the **live**
Story bodies + labels on every beat and returns one `WaveTickResult`
describing the next action. There is **no wave barrier** (Story #4155): a
Story whose own dependencies are all done is dispatched the instant a slot is
free under the GLOBAL in-flight cap, even while an unrelated sibling Story is
still `agent::executing`. The loop is simply:

```text
tick → dispatch the ready set → observe → re-tick → … → epic-complete
```

The slash command's job each beat is to call `tick()` via its CLI shim,
dispatch the Stories in `nextAction.stories` via the Agent tool, record each
returned Story's terminal status, and re-tick until terminal. There is no
`record-wave` / `currentWave` step — the checkpoint carries only a flat
per-Story status map (for resume + the operator rollup) and the global cap.

### 2.0. Open the Epic PR as a draft at wave 1 (Story #4359)

When `delivery.ci.earlyPr` is on (the default), open the Epic PR as a
**draft** once, before the first `tick`, so every subsequent per-wave push
to `epic/<epicId>` runs CI attributed to its own wave. (CI is keyed on the PR
ref with `cancel-in-progress`, so each new wave push **supersedes** the prior
wave's in-flight run rather than queuing behind it — the latest wave always
gets the verdict, and CI-minute use stays bounded; intermediate wave runs are
cancelled, not completed.) Resolve the flag through the
[`getCiDelivery`](../../scripts/lib/config/ci.js) accessor (default `true`);
do not read `delivery.ci.earlyPr` directly.

> **This step is host-LLM-driven, with no runtime enforcement seam** — unlike
> the Phase 7 ready-flip, which the `Finalizer` listener wires in
> deterministically (`finalizer.js` resolves `earlyPr` and calls
> `markPrReady`). The asymmetry is intentional and safe: if this wave-1
> draft-open is skipped, the `earlyPr`-on Phase 7 `markPrReady` call degrades
> to a no-op on the PR that finalize opens at close time (`gh pr ready` is a
> no-op on an already-ready PR), so the merge gate is never stranded — the run
> only loses the per-wave CI attribution this step buys.

- **`earlyPr` on** — call
  [`openOrLocatePr`](../../scripts/lib/orchestration/finalize/open-or-locate-pr.js)
  with `{ epicId, headBranch: 'epic/<epicId>', baseBranch: 'main', draft: true }`.
  The helper probes for an existing open PR first, so this is idempotent — a
  resumed `/deliver` run re-locates the same draft and opens no duplicate.
  Phase 7 later flips this draft to ready-for-review (it does **not**
  re-create the PR).
- **`earlyPr` off** — skip this step entirely. No draft is opened at wave 1;
  Phase 7 opens the PR at close time on the pre-Story timing.

The draft carries the same title/body contract Phase 7 uses
(`feat: Epic #<epicId>` / `Closes #<epicId>`), so no title/body reconciliation
is needed when it is marked ready.

### 2a. Tick — plan the next action

```bash
node .agents/scripts/wave-tick.js --epic <epicId>
```

Stdout is one `WaveTickResult` envelope:

```json
{
  "nextAction":
      { "kind": "dispatch", "stories": [{ "id": <n>, "title": "…" }, ...], "in-flight": [<storyId>, ...] }
    | { "kind": "observe",  "waitingOn": [<storyId>, ...], "in-flight": [<storyId>, ...] }
    | { "kind": "halt", "reason": "dependency-cycle" | "unsatisfiable-dependency", "stuckStories": [<storyId>, ...], "cycle"?: [<storyId>, ...], "in-flight": [<storyId>, ...] }
    | { "kind": "epic-complete", "in-flight": [<storyId>, ...] },
  "blockedStories": [{ "storyId": <n>, "reason": "…", "detail"?: "…" }, ...],
  "gateFailures":   [{ "storyId": <n>, "gate": "…", "detail"?: "…" }, ...],
  "readyCount":     <n>,
  "inFlight":       [<storyId>, ...]
}
```

`nextAction.stories` is the **ready set** for this beat — the
dependency-satisfied, overlap-free subset of open Stories, capped at
`globalCap − inFlight`. The CLI is a planner: it dispatches nothing and
persists nothing. It emits only the two wave-window forensics signals that
have a live consumer — `wave-start` (on the run's first dispatch) and
`wave-complete` (when the run finishes), which the perf-aggregator brackets
into the `waveParallelism` report (and `wave-start` anchors span-tree Story
spans). The [`signals` helper](signals.md)
(`node .agents/scripts/signals-view.js`) renders the forensics signals in the
span-tree view.

> **Old-shape checkpoint → fail-closed.** A pre-ready-set
> (`plan` / `currentWave` / `totalWaves`) checkpoint makes the tick refuse
> to run and throw; re-seed via `epic-deliver-prepare.js`. See
> [`deliver-epic-reference.md` § Fail-closed on an old-shape checkpoint](deliver-epic-reference.md#fail-closed-on-an-old-shape-checkpoint).

### 2b. Dispatch — fan out per-Story Agent calls

*You* (the LLM running this skill) are the dispatcher; you never invoke
`helpers/epic-deliver-story` yourself. Emit **one `Agent` tool call per
Story** in `nextAction.stories` (even when `length === 1` — the
parent-child boundary keeps the return-parser uniform). The *children*
run [`helpers/epic-deliver-story`](epic-deliver-story.md). Use
`subagent_type: general-purpose`.

Emit **one assistant turn** with **N parallel `Agent` calls** where
`N === nextAction.stories.length` (the ready set is already capped at
`globalCap − inFlight` by the tick, so it never exceeds available slots).
Dispatch the ready set as background calls (`run_in_background: true`) and,
as each child returns, record it (§ 2c) and **re-tick** (§ 2a) to pull the
next ready set — never wait for the whole set before refilling.

> **Throughput + capability tuning.** The default `concurrencyCap` of 3 is
> a deliberate operator-tuning knob (raise
> `delivery.deliverRunner.concurrencyCap`), and the optional per-call
> `model:` escape hatch lets mechanical Stories run on a cheaper capability.
> See [`deliver-epic-reference.md` § Throughput tradeoff](deliver-epic-reference.md#throughput-tradeoff)
> and [§ Sub-agent dispatch capability](deliver-epic-reference.md#sub-agent-dispatch-capability).

**Ledger the dispatch BEFORE the Agent call.** Immediately before each
per-Story `Agent` tool call (one shell-out per Story, every attempt —
including retries from a refill), invoke
[`lifecycle-emit-story-dispatch.js`](../../scripts/lifecycle-emit-story-dispatch.js)
so the lifecycle ledger durably records the dispatch attempt. The
emit must happen **before** the Agent call fires — never after — so
that a host-process crash mid-Agent leaves a `story.dispatch.start`
record that `wave-tick.js` (see § 2a) excludes from the next beat's ready
set and surfaces under `nextAction['in-flight']`:

```bash
node .agents/scripts/lifecycle-emit-story-dispatch.js \
  --epic <epicId> --story <storyId> \
  --wave 0 --attempt <attempt>
```

Pass `--wave 0` — the ready-set runtime has a single continuous front, so
the ledger's `waveIndex` is a fixed `0` (it is metadata for the start/end
pairing math, not a scheduling input). `<attempt>` starts at 1 for the
Story's first dispatch and increments on each retry/refill. The CLI appends
exactly one NDJSON line to `temp/epic-<epicId>/lifecycle.ndjson`; the
matching `story.dispatch.end` record is appended later by
`epic-execute-record-wave.js` (via `emit-story-dispatch-end.js`, Story #3900)
after the Agent return is recorded in § 2c.

Each Agent call's prompt must (1) name the Story + Epic ids, (2)
instruct the child to invoke `helpers/epic-deliver-story <storyId>`
(whose Step 4 defines the child's return shape), (3) remind the child
of the **non-interactive contract** (no clarifying questions;
transition to `agent::blocked` and exit if stuck), (4) tell the child to
suppress per-Story chat relay and instead relay **one line per phase
transition** (e.g. `Story #<id>: implementing → closing`) — the child's
authoritative progress lands in the `story-run-progress` snapshot the
`story-phase.js` CLI upserts, not in a verbatim body dump, (5) require the
child to emit a `story.heartbeat` lifecycle event at least once per
Story-level phase transition via `node .agents/scripts/story-phase.js` (or
whenever it stalls on a long-running step), and if it cannot make progress
to transition to `agent::blocked` rather than fall silent, and (6) pass the
**docs digest path** — the `docsDigestPath` field from the
`epic-deliver-prepare.js` envelope (§ Phase 1 main), which points at
`temp/epic-<epicId>/docs-digest.md`. Instruct the child to read that
digest instead of re-reading the full `project.docsContextFiles` set,
and to pull individual docs files on demand (per
[`.agents/instructions.md` § 3](../../instructions.md)). When
`docsDigestPath` is null (the project configured no `docsContextFiles`),
say so — the child then has no per-Story docs mandate. The pairing of
`story.heartbeat` and `agent::blocked` is what lets the § 2d Idle
Watchdog distinguish a working child from a dead one; a silent child
with no recent heartbeat and no blocker label is the failure mode the
watchdog is built to catch.

There is **no per-child JSON return-parsing ceremony** for the parent
to enforce. GitHub state is the contract: `epic-execute-record-wave.js`
(§ 2c, mode B) treats each child's raw return text as a best-effort
hint and reconciles any unparseable, empty, or missing return directly
from the Story's live labels and comments.

### 2c. Record the Story outcomes

As dispatched Stories return (record them as they land — you need not wait
for the whole ready set), persist each Story's terminal status via
`epic-execute-record-wave.js`. There is **no `--wave` flag and no
`currentWave`** — the recorder splices each Story's status into the
checkpoint's flat per-Story map and re-renders the rollup:

```bash
# Mode A — host LLM already parsed each child return.
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --results @<file>|<inline-json>

# Mode B — pipe the raw per-Story sub-agent return texts directly.
node .agents/scripts/epic-execute-record-wave.js \
  --epic <epicId> --returns @<file>|<inline-json>
# `<inline-json>` shape: [{ "storyId": <n>, "returnText": "<raw text>" }]
```

**Mode B is the default path** — pipe the raw return texts through
without inspecting them. The CLI reconciles parse failures from GitHub,
records each Story's terminal status, emits one `story.dispatch.end` per
recorded Story (closing the ledger pairing), re-renders
`epic-run-progress`, and prints `{ status, nextAction, renderedBody, ... }`.
Print `renderedBody` verbatim, then optionally append a short **Notable**
section (0–5 bullets on newly blocked / failed / slow Stories, friction,
elapsed-time surprises).

> **Crash recovery.** A child that finished but was never recorded is
> re-derived from its live label on the next `tick` and never
> re-dispatched. See
> [`deliver-epic-reference.md` § Crash recovery (record step)](deliver-epic-reference.md#crash-recovery-record-step)
> for the manual re-record command.

### 2d. Loop on `nextAction`

After `2c`, re-run `wave-tick.js`. Branch on the new envelope:

- `dispatch` → repeat 2b/2c for the new ready set (the next beat's
  dependency-satisfied Stories), then re-tick.
- `observe` → poll the Epic (children may still be in flight, or some
  are `agent::blocked`). If `blockedStories` is non-empty, post a
  friction comment, flip Epic to `agent::blocked`, park.
- `halt` → the run is stuck: no Story is dispatchable, nothing is in
  flight, yet not every Story is done. `reason` distinguishes the two
  causes — `dependency-cycle` (the in-scope Stories form a `blocked by`
  cycle; `cycle` lists the offending Story ids) or
  `unsatisfiable-dependency` (a Story is gated on a dependency that can
  never satisfy). `stuckStories` names the Story id(s) that stranded the
  run. Post a friction comment quoting `reason` + `stuckStories`, flip the
  Epic to `agent::blocked`, and park for the operator. **Never** treat a
  `halt` as completion — proceeding to Phase 3 would silently drop the
  stuck Story.
- `epic-complete` → **every** in-scope Story is done and nothing is in
  flight; proceed to Phase 3. (The tick returns `epic-complete` only when
  the done count equals the in-scope Story count — a stuck Story surfaces
  as `halt`, not a false `epic-complete`.)

> **Idle Watchdog.** While any Story is in flight, re-tick every 30 minutes
> with `wave-tick.js --epic <epicId> --check-idle 30` so a silent child
> (crashed host, lost return) is surfaced as a `wave-stall` and
> re-dispatched or blocked. The full cadence, staleness test (heartbeat +
> deterministic branch-commit signal), stall envelope, and the "why 30 not
> 10" rationale are in
> [`deliver-epic-reference.md` § 2e. Idle Watchdog](deliver-epic-reference.md#2e-idle-watchdog).
> Stop the cadence once the tick returns `epic-complete`.

---

## Phase 3 — Close-validation

Run lint + test + ratchets against `epic/<epicId>` before opening the PR:

```bash
node .agents/scripts/evidence-gate.js \
  --epic-id <epicId> --scope-id <epicId> --gate lint -- npm run lint
node .agents/scripts/evidence-gate.js \
  --epic-id <epicId> --scope-id <epicId> --gate test -- npm test
```

If either gate fails: STOP, fix on a hotfix branch, merge back to the
Epic branch, restart this phase.

### 3.1 Refresh ratcheted baselines

Inspect the scripts in `.husky/pre-push` (typecheck, lint, maintainability,
design tokens, dependency audits, bundle-size budgets). Run each against
the Epic branch; if any drifts, refresh and commit
`chore(baselines): refresh <name> for Epic #<epicId>`.

---

## Phase 4 — Epic audit (change-set lenses)

Skip when `--skip-epic-audit`. Otherwise auto-invoke
[`helpers/epic-audit.md`](epic-audit.md) inline. The helper runs
[`epic-audit-prepare.js`](../../scripts/epic-audit-prepare.js) to ask the
[`selectAudits`](../../scripts/lib/audit-suite/index.js) SDK which lenses fire
at the `gate3` close gate, **unions in the model-judged risk-routed lenses**
(Story #3889 — `epic-audit-prepare.js` reads the Epic's `planningRisk`
envelope off the `epic-plan-state` checkpoint and maps each high-risk axis to
its lens via `resolveAuditLenses`), then dispatches each selected lens through
[`runAuditSuite`](../../scripts/lib/audit-suite/index.js). A high-risk Epic
therefore auto-runs its mapped lenses (e.g. a `security`-axis Epic runs
`audit-security`) even when the change set alone did not select them; a
low-risk Epic adds nothing. Findings are persisted as an `audit-results`
structured comment on the Epic.

The helper's Step 3 remediation is **threshold-aware** (Story #4399): it
reads `delivery.epicAudit.autoFixSeverity` (default **`medium`**) and, at
`medium`, routes 🔴/🟠/**🟡** findings into on-branch remediation (Mediums
batched per lens — one commit per lens, a single validation + overlapping-
lens rescan at the end) while 🟢 Suggestions still graduate; `high`
reproduces the pre-4399 Critical/High-only routing. Remediated findings are
rendered under the comment's `## Fixed on-branch` section so they never
graduate to follow-up issues. The severity gate below is **unchanged** —
it keys off the surviving (unfixed) findings.

The helper walks the selected roster **serially in-context by default**; when
the roster carries more than one lens it **may delegate the walk to a single
audit-orchestrator sub-agent** that fans the already-selected lenses out as
parallel level-2 agents and returns only the aggregated `audit-results` (see
[`epic-audit.md` § "Optional: delegate the roster walk to an audit-orchestrator
sub-agent"](epic-audit.md), within the sub-agent depth budget noted under
"Flat Story dispatch by design" above). The roster stays fixed upstream, every
per-lens cost gate is preserved, and the seven sequential-only lenses are **not**
batch-converted — the fan-out parallelizes across lenses only and never changes
how any single lens runs internally.

- **Any surviving 🔴 Critical Blocker** — STOP. Relay to the operator.
- **Only 🟠/🟡/🟢 surviving** — log as non-blocking and continue.
- **Selector reports `degraded: true`** — STOP. Propagate the
  `reason`/`detail`, post a friction comment, do not fall back to a
  full-roster audit.
- **`selectedAudits` is empty** (docs-only change set) — log the
  short-circuit and continue to Phase 5.

---

## Phase 5 — Code review

Skip when `--skip-code-review`. Otherwise resolve the **risk-derived review
depth** for this Epic, then auto-invoke
[`helpers/code-review.md`](code-review.md) inline (read-only audit)
with the argument envelope `{ scope: 'epic', ticketId: <epicId>, baseRef:
'main', headRef: 'epic/<epicId>', depth: <reviewDepth> }`. The helper
persists findings as a `code-review` structured comment on the Epic.

The `depth` is the live epic-scope producer for Story #3876's review-depth
lever (Story #3937). Resolve it from the Epic's judged risk envelope the same
best-effort way Phase 4 routes audit lenses — via
[`resolveReviewDepthForEpic`](../../scripts/lib/orchestration/code-review.js),
which reads `planningRisk.overallLevel` off the Epic's `epic-plan-state`
checkpoint and maps it: `high` → `deep`, `low` → `light`, everything else
(including a missing/unparseable checkpoint, or an Epic that skipped
`/plan`) → `standard`. The helper threads `depth` into `runCodeReview`,
which forwards it to every provider's `runReview` input; the LLM-backed
providers (codex, security-review, ultrareview) render it into the prompt they
emit so a high-risk Epic gets a deeper adversarial pass and a low-risk one a
lighter one. Depth is **input-only** — it never changes the findings envelope
or the posted comment shape.

The helper's Step 4.5 focused-fix routing is **threshold-aware**
(Story #4399): it reads `delivery.codeReview.autoFixSeverity` (default
**`medium`**) and, at `medium`, routes 🔴/🟠/**🟡** findings into on-branch
remediation (Mediums batched per lens — one commit per lens, a single
validation + rescan at the end) while 🟢 Suggestions stay on the comment;
`high` reproduces the pre-4399 Critical/High-only routing. Remediated
findings are rendered under the comment's `## Fixed on-branch` section so
they never graduate to follow-up issues. The severity gate below is
**unchanged** — it keys off the surviving (unfixed) findings.

- **Any surviving 🔴 Critical Blocker** — STOP. Relay to the operator.
- **Only 🟠/🟡/🟢 surviving** — log as non-blocking and continue.

---

## Phase 6 — Retro

Skip when `--skip-retro`. Otherwise post the `epic-perf-report` via
`node .agents/scripts/analyze-execution.js --epic <epicId>` (failure →
warn and continue; the retro runner falls back). Then invoke the retro
runner via its CLI wrapper:

```bash
node .agents/scripts/retro-run.js --epic <epicId>
```

[`retro-run.js`](../../scripts/retro-run.js) resolves the config/provider,
constructs a lifecycle bus with a `LedgerWriter` (so the run's
`retro.start` / `retro.end` boundaries land in
`temp/epic-<epicId>/lifecycle.ndjson`), and calls `runRetro` — the
canonical compose-and-post surface at
[`.agents/scripts/lib/orchestration/retro-runner.js`](../../scripts/lib/orchestration/retro-runner.js).
Propagate `--full-retro` to bypass the compact-path heuristic.

Retro fires here (before the PR opens) so it stays in the operator's
local session with full env access (env vars, credentials, MCP). After
the GitHub upsert succeeds, the retro body is also **mirrored locally** to
`temp/epic-<epicId>/retro.md` (path resolved via
[`lib/config/temp-paths.js`](../../scripts/lib/config/temp-paths.js)'s
`epicRetroMirrorPath`). GitHub remains the source of truth — a
mirror-write failure only logs a warn and never fails the phase.

---

## Phase 6.5 — Post-wave integration gate (Epic #4131, F1/F4)

This phase runs **after** the Phase 2 wave loop reports `epic-complete` and
**before** the Phase 7 finalize emit opens the PR to `main`. It is the one
**deliberately-global** gate — its evidence spans the whole product, not just
the Epic's change set — so it catches the surface each Story shipped correctly
in isolation yet the assembled product cannot reach (an unnavigable route, a
broken persona journey).

Skip when `--skip-integration-gate` (log the override; record a manual
intervention per
[`deliver-epic-reference.md` § Recording manual interventions](deliver-epic-reference.md#recording-manual-interventions)).
The gate is otherwise **always evaluated** but a **silent no-op when
unconfigured** (no `routeGlobs` / `navRegistry` / `journeySuite` in
`.agentrc.json`).

Sub-steps and hard-failure semantics:

- **6.5a — Whole-product navigability**: run the `navigability` lens in
  whole-route mode over the `epic/<epicId>` tip. An **orphaned** route (no
  nav door for any entitled persona) or a dead nav href is a hard failure
  that **blocks finalize** and names the surface.
- **6.5b — Consumer journey suite**: run
  `delivery.quality.navigability.journeySuite` over the tip. A failing
  persona journey is a hard failure that **blocks finalize** and names the
  broken journey.
- **6.5c — `@pending` ≠ green for surface-adding Epics (F4)**: for a
  **surface-adding** Epic, an AC covered **only** by `@pending` scenarios is
  treated as unsatisfied and **fails the close gate** instead of passing
  green. This is **purely additive** and scoped to surface-adding Epics —
  refactor-only and docs-only Epics are **unaffected** and the existing
  `satisfied` / `missing` reconciliation is **not de-scoped** for any Epic.

On any hard failure, post a friction structured comment naming the surface
(route / nav-door identifier only — never route bodies or persona PII per
`security-baseline.md`), flip the Epic to `agent::blocked`, and **do not**
open the PR — the gate fails safe and loud. See
[`deliver-epic-reference.md` § Phase 6.5](deliver-epic-reference.md#phase-65--post-wave-integration-gate-epic-4131-f1f4)
for the full lens config, the surface-adding-signal derivation, the no-op
degradation contract, and the fail-safe-and-loud security note.

---

## Phase 7 — Finalize (ready the PR / open PR to main)

Before the close-tail emit, sync the Epic branch with `origin/main` so the
PR opens with the latest base commits already integrated (a stale base
stalls at branch-protection's `up-to-date branch` rule):

```bash
git checkout epic/<epicId>
node .agents/scripts/sync-branch-from-base.js \
  --branch epic/<epicId> --base main
git push origin epic/<epicId>
```

Then fire the close-tail emit:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> --event epic.close.end
```

`epic.close.end` drives the bus-owned `Finalizer` chain: acceptance-table
reconciliation (throws and aborts finalize on a coverage gap, `waived` under
`acceptance::n-a`), the PR-open/ready step (below), and the
`epic-handoff` comment naming the PR URL. The chain emits `pr.created` →
`epic.finalize.end` and **stops** — it never emits `epic.merge.ready` (the
auto-merge arm is driven later from the Phase 8.5 gated watch path). The
operator shells nothing beyond the sync and the single emit.

**PR-open/ready is gated by `delivery.ci.earlyPr` (Story #4359).** Resolve
the flag through the [`getCiDelivery`](../../scripts/lib/config/ci.js)
accessor (default `true`); do not read `delivery.ci.earlyPr` directly.

- **`earlyPr` on (default)** — the Epic PR already exists as a draft (Phase
  2 opened it at wave 1). Finalize **locates** the existing PR and flips it
  ready-for-review via
  [`markPrReady`](../../scripts/lib/orchestration/finalize/open-or-locate-pr.js)
  rather than creating a PR. `gh pr ready` on an already-ready PR is a
  no-op, so a re-run is idempotent.
- **`earlyPr` off** — no draft was opened at wave 1; finalize opens the PR
  now via `openOrLocatePr` (no `draft`), exactly as the pre-Story timing.

In both modes the PR title/body contract (`feat: Epic #<epicId>` /
`Closes #<epicId>`) is identical.

See
[`deliver-epic-reference.md` § Phase 7 — Finalize](deliver-epic-reference.md#phase-7--finalize-close-tail-listener-chain)
for the branch-sync outcome table (conflict / fetch-failed recovery) and the
full three-step listener contract (why finalize must not emit
`epic.merge.ready`, the merge-lockout lint rule, the no planning-ticket close
sweep).

---

## Phase 8 — Watch-and-iterate until CI is green

The host LLM owns the green-bar loop until the operator merges. Use
`pr-watch-with-update.js` — the **single CI-watch mechanism** shared with
the standalone single-Story Step 4 path (Story #4358). It polls the PR's
required checks to a terminal state and additionally auto-recovers from
`mergeStateStatus: BEHIND` by calling `gh pr update-branch` once every
required check is green (branch-protection rules requiring "up to date
before merging" otherwise park the PR until the operator clicks **Update
branch** manually):

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber> --epic <epicId>
```

`<agentRoot>` resolves from `project.paths.agentRoot` (default `.agents`).
Poll cadence and caps come from `delivery.ci.watch.*`
(`pollIntervalMs`, `maxPolls`, `maxResumes`); pass `--poll-interval-ms`,
`--max-polls`, `--max-resumes`, or `--max-updates` to override for one
run. Passing `--epic <epicId>` scopes the red-path failure digest to
`temp/epic-<epicId>-ci-digest.{json,md}`.

**Three-way exit (slow-vs-failed semantics):**

- **Exit 0** — every required check is green → proceed to Phase 8.5.
- **Exit 1** — a required check genuinely failed (red). The CLI writes
  `temp/epic-<epicId>-ci-digest.{json,md}` (failing check, run id,
  `gh run view --log-failed` tail, coarse classification) and surfaces
  the fix-loop handoff. Remediate on `epic/<epicId>` and re-run the
  helper (auto-merge stays armed across retries). If the same failure
  class recurs, hand the convergence off to the host loop:
  `/loop /loops:fix-failing-tests`.
- **Exit 2** — **still-running** (slow CI, not red): the poll cap fired
  with checks still pending and the watcher exhausted its
  `delivery.ci.watch.maxResumes` re-arm budget with nothing red. This is
  **never** a failure and **never** `timed_out`. Hand the wait off to the
  host's interval loop rather than blocking the delivery turn:
  `/loop 5m /loops:watch-ci`.

> **Triage authority.** How to classify and remediate a red (or repeatedly
> slow) check — the root-cause-only decision tree for infra/transient and
> flaky failures (reproduce → check `main` → bisect env vs code → fix in-scope
> or file a `meta::framework-gap` issue), the never-rerun / never-quarantine
> prohibitions, and the escalation criteria (three-strikes, the 30-minute
> wall-clock timebox, and the clearly-environmental fast path) — is defined
> once in [`.agents/rules/ci-remediation.md`](../../rules/ci-remediation.md).
> Read it before remediating.
>
> **Remediation + hard prohibitions.** For the per-check fix table (lint,
> baseline drift, test, coverage), the three-strikes halt rule, and the
> never-merge / never-force-push / never-dodge prohibitions, see
> [`deliver-epic-reference.md` § Phase 8 — Watch-and-iterate remediation](deliver-epic-reference.md#phase-8--watch-and-iterate-remediation).

---

## Phase 8.5 — Auto-merge gate

After Phase 8 exits 0, evaluate the auto-merge predicate by emitting
`epic.automerge.start`:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.automerge.start --pr-url <prUrl>
```

`AutomergePredicate` first runs a **live `gh pr checks --required` probe**
(Story #4361): green required CI is the arming signal, so if any required
check is red, pending, or the probe is unreadable it emits
`epic.merge.blocked` immediately — even if the Phase 8 watch was interrupted
before it observed green (closing the Story #3901 interrupted-watch hole).
When the probe is green it evaluates the structured-signal verdict under the
`delivery.ci.autoMerge` policy (default `"trust-ci"`; see
[`configuration.md`](../../docs/configuration.md)):

- **`trust-ci`** (default) — the ONLY structured conditions that block
  arming are an unresolved 🔴 critical (red) code-review finding or an
  `agent::blocked` state (a story-level blocker recorded in run-state, a
  non-done story, or a missing run-state checkpoint). Manual interventions,
  🟠 warning-level findings, and a non-clean retro are **recorded for audit**
  (surfaced on the classification log and the arm-reason) but no longer block.
- **`strict`** — restores the prior clean-sprint predicate exactly: empty
  manual-interventions, every story done, no story blocked, `0` 🔴 + `0` 🟠
  review findings, and the retro's `automerge-verdict` trailer reporting
  `cleanSprint: true`. Any dirty signal blocks.

On an arming decision the predicate emits `epic.merge.ready`; the downstream
`AutomergeArmer` (the sole authorized `gh pr merge` call site) fires
`gh pr merge --auto --squash --delete-branch`. Otherwise the predicate emits
`epic.merge.blocked` with the disqualifying reasons and exits without merging
— the operator merges manually.

**Blocked-path output (operator merges the button).** When arming is
declined, `epic.merge.armed` never fires inside this run, so Phase 9 does not
reap automatically. Surface the exact one-liner the operator runs **after**
they merge the PR by hand so local refs are reaped and `main` is
fast-forwarded (the idempotent-resume path below runs this automatically on
the next `/deliver <epicId>`):

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.merge.armed --pr-url <prUrl>
```

Close the phase wrapper by emitting `epic.automerge.end` (records the arm
outcome on the ledger; `merged: true` once GitHub completes the squash,
`merged: false` with a reason otherwise):

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.automerge.end --pr-url <prUrl> --merged <true|false>
```

> **Predicate wiring + manual-intervention recording.** For the full
> predicate contract (the trailer read, the `delivery.ci.autoMerge` policy
> split, and the Story #4361 live `gh pr checks --required` probe that
> replaced the former CI-freshness skip) and the
> `epic-deliver-note-intervention.js` command + its trigger list, see
> [`deliver-epic-reference.md` § Phase 8.5 — Auto-merge predicate detail](deliver-epic-reference.md#phase-85--auto-merge-predicate-detail).

---

## Phase 9 — Local branch cleanup

Phase 9 runs **automatically** inside the lifecycle bus once auto-merge
arms: the `BranchCleaner` listener subscribes to `epic.cleanup.start`
and reaps local refs (the `epic/<id>` branch, every `story-<id>` in the
checkpoint, attached worktrees, and stale tracking refs) before `Cleaner`
archives the `temp/epic-<id>/` tree. No operator step is required on the
auto-merge path.

For out-of-band cleanup re-entry (resume after a crash, or operator
override), fire `epic.merge.armed`:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.merge.armed --pr-url <prUrl>
```

> **Reap order + operator-merges fallback.** For the full in-process reap
> order, the per-branch classification log, and the manual reap sequence
> when Phase 8.5 fell back to the operator-merges-button path (auto-merge
> declined, `epic.merge.armed` never fired), see
> [`deliver-epic-reference.md` § Phase 9 — Local branch cleanup detail](deliver-epic-reference.md#phase-9--local-branch-cleanup-detail).

---

## Idempotence and resume

Re-runs pick up at the next undispatched wave (in-flight Stories finish
via `helpers/epic-deliver-story`'s own checkpointing). The PR from Phase 7 is
updated in place on subsequent runs. The authoritative live view is
the `epic-run-progress` structured comment.

**Resume auto-arm for a merged-but-uncleaned Epic.** When `/deliver` resumes
against an Epic whose PR already merged (operator merged the button in a prior
session) but whose local `epic/<id>` / `story-<id>` refs still linger, the
resume path detects the merged-but-uncleaned state
(`detectMergedUncleanedEpic` in
[`epic-cleanup.js`](../../scripts/lib/orchestration/epic-cleanup.js)) and fires
`epic.merge.armed` automatically so Phase 9 reaps — no manual command. The
detection is idempotent: an already-reaped Epic (no local refs) is a clean
no-op, and an unmerged Epic never arms. It resolves the merged PR's URL for the
required `epic.merge.armed` payload and fails closed (does **not** arm) on any
indeterminate `gh` probe. The one-liner under Phase 8.5 / Phase 9 is the manual
equivalent for the case where the operator does not re-run `/deliver`.

---

## Constraints

- **Never** merge `epic/<epicId>` to `main` outside Phase 8.5.
- **Never** dispatch more than the global `concurrencyCap` allows;
  concurrency lives inside the ready-set fan-out.
- **Never** flip Story-level labels from this skill; **never** invoke
  `helpers/epic-deliver-story` yourself (children run it via Agent fan-out,
  even for single-Story waves); **never** spawn a subprocess for dispatch.
- **Always** checkpoint via `epic-deliver-prepare.js` /
  `epic-execute-record-wave.js`; never write run state elsewhere.
- **Always** post a friction structured comment before a non-`complete`
  outcome.
- **Always** auto-invoke the epic-audit, code-review, and retro helpers
  (Phases 4–6) when their artefacts aren't already present.
- **Always** run the Phase 6.5 integration gate after the wave loop
  reports `epic-complete` and before Phase 7 finalize (unless
  `--skip-integration-gate`); **never** open the PR while the gate
  reports a hard failure (orphaned surface, dead nav href, broken
  journey, or a surface-adding Epic with only `@pending` AC coverage).
- **Always** drive Phase 8 to green CI before returning control — the
  host LLM owns the loop until the PR is mergeable or the Epic is
  parked at `agent::blocked`.
