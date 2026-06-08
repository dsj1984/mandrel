---
name: qa-explore-driving
description:
  Conventions for agent-driven exploratory QA driving — how the agent itself
  drives a surface during `/qa-explore` (agent-led), as opposed to the
  human-led `/qa-assist`. Use when the agent explores a running app via the
  browser MCP (navigation-first, the default) or walks a static surface (the
  documented interim until consumer persona-seeding lands), under a strictly
  read-only capture invariant. The exploration procedure lives in
  `.agents/workflows/qa-explore.md`; this skill is the driving-conventions
  reference it leans on.
---

# Skill: qa-explore-driving

## Policy Capsule

- Drive the running app **by default** through the browser MCP, navigation-first: start at a root and reach each surface only via UI affordances — never URL-jump to a deep link.
- Treat **static driving** (reading source, routes, and rendered markup without a live runtime) as the **documented interim** method, chosen at Plan time when a live runtime is not reachable — never the silent fallback.
- Hold the **read-only capture invariant** absolutely: the agent makes no source edits and no product mutations while driving; the only write is appending to the `temp/qa/<sessionId>` ledger.
- Authenticated driving depends on **consumer persona-seeding infrastructure that this Epic does not deliver**; without it, drive only the unauthenticated surface or fall back to static, and record the gap — never enter real credentials or fabricate a session.
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

Static driving is the **explicitly documented interim** method for when a live
runtime is not reachable — most commonly because authenticated driving needs
consumer persona-seeding infrastructure that does not yet exist (§ 4). It walks
the surface from source, route definitions, and rendered markup rather than a
running browser.

- **Choose it at Plan time, never silently.** Static is a deliberate Plan-phase
  decision recorded in the ledger ("method: static, reason: no reachable
  authenticated runtime"), not an unannounced fallback the agent slips into
  when the browser MCP hiccups.
- **It is interim, not equivalent.** Static driving cannot exercise real
  authorization, routing guards, or runtime console/network signal. Treat its
  coverage as partial and say so in the ledger; a static pass does not close the
  same coverage a driven pass would.
- **Same read-only invariant.** Static driving reads source and routes; it makes
  no edits. The read-only capture invariant (§ 3) applies identically.
- **Promote to driving when the runtime lands.** Static is the bridge until the
  consumer's persona-seeding infrastructure (§ 4) makes authenticated driving
  possible. When that lands, re-run the surface driven; do not leave a surface
  permanently static when it could be driven.

## 3. The Read-Only Capture Invariant

The agent-driven Capture phase is **strictly read-only**. This invariant is
inviolable per [`security-baseline.md`](../../../../rules/security-baseline.md)
and the Epic's security considerations — it is not a soft preference.

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

## 4. Authenticated Driving Depends on Consumer Infra (Not Delivered Here)

Driving an **authenticated** surface requires signing in as a seeded persona.
That seeding — provisioning a test persona with the right org, role, and data
so the agent can reach a logged-in surface navigation-first — is **consumer
persona-seeding infrastructure that this Epic does not deliver**. It is an
explicit non-goal of the `/qa-explore` rebuild.

- **Unauthenticated surface only, by default.** Without persona-seeding infra in
  the consumer project, drive only the surface reachable without sign-in, or
  fall back to static driving (§ 2) for the authenticated surface. Record the
  gap in the ledger so the partial coverage is visible.
- **Never enter real credentials.** The agent MUST NOT type real usernames,
  passwords, or tokens to reach an authenticated surface, and MUST NOT fabricate
  or forge a session. This is a hard security boundary, not a convenience to
  work around.
- **The dependency is the consumer's to satisfy.** When a consumer wants driven
  authenticated exploration, the consumer supplies a dev sign-in seam and seeded
  personas (the same shape `qa-harness` resolves via its contract). Until then,
  authenticated coverage is static or deferred — say which in the ledger.
- **Surface the gap, don't paper over it.** A surface that could not be driven
  because authenticated seeding is absent is itself a coverage signal worth
  recording, not a silent skip.

## 5. Cross-References

- Run procedure (SSOT): [`qa-explore.md`](../../../../workflows/qa-explore.md).
- Known-scenario sibling sweep: [`qa-harness`](../qa-harness/SKILL.md).
- Browser instrumentation: [`browser-testing-with-devtools`](../../../core/browser-testing-with-devtools/SKILL.md).
- Read-only / no-PII boundary: [`security-baseline.md`](../../../../rules/security-baseline.md).
- Assertion-tier rules: [`testing-standards.md`](../../../../rules/testing-standards.md).
