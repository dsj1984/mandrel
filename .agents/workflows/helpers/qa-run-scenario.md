---
description: >-
  Helper — not a slash command. Drive one Gherkin scenario through a real
  browser (navigate, act, assert) under a defined input/output contract, and
  return a single structured per-scenario result. Invoked per scenario by the
  `/qa-run` sweep (Step 3); may also be dispatched in a deferred batched
  sub-agent mode (spec-only).
caller: qa-run.md
---

# helpers/qa-run-scenario — single-scenario driver

> **Not a slash command.** This file lives in `helpers/` and is not projected
> into the mandrel plugin command tree. It is invoked per scenario by the
> [`/qa-run`](../qa-run.md) sweep, which owns environment resolution, scope
> selection, sign-in, and the sweep-level report. This helper owns exactly one
> scenario: drive it, analyze it, and hand back one structured result.

## Overview

`qa-run-scenario` is the **single-scenario worker** for the QA sweep. The
orchestrator ([`/qa-run`](../qa-run.md)) resolves the environment and scope,
signs in each persona once, then calls this helper once per scenario in
selection order. The helper never resolves the contract, never signs in from
cold, and never files tickets — it receives an already-authenticated session
and a single scenario ref, drives it, and returns one per-scenario result the
orchestrator folds into its report.

Factoring the per-scenario procedure here keeps the driving rules
(navigation-first, semantic `Then`, mandatory evidence redaction) in **one
prose home** and lets the orchestrator stay focused on invocation ergonomics,
write-safety, and reporting.

## Input contract

The caller MUST pass a fully-resolved input envelope. The helper does not
re-resolve any of it:

| Field                   | Shape                                                                 | Use                                                                                          |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `environment`           | `{ name, baseUrl, allowWrites }`                                       | The resolved target (from `resolveQaEnvironment`). `baseUrl` is the navigation root; `allowWrites` gates any mutating `When` step. |
| `persona`               | persona name **plus** a confirmed authenticated-session precondition   | The caller MUST have signed this persona in and confirmed the authenticated state (Step 2 of the sweep) **before** calling the helper. This helper does not sign in from cold; it re-verifies the session on entry and drives as that persona. |
| `scenario`              | scenario ref — the `.feature` file path and `(file, line)` locator     | The single scenario to drive. Its `Given/When/Then` steps are the source of truth. |
| `consoleAllowlist`      | `string[]` benign-console patterns                                     | Passed to `filterConsoleMessages` when turning console output into findings.                 |
| `designTokens`          | pointer to the token/style source, or `null`                          | When set, spot-check the surface against the tokens; gross violations become findings.       |

**Authenticated-session precondition.** The `persona` input is not a request to
sign in — it is an assertion that the caller has already signed this persona in
and confirmed the authenticated state. On entry the helper re-verifies the
session with a `take_snapshot` (the user menu / persona badge is present)
before driving the scenario; if the session is not authenticated, the helper
returns a `blocked` result rather than attempting a cold sign-in.

## Output contract

The helper returns **one structured per-scenario result**:

```json
{
  "scenario": "<featureRoot-relative file path>:<line>",
  "intent": "<one plain-English line of business intent>",
  "verdict": "pass" | "fail" | "blocked",
  "surface": "<the surface the scenario ended on>",
  "findings": [ /* zero or more F# findings (the console/network-derived shape) */ ]
}
```

- **`intent`** — one plain-English line derived from the `Scenario:` name and
  its `Given/When/Then` (what the user is trying to do and the outcome that
  proves it). Stated for **every** scenario, pass or fail.
- **`verdict`** — `pass` when every `Then` asserted true; `fail` when a `Then`
  did not hold (record the user-visible symptom); `blocked` when the scenario
  could not be driven to a verdict (session not authenticated, a required
  affordance missing, a mutating step excluded by the write guard).
- **`surface`** — the surface the scenario ended on (for failure triage).
- **`findings`** — zero or more `F#` findings in the console/network-derived
  shape (`{ id, classification, surface, symptom, likelyRootCause, disposition,
  acceptance, evidence: { console[], network[] } }`, the subset
  [`console-allowlist.js`](../../scripts/lib/qa/console-allowlist.js) emits),
  with evidence already redacted (below). The caller (`/qa-run` Step 4) records
  each finding as a `QaLedgerItem` on the shared session ledger before routing
  it through the classify/route/dedup/promote core; this helper does not touch
  the ledger.

The caller aggregates these results into its sweep report (per-scenario
`intent + verdict` lines, totals, failure triage) and folds each scenario's
findings onto the shared ledger. The helper never files tickets and never
renders the sweep-level report.

## Driving rules (non-negotiable)

These are the load-bearing invariants of a real-browser QA sweep. They are
**not** relaxable per scenario.

### Navigation-first — never URL-jump

