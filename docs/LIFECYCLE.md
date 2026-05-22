# Lifecycle Event Bus — Reference

This document is the canonical reference for the `/epic-deliver` lifecycle
event bus introduced by Epic #2172. It supersedes the prior "runner CLI
shells emit comments inline" model: a single typed event bus inside the
operator's session is now the only authorised emitter of phase
transitions, and a fixed roster of single-purpose listeners maps those
events to ticket state, structured comments, notifications, and the
on-disk audit ledger.

The bus is the operational system-of-record for an Epic run. Resume,
observability, and safety gates all read from the ledger it writes; no
side-effecting code is permitted to fire without first traversing the
bus.

---

## 1. Bus contract

Source: [`lib/orchestration/lifecycle/bus.js`](../.agents/scripts/lib/orchestration/lifecycle/bus.js).

- **Sequential mediator.** Listeners run in registration order, awaited
  one at a time. There is no `Promise.all` over listener arrays — that
  pattern is forbidden by a lint rule because it breaks the ledger's
  emitted-before-completed ordering and resume semantics.
- **Schema validation before fan-out.** Every `emit()` validates the
  payload against the JSON Schema at
  `.agents/schemas/lifecycle/<event>.schema.json` BEFORE any listener
  runs. A validation failure throws immediately, no `emitted` ledger
  record is written, and no listener fires.
- **Throw-on-first.** A throw from any listener short-circuits the
  remaining listeners and propagates to the caller. The `failed` ledger
  record captures the error.
- **Wildcard subscriptions** (`bus.on('*', fn)`) are permitted for trace
  and heartbeat observers; the side-effect firewall in
  [`listeners/README.md`](../.agents/scripts/lib/orchestration/lifecycle/listeners/README.md)
  prohibits state-mutating imports from wildcard listeners.
- **No re-entry.** Listeners MUST NOT call `bus.emit()` from inside a
  listener body. The bus is not re-entrant.

### seqId guarantee

Every emit is stamped with a monotonically increasing `seqId` per bus
instance. Listeners are required to be idempotent on `(event, seqId)`
because the resume path may replay a single seqId when an `emitted`
record landed on disk but its matching `completed` did not. The
canonical idempotency pattern is a per-instance `Set<seqId>` checked at
the top of the listener body.

### Secret strip

`LedgerWriter` recursively strips keys in `SECRET_KEY_DENY_LIST`
(`token`, `password`, `secret`, `apikey`, `webhookurl`) from every
payload before writing. The denylist is a defence-in-depth layer — event
payloads are never supposed to carry secrets — but the strip means a
future contributor cannot accidentally leak a token into the ledger,
which is treated as an artifact safe to attach to PR comments.

---

## 2. Event taxonomy

The full set of typed events is the union of all
`<event>.schema.json` files in
[`.agents/schemas/lifecycle/`](../.agents/schemas/lifecycle/) (the
`ledger-record.schema.json` file describes the on-disk record envelope,
not an event). Each event has exactly one schema; the schema is the
contract.

### Epic phase events

| Event                       | Emitted when                                                |
| --------------------------- | ----------------------------------------------------------- |
| `epic.plan.start`           | `/epic-plan` Phase 1 begins.                                |
| `epic.plan.end`             | `/epic-plan` Phase 7 closes the planning run.               |
| `epic.snapshot.start`       | `/epic-deliver` Phase 1 — snapshot phase opens.             |
| `epic.snapshot.end`         | Snapshot complete; wave plan persisted.                     |
| `epic.finalize.start`       | Phase 6 finalize begins (PR-open).                          |
| `epic.finalize.end`         | Finalize completed; PR opened (or skipped).                 |
| `epic.close.start`          | Close-validation chain opens.                               |
| `epic.close.end`            | Close-validation chain completes.                           |
| `epic.automerge.start`      | Phase 7.5 emit shim fires.                                  |
| `epic.automerge.end`        | Automerge phase concludes.                                  |
| `epic.cleanup.start`        | Phase 8 cleanup shim fires.                                 |
| `epic.cleanup.end`          | Cleanup archive + branch reap complete.                     |
| `epic.complete`             | Terminal event — Epic merged, cleaned, retro posted.        |
| `epic.blocked`              | Epic enters `agent::blocked` (HITL gate).                   |
| `epic.unblocked`            | Operator returns Epic to `agent::executing`.                |
| `epic.watch.start`          | `Watcher` begins polling `gh pr checks`.                    |
| `epic.watch.end`            | `Watcher` resolves a terminal check verdict.                |
| `epic.merge.ready`          | `AutomergePredicate` clean — armed-merge authorised.        |
| `epic.merge.blocked`        | `AutomergePredicate` dirty — operator-merges-button path.   |
| `epic.merge.armed`          | `AutomergeArmer` armed GitHub native auto-merge.            |

