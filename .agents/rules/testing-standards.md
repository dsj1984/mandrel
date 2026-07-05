# Testing Standards

Rules to enforce robust, reliable, and consistent testing methodologies. These
standards are pyramid-aware: every test belongs to exactly one of three
tiers — **unit**, **contract**, or **e2e / acceptance** — and each tier has
distinct responsibilities, scope, and assertion style. Choosing the correct
tier is the first decision when adding a test; the companion rule
[`gherkin-standards.md`](./gherkin-standards.md) governs how acceptance-tier
scenarios are authored. The companion skill
[`core/test-driven-development`](../skills/core/test-driven-development/SKILL.md)
shows **how** to apply these standards (TDD cycle, Prove-It Pattern, naming,
anti-patterns) — read this rule for the **what**. When the skill and this
rule diverge, this rule wins, per the central ordering in
[`.agents/instructions.md` § 1.K](../instructions.md) (rules sit above
skills).

## The Three Tiers

### Unit

Pure logic, no I/O. Unit tests exercise a single function, component, or
module in isolation and make up the broad base of the pyramid.

- **Scope.** Pure functions, reducers, formatters, parsers, validators,
  component rendering with mocked props, hook logic with mocked context.
- **Dependencies.** All external network, database, filesystem, and time
  sources MUST be mocked. Never let a unit test make a real call.
- **Assertions.** Return values, thrown errors, rendered output, emitted
  events. Do not assert on HTTP status codes, SQL, or wire formats — those
  are contract-tier concerns.
- **Location.** Colocate `*.test.ts` / `*.test.tsx` alongside the file under
  test, or in a `__tests__/` directory inside the same module. Never use the
  `.spec.` suffix.
- **Coverage.** Unit tests are where line and branch coverage targets are
  met. Mutation testing (e.g. Stryker), when configured, runs at this tier.

### Contract

API ↔ DB invariants, schema conformance, adapter and boundary contracts.
Contract tests exercise the shape of data crossing a process or service
boundary and are where shape, status, and error-body assertions live.

- **Scope.** REST/GraphQL handler ↔ persistence round-trips, Zod/JSON-schema
  validation, adapter contract tests against a real (or high-fidelity
  in-memory) database, event-payload conformance, backwards-compatibility
  tests for published API surfaces.
- **Dependencies.** Use a real database (Testcontainers, SQLite file, or
  project equivalent) or a contract-grade fake. Do not mock the boundary
  that is under test. External third-party services MAY be mocked; the
  system-under-test's own persistence layer MUST NOT be.
- **Assertions.** HTTP status codes, response bodies, error shapes, DB row
  state after a write, schema conformance, pagination envelopes, idempotency
  keys. This is the correct home for *all* status-code and wire-shape
  assertions.
- **Location.** `tests/contract/**/*.test.ts` or the project's equivalent
  contract directory. Keep contract tests separate from unit tests so they
  can be executed (and timed) independently.
- **Coverage.** Measured by contract surface covered (endpoints, events,
  schemas), not line coverage. Every public API surface MUST have at least
  one contract test exercising the happy path and at least one negative
  case.

### E2E / Acceptance

User-visible journeys, authored in Gherkin (`.feature` files) and executed
through a browser or mobile automation runner. These sit at the narrow top
of the pyramid.

- **Scope.** Multi-step user journeys that cross UI, API, and persistence —
  e.g. "sign in, create an invoice, send it, see it in the outbox". One
  scenario per user-visible outcome.
- **Authoring.** Scenarios MUST follow
  [`gherkin-standards.md`](./gherkin-standards.md) — business intent only,
  canonical tag taxonomy, step reuse, no implementation leakage.
- **Dependencies.** Run against a real application stack (local, ephemeral,
  or preview environment) with seeded test data. Do not mock the UI, API,
  or DB at this tier.
- **Assertions.** User-visible outcomes only: a banner appears, a row shows
  up in a list, a PDF downloads. Never assert on DB rows, HTTP status
  codes, or JSON shapes here — push those down to the contract tier.
