# Lifecycle Event Bus — Reference

This document is the canonical reference for the lifecycle event bus
introduced by Epic #2172 (and retained through the v2 Story collapse).
A typed event bus inside the operator's session is the authorised
emitter of phase transitions for delivery runs; listeners map those
events to ticket state, structured comments, notifications, and the
on-disk audit ledger.

> **v2 note.** Live delivery is **Story-only**
> (`helpers/deliver-story` → `single-story-init` / `single-story-close` /
> `single-story-confirm-merge`). Epic-scoped listener chains
> (`lifecycle-emit.js`, AutomergeArmer, Finalizer, Cleaner, …) were
> removed; new runs write under `temp/run-<id>/`. Story #4545 deleted the
> `epic.*` and `acceptance.reconcile.*` schemas whose emitters went with
> those chains — a schema with no producer documents an event that can
> never appear, which is worse than absent. An event schema earns its place
> here only while code emits it.

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

### Live Story delivery events

| Event                       | Emitted when                                                |
| --------------------------- | ----------------------------------------------------------- |
| `story.dispatch.start`      | A Story delivery worker is launched.                        |
| `story.dispatch.end`        | A Story delivery worker returned (done / blocked / failed). |
| `story.heartbeat`           | Story-phase heartbeat during implementation.                |
| `story.blocked`             | Story transitioned to `agent::blocked`.                     |
| `close-validate.start` / `.end` | Close-validation gates open / close.                    |
| `code-review.start` / `.end` | Inline review sub-phase.                                   |
| `pr.created`                | `gh pr create` returned a PR URL.                           |
| `merge.unlanded`            | Headless Story delivery finished without a confirmed merge. |
| `loop.tick`                 | One pass of a host-driven loop (idle-watchdog visibility).  |
| `notification.emitted`      | Notify path fanned a webhook event.                         |
| `checkpoint.written`        | Resume pointer persisted.                                   |

### Historical Epic events (schemas deleted)

Pre-v2 Epic delivery emitted `epic.*`, `story.merged` (into `epic/<id>`),
`acceptance.reconcile.*`, and related events. Story #4545 deleted the
`epic.*` and `acceptance.reconcile.*` schemas along with the emitters the
cutover had already removed — the roster below is schema-file-driven, so
retaining them rendered dead events into this document as if they were live.
Archived ledgers stay readable regardless: `lifecycle.ndjson` is plain NDJSON
and reading it never consults a schema (only `bus.emit()` validates, and only
on the write path).

`epic.watch.start` / `.end` were retired with the rest: their only
production consumer (`pr-watch-with-update.js`) drives the poll loop in
[`listeners/watcher.js`](../.agents/scripts/lib/orchestration/lifecycle/listeners/watcher.js)
directly, without a bus, so the events were never observable in production
ledgers and their schemas were deleted.

> **Loop ticks vs Story heartbeats.** `loop.tick` is distinct from
> `story.heartbeat`: it is emitted once per pass of a host-driven loop,
> not tied to any Story tier. Emit it through
> [`emit-loop-tick.js`](../.agents/scripts/lib/orchestration/lifecycle/emit-loop-tick.js).

### Schema-backed roster

The table below is regenerated from `.agents/schemas/lifecycle/*.schema.json`
by [`generate-lifecycle-docs.js`](../.agents/scripts/generate-lifecycle-docs.js).
Run `node .agents/scripts/generate-lifecycle-docs.js` after adding or editing
a lifecycle schema; the drift gate is
`node .agents/scripts/generate-lifecycle-docs.js --check`.

<!-- BEGIN GENERATED:lifecycle-events -->

