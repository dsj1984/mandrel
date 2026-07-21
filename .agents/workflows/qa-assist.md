---
description: Human-led QA assist loop — set up, then ride a rolling multi-observation intake session. The operator reports observations in any order; the agent enriches each (repro + root-cause file:line + coverage verdict for bugs; analysis + options + recommendation for enhancements), asks clarifying questions only when ambiguous, and appends a redacted ledger item — recording, never planning — to a persistent, resumable session under temp/qa/. Only when the operator says they are done does it review the full ledger and hand off to /plan.
---

# /qa-assist

Drive a **human-led, rolling QA-assist session**. The operator tests; the agent
rides alongside as the QA engineer and captures what they see into a
high-quality, triage-ready ledger. The session has four movements:

1. **Setup & Ready** (Phase 0) — load codebase context, resolve the contract,
   open (or resume) the rolling ledger, then tell the operator what it will do
   and that it is **ready for observations**.
2. **Rolling intake** (Phases 1–3, looped) — the operator reports observations
   **in any order and any quantity**: one at a time, or a **brain dump** of many
   at once. The agent splits a multi-observation message into discrete items and
   runs each through **Intake → Enrich → Record**, then **loops straight back**
   for more. It **records and enriches only — it never plans or fixes during
   intake.**
3. **Done** — when the operator says they have finished testing, the agent does
   a final review of the **entire** ledger and asks any last clarifying
   questions.
4. **Triage & Plan** (Phase 4) — only then does it route the full ledger through
   [`/plan`](plan.md) to generate Stories.

Unlike [`/qa-explore`](qa-explore.md) (where the *agent* drives open-ended
exploration of a named surface), `/qa-assist` is **human-led**: the human owns
the signal, the agent owns the enrichment. It is the front door for "I'm
testing — ride along and capture everything well." Each observation is a
`QaLedgerItem` on the same ledger `/qa-explore` produces, so a `/qa-assist` item
flows through the identical dedup, classification, and promotion machinery in
Phase 4.

The shared machinery — contract resolution + loud failure, the session & ledger
contract, redact-first, the `QaLedgerItem` shape, the triage procedure, and the
HITL write gate — lives once in [`helpers/qa-core.md`](helpers/qa-core.md); this
workflow states only the `/qa-assist`-specific phases (Intake / Enrich) plus a
Constraints delta.

> **When to run**: a developer or operator is about to test (or is mid-test) and
> wants every bug and enhancement idea captured as a high-quality,
> triage-ready finding without breaking stride — then, when the testing pass is
> done, turned into a plan in one batch.
>
> **Skills**: `core/qa-coverage-mapping`

## Role framing

You are the quality gatekeeper for this run: value coverage, hermetic
environments, and deterministic results. **Never invent the signal** — the human
owns what was observed; you enrich it. Apply the QA skills; there is no separate
persona pack.

## Slash Command

```text
/qa-assist [observation]
```

### Arguments

| Name          | Required | Shape / Example                                   | Notes                                                                                                                                  |
| ------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `observation` | no       | `"sync-commands wipes .claude on a reused name"` | An optional first observation, or a brain dump of several. **Usually omitted** — the normal launch is a bare `/qa-assist`, which does Setup and then waits. If supplied, run Setup first, then feed it in as the first intake (splitting it if it carries multiple observations). |

A bare `/qa-assist` is the expected entry point. **Do not** demand an
observation up front and **do not** synthesize one — the QA Golden Rule forbids
inventing the signal. Set up, announce ready, and wait.

## Contract & session — persistent, resumable, rolling

Resolve the `qa` contract and the session per
[`helpers/qa-core.md`](helpers/qa-core.md) during Setup — the resolver fails
**loudly** when the harness is unbound; surface that verbatim and stop.
`/qa-assist` **defaults to a persistent rolling session**: the same session is
resumed across invocations so an operator can top up the same ledger across a
working day or a multi-launch pass. A reused session **appends** (never
overwrites) and surfaces the carried `untriaged` items as the rolling backlog so
the operator sees what is still open. Pass `--session-id <id>` (or
`QA_SESSION_ID`) to resume or fork a named session.

## Phase gates (HITL)

Gating is deliberately **light during intake and firm at the boundary**, so the
rolling loop stays fluid:

- **Within a single observation, Intake → Enrich → Record is fluid.** The agent
  restates, enriches, and appends the ledger item without ceremony, pausing only
  to **ask clarifying questions when the observation is ambiguous**. After each
  append it **echoes the recorded item** for correction, then **loops back** for
  the next observation. It does **not** triage, route, file tickets, or invoke
  `/plan` during intake.
- **Two things always require explicit operator confirmation** (the HITL write
  gate in [`helpers/qa-core.md`](helpers/qa-core.md)). First, the session-level
  transition into **Phase 4 — Triage & Plan** — the operator must say they are
  done. Second, **every write that leaves the local ledger** — filing a ticket,
  invoking `/plan`, or mutating a label. Present the artifact, ask, and wait.

