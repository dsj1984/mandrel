---
name: code-review-and-quality
description:
  Conducts multi-axis code review and runs the disciplined post-green refactor
  pass. Use before merging any change, when reviewing code written by yourself,
  another agent, or a human, or when the opt-in `delivery.refactorStage`
  checkpoint asks for a behaviour-preserving CRAP/duplication pass after the
  suite is green.
---

# Code Review and Quality

## Policy Capsule

- Every change gets reviewed before merge — no exceptions, including agent-authored code.
- Apply the **five-axis review** to every change: **Correctness, Readability & Simplicity, Architecture, Security, Performance**.
- Approval standard: approve when the change **definitely improves overall code health**, even if it isn't perfect. Don't block on stylistic preferences that match project conventions.
- Verify the spec/task requirements are met, edge cases (null, empty, boundary) and error paths are handled, and the tests are actually testing the right things — not just that they pass.
- Reject "clever" code in favour of the boring, obvious solution. Abstractions MUST earn their complexity (no generalizing before the third use case).
- Flag dead code artifacts (`_unused` vars, backwards-compat shims, `// removed` comments) and require their removal before merge.
- Defer to `.agents/rules/security-baseline.md` and the `security-and-hardening` skill for security review; explicit checks include input validation, no hardcoded secrets, parameterized queries, encoded output, authn+authz, and treating external data as untrusted.
- Review performance on the hot path only, and measure before optimizing; explicit checks include no N+1 queries, no unbounded fetches, no blocking sync work, no obviously oversized bundles.
- Disallow scope creep in a PR: drive-by cleanups, adjacent refactors, and "while I'm here" edits should be split into a separate change.
- Bug-fix reviews cover **both** the fix and the regression test; a fix without a failing-then-passing test is not approvable.
- **Refactoring is post-green and behaviour-preserving.** Run the refactor pass only when the suite is already green and gates pass; inputs, outputs, side effects, error semantics, and ordering MUST be identical before and after, and existing tests MUST keep passing **without modification** (if a test had to change, behaviour changed — revert).
- **Lower CRAP by lowering complexity, and remove duplication at the root.** Target the highest-CRAP well-covered functions and the largest verbatim duplications by measurement (`check-baselines.js`), not by smell; extract one well-named helper rather than leaving near-copies. CRAP must not rise and maintainability must not fall on any touched file, and no gate, floor, or threshold may be retuned to make the pass "succeed".

## Long-form reference — read on demand

The capsule above is the contract and the whole always-read surface of this
skill. The long-form material behind it — patterns, worked examples,
checklists, and rationalizations — lives in the on-demand sibling
[`reference.md`](reference.md), matching the split the always-on rules already
use ([`rules/git-conventions.md`](../../../rules/git-conventions.md) ⇄
[`git-conventions-reference.md`](../../../rules/git-conventions-reference.md)).
Activating this skill costs the capsule; open a section below only when the
task actually engages it.

- [Overview](reference.md#overview)
- [When to Use](reference.md#when-to-use)
- [The Five-Axis Review](reference.md#the-five-axis-review)
- [Change Sizing](reference.md#change-sizing)
- [Change Descriptions](reference.md#change-descriptions)
- [Review Process](reference.md#review-process)
- [Multi-Model Review Pattern](reference.md#multi-model-review-pattern)
- [Dead Code Hygiene](reference.md#dead-code-hygiene)
- [Review Speed](reference.md#review-speed)
- [Handling Disagreements](reference.md#handling-disagreements)
- [Honesty in Review](reference.md#honesty-in-review)
- [Dependency Discipline](reference.md#dependency-discipline)
- [The Review Checklist](reference.md#the-review-checklist)
- [Common Rationalizations](reference.md#common-rationalizations)
- [Red Flags](reference.md#red-flags)
- [Post-Green Refactor Pass](reference.md#post-green-refactor-pass)
- [Verification](reference.md#verification)
