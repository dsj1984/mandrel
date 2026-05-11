---
description: >-
  Fan out the audit-* suite in one parallel turn. Dispatch one Agent call per
  audit-* child (security, clean-code, dependencies, devops, lighthouse,
  performance, privacy, quality, seo, sre, ux-ui, architecture) and collect
  the per-child return envelopes for aggregation into a unified report.
recommendedModel: opus
# rationale: aggregation reasoning across 12 audit envelopes benefits from opus
dispatchModel: haiku
# rationale: per-audit children are structured scan + report writers — haiku is fast and sufficient
---

# /audit-fan-out

## Overview

`/audit-fan-out` is a **parallel orchestrator** that runs every `audit-*`
workflow in this directory as a separate sub-agent and folds the results
into one unified report. It mirrors `/epic-deliver` Phase 2a's dispatch
shape (one assistant turn, N parallel `Agent` calls) but at the audit
layer rather than the Story layer.

```text
/audit-fan-out
  → one assistant turn:
      Agent × 12 parallel calls (subagent_type: general-purpose, model: haiku):
        /audit-security
        /audit-clean-code
        /audit-dependencies
        /audit-devops
        /audit-lighthouse
        /audit-performance
        /audit-privacy
        /audit-quality
        /audit-seo
        /audit-sre
        /audit-ux-ui
        /audit-architecture
  → aggregate per-child envelopes into one unified report grouped by status
```

The frontmatter declares `recommendedModel: opus` (the aggregator runs in
the parent's loop and benefits from reasoning headroom) and
`dispatchModel: haiku` (the children are structured scanners + report
writers, well within haiku's competency and ~4–6× cheaper). See
[`README.md`](README.md) for the precedence rules.

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) Rule 3
> for the dispatch below — N independent audit dimensions get N parallel
> `Agent` calls in one turn, not a serial chain.

## Step 1 — Children

The fan-out enumerates the **12 audit-\* children** that live in this
directory. They are independent of each other (no shared write paths —
each writes to `{{auditOutputDir}}/audit-<dimension>-results.md`), so all
12 dispatch in a single assistant turn:

| # | Slash command | Workflow file |
| :-- | :-- | :-- |
| 1 | `/audit-security` | [audit-security.md](audit-security.md) |
| 2 | `/audit-clean-code` | [audit-clean-code.md](audit-clean-code.md) |
| 3 | `/audit-dependencies` | [audit-dependencies.md](audit-dependencies.md) |
| 4 | `/audit-devops` | [audit-devops.md](audit-devops.md) |
| 5 | `/audit-lighthouse` | [audit-lighthouse.md](audit-lighthouse.md) |
| 6 | `/audit-performance` | [audit-performance.md](audit-performance.md) |
| 7 | `/audit-privacy` | [audit-privacy.md](audit-privacy.md) |
| 8 | `/audit-quality` | [audit-quality.md](audit-quality.md) |
| 9 | `/audit-seo` | [audit-seo.md](audit-seo.md) |
| 10 | `/audit-sre` | [audit-sre.md](audit-sre.md) |
| 11 | `/audit-ux-ui` | [audit-ux-ui.md](audit-ux-ui.md) |
| 12 | `/audit-architecture` | [audit-architecture.md](audit-architecture.md) |

## Step 2 — Dispatch (parallel)

Emit **one assistant turn** containing **12 parallel `Agent` tool calls**,
one per audit child. Use `subagent_type: general-purpose` and pass
`model: 'haiku'` on every call (resolved from this workflow's
`dispatchModel`; see [`README.md`](README.md) for the precedence rules).

Each Agent call's prompt names the audit, instructs the child to invoke
the corresponding `/audit-<dimension>` slash command, reminds it of the
non-interactive contract (no clarifying questions; produce the report
file even if findings are sparse), and states the return-envelope
contract the child owes the aggregator.

### Concurrency cap and overflow

Respect `orchestration.concurrencyCap` (or the caller's slot budget). The
default cap in this codebase is typically 5–6; the audit suite has 12
children, so overflow is the common case.

When `12 > concurrencyCap`:

1. Dispatch the **first `concurrencyCap`** children in the initial
   assistant turn, each as a background `Agent` call with
   `run_in_background: true`. The remaining `12 - concurrencyCap` stay
   queued.
2. Stream their stdout events via the `Monitor` tool (one event per
   stdout line). As **each** in-flight child returns its task
   notification, dispatch the **next** undispatched audit immediately —
   keep the in-flight count at `concurrencyCap` until every audit has
   been dispatched, then drain the remaining returns.
3. **Never** exceed `concurrencyCap` in flight. **Never** wait for a
   whole batch to return before refilling — refill on each individual
   return.

This is the same overflow pattern `/epic-deliver` Phase 2a uses for
`plan[N].length > concurrencyCap`. See
[`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) Rule 3 for
the canonical shape.

## Constraints

- **Never** dispatch the audits serially. The whole point of this
  workflow is the one-turn parallel shape; falling back to a serial
  chain defeats the dispatch-performance pass this skill was built for.
- **Never** exceed `concurrencyCap` in-flight `Agent` calls. Overflow
  must drain via `run_in_background` + `Monitor` per Step 2.
- **Always** pass `model: 'haiku'` on every `Agent` call, resolved from
  this workflow's `dispatchModel`. A per-call literal `model:` argument
  overrides it for that one call (see [`README.md`](README.md)
  precedence rules) — use this escape hatch only when one audit
  genuinely needs different reasoning headroom than the rest.
