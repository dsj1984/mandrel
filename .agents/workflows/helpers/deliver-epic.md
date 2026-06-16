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
  explicit operator override for the post-wave integration gate, consistent
  with `--skip-epic-audit`. Use only when the deliberately-global checks are
  known to be irrelevant for this Epic (e.g., a docs-only Epic that adds no
  surface). Skipping the gate is recorded as a manual intervention and
  disqualifies auto-merge, exactly like the other `--skip-*` overrides.

Every other runtime modifier is sourced from the Epic's labels or from
`delivery.deliverRunner` in `.agentrc.json`.

---

## Contract

- **Idempotent by checkpoint.** Re-runs resume from `epic-run-state`.
- **Single pause point.** Only `agent::blocked` halts execution. No
  clarifying questions — if stuck, flip to `agent::blocked`, post a
  friction comment, park.
- **Two-level dispatch.** Host LLM fans out per-Story Agent calls
  directly with `subagent_type: general-purpose`. Sub-agents do not
  carry the `Agent` tool, so this stays flat.
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
  branch cleanup). PR open + planning-artifact close are
  operator-/host-LLM-driven in the current wiring — see Phase 7.1 for
  the canonical manual sequence and `finalizer.js` for the listener's
  no-op disclaimer. The append-only NDJSON ledger at
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
configures `maxStories` etc.). The CI-firehose mitigation
(`delivery.ci.skipForStoryPushes: true`) and these threshold keys are
the two operator-tunable knobs F13 ships.

### Phase 1 main — Seed the wave plan

```bash
node .agents/scripts/epic-deliver-prepare.js --epic <epicId> [--steal] [--as <handle>]
```

Validates `type::epic`, enumerates `type::story` descendants, parses
`blocked by #N` plus explicit `dependencies`, computes the dependency DAG
(to enumerate the open Story set), and upserts the `epic-run-state`
checkpoint in the per-Story-status shape (a flat `stories` map seeded at
`pending`, plus the global `concurrencyCap`). Treat the printed JSON as
`state`: `{ epicId, storyCount, concurrencyCap, stories, checkpointInitializedAt }`.
`stories` is the flat dispatch hint (`{ storyId, worktree, title }` per open
Story); the ready-set `tick` (Phase 2) decides which to dispatch on each
beat. Flip the Epic to `agent::executing` (idempotent) after the CLI returns.

