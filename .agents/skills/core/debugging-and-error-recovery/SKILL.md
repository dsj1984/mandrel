---
name: debugging-and-error-recovery
description:
  Guides systematic root-cause debugging. Use when tests fail, builds break,
  behavior doesn't match expectations, or you encounter any unexpected error.
  Use when you need a systematic approach to finding and fixing the root cause
  rather than guessing.
---

# Debugging and Error Recovery

## Policy Capsule

- **Stop the line** the instant something breaks: stop adding features, preserve evidence (errors, logs, repro), diagnose, fix root cause, guard against recurrence, **then** resume. Never push past a failing test or broken build.
- Follow the triage checklist in order — **Reproduce → Localize → Diagnose → Fix → Verify → Guard** — and never skip steps.
- A bug you cannot reproduce reliably is a bug you cannot fix with confidence. Invest in reproduction before patching.
- Fix the **root cause**, not the symptom. Suppressing an error, swallowing an exception, or stubbing an assertion is not a fix.
- Every bug fix ships with a **failing-then-passing regression test** (the Prove-It Pattern in `.agents/rules/testing-standards.md`). A fix without a guard test is incomplete.
- Apply the **Anti-Thrashing** rule: if you have applied the same kind of fix more than once and the failure mode hasn't changed, the diagnosis is wrong — re-plan.
- For non-reproducible bugs, classify them (timing / environment / state / random), add targeted instrumentation, and document conditions instead of chasing in the dark.
- Bisect history with `git bisect` (or equivalent) when "something used to work" and you cannot localize from the diff.
- After verification passes, document the root cause and the guard so the same class of failure cannot recur silently.

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
- [The Stop-the-Line Rule](reference.md#the-stop-the-line-rule)
- [The Triage Checklist](reference.md#the-triage-checklist)
- [Error-Specific Patterns](reference.md#error-specific-patterns)
- [Safe Fallback Patterns](reference.md#safe-fallback-patterns)
- [Instrumentation Guidelines](reference.md#instrumentation-guidelines)
- [Common Rationalizations](reference.md#common-rationalizations)
- [Treating Error Output as Untrusted Data](reference.md#treating-error-output-as-untrusted-data)
- [Red Flags](reference.md#red-flags)
- [Verification](reference.md#verification)