| Event | Schema | Description | Required fields |
| --- | --- | --- | --- |
| `checkpoint.written` | [`checkpoint.written.schema.json`](../.agents/schemas/lifecycle/checkpoint.written.schema.json) | Self-emitted by CheckpointPointerWriter after the pointer file is updated. Carries the phase header for tracing and the last-completed seqId for the resume contract. | `phase`, `lastCompletedSeqId` |
| `close-validate.end` | [`close-validate.end.schema.json`](../.agents/schemas/lifecycle/close-validate.end.schema.json) | Emitted at the end of the close-validate sub-phase. ok=true => every gate passed; ok=false => failedGate identifies the first failed gate. durationMs is wall-clock time spent in the gate chain. Story #2250. | `epicId`, `storyId`, `ok` |
| `close-validate.start` | [`close-validate.start.schema.json`](../.agents/schemas/lifecycle/close-validate.start.schema.json) | Emitted at the start of the close-validate sub-phase (pre-merge gate chain typecheck/lint/test/format/maintainability/crap). Story #2250. | `epicId`, `storyId` |
| `code-review.end` | [`code-review.end.schema.json`](../.agents/schemas/lifecycle/code-review.end.schema.json) | Emitted at the end of the code-review sub-phase. Carries a review-finding severity summary so the lifecycle ledger surfaces critical/high/medium/suggestion counts directly. The payload MUST NOT carry any secret-key-denylist fields (token, password, secret, apiKey, webhookUrl) — the LedgerWriter enforces this, but the schema's `additionalProperties: false` keeps the surface tight. Story #2252. | `epicId`, `status` |
| `code-review.start` | [`code-review.start.schema.json`](../.agents/schemas/lifecycle/code-review.start.schema.json) | Emitted at the start of the code-review sub-phase (Phase D of the close-tail). Story #2252. | `epicId` |
| `intervention.recorded` | [`intervention.recorded.schema.json`](../.agents/schemas/lifecycle/intervention.recorded.schema.json) | Emitted whenever the host LLM performs an out-of-band manual intervention during an Epic delivery (e.g., AskUserQuestion, manual git restore/reset, --no-ff recovery merge, story-close --skipValidation). The InterventionRecorder listener appends the payload to the epic-run-state-store's manualInterventions array; a non-empty array disqualifies the Epic from auto-merge. | `epicId`, `reason` |
| `ledger-record` | [`ledger-record.schema.json`](../.agents/schemas/lifecycle/ledger-record.schema.json) | Append-only NDJSON record shape for temp/run-<id>/lifecycle.ndjson. Three discriminated kinds; consumers (LedgerWriter, TraceLogger) discriminate on `kind`. | — |
| `loop.tick` | [`loop.tick.schema.json`](../.agents/schemas/lifecycle/loop.tick.schema.json) | Emitted once per pass of a host-driven loop (e.g. a recurring loop command or a long-running poll) so each round lands an inspectable ledger record. Surfaces the loop as forward-progress evidence the /deliver idle watchdog already scans — distinct from story.heartbeat, which carries Story-phase info for a single in-flight Story. A loop is not tied to a Story tier: loop.tick carries a free-form loopName, a monotonic round counter, the configured cadence, and a status so a host loop never runs silently. cadence is the loop's configured interval label (e.g. '5m', 'self-paced'); status is the per-round verdict (running while the loop continues, done when it terminates normally, blocked when it stalls). | `event`, `loopName`, `round`, `cadence`, `status`, `timestamp` |
| `merge.flip-failed` | [`merge.flip-failed.schema.json`](../.agents/schemas/lifecycle/merge.flip-failed.schema.json) | Emitted when a delivery run observed a CONFIRMED merge but the agent::closing → agent::done label write itself failed. Deliberately distinct from merge.unlanded (Story #4539): the merge landed, so attributing this to an unlanded merge sends the operator to branch protection and required checks when the real fault is an API failure on the label write, remedied by re-running single-story-confirm-merge.js. scope distinguishes the epic-path (ticketId = epicId) from the standalone story-path (ticketId = storyId). | `event`, `scope`, `ticketId`, `prNumber`, `blockClass`, `reason`, `elapsedSeconds` |
| `merge.unlanded` | [`merge.unlanded.schema.json`](../.agents/schemas/lifecycle/merge.unlanded.schema.json) | Emitted whenever a headless delivery run (the epic-path finalize flow or the standalone single-story-close flow) finishes its work without a confirmed merge, so a work-complete-but-unmerged terminal state is precisely attributable from the lifecycle ledger instead of diffing origin/main after the fact (Epic #4425). scope distinguishes the epic-path (ticketId = epicId) from the standalone story-path (ticketId = storyId); blockClass is produced by the shared classifier in merge-block-class.js. | `event`, `scope`, `ticketId`, `prNumber`, `blockClass`, `reason`, `elapsedSeconds` |
| `notification.emitted` | [`notification.emitted.schema.json`](../.agents/schemas/lifecycle/notification.emitted.schema.json) | Self-emitted by NotifyDispatcher after each webhook/comment dispatch. Carries the upstream event name, the channel, the severity, and the ok flag for trace fidelity. | `event`, `channel`, `severity`, `ok` |
| `pr.created` | [`pr.created.schema.json`](../.agents/schemas/lifecycle/pr.created.schema.json) | Emitted by Finalizer immediately after gh pr create (or short-circuit). Must be preceded by acceptance.reconcile.ok from the same run. | `prUrl`, `head`, `base` |
| `retro.end` | [`retro.end.schema.json`](../.agents/schemas/lifecycle/retro.end.schema.json) | Emitted at the end of the retro sub-phase. `posted` indicates whether the retro structured comment was upserted onto the Epic; `retroPath` is the local mirror path under temp/run-<id>/ when written. Story #2252. | `epicId`, `posted` |
| `retro.start` | [`retro.start.schema.json`](../.agents/schemas/lifecycle/retro.start.schema.json) | Emitted at the start of the retro sub-phase (Phase E of the close-tail). Story #2252. | `epicId` |
| `story.blocked` | [`story.blocked.schema.json`](../.agents/schemas/lifecycle/story.blocked.schema.json) | Emitted from the story-close path when a Story transitions to agent::blocked. | `storyId`, `reason` |
| `story.dispatch.end` | [`story.dispatch.end.schema.json`](../.agents/schemas/lifecycle/story.dispatch.end.schema.json) | Appended to the Epic ledger by emit-story-dispatch-end.js when a child story sub-agent returns, so /deliver's idle watchdog can subtract completed Stories from the in-flight set. Subscribed by CheckpointPointerWriter via SUBSCRIBED_END_EVENTS. Sibling ordering within a wave is not guaranteed; ordering between waves is. | `storyId`, `outcome`, `durationMs` |
| `story.dispatch.start` | [`story.dispatch.start.schema.json`](../.agents/schemas/lifecycle/story.dispatch.start.schema.json) | Emitted before a story is handed to the host-LLM for Agent-tool fanout. lifecycle-emit-story-dispatch.js appends the {storyId, waveIndex, dispatchedAt, attempt} shape to the Epic ledger so /deliver's host loop can durably ledger every dispatch attempt for in-flight reconciliation (Story #2891). | `storyId`, `waveIndex` |
| `story.merged` | [`story.merged.schema.json`](../.agents/schemas/lifecycle/story.merged.schema.json) | Emitted from the story-close path after a Story branch successfully merges into main (single-story/confirm-merge.js). | `storyId`, `sha` |

<!-- END GENERATED:lifecycle-events -->

---

## 3. Ledger format

The bus writes two on-disk artifacts per run, both rooted at
`temp/run-<id>/` (resolved by
[`runTempDir`](../.agents/scripts/lib/config/temp-paths.js); the
deprecated `epicTempDir` alias still forwards here):

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
`temp/run-<id>/lifecycle.ndjson`, finds the highest seqId with a
terminal record (`completed` or `failed`), and replays the bus from
that point. Idempotent listeners (`Set<seqId>` guard) make the replay
safe — the NDJSON ledger is the sole source of truth for resume.

---

## 4. Listener model

Listeners live in
[`lib/orchestration/lifecycle/listeners/`](../.agents/scripts/lib/orchestration/lifecycle/listeners/).
Each listener does exactly one thing in response to its subscribed
events.

| Listener                     | Subscribes to                                                                                  | Side effect                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Watcher`                    | `pr.created`                                                                                   | `watchPrToTerminal` — CI watch used by `pr-watch-with-update.js`. |

> **v2 note.** The Epic lifecycle listener chain (`AutomergeArmer`,
> `AutomergePredicate`, `Finalizer`, `Cleaner`, …) was removed. Story
> delivery arms merge and confirms land via `single-story-close`
> (`phases/auto-merge.js` + `confirm-merge.js`). `MergeWatcher` followed in
> Story #4545 — the listener had no production caller, and the poll defaults
> and `deriveChecksStatus` the close path did reuse from it now live in
> [`lib/orchestration/merge-poll.js`](../.agents/scripts/lib/orchestration/merge-poll.js).
### Side-effect firewall

Listeners MAY read tickets via the injected provider, write tickets via
`transitionTicketState`, upsert structured comments, and append to the
per-run ledger / signals files. Listeners MUST NOT call `bus.emit()`
from inside a listener body, import runner state directly, or mutate
cross-cutting globals.

The "merge-lockout" lint rule
([`.agents/scripts/check-lifecycle-lint.js`](../.agents/scripts/check-lifecycle-lint.js))
enforces that the literal `gh pr merge` call lives only inside
`single-story-close/phases/auto-merge.js`. Any other module that
re-introduces the string fails lint.

---

## 5. Emit boundaries

Live Story close-and-land —
[`.agents/scripts/single-story-close.js`](../.agents/scripts/single-story-close.js)
— arms auto-merge and optionally polls to merge confirmation
(`delivery.routing.closeAndLand`, default true).

[`.agents/scripts/notify.js`](../.agents/scripts/notify.js) remains the
single dispatch entry point for webhook / @mention channels.

---

## 6. Related references

- [`docs/architecture.md`](architecture.md) — system overview; Story
  delivery scripts and operator-tunable knobs.
- [`.agents/docs/SDLC.md`](../.agents/docs/SDLC.md) — end-to-end SDLC narrative.
- [`.agents/workflows/deliver.md`](../.agents/workflows/deliver.md)
  — operator-facing `/deliver` router.
- [`docs/decisions.md`](decisions.md) — architectural decisions log;
  the Epic #2172 entry records the rationale for the bus refit.
