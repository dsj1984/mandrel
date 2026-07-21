---
description: Agent-led exploratory-QA loop — the agent Plans a surface with an explicit static-vs-drive method choice, drives it (browser MCP or static), and captures ledger items read-only, then Triages — a bounded per-surface session, HITL-gated at every phase transition, routed through the shared dedup/coverage/classification/missing-test/redaction/session core under temp/qa/
---

# /qa-explore

Drive a **bounded, agent-led exploratory-QA session** as a human-in-the-loop
(HITL) loop: **Plan → Capture → Triage**. The operator names a single surface;
the agent (acting as the QA engineer) **plans** how it will reach that surface,
**drives** it itself — through the browser MCP by default, or statically as a
documented interim — and records each observation as a structured ledger item
under a strictly read-only capture invariant. Only after explicit operator
confirmation does it triage the ledger into routed, classified, dedup'd
follow-up dispositions.

This is the **agent-led** front-end of exploratory QA: **the agent drives, the
operator watches and gates.** Its human-led sibling is
[`/qa-assist`](qa-assist.md) — there the *human* drives a single observation and
the agent scribes/enriches. No human-driven flow lives in `/qa-explore`.

Unlike [`/qa-run`](qa-run.md) (which steps a known set of Gherkin `.feature`
scenarios through a browser), `/qa-explore` is **open-ended exploration**: the
agent probes the surface for product bugs, environment-setup friction,
tooling/DX gaps, missing tests, and enhancement ideas — each captured as a
`QaLedgerItem`.

The shared machinery — contract resolution + loud failure, the session & ledger
contract, redact-first, the `QaLedgerItem` shape, the triage procedure, and the
HITL write gate — lives once in [`helpers/qa-core.md`](helpers/qa-core.md); this
workflow states only the `/qa-explore`-specific phases (Plan / Capture) plus a
Constraints delta.

> **When to run**: ad-hoc agent-driven exploration of a freshly delivered Story
> or Feature, a regression sweep over a risky surface before `/deliver`, or a
> structured agent-driven bug-hunt captured into a triageable ledger.
>
> **Skills**: `core/qa-coverage-mapping`, `stack/qa/qa-explore-driving`

## Role framing

You are the quality gatekeeper for this run: value coverage, hermetic
environments, and deterministic results. Do **not** invent signal — capture what
the surface shows. Apply the QA skills below; there is no separate persona pack.

## Driving conventions

