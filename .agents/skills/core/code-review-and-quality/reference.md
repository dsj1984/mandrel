# Code Review and Quality — Reference (on-demand)

**Read this when** a task engages one of the sections below and the Policy
Capsule in [`SKILL.md`](SKILL.md) does not settle it on its own. The capsule is
the contract; this file is the reference material behind it. The generic
five-axis review method, change-sizing heuristics, and review-etiquette prose
are frontier-known and are not reproduced here — this file keeps the two
project-specific contracts: the finding-severity table and the measured
post-green refactor pass.

## Finding-Severity Table

Label every review comment with its severity so the author knows what's
required vs. optional — this prevents authors from treating all feedback as
mandatory:

| Prefix                        | Meaning            | Author Action                                           |
| ----------------------------- | ------------------ | ------------------------------------------------------- |
| _(no prefix)_                 | Required change    | Must address before merge                               |
| **Critical:**                 | Blocks merge       | Security vulnerability, data loss, broken functionality |
| **Nit:**                      | Minor, optional    | Author may ignore — formatting, style preferences       |
| **Optional:** / **Consider:** | Suggestion         | Worth considering but not required                      |
| **FYI**                       | Informational only | No action needed — context for future reference         |

## Post-Green Refactor Pass

Review's sibling discipline is the **behaviour-preserving refactor** that drives
CRAP (Change Risk Anti-Patterns) and duplication down _after_ the code is green
— the pass wired in as the opt-in `delivery.refactorStage` checkpoint. It
optimises for the measured CRAP and duplication axes the baselines ratchet, not
for subjective readability, and it never runs from red.

**When to run:** a baseline report flags a high-CRAP function that is already
well-covered (so the lever is complexity, not coverage); the same logic is
duplicated across two or more files and the copies are drifting; or the
`delivery.refactorStage` checkpoint fires after gates pass and before a Story
closes. **When NOT to:** before tests are green (write/fix tests first), or when
a function's CRAP is high because it is _uncovered_ — that is a missing-test
problem, so drive it with the TDD cycle in
[`.agents/rules/testing-standards.md`](../../../rules/testing-standards.md).

```text
Confirm green + baseline  →  pick highest-CRAP / largest dup
        ▲                                  │
        │                                  ▼
  re-run gates, confirm   ◄──  refactor   ◄──  comprehend the target
  CRAP↓ / maint↑, tests pass   (one change)    (call sites + tests)
```

1. **Baseline.** Confirm green and capture current CRAP and maintainability
   (`node .agents/scripts/check-baselines.js`) — your do-no-harm reference.
2. **Target by measurement.** Pick the highest-CRAP well-covered function, or
   the largest verbatim duplication. Work worst-first.
3. **Comprehend before you touch (Chesterton's Fence).** Read the call sites and
   the tests that pin the behaviour first; an "unnecessary" abstraction may
   exist for testability or extensibility.
4. **Refactor one step.** Extract a focused function, flatten nesting into guard
   clauses, replace a nested ternary / boolean-flag param, or extract a single
   shared helper for the duplication (dedup the _behaviour_, not just the text —
   look-alike blocks that encode different responsibilities stay separate).
5. **Verify.** Re-run the affected tests (unmodified) and the baselines. CRAP
   must not rise, maintainability must not fall, tests must pass. If a test
   needed editing, revert — behaviour changed.

Keep each refactor an isolated, reviewable commit separate from feature or fix
work, refactor only the targeted functions/duplications (no drive-by rewrites),
and leave no dead code behind (unused imports, orphaned helpers).

**After a post-green refactor pass, confirm:**

- [ ] The suite was green before and after, with **no test modifications**.
- [ ] CRAP did not rise and maintainability did not fall on any touched file
      (baselines re-run and compared).
- [ ] No gate, floor, or coverage threshold was loosened.
- [ ] Duplication was removed at the root (one helper), not just locally patched.
- [ ] Each refactor is an isolated commit, separate from feature or fix work.