- **Location.** `tests/features/**/*.feature` with step definitions in
  `tests/steps/**` (or the project's equivalent). The companion skill is
  [`stack/qa/playwright-bdd`](../skills/stack/qa/playwright-bdd/SKILL.md).

## Assertion Placement Rule {#assertion-placement}

**DB assertions and API-shape assertions MUST live at the contract tier.**
They MUST NOT appear in `.feature` files, and SHOULD NOT appear in unit
tests.

"DB assertions" means any check against persisted state — a row count, a
column value, the presence or absence of a record after a write.

"API-shape assertions" means any check against wire format or transport
semantics, including:

- HTTP status codes (`200`, `401`, `404`, etc.)
- Response body shape, field names, field types
- Error envelope structure (error codes, error messages, problem+json
  fields)
- Pagination metadata (cursors, page counts, `total` fields)
- JSON/OpenAPI/Zod schema conformance
- Header values that carry protocol semantics (`Location`, `ETag`,
  `Retry-After`)

When a reviewer finds one of the above in a `.feature` file, the required
remediation is to delete it from the scenario and add (or extend) a
contract test that covers the assertion. The scenario should assert the
**user-visible outcome** only ("the invoice appears in the outbox"), not
the wire shape that produced it.

This rule is enforced bidirectionally: the companion prohibition on
`.feature` authoring lives in
[`gherkin-standards.md § Forbidden Patterns`](./gherkin-standards.md#forbidden-patterns),
which forbids raw SQL, HTTP status codes, DOM selectors, URLs, and JSON
payloads inside scenarios. That list and this section are two sides of the
same constraint: shape and state belong in contract tests; business
outcomes belong in acceptance scenarios.

This is the pyramid's load-bearing constraint. It is why the contract
tier exists as a distinct layer, and why acceptance scenarios stay
readable, stable, and free of implementation churn.

## Test Structure (Arrange, Act, Assert)

Every test at every tier follows the same three-block structure:

1. **Arrange.** Set up state, fixtures, mocks, seeded data, or page
   navigation.
2. **Act.** Call the function, hit the endpoint, or drive the user
   interaction.
3. **Assert.** Validate the outputs or side effects appropriate to the tier.

Do not interleave arrange/act/assert. Do not chain multiple unrelated
assertions into a single "kitchen sink" test — split them.

## Mocking & Isolation

- Unit tests MUST mock all external network calls, database access, and
  filesystem I/O. Contract tests MUST NOT mock the boundary under test
  (the DB or the API). E2E tests mock nothing within the system under test.
- Never write tests that depend on real-world timing unless explicitly
  testing a timeout — use fake timers instead.
- Reset mocks in `afterEach` (unit) or tear down seeded data in `afterEach`
  / `afterAll` (contract). Do not let state leak between tests.
- Parallelization: unit and contract suites MUST be safe to run in
  parallel. If a contract test requires exclusive DB access, gate it behind
  a named serial worker — do not reorder the whole suite.

## Coverage & Mutation Thresholds

- **Line / branch coverage** is measured at the unit tier only. Project
  defaults live in the consuming repo's coverage config; do not target
  coverage percentages on contract or e2e suites.
- **Contract coverage** is measured by API surfaces exercised, not lines.
  Every endpoint, event, and published schema SHOULD have at least one
  happy-path and one negative-path contract test.
- **Mutation testing** (when configured) runs on the unit tier. It is not
  meaningful at the contract or e2e tiers because those tiers exercise
  integration paths rather than isolated logic.
- Coverage targets apply to production code. Test helpers, fixtures, and
  generated code are excluded per the project's coverage config.

## Anti-Gaming (review-side complement)

These standards define what a *correct* test looks like; they cannot, on
their own, catch a change that reaches green by **weakening the check rather
than fixing the code** — a relaxed assertion, a skipped or deleted test, a
swallowed error, a stub return, a fake rename, or a warning silenced by
comment deletion. That shortcut taxonomy is enumerated, and the reviewer-facing
detection lens for it lives, in the **Anti-Gaming / Shortcut Detection** pillar
(Pillar 4) of
[`../workflows/helpers/code-review.md`](../workflows/helpers/code-review.md#pillar-4-anti-gaming--shortcut-detection).
When you loosen a matcher, quarantine a test, or remove coverage, record the
spec-sanctioned rationale in the commit body or Story comment so that pillar
reads it as a deliberate decision rather than gaming.

## Property-Based Testing (a technique, not a tier)

Property-based testing is a **technique** — generating a domain of inputs and
asserting invariants that must hold across all of them — not a fourth tier. It
layers onto the **unit** tier (and occasionally the **contract** tier) without
changing where a test lives or how it is mocked: the tier-placement, mocking,
and coverage MUSTs above remain the SSOT and continue to govern any
property-based test. Reach for it when a unit's correctness is better expressed
as an invariant over many inputs than as a handful of hand-picked examples
(parsers, encoders/decoders, serializers, sorting, idempotency).

For the how — choosing properties, shrinking, generators, and worked
examples — see the companion skill
[`core/property-based-testing`](../skills/core/property-based-testing/SKILL.md).
