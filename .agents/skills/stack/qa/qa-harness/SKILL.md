---
name: qa-harness
description:
  Conventions for agent-driven QA driving — the one driving-conventions
  reference behind both `/qa-run` (the known-scenario sweep through a real
  browser) and `/qa-explore` (agent-led exploratory driving). Use when
  instrumenting a live surface — covers navigation-first execution,
  per-surface console and network capture, design-token visual checks, the
  `F#` finding shape, per-environment resolution, and static driving as the
  documented interim. The run procedures live in `.agents/workflows/qa-run.md`
  and `.agents/workflows/qa-explore.md`; this skill is the conventions
  reference they lean on.
---

# Skill: qa-harness

## Policy Capsule

- Driving rules (navigation-first, semantic `Then`, mandatory redaction, sequential-only) live in one prose home — [`qa-run-scenario.md`](../../../../workflows/helpers/qa-run-scenario.md); apply them, do not restate them.
- Resolve the `qa` contract first and fail loudly when it is absent or malformed; there is no auto-detection fallback and no headless degrade.
- Resolve the target **environment** before driving (via `resolveQaEnvironment`); each environment keys its own `baseUrl`, `signInSeam`, and `allowWrites`, and its name is recorded on the ledger.
- Sign in only through the resolved `signInSeam` (`kind: 'url'` dev impersonation or `kind: 'skill'` with a stored `credentialRef`). **Never** type real credentials inline and never fabricate a session.
- Hold the read-only capture invariant absolutely: no source edits, no product mutations — the only write is appending to the `temp/qa/<sessionId>` ledger.
- Scrub captured console, network, and headers of tokens, session cookies, and PII before any finding reaches disk or GitHub; findings are posted to GitHub at approval time.
- Capture console and network per surface; turn each non-allowlisted console error and each failed/error-status request into one structured `F#` finding.
- Filter console through `qa.consoleAllowlist` via `filterConsoleMessages`; treat the allowlist as a benign-noise filter, never as a security control to silence genuine errors.
- Spot-check surfaces against `qa.designTokens` when set; flag gross token violations (off-palette colors, off-scale spacing/typography) as findings.
- Choose **static driving** only at Plan time and only where no seam resolves — the documented interim, never a silent fallback — and record the partial coverage.
- Record findings as `QaLedgerItem`s and route them through the shared classify/route/promote core ([`qa-core.md`](../../../../workflows/helpers/qa-core.md)); the harness never files tickets autonomously, and every phase transition is HITL-gated.

Guidance for driving a live surface through a real browser (the chrome-devtools
MCP surface). Two workflows lean on this one skill: the **known-scenario
sweep** ([`qa-run.md`](../../../../workflows/qa-run.md)) walks a resolved
Gherkin scenario set, and **exploratory driving**
([`qa-explore.md`](../../../../workflows/qa-explore.md)) walks a named surface
the agent has no script for. Each **procedure** — argument parsing, phase
gates, contract resolution sequence — is the SSOT in its own workflow; this
skill shows **how** to apply the driving and instrumentation conventions both
depend on. Assertion-tier rules live in
[`testing-standards.md`](../../../../rules/testing-standards.md)
(§ Assertion Placement); scenario prose conventions live in
[`gherkin-authoring`](../gherkin-authoring/SKILL.md); browser-locator
discipline is shared with [`playwright`](../playwright/SKILL.md); browser
instrumentation lives in
[`browser-testing-with-devtools`](../../../core/browser-testing-with-devtools/SKILL.md).
Read this skill before instrumenting a live surface; read the workflow for the
run order.

## 1. Driving Rules Live in One Prose Home

