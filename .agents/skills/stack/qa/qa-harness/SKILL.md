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

- Driving rules (navigation-first, semantic `Then`, mandatory redaction, sequential-only) live in one prose home — [`qa-run-scenario.md`](../../../../workflows/helpers/qa-run-scenario.md); apply them, do not restate them.
- Capture console and network per surface; turn each non-allowlisted console error and each failed/error-status request into one structured `F#` finding.
- Filter console through `qa.consoleAllowlist` via `filterConsoleMessages`; treat the allowlist as a benign-noise filter, never as a security control to silence genuine errors.
- Spot-check surfaces against `qa.designTokens` when set; flag gross token violations (off-palette colors, off-scale spacing/typography) as findings.
- Scrub captured console and network of tokens, session cookies, and PII before rendering any finding — findings are posted to GitHub at approval time.
- Record findings as `QaLedgerItem`s and route them through the shared classify/route/promote core ([`qa-core.md`](../../../../workflows/helpers/qa-core.md)); the harness never files tickets autonomously.
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

## 1. Driving Rules Live in One Prose Home

The driving rules the harness depends on — **navigation-first / never URL-jump**,
**semantic `Then` assertion** against the accessibility snapshot, the Gherkin →
browser-action mapping, the per-`When` write guard, mandatory evidence
redaction, and the **sequential-only** browser rule — are stated once in
[`qa-run-scenario.md`](../../../../workflows/helpers/qa-run-scenario.md), the
single-scenario driver `/qa-run` delegates to. Apply them from there; this skill
does not restate them. In short: reach every surface the way a real user would
(start at a root, click affordances, never deep-link a `Given`), assert `Then`
semantically (roles, accessible names, visible text — never DOM/CSS/XPath
selectors, HTTP status, response bodies, or DB rows), and record each scenario's
result (pass / fail / blocked), the surface it ended on, and a one-line symptom
for any failure. Assertion-tier rules are in
[`testing-standards.md` § Assertion Placement](../../../../rules/testing-standards.md#assertion-placement).

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
the sweep can record it onto the shared ledger (each `F#` finding becomes one
`QaLedgerItem` — see [`qa-core.md`](../../../../workflows/helpers/qa-core.md))
and the schema validates:

```jsonc
{
  "id": "F1",                       // 1-based, assigned per surface across console+network
  "classification": "console-error", // console-error | network-error | visual-token | ...
  "surface": "/invoices",           // the user-reachable surface, not a deep link
  "symptom": "...",                 // one-line user-visible / captured symptom
  "likelyRootCause": null,          // heuristic card output (§4); null until enriched
  "disposition": "follow-up",       // blocker | follow-up
  "acceptance": null,               // AC this folds into, when known
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
| Repeated identical console error across many surfaces | A shared component or global bootstrap fault | record once; the shared route/dedup core collapses duplicates at triage |

Heuristics for working the cards:

- **Record once, let dedup collapse.** When the same error fires on many
  surfaces, record it once rather than filing N copies; the shared
  classify/route/dedup core ([`qa-core.md`](../../../../workflows/helpers/qa-core.md))
  collapses duplicates at triage against the fingerprint footer.
- **Blocker vs. follow-up.** A finding is a **blocker** when it breaks the
  scenario's user-visible outcome or exposes an authorization gap. Everything
  else (noise that does not break the journey, cosmetic token drift) is a
  **follow-up**.
- **Symptom over diagnosis.** When unsure of the root cause, record the precise
  symptom and leave `likelyRootCause: null`. A wrong guess is worse than an
  honest "unknown" the operator can triage.

## 5. Record onto the Ledger & Triage (Never File Autonomously)

Record each `F#` finding as a `QaLedgerItem` on the shared session ledger under
`temp/qa/`, then route the ledger through the shared classify → route →
disposition → promote core — both stated once in
[`qa-core.md`](../../../../workflows/helpers/qa-core.md). The harness **MUST
NOT** create tickets autonomously: findings are promoted through `/plan` only
after the operator confirms each disposition at the HITL write gate. That gate
is the safety boundary against spurious filing.

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
- Driving rules (one prose home): [`qa-run-scenario.md`](../../../../workflows/helpers/qa-run-scenario.md).
- Shared QA core (contract/session/redaction/ledger/triage/HITL): [`qa-core.md`](../../../../workflows/helpers/qa-core.md).
- Console filter module: [`console-allowlist.js`](../../../../scripts/lib/qa/console-allowlist.js).
- Assertion-tier rules: [`testing-standards.md`](../../../../rules/testing-standards.md).
- Scenario prose: [`gherkin-authoring`](../gherkin-authoring/SKILL.md).
- Browser-locator discipline: [`playwright`](../playwright/SKILL.md).
- Evidence scrubbing: [`security-baseline.md`](../../../../rules/security-baseline.md).