### Wave + Story events

| Event                       | Emitted when                                                |
| --------------------------- | ----------------------------------------------------------- |
| `wave.start`                | Wave fan-out opens (one event per wave).                    |
| `wave.end`                  | All Stories in the wave reached a terminal state.           |
| `story.dispatch.start`      | A Story sub-agent is launched.                              |
| `story.dispatch.end`        | A Story sub-agent returned (done / blocked / failed).       |
| `story.merged`              | Story branch merged into `epic/<epicId>`.                   |
| `story.blocked`             | Story transitioned to `agent::blocked`.                     |

### Reconciliation + supporting events

| Event                          | Emitted when                                             |
| ------------------------------ | -------------------------------------------------------- |
| `acceptance.reconcile.start`   | Acceptance-spec reconciler begins.                       |
| `acceptance.reconcile.ok`      | Reconcile completed with no diff vs spec.                |
| `acceptance.reconcile.failed`  | Reconcile completed but the spec drifted; halt or warn.  |
| `acceptance.reconcile.waived`  | Reconciler waived by `acceptance::n-a` label (Finalizer routes to PR). |
| `acceptance.reconcile.skipped` | Reconciler skipped (empty Acceptance Spec; no PR).        |
| `close-validate.start`         | Close-validation gates open.                             |
| `close-validate.end`           | Close-validation gates close (pass or fail).             |
| `code-review.start`            | Phase 4 inline audit opens.                              |
| `code-review.end`              | Audit completed.                                         |
| `retro.start`                  | Phase 5 retro authoring opens.                           |
| `retro.end`                    | Retro persisted.                                         |
| `pr.created`                   | `gh pr create` returned a PR URL.                        |
| `checkpoint.written`           | `CheckpointPointerWriter` persisted a resume pointer.    |
| `notification.emitted`         | `NotifyDispatcher` fanned a webhook event.               |

The numeric count of typed events is the file count under
`.agents/schemas/lifecycle/` minus `ledger-record.schema.json`. Treat the
schema directory — not this table — as the source of truth when adding a
new event.

### Schema-backed roster

The table below is regenerated from `.agents/schemas/lifecycle/*.schema.json`
by [`generate-lifecycle-docs.js`](../.agents/scripts/generate-lifecycle-docs.js).
Run `node .agents/scripts/generate-lifecycle-docs.js` after adding or editing
a lifecycle schema; the drift gate is
`node .agents/scripts/generate-lifecycle-docs.js --check`.

<!-- BEGIN GENERATED:lifecycle-events -->

