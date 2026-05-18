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
| `acceptance.reconcile.skipped` | Reconciler skipped (waiver label or no spec).            |
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
| `StructuredCommentPoster`    | `wave.start`, `wave.end` (and the Epic-scoped reconciliation events)                           | Upsert lifecycle-tagged structured comments on the Epic ticket.      |
| `ProgressReporter`           | `wave.end`, `story.dispatch.end`                                                               | Re-compose the `epic-run-progress` comment.                          |
| `SignalsAppender`            | `wave.start`, `wave.end`, `story.dispatch.*`                                                   | Append idempotent rows to `temp/epic-<id>/signals.ndjson`.           |
| `NotifyDispatcher`           | The curated webhook subset (`epic-*` events)                                                   | Fan out the @mention + webhook channels via `notify.js`.             |
| `CheckpointPointerWriter`    | `wave.end`, `epic.finalize.start`, `epic.complete`                                             | Persist a resume pointer in `epic-run-state`.                        |
| `AcceptanceReconciler`       | `epic.close.start` (gated by waiver label)                                                     | Reconcile AC IDs against the linked acceptance-spec ticket.          |
| `Finalizer`                  | `epic.finalize.start`                                                                          | FF-merge `epic/<id>` onto `main`, push, open the PR, close planning tickets, post the handoff comment. |
| `Watcher`                    | `pr.created`                                                                                   | Resolve required-check names; poll `gh pr checks`; emit `epic.watch.end`. |
| `AutomergePredicate`         | `epic.watch.end`                                                                               | Evaluate predicate signals; emit `epic.merge.ready` or `epic.merge.blocked`. |
| `AutomergeArmer`             | `epic.merge.ready` **only**                                                                    | Arm GitHub native auto-merge — the SOLE production code path authorised to call `gh pr merge`. |
| `Cleaner`                    | `epic.merge.armed`                                                                             | Archive `temp/epic-<id>/`; emit `epic.cleanup.start` / `epic.cleanup.end` / `epic.complete`. |
| `TimeoutWatchdog`            | `*` (wildcard observer with bounded timer)                                                     | Halt the run when a wave / phase exceeds its budget.                 |
| `HeartbeatMonitor`           | `*` (wildcard observer)                                                                        | Emit periodic heartbeat traces so external watchers can detect a stuck run. |
| `BlockerHandler`             | `epic.blocked`                                                                                 | The sole runtime pause point — halts execution, waits to resume.     |

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
