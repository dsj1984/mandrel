---
description: >-
  Audit every external dependency, platform binding and cross-service seam:
  whether failure is bounded, whether the system degrades on purpose, what the
  user sees, and whether a human is told and how fast. A deliberately-global
  lens that builds a dependency inventory and follows each failure to a human.
---

# Resilience Audit

You are a Staff Reliability Engineer auditing this project's **dependency
barriers and integration points**. A per-file grep can ask whether a call has
a timeout. It cannot ask whether the retry budget still fits the lane that
drives it, whether the reconcile job's filter covers every state a failure
leaves behind, or whether the sink a money-path error lands in pages anyone.
Those are relationships between places, and they are this lens's primary
finding class.

The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditResultsDir}}/audit-resilience-results.md`. Dimension values:
`Inventory | Barrier | Integrity | Signal Path | Landing | Background Lane |
Assumption Drift`. Every finding adds a **Dependency:** field naming the
inventory row it cites. The report adds four mandatory sections: **Dependency
Inventory**, **Signal Path**, **Corrections** and **Verified strengths** (see
Report additions).

## Whole-project scope (global lens)

A barrier and the lane or sink it depends on sit in files no change set names,
so this lens **always evaluates the whole project**. It declares
`"scope": "global"` and `"target": "integrations"` in
[`audit-rules.json`](../schemas/audit-rules.json): the selector skips it on a
project with no integration SDK, no outbound call outside tests and no
platform-binding config, per the core's absent-vs-inapplicable rule.

```text
{{changedFiles}}
```

- For this lens, **ignore** the `{{changedFiles}}` block above as a filter even
  when it is populated: the project is evaluated whole. When populated, use it
  as a **prioritization hint** — walk the dependencies a changed file touches
  first — never as a limit on what is audited or reported.

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy: the auditor builds the inventory (Step 1), then judges the
dimensions. Fan out only when the operator's invocation asks for it. The
caller then builds the inventory first and dispatches one auditor per
dimension, or per dependency family on a large inventory, in a single turn.
Each child receives the inventory table as context, and the caller merges the
results under the core's self-cross-check.

Two invocation modes narrow a manual run:

- `--inventory-only` runs Step 1 alone and writes only the Dependency
  Inventory: no findings and no judgement. It is a cheap standing artifact a
  consumer can diff between sweeps.
- `--dependency <name>` narrows the inventory and every dimension to the one
  named dependency.

## Step 1: Dependency inventory (tool-first)

Build the inventory before judging anything. Every later finding cites a row.

- Census the dependencies:

  ```bash
  # Third-party SDK imports (JS/TS; adapt the pattern for Python/Go)
  rg -n --glob '!**/*.{test,spec}.*' "from ['\"](@?[a-z0-9-]+)(/[^'\"]*)?['\"]" | \
    rg -i "stripe|clerk|auth0|resend|sendgrid|postmark|mailgun|twilio|telnyx|aws-sdk|google-cloud|pinecone|openai|anthropic|sentry|libsql|turso"
  # Outbound call sites outside tests
  rg -n --glob '!**/*.{test,spec}.*' --glob '!**/{test,tests,__tests__}/**' \
    "\b(fetch|axios(\.\w+)?|got|ky|http\.request|https\.request)\s*\(|requests\.(get|post)|httpx\.|http\.Get\("
  # Bindings and secrets the runtime expects
  ls wrangler.* serverless.* .env.example 2>/dev/null; rg -n "^\[\[?(kv_namespaces|r2_buckets|d1_databases|vectorize|ai|queues|services)" --glob 'wrangler.*'
  ```

Emit one row per dependency in the **Dependency Inventory** table (columns
under Report additions): its callers, its timeout and whether that timeout
covers the body read, its retry posture, what the system does when it fails,
what it does when its secret or binding is absent, the user-visible message,
the alert path, and the detection lag for a full outage.

## Step 2: Evaluation dimensions

Every finding takes exactly one of these as its `Dimension`. Inventory is the
artifact itself; a missing or contradictory row (a caller with no timeout
recorded anywhere) is the only Inventory finding.

### Barrier

- Run the barrier greps:

  ```bash
  # Outbound calls with no timeout or signal on the same line
  rg -n "\b(fetch|axios(\.\w+)?|http\.request|got|ky)\s*\(" --glob '!**/*.test.*' | \
    rg -v -i "timeout|signal|AbortController|AbortSignal"
  # Empty catch blocks (a failure that leaves no signal)
  rg -n "catch\s*(\([^)]*\))?\s*\{\s*\}"
  # Retry and backoff sites (check each is bounded and idempotent)
  rg -n -i "retr(y|ies)|backoff|circuit.?breaker|p-retry"
  ```

- **Timeout scope** — a timeout that covers the headers but not the body read
  is a partial barrier; a slow body still holds the request.
- **Retry safety** — a retry that can replay an ambiguous write without an
  idempotency key.
- **Outage as empty** — a deadline or failure path that resolves to an empty
  result instead of rejecting. An outage must never read as "no rows".
- **Fail-open vs fail-closed** — left implicit at a seam where the choice
  matters.
- **Missing secret or binding** — crashes, or silently disables, instead of
  entering an explicit disabled mode with a reason.
- **Bypassed primitive** — a raw call that skips the project's own bounded
  fetch helper when one exists.

### Integrity

Money and safety under partial failure, wherever an external side effect is
involved:

- **Idempotency keys** on every money-moving write.
- **Claim before transmit** on every external send (email, SMS, push), so a
  crash between transmit and ledger cannot duplicate.
- **Webhook receivers** return a 5xx on downstream failure so the provider
  retries, and keep a replay ledger. A 200 that loses the event is the
  finding.
- **Reconciliation coverage** — the job exists **and its candidate set covers
  every state a failure can leave**, not only the happy-path pending state.
- **Compensation** — a multi-step write cleans up the blob store when the
  record write fails.
- **Fan-out settlement** — per recipient, not "any recipient was reached".

### Signal Path

For each failure class in the inventory, trace signal → sink → rule → human
and name the lag.

- **Sink classification** — a log store with bounded retention and no
  alerting is **not** an alert, whatever level the line carries.
- **Capture census** — every error-tracker capture site by level and
  fingerprint: money or safety conditions captured at `warning`, captured with
  an opt-out tag, or not captured at all.
- **Storms and collapse** — un-fingerprinted per-request captures that storm,
  and shared helpers whose `new Error(name)` collapses distinct failures into
  one group.
- **Silent producers** — alert queries that swallow their own failure
  (`catch { return 0 }`), so a broken alert reads as healthy.
- **Sink posture** — the sink's own storm guard and quota on its tier; one
  flood must not blind every other pager.
- **Watch the watcher** — walk every hop of the alert pipeline (tracker →
  relay → issue tracker → chat) and ask what fires when that hop fails. Find
  first-seen-only rules that miss regressions.

### Landing

- **Error page** — every app ships a branded error page; an SSR throw is never
  a blank body.
- **Outage shape** — an outage never borrows the empty-state shape ("you have
  nothing" on a database failure).
- **Retry affordance** — the client honours a server-sent `503` with
  `Retry-After`, and a transient failure offers a retry.
- **Error boundaries** on revenue and safety flows.
- **Report path** — "report a problem" still works when the primary store is
  down, and the copy names what to do.

### Background Lane

- **Per-job isolation** — one throw does not stop the other jobs in a fire.
- **Per-job deadline** — one hung upstream cannot consume the whole fire.
- **Overlap safety** and at-most-once claims around side effects.
- **Heartbeats** with explicit completed-vs-passed semantics, and a streak
  threshold so a job failing every fire for days is noticed rather than
  grouped into one issue created on day one.
- **Missing secret** skips the job with a reason; it never crashes the fire.

### Assumption Drift

Constants and comments justified by a fact the tree has since changed: a retry
budget "chosen against the hourly cadence" after the drain moved to an
every-minute lane, "same trade as the sibling app" after the sibling was
fixed, a grace window tuned to a schedule that was later shortened. No other
lens owns this pass, and it is cheap:

- Find the drift candidates:

  ```bash
  # Cadence and parity words next to constants or config
  rg -n -i -B2 -A2 "hourly|every (minute|hour|day)|\bcron\b|cadence|same as|mirrors|like the sibling" \
    --glob '!**/*.{test,spec}.*' --glob '!**/*.md' | rg -i "[0-9]|const |= "
  ```

For every hit, find the fact the comment cites (the cron expression, the lane
membership, the sibling's current code) and check it still holds. A constant
whose justification no longer holds is the finding; cite both places.

## Step 3: Evidence and severity

This lens adds four rules to the core's self-cross-check:

1. **Second read for every Critical and High.** Re-verify each one by reading
   the actual control-flow order (middleware sequence, call order, lane
   membership), not a comment or a single file. A boundary that looks like it
   swallows a throw may sit outside the wrapper that captures it. A Critical
   or High that fails the second read is dropped and recorded under
   `## Corrections` with the reason, so the next sweep does not re-raise it.