| Event | Schema | Description | Required fields |
| --- | --- | --- | --- |
| `acceptance.reconcile.failed` | [`acceptance.reconcile.failed.schema.json`](../.agents/schemas/lifecycle/acceptance.reconcile.failed.schema.json) | Emitted by AcceptanceReconciler when reconciliation fails. Routes to epic.blocked; no PR is created. | `baseRead`, `reason` |
| `acceptance.reconcile.ok` | [`acceptance.reconcile.ok.schema.json`](../.agents/schemas/lifecycle/acceptance.reconcile.ok.schema.json) | Emitted by AcceptanceReconciler when reconciliation passes. Finalizer subscribes only to this event to gate the push and PR create. | `baseRead` |
| `acceptance.reconcile.skipped` | [`acceptance.reconcile.skipped.schema.json`](../.agents/schemas/lifecycle/acceptance.reconcile.skipped.schema.json) | Emitted by AcceptanceReconciler when reconciliation is skipped because the linked Acceptance Spec declares zero AC IDs ('empty-spec'). Story #2893 split the `acceptance::n-a` waiver path out to `acceptance.reconcile.waived` so the Finalizer can route waived Epics through to PR creation while empty-spec Epics still terminate without a PR. The reason field is required so the listener never silently no-ops. | `baseRead`, `reason` |
| `acceptance.reconcile.start` | [`acceptance.reconcile.start.schema.json`](../.agents/schemas/lifecycle/acceptance.reconcile.start.schema.json) | Emitted by AcceptanceReconciler at the start of acceptance-spec reconciliation. Must precede pr.created in every healthy run (reconciliation ordering invariant). | `epicId` |
| `acceptance.reconcile.waived` | [`acceptance.reconcile.waived.schema.json`](../.agents/schemas/lifecycle/acceptance.reconcile.waived.schema.json) | Emitted by AcceptanceReconciler when reconciliation is waived by the acceptance::n-a label. Distinct from acceptance.reconcile.skipped (which now means 'empty-spec' only) so the Finalizer can subscribe to .waived and route waived Epics through to PR creation while empty-spec Epics still terminate without a PR. The reason field is required and pinned to 'waiver'. | `baseRead`, `reason` |
| `checkpoint.written` | [`checkpoint.written.schema.json`](../.agents/schemas/lifecycle/checkpoint.written.schema.json) | Self-emitted by CheckpointPointerWriter after the pointer file is updated. Carries the phase header for tracing and the last-completed seqId for the resume contract. | `phase`, `lastCompletedSeqId` |
| `close-validate.end` | [`close-validate.end.schema.json`](../.agents/schemas/lifecycle/close-validate.end.schema.json) | Emitted at the end of the close-validate sub-phase. ok=true => every gate passed; ok=false => failedGate identifies the first failed gate. durationMs is wall-clock time spent in the gate chain. Story #2250. | `epicId`, `storyId`, `ok` |
| `close-validate.start` | [`close-validate.start.schema.json`](../.agents/schemas/lifecycle/close-validate.start.schema.json) | Emitted at the start of the close-validate sub-phase (pre-merge gate chain typecheck/lint/test/format/maintainability/crap). Story #2250. | `epicId`, `storyId` |
| `code-review.end` | [`code-review.end.schema.json`](../.agents/schemas/lifecycle/code-review.end.schema.json) | Emitted at the end of the code-review sub-phase. Carries a review-finding severity summary so the lifecycle ledger surfaces critical/high/medium/suggestion counts directly. The payload MUST NOT carry any secret-key-denylist fields (token, password, secret, apiKey, webhookUrl) — the LedgerWriter enforces this, but the schema's `additionalProperties: false` keeps the surface tight. Story #2252. | `epicId`, `status` |
| `code-review.start` | [`code-review.start.schema.json`](../.agents/schemas/lifecycle/code-review.start.schema.json) | Emitted at the start of the code-review sub-phase (Phase D of the close-tail). Story #2252. | `epicId` |
| `epic.automerge.end` | [`epic.automerge.end.schema.json`](../.agents/schemas/lifecycle/epic.automerge.end.schema.json) | Emitted at the end of the automerge phase wrapper. merged=true means GitHub completed the squash; merged=false with a reason captures predicate-blocked or armed-but-pending outcomes. | `prUrl`, `merged` |
| `epic.automerge.start` | [`epic.automerge.start.schema.json`](../.agents/schemas/lifecycle/epic.automerge.start.schema.json) | Emitted at the start of the automerge phase wrapper. Distinct from epic.merge.ready (predicate outcome) and epic.merge.armed (arm outcome). | `prUrl` |
| `epic.blocked` | [`epic.blocked.schema.json`](../.agents/schemas/lifecycle/epic.blocked.schema.json) | Emitted by BlockerHandler (or TimeoutWatchdog) when the Epic transitions to agent::blocked. The reason field carries either a typed marker (timeout:<event>, waiver, …) or a free-form summary; sourceStoryId scopes the blocker to a child Story when applicable. | `reason` |
| `epic.cleanup.end` | [`epic.cleanup.end.schema.json`](../.agents/schemas/lifecycle/epic.cleanup.end.schema.json) | Emitted by Cleaner when branch cleanup and temp archive complete. | `epicId` |
| `epic.cleanup.start` | [`epic.cleanup.start.schema.json`](../.agents/schemas/lifecycle/epic.cleanup.start.schema.json) | Emitted by Cleaner at the start of branch cleanup + temp archive. | `epicId` |
| `epic.close.end` | [`epic.close.end.schema.json`](../.agents/schemas/lifecycle/epic.close.end.schema.json) | Emitted when the close-tail phase finishes; AcceptanceReconciler subscribes to this event to gate finalize. | `epicId` |
| `epic.close.start` | [`epic.close.start.schema.json`](../.agents/schemas/lifecycle/epic.close.start.schema.json) | Emitted when the close-tail phase begins (close-validate / code-review / retro). | `epicId` |
| `epic.complete` | [`epic.complete.schema.json`](../.agents/schemas/lifecycle/epic.complete.schema.json) | Terminal event for a successful Epic run. LabelTransitioner subscribes to this event to flip the Epic to agent::done. | `epicId`, `prUrl` |
| `epic.finalize.end` | [`epic.finalize.end.schema.json`](../.agents/schemas/lifecycle/epic.finalize.end.schema.json) | Emitted by Finalizer after the PR is opened (or short-circuited by gh pr list --head idempotency check). | `epicId`, `prUrl` |
| `epic.finalize.start` | [`epic.finalize.start.schema.json`](../.agents/schemas/lifecycle/epic.finalize.start.schema.json) | Emitted by Finalizer at the start of the finalize phase (fast-forward / hotspot / baseline / push / gh pr create). | `epicId` |
| `epic.merge.armed` | [`epic.merge.armed.schema.json`](../.agents/schemas/lifecycle/epic.merge.armed.schema.json) | Emitted by AutomergeArmer after gh pr merge --auto --squash --delete-branch succeeds. Must be preceded by epic.merge.ready from the same run (merge-gate ordering invariant). | `prUrl` |
| `epic.merge.blocked` | [`epic.merge.blocked.schema.json`](../.agents/schemas/lifecycle/epic.merge.blocked.schema.json) | Emitted by AutomergePredicate when the Epic is NOT safe to auto-merge. AutomergeArmer never sees this event; PR stays disarmed. | `prUrl`, `reason` |
| `epic.merge.confirmed` | [`epic.merge.confirmed.schema.json`](../.agents/schemas/lifecycle/epic.merge.confirmed.schema.json) | Emitted by MergeWatcher after gh pr view --json mergeCommit,mergedAt returns a non-null mergeCommit for the armed Epic PR. Strictly downstream of epic.merge.armed; carries the observed mergeCommit SHA, mergedAt timestamp, and the cumulative poll count (Story #2896, Epic #2880). | `epicId`, `prUrl`, `mergeCommitSha`, `pollAttempts` |
| `epic.merge.ready` | [`epic.merge.ready.schema.json`](../.agents/schemas/lifecycle/epic.merge.ready.schema.json) | Emitted by AutomergePredicate when the Epic is safe to auto-merge. The ONLY event AutomergeArmer subscribes to. | `prUrl` |
| `epic.plan.end` | [`epic.plan.end.schema.json`](../.agents/schemas/lifecycle/epic.plan.end.schema.json) | Emitted when the runner finishes building the wave DAG. | `waves` |
| `epic.plan.start` | [`epic.plan.start.schema.json`](../.agents/schemas/lifecycle/epic.plan.start.schema.json) | Emitted when the runner begins planning waves for an Epic. | `epicId` |
| `epic.snapshot.end` | [`epic.snapshot.end.schema.json`](../.agents/schemas/lifecycle/epic.snapshot.end.schema.json) | Emitted when the snapshot phase finishes; carries enumerated story IDs the Epic owns. | `epicId`, `storyIds` |
| `epic.snapshot.start` | [`epic.snapshot.start.schema.json`](../.agents/schemas/lifecycle/epic.snapshot.start.schema.json) | Emitted when the runner enters the snapshot phase for an Epic. | `epicId` |
| `epic.unblocked` | [`epic.unblocked.schema.json`](../.agents/schemas/lifecycle/epic.unblocked.schema.json) | Emitted by BlockerHandler when the Epic returns to agent::executing after operator unblock. | `reason` |
| `epic.watch.end` | [`epic.watch.end.schema.json`](../.agents/schemas/lifecycle/epic.watch.end.schema.json) | Emitted by Watcher when required checks settle. checkOutcomes maps check-name → terminal state (success \| failure \| timed_out \| skipped). AutomergePredicate subscribes to this event. | `prUrl`, `checkOutcomes` |
| `epic.watch.start` | [`epic.watch.start.schema.json`](../.agents/schemas/lifecycle/epic.watch.start.schema.json) | Emitted by Watcher when required-check polling begins. Required-check names are resolved from GitHub at runtime via gh pr checks, not from .agentrc.json. | `prUrl`, `requiredChecks` |
| `intervention.recorded` | [`intervention.recorded.schema.json`](../.agents/schemas/lifecycle/intervention.recorded.schema.json) | Emitted whenever the host LLM performs an out-of-band manual intervention during an Epic delivery (e.g., AskUserQuestion, manual git restore/reset, --no-ff recovery merge, story-close --skipValidation). The InterventionRecorder listener appends the payload to the epic-run-state-store's manualInterventions array; a non-empty array disqualifies the Epic from auto-merge. | `epicId`, `reason` |
| `ledger-record` | [`ledger-record.schema.json`](../.agents/schemas/lifecycle/ledger-record.schema.json) | Append-only NDJSON record shape for temp/epic-<id>/lifecycle.ndjson. Three discriminated kinds; consumers (LedgerWriter, lifecycle-diff CLI, TraceLogger) discriminate on `kind`. | — |
| `notification.emitted` | [`notification.emitted.schema.json`](../.agents/schemas/lifecycle/notification.emitted.schema.json) | Self-emitted by NotifyDispatcher after each webhook/comment dispatch. Carries the upstream event name, the channel, the severity, and the ok flag for trace fidelity. | `event`, `channel`, `severity`, `ok` |
| `pr.created` | [`pr.created.schema.json`](../.agents/schemas/lifecycle/pr.created.schema.json) | Emitted by Finalizer immediately after gh pr create (or short-circuit). Must be preceded by acceptance.reconcile.ok from the same run. | `prUrl`, `head`, `base` |
| `retro.end` | [`retro.end.schema.json`](../.agents/schemas/lifecycle/retro.end.schema.json) | Emitted at the end of the retro sub-phase. `posted` indicates whether the retro structured comment was upserted onto the Epic; `retroPath` is the local mirror path under temp/epic-<id>/ when written. Story #2252. | `epicId`, `posted` |
| `retro.start` | [`retro.start.schema.json`](../.agents/schemas/lifecycle/retro.start.schema.json) | Emitted at the start of the retro sub-phase (Phase E of the close-tail). Story #2252. | `epicId` |
| `story.blocked` | [`story.blocked.schema.json`](../.agents/schemas/lifecycle/story.blocked.schema.json) | Emitted from the story-close path when a Story transitions to agent::blocked. | `storyId`, `reason` |
| `story.dispatch.end` | [`story.dispatch.end.schema.json`](../.agents/schemas/lifecycle/story.dispatch.end.schema.json) | Emitted by wave-session when a child story sub-agent returns. Sibling ordering within a wave is not guaranteed; ordering between waves is. | `storyId`, `outcome`, `durationMs` |
| `story.dispatch.start` | [`story.dispatch.start.schema.json`](../.agents/schemas/lifecycle/story.dispatch.start.schema.json) | Emitted before a story is handed to the host-LLM for Agent-tool fanout. The wave-session path emits the minimal {storyId, waveIndex} shape inline; lifecycle-emit-story-dispatch.js emits the extended {storyId, waveIndex, dispatchedAt, attempt} shape so /epic-deliver's host loop can durably ledger every dispatch attempt for in-flight reconciliation (Story #2891). | `storyId`, `waveIndex` |
| `story.merged` | [`story.merged.schema.json`](../.agents/schemas/lifecycle/story.merged.schema.json) | Emitted from the story-close path after a Story branch successfully merges into epic/<id>. | `storyId`, `sha` |
| `wave.end` | [`wave.end.schema.json`](../.agents/schemas/lifecycle/wave.end.schema.json) | Emitted by iterate-waves when a wave settles. The outcomes object must carry exactly the story IDs from the matching wave.start (Repeatability AC #5 — wave completeness invariant). Epic #2646 Story C — optional `totalWaves`, `startedAt`, `completedAt`, `durationMs`, and `stories[]` enrich the comment body emitted by structured-comment-poster (replaces the legacy wave-observer writer). `stories[]` carries per-story commit-assertion deltas so a reclassified `done → failed` row surfaces in the wave-end comment body. | `waveIndex`, `outcomes` |
| `wave.start` | [`wave.start.schema.json`](../.agents/schemas/lifecycle/wave.start.schema.json) | Emitted by iterate-waves when a wave begins; lists story IDs dispatched in this wave. Epic #2646 Story C — optional `totalWaves`, `stories`, and `startedAt` enrich the comment body emitted by structured-comment-poster (replaces the legacy wave-observer writer). | `waveIndex`, `storyIds` |

<!-- END GENERATED:lifecycle-events -->

---

## 3. Ledger format

The bus writes two on-disk artifacts per Epic run, both rooted at
`temp/epic-<id>/`:

### Canonical NDJSON: `lifecycle.ndjson`

Append-only, one JSON record per line. Source:
[`lib/orchestration/lifecycle/ledger-writer.js`](../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js).

Each successful emit produces two records:

1. `{ "kind": "emitted", "seqId": <n>, "event": <name>, "payload": {...} }`
   — written BEFORE any listener fires.
2. `{ "kind": "completed", "seqId": <n>, "event": <name> }` — written
   AFTER every listener returned without throwing.

A listener throw produces `emitted` followed by
`{ "kind": "failed", "seqId": <n>, "event": <name>, "error": "..." }`.

This shape is the resume contract: an `emitted` line without a matching
`completed` or `failed` is the canonical resume target. The ledger is
written synchronously (`appendFileSync`) so resume can rely on
durability without an explicit flush.

### Markdown companion: `lifecycle.md`

Rendered by
[`lib/orchestration/lifecycle/trace-logger.js`](../.agents/scripts/lib/orchestration/lifecycle/trace-logger.js)
as a human-readable trace of the run. The companion is regenerated from
the canonical NDJSON on every emit, so it is always consistent with the
ledger but is **not** the source of truth — diffs and resume read the
NDJSON.

### Resume

Resume is ledger-driven. The resume helper reads
`temp/epic-<id>/lifecycle.ndjson`, finds the highest seqId with a
terminal record (`completed` or `failed`), and replays the bus from
that point. Idempotent listeners (`Set<seqId>` guard) make the replay
safe — the NDJSON ledger is the sole source of truth for resume.

---

## 4. Listener model

Listeners live in
[`lib/orchestration/lifecycle/listeners/`](../.agents/scripts/lib/orchestration/lifecycle/listeners/).
Each listener does exactly one thing in response to its subscribed
events. The runner factory composes them in a fixed order so the ledger
boundary is always the first writer.

| Listener                     | Subscribes to                                                                                  | Side effect                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `LedgerWriter`               | `*` (registered first on every event)                                                          | Append `emitted` / `completed` / `failed` rows to `lifecycle.ndjson`.|
| `TraceLogger`                | `*` (wildcard trace observer)                                                                  | Re-render the `lifecycle.md` companion.                              |
| `LabelTransitioner`          | `wave.end`, `story.merged`, `story.blocked`, `epic.blocked`, `epic.unblocked`, `epic.complete` | Flip ticket `agent::*` labels via `transitionTicketState`.           |
| `StructuredCommentPoster`    | `wave.start`, `wave.end`, `epic.blocked`, `epic.unblocked`                                     | Upsert lifecycle-tagged structured comments on the Epic ticket.      |
| `ProgressReporter`           | `wave.end`, `story.dispatch.end`                                                               | Re-compose the `epic-run-progress` comment.                          |
| `SignalsAppender`            | `story.dispatch.end`, `story.blocked`, `wave.end`                                              | Append idempotent rows to `temp/epic-<id>/signals.ndjson`.           |
| `NotifyDispatcher`           | `*` (dynamic; `epic.snapshot.start`, `wave.end`, `epic.blocked`, `epic.unblocked`, `epic.complete` via `LIFECYCLE_TO_WEBHOOK_EVENT`) | Fan out the @mention + webhook channels via `notify.js`.             |
| `CheckpointPointerWriter`    | `*` (dynamic `*.end` events sourced from `SUBSCRIBED_END_EVENTS`)                              | Persist a resume pointer in `epic-run-state`.                        |
| `AcceptanceReconciler`       | `epic.close.end` (gated by waiver label)                                                       | Reconcile AC IDs against the linked acceptance-spec ticket.          |
| `Finalizer`                  | `acceptance.reconcile.ok`, `acceptance.reconcile.waived`                                       | Open or locate the Epic PR, close planning tickets, post the handoff comment; emit `epic.merge.ready`. |
| `MergeWatcher`               | `epic.merge.armed`                                                                             | Poll `gh pr view` until `mergeCommit` is non-null; emit `epic.merge.confirmed`. |
| `Watcher`                    | `pr.created`                                                                                   | Resolve required-check names; poll `gh pr checks`; emit `epic.watch.end`. |
| `AutomergePredicate`         | `epic.watch.end`                                                                               | Evaluate predicate signals; emit `epic.merge.ready` or `epic.merge.blocked`. |
| `AutomergeArmer`             | `epic.merge.ready` **only**                                                                    | Arm GitHub native auto-merge — the SOLE production code path authorised to call `gh pr merge`. |
| `Cleaner`                    | `epic.merge.confirmed`                                                                         | Archive `temp/epic-<id>/`; emit `epic.cleanup.start` / `epic.cleanup.end` / `epic.complete`. |
| `BranchCleaner`              | `epic.cleanup.start`                                                                           | Reap local `story-<id>` and `epic/<id>` refs; prune remote tracking. |
| `InterventionRecorder`       | `intervention.recorded`                                                                        | Append manual-intervention entries to `epic-run-state` (disqualifies auto-merge). |
| `TimeoutWatchdog`            | `*` (wildcard observer with bounded timer)                                                     | Halt the run when a wave / phase exceeds its budget.                 |
| `HeartbeatMonitor`           | `*` (wildcard observer)                                                                        | Emit periodic heartbeat traces so external watchers can detect a stuck run. |
| `BlockerHandler`             | `story.blocked`                                                                                | The sole runtime pause point — halts execution, waits to resume.     |

### Side-effect firewall

Listeners MAY read tickets via the injected provider, write tickets via
`transitionTicketState`, upsert structured comments, and append to the
per-Epic ledger / signals files. Listeners MUST NOT call `bus.emit()`
from inside a listener body, import runner state directly, or mutate
cross-cutting globals.

The "merge-lockout" lint rule
([`.agents/scripts/check-lifecycle-lint.js`](../.agents/scripts/check-lifecycle-lint.js))
enforces that the literal `gh pr merge` call lives only inside
`AutomergeArmer`. Any other module that re-introduces the string fails
lint.

---

## 5. Emit boundaries

The lifecycle bus is the sole runtime; every side effect at a phase
boundary is owned by a listener that subscribes to a typed event. The
`/epic-deliver` workflow markdown reaches the bus through a single
generic CLI — there are no per-phase shim scripts.

- [`.agents/scripts/lifecycle-emit.js`](../.agents/scripts/lifecycle-emit.js)
  — generic argv-driven emit helper. Phase 6 fires `epic.close.end`,
  Phase 7.5 fires `epic.automerge.start`, Phase 8 fires
  `epic.merge.armed`. Schema validation in the bus catches missing or
  malformed payload fields before any listener runs.
- [`.agents/scripts/notify.js`](../.agents/scripts/notify.js) — single
  dispatch entry point for webhook / @mention channels. The canonical
  caller is the `NotifyDispatcher` listener; out-of-band operator
  invocations (smoke-testing a channel, replaying a missed notification)
  remain supported.

Inside the session, the runner factory wires the listener roster onto
the bus before the wave loop starts; emits from `lifecycle-emit.js`
re-enter the same chain. The ledger writes (`emitted` → listener fan-out
→ `completed` / `failed`) make the replay deterministic.

---

## 6. Related references

- [`docs/architecture.md`](architecture.md) — system overview; the
  Orchestration Engine and Epic Deliver Runner sections describe how
  the bus fits into the larger SDL.
- [`.agents/SDLC.md`](../.agents/SDLC.md) — end-to-end SDLC narrative;
  the Phase 3 (Delivery) section names the bus as the runtime
  coordinator.
- [`.agents/workflows/epic-deliver.md`](../.agents/workflows/epic-deliver.md)
  — operator-facing `/epic-deliver` runbook.
- [`docs/decisions.md`](decisions.md) — architectural decisions log;
  the Epic #2172 entry records the rationale for the bus refit.
