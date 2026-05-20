---
name: gherkin-authoring
description:
  Authors `.feature` files that stay business-readable, translate cleanly from
  PRD acceptance criteria, and reuse a shared step-definition library. Use
  when writing or editing scenarios — the SSOT enforcement rules live in
  `.agents/rules/gherkin-standards.md`; this skill shows authors how to apply
  them.
---

# Skill: gherkin-authoring

## Policy Capsule

- Write `Given` clauses as stative preconditions, `When` as a single business action, and `Then` as a user-visible outcome.
- Allow exactly one `When` per scenario; if you need two, split into two scenarios.
- Never assert on HTTP status codes, SQL state, DOM selectors, URLs, or JSON payloads inside `.feature` prose — push those to contract tests.
- Tag every Scenario or Outline with exactly one canonical `@domain-*` tag and the appropriate risk/platform tags from the gherkin-standards taxonomy.
- Use `Background` only when every scenario in the file genuinely shares the precondition with no per-scenario variation.
- Reuse existing step definitions: grep the steps tree for the verb stem before authoring a new step.
- Author one scenario per PRD acceptance criterion; for bounded matrices, use a Scenario Outline with ≤12 Examples rows.
- Use third-person present-tense, role-qualified actors (`the billing-admin`), never first person.

Guidance for authoring `.feature` files that stay business-readable, translate
cleanly from PRD acceptance criteria, and reuse a shared step-definition
library. The enforcement rules — tag taxonomy, forbidden patterns, Outline
conventions, selector discipline, step reuse — live in
[`.agents/rules/gherkin-standards.md`](../../../../rules/gherkin-standards.md),
which is the SSOT. This skill shows authors **how** to apply those rules; read
the rule file for the **what**. Runtime wiring for Playwright consumers is
covered by [`playwright-bdd`](../playwright-bdd/SKILL.md); test-layer scope is
covered by
[`testing-standards.md`](../../../../rules/testing-standards.md).

