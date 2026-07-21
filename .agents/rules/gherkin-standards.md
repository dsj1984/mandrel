# Gherkin Authoring Standards

Rules for authoring `.feature` files so scenarios remain business-readable,
reusable across projects, and free of implementation leakage. Applies to every
Gherkin file (`*.feature`) in any project that consumes this framework. The
companion stack skill is
[`stack/qa/gherkin-authoring`](../skills/stack/qa/gherkin-authoring/SKILL.md);
test-layer responsibilities live in
[`testing-standards.md`](./testing-standards.md).

## Tag Taxonomy

Tags are the only supported mechanism for selecting, filtering, and routing
scenarios. Use the canonical set below; do not invent ad-hoc tags.

- `@smoke` — minimal critical-path scenarios that MUST pass on every PR.
- `@risk-high` — scenarios covering flows flagged `risk::high` on their
  originating ticket. Run on every release candidate.
- `@platform-web` — scenarios that only make sense on the web client.
- `@platform-mobile` — scenarios that only make sense on the mobile client.
- `@domain-<slug>` — domain scope (e.g. `@domain-billing`, `@domain-auth`).
  The slug is project-defined; one tag per scenario.
- `@flaky` — operational quarantine tag. Scenarios carrying this tag are
  excluded from the gating suite and run in a dedicated non-blocking job
  until stabilized. Treat `@flaky` as a debt marker, not a permanent label.
- `@skip` — scaffold-gating tag. Applied to scenarios scaffolded ahead of
  their implementation (e.g. by a wave-0 BDD scaffold Story); the scenario
  is excluded from the gating suite until the implementing Story removes
  the tag (the "de-skip" edit). Unlike `@flaky`, `@skip` marks planned
  not-yet-implemented behavior, never a stability problem.

Retired: the `@epic-<id>-ac-N` AC tag is inert — do not apply it to new
scenarios; `mandrel update` strips surviving instances from consumer files.

Rules:

- Every `Scenario` or `Scenario Outline` MUST carry exactly one `@domain-*`
  tag.
- Platform tags are mutually exclusive. A scenario that applies to both
  platforms carries neither.
- `@smoke` and `@risk-high` are orthogonal to domain/platform and may be
  combined freely.
- Tag at the `Feature:` level when every scenario shares the tag; tag at the
  scenario level otherwise. Do not duplicate feature-level tags onto
  scenarios.
- Tags not in this taxonomy MUST be proposed in a PR that updates this rule
  before use.

## Forbidden Patterns

`.feature` files describe business intent. The following MUST NOT appear in
any `Feature`, `Background`, `Scenario`, `Scenario Outline`, or `Examples`
block. They belong in step definitions or contract-layer tests instead.

- **Raw SQL or ORM calls.** `SELECT ... FROM ...`, `INSERT INTO ...`,
  `prisma.user.findMany(...)`, Knex builders, etc. Database access is a step
  definition concern.
- **HTTP status codes.** `200`, `401`, `expect status 404`. Status-code
  assertions are contract-layer tests; scenarios assert user-visible
  outcomes.
- **DOM selectors.** CSS selectors, XPath, `#id`, `.class`, `[data-testid=...]`,
  element tag names. Selectors live inside step definitions.
- **Raw URLs or route paths.** `/api/v1/users/123`, `https://...`. Reference
  the business resource (e.g. "the user's profile"), not the transport path.
- **JSON/request/response payloads.** Shape and field assertions belong in
  contract-layer tests.
- **Framework or tooling names.** No `Playwright`, `Cucumber`, `Jest`,
  `Prisma`, `React` in scenario text.
- **Timings or waits.** `wait 2 seconds`, `sleep`, `retry 3 times`. Use
  business-level readiness ("until the invoice is issued"); step definitions
  own timing.

## Scenario Outline Conventions

Use `Scenario Outline` only when the same behavior is exercised across a
bounded matrix (roles, permissions, plan tiers, locales). For divergent
behavior, write separate `Scenario` blocks.

- Placeholders use `<angle-bracket-names>` that match `Examples` column
  headers exactly.
- Each `Examples` block MUST include a header row whose names are kebab-case
  and self-describing (`<user-role>`, not `<x>`).
- For role/permission matrices, dedicate one column to the role and one
  column per observable outcome. Do not encode multiple outcomes in a single
  free-text column.
- Split `Examples` tables by tag when rows need different tags (e.g.
  `@risk-high` for admin rows). Each `Examples` block may carry its own
  tags.
- Keep `Examples` tables under ~12 rows. Larger matrices indicate the
  scenario is really several scenarios and should be split.

Example skeleton:

```gherkin
@domain-billing
Scenario Outline: <user-role> access to invoice exports
  Given a signed-in <user-role>
  When they request an invoice export
  Then the export is <export-outcome>

  Examples:
    | user-role      | export-outcome   |
    | account-owner  | delivered        |
    | billing-admin  | delivered        |
    | viewer         | denied           |
```

## Selector & `data-testid` Discipline

Steps reference **business intent**; selectors are a step-definition
implementation detail.

- Scenario text names the user-visible concept: "the submit button", "the
  invoices table", "the error banner".
- Step definitions resolve concepts to selectors. Prefer `data-testid`
  attributes (e.g. `data-testid="submit-invoice"`); fall back to role-based
  queries (`getByRole`) only when `data-testid` is unavailable.
- `data-testid` values MUST NOT appear in `.feature` files. If a step needs
  to distinguish between two similar elements, encode the distinction in
  business language ("the primary submit button"), then let the step
  definition map that to the `data-testid`.
- When a new UI element needs a stable hook, add the `data-testid` in the
  component and reference the business concept in the scenario in the same
  PR.

## Step Reuse — Grep Before You Write

Before authoring a new step, grep the step-definition library for the verb
stem and **reuse an existing step verbatim** (adjust your scenario to fit it),
or **extend a near-match** (add a parameter, widen the regex, updating every
call site in the same PR) — new steps fragment the vocabulary and multiply
maintenance. Add a new definition only when no reasonable match exists, and
never copy-paste a step implementation to support a paraphrased scenario.
When a step is superseded, mark it deprecated and migrate every call site in
the same PR; do not leave two near-identical steps live.
