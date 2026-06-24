---
description: >-
  Interval watch loop that polls a pull request's CI checks until they settle.
  Each round runs `gh pr checks` and reports the delta; the host (`/loop 5m`)
  owns the cadence and re-invokes the unit on its schedule. verify is optional
  for an interval loop — the externally-scheduled host owns iteration, so this
  unit ships the action and goal, not a terminating oracle.
loop:
  cadence: interval
  goal: >-
    Keep an eye on the current pull request's required CI checks each interval,
    surfacing the first failed or stuck check the moment it appears so a human
    can act before the checks finish.
  maxRounds: 60
  onExhaust: report
---

# /loops:watch-ci — poll a PR's checks until they settle

An **interval watch loop**. The host (`/loop <interval> /loops:watch-ci`, e.g.
`/loop 5m …`) owns the cadence and re-runs this unit on each tick. Because the
host schedules iteration externally, this unit carries **no `verify` oracle** —
per the loop-unit schema, `verify` is required only for `self-paced` cadence and
optional for `interval` / `cron`. The unit's job each round is to observe and
report, not to converge.

## Action

Each interval:

1. **Read the current check state.** Run `gh pr checks` for the PR under watch
   (the host supplies the PR number, or it is inferred from the current
   branch's open PR). Capture the per-check status: pending, passed, or failed.
2. **Compute the delta since last round.** Compare against the prior round's
   snapshot. A check that flipped `pending → failed` is the headline; a check
   that flipped `pending → passed` is progress.
3. **Surface failures immediately.** On the first failed or cancelled required
   check, report it — name the check, link the run, and quote the first error
   line if cheaply available — so a human can act before the rest of the matrix
   finishes. Do not wait for the whole suite to settle to raise a red check.
4. **Report and yield.** Emit a one-line status summary
   (`N passed, M pending, K failed`) and return control to the host, which
   sleeps until the next interval.

## Goal & done-signal

- **Goal:** the operator learns about a CI failure on the watched PR as early as
  the polling interval allows, and knows when all required checks have gone
  green.
- **Done-signal:** all required checks have a terminal status (every check
  passed, or at least one has failed). An interval loop has no self-evaluated
  oracle — the host stops the loop when the operator cancels it, when a failure
  is surfaced and acted on, or when `maxRounds` is reached.
- **Backstop:** `maxRounds: 60`. At a 5-minute interval that is ~5 hours of
  watching; `onExhaust: report` emits a final status and stops rather than
  polling forever on a wedged check.

## Stop & escalate

- **A required check failed.** Surface it and let the operator decide whether to
  keep watching the remaining checks or stop. A failed required check is the
  signal the watch existed to catch.
- **The PR cannot be resolved** (no open PR for the branch, `gh` not
  authenticated, the PR was merged or closed out from under the watch). Report
  the condition and stop — there is nothing left to watch.
- **`maxRounds` is reached with checks still pending.** Emit a final summary of
  the stuck checks (`onExhaust: report`) so the operator can investigate the
  wedged run.
