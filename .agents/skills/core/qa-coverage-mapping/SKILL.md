---
name: qa-coverage-mapping
description:
  Map a quality finding to a per-tier coverage verdict (unit / contract /
  acceptance) aligned to `.agents/rules/testing-standards.md`. Use when a
  finding points at a symbol or surface and you need to know which test tiers
  already cover it and which are missing, so remediation lands the right tier.
  Delegates the verdict to the deterministic
  `lib/qa/coverage-verdict.js#coverageVerdict` helper.
allowed_tools:
  - Read
  - Bash
---

# qa-coverage-mapping

## Policy Capsule

- The three-tier taxonomy (unit / contract / acceptance), tier-placement rules, and assertion-placement constraints live in `.agents/rules/testing-standards.md`; that rule is the SSOT and wins on any conflict — this skill only maps a finding onto those tiers.
- Compute the verdict through the deterministic helper `coverageVerdict(...)` in `.agents/scripts/lib/qa/coverage-verdict.js`; never re-derive tier placement by hand in prose.
- Build the `surface` input by gathering the finding's symbol and the colocated/contract/acceptance tests that exercise it — pass test paths (or `{path, tier}` descriptors) so the helper classifies each one.
- Read the verdict as a `{unit, contract, acceptance}` object: each tier is `{status: 'present'|'absent', note}`. A surface with only a colocated unit test reports `unit: present` and `contract`/`acceptance`: `absent` with explanatory notes.
- Route remediation by the absent tiers, honoring the assertion-placement rule: wire-shape and status-code gaps become **contract** tests, user-visible journey gaps become **acceptance** scenarios — never push those into unit tests or `.feature` files incorrectly.
- Treat `absent` as a coverage gap to surface, not an automatic failure: some surfaces legitimately need only one tier (a pure formatter needs no acceptance scenario). Use the notes to justify, not to mandate, the missing tier.
- This skill is read + classify only: it does not author tests, mutate tickets, or run the suite. Hand the verdict to the TDD cycle in `.agents/rules/testing-standards.md` to actually write the missing tier.

## Role

You are the coverage cartographer. Given a finding that names a code surface
(a symbol — function, class, or module export — plus the tests around it), you
produce a structured per-tier verdict that says, for each of the three test
tiers in [`.agents/rules/testing-standards.md`](../../../rules/testing-standards.md),
whether coverage is **present** or **absent**, and why. You do not write the
missing tests; you tell the operator (or the next skill) exactly which tier is
missing so remediation is aimed correctly.

## When to use

- A quality / audit finding points at a specific symbol and you need to know
  whether it is already tested, and at which tier.
- Before remediating a coverage gap, to decide whether the missing test is a
  **unit**, **contract**, or **acceptance** test (the assertion-placement rule
  makes this decision load-bearing — a status-code gap must become a contract
  test, not a unit test).
- During a test-pyramid audit, to roll up many surfaces into a tier-by-tier
  gap report.

**When NOT to use:** for authoring tests (use the TDD cycle in
[`.agents/rules/testing-standards.md`](../../../rules/testing-standards.md#applying-the-standards)),
for measuring line/branch coverage percentages (that is the unit-tier coverage
config, not this skill), or for anything that requires running the suite.

## The verdict shape

`coverageVerdict(surface)` returns:

```json
{
  "unit":       { "status": "present" | "absent", "note": "…" },
  "contract":   { "status": "present" | "absent", "note": "…" },
  "acceptance": { "status": "present" | "absent", "note": "…" }
}
```

- `status` is `present` when at least one classified test exercises the surface
  at that tier, `absent` otherwise.
- `note` is always populated. For `present` tiers it summarizes the count; for
  `absent` tiers it explains the gap and echoes the symbol so the report reads
  cleanly.

## How to apply

1. **Identify the surface.** From the finding, capture the `symbol` and the
   list of tests that touch it — colocated `*.test.*`, anything under
   `tests/contract/**`, and any `.feature` scenario.
2. **Classify and verdict.** Pass the surface to `coverageVerdict`. Each test
   is classified by path (`.feature` → acceptance, `…/contract/…` or
   `.contract.test.*` → contract, `.test.*` or `__tests__/` → unit) or by an
   explicit `tier` field when you already know it.
3. **Read the gaps.** Every `absent` tier is a candidate gap. Apply judgment
   from the Policy Capsule: not every surface needs all three tiers.
4. **Route remediation.** For real gaps, hand off to the TDD cycle in
   `.agents/rules/testing-standards.md` with the missing tier named, honoring
   the assertion-placement rule so each assertion lands in its correct tier.

## Example

```js
import { coverageVerdict } from '../../../scripts/lib/qa/coverage-verdict.js';

const verdict = coverageVerdict({
  symbol: 'parseInvoice',
  tests: ['src/invoice/parse-invoice.test.js'],
});

// verdict.unit.status       === 'present'
// verdict.contract.status   === 'absent'   // wire-shape gap → contract test
// verdict.acceptance.status === 'absent'   // no user journey covered here
```

A colocated-unit-only surface like `parseInvoice` reports `unit` present and
both `contract` and `acceptance` absent with explanatory notes — exactly the
signal you need to decide whether the boundary (`contract`) or a user-visible
journey (`acceptance`) still needs a test, or whether a pure parser is
legitimately unit-only.
