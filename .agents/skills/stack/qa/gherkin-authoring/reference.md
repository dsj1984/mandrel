# Gherkin Authoring — Reference (on-demand)

**Read this when** a task engages one of the sections below and the Policy
Capsule in [`SKILL.md`](SKILL.md) does not settle it on its own. The capsule is
the contract; this file is the reference material behind it. The enforcement
rules (tag taxonomy, forbidden patterns, Outline conventions) are owned by the
SSOT rule, [`gherkin-standards.md`](../../../../rules/gherkin-standards.md).

## Canonical Given / When / Then Phrasing

`.feature` prose is written for a product-minded reader, not a test harness.
Each clause has exactly one job:

- **Given** — a precondition that is *already true* when the scenario starts.
  Stative, past or present tense. No actions.
  - Good: `Given a signed-in account-owner with an unpaid invoice`.
  - Bad: `Given the user clicks the login button` (that's a When).
- **When** — the single business action under test. One verb, one actor, one
  event. Splitting a When into multiple clauses is almost always wrong — move
  the extra clauses into Given.
  - Good: `When they issue the invoice`.
  - Bad: `When they log in and issue the invoice and download the PDF`.
- **Then** — an observable, user-visible outcome. Assert what the *user* sees or
  what the *business* records, not what the system emits internally.
  - Good: `Then the invoice appears in the issued invoices list`.
  - Bad: `Then a 201 is returned` (forbidden; see
    [gherkin-standards § Forbidden Patterns](../../../../rules/gherkin-standards.md#forbidden-patterns)).
- **And / But** — continuation clauses. They inherit the mood of the most recent
  Given/When/Then. Never start a scenario with And/But.

Voice and tense: third-person, present tense, role-qualified noun actors
(`the user`, `a billing-admin`, not "I" or "we"). One clause, one fact —
comma-chained facts hide compound assertions. Numbers and identifiers go in
`Examples` tables or fixtures, not inline prose.

## Translating PRD Acceptance Criteria to Scenarios

PRD ACs are the raw material. The authoring move is **one AC → one scenario**
unless the AC encodes a matrix (then it becomes a Scenario Outline — see below).

Walkthrough — a PRD AC from a billing feature:

> **AC-3:** When a billing-admin issues an invoice for a customer with a
> negative balance, the system rejects the issue and shows an error naming the
> outstanding amount.

Translation steps:

1. **Identify the domain.** Billing → tag the scenario `@domain-billing`.
2. **Identify the actor and precondition.** "billing-admin", "customer with a
   negative balance" → two Givens.
3. **Identify the single action.** "issues an invoice" → one When.
4. **Identify the observable outcome.** "rejects the issue and shows an error
   naming the outstanding amount" → two Thens (business outcome, then
   user-visible detail).
5. **Pick the risk tag.** If the originating ticket was `risk::high`, add
   `@risk-high`.

Resulting scenario:

```gherkin
@domain-billing @risk-high
Scenario: Issuing an invoice is rejected when the customer has a negative balance
  Given a signed-in billing-admin
  And a customer with a negative account balance
  When the billing-admin issues an invoice for that customer
  Then the issue is rejected
  And the rejection message names the outstanding amount
```

Heuristics:

- If a single AC needs more than **one When**, it is really two ACs. Split
  before you write.
- If a Then starts with "and the database has…" or "and the API returned…", you
  have crossed into step-definition or contract-test territory. Rewrite it as
  user-visible language or move the assertion to a contract test.
- If an AC says "the system logs X", that's an engineering non-functional
  requirement — cover it with a focused unit or integration test, not a
  `.feature` file.

## Background vs. Given, Outline vs. Multi-Scenario

Two authoring decisions authors routinely get wrong.

**Background vs. Given.** `Background` runs before **every** scenario in the
file. Use it only when every scenario genuinely shares the precondition **and**
it has no per-scenario variation (no `<placeholders>`, no per-scenario data).
Prefer a per-scenario Given when only some scenarios need the precondition, when
it varies by role/plan/fixture, or when a reader cannot understand the scenario
without scrolling up. Rule of thumb: if you find yourself writing *"except in
the admin scenario, where the Background step is actually…"*, delete the
Background.

**Scenario Outline vs. multiple Scenarios.** Use `Scenario Outline` when the
**same behavior** is exercised across a **bounded matrix** (roles, plan tiers,
locales) — the Givens/When/Thens are identical and only the data varies. Use
multiple `Scenario` blocks when the Givens differ structurally, the When verb
differs, or the Then outcomes differ in kind, not just value. Keep `Examples`
tables under ~12 rows, and split them by tag when rows need different tags
(e.g. `@risk-high` on admin rows only).

## Step-Definition Library Structure

Authoring scenarios and maintaining steps are the same job split across two
files. Keep that coupling visible:

```text
tests/
  steps/
    _common/          # actor, auth, navigation — reused across every domain
      auth.steps.ts
      navigation.steps.ts
    billing/          # one directory per @domain-* tag
      invoices.steps.ts
    _deprecated/      # steps pending migration
```

- One directory per `@domain-*` tag; `_common/` holds cross-cutting steps.
  Files are named by the noun the steps act on (`invoices.steps.ts`). Two levels
  (`steps/<domain>/<noun>.steps.ts`) is the nesting ceiling.
- Step text follows the scenario text verbatim — divergence between scenario
  prose and step text is a bug. Parameterize only over values that actually
  vary; keep implementations ≤20 lines (a longer one signals a missing helper).

**Reuse before authoring** — the non-negotiable workflow is in
[gherkin-standards § Step Reuse](../../../../rules/gherkin-standards.md#step-reuse--grep-before-you-write):

1. Search for the verb: `rg -n "issues? an invoice" tests/steps`.
2. If the phrase exists, **change your scenario** to use it — do not fork a
   near-duplicate step.
3. If a near-match exists, extend the existing step and update every call site
   in the same PR.
4. Only when no reasonable match exists, add a new step in the correct domain
   directory.

**Deprecation.** When a step is superseded, move the old definition into
`steps/_deprecated/` with a comment naming the replacement, migrate every call
site in the same PR, and delete the `_deprecated/` entry when the migration
lands. Never leave two live step definitions that mean the same thing.

## Authoring Checklist

Before opening a PR that adds or edits a `.feature` file:

- [ ] Every Scenario/Outline carries exactly one `@domain-*` tag.
- [ ] No forbidden patterns (SQL, status codes, selectors, URLs, payloads,
      framework names, explicit waits) appear in prose.
- [ ] Each scenario has exactly one `When`.
- [ ] `Then` clauses assert user-visible outcomes, not implementation.
- [ ] `Background` is justified (applies to every scenario in the file).
- [ ] If a Scenario Outline is used, the matrix is bounded (≤12 rows) and the
      shape is truly identical across rows.
- [ ] Every step phrase grep-matches an existing step definition **or** is
      accompanied by a new step definition in the right domain directory.
- [ ] Reads standalone — a product reader who has never seen the codebase can
      understand the intent without opening a step file.