Before you drive a surface, read the
[`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md)
skill — the **one** conventions reference for the *how* of agent-driven
exploration (navigation-first driving as the default; static driving as the
documented interim chosen at Plan time only where no seam resolves;
authenticated driving through the resolved environment's `signInSeam`; broken
navigation is a finding, not a workaround). The driving method (drive vs.
static) is a **Plan-phase decision recorded in the ledger**; do not switch
methods mid-surface without a new Plan note. Do not restate these conventions
inline — the skill owns them.

## Slash Command

```text
/qa-explore <surface>
```

### Arguments

| Name      | Required | Shape / Example                    | Notes                                                                                  |
| --------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `surface` | yes      | `feature:login`, `area:onboarding` | A human label for the single surface to explore. Recorded as each ledger item's `coverage`. |

If no `surface` is supplied, **stop and ask** the operator to name one — do not
invent scope. `/qa-explore` is **bounded to one surface per session**: explore
exactly the named surface, do not wander into adjacent surfaces, and start a
fresh session for a different surface.

## Contract & session

Resolve the `qa` contract and the session (under `temp/qa/`) per
[`helpers/qa-core.md`](helpers/qa-core.md) before exploring — the resolver fails
**loudly** when the project has not bound the harness; surface that verbatim and
stop. A reused session appends and carries its `untriaged` backlog forward.

## Bounded per-surface session

A `/qa-explore` run is a **single bounded session over one named surface**, not
an open-ended sweep:

- **One surface.** The session explores exactly the `surface` argument. Driving
  it may legitimately touch sub-surfaces reachable navigation-first, but the
  session does not pivot to a different top-level surface — that is a new
  session.
- **Bounded by the operator's gate.** Capture continues until the operator says
  exploration is complete (the Capture → Triage gate), not until the agent has
  exhausted the app. The agent proposes when it believes the surface is
  covered; the operator decides.
- **Resumable, not unbounded.** A reused session appends to the same ledger and
  carries its untriaged backlog forward; it does not widen the surface.

## Phase gates (HITL)

Every phase transition is gated on **explicit operator confirmation** (the HITL
write gate in [`helpers/qa-core.md`](helpers/qa-core.md)). Do not advance
Plan → Capture, or Capture → Triage, until the operator says so. State each gate
as a question, present the artifact (the plan with its chosen driving method,
then the captured ledger), and wait. If the operator does not confirm, hold.

---

## Phase 1 — Plan

Goal: agree on **what** will be explored and **how the agent will drive it**
before touching the surface.

1. Re-read the `stack/qa/qa-explore-driving` skill and resolve the contract and
   session (above).
2. **Resolve the target environment** via
   [`resolveQaEnvironment`](../scripts/lib/qa/resolve-qa-contract.js) — it keys
   each deployment target to `{ name, baseUrl, signInSeam, allowWrites }`. When
   the operator's `surface` does not pin an unambiguous target and the contract
   declares more than one environment, **prompt** the operator (or accept
   `defaultEnvironment`) — never silently pick one. The resolver throws loudly
   (naming the known environments) on an unknown name or unmatched URL; surface
   that verbatim and stop.
3. **Choose the driving method explicitly** for the named `surface` on the
   resolved environment:
   - **Drive (default):** a seam resolves, so drive through the browser MCP
     navigation-first — including authenticated deployed hosts reached via a
     `skill` seam (a stored `credentialRef` read by the named sign-in skill,
     never a hand-typed secret) or a dev `url` seam (persona name substituted).
   - **Static (documented interim):** **no seam resolves**, so walk the surface
     from source, routes, and rendered markup — a deliberate Plan-time decision
     with a recorded reason, never a silent fallback.
4. Draft an **exploration plan**: the resolved target environment (name +
   `baseUrl`), the sub-surfaces / flows / states to drive, the classes of signal
   being hunted (the [ledger `class` enum](../schemas/qa-ledger.schema.json)),
   the chosen method and its rationale, and any rolling backlog carried forward.
   Record the resolved **environment name**, the chosen method, and the reason on
   the ledger (e.g. `environment: staging, method: drive, seam: skill` or
   `environment: preview, method: static, reason: no seam resolves`).
5. Present the plan, the resolved environment, the chosen method, and the
   resolved `ledgerPath` to the operator.
6. **Gate:** ask the operator to confirm the plan, the environment, and the
   method (or amend). Do **not** proceed to Capture until they confirm.

---

## Phase 2 — Capture (agent drives, READ-ONLY)

Goal: **the agent drives the confirmed surface itself** and records its
observations. **This phase is strictly read-only.**

> **Read-only invariant.** The agent observes; it never mutates. Per
> [`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md)
> § 3 (inviolable per [`security-baseline.md`](../rules/security-baseline.md)),
> do **not** edit source, run write commands, file or label GitHub issues,
> change tickets, submit destructive forms, or alter the product under test. The
> only write Capture performs is **appending ledger lines to
> `temp/qa/<sessionId>.ndjson`**. When a surface's only path forward is a
> mutating action, record the boundary as the finding and stop — do not cross
> it.

Drive the surface using the method chosen in Plan (per the driving-conventions
skill): navigation-first through the browser MCP for **drive**, signing in
through the resolved environment's `signInSeam`; or walking source, routes, and
rendered markup for **static** (treat its coverage as partial and say so in the
ledger). Never URL-jump to establish a starting state, and reach an
authenticated surface only through the resolved environment's `signInSeam`:
**Never type real credentials inline** and never fabricate a session.

