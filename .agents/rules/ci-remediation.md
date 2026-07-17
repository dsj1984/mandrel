# CI Failure Triage & Remediation

This rule applies when a delivery path is watching a pull request's CI checks
and a required check is red (or repeatedly slow) — the `/deliver` router
([`deliver.md`](../workflows/deliver.md)) runs each Story through the
single-Story Step 4 CI watch + fix loop
([`deliver-story.md`](../workflows/helpers/deliver-story.md)), which hands off
to it. It is the single triage brain that mechanism defers to:
the watcher (`pr-watch-with-update.js`) surfaces the failing check, the run
link, and the failure signature; this rule decides what to do next.

The animating principle: **a red check is a defect until proven otherwise, and
the fix is always to remove the defect — never to hide it.** There is no
rerun-the-failed-job path and no quarantine path in this rule, by design.
Reruns and quarantines mask defects; a flaky test that passes on the second
attempt is still a bug that will fail a future run for a real user or a future
delivery. Root-cause it or file it — never re-roll the dice.

## The triage decision tree

When a required check goes red, walk this tree top to bottom. Do **not** skip
to "fix" before you have classified the failure — an unclassified fix is a
guess.

### 1. Pull the evidence

Fetch the failing job log and record the failure signature (the failing check
name, the run id / run link, and the first distinctive error line). The
watcher already writes this to `temp/story-<id>-ci-digest.{json,md}` — start
from that digest.

### 2. Classify the failure

- **Deterministic (real) failure** — the check fails the same way every time,
  and the failure is caused by the diff under review (a lint violation, a
  broken test, a coverage regression, a baseline drift the diff genuinely
  caused). → Go to [§ Real failures](#real-failures--route-to-the-per-check-fix-table).
- **Infra / transient failure** — a runner died, a network fetch timed out, a
  dependency registry 5xx'd, a step hit a platform-conditional path. → Go to
  [§ Infra, transient, and flaky failures](#infra-transient-and-flaky-failures-are-root-cause-defects).
- **Flaky failure** — the check fails intermittently: green on one run, red on
  the next, with **no diff change** between them (order-dependent tests,
  timing/race assertions, shared-state bleed, wall-clock or timezone
  assumptions). → Go to
  [§ Infra, transient, and flaky failures](#infra-transient-and-flaky-failures-are-root-cause-defects).

## Real failures — route to the per-check fix table

A deterministic failure caused by the diff is remediated at source. Use the
existing per-check fix table — do **not** duplicate it here:

- **Story Step 4**:
  [`deliver-story-reference.md` § Step 4 — CI watch + fix recovery](../workflows/helpers/deliver-story-reference.md#step-4--ci-watch--fix-recovery).

In short: lint/format → `npm run lint` + biome apply; maintainability/crap
baseline drift → re-run the ratcheted script and fix at source (refresh a
baseline only when the diff demonstrably can't be covered); test failure →
reproduce with `npm test`, fix source or test; coverage threshold → add tests.
Commit the fix on the delivery branch (`story-<storyId>`), push, and re-run the
watcher. Auto-merge stays armed across retries.

## Infra, transient, and flaky failures ARE root-cause defects

Treat every infra/transient failure **and** every flaky failure as a
root-cause defect. The remediation sequence is the same for both — you do not
get to wave it off because "CI was flaky."

1. **Reproduce.** Run the failing check locally (or in a clean environment as
   close to CI as you can get). Re-run it enough times to observe the
   intermittency for a flaky failure. If you cannot reproduce it at all after a
   genuine attempt, that itself is a finding — record it in the issue you file
   in step 4.
2. **Check whether it also fails on `main`.** Run the same check against an
   unmodified `main` checkout. If it fails on `main`
   too, the defect is **pre-existing** — it is not caused by the diff under
   review, and the fix belongs in a separate change, not silently folded into
   this delivery.
3. **Bisect environment vs. code.** Determine whether the failure is driven by
   the environment (runner OS, Node version, concurrency, a platform-
   conditional branch, an external service) or by the code (an
   order-dependent test, a race, a shared-state assumption). This tells you
   where the fix has to land.
4. **Then either fix in-scope OR file the defect.**
   - **Fix in-scope** when the root cause is within this delivery's footprint
     and the fix is a cohesive part of the change under review (e.g. a race in
     a test the diff touches, a timezone assumption in code the Story owns).
     Commit it on the delivery branch, push, and re-run the watcher.
   - **File a `meta::framework-gap` issue** when the root cause is outside this
     delivery's scope — a pre-existing flaky test, a runner/infra weakness, a
     framework-level environment gap. Open the issue with the
     `meta::framework-gap` label (see
     [`git-conventions.md` § `meta::framework-gap`](git-conventions.md)),
     and include **the run link and the failure signature** (failing check,
     run id, first distinctive error line) captured in step 1 so a later
     `/plan` Phase 0 sweep can act on it. Then remediate this delivery only if
     the pre-existing defect is genuinely blocking it; otherwise proceed once
     the defect is filed and the check is not caused by your diff.

**There is no shortcut.** You may **not** re-run the failed job to "see if it
goes green," and you may **not** quarantine, skip, or `.only`/`.skip` a flaky
test to get a green bar. Both mask the defect and are prohibited by this rule.

## Escalation criteria

Escalate — flip the ticket to `agent::blocked`, post a `friction` comment, and
hand back to the operator — under **any** of the following. These extend the
existing three-strikes halt rule; they do not replace it.

- **Three strikes (existing).** Three consecutive remediation iterations on the
  same failure class without convergence. Stop; the diagnosis is likely wrong
  (see [`instructions.md` § 1.I Anti-Thrashing](../instructions.md)).
- **Wall-clock timebox.** Regardless of iteration count, if you have spent more
  than **30 minutes of active remediation** on a single CI failure without a
  green bar in sight, stop and escalate. A long grind on one red check is
  itself a signal that the failure exceeds a single delivery turn's judgment.
- **Clearly-environmental → escalate immediately (fast path).** When the
  failure is unambiguously environmental and outside your control — a runner
  provisioning failure, a persistent registry/network outage, a
  branch-protection or CI-configuration misconfiguration, an expired
  credential — do **not** burn iterations trying to code around it. File the
  `meta::framework-gap` issue (with run link + signature) and escalate on the
  first encounter. This fast path exists so an operator-side or infra-side
  problem reaches the operator immediately instead of consuming the turn.

When you escalate, name the failing check, the run link, the failure
signature, the classification you reached, and what you tried — never fall
silent.