The driving rules both modes depend on — **navigation-first / never
URL-jump**, **semantic `Then`** assertion against the accessibility snapshot,
the Gherkin → browser-action mapping, the per-`When` write guard, mandatory
evidence redaction, and the **sequential-only** browser rule — are stated once
in [`qa-run-scenario.md`](../../../../workflows/helpers/qa-run-scenario.md).
Apply them from there; this skill does not restate them. In short: reach every
surface the way a real user would (start at a root, click affordances, never
deep-link a starting state), assert semantically (roles, accessible names,
visible text — never DOM/CSS/XPath selectors, HTTP status, response bodies, or
DB rows), and treat broken navigation — a missing affordance, a nav 404, a
guard redirect loop — as a **finding, not a workaround**. Assertion-tier rules
are in
[`testing-standards.md` § Assertion Placement](../../../../rules/testing-standards.md#assertion-placement).

## 2. The Read-Only Capture Invariant

Capture is **strictly read-only** in both modes. This invariant is inviolable
per [`security-baseline.md`](../../../../rules/security-baseline.md) — it is
not a soft preference.

- **No source edits.** The agent does not modify application code, config, or
  tests while driving. Driving observes; it never repairs.
- **No product mutations.** No creating, updating, or deleting product data, no
  destructive form submissions, no irreversible actions "to see what happens".
  When a surface's only path forward is a mutating action, record the boundary
  as the finding and stop — do not cross it.
- **The only write is the ledger.** The single permitted side effect is
  appending finding lines under `temp/qa/<sessionId>`.
- **Scrub before persisting.** Strip tokens, session cookies, `Authorization`
  headers, and PII from captured console and network evidence via the shared
  redaction path **before** any finding reaches disk or GitHub. Captured
  evidence is untrusted until scrubbed.
- **HITL gates every write outward.** Phase transitions and GitHub writes
  (ticket creation, promotion) happen only behind an operator confirmation
  gate; the agent never files or promotes findings autonomously.

## 3. Contract, Environment & Sign-In

- **Resolve the `qa` contract first.** Before any browser work, resolve the
  contract via `resolveQaContract(config)`. When the block is absent,
  malformed, or missing a required field, the resolver **throws** — relay its
  verbatim message and STOP. There is no auto-detection fallback.
- **Resolve the environment.** `resolveQaEnvironment` keys each deployment
  target to `{ name, baseUrl, signInSeam, allowWrites }`. Where the operator's
  input does not pin an unambiguous target and the contract declares more than
  one environment, prompt (or accept `defaultEnvironment`) — never silently
  pick one. Record the resolved name on the ledger.
- **Sign in through the seam, never inline.** The two seam kinds:
  - **`kind: 'url'` (dev impersonation).** Substitute the persona **name** into
    the seam's URL template and navigate there. The persona name is the sole
    input; no per-persona auth material is read.
  - **`kind: 'skill'` (procedural / credential).** Invoke the named consumer
    sign-in skill, which reads a per-persona **`credentialRef`** — an indirect
    handle to a stored credential, never an inline secret. Read that skill's
    `SKILL.md` and follow it.

  The agent MUST NOT type real usernames, passwords, or tokens, and MUST NOT
  fabricate or forge a session. This is a hard security boundary, not a
  convenience to work around. Confirm authenticated state with a
  `take_snapshot` before driving.
- **No headless fallback.** The chrome-devtools MCP surface is a host-provided
  runtime dependency. If it is unavailable, report a clear error and stop.

## 4. Mode — Known-Scenario Sweep (`/qa-run`)

The sweep drives a resolved scenario set and instruments each surface the
moment it lands on it, before moving on. Capture is **per surface** so evidence
is attributable to a concrete user-reachable state. Record each scenario's
result (pass / fail / blocked), the surface it ended on, and a one-line symptom
for any failure.

### 4.1 Console

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

### 4.2 Network

Capture with `list_network_requests` on the surface. Failed requests and
error-status responses (4xx / 5xx) become findings alongside the
console-derived set, sharing the same `F#` numbering across the surface.

### 4.3 Design-token visual check

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

### 4.4 The `F#` finding shape

Every captured problem is normalized into the structured `F#` shape so the
sweep can record it onto the shared ledger (each `F#` finding becomes one
`QaLedgerItem` — see [`qa-core.md`](../../../../workflows/helpers/qa-core.md))
and the schema validates:

```jsonc
{
  "id": "F1",                       // 1-based, assigned per surface across console+network
  "classification": "console-error", // console-error | network-error | visual-token | ...
  "surface": "/invoices",           // the user-reachable surface, not a deep link
  "symptom": "...",                 // one-line user-visible / captured symptom
  "likelyRootCause": null,          // null unless the cause is evidenced, not guessed
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
- **Blocker vs. follow-up.** A finding is a **blocker** when it breaks the
  scenario's user-visible outcome or exposes an authorization gap. Everything
  else — noise that does not break the journey, cosmetic token drift — is a
  **follow-up**.
- **Symptom over diagnosis.** When unsure of the root cause, record the precise
  symptom and leave `likelyRootCause: null`. A wrong guess is worse than an
  honest "unknown" the operator can triage.
- **Record once, let dedup collapse.** When the same error fires on many
  surfaces, record it once rather than filing N copies; the shared
  classify/route/dedup core collapses duplicates at triage against the
  fingerprint footer.

## 5. Mode — Exploratory Driving (`/qa-explore`)

Exploratory driving walks a named surface with no scenario script, capturing
what it observes. It is the agent-led half of exploratory QA; its human-led
sibling is `/qa-assist` (the human drives, the agent scribes). Everything in
§§ 1–3 applies unchanged; the deltas are the method choice and the per-surface
boundary.

- **Pick the driving method explicitly at Plan time** — drive (default) vs.
  static — and record it in the ledger. Do not switch methods mid-surface
  without a new Plan note.
- **Drive is the default.** When the resolved environment carries a
  `signInSeam`, authenticated surfaces — including deployed hosts — are
  **driven** through that seam, not statically deferred.
- **Static driving is the documented interim**, chosen **only where no seam
  resolves** for the target environment. It walks the surface from source,
  route definitions, and rendered markup rather than a running browser:
  - **Never a silent fallback.** Static is a deliberate Plan-phase decision
    recorded with its reason ("environment: preview, method: static, reason: no
    seam resolves"), not something the agent slips into when the browser MCP
    hiccups.
  - **Interim, not equivalent.** Static driving cannot exercise real
    authorization, routing guards, or runtime console/network signal. Treat its
    coverage as partial and say so in the ledger; a static pass does not close
    the same coverage a driven pass would.
  - **Same read-only invariant** (§ 2) applies identically.
  - **Promote to driving when a seam lands.** Re-run the surface driven rather
    than leaving it permanently static.
- **A surface that could not be driven is itself a signal.** Where the
  environment resolves no seam, drive the unauthenticated surface or fall back
  to static and record the gap — never a silent skip.
- **Observe, do not fabricate.** Never script the runtime to manufacture an
  outcome the exploration is meant to discover.

## 6. Record onto the Ledger & Triage (Never File Autonomously)

Record each finding as a `QaLedgerItem` on the shared session ledger under
`temp/qa/`, then route the ledger through the shared classify → route →
disposition → promote core — both stated once in
[`qa-core.md`](../../../../workflows/helpers/qa-core.md). The harness **MUST
NOT** create tickets autonomously: findings are promoted through
`/mandrel-plan` only after the operator confirms each disposition at the HITL
write gate. That gate is the safety boundary against spurious filing.

## 7. Cross-References

- Sweep procedure (SSOT): [`qa-run.md`](../../../../workflows/qa-run.md).
- Exploration procedure (SSOT): [`qa-explore.md`](../../../../workflows/qa-explore.md).
- Driving rules (one prose home): [`qa-run-scenario.md`](../../../../workflows/helpers/qa-run-scenario.md).
- Shared QA core (contract/session/redaction/ledger/triage/HITL): [`qa-core.md`](../../../../workflows/helpers/qa-core.md).
- Console filter module: [`console-allowlist.js`](../../../../scripts/lib/qa/console-allowlist.js).
- Assertion-tier rules: [`testing-standards.md`](../../../../rules/testing-standards.md).
- Scenario prose: [`gherkin-authoring`](../gherkin-authoring/SKILL.md).
- Browser-locator discipline: [`playwright`](../playwright/SKILL.md).
- Browser instrumentation: [`browser-testing-with-devtools`](../../../core/browser-testing-with-devtools/SKILL.md).
- Evidence scrubbing / read-only boundary: [`security-baseline.md`](../../../../rules/security-baseline.md).
