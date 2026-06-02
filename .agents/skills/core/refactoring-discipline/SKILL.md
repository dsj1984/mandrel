---
name: refactoring-discipline
description:
  Run a post-green refactor pass that lowers CRAP and removes duplication
  without changing behaviour. Use after tests pass and gates are green, when
  a function's CRAP score is high but well-covered, or when the same logic is
  duplicated across files. Pairs with the `refactorer` persona and the
  opt-in `delivery.refactorStage` checkpoint; complements
  `core/code-simplification` (clarity) by focusing on the measured
  CRAP/duplication axes.
---

# Refactoring Discipline

## Policy Capsule

- **Post-green only.** Run this pass when the suite is already green and the quality gates already pass. You never refactor from red, and you never make a failing test pass under the banner of "refactoring" — that is a behaviour change.
- **Preserve behaviour exactly.** Inputs, outputs, side effects, error semantics, and ordering MUST be identical before and after. Existing tests MUST keep passing **without modification**; if a test had to change, the refactor changed behaviour — revert it.
- **Lower CRAP by lowering complexity, not by adding coverage.** CRAP = `complexity² × (1 − coverage)³ + complexity`. The refactorer's lever is the *complexity* factor: extract functions, flatten nesting with guard clauses, replace nested ternaries and boolean-flag params, and split multi-responsibility functions. Adding tests to a tangled function is the test author's job, not this pass.
- **Remove duplication at the root.** Extract one well-named helper for repeated logic instead of leaving near-copies that drift apart. Dedup the *behaviour*, not just the text — collapse copies only when they are genuinely the same responsibility.
- **Target by measurement, not by smell.** Work from the baselines (`check-baselines.js` CRAP/maintainability) and pick the highest-CRAP, well-covered functions and the largest verbatim duplications first. Prove each number moved the right way after the change.
- **Do no harm to the gates.** After every change, CRAP must not rise and maintainability must not fall for any touched file. A refactor that regresses a baseline is not done — back it out. Never retune a gate, floor, or coverage threshold to make the pass "succeed".
- **Comprehend before you touch (Chesterton's Fence).** Read the call sites and the tests first; never refactor code you do not fully understand. An "unnecessary" abstraction may exist for testability or extensibility.
- **Incremental and isolated.** One behaviour-preserving change at a time, re-running the affected tests after each. Keep refactors in their own commits, separate from feature or fix work, so diffs stay reviewable and revertible.
- **Scope discipline.** Refactor only the targeted functions/duplications. No drive-by rewrites of untargeted modules — unscoped churn adds regression risk and noise.

## Overview

CRAP (Change Risk Anti-Patterns) flags functions that are both complex and
under-tested; duplication multiplies the cost of every future change. This
skill is the disciplined, **behaviour-preserving** pass that drives those two
metrics down *after* the code is green — the post-green stage owned by the
[`refactorer`](../../../personas/refactorer.md) persona and wired in as the
opt-in `delivery.refactorStage` checkpoint. It complements
[`core/code-simplification`](../code-simplification/SKILL.md): simplification
optimises for human comprehension; this skill optimises for the measured
CRAP and duplication axes the baselines ratchet.

## When to Use

- A baseline report flags a function with high CRAP that is already
  well-covered (so the lever is complexity, not coverage).
- The same logic is duplicated across two or more files and the copies are
  starting to drift.
- An opt-in `delivery.refactorStage` checkpoint runs after gates pass and
  before a story closes.

**When NOT to use:** before tests are green (write/fix tests first); when a
high-CRAP function is high because it is *uncovered* (that is a missing-test
problem — use `core/test-driven-development` or
`core/mutation-survivor-remediation`); or for pure clarity tweaks with no
metric impact (use `core/code-simplification`).

## The Refactor Loop

```text
Confirm green + baseline  →  pick highest-CRAP / largest dup
        ▲                                  │
        │                                  ▼
  re-run gates, confirm   ◄──  refactor   ◄──  comprehend the target
  CRAP↓ / maint↑, tests pass   (one change)    (call sites + tests)
```

1. **Baseline.** Confirm the suite is green and capture current CRAP and
   maintainability (`node .agents/scripts/check-baselines.js`). This is your
   do-no-harm reference.
2. **Target.** Pick the highest-CRAP well-covered function, or the largest
   verbatim duplication. Work worst-first.
3. **Comprehend.** Read the call sites and the tests that pin the behaviour
   before touching anything.
4. **Refactor one step.** Extract a function, flatten nesting into guard
   clauses, replace a nested ternary / boolean-flag param, or extract a
   shared helper for the duplication.
5. **Verify.** Re-run the affected tests (unmodified) and the baselines.
   CRAP must not rise, maintainability must not fall, tests must pass. If a
   test needed editing, revert — behaviour changed.

## CRAP & Duplication Targeting

- **CRAP lever is complexity.** Reduce branches and nesting per covered
  line. Extracting a focused helper moves complexity out of the hot
  function and lowers its CRAP without inflating the suite.
- **Duplication lever is a single source.** Replace N near-copies with one
  helper, then delete the now-dead copies *within* the touched files.
- **Equivalent-by-coincidence is not duplication.** Two blocks that look
  alike but encode different responsibilities should stay separate; merging
  them couples unrelated change reasons.

## Red Flags

- Editing a test to keep it passing after a "refactor" (behaviour changed).
- CRAP or maintainability regressing on a touched file and shipping anyway.
- Retuning a gate, floor, or coverage threshold to make the pass succeed.
- Refactoring an uncovered function to lower CRAP — that needs tests, not a
  restructure.
- Merging look-alike blocks that encode different responsibilities.
- Drive-by rewrites of modules the pass did not target.

## Verification

- [ ] The suite was green before the pass and is green after, with **no test
      modifications**.
- [ ] CRAP did not rise and maintainability did not fall on any touched
      file (baselines re-run and compared).
- [ ] No gate, floor, or coverage threshold was loosened.
- [ ] Duplication was removed at the root (one helper), not just locally
      patched.
- [ ] Each refactor is an isolated, reviewable commit, separate from feature
      or fix work.
- [ ] No dead code left behind after extractions (unused imports, orphaned
      helpers).