In short: appending to the rolling ledger is the natural product of intake and
needs no gate beyond the echo-back; **planning and anything that leaves the
ledger is hard-gated.**

---

## Phase 0 — Setup & Ready

Goal: become the operator's QA assistant before any observation arrives.

1. Re-read the QA role framing and `core/qa-coverage-mapping` skill.
2. **Load codebase context.** Read the files in `project.docsContextFiles`
   (architecture, decisions, patterns) and, when the testing touches UI/routing,
   `docs/style-guide.md` / `docs/web-routes.md`. This is the context you will
   draw on to enrich observations without guessing.
3. **Resolve the `qa` contract and the rolling session** (above). Compute the
   ledger path and load any carried `untriaged` backlog.
4. **Announce readiness.** Tell the operator, in one short message: which
   session this is (new vs. resumed) and how many items are already on the
   ledger; what you will do with each observation (enrich bugs with repro +
   root-cause `file:line` + coverage; enrich enhancements with analysis +
   options + a recommendation) and that you will **record only, not plan**; and
   that you are **ready for observations, in any order** and they should tell you
   when they are **done testing**.
5. **Wait.** Do not invent an observation. If launched with an `observation`
   argument, treat it as the first intake and proceed to Phase 1; otherwise wait
   for the operator's first report.

---

## Phase 1 — Intake (per observation, looped)

Goal: understand **exactly what the human observed** before enriching it. The
operator's message may carry **one observation or a brain dump of many**; split
first, then run Intake for **each** before returning for the next message.

1. **Split a brain dump into discrete observations.** Parse the message into the
   distinct things observed — one ledger item per distinct symptom, surface, or
   idea. Use the operator's own structure (numbered/bulleted list, blank-line
   paragraphs, "and another thing…") as the split boundary; do **not** merge two
   unrelated symptoms or split one symptom into several. **Echo the parsed list
   back** ("I read N observations: …") and let the operator correct the split
   before you enrich anything — the only confirmation intake requires. A
   single-observation message is the N = 1 case; skip the echo when it is
   unambiguously one item.
2. **Process each observation in turn** through the rest of this phase and
   Phases 2–3. For each one:
   - **Restate the observation** in your own words — the surface it touches, the
     action taken, the actual result, and (for a bug) the expected result, or
     (for an enhancement) the desired improvement.
   - **Ask clarifying questions only when that observation is ambiguous.** If you
     cannot confidently fill in the load-bearing facts, **ask** — do not paper
     over the gap with an assumption. Typical gaps: which surface/command/flow;
     the exact steps and whether it reproduces; what was expected and why that is
     the contract; the environment (OS, shell, branch, fresh vs. reused state).
     When the observation is already clear, **do not interrogate**. Batch the
     questions across the brain dump into one message.

---

## Phase 2 — Enrich (per observation)

Goal: turn the observation into a high-quality, triage-ready finding. Delegate
every decision to the shared helpers; never re-derive them in prose.

1. **Redact first** (per [`helpers/qa-core.md`](helpers/qa-core.md)) — scrub the
   evidence string through `redactEvidence` before it touches disk or GitHub.
2. **Branch on what kind of observation it is.**
   - **Bug.** Establish a clean, minimal, deterministic **repro**. Investigate
     the **root cause** (read the relevant code, console, and logs) and pin the
     locus as a concrete **`file:line`** reference (say so explicitly if you
     cannot pin it rather than inventing a locus). Then run the coverage steps.
   - **Enhancement / suggestion.** Analyze **how** the change would be made: the
     surfaces it touches, the **options**, and a brief **recommendation** with
     trade-offs. Still pin the relevant `file:line` anchor(s) where the change
     would land.
3. **Hydrate the QA context** to locate code precisely, via
   [`qa-context-hydrator.js`](../scripts/lib/qa/qa-context-hydrator.js) — it
   resolves the source ticket body, the feature-file set, the surface map, and
   recent git log:

   ```js
   import { hydrateQaContext } from '../scripts/lib/qa/qa-context-hydrator.js';
   const context = await hydrateQaContext({ ticketNumber, githubPort, gitPort, surfaceMap });
   ```

4. **Compute the coverage verdict** for the surface the observation points at,
   via [`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js) — the
   deterministic seam behind the
   [`core/qa-coverage-mapping`](../skills/core/qa-coverage-mapping/SKILL.md)
   skill. Read that skill for how to assemble the `surface` input and read the
   per-tier `{present|absent}` verdict. Optionally render a human-readable
   summary via [`coverage-report.js`](../scripts/lib/qa/coverage-report.js).
5. **Propose the missing test** (if any) from that verdict, via
   [`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js) — it
   names the lowest absent tier, or returns `null` when every tier is covered.
   Record its `description` as the ledger item's `missingTest`.
