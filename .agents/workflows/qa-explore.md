---
description: Agent-led exploratory-QA loop — the agent Plans a surface with an explicit static-vs-drive method choice, drives it (browser MCP or static), and captures ledger items read-only, then Triages — a bounded per-surface session, HITL-gated at every phase transition, routed through the shared dedup/coverage/classification/missing-test/redaction/session core under temp/qa/
---

# /qa-explore

Drive a **bounded, agent-led exploratory-QA session** as a human-in-the-loop
(HITL) loop: **Plan → Capture → Triage**. The operator names a single surface;
the agent drives it itself — **the agent drives, the operator watches and
gates** — and records each observation as a `QaLedgerItem` under a strictly
read-only capture invariant. Its human-led sibling is
[`/qa-assist`](qa-assist.md); no human-driven flow lives in `/qa-explore`.
Unlike [`/qa-run`](qa-run.md) (a known set of Gherkin `.feature` scenarios),
this is **open-ended exploration** for product bugs, environment-setup
friction, tooling/DX gaps, missing tests, and enhancement ideas.

The shared machinery — contract resolution + loud failure, the session & ledger
contract, redact-first, the `QaLedgerItem` shape, the triage procedure, and the
HITL write gate — lives once in [`helpers/qa-core.md`](helpers/qa-core.md); this
workflow states only the `/qa-explore`-specific phases (Plan / Capture).

> **When to run**: ad-hoc agent-driven exploration of a freshly delivered Story
> or Feature, a regression sweep over a risky surface before `/mandrel-deliver`, or a
> structured agent-driven bug-hunt captured into a triageable ledger.
>
> **Skills**: `stack/qa/qa-harness`

## Role framing

You are the quality gatekeeper for this run: value coverage, hermetic
environments, and deterministic results. Do **not** invent signal — capture what
the surface shows. Apply the QA skills below; there is no separate persona pack.

## Driving conventions

Before you drive a surface, read the
[`stack/qa/qa-harness`](../skills/stack/qa/qa-harness/SKILL.md)
skill — the **one** conventions reference for the *how* of agent-driven driving,
shared with the known-scenario sweep (navigation-first driving as the default;
static driving as the documented interim chosen at Plan time only where no seam
resolves; authenticated driving through the resolved environment's
`signInSeam`; broken navigation is a finding, not a workaround). Its § 5 carries
the exploratory-mode deltas. The driving method (drive vs. static) is a
**Plan-phase decision recorded in the ledger**; do not switch methods
mid-surface without a new Plan note. Do not restate these conventions inline —
the skill owns them.

## Slash Command

```text
/qa-explore <surface>
```

### Arguments

| Name      | Required | Shape / Example                    | Notes                                                                                  |
| --------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `surface` | yes      | `feature:login`, `area:onboarding` | A human label for the single surface to explore. Recorded as each ledger item's `coverage`. |

If no `surface` is supplied, **stop and ask** the operator to name one — do not
invent scope.

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

1. Re-read the `stack/qa/qa-harness` skill and resolve the contract and
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
> [`stack/qa/qa-harness`](../skills/stack/qa/qa-harness/SKILL.md)
> § 2 (inviolable per [`security-baseline.md`](../rules/security-baseline.md)),
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
2. **Read the coverage tiers and name the missing test** per
   [`helpers/qa-core.md`](helpers/qa-core.md) § Coverage tiers, recording the
   sentence as the ledger item's `missingTest` (or `null`).
3. **Append a `QaLedgerItem`** to the ledger (shape per
   [`helpers/qa-core.md`](helpers/qa-core.md)): a stable `id`, the redacted
   `evidence`, the `coverage` label (the `surface`, or `unknown`), a tentative
   `class` and `severity`, the `missingTest`, and `disposition` left untriaged.
4. Continue driving until the agent believes the surface is covered, then
   propose that exploration is complete.
5. **Gate:** present the captured ledger (item count, classes, the driving
   method used, the rolling backlog) and ask the operator to confirm moving to
   Triage. Do **not** triage until they confirm.

---

## Phase 3 — Triage

Route the captured ledger through the shared classify → route → disposition →
promote procedure in [`helpers/qa-core.md`](helpers/qa-core.md), with the
operator deciding each `file` / `defer` / `dismiss` and every write
operator-gated. `file` findings are promoted through `/mandrel-plan` (never a raw
Issue); `defer` carries an item forward as backlog; `dismiss` marks it
non-actionable.

After triage, write the updated dispositions back to the ledger (still under
`temp/qa/`), and summarize: items captured, the driving method used, classes,
routes (`new`/`update-existing`/`duplicate`/`regression-of-closed`), the
Stories (`/mandrel-plan --seed-file`) promoted, and the deferred rolling backlog a
resumed session will pick up.

---

## Constraints

The shared core in [`helpers/qa-core.md`](helpers/qa-core.md) and the driving
conventions in [`stack/qa/qa-harness`](../skills/stack/qa/qa-harness/SKILL.md)
bind this workflow. The `/qa-explore` deltas are stated once, above: one
surface per session, the method chosen at Plan time, and a read-only Capture.

## See also

- [`/mandrel-plan`](mandrel-plan.md) — the planning pipeline Triage chains into for a
  `file`-dispositioned finding. The plan→deliver hard stop is preserved.
- [`/qa-assist`](qa-assist.md) — the human-led sibling that enriches a single
  operator observation and triages through the same `/mandrel-plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for the
  findings → `/mandrel-plan` handoff and the shared fingerprint-footer dedup contract.
- [`helpers/qa-core.md`](helpers/qa-core.md) — the shared contract/session/
  redaction/QaLedgerItem/triage/HITL core.
