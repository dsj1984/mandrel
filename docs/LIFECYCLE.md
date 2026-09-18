# Lifecycle Ledger — Reference

This document is the canonical reference for the per-run **lifecycle ledger**:
the append-only NDJSON trail a delivery run leaves behind so a
work-complete-but-unmerged outcome is attributable after the fact.

> **There is no lifecycle event bus.** One shipped from Epic #2172 through the
> v2 collapse, and this document described it. Story #5024 deleted it. The bus,
> `LedgerWriter`, `TraceLogger` and `emit-loop-tick.js` formed a closed island:
> `emit-loop-tick.js` was the only non-test importer of the first two and had no
> importer of its own, and `trace-logger.js` had none at all — so the
> `lifecycle.md` companion the old § 3 documented was never written in
> production, and no listener the old § 4 tabulated had registered since the
> Story-only cutover removed the close-tail chain (`AutomergeArmer`,
> `Finalizer`, `Cleaner`, …; `MergeWatcher` in #4545, `Watcher` in #5006).
>
> **An event schema earns its place here only while code emits it.** Story
> #4545 applied that rule to the `epic.*` and `acceptance.reconcile.*`
> families. Story #5024 applied it to the remaining fifteen, whose emitters had
> already gone: retiring the bus left exactly two emittable events. See
> [ADR `20260806-lifecycle-bus-retired`](decisions.md).

---

## 1. What writes the ledger

Source:
[`lib/orchestration/lifecycle/emit-ledger-event.js`](../.agents/scripts/lib/orchestration/lifecycle/emit-ledger-event.js).

`appendLedgerEvent` is a **bare `appendFileSync`** — a direct, dependency-free
write from the `single-story-close` flow, deliberately not a publish:

- **Schema validation before the write.** The payload is validated against
  `.agents/schemas/lifecycle/<event>.schema.json` with a cached Ajv 2020
  validator. A validation failure throws and nothing is appended.
- **One record per call, `kind: 'emitted'`.** There is no completion or
  failure pairing to write, because there are no listeners to run between them.
- **Scope-resolved destination.** The record lands at
  [`storyLedgerPath`](../.agents/scripts/lib/config/temp-paths.js) —
  `<tempRoot>/standalone/stories/story-<sid>/lifecycle.ndjson`, or the
  run-scoped path when an enclosing run id is supplied.
- **Write scope is `story` only.** The `merge.unlanded` / `merge.flip-failed`
  schemas still accept `scope: 'epic'` on **read** so archived ledgers keep
  validating; only the writer path narrowed. The same split
  [`merge-block-class.js`](../.agents/scripts/lib/orchestration/merge-block-class.js)
  keeps for `predicate-refused`.

Both emitters —
[`emit-merge-unlanded.js`](../.agents/scripts/lib/orchestration/lifecycle/emit-merge-unlanded.js)
and
[`emit-merge-flip-failed.js`](../.agents/scripts/lib/orchestration/lifecycle/emit-merge-flip-failed.js)
— share that core and differ only in their schema and their payload's meaning.

---

## 2. Event taxonomy

Two events are emittable:

| Event | Emitted when |
| --- | --- |
| `merge.unlanded` | A headless delivery run finished without a confirmed merge. |
| `merge.flip-failed` | The merge was CONFIRMED but the `agent::closing` → `agent::done` label write itself failed. |

The distinction is load-bearing (Story #4539): attributing a failed label write
to an unlanded merge sends the operator to branch protection and required checks
when the real fault is an API failure, remedied by re-running
`single-story-confirm-merge.js`.

This section is **authored**, hand-maintained beside the emitters it
documents. Story #5089 retired the schema-driven renderer that used to own the
roster below, along with its `--check` companion: with the taxonomy down to two
events, it bought less than it cost, and it forced every consumer repo to carry
a `docs/LIFECYCLE.md` nothing consumer-side read.
`tests/lifecycle/schema-registry.test.js` is the machine check, and it checks
the list **in both directions** — a listed event missing its schema file
fails, and so does a schema file for an event nobody emits. The one-way
version of that assertion is what let fifteen emitter-less schemas read green
for months. Update this section by hand whenever you add or edit a lifecycle
schema; the test fails if you forget.

### Schema-backed roster

The two emittable events above, plus the `ledger-record` envelope § 3
describes, are the whole shipped schema set:

| Event | Schema | Description | Required fields |
| --- | --- | --- | --- |
| `ledger-record` | [`ledger-record.schema.json`](../.agents/schemas/lifecycle/ledger-record.schema.json) | Append-only NDJSON record shape for the per-run lifecycle ledger. Three discriminated kinds keyed on `kind`. Only `emitted` has a writer: Story #5024 retired the lifecycle bus, so the `completed` / `failed` kinds are a READ contract for ledgers archived from the bus era (`failed` requires a `listener`, which only a listener chain could supply). Reading a ledger never consults this schema; validation happens on the write path only. | — |
| `merge.flip-failed` | [`merge.flip-failed.schema.json`](../.agents/schemas/lifecycle/merge.flip-failed.schema.json) | Emitted when a delivery run observed a CONFIRMED merge but the agent::closing → agent::done label write itself failed. Deliberately distinct from merge.unlanded (Story #4539): the merge landed, so attributing this to an unlanded merge sends the operator to branch protection and required checks when the real fault is an API failure on the label write, remedied by re-running single-story-confirm-merge.js. scope distinguishes the epic-path (ticketId = epicId) from the standalone story-path (ticketId = storyId). | `event`, `scope`, `ticketId`, `prNumber`, `blockClass`, `reason`, `elapsedSeconds` |
| `merge.unlanded` | [`merge.unlanded.schema.json`](../.agents/schemas/lifecycle/merge.unlanded.schema.json) | Emitted whenever a headless delivery run (the epic-path finalize flow or the standalone single-story-close flow) finishes its work without a confirmed merge, so a work-complete-but-unmerged terminal state is precisely attributable from the lifecycle ledger instead of diffing origin/main after the fact (Epic #4425). scope distinguishes the epic-path (ticketId = epicId) from the standalone story-path (ticketId = storyId); blockClass is produced by the shared classifier in merge-block-class.js. | `event`, `scope`, `ticketId`, `prNumber`, `blockClass`, `reason`, `elapsedSeconds` |

---

## 3. Ledger format

Append-only, one JSON record per line, at the path § 1 resolves. The record
envelope is `ledger-record.schema.json`.

```json
{ "kind": "emitted", "seqId": 1, "ts": "…", "event": "merge.unlanded", "payload": { … } }
```

The envelope keeps three discriminated kinds — `emitted`, `completed`,
`failed` — but **only `emitted` has a writer today**. The other two are a
**read** contract: archived ledgers from the bus era carry them, and `failed`
additionally requires a `listener` field that only a listener chain could
supply. Reading a ledger never consults a schema; validation happens on the
write path only, so archived records stay readable regardless.

The ledger is written synchronously, so a consumer can rely on durability
without an explicit flush.

---

## 4. Emit boundaries

Live Story close-and-land —
[`.agents/scripts/single-story-close.js`](../.agents/scripts/single-story-close.js)
— arms auto-merge and optionally polls to merge confirmation
(`delivery.routing.closeAndLand`, default true). The two ledger emits fire from
its
[`confirm-merge`](../.agents/scripts/lib/orchestration/single-story-close/phases/confirm-merge.js)
phase.

[`.agents/scripts/notify.js`](../.agents/scripts/notify.js) remains the single
dispatch entry point for webhook / @mention channels. It is a **separate
channel from this ledger**: the notify allowlist and the lifecycle event
taxonomy are different vocabularies, and `merge.unlanded` / `merge.flip-failed`
are allowlistable for webhooks without having a `notify()` dispatcher today.

The merge-lockout lint
([`scripts/check-lifecycle-lint.js`](../scripts/check-lifecycle-lint.js))
enforces that the literal `gh pr merge` call lives only inside
`single-story-close/phases/auto-merge.js`. Any other module that re-introduces
the string fails lint.

---

## 5. Related references

- [`docs/architecture.md`](architecture.md) — system overview; Story
  delivery scripts and operator-tunable knobs.
- [`docs/SDLC.md`](SDLC.md) — end-to-end SDLC narrative.
- [`.agents/workflows/mandrel-deliver.md`](../.agents/workflows/mandrel-deliver.md)
  — operator-facing `/mandrel-deliver` router.
- [`docs/decisions.md`](decisions.md) — architectural decisions log; the
  Epic #2172 entry records the original bus refit and
  `20260806-lifecycle-bus-retired` records its retirement.
