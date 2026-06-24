---
description: >-
  Self-paced convergence loop that drives a red test suite to green. Each round
  reads the latest failure, applies the smallest fix, and re-runs the verify
  oracle (`npm test`); the loop terminates when the oracle exits 0. The host
  (`/loop`) owns iteration and pacing — mandrel supplies the action, the goal,
  and the terminating oracle.
loop:
  cadence: self-paced
  goal: >-
    Drive the project's test suite from red to green by fixing the root cause of
    each failure, one round at a time, until the verify oracle passes.
  verify: npm test
  maxRounds: 10
  onExhaust: hand-back
---

# /loops:fix-failing-tests — drive a red suite to green

A **self-paced convergence loop**. The host (`/loop` with no interval) decides
when to run the next round; this unit supplies the action each round performs,
the standing goal, and the runnable `verify` oracle that tells the host when to
stop. When `npm test` exits 0, the goal is met and the loop terminates.

> **Scope.** This loop fixes the **root cause** of failing tests. It does not
> delete, skip, `.only`, or weaken assertions to force a green bar — that is an
> escalation condition, not a round (see **Stop & escalate** below).

## Action

Each round:

1. **Read the latest failure.** Run the verify oracle (`npm test`) and read the
   first failing assertion — name, file, and the expected-vs-actual diff. Fix
   one failure cluster per round; do not fan out across unrelated failures in a
   single round.
2. **Diagnose the root cause.** Decide whether the failure is in the production
   code under test or in the test's own setup/expectation. Prefer the
   smallest change that makes the assertion honest — fix the code when the test
   encodes the intended contract; fix the test only when it asserts the wrong
   thing and you can state why in one sentence.
3. **Apply the smallest fix.** Make the minimal edit that addresses the
   diagnosed cause. Avoid speculative refactors — convergence depends on each
   round changing exactly one thing.
4. **Re-run the oracle.** Run `npm test` again. A reduced failure count is
   progress; a new failure introduced by the fix means the diagnosis was wrong
   — revert and re-diagnose rather than stacking another fix on top.

## Goal & done-signal

- **Goal:** the test suite passes — every test green, no skipped-to-hide
  failures.
- **Done-signal (the oracle):** `npm test` exits 0. This is the single
  terminating check the host `/loop` evaluates after each round. When it
  passes, stop — the loop is complete.
- **Backstop:** `maxRounds: 10`. If the oracle is still red after ten rounds,
  the `onExhaust: hand-back` policy returns control to the caller with a
  summary rather than looping indefinitely.

## Stop & escalate

Stop the loop and hand back (do **not** keep iterating) when:

- **The same failure survives the same class of fix twice.** Per the
  anti-thrashing protocol, a repeated fix against an unchanged failure means
  the diagnosis is wrong — stop and report what you tried.
- **A fix would weaken the contract.** If the only way to make the bar green is
  to delete a test, add `.skip` / `.only`, or relax an assertion to match buggy
  behaviour, that is a product decision, not a loop round. Stop and surface it.
- **The failure is environmental, not a code defect** (missing service, absent
  credential, a flaky timing-dependent test). The loop cannot converge on an
  external cause — report the blocker so the operator can resolve it.
- **`maxRounds` is reached with the oracle still red.** Hand back a summary of
  the remaining failures and the rounds spent.