Start the scenario at a **root** (the app's home/dashboard after sign-in,
anchored on `environment.baseUrl`) and reach the surface under test **only by
navigating UI affordances** — click nav links, menu items, buttons, and follow
the same paths a real user would. **Never** `navigate_page` directly to a deep
link to set up a `Given`. URL-jumping bypasses the app's real authorization and
routing flows, which both masks access-control gaps and produces findings that
do not reflect a user-reachable state. Driving via affordances keeps the agent
inside the app's genuine flows and surfaces broken navigation, guard
redirects, and dead links as findings rather than hiding them.

Map the Gherkin steps to browser actions:

- **`Given`** — establish state by navigating from the root via affordances
  (navigate to the starting surface, seed via UI where the manifest does not
  pre-seed).
- **`When`** — perform the user action: `click`, `fill_form`,
  `evaluate_script` (only for app-provided hooks, never to fabricate the
  outcome), then `wait_for` the resulting transition. **Write guard:** when
  `environment.allowWrites` is `false`, a `When` step that mutates persisted
  state MUST NOT be executed — the orchestrator excludes mutating scenarios
  from the selection under a read-only environment, so a mutating scenario
  reaching this helper under `allowWrites: false` is returned `blocked`.
- **`Then`** — assert the outcome semantically (below).

### Semantic Then assertion against the accessibility snapshot

Assert every `Then` **semantically** against the accessibility snapshot from
`take_snapshot` — match on roles, accessible names, labels, and visible text
that express the user-visible outcome ("a banner with text _Invoice sent_ is
visible", "a row for _ACME Corp_ appears in the invoices table"). **Do not**
assert against brittle DOM/CSS/XPath selectors, and **do not** assert on HTTP
status codes, response bodies, or DB rows — those are contract-tier concerns
that belong in contract tests, not in a user-journey sweep (see
[`.agents/rules/testing-standards.md`](../../rules/testing-standards.md)
§ Assertion Placement). A `Then` that can only be expressed as a wire-shape or
DB check is a signal the scenario is mis-tiered, not a reason to break the
semantic rule.

Before driving the scenario, state its **business intent** in one plain-English
line (the `intent` output field). Keep it to one line sourced from the
`Scenario:` name and steps — the `.feature` file is the source of truth; do not
paraphrase every step or leak implementation detail.

### Mandatory evidence redaction

Per surface visited, capture console (`list_console_messages`, filtered through
`consoleAllowlist` via
[`filterConsoleMessages`](../../scripts/lib/qa/console-allowlist.js)) and
network (`list_network_requests`; failed / error-status requests become
findings). Before any captured console/network evidence leaves this helper in a
finding, it **MUST** pass
[`redact-evidence.js`](../../scripts/lib/qa/redact-evidence.js)
(`redactEvidence`) to scrub tokens, session cookies, and PII per
[`.agents/rules/security-baseline.md`](../../rules/security-baseline.md).
Redaction is not optional — findings are posted to GitHub at the orchestrator's
approval time, so unredacted secrets must never reach the `findings` output.

## Deferred: batched sub-agent dispatch mode (spec-only)

> **Not yet enabled.** This section specifies a future execution mode; the
> current `/qa-run` sweep calls this helper **inline**, one scenario at a time,
> in the orchestrator's own turn. The batched mode below is documented so the
> contract is stable when it is turned on — do not implement it as live
> behavior from this spec alone.

In the deferred mode, the orchestrator MAY dispatch scenarios to fresh-context
sub-agents to keep its own context window focused, under these hard rules:

- **Sequential, never parallel.** Sub-agents run **one at a time**, never
  concurrently. A live browser surface is a single shared resource; parallel
  drivers would race on navigation and cross-contaminate evidence.
- **One sub-agent per persona group.** Scenarios are grouped by persona and a
  single sub-agent drives all of one persona's scenarios, so the persona is
  signed in once per group rather than per scenario.
- **Re-verify auth on entry.** Each sub-agent MUST re-verify the
  authenticated-session precondition (a `take_snapshot` confirming the persona
  badge) when it starts, because it does not share the orchestrator's live
  session state.
- **Same input/output contract.** Each sub-agent consumes the input contract
  above and returns the per-scenario result shape above for every scenario it
  drove — the orchestrator aggregates identically whether the helper ran inline
  or via a batched sub-agent.

## Constraints

- **Always** re-verify the authenticated session on entry; never sign in from
  cold in this helper.
- **Always** navigate from the root via UI affordances. **Never** URL-jump to a
  deep link to set up a scenario.
- **Always** assert `Then` outcomes semantically against the accessibility
  snapshot. **Never** assert via DOM/CSS/XPath selectors, HTTP status codes,
  response bodies, or DB rows inside a scenario.
- **Always** run captured evidence through `redact-evidence.js` before it
  leaves the helper in a finding.
- **Never** execute a mutating `When` step under `environment.allowWrites:
  false` — return `blocked` instead.
- **Never** file tickets or render the sweep report — return one structured
  per-scenario result and let the orchestrator aggregate.
