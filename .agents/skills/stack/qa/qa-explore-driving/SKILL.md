---
name: qa-explore-driving
description:
  Conventions for agent-driven exploratory QA driving — how the agent itself
  drives a surface during `/qa-explore` (agent-led), as opposed to the
  human-led `/qa-assist`. Use when the agent explores a running app via the
  browser MCP (navigation-first, the default) — including authenticated
  deployed surfaces reached through the resolved environment's sign-in seam —
  or walks a static surface (the documented interim where no seam resolves),
  under a strictly read-only capture invariant. The exploration procedure lives in
  `.agents/workflows/qa-explore.md`; this skill is the driving-conventions
  reference it leans on.
---

# Skill: qa-explore-driving

## Policy Capsule

- Drive the running app **by default** through the browser MCP, navigation-first: start at a root and reach each surface only via UI affordances — never URL-jump to a deep link.
- Resolve the target **environment** at Plan time (via `resolveQaEnvironment`) and record its name in the ledger; each environment keys its own `baseUrl`, `signInSeam`, and `allowWrites`.
- Treat **static driving** (reading source, routes, and rendered markup without a live runtime) as the **documented interim** method, chosen at Plan time **only where no seam resolves** for the target environment — never the silent fallback.
- Hold the **read-only capture invariant** absolutely: the agent makes no source edits and no product mutations while driving; the only write is appending to the `temp/qa/<sessionId>` ledger.
- Authenticated driving follows the resolved environment's **`signInSeam`**: sign in through a dev `url` seam (persona name substituted into the template) or a `skill` seam (a stored `credentialRef` read by the named sign-in skill), with **mandatory redaction** of all captured evidence. Never type real credentials inline or fabricate a session; where an environment resolves no seam, drive the unauthenticated surface or fall back to static and record the gap.
- Pick the driving method explicitly in the Plan phase (drive vs. static) and record it in the ledger; do not switch methods mid-surface without a new Plan note.
- Every phase transition and every GitHub write is HITL-gated; the agent drives and captures, but never files or promotes findings autonomously.
- Broken navigation, a missing affordance, or a guard redirect loop is a **finding**, not a workaround — record it and move on; do not route around it with a direct URL.
- Scrub captured evidence (tokens, session cookies, PII) at the boundary via the shared redaction path before any finding reaches disk or GitHub.

Guidance for the **agent-driven** half of exploratory QA. `/qa-explore` is the
agent-led front-end (the agent drives, the operator watches); its human-led
sibling is `/qa-assist` (the human drives, the agent scribes). The exploration
**procedure** — argument parsing, phase gates, contract resolution, ledger
plumbing — is the SSOT in
[`qa-explore.md`](../../../../workflows/qa-explore.md); this skill shows **how**
to apply the driving conventions that procedure depends on. The
navigation-first execution and per-surface capture discipline are shared with
[`qa-harness`](../qa-harness/SKILL.md) (the known-scenario sweep); browser
instrumentation lives in
[`browser-testing-with-devtools`](../../../core/browser-testing-with-devtools/SKILL.md);
the read-only and no-PII boundaries are inviolable per
[`security-baseline.md`](../../../../rules/security-baseline.md). Read this
skill before driving a live surface; read the workflow for the phase order.

## 1. Navigation-First Driving (the default)

The agent reaches every surface the way a real user would. This is the
load-bearing convention — it is what makes findings reflect a user-reachable
state rather than an artifact of a deep link.

- **Drive the running app by default.** When a live runtime is reachable, drive
  it through the browser MCP (the chrome-devtools MCP surface). This is the
  primary method; static driving is the interim alternative (§ 2), not the
  norm.
- **Start at a root.** Begin each surface at the app's home or dashboard and
  reach the surface under test by clicking nav links, menu items, and buttons —
  the same affordances a user has.
- **Never URL-jump.** Do not navigate directly to a deep link to establish a
  starting state. URL-jumping bypasses the app's real authorization and routing
  flows, which both masks access-control gaps and produces findings that no
  user could actually trigger.
- **Broken navigation is a finding, not a workaround.** When an affordance is
  missing, a nav link 404s, or a guard redirect loops, that is the finding. Do
  not route around it with a direct URL — record it and move on.
- **Observe, do not fabricate.** Use app-provided UI affordances to reach and
  observe a surface. Never script the runtime to manufacture an outcome the
  exploration is meant to discover.

## 2. Static Driving — the Documented Interim

Static driving is the **explicitly documented interim** method for when **no
seam resolves** for the target environment — the resolved environment carries
no `signInSeam` the agent can drive through (§ 4). It walks the surface from
source, route definitions, and rendered markup rather than a running browser.

