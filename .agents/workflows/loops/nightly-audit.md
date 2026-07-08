---
description: >-
  Cron maintenance loop that runs a nightly audit sweep over the repository and
  files actionable findings. Each run executes the audit workflows and routes
  the results; the host (`/schedule` or a cron-driven `/loop`) owns the cadence.
  verify is optional for a cron loop — the scheduler owns iteration, so this
  unit ships the action and goal, not a terminating oracle.
loop:
  cadence: cron
  goal: >-
    Keep the repository's standing health surfaced by running the audit sweep on
    a nightly schedule and turning each fresh finding into an actionable, deduped
    record so regressions are caught within a day rather than at release time.
  maxRounds: 30
  onExhaust: report
---

# /loops:nightly-audit — scheduled maintenance audit sweep

A **cron maintenance loop**. The host (`/schedule`, or a cron-driven `/loop`)
owns the cadence and fires this unit once per scheduled window — typically
overnight. Because the scheduler owns iteration, this unit carries **no
`verify` oracle**: per the loop-unit schema, `verify` is required only for
`self-paced` cadence and optional for `interval` / `cron`. Each run is a single
sweep that observes, records, and yields until the next scheduled tick.

## Action

Each scheduled run:

1. **Run the audit sweep.** Execute the relevant audit workflows for the repo
   (`/audit-security`, `/audit-clean-code`, `/audit-dependencies`,
   `/audit-quality`, and any others the project relies on). Each audit writes a
   structured `temp/audits/audit-*-results.md` report — that is the canonical
   artifact this loop consumes, not free-form prose. Because these audits are
   **independent** of one another, a scheduled run **may fan them out to
   parallel sub-agents** (one per audit) rather than walking them serially —
   the same cross-lens parallelization `/deliver` Phase 4 uses (see
   [`../helpers/epic-audit.md` § "Optional: delegate the roster walk to an
   audit-orchestrator sub-agent"](../helpers/epic-audit.md)). Each sub-agent
   returns only its structured report; the scheduler/host owns the fan-out just
   as it owns the cadence, and each per-audit strategy (sequential or
   orchestrated) is unchanged by running under its own sub-agent.
2. **Diff against the prior night.** Compare the fresh findings against the last
   sweep's reports and against already-open Issues. A finding seen before is
   not new signal; only genuinely fresh or regressed findings warrant a record.
3. **Route fresh findings.** Hand the new findings to `/audit-to-stories`, which
   deduplicates against existing Issues by fingerprint and either chains into
   `/plan` or opens standalone Stories. Do not open raw duplicate Issues —
   dedup is the loop's job, not the operator's.
4. **Report and yield.** Emit a short digest (sweeps run, new findings, Issues
   opened or updated) and return control to the scheduler, which sleeps until
   the next cron window.

## Goal & done-signal

- **Goal:** the repository's health regressions are caught and turned into
  actionable, deduplicated records within a day, without a human remembering to
  run the audits by hand.
- **Done-signal:** the nightly sweep completed and every fresh finding has been
  routed to a record (or explicitly judged a non-finding). A cron loop has no
  self-evaluated oracle — the scheduler owns whether the loop runs again; this
  unit simply finishes the night's sweep and yields.
- **Backstop:** `maxRounds: 30`. Roughly a month of nightly runs;
  `onExhaust: report` emits a final digest and stops so a long-lived schedule
  is renewed deliberately rather than running unbounded.

## Stop & escalate

- **An audit cannot run** (a required tool is missing, the audit harness errors,
  the working tree is dirty in a way that invalidates the sweep). Report the
  failure for that audit and continue with the others — do not abort the whole
  night because one audit broke.
- **A finding is high-severity and time-sensitive** (an exposed secret, a
  critical CVE reachable in production). Surface it loudly in the digest rather
  than letting it sit as one row among many — a nightly cadence is too slow for
  an actively-exploitable finding.
- **`maxRounds` is reached.** Emit a final digest (`onExhaust: report`) so the
  operator can renew or retire the schedule deliberately.
