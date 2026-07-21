# CI Failure Triage & Remediation

This rule applies when a delivery path is watching a pull request's CI checks
and a required check is red (or repeatedly slow). The Story Step 4 CI watch +
fix loop ([`deliver-story.md`](../workflows/helpers/deliver-story.md)) hands off
to it: the watcher (`pr-watch-with-update.js`) surfaces the failing check, the
run link, and the failure signature; this rule decides what to do next.

## Goal

**A red check is a defect until proven otherwise, and the fix is always to
remove the defect — never to hide it.** A red required check is resolved in
exactly one of two ways, and no others:

1. **Remove the root cause on the branch.** Pull the failing job log and record
   the failure signature (failing check, run id / run link, first distinctive
   error line — the watcher writes this to
   `temp/story-<id>-ci-digest.{json,md}`). Reproduce the failure, confirm it is
   caused by the diff under review — **verify the same check against an
   unmodified `main` checkout**; if it also fails on `main` the defect is
   pre-existing and belongs in a separate change — then fix it at source,
   commit on `story-<storyId>`, push, and re-run the watcher. Auto-merge stays
   armed across retries. Route deterministic per-check failures (lint/format,
   maintainability/CRAP baseline drift, test failure, coverage threshold)
   through the fix table in
   [`deliver-story-reference.md` § Step 4](../workflows/helpers/deliver-story-reference.md#step-4--ci-watch--fix-recovery);
   refresh a baseline only when the diff demonstrably can't be covered.
2. **File a `meta::framework-gap` issue** when the root cause is outside this
   delivery's scope — a pre-existing flaky test, a runner/infra weakness, a
   framework-level environment gap. Open the issue with the `meta::framework-gap`
   label (see [`git-conventions.md`](git-conventions.md)) carrying **the run
   link and the failure signature** so a later `/plan` Phase 0 sweep can act on
   it. Remediate this delivery only if the pre-existing defect is genuinely
   blocking it.

Infra, transient, and flaky failures are root-cause defects too — a flaky test
that passes on a rerun is still a bug that will fail a future run. They route
through the same two options; bisect environment (runner OS, Node version,
concurrency, a platform-conditional branch, an external service) vs. code (an
order-dependent test, a race, a shared-state assumption) to decide which.

## Verifier

The check is resolved only when it is **green with zero reruns of the failed
job**, and the diff carries **no `.skip` / `.only`, no quarantine, and no
deleted or loosened assertion** introduced to reach green. You may **not**
re-run a failed job to "see if it goes green," and you may **not** skip,
`.only`, or quarantine a flaky test to get a green bar. Both mask the defect
and are prohibited by this rule.

## Escalation

Flip the ticket to `agent::blocked`, post a `friction` comment (naming the
failing check, the run link, the failure signature, the classification you
reached, and what you tried — **never fall silent**), and hand back to the
operator under **any** of:

- **Three strikes.** Three consecutive remediation iterations on the same
  failure class without convergence — the diagnosis is likely wrong (see
  [`instructions.md` § 1.I Anti-Thrashing](../instructions.md)).
- **Wall-clock timebox.** More than **30 minutes** of active remediation on a
  single CI failure without a green bar in sight.
- **Clearly-environmental → escalate immediately.** An unambiguously
  environmental failure outside your control (runner provisioning, a persistent
  registry/network outage, a branch-protection or CI misconfiguration, an
  expired credential) — file the `meta::framework-gap` issue (with run link +
  signature) and escalate on the first encounter rather than burning iterations
  trying to code around it.
