# Lifecycle Listeners

Each listener in this directory subscribes to one or more lifecycle bus
events and performs a single side effect. The canonical close-tail roster
— in registration order — is wired by
[`index.js`](./index.js) (`buildDefaultListenerChain`), the production
entrypoint the standalone `lifecycle-emit.js` CLI shells in for
`/deliver`'s Phase 6 / 7.5 / 8 / 8.5 markdown invocations:

- `ledger-writer.js` — privileged `onEmitted` hook that lands every
  `emitted` record on disk before any listener body runs (MUST be first).
- `acceptance-reconciler.js` — gates Finalize on close-time acceptance
  coverage (`epic.close.end → acceptance.reconcile.*`).
- `finalizer.js` — opens the PR on `acceptance.reconcile.{ok,waived}` and
  emits `epic.merge.ready`.
- `automerge-armer.js` — arms `gh pr merge --auto --squash --delete-branch`
  on `epic.merge.ready`.
- `automerge-predicate.js` — evaluates the clean-sprint predicate and
  emits `epic.merge.{ready,blocked}`.
- `branch-cleaner.js` — reaps story/epic branches on `epic.cleanup.start`.
- `merge-watcher.js` — polls `gh pr view` after `epic.merge.armed` until
  the PR's `mergeCommit` is observed, then emits `epic.merge.confirmed`.
- `cleaner.js` — archives `temp/epic-<id>/` and emits the terminal
  `epic.cleanup.* → epic.complete` sequence on `epic.merge.confirmed`.
- `label-transitioner.js` — flips the Epic ticket to `agent::done` (and
  closes it as completed, idempotently) on `epic.complete`. Skipped when
  no provider is wired. Re-homed onto this chain after the 2026-07-11
  incident (merged Epics stranding at `agent::executing`): the original
  LabelTransitioner died with the in-process runner stratum (#3936) and
  the flip had no owner.
- `checkpoint-pointer-writer.js` — persists `{ lastCompletedSeqId, phase }`
  on every `*.end` event.

Two further listeners are activated outside the close-tail chain by their
own CLI entrypoints rather than `buildDefaultListenerChain`:

- `notify-dispatcher.js` — fans out the curated webhook event subset
  (driven by `notify.js`).
- `intervention-recorder.js` — appends operator-intervention payloads to
  the epic-run-state (driven by `epic-deliver-note-intervention.js`).
- `watcher.js` — the CI-poll loop (`watchPrToTerminal`) driven by
  `pr-watch-with-update.js`.

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
