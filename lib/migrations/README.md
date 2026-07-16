# Version-keyed migrations

The migration runner applies one-time, version-gated transformations to a
consumer project's on-disk state when they upgrade `mandrel` across a
version boundary that changed a contract.

The engine lives in [`index.js`](./index.js). It owns ordering, version
filtering, idempotency enforcement, and the actionable per-step log line. The
`migrations` array is the single source of truth for which steps exist and in
what order they run.

> Story #4531 registered the first real step —
> [`steps/2.1.0-retire-mi-drop-knobs.js`](./steps/2.1.0-retire-mi-drop-knobs.js),
> which strips the retired `codingGuardrails.miDropMustRefactor` and
> `autoRefresh.miDropCap` keys from a consumer's `.agentrc.json`. The
> machinery itself is still exercised independently by fixture steps in
> [`__tests__/index.test.js`](./__tests__/index.test.js). Add the next real
> step here (ascending by version) when the next contract cutover lands.

## Step shape

Each entry in the `migrations` registry is an object:

```js
{
  version: '1.4.0',                  // semver the step graduates the tree to
  description: 'rename foo to bar',  // short, operator-facing summary
  detect(ctx) { return boolean },    // true ⇒ this step still needs applying
  apply(ctx) { /* perform the change */ },
}
```

| Field         | Type                          | Meaning                                                                 |
| ------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `version`     | `string` (semver)             | The version this step graduates the tree **to**. Drives range filtering and ordering. |
| `description` | `string`                      | Short, operator-facing summary printed in the `migrated …` log line.    |
| `detect`      | `(ctx) => boolean`            | Returns `true` when the change is **not yet** present (step still needs applying). |
| `apply`       | `(ctx) => void`               | Performs the change against `ctx`.                                      |

Keep the `migrations` array sorted ascending by `version`.

## Version filtering

`runMigrations({ fromVersion, toVersion, ctx })` applies only steps whose
`version` is **strictly greater than `fromVersion`** and **less than or equal
to `toVersion`**, in ascending version order:

- A step at exactly `fromVersion` is already in the tree (the consumer was on
  that version) and is **skipped**.
- A step at exactly `toVersion` is the upgrade target and **runs**.

Each step that actually applies prints `migrated <version>: <description>`
through an injected `log` seam (defaults to `console.log`).

`runMigrations` returns `{ applied, skipped }` — the versions that applied and
the in-range versions skipped because `detect` returned `false`.

## Idempotency contract

**`detect(ctx)` MUST return `false` once `apply(ctx)` has run against the same
context.**

The runner consults `detect` before every `apply`, so a step whose change is
already present is skipped. This makes a second `runMigrations` pass over the
same context a no-op — re-running an upgrade, or running it after a partial
failure, never double-applies a step. A migration whose `detect` keeps
returning `true` after `apply` is a bug: it will re-fire on every pass.

When authoring a step, write `detect` to probe for the *post-condition* of
`apply` (the renamed key exists, the moved file is in place, …) and return the
negation. The unit tests assert this property with fixture steps.
