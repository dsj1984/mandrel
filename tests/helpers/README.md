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