> **Preflight guards (Story #3482 / F-workflow-guards).** Before the
> snapshot phase runs — and before any worktree is created — prepare runs
> two **fail-closed** guards
> ([`lib/orchestration/epic-deliver-lease-guard.js`](../../scripts/lib/orchestration/epic-deliver-lease-guard.js)):
>
> 1. **Checkout safety.** Prepare refuses to start when the working tree is
>    dirty or HEAD is on a branch other than the expected one (`epic/<id>`
>    on a resume, or the project base branch on a fresh run). It will
>    **not** check `epic/<id>` out over your work — the historic
>    HEAD-yank footgun. Remediation: commit/stash/clean the tree, or
>    switch to the expected branch, then re-run.
> 2. **Epic lease.** Prepare acquires the assignee-as-lease on the Epic
>    ticket (`ticket-lease.acquireLease`). On a **live foreign claim**
>    (a teammate's run with a fresh `story.heartbeat` within
>    `delivery.lease.ttlMs`) it exits non-zero and names the current owner;
>    a **stale** claim is silently reclaimed. The operator identity is
>    resolved from `--as <handle>` → `github.operatorHandle` →
>    `git config user.email`. Pass `--steal` to forcibly transfer a live
>    foreign claim (the takeover is logged for auditability). The committed
>    `github.operatorHandle` is the non-personal `@[USERNAME]` placeholder,
>    which resolves to null — so when none of the three sources yields a real
>    identity the guard **fails closed** (throws after the checkout guard
>    runs) rather than driving an ownerless, unguarded delivery. Set your own
>    handle in `.agentrc.local.json`, pass `--as <handle>`, or configure
>    `git user.email`. The lease is the cross-clone coordination layer, while
>    `epic-merge-lock.js` continues to serialize same-machine sessions.
>
> Both guards throw on failure, which `runAsCli` maps to `process.exit(1)`
> per [`orchestration-error-handling.md`](../../rules/orchestration-error-handling.md).

Once the preflight guards pass, the snapshot phase applies one more gate:

> **Acceptance-spec start gate.** Before the wave loop fans out, the
> snapshot phase
> ([`lib/orchestration/epic-runner/phases/snapshot.js`](../../scripts/lib/orchestration/epic-runner/phases/snapshot.js))
> asserts that the Epic either carries the `acceptance::n-a` waiver
> label **or** has a linked `context::acceptance-spec` ticket. The
> ticket's GitHub state (open / closed) is **not** checked —
> presence is sufficient, matching the PRD and Tech Spec contract.
> The reviewer's OK during `/plan` Phase 7 is the approval
> signal, not a manual ticket-close action. Neither condition met →
> the snapshot throws a clear error
> (`[epic-deliver] Epic #<id> cannot launch: …`) and `runAsCli`
> maps it to `process.exit(1)`. Operator remediation: either run
> `/plan` Phase 7 to author the spec, or apply the
> `acceptance::n-a` label to opt out.

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

> **Fail-closed on an old-shape checkpoint.** If the Epic still carries a
> pre-ready-set (`plan` / `currentWave` / `totalWaves`) `epic-run-state`
> checkpoint, the tick **refuses to run** and throws an explicit operator
> message — re-run `epic-deliver-prepare.js --epic <id>` to re-seed the
> checkpoint in the per-Story-status shape, then re-run `/deliver`.

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

> **Throughput tradeoff.** The default `concurrencyCap` of 3 is the GLOBAL
> in-flight cap, intentionally conservative — it keeps host-quota
> consumption low and avoids flooding the GitHub API. For Epics with wide
> dependency-free fronts where the host has adequate parallel-agent quota,
> raising `delivery.deliverRunner.concurrencyCap` in `.agentrc.json` reduces
> wall-clock time proportionally to the extra concurrency. The safe default
> is left in place; this is a deliberate operator-tuning knob, not a hidden
> performance ceiling. See `agentrc-reference.json`
> `delivery.deliverRunner.concurrencyCap` for the configuration surface.

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
transition to `agent::blocked` and exit if stuck), (4) ask the child to
suppress per-Story chat relay, and (5) require the child to emit a
`story.heartbeat` lifecycle event at least once per Story-level phase
transition via `node .agents/scripts/story-phase.js` (or whenever it
stalls on a long-running step), and if it cannot make progress to
transition to `agent::blocked` rather than fall silent. The pairing of
`story.heartbeat` and `agent::blocked` is what lets the §2e Idle
Watchdog distinguish a working child from a dead one; a silent child
with no recent heartbeat and no blocker label is the failure mode the
watchdog is built to catch.

There is **no per-child JSON return-parsing ceremony** for the parent
to enforce. GitHub state is the contract: `epic-execute-record-wave.js`
(§ 2c, mode B) treats each child's raw return text as a best-effort
hint and reconciles any unparseable, empty, or missing return directly
from the Story's live labels and comments.

**Sub-agent dispatch.** `Agent` calls emit no `model:` argument by
default — children inherit from the `general-purpose` sub-agent
definition and the parent's worktree context. No
`--dangerously-skip-permissions` (no subprocess is spawned). If a
specific call needs to override the inherited model, pass `model:` as a
per-call literal at the `Agent(...)` site.

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

> **Crash recovery.** If the host crashed *after* a child finished but
> *before* its return was recorded, the next `tick` re-derives that Story's
> state directly from its live label (the tick reads labels every beat), so a
> done-but-unrecorded Story is recognised as done and never re-dispatched —
> there is no falsely-`complete` empty wave to recover from. If you want to
> reconcile a known-completed Story whose return text was lost, re-record it
> from its live state by passing `--results '[{"storyId":<n>,"status":"done"}]'`
> (verification re-checks the live label before recording `done`).

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

### 2e. Idle Watchdog

A Story's implementation loop can run for many minutes between
`story.dispatch.start` and the post-merge `story.merged` record. While
`observe` keeps the host LLM polling the Epic, it does **not** flag a
sub-agent that has gone silent (host crash, mid-Story stall, lost
return). The Idle Watchdog closes that gap.

