# Lifecycle Listeners

Each listener in this directory subscribes to one or more lifecycle bus
events and performs a single side effect:

- `label-transitioner.js` — flips ticket `agent::*` labels via
  `transitionTicketState` in response to `wave.end`, `story.merged`,
  `story.blocked`, `epic.blocked`, `epic.unblocked`, `epic.complete`.
- `structured-comment-poster.js` — upserts `wave-<n>-start` /
  `wave-<n>-end` and `lifecycle-epic-blocked` / `lifecycle-epic-unblocked`
  structured comments on the Epic ticket. Owns the rich wave-boundary
  body (per-story bullets, duration, commit-assertion reclassification
  detail) inherited from the retired `wave-observer.js` writer
  (Epic #2646 Story C).
- `progress-reporter.js` _(Task #2244)_ — composes the
  `epic-run-progress` comment off `wave.end` / `story.dispatch.end`.
- `signals-appender.js` _(Task #2244)_ — appends idempotent rows to
  `temp/epic-<id>/signals.ndjson`.
- `notify-dispatcher.js` _(Task #2244)_ — fans out the curated webhook
  event subset.

## Idempotency contract

Listeners MUST be idempotent on `(event, seqId)`. The bus may invoke a
listener twice for the same seqId during the resume window (when an
`emitted` ledger line landed but the matching `completed` did not). The
canonical pattern is a per-instance `Set<seqId>` checked at the top of
the listener body; the second invocation returns early without mutating
external state.

The seqId guard is the only correctness requirement we surface from the
bus contract — downstream idempotency primitives (label-state diff,
marker-keyed upsert, NDJSON dedupe by seqId) layer on top of it.

## Side-effect firewall

Listeners MAY:

- read tickets via the injected `provider`,
- write tickets via the injected `transitionTicketState`,
- upsert structured comments via the injected `upsertStructuredComment`,
- append to per-Epic ledger / signals files under `tempRoot`.

Listeners MUST NOT:

- `bus.emit()` from inside a listener body (sequential mediator
  contract — the bus cannot re-entry safely),
- import the runner state directly,
- mutate cross-cutting globals.

Trace observers (`bus.on('*', fn)`) live under
`lib/orchestration/lifecycle/trace-logger.js` and are subject to the
same firewall, plus a stricter no-IO rule.