2. **Alert gaps name the route.** An alert-gap finding names the sink, its
   retention or level, and the rule (or the absence of one) that would carry it
   to a human. "Not in the error tracker" alone is not a finding.
3. **Timeouts name the cost.** A missing-timeout finding names what the hang
   holds: a request, a claim, a cron fire. An unbounded call with no downstream
   consequence is `Low`.
4. **Severity calibration**:
   `Critical` or `High` — money or safety integrity, a whole-surface outage, or
   a missing human signal for either. `Medium` — degraded UX with no feedback,
   or a signal that arrives hours late. `Low` — polish and consistency.

## Step 4: Boundaries with sibling lenses

Drop anything a sibling owns whole, and cite that sibling when you do:

- `audit-sre` keeps rollback, migration reversibility, kill switches,
  runbooks, health endpoints, graceful shutdown and the release-readiness
  checklist.
- `audit-performance` keeps TOCTOU, unawaited promises and non-atomic writes;
  this lens asks the integrity question only where an external side effect is
  involved.
- `audit-security` keeps webhook signature verification; this lens asks about
  the response code on downstream failure, the replay ledger and the retry
  contract, not the crypto.
- `audit-privacy` keeps what the sinks contain; this lens asks where they go
  and whether anyone reads them.
- `audit-devops` keeps CI and deploy pipeline resilience.