**Cadence.** While any Story is in flight (i.e. `nextAction.kind` is
`observe` or the most recent dispatch's `in-flight` list is non-empty),
re-tick every **30 minutes** with the watchdog flag:

```bash
node .agents/scripts/wave-tick.js --epic <epicId> --check-idle 30
```

> **Why 30, not 10 (Story #3900).** Heartbeats fire only at Story-level
> phase transitions, and `implementing → closing` routinely exceeds 10
> minutes for a healthy Story. A 10-minute threshold therefore tripped the
> watchdog on every long-running Story, whose prescribed remediation —
> re-dispatch — put two agents on one `story-<id>` branch (the worst
> failure mode in the system). The threshold is widened to 30 minutes and
> the staleness test now also consults a deterministic branch-commit
> signal (below), so a Story still gaining commits is never flagged.

The `--check-idle <minutes>` mode scans the per-Epic lifecycle ledger
(`temp/epic-<epicId>/lifecycle.ndjson`) for Stories that carry a
`story.dispatch.start` without a matching `story.dispatch.end` (the
canonical in-flight list — see § 2a's `nextAction['in-flight']`), and
compares each in-flight Story's most recent ledger event (any
`story.*` event, notably the `story.heartbeat` records emitted by
`story-phase.js` at each Story-level phase transition) against the
threshold. **Before flagging a stall, it also checks the last commit on
`story-<id>` via `git log` (Story #3900): a Story whose branch carries a
commit newer than the threshold is making forward progress and is left
in-flight, never stalled — deterministic protection against the
false-positive re-dispatch hazard even when no heartbeat has landed.**
The CLI emits one envelope on stdout and exits non-zero when at least
one in-flight Story has been silent for ≥ the threshold:

```json
{
  "kind": "wave-stall",
  "epicId": <n>,
  "thresholdMinutes": <n>,
  "checkedAt": "<ISO-8601>",
  "stalled": [{ "storyId": <n>, "lastEventAt": "<ISO-8601>", "idleMinutes": <n> }],
  "inFlight": [<storyId>, ...]
}
```

**On a stall.** When the watchdog exits non-zero, post the envelope
verbatim as a `wave-stall` structured comment on the Epic (use
[`post-structured-comment.js`](../../scripts/post-structured-comment.js)
with `--kind wave-stall`), then re-evaluate the affected Stories: if a
child sub-agent has crashed (no `story.dispatch.end`, no recent
heartbeat, no commit on `story-<id>`), re-dispatch the Story per § 2b
incrementing the `--attempt` counter; if the child is alive but
genuinely blocked, flip the Story to `agent::blocked` and proceed per
§ 2d's `observe` branch.

Stop the watchdog cadence once `wave-tick.js` returns `epic-complete` —
there are no in-flight Stories left to monitor.

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

- **Any 🔴 Critical Blocker** — STOP. Relay to the operator.
- **Only 🟠/🟡/🟢** — log as non-blocking and continue.
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

- **Any 🔴 Critical Blocker** — STOP. Relay to the operator.
- **Only 🟠/🟡/🟢** — log as non-blocking and continue.

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
local session with full env access (env vars, credentials, MCP).

After the GitHub upsert succeeds, the retro body is also **mirrored
locally** to the per-Epic temp tree at `temp/epic-<epicId>/retro.md`
(path resolved via
[`lib/config/temp-paths.js`](../../scripts/lib/config/temp-paths.js)'s
`epicRetroMirrorPath`, which honours `project.paths.tempRoot`).
Operators can read the retro without re-fetching from GitHub. GitHub
remains the source of truth — a mirror-write failure only logs a warn
and never fails the phase.

---

## Phase 6.5 — Post-wave integration gate (Epic #4131, F1/F4)

This phase runs **after** the Phase 2 wave loop reports `epic-complete` and
**before** the Phase 7 finalize emit opens the PR to `main`. Where every gate
before it (`selectAudits`, the cross-epic-leak guard `#3362`, diff-against-base,
the file-assumption gate) is **change-set-scoped** — it narrows its evidence to
the Epic's `changedFiles` — this is the one **deliberately-global** gate: its
evidence spans the **whole product**, not just the change set. The disease it
catches is the surface that each Story shipped correctly in isolation yet that
the assembled product cannot reach: a route nobody can navigate to, or a
persona journey that the integrated waves silently broke. A change-set lens
never sees that, because no single Story's diff contains the orphan.

Skip when `--skip-integration-gate` (log the override; record a manual
intervention per [§ Recording manual interventions](#recording-manual-interventions)).
The gate is otherwise **always evaluated**, but it is a **silent no-op when
unconfigured** (see *No-op when unconfigured* below) so consumers who ship no
nav config and no journey suite are unaffected.

### 6.5a — Whole-product navigability (reuses the Phase 4 lens)

Run the `navigability` lens
([`audit-navigability.md`](../audit-navigability.md), the deliberately-global
lens delivered in this Epic's wave 0) in **whole-route mode** against the
integrated `epic/<epicId>` tip. Unlike its Phase 4 change-set-routed invocation,
here it is driven explicitly over the consumer's **entire** route tree + nav
registry — it is on the global-lens allowlist (`GLOBAL_LENS_ALLOWLIST` in
[`lib/audit-suite/selector.js`](../../scripts/lib/audit-suite/selector.js)) and
exempt from the cross-epic-leak guard `#3362`, so a route orphaned anywhere in
the product is in scope even when no Story in this Epic touched it.

The lens reads the consumer's navigability config (resolved from `.agentrc.json`):

- `delivery.quality.navigability.routeGlobs` — the route-tree SSOT the lens
  enumerates.
- `delivery.quality.navigability.navRegistry` — the nav-registry SSOT the lens
  cross-checks every route against.

A whole-product finding is a **hard failure**: an **orphaned route** (a route
with no nav door for any entitled persona) or a **dead nav href** (a nav door
pointing at a route that no longer exists). On a hard failure the gate **blocks
finalize** and names the orphaned surface (route identifier / nav-door
identifier only — never the route body or persona PII, per
`security-baseline.md`). Do **not** proceed to Phase 7.

### 6.5b — Consumer journey suite

Run the consumer's per-persona journey suite — the integrated, cross-Epic
persona-journey verification — over the `epic/<epicId>` tip:

- `delivery.quality.navigability.journeySuite` — path/command for the journey
  suite. Absent ⇒ this sub-step is skipped (no-op).

A failing journey (a persona cannot complete an end-to-end journey through the
assembled product) is a **hard failure**: block finalize and name the broken
journey. This is the runtime complement to 6.5a's static reachability check —
6.5a proves a door exists; the journey suite proves the door, and everything
behind it, actually works when the waves are integrated.

### 6.5c — `@pending` ≠ green for surface-adding Epics (F4)

The Phase 7 finalize chain runs the acceptance-spec reconciler
([`acceptance-spec-reconciler.js`](../../scripts/acceptance-spec-reconciler.js)),
which classifies every AC ID into `satisfied` (covered by a non-pending
scenario), `pending` (covered **only** by scenarios tagged `@pending`), or
`missing`. For a **surface-adding Epic** — one whose risk verdict carries a
surface-adding signal (a route-adding change set, the `navigability` lens routed
in Phase 4, or a configured `routeGlobs` match) — this phase tightens that
contract: an AC whose coverage is **only `@pending`** is treated as
**unsatisfied**, not green. A surface-adding Epic whose acceptance coverage is
**only `@pending`** therefore **fails the close gate** instead of passing —
shipping a new surface behind a deferred-forever `@pending` scenario is exactly
the late-gate gap this Epic exists to close.

This is **purely additive** and **scoped to surface-adding Epics**:
refactor-only and docs-only Epics (no surface-adding signal) are **unaffected** —
their `@pending` handling is exactly as before, and the existing
`satisfied` / `missing` reconciliation is **not** de-scoped for any Epic.

### No-op when unconfigured

With **no** navigability config (`routeGlobs` / `navRegistry`) and **no**
`journeySuite` present in `.agentrc.json`, this entire phase degrades to a
**silent no-op**: 6.5a and 6.5b skip (nothing to enumerate or run) and 6.5c's
surface-adding signal cannot fire without route globs, so the `@pending`
tightening never engages. The gate adds **zero** behaviour to an unconfigured
consumer — it neither blocks finalize nor changes the existing change-set-scoped
gates. The override flag `--skip-integration-gate` is the explicit operator
escape hatch (consistent with `--skip-epic-audit`) for a configured consumer who
wants to bypass the gate for a specific run.

### Fail safe and loud

Per the Tech Spec's security note, this gate sits on the **critical path** to
finalize. It MUST fail **safe and loud**: a hard failure **blocks** finalize and
**names the cause** (the orphaned route, dead href, broken journey, or
`@pending`-only AC), never silently passes. A genuinely unconfigured consumer is
the **only** silent path, and that path **passes** (it is a no-op, not a block).
On a hard failure, post a friction structured comment naming the surface, flip
the Epic to `agent::blocked`, and park for the operator — do **not** open the PR.

---

## Phase 7 — Finalize (open PR to main)

### 7.0 — Sync Epic branch from `main` (Story #2580)

Before firing the close-tail emit, sync the Epic branch with
`origin/main` so the PR opens with the latest base commits already
integrated. The Epic branch may be behind `main` if other PRs merged
during the wave loop; without this step, the Epic→`main` PR opens
"behind base" and (with branch-protection's `up-to-date branch` rule)
stalls at the merge gate.

```bash
git checkout epic/<epicId>
node .agents/scripts/sync-branch-from-base.js \
  --branch epic/<epicId> --base main
```

Outcomes:

- **`fast-forward` / `merge-commit` / `noop-already-current`** → push
  the resulting tip and continue to Phase 7.1: `git push origin epic/<epicId>`.
- **`conflict`** → resolve in the Epic checkout (`git merge --no-edit
  origin/main`, fix conflicts, `git commit --no-edit`), then re-run the
  sync command. Once it exits 0, continue. Operator-recoverable; not an
  agent loop.
- **`fetch-failed`** → re-check network / `origin` access and re-run.

This is a workflow-level step (operator-driven), not part of the
close-tail listener chain. The sync runs from the main checkout so
the resulting tip lands on `epic/<epicId>` before Phase 7.1 fires
the bus-driven close-tail.

### 7.1 — Fire the close-tail emit

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> --event epic.close.end
```

Emits `epic.close.end` onto the lifecycle bus. **Every close-time
responsibility below runs inside the listener chain — the operator
shells nothing manually. The `Finalizer` listener (Story #2894 —
bus-owned finalize) composes three helpers under
`.agents/scripts/lib/orchestration/finalize/` and emits the canonical
chain.** Treat this section as a runtime contract — `/deliver`
just fires the emit and reads the resulting ledger.

1. **Acceptance-spec reconciliation — bus-driven.** The
   `AcceptanceReconciler` listener invokes
   [`acceptance-spec-reconciler.js`](../../scripts/acceptance-spec-reconciler.js)
   to diff the AC IDs declared in the linked `context::acceptance-spec`
   body against `@ac-*` / `@pending` tags in `tests/features/**`. A
   non-OK reconciliation throws (per
   [`rules/orchestration-error-handling.md`](../../rules/orchestration-error-handling.md)),
   aborting finalize **before** any PR is opened or planning artifacts
   are closed — so the PRD, Tech Spec, and Acceptance Spec stay open
   until the AC coverage gap is fixed. The reconciler returns
   `status: 'waived'` without scanning features when the Epic carries
   `acceptance::n-a`, and defends against direct CLI invocation by
   refusing to run when no spec is linked and no waiver is set (the
   start gate in Phase 1 would normally catch that first).
2. **PR open — bus-driven (Story #2894).** On
   `acceptance.reconcile.ok` the `Finalizer` listener invokes
   [`openOrLocatePr`](../../scripts/lib/orchestration/finalize/open-or-locate-pr.js)
   with `{ epicId, headBranch: 'epic/<id>', baseBranch: 'main' }`.
   The helper probes for an existing open PR on the head branch
   first (idempotent locate path — a re-run of `/deliver`
   on the same branch short-circuits without opening a duplicate)
   and only opens a new PR when none exists. The listener then
   emits `pr.created` → `epic.finalize.end` and **stops** (Story
   #3367). It does **not** emit `epic.merge.ready`: that event is
   the sole `AutomergeArmer` trigger, and emitting it from finalize
   would cascade `epic.close.end` synchronously through the arm →
   `MergeWatcher` → `Cleaner` → `BranchCleaner` reap, deleting the
   `epic/<id>` branch before the PR merged and bypassing the
   `AutomergePredicate` disqualification gate. The auto-merge arm is
   driven later from the gated watch path (`pr.created` → `Watcher`
   → `epic.watch.end` → `AutomergePredicate` → `epic.merge.ready` →
   `AutomergeArmer`) re-entered in Phase 8.5. The merge-lockout rule
   in [`check-lifecycle-lint.js`](../../scripts/check-lifecycle-lint.js)
   keeps `gh pr merge --auto --squash --delete-branch` confined to
   `AutomergeArmer` — Phase 7 never shells the merge command.
3. **Planning-artifact close + hand-off — bus-driven (Story
   #2894).** After `openOrLocatePr` returns, the `Finalizer` chains
   [`closePlanningTickets`](../../scripts/lib/orchestration/finalize/close-planning-tickets.js)
   to close the three planning context tickets
   (`context::prd`, `context::tech-spec`, `context::acceptance-spec`)
   so the Epic's `Closes #<id>` auto-close path is not blocked by
   open sub-issues, then
   [`postHandoffComment`](../../scripts/lib/orchestration/finalize/post-handoff-comment.js)
   to upsert the canonical `epic-handoff` structured comment naming
   the PR URL. Both helpers are idempotent — already-closed tickets
   are counted under `alreadyClosed`, and the handoff comment is
   edited in place via `upsertStructuredComment` rather than
   appending a duplicate. When the `acceptance::n-a` waiver is set
   and no Acceptance Spec ticket was ever opened, the third
   planning-ticket close is recorded as `skipped`.

Branch cleanup is out-of-band (Phase 9 reaps local refs after merge; the
rare "scrap and reset" case for an unmerged Epic is handled manually).

---

## Phase 8 — Watch-and-iterate until CI is green

The host LLM owns the green-bar loop until the operator merges. Use
the shared watch-and-recover helper, which wraps `gh pr checks --watch`
and additionally auto-recovers from `mergeStateStatus: BEHIND` by
calling `gh pr update-branch` once every required check is green
(branch-protection rules requiring "up to date before merging"
otherwise park the PR until the operator clicks **Update branch**
manually):

```bash
node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>
```

`<agentRoot>` resolves from `project.paths.agentRoot` (default
`.agents`). Pass `--max-updates N` (default 3) to cap update-branch
calls per session and `--poll-interval-ms MS` (default 10000) to
override the polling cadence.

Exit 0 → proceed to Phase 8.5. Non-zero → remediate (below) and re-run
the helper. Auto-merge stays armed across retries; the
`epic.automerge.start` emit in Phase 8.5 re-runs the `AutomergeArmer`
listener, which re-checks `mergeStateStatus` before firing merge, so a
second BEHIND that arrives between the helper exiting clean and Phase
8.5 starting is also caught.

### 8.1 Remediation

For each failed required check: fetch the log
(`gh run view <runId> --log-failed`), classify and fix:

- **lint / format** → `npm run lint` + `npx biome check --apply` (or
  `format --write`); commit, push.
- **maintainability / crap baseline drift** → re-run the ratcheted
  script. Refresh the baseline only when drift is justified by the
  diff; otherwise fix at source.
- **test failure** → reproduce with `npm test`, fix source or test.
- **coverage threshold** → add tests (preferred); refresh baseline only
  when the diff demonstrably can't be covered.
- **anything else** → read the log, fix at source.

Push to `epic/<epicId>` and re-run
`node <agentRoot>/scripts/pr-watch-with-update.js --pr <prNumber>`.

### 8.2 When to halt

Three consecutive iterations on the same failure class without
convergence → friction comment, flip to `agent::blocked`, park. Unknown
failure class on first encounter → attempt source-level fix; log
friction if diagnosis takes more than one round.

### 8.3 Hard prohibitions

**Never** `gh pr merge` from Phase 8 (Phase 8.5 is the only merge
site). **Never** force-push to `main`. **Never** push empty commits or
refresh baselines to dodge a red check.

---

## Phase 8.5 — Auto-merge gate

After Phase 8 exits 0, evaluate the auto-merge predicate by emitting
`epic.automerge.start`:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.automerge.start --pr-url <prUrl>
```

`AutomergePredicate` subscribes to `epic.automerge.start` (Story #3901 —
before that this event had **zero** subscribers and the entire Phase 8.5
gate was a dead wire). It evaluates the structured-signal verdict and
emits `epic.merge.ready` on a clean verdict or `epic.merge.blocked`
otherwise. The CI-freshness gate is skipped on this event because Phase 8
already polled every required check to green — `epic.automerge.start`
carries `prUrl` but no `checkOutcomes`.

The `AutomergeArmer` listener subscribes to the downstream
`epic.merge.ready` outcome and fires `gh pr merge --auto --squash
--delete-branch` only when `clean: true`. `clean: true` requires
**all** of:

- `state.manualInterventions[]` is empty;
- every wave's `status === "complete"`;
- no story envelope carries a `blockerCommentId` or non-`done` status;
- code-review reports `0` 🔴 + `0` 🟠 findings;
- the retro's machine-readable `automerge-verdict` trailer reports
  `cleanSprint: true` (Story #3901 — the predicate reads the parsed JSON
  trailer `retro-run.js` writes into the retro body, **not** an emoji
  string-match on the human-facing "🟢 Clean sprint" prose).

When clean, the listener fires `gh pr merge --squash --delete-branch`.
Otherwise the listener records disqualifying reasons via
`epic.merge.blocked` and exits without merging — operator merges
manually.

Close the phase wrapper by emitting `epic.automerge.end` (records the
arm outcome on the ledger; `merged: true` once GitHub completes the
squash, `merged: false` with a reason for predicate-blocked or
armed-but-pending):

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.automerge.end --pr-url <prUrl> --merged <true|false>
```

### Recording manual interventions

Whenever you step outside the happy path during a delivery, record it
(each entry disqualifies auto-merge):

```bash
node .agents/scripts/epic-deliver-note-intervention.js \
  --epic <epicId> --reason "<one-line description>"
```

Triggers: `AskUserQuestion` mid-run; `git restore`/`reset` against the
tree; child-reported `--no-ff` recovery, stash dance, or out-of-band
merge surgery; child closes via `--skipValidation`; force-pushing or
empty-committing to dodge CI diagnosis.

---

## Phase 9 — Local branch cleanup

Phase 9 runs **automatically** inside the lifecycle bus once auto-merge
arms: the `BranchCleaner` listener subscribes to `epic.cleanup.start`
and reaps local refs before `Cleaner` archives the `temp/epic-<id>/`
tree. No operator step is required on the auto-merge path.

What gets reaped (in order, all in-process):

1. The main checkout is switched off `epic/<id>` to `baseBranch` when
   needed (otherwise `git branch -D epic/<id>` is refused).
2. Every `story-<id>` listed in the `epic-run-state` checkpoint, plus
   `epic/<id>`. Attached worktrees are removed with the standard
   `git worktree remove` → `--force` → filesystem-rm fallback (the
   last step covers Windows file-locks).
3. `git remote prune <remote>` drops stale `<remote>/...` tracking
   refs left behind by `gh pr merge --delete-branch`.
4. The `wt-branch` scratch ref left by `story-close.js`'s internal
   merge worktree is deleted when no worktree still points at it.

Per-branch failures aggregate into the listener's classification log
(`reaped` / `failed` / `no-state` / `skipped-duplicate`) and are
visible in `temp/epic-<id>/lifecycle.ndjson`. They do not block the
rest of cleanup.

For out-of-band cleanup re-entry (resume after a crash, or operator
override), fire `epic.merge.armed` via the lifecycle-emit helper:

```bash
node .agents/scripts/lifecycle-emit.js --epic <epicId> \
  --event epic.merge.armed --pr-url <prUrl>
```

If Phase 8.5 fell back to the operator-merges-button path (`gh pr
merge --auto` was declined), the `epic.merge.armed` event never fires
inside this run and Phase 9 will not run automatically. After the
operator merges the PR, `epic/<epicId>` and each `story-<id>` ref can
be reaped manually:

```bash
git checkout main
git pull --ff-only origin main
git branch -D epic/<epicId>
git branch -D story-<id1> story-<id2> ...
git remote prune origin
```

Note that `git-cleanup.js` alone will not catch `story-<id>` refs in
this case because the epic PR squash-merges break the `git branch
--merged main` signal and the stories never had their own PRs. Wiring
a CLI surface that drives the BranchCleaner listener for this
fallback is tracked as follow-up to Story #2398.

---

## Idempotence and resume

Re-runs pick up at the next undispatched wave (in-flight Stories finish
via `helpers/epic-deliver-story`'s own checkpointing). The PR from Phase 7 is
updated in place on subsequent runs. The authoritative live view is
the `epic-run-progress` structured comment.

---

## Constraints

- **Never** merge `epic/<epicId>` to `main` outside Phase 8.5.
- **Never** dispatch more than one wave at a time; concurrency lives
  inside a single wave's fan-out, capped at `concurrencyCap`.
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
