# Lifecycle Listeners

Each listener in this directory subscribes to one or more lifecycle bus
events and performs a single side effect. The full close-tail roster and
event taxonomy live in [`docs/LIFECYCLE.md`](../../../../../../docs/LIFECYCLE.md)
— that document is the SSOT. This README only indexes the **files that still
live in this folder**.

## Files here

- [`watcher.js`](./watcher.js) — the CI-poll loop (`watchPrToTerminal`)
  driven by `pr-watch-with-update.js`.

`merge-watcher.js` was deleted in Story #4545: the Epic-era `MergeWatcher`
listener had no production caller after the v2.0.0 Story-only cutover. The
poll defaults and `deriveChecksStatus` the live close path did import from it
now live in
[`lib/orchestration/merge-poll.js`](../../merge-poll.js), a home the close
path owns.

Other close-tail side effects (ledger write, finalize/PR open, automerge
arm, branch cleanup, label transition) are owned by the Story delivery
path (`helpers/deliver-story` / `single-story-close.js`) rather than a
`buildDefaultListenerChain` factory in this directory.

## Idempotency contract

Listeners MUST be idempotent on `(event, seqId)`. The bus may invoke a
listener twice for the same seqId during the resume window (when an
`emitted` ledger line landed but the matching `completed` did not). The
canonical pattern is a per-instance `Set<seqId>` checked at the top of
the listener body; the second invocation returns early without mutating
external state.

## Side-effect firewall

Listeners MAY:

- read tickets via the injected `provider`,
- write tickets via the injected `transitionTicketState`,
- upsert structured comments via the injected `upsertStructuredComment`,
- append to per-run ledger / signals files under `tempRoot`.

Listeners MUST NOT:

- `bus.emit()` from inside a listener body (sequential mediator
  contract — the bus cannot re-enter safely),
- import runner state directly,
- mutate cross-cutting globals.

Trace observers (`bus.on('*', fn)`) live under
`lib/orchestration/lifecycle/trace-logger.js` and are subject to the
same firewall, plus a stricter no-IO rule.