- **Choose it at Plan time, never silently.** Static is a deliberate Plan-phase
  decision recorded in the ledger ("environment: preview, method: static,
  reason: no seam resolves"), not an unannounced fallback the agent slips into
  when the browser MCP hiccups.
- **It is interim, not equivalent.** Static driving cannot exercise real
  authorization, routing guards, or runtime console/network signal. Treat its
  coverage as partial and say so in the ledger; a static pass does not close the
  same coverage a driven pass would.
- **Same read-only invariant.** Static driving reads source and routes; it makes
  no edits. The read-only capture invariant (§ 3) applies identically.
- **Promote to driving when a seam lands.** Static is the bridge until the
  target environment resolves a `signInSeam` (§ 4) that makes driven
  authenticated exploration possible. When that lands, re-run the surface
  driven; do not leave a surface permanently static when it could be driven.

## 3. The Read-Only Capture Invariant

The agent-driven Capture phase is **strictly read-only**. This invariant is
inviolable per [`security-baseline.md`](../../../../rules/security-baseline.md)
and the Story's security considerations — it is not a soft preference.

- **No source edits.** The agent does not modify application code, config, or
  tests while driving. Exploration observes; it never repairs.
- **No product mutations.** The agent does not create, update, or delete product
  data, submit destructive forms, or trigger irreversible actions to "see what
  happens". When a surface's only path forward is a mutating action, record the
  boundary as the finding and stop — do not cross it.
- **The only write is the ledger.** The single permitted side effect of Capture
  is appending finding lines to the session ledger under
  `temp/qa/<sessionId>`. Everything else is observation.
- **Scrub before persisting.** Strip tokens, session cookies, Authorization
  headers, and PII from captured console and network evidence via the shared
  redaction path **before** any finding reaches disk or GitHub. Captured
  evidence is untrusted until scrubbed.
- **HITL gates every write outward.** Phase transitions and GitHub writes
  (ticket creation, promotion) happen only behind an operator confirmation gate.
  The agent never files or promotes findings autonomously.

## 4. Authenticated Driving Follows the Per-Environment Seam

Driving an **authenticated** surface requires signing in. The resolved target
environment (via `resolveQaEnvironment`, § Policy Capsule) carries the
`signInSeam` the agent drives through — the same discriminated-union shape
`qa-harness` resolves via its contract. When a seam resolves, authenticated
deployed surfaces are **driven**, not statically deferred.

- **Drive the authenticated surface through the seam.** When the target
  environment carries a `signInSeam`, sign in via that seam and then reach the
  authenticated surface navigation-first — including authenticated **deployed**
  hosts. The two seam kinds:
  - **`kind: 'url'` (dev impersonation).** Substitute the persona **name** into
    the seam's URL template and navigate there. The persona name is the sole
    input; no per-persona auth material is read.
  - **`kind: 'skill'` (procedural / credential).** Invoke the named consumer
    sign-in skill, which reads a per-persona **`credentialRef`** — an indirect
    handle to a stored credential, never an inline secret. Read the skill's
    `SKILL.md` and follow it.
- **Never enter real credentials inline.** The agent MUST NOT type real
  usernames, passwords, or tokens to reach an authenticated surface, and MUST
  NOT fabricate or forge a session. Sign-in flows only through the seam, which
  consumes a persona name or a `credentialRef` indirection — never a
  hand-typed secret. This is a hard security boundary, not a convenience to
  work around.
- **Redaction is mandatory.** Every captured evidence string — console,
  network, headers — passes through the shared redaction path (§ 3) before it
  reaches disk or GitHub; bearer tokens, session cookies, `Authorization`
  headers, and PII are masked. Authenticated driving raises the stakes on
  redaction, it does not relax it.
- **Static only where no seam resolves.** When the target environment resolves
  **no** `signInSeam`, drive only the unauthenticated surface or fall back to
  static driving (§ 2), and record the gap in the ledger so the partial
  coverage is visible. A surface that could not be driven because the
  environment carries no seam is itself a coverage signal worth recording, not
  a silent skip.

## 5. Cross-References

- Run procedure (SSOT): [`qa-explore.md`](../../../../workflows/qa-explore.md).
- Known-scenario sibling sweep: [`qa-harness`](../qa-harness/SKILL.md).
- Browser instrumentation: [`browser-testing-with-devtools`](../../../core/browser-testing-with-devtools/SKILL.md).
- Read-only / no-PII boundary: [`security-baseline.md`](../../../../rules/security-baseline.md).
- Assertion-tier rules: [`testing-standards.md`](../../../../rules/testing-standards.md).
