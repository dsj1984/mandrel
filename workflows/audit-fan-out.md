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
[`README.md`](../README.md#workflow-authoring) for the precedence rules.

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
`dispatchModel`; see [`README.md`](../README.md#workflow-authoring) for
the precedence rules).

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

## Step 3 — Return envelope

Each child sub-agent owes its parent (you, the aggregator) a single
fenced JSON object as its terminal message, shaped exactly:

```json
{
  "status": "ok" | "warn" | "fail",
  "keyFindings": ["<string>", "..."],
  "reportLink": "<relative or absolute path to the dimension report>"
}
```

Field semantics:

- **`status`** (`'ok' | 'warn' | 'fail'`) — terminal posture for the
  dimension:
  - `"ok"` — no Critical or High findings; the dimension is in good
    shape.
  - `"warn"` — Medium-severity findings present, or a single isolated
    High that is already tracked in the backlog. Worth reading the
    report but not a release blocker.
  - `"fail"` — one or more Critical findings, or a cluster of High
    findings that materially affect the release posture. Blocks
    promotion until triaged.
- **`keyFindings`** (`string[]`) — an array of 1–5 short strings
  (≤ 120 chars each) summarising the top issues from the dimension
  report's "Detailed Findings" section. These are the lines a human
  will scan first in the unified report; they should name the issue,
  not restate the audit dimension.
- **`reportLink`** (`string`) — a path string pointing at the full
  audit report written by the child (typically
  `{{auditOutputDir}}/audit-<dimension>-results.md`). The aggregator
  uses this for drill-down links in the unified report; do **not**
  inline the full report body in the envelope.

If a child cannot complete its audit (tooling missing, scope
unparseable), it returns `status: "fail"` with `keyFindings: ["<reason>"]`
and `reportLink: null`. The aggregator surfaces the failure in the
unified report rather than swallowing it.

## Step 4 — Aggregation

Once every child has returned (or the overflow drain is complete),
compose the **unified report** by grouping the per-child envelopes by
their `status` field. Read each envelope's `keyFindings` and
`reportLink` to build the table — do **not** re-open the dimension
reports to re-derive the fields; the envelope is the contract.

The unified report has three sections in this order:

1. **`## Failures`** — every child whose envelope had
   `status: "fail"`. For each, render the audit dimension name, the
   `keyFindings` array as a bulleted list, and a markdown link to the
   envelope's `reportLink` labelled "full report" for drill-down.
   Failures are listed first because they are release blockers.
2. **`## Warnings`** — every child whose envelope had
   `status: "warn"`, same shape as Failures (`keyFindings` as bullets,
   `reportLink` as the drill-down link). Sorted alphabetically by
   audit dimension to keep the diff stable across runs.
3. **`## Healthy`** — every child whose envelope had `status: "ok"`.
   For these, render a single-line "✅ <dimension> — no Critical/High
   findings" entry with a link to the envelope's `reportLink` for the
   reader who wants to verify. No `keyFindings` body needed; the green
   line is the summary.

Close the unified report with a one-line tally:
`"<F> failures · <W> warnings · <H> healthy · 12 total"`. Save the
unified report to `{{auditOutputDir}}/audit-fan-out-results.md`.

The aggregation step is what makes the fan-out worth the cost: every
child envelope is consumed exactly once by the aggregator, no audit
report is re-parsed, and the unified view fits in a single screenful
even when all 12 dimensions ran.

## Constraints

- **Never** dispatch the audits serially. The whole point of this
  workflow is the one-turn parallel shape; falling back to a serial
  chain defeats the dispatch-performance pass this skill was built for.
- **Never** exceed `concurrencyCap` in-flight `Agent` calls. Overflow
  must drain via `run_in_background` + `Monitor` per Step 2.
- **Always** pass `model: 'haiku'` on every `Agent` call, resolved from
  this workflow's `dispatchModel`. A per-call literal `model:` argument
  overrides it for that one call (see
  [`README.md`](../README.md#workflow-authoring) precedence rules) — use
  this escape hatch only when one audit genuinely needs different
  reasoning headroom than the rest.
- **Always** group the unified report by envelope `status` and surface
  `reportLink` for drill-down. Do not re-derive findings by re-reading
  the dimension reports; the envelope **is** the aggregation contract.
