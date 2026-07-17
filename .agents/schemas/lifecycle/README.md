# Lifecycle event schemas

JSON Schemas for the lifecycle event taxonomy consumed by the
`/deliver` lifecycle bus
(`lib/orchestration/lifecycle/bus.js`). The bus validates every
emit payload against one of these schemas before invoking
listeners; a schema mismatch fails the emit and propagates the
throw.

Each event in the Tech Spec taxonomy has a `<event>.schema.json`
file. The ledger record (`emitted | completed | failed` union)
lives in `ledger-record.schema.json` and is consumed by
`ledger-writer.js`.

Schemas are intentionally permissive (`additionalProperties: true`)
on inner objects whose shape is dictated by upstream tooling (e.g.
`gh pr view` JSON, `checkOutcomes`). The required-key set is the
contract.