For each observation the agent makes while driving:

1. **Redact first** (per [`helpers/qa-core.md`](helpers/qa-core.md)) — scrub the
   evidence string through `redactEvidence` before it touches disk.
2. **Compute the coverage verdict** for the surface the observation points at,
   via [`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js) — the
   deterministic seam behind the
   [`core/qa-coverage-mapping`](../skills/core/qa-coverage-mapping/SKILL.md)
   skill. Read that skill for how to assemble the `surface` input and read the
   per-tier `{present|absent}` verdict.
3. **Propose the missing test** (if any) from that verdict, via
   [`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js) — it
   names the lowest absent tier, or returns `null` when every tier is covered.
   Record its `description` as the ledger item's `missingTest` (or `null`).
4. **Append a `QaLedgerItem`** to the ledger (shape per
   [`helpers/qa-core.md`](helpers/qa-core.md)): a stable `id`, the redacted
   `evidence`, the `coverage` label (the `surface`, or `unknown`), a tentative
   `class` and `severity`, the `missingTest`, and `disposition` left untriaged.
5. Continue driving until the agent believes the surface is covered, then
   propose that exploration is complete.
6. **Gate:** present the captured ledger (item count, classes, the driving
   method used, the rolling backlog) and ask the operator to confirm moving to
   Triage. Do **not** triage until they confirm.

---

## Phase 3 — Triage

Route the captured ledger through the shared classify → route → disposition →
promote procedure in [`helpers/qa-core.md`](helpers/qa-core.md), with the
operator deciding each `file` / `defer` / `dismiss` and every write
operator-gated. `file` findings are promoted through `/plan` (never a raw
Issue); `defer` carries an item forward as backlog; `dismiss` marks it
non-actionable.

After triage, write the updated dispositions back to the ledger (still under
`temp/qa/`), and summarize: items captured, the driving method used, classes,
routes (`new`/`update-existing`/`duplicate`/`regression-of-closed`), the
Stories (`/plan --seed-file`) promoted, and the deferred rolling backlog a
resumed session will pick up.

---

## Constraints

Beyond the shared core ([`helpers/qa-core.md`](helpers/qa-core.md): contract +
loud failure, session/ledger, redact-first, QaLedgerItem, triage, HITL gate)
and the driving conventions
([`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md)),
the `/qa-explore`-specific deltas are:

- **Agent-led, bounded per surface.** The agent drives one named surface per
  session and proposes when it is covered; the operator gates the boundary. No
  human-driven flow lives here — that is [`/qa-assist`](qa-assist.md).
- **Pick the driving method at Plan time** (drive default; static the documented
  interim, chosen with a recorded reason, never a silent fallback); do not
  switch mid-surface without a new Plan note.
- **Capture is read-only.** The only Capture write is appending ledger lines
  under `temp/qa/`. No source edits, ticket mutations, product writes, or
  destructive form submissions. Reach an authenticated surface only through the
  resolved environment's `signInSeam`; where no seam resolves, record the gap
  and fall back to static.
- **Broken navigation is a finding, not a workaround** — never URL-jump around a
  missing affordance, a nav 404, or a guard redirect loop.
- **Delegate coverage decisions to the helpers.** Coverage verdict
  ([`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js)) and
  missing-test ([`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js))
  are deterministic — never re-derive them in prose.

## See also

- [`/plan`](plan.md) — the planning pipeline Triage chains into for a
  `file`-dispositioned finding. The plan→deliver hard stop is preserved.
- [`/qa-assist`](qa-assist.md) — the human-led sibling that enriches a single
  operator observation and triages through the same `/plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for the
  findings → `/plan` handoff and the shared fingerprint-footer dedup contract.
- [`helpers/qa-core.md`](helpers/qa-core.md) — the shared contract/session/
  redaction/QaLedgerItem/triage/HITL core.