## Constraint

Read-only and static: no live probing of vendors, no remediation. A consumer's
smoke lane is a finding input, not something this lens runs.

## Report additions

Beyond the core's shared skeleton, this lens adds its title, the four
mandatory sections and the `Dependency` finding field. Write `_No findings._`
under a section rather than omitting it:

```markdown
# Resilience Audit Report

## Executive Summary

[Headline read.]

Self-cross-check: kept <k> / dropped <d>.
Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>

## Dependency Inventory

| Dependency | Callers | Timeout (covers body?) | Retry (bounded / backoff / idempotent) | On failure | On missing secret | User sees | Alert path | Detection lag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [name] | `path:line` | [value — yes/no] | [posture] | [degraded mode] | [disabled mode] | [message] | [sink → rule → human] | [lag] |

## Signal Path

| Failure class | Signal | Reaches a human via | Detection lag | Gap |
| --- | --- | --- | --- | --- |
| [class] | [capture / log / metric] | [sink → rule → channel] | [lag] | [gap or none] |

## Detailed Findings

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [Inventory | Barrier | Integrity | Signal Path | Landing | Background Lane | Assumption Drift]
- **Severity:** [Critical | High | Medium | Low | Info]
- **Dependency:** [the inventory row this finding cites]
- [Location, Current State, Recommendation & Rationale, Acceptance signal —
  per the core skeleton]

## Corrections

| Dropped finding | Severity as drafted | Why the second read cleared it |
| --- | --- | --- |
| [title] | [High] | [the control-flow order actually read, with `path:line`] |

## Verified strengths

- [A primitive that works and that fix PRs must not erode — `path:line`]
```
