# `tests/helpers/`

Shared test doubles for orchestration unit tests. Use these helpers in
preference to hand-rolled mock objects so that new gate labels and
contract additions in production code do not silently break unrelated
tests.

---

## `make-mock-provider.js`

A factory that returns a ticketing-provider double suitable for the
`injectedProvider` parameter on orchestration entry points such as
`runEpicDeliverFinalize`, `reconcileAcceptanceSpec`, and
`reconcileBaselinesOnEpicBranch`.

### Why it exists

Before this helper, every test that needed an `injectedProvider` wrote
its own ad-hoc object:

```js
// hand-rolled — DO NOT do this in new tests
const provider = {
  getTicket: async () => ({ id: 7, title: 'X' }),
};
```

When a new production gate started reading `labels` (for example, the
acceptance-spec reconciler short-circuits on the `acceptance::n-a`
waiver), every hand-rolled provider that omitted `labels` either threw
on `labels.includes(...)` or behaved as "no waiver", forcing dozens of
unrelated tests to add a `labels: [...]` field.

`makeMockProvider` centralises the safe defaults so the next gate label
only requires updating one file.

### API

```js
import { makeMockProvider } from '../helpers/make-mock-provider.js';

makeMockProvider({
  labels = ['acceptance::n-a'],   // override or pass [] to clear
  title  = 'Test Ticket',
  body   = '',
  ...overrides                    // e.g. getTicket, getEpic, etc.
} = {});
```

### Contract

1. **Defaults satisfy current gates.** Calling `makeMockProvider()` with
   no arguments returns a provider whose `getTicket(id)` resolves to:

   ```js
   { id, title: 'Test Ticket', body: '', labels: ['acceptance::n-a'] }
   ```

   The default `labels: ['acceptance::n-a']` causes the acceptance-spec
   reconciler to return `status: 'waived'` without scanning features.

2. **`labels` overrides, never merges.** `makeMockProvider({ labels: ['foo'] })`
   yields a provider whose tickets carry `labels: ['foo']` only — the
   default is replaced, not merged. Pass `labels: []` to model a ticket
   with no labels at all.

3. **Overrides replace, never merge.** Passing any other key on the
   options object (`getTicket`, `getEpic`, `getTicketDependencies`,
   `postComment`, …) replaces the corresponding default field on the
   returned provider. This keeps the helper safe to extend — adding a
   new default cannot accidentally compose with an override.

### Migration recipe

Hand-rolled provider with a custom title:

```js
// BEFORE
const provider = {
  getTicket: async () => ({
    id: 1386,
    title: 'Epic — Stabilize',
    labels: ['acceptance::n-a'],
  }),
};

// AFTER
const provider = makeMockProvider({
  getTicket: async () => ({
    id: 1386,
    title: 'Epic — Stabilize',
    labels: ['acceptance::n-a'],
  }),
});
```

Hand-rolled provider that only needs the defaults:

```js
// BEFORE
const provider = {
  getTicket: async (id) => ({ id, title: 'X', labels: ['acceptance::n-a'] }),
};

// AFTER
const provider = makeMockProvider();
```

### When NOT to use the helper

- **Multi-ticket lookup providers** (e.g. `buildProvider(tickets)` style
  factories backed by a `Map`). Those carry test-specific lookup logic
  the helper does not model — keep the local factory.
- **Contract tests** that need a real ticketing backend. The helper is
  unit-tier only.

---

## `projected-commands.js`

Computes the `.claude/commands/` projection deterministically, by running the
real `.agents/scripts/sync-claude-commands.js` against the repository's real
`.agents/workflows/` tree into a managed temp directory.

### Why it exists

`.claude/commands/` is a generated, **gitignored** mirror, materialized by the
`prepare` lifecycle script (`npm run sync:commands`). A freshly materialized
git worktree inherits `node_modules/` by clone and never runs `prepare`, so the
directory is empty there. Structural guards that asserted against it were
really asserting "somebody ran the sync in this checkout" — which failed in
every worktree-based delivery (positive assertions) or passed vacuously
(negative ones).

Projecting into a temp tree makes those guards a function of tracked source
alone, and strengthens them: they now assert what the sync *would* produce,
including the orphan-reap, rather than trusting whatever mirror is on disk.

### API

```js
import {
  projectCommands,    // fresh projection; `{ seedOrphans: ['old.md'] }` to test the reap
  projectedCommands,  // memoized default projection — one sync spawn per process
} from '../helpers/projected-commands.js';

projectedCommands().has('qa-run.md'); // → boolean
```

Both return `{ dest, files, has(rel) }`, where `rel` is a destination-relative
path (`qa-run.md`, `loops/<name>.md`) matching the sync script's own keys.

### Users

`tests/qa-run-rename.test.js`, `tests/qa-assist-rename.test.js`,
`tests/run-bdd-suite-retired.test.js`,
`tests/audit-suite/audit-fan-out-retirement.test.js`.

---

## `fast-check-config.js`

The one source of run parameters for every
[`fast-check`](https://fast-check.dev/) property in the suite.

### Why it exists

The repository does not rerun flaky tests — a red is root-caused. A property
drawing a fresh random seed per run could go red once and green on the retry,
so every property runs from a **pinned default seed** and a **bounded default
run count**. A failure prints the seed, the replay path and the shrunk
counterexample, which is everything needed to reproduce it.

### API

```js
import fc from 'fast-check';
import { fcParams } from '../helpers/fast-check-config.js';

fc.assert(fc.property(arb, predicate), fcParams());
```

- `fcParams(overrides?)` → `{ seed, numRuns }`, with `overrides` merged last
  (for extras such as `examples`). Never override `seed` in a test — that
  defeats the env override below.
- `resolveRunParameters(env?)` → the same pair resolved from an explicit env
  object (defaults to `process.env`).
- `DEFAULT_SEED`, `DEFAULT_NUM_RUNS` — the pinned defaults.

### Env overrides

```bash
MANDREL_FC_SEED=1 MANDREL_FC_NUM_RUNS=500 node --test tests/wave-runner/ready-set.property.test.js
```

`MANDREL_FC_SEED` takes any safe integer; `MANDREL_FC_NUM_RUNS` any positive
integer. A malformed value throws rather than silently falling back, so a
request for 5000 runs never quietly runs 100.

### Users

`tests/lib/orchestration/epic-rollup.property.test.js`,
`tests/wave-runner/ready-set.property.test.js`.
