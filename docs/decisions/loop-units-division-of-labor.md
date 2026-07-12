# ADR: Loop units — mandrel owns content + oracle + contract; the host owns cadence + iteration

**Status:** Accepted
**Date:** 2026-06-24
**Epic:** [#4284](https://github.com/dsj1984/mandrel/issues/4284) — loop-unit
schema, namespaced `/loops:` projection, and operator-facing starter loops.
**Stories:** [#4288](https://github.com/dsj1984/mandrel/issues/4288) (schema +
validator + lint gate), [#4289](https://github.com/dsj1984/mandrel/issues/4289)
(namespaced `/loops:` projection),
[#4290](https://github.com/dsj1984/mandrel/issues/4290) (starter units + this
ADR).
**Builds on:**
[ADR 20260512-coupling-stance](../decisions.md#adr-20260512-coupling-stance-two-surface-coupling-stance)
(Claude Code-first workflow surface; prefer built-ins over homegrown
re-implementations) and
[ADR 20260512-loop-adoption](../decisions.md) (adopt the built-in `/loop`; no
homegrown loop surface to reconcile).

## Context

Recurring/iterative work — "drive this red suite to green", "watch the PR's CI
until it settles", "run the audit sweep every night" — recurs across many
projects. A naive framework instinct is to build a **runner** for it: a `/goal`
command that holds a definition of done, a `/loop` engine that paces rounds and
evaluates the oracle, a scheduler that fires cron work. That instinct is wrong
here for two reasons:

1. **Claude Code already ships the runner.** The built-in `/loop` paces both
   self-paced and interval loops, and `/schedule` runs cron-driven cloud
   agents. Per the two-surface coupling stance, the workflow surface is
   Claude Code-first and **prefers built-ins over homegrown re-implementations**
   when their contract matches. Building a mandrel `/loop` or `/goal` would
   duplicate a built-in and Claude-lock nothing in return — it is pure surface
   area to maintain.
2. **The durable, portable, reviewable part of recurring work is the
   *definition*, not the *driver*.** What a round *does*, what *done* means, and
   the runnable check that proves a round complete are content that belongs in
   the repository, version-controlled and lint-gated. The pacing — when the next
   round fires, how many rounds, the sleep between ticks — is host runtime
   concern, not a contract a consumer should re-implement.

The risk this ADR exists to prevent: a contributor reflexively builds a `/goal`
or `/loop` runner inside the framework, re-deriving pacing and oracle-evaluation
logic the host already owns, and creating a homegrown surface that drifts from
the built-in it shadows.

## Decision

**Mandrel ships loop *units* — content and contract — and ships no runner.**
The division of labor is fixed as:

### Mandrel owns (the loop *unit*)

- **The action** — what one round of the loop does (the `## Action` body).
- **The goal** — the standing objective each round works toward
  (`loop.goal`, required).
- **The `verify` oracle** — the runnable check that proves a round is complete
  (`loop.verify`). **Required for `self-paced` cadence** (nothing external paces
  it, so the oracle is the only stop signal); **optional for `interval` /
  `cron`** (an external scheduler owns iteration).
- **The observability / escalation contract** — the `maxRounds` backstop, the
  `onExhaust` policy (`block` / `report` / `hand-back`), and the explicit
  "stop & escalate" conditions in each unit's body. This is the safety
  contract that keeps a loop from running unbounded or papering over a wrong
  diagnosis.

A loop unit is a markdown file under `.agents/workflows/loops/` whose
frontmatter was validated against `.agents/schemas/loop-unit.schema.json`
by `check-loop-units.js` (wired into `npm run lint`), and which projects to the
namespaced `/loops:<name>` command via `sync-claude-commands.js`.

> **Retirement addendum (#4482, 2026-07-12).** The three starter units, the
> schema, and `check-loop-units.js` were retired: the starters were pure
> adapters over host-native behavior and never ran. The division of labor
> this ADR records (host owns the driver; a unit is content-only) stands —
> `sync-claude-commands.js` still projects consumer-authored
> `.agents/local/workflows/loops/` units — but the framework ships no
> starter units and no frontmatter lint gate.

### The host owns (the loop *driver*)

- **Cadence** — when the next round fires. Self-paced and interval loops are
  driven by the built-in **`/loop`**; cron loops are driven by **`/schedule`**.
- **Iteration** — the round counter, the sleep between ticks, re-invoking the
  unit each tick, and stopping when the unit's oracle passes or the operator
  cancels.

### No runner is shipped

Mandrel ships **no `/goal` command and no `/loop` runner of its own.** The
built-in `/loop` and `/schedule` are the drivers; a loop unit is the *thing they
drive*. This is the load-bearing prohibition of this ADR: do not add a
framework-side loop engine, scheduler, or definition-of-done command. If a unit
needs a different cadence, that is a host-side `/loop` / `/schedule` invocation,
not new framework code.

## Consequences

- **Adding a starter loop is content-only.** A new `.agents/workflows/loops/*.md`
  with a valid `loop:` block is the entire change — no runner wiring, no
  scheduler plumbing. The three starters
  (`fix-failing-tests` self-paced, `watch-ci` interval, `nightly-audit`
  cron — retired in #4482, see the addendum above) mapped one starter to
  each cadence.
- **The `verify` oracle is the contract seam.** Because a self-paced unit
  carries a runnable oracle, the host `/loop` has a deterministic stop signal it
  did not have to be taught — the unit is portable to any host that can run a
  command and check its exit code.
- **No homegrown surface to reconcile.** There is no mandrel `/loop` or `/goal`
  to keep in lockstep with the built-ins as Claude Code evolves; the coupling
  stance's "prefer built-ins" default is honored by construction.
- **Reversal cost is recorded here.** Should a future host gap force a
  framework-side runner (e.g. a non-Claude-Code runtime with no `/loop`
  equivalent), this ADR is the entry point to revisit — and that runner would
  be a separate Epic with its own superseding ADR, not an incremental addition.

## Alternatives considered

- **Ship a mandrel `/goal` + `/loop` runner.** Rejected — it duplicates the
  built-in `/loop` and `/schedule`, adds a homegrown surface that drifts from
  the built-ins it shadows, and Claude-locks nothing in return. Directly
  contradicts the two-surface coupling stance's "prefer built-ins" rule.
- **Encode loops as ordinary flat workflows (`/<name>`).** Rejected — a loop is
  not a one-shot command; conflating the two loses the cadence/oracle contract
  and the namespaced discoverability that `/loops:<name>` provides. The schema +
  validator + namespaced projection exist precisely to keep loop units a
  distinct, contract-checked category.
- **Make `verify` mandatory for every cadence.** Rejected — interval and cron
  loops are paced by an external scheduler that owns iteration, so a
  self-evaluated terminating oracle is not meaningful for them. The schema makes
  `verify` conditional on `self-paced` for exactly this reason.
