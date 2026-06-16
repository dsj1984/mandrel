---
name: qa-harness
description:
  Conventions for the agent-driven QA harness that drives Gherkin scenarios
  through a real browser. Use when executing `/qa-run` or instrumenting
  a live surface — covers navigation-first execution, per-surface console and
  network capture, design-token visual checks, and the framework-generic
  heuristic cards for turning signal into findings. The harness procedure lives
  in `.agents/workflows/qa-run.md`; this skill is the conventions
  reference it leans on.
---

# Skill: qa-harness

## Policy Capsule

- Drive every scenario navigation-first: start at a root and reach the surface under test only via UI affordances — never URL-jump to a deep link to set up a `Given`.
- Assert `Then` outcomes semantically against the accessibility snapshot (roles, accessible names, visible text); never via DOM/CSS/XPath selectors, HTTP status codes, response bodies, or DB rows.
- Capture console and network per surface; turn each non-allowlisted console error and each failed/error-status request into one structured `F#` finding.
- Filter console through `qa.consoleAllowlist` via `filterConsoleMessages`; treat the allowlist as a benign-noise filter, never as a security control to silence genuine errors.
- Spot-check surfaces against `qa.designTokens` when set; flag gross token violations (off-palette colors, off-scale spacing/typography) as findings.
- Scrub captured console and network of tokens, session cookies, and PII before rendering any finding — findings are posted to GitHub at approval time.
- Bundle findings by likely root cause into a draft for operator sign-off; the harness never files tickets autonomously.
- Resolve the `qa` contract first and fail loudly when it is absent or malformed; there is no auto-detection fallback and no headless degrade.

Guidance for executing the agent-driven QA harness through a real browser (the
chrome-devtools MCP surface). The harness **procedure** — argument parsing,
step ordering, contract resolution sequence — is the SSOT in
[`.agents/workflows/qa-run.md`](../../../../workflows/qa-run.md);
this skill shows **how** to apply the instrumentation and inspection
conventions that procedure depends on. The assertion-tier rules it enforces
live in [`testing-standards.md`](../../../../rules/testing-standards.md)
(§ Assertion Placement); scenario prose conventions live in
[`gherkin-authoring`](../gherkin-authoring/SKILL.md); browser-locator
discipline is shared with [`playwright`](../playwright/SKILL.md). Read this
skill before instrumenting a live surface; read the workflow for the run order.

## 1. Navigation-First Execution

The harness reaches every surface the way a real user would. This is the
load-bearing convention — it is what makes findings reflect a user-reachable
state rather than an artifact of a deep link.

- **Start at a root.** After sign-in, begin each scenario at the app's home or
  dashboard. Reach the surface under test by clicking nav links, menu items,
  and buttons — the same affordances a user has.
- **Never URL-jump.** Do not `navigate_page` directly to a deep link to
  establish a `Given`. URL-jumping bypasses the app's real authorization and
  routing flows, which both masks access-control gaps and produces findings
  that no user could actually trigger.
- **Broken navigation is a finding, not a workaround.** When an affordance is
  missing, a nav link 404s, or a guard redirect loops, that is the finding.
  Do not route around it with a direct URL — record it and move on.
- **Map Gherkin to browser actions.** `Given` establishes state by navigating
  from the root (sign in as the persona, walk to the starting surface, seed via
  UI where the manifest does not pre-seed). `When` performs the single user
  action (`click`, `fill_form`, then `wait_for` the transition). Use
  `evaluate_script` only for app-provided hooks — never to fabricate the
  outcome a `Then` is meant to observe.

### Semantic `Then` assertion

Assert every `Then` against the accessibility snapshot from `take_snapshot`,
matching on **roles, accessible names, labels, and visible text** that express
the user-visible outcome — "a banner with text _Invoice sent_ is visible", "a
row for _ACME Corp_ appears in the invoices table".

