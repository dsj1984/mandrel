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

The enforcement rules — tag taxonomy, forbidden patterns, Outline conventions,
selector discipline, step reuse — live in
[`.agents/rules/gherkin-standards.md`](../../../../rules/gherkin-standards.md),
which is the SSOT. This skill shows authors **how** to apply those rules; read
the rule for the **what**.

## Long-form reference — read on demand

The worked authoring material — canonical Given/When/Then phrasing, the
one-AC-to-one-scenario translation walkthrough, Background-vs-Given and
Outline-vs-multi-scenario decisions, the step-definition library layout and
reuse/deprecation workflow, and the pre-PR authoring checklist — lives in the
on-demand sibling [`reference.md`](reference.md). Open a section only when the
task engages it.

- [Canonical Given / When / Then Phrasing](reference.md#canonical-given--when--then-phrasing)
- [Translating PRD Acceptance Criteria to Scenarios](reference.md#translating-prd-acceptance-criteria-to-scenarios)
- [Background vs. Given, Outline vs. Multi-Scenario](reference.md#background-vs-given-outline-vs-multi-scenario)
- [Step-Definition Library Structure](reference.md#step-definition-library-structure)
- [Authoring Checklist](reference.md#authoring-checklist)

## Cross-References

- SSOT rules: [`.agents/rules/gherkin-standards.md`](../../../../rules/gherkin-standards.md).
- Runtime wiring: [`playwright-bdd`](../playwright-bdd/SKILL.md).
- Browser-level conventions: [`playwright`](../playwright/SKILL.md).
- Test-layer scope: [`testing-standards.md`](../../../../rules/testing-standards.md).
- Example feature: [`examples/invoice-issue.feature`](./examples/invoice-issue.feature).