## 1. Canonical Given / When / Then Phrasing

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
- **Then** — an observable, user-visible outcome. Assert what the *user* sees
  or what the *business* records, not what the system emits internally.
  - Good: `Then the invoice appears in the issued invoices list`.
  - Bad: `Then a 201 is returned` (forbidden; see
    [gherkin-standards § Forbidden Patterns](../../../../rules/gherkin-standards.md#forbidden-patterns)).
- **And / But** — continuation clauses. They inherit the mood of the most
  recent Given/When/Then. Never start a scenario with And/But.

Voice and tense:

- Third-person, present tense. `the user`, `an admin`, `a billing-admin`
  (role-qualified nouns, not "I" or "we").
- One clause, one fact. Comma-chained facts hide compound assertions.
- Numbers and identifiers go in `Examples` tables or fixtures, not inline
  prose. Prose should read the same whether the underlying fixture has 1 or
  10,000 rows.

## 2. Translating PRD Acceptance Criteria to Scenarios

PRD ACs are the raw material. The authoring move is **one AC → one scenario**
unless the AC encodes a matrix (in which case it becomes a Scenario Outline —
see §3).

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
   naming the outstanding amount" → two Thens. The first asserts the business
   outcome (rejection); the second asserts the user-visible detail (error
   names the amount).
5. **Pick the risk tag.** If the originating ticket was `risk::high`, add
   `@risk-high`. Smoke tag only if this is a critical path on every PR.

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
- If a Then starts with "and the database has…" or "and the API returned…",
  you have crossed into step-definition or contract-test territory. Rewrite
  it as user-visible language or move the assertion to a contract test (see
  [testing-standards](../../../../rules/testing-standards.md)).
- If an AC says "the system logs X", that's an engineering non-functional
  requirement — not a BDD scenario. Cover it with a focused unit or
  integration test, not a `.feature` file.
- When a PRD AC is phrased negatively ("non-admins cannot export"), prefer a
  Scenario Outline if there are multiple negative roles; write a plain
  Scenario if there is exactly one.

## 3. Background vs. Given — and Outline vs. Multi-Scenario

Two authoring decisions that authors routinely get wrong.

### 3.1 Background vs. Given

`Background` runs before **every** scenario in the file. Use it only when:

- Every scenario in the file genuinely shares the precondition, **and**
- The precondition has no per-scenario variation (no `<placeholders>`,
  no per-scenario data).

Prefer a per-scenario Given when:

- Only some scenarios need the precondition. A Background that applies to
  four out of five scenarios is a Background for none of them; move it.
- The precondition varies by role, plan tier, or fixture shape. Variation
  belongs in a Scenario Outline's Examples, not in Background.
- Readers cannot understand the scenario without scrolling up to read
  Background. Background is a shortcut; if it hurts readability, inline it.

Rule of thumb: if you find yourself writing *"except in the admin scenario,
where the Background step is actually…"*, delete the Background.

### 3.2 Scenario Outline vs. multiple Scenarios

Use `Scenario Outline` when the **same behavior** is exercised across a
**bounded matrix** (roles, plan tiers, locales). The shape of the scenario —
Givens, When, Thens — is identical; only the data varies.

Use multiple `Scenario` blocks when:

- The Givens differ structurally (not just in value).
- The When verb differs.
- The Then outcomes differ in kind, not just in value. "Delivered vs.
  denied" is one outcome column (see Outline skeleton in
  [gherkin-standards § Scenario Outline Conventions](../../../../rules/gherkin-standards.md#scenario-outline-conventions)).
  "Email is sent vs. invoice is issued vs. account is suspended" are three
  different scenarios.

Scale guardrails (also in gherkin-standards):

- Keep `Examples` tables under ~12 rows. Larger tables hide distinct
  behaviors behind a shared skeleton.
- Split `Examples` by tag when rows need different tags (e.g. `@risk-high`
  on admin rows only).

## 4. Step-Definition Library Structure

Authoring scenarios and maintaining steps are the same job split across two
files. The library layout below keeps that coupling visible.

### 4.1 Layout

```text
tests/
  steps/
    _common/          # actor, auth, navigation — reused across every domain
      auth.steps.ts
      navigation.steps.ts
    billing/          # one directory per @domain-* tag
      invoices.steps.ts
      subscriptions.steps.ts
    auth/
      signin.steps.ts
    _deprecated/      # steps pending migration; see §4.4
```

- One directory per `@domain-*` tag. `_common/` holds cross-cutting steps
  (sign-in, navigation, generic waits handled at the fixture layer).
- Files are named by the noun the steps act on
  (`invoices.steps.ts`, not `billing-steps-1.ts`). A new noun is a new file.
- Avoid deep nesting. Two levels (`steps/<domain>/<noun>.steps.ts`) is the
  ceiling for most projects.

### 4.2 Naming

Step text follows the scenario text verbatim — if the scenario reads `the
invoice appears in the issued invoices list`, the step regex matches exactly
that phrase. Divergence between scenario prose and step text is a bug.

- Parameterize only over values that vary across scenarios. A step that
  accepts `{string}` for a literal that is always the same value is over-
  parameterized; bake the constant in and rename the step.
- Role-qualified actors (`{actor}`) read better than generic `{string}`.
  Define a custom parameter type that resolves `account-owner`, `billing-admin`,
  `viewer` to fixtures.
- Keep step implementations ≤20 lines. Longer implementations indicate a
  missing helper (domain fixture, page object, API client).

### 4.3 Reuse Before Authoring

The non-negotiable workflow is in
[gherkin-standards § Step Reuse](../../../../rules/gherkin-standards.md#step-reuse--grep-before-you-write):
grep the step tree for the verb stem before writing anything new. In practice:

1. Search for the verb: `rg -n "issues? an invoice" tests/steps`.
2. If the phrase exists, **change your scenario** to use that phrase. Do not
   fork a near-duplicate step.
3. If a near-match exists, extend the existing step (add a parameter, widen
   the regex) and update every call site in the same PR.
4. Only when no reasonable match exists, add a new step in the correct
   domain directory.

### 4.4 Deprecation

When a step is superseded:

1. Move the old definition into `steps/_deprecated/` and annotate it with a
   one-line comment naming the replacement.
2. Migrate every call site to the replacement in the same PR.
3. Delete the `_deprecated/` entry when the migration lands.

Never leave two live step definitions that mean the same thing. Parallel
vocabularies rot the suite faster than any other source of maintenance cost.

## 5. Authoring Checklist

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

## 6. Cross-References

- SSOT rules: [`.agents/rules/gherkin-standards.md`](../../../../rules/gherkin-standards.md).
- Runtime wiring: [`playwright-bdd`](../playwright-bdd/SKILL.md).
- Browser-level conventions: [`playwright`](../playwright/SKILL.md).
- Test-layer scope: [`testing-standards.md`](../../../../rules/testing-standards.md).
- Example feature: [`examples/invoice-issue.feature`](./examples/invoice-issue.feature).