6. **Classify** the finding via
   [`classify-finding.js`](../scripts/lib/findings/classify-finding.js) so the
   tentative `class` resolves to the correct focus/meta label set. The helper
   **throws** on an absent/unknown class — fix the finding's class rather than
   defaulting.

---

## Phase 3 — Record (per observation), then loop

Goal: persist the enriched finding to the rolling ledger and **return to
intake**. **No triage, routing, ticket-filing, or `/plan` happens here** — that
is Phase 4, and only after the operator says they are done.

1. **Append a `QaLedgerItem`** to the ledger (shape per
   [`helpers/qa-core.md`](helpers/qa-core.md)): a stable `id` (appended after any
   carried backlog), the redacted `evidence`, the repro and root-cause
   `file:line` notes (or the enhancement analysis/options/recommendation), the
   `coverage` label, the `class` and `severity`, the `missingTest`, and a
   `disposition` of **untriaged** (intake does not decide disposition — Phase 4
   does).
2. **Echo the recorded item** back in one short line — its `class`, `severity`,
   root-cause locus or recommendation, and coverage verdict — so the operator can
   correct it on the spot. When a brain dump produced several items, append them
   all, then echo a **compact batch summary** (one line per new `Lx` item).
3. **Loop back to Phase 1** and wait for the next message. Keep doing this for as
   many observations as the operator reports — one at a time or in batches, in
   any order — until they say they are done testing.

---

## Phase 4 — Triage & Plan (on "I'm done")

Goal: when the operator says they have finished testing, turn the **whole**
ledger into a plan. This is the only phase that triages, routes, or plans, and
its transition is **explicitly operator-gated**.

1. **Final ledger review.** Read the entire rolling ledger back to the operator:
   every item, its class/severity, root-cause or recommendation, and coverage
   verdict. Confirm it is complete and ask any **last clarifying questions** —
   missing repro, an item that should be split or merged, a severity to adjust.
   Let the operator set each item's disposition (`file` / `defer` / `dismiss`).
2. **Triage the ledger** through the shared classify → route → disposition →
   promote procedure in [`helpers/qa-core.md`](helpers/qa-core.md): dedup/route
   each `file` finding against open + closed Issues, then promote the
   `file`-dispositioned findings through `promoteFindings` → `/plan` (never a raw
   Issue), stamping each cluster's `fingerprintFooter(sha)` into the seed.
   `defer` carries an item forward as backlog; `dismiss` marks it non-actionable.
3. **Gate:** the move into this phase, and every write inside it (seed write,
   `/plan` invocation, ticket-filing, label mutation), is **operator-gated** —
   confirm each one. The plan→deliver hard stop is preserved; redaction has
   already run, so nothing unredacted reaches disk or GitHub.

After planning, summarize: the findings recorded, the route/promotion decisions
(`new`/`update-existing`/`duplicate`/`regression-of-closed`), whether each
cluster became a Story via `/plan --seed-file`, and any `defer` backlog a
resumed session will pick up.

---

## Constraints

Beyond the shared core ([`helpers/qa-core.md`](helpers/qa-core.md): contract +
loud failure, session/ledger, redact-first, QaLedgerItem, triage, HITL gate),
the `/qa-assist`-specific deltas are:

- **Human-led, rolling, multi-observation.** The operator owns the signal and
  reports in any order and quantity — one at a time or a brain dump. The agent
  splits a brain dump (echoing the split for correction), then enriches and
  records each. **Never invent an observation**; ask clarifying questions only
  when one is ambiguous, batched across the dump.
- **Record during intake; plan only on "done".** Phases 1–3 enrich, append, and
  loop — never triage, route, file, or invoke `/plan`. All of that is Phase 4,
  entered only on explicit operator confirmation that testing is done.
- **Light intake gate, firm boundary gate.** Intake → Enrich → Record is fluid
  (echo-back, no ceremony); the move into Phase 4 and every write that leaves the
  ledger are hard-gated.
- **Persistent, resumable rolling session** — `/qa-assist` defaults to resuming
  the same session and appending; a reused session carries the untriaged backlog
  forward and never overwrites a prior ledger.
- **Enrichment helpers are deterministic** — context hydration
  ([`qa-context-hydrator.js`](../scripts/lib/qa/qa-context-hydrator.js)),
  coverage verdict/report, missing-test, and classification are never re-derived
  in prose.

## See also

- [`/plan`](plan.md) — the planning pipeline `/qa-assist` chains into in Phase 4.
  The plan→deliver hard stop is preserved across the handoff.
- [`/qa-explore`](qa-explore.md) — the agent-led sibling that drives a named
  surface and triages through the same `/plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for the
  findings → `/plan` handoff and the shared fingerprint-footer dedup contract.
- [`helpers/qa-core.md`](helpers/qa-core.md) — the shared contract/session/
  redaction/QaLedgerItem/triage/HITL core.
