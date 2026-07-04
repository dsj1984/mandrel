# epic-plan-decompose-author — examples & extended rationale

Read this file on demand while authoring the ticket array. The SKILL.md carries
the operating contract (Policy Capsule, Inputs / Outputs, Procedure, the
authoring guidance that complements the rendered decomposer prompt, and
Constraints); this file carries the worked WAVE-0 BDD scaffold Story and the
extended reasoning behind it.

## WAVE-0 BDD scaffold Story — worked example

The contract lives in SKILL.md under **WAVE-0 BDD SCAFFOLD STORY**: when the
Epic body's `## Acceptance Table` carries one or more `Disposition: new` rows,
emit **exactly one** dedicated wave-0 scaffold Story whose sole job is to create
those `.feature` files with `@skip`-tagged scenarios (each also carrying its
namespaced `@epic-<id>-ac-N` tag) BEFORE any implementation Story runs.

**Worked example.** Epic #42, Acceptance Table with two `new` rows
(`AC-1` -> `tests/features/billing/invoice.feature`,
`AC-2` -> `tests/features/billing/refund.feature`). The scaffold Story below
uses a serialized string `body`, top-level `acceptance`/`verify` arrays, an
empty `depends_on`, and tags each scenario with both `@skip` and its namespaced
`@epic-42-ac-N` tag:

    {
      "slug": "scaffold-billing-feature-files",
      "type": "story",
      "title": "Scaffold @skip-tagged billing feature files",
      "depends_on": [],
      "labels": ["type::story", "persona::qa-engineer"],
      "acceptance": [
        "tests/features/billing/invoice.feature and tests/features/billing/refund.feature both exist on the branch",
        "every Scenario in the two new feature files is preceded by an @skip tag (grep for un-skipped scenarios returns zero matches)",
        "the invoice.feature scenario carries @epic-42-ac-1 and the refund.feature scenario carries @epic-42-ac-2"
      ],
      "verify": [
        "test -f tests/features/billing/invoice.feature && test -f tests/features/billing/refund.feature (validate)",
        "test -z \"$(grep -rL '@skip' tests/features/billing/*.feature)\" (validate)",
        "grep -q '@epic-42-ac-1' tests/features/billing/invoice.feature && grep -q '@epic-42-ac-2' tests/features/billing/refund.feature (validate)"
      ],
      "body": "## Goal\nbdd-scaffold: create the @skip-tagged, @epic-42-ac-N-tagged feature files the billing-flows implementation Stories verify against, so wave-0 lands them before any implementation Story runs.\n\n## Changes\n- {\"path\": \"tests/features/billing/invoice.feature\", \"assumption\": \"creates\"}\n- {\"path\": \"tests/features/billing/refund.feature\", \"assumption\": \"creates\"}\n\n## Acceptance\n- [ ] tests/features/billing/invoice.feature and tests/features/billing/refund.feature both exist on the branch\n- [ ] every Scenario in the two new feature files is preceded by an @skip tag\n- [ ] the invoice.feature scenario carries @epic-42-ac-1 and the refund.feature scenario carries @epic-42-ac-2\n\n## Verify\n- test -f tests/features/billing/invoice.feature && test -f tests/features/billing/refund.feature (validate)\n- test -z \"$(grep -rL '@skip' tests/features/billing/*.feature)\" (validate)\n- grep -q '@epic-42-ac-1' tests/features/billing/invoice.feature && grep -q '@epic-42-ac-2' tests/features/billing/refund.feature (validate)\n"
    }

The implementation Stories that later un-skip and flesh out these scenarios each
carry `depends_on: ["scaffold-billing-feature-files"]`, placing them in a later
wave than the scaffold. They MUST NOT add the `@epic-42-ac-N` tag themselves —
it is already present from the scaffold pass; their job is to remove `@skip`
once the scenario passes.