- **Never** assert against brittle DOM/CSS/XPath selectors.
- **Never** assert on HTTP status codes, response bodies, or DB rows inside a
  scenario — those are contract-tier concerns (see
  [`testing-standards.md` § Assertion Placement](../../../../rules/testing-standards.md#assertion-placement)).
- A `Then` that can only be expressed as a wire-shape or DB check is a signal
  the scenario is **mis-tiered**, not a license to break the semantic rule.

Record each scenario's result (pass / fail / blocked), the surface it ended on,
and a one-line user-visible symptom for any failure.

## 2. Per-Surface Console & Network Capture

Instrument each surface the moment you land on it, before moving on. Capture is
**per surface** so evidence is attributable to a concrete user-reachable state.

### 2.1 Console

1. Capture with `list_console_messages` on the current surface.
2. Filter through the contract's `consoleAllowlist` using
   [`filterConsoleMessages`](../../../../scripts/lib/qa/console-allowlist.js).
   The filter is the pure decision layer: it escalates only messages at level
   `error` / `severe`, suppresses any message matched by an allowlist
   substring pattern, and returns one structured finding per surviving error in
   capture order (`F1`, `F2`, …).
3. Each surviving console error becomes one `F#` finding. Non-error levels
   (`log`, `info`, `debug`, `warning`) are never escalated.

The allowlist is a **benign-noise filter, not a security control.** It exists
to suppress known, expected, harmless console chatter (a third-party widget's
deprecation notice, a dev-only HMR log). Never expand it to silence a genuine
error signal — if a real error is noisy, fix the error, do not allowlist it.
Allowlist matching is case-sensitive substring matching, so patterns stay
readable in `.agentrc.json` without regex escaping; a blank pattern is ignored
rather than matching everything.

### 2.2 Network

Capture with `list_network_requests` on the surface. Failed requests and
error-status responses (4xx / 5xx) become findings alongside the
console-derived set, sharing the same `F#` numbering across the surface.

### 2.3 Design-token visual check

When the contract's `designTokens` pointer is set (it defaults to `null`),
spot-check the rendered surface against the token source. Flag **gross** token
violations as findings — the goal is catching drift, not pixel-perfect audits:

- **Color** — text or controls rendered in an off-palette color where a token
  color is expected (a hard-coded `#3366ff` where the primary token is the
  contract).
- **Spacing** — padding/margins that visibly break the spacing scale (a
  one-off `13px` gutter amid an 8px-based scale).
- **Typography** — font families, sizes, or weights outside the type scale.

A gross violation is one a designer would call a regression on sight; subtle
sub-pixel differences are not harness findings. When `designTokens` is `null`,
skip this check entirely — do not invent a token source.

## 3. Findings — the `F#` Shape

Every captured problem is normalized into the structured `F#` finding shape so
the draft bundle stays diffable and the schema validates:

```jsonc
{
  "id": "F1",                       // 1-based, assigned per surface across console+network
  "classification": "console-error", // console-error | network-error | visual-token | ...
  "surface": "/invoices",           // the user-reachable surface, not a deep link
  "symptom": "...",                 // one-line user-visible / captured symptom
  "likelyRootCause": null,          // heuristic card output (§4); null until enriched
  "disposition": "follow-up",       // blocker | follow-up
  "acceptance": null,               // AC this folds into, when known
  "foldsInto": "F2",                // optional: another finding this is a duplicate facet of
  "evidence": {
    "console": [{ "level": "error", "text": "..." }],
    "network": []
  }
}
```

- **Determinism is load-bearing.** Re-running the same selector over the same
  captured console with the same allowlist yields the same findings in the same
  order. Do not reorder or renumber findings between sweeps.
- **Scrub before rendering.** Before any finding's `evidence` is rendered or
  drafted, strip tokens, session cookies, Authorization headers, and PII from
  the captured console and network per
  [`security-baseline.md`](../../../../rules/security-baseline.md). Findings are
  posted to GitHub at approval time — captured evidence is untrusted until
  scrubbed.

## 4. Framework-Generic Heuristic Cards

The harness ships **framework-generic** root-cause heuristics — they reason
about symptoms, not about any one frontend framework. Use a card to populate
`likelyRootCause` and to set `disposition`. The cards are guidance, not a
classifier: when a symptom matches none cleanly, leave `likelyRootCause: null`
and let the operator triage from the symptom.

| Symptom pattern | Likely root cause | Default disposition |
| --- | --- | --- |
| `404` / `Not Found` on a navigation or asset request | Dead route, broken link, or missing build artifact | follow-up (blocker if it breaks the scenario path) |
| `401` / `403` reaching a surface the persona should see | Missing or over-tight authorization check; guard misconfig | blocker |
| `500` / `502` / `503` on a user action | Server-side fault behind the action | blocker |
| Uncaught `TypeError` / `ReferenceError` in console | Null/undefined dereference or missing binding in client code | blocker when it breaks the surface, else follow-up |
| `Failed to fetch` / `NetworkError` / CORS-rejected request | Misconfigured CORS allowlist, wrong origin, or a downed dependency | follow-up |
| Hydration / mismatch warning escalated to error | Server/client render divergence | follow-up |
| Off-palette color, off-scale spacing/typography | Design-token drift — hard-coded value bypassing the token | follow-up |
| Repeated identical console error across many surfaces | A shared component or global bootstrap fault | fold the duplicates into one finding via `foldsInto` |

Heuristics for working the cards:

- **Fold duplicates.** When the same error fires on many surfaces, emit one
  finding and point the rest at it with `foldsInto` rather than filing N copies.
- **Blocker vs. follow-up.** A finding is a **blocker** when it breaks the
  scenario's user-visible outcome or exposes an authorization gap. Everything
  else (noise that does not break the journey, cosmetic token drift) is a
  **follow-up**.
- **Symptom over diagnosis.** When unsure of the root cause, record the precise
  symptom and leave `likelyRootCause: null`. A wrong guess is worse than an
  honest "unknown" the operator can triage.

## 5. Draft & Sign-Off (Never File Autonomously)

Bundle findings **by likely root cause** into proposed follow-up tickets with
`Depends-on` / `Blocks` relationships, then present the draft for operator
approval. The harness **MUST NOT** create tickets autonomously — it stops at a
draft. The operator-approval gate is the safety boundary against spurious
filing. When the run was triggered from an Epic-testing context, hand the
**approved** findings to the Epic-testing helper for attachment to the Epic's
QA evidence ticket.

## 6. Sign-In & Contract Discipline

- **Resolve the `qa` contract first.** Before any browser work, resolve the
  contract via `resolveQaContract(config)`. When the block is absent,
  malformed, or missing a required field, the resolver **throws** — relay its
  verbatim message and STOP. There is no auto-detection fallback.
- **Dev seam only.** Sign in once per persona via the contract's `signInSeam`
  (`kind: 'url'` dev seam or `kind: 'skill'`). **Never** enter real
  credentials. Confirm authenticated state with a `take_snapshot` before
  driving any scenario.
- **No headless fallback.** The chrome-devtools MCP surface is a host-provided
  runtime dependency. If it is unavailable, degrade with a clear error and stop
  — never fall back to the retired headless BDD runner.

## 7. Cross-References

- Run procedure (SSOT): [`qa-run.md`](../../../../workflows/qa-run.md).
- Console filter module: [`console-allowlist.js`](../../../../scripts/lib/qa/console-allowlist.js).
- Assertion-tier rules: [`testing-standards.md`](../../../../rules/testing-standards.md).
- Scenario prose: [`gherkin-authoring`](../gherkin-authoring/SKILL.md).
- Browser-locator discipline: [`playwright`](../playwright/SKILL.md).
- Evidence scrubbing: [`security-baseline.md`](../../../../rules/security-baseline.md).
