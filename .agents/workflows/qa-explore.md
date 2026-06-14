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
the agent scribes/enriches. No human-driven flow lives in `/qa-explore`; if you
want to capture something *you* observed, use `/qa-assist` instead.

Unlike [`/qa-run-harness`](qa-run-harness.md) (which steps a known set of
Gherkin `.feature` scenarios through a browser), `/qa-explore` is **open-ended
exploration**: the agent probes the surface for product bugs, environment-setup
friction, tooling/DX gaps, missing tests, and enhancement ideas — each captured
as a `QaLedgerItem` against the
[`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json) contract.

This is a **prose workflow**, not a Node orchestrator: the host LLM executes
the procedure; deterministic Node helpers under `.agents/scripts/lib/qa/` and
`.agents/scripts/lib/findings/` do the contract resolution, session/ledger
resolution, redaction, coverage verdict, missing-test proposal, classification,
and dedup/route decisions. The agent never invents those decisions in prose.

> **When to run**: ad-hoc agent-driven exploration of a freshly delivered Story
> or Feature, a regression sweep over a risky surface before `/deliver`, or
> a structured agent-driven bug-hunt the operator wants captured into a
> triageable ledger.
>
> **Persona**: `qa-engineer` · **Skills**: `core/qa-coverage-mapping`,
> `stack/qa/qa-explore-driving`

## Persona

Adopt the **`qa-engineer`** persona
([`.agents/personas/qa-engineer.md`](../personas/qa-engineer.md)) for the whole
run. You are the quality gatekeeper: you value coverage, hermetic
environments, and deterministic results. Re-read that persona file as your
first action so the Plan/Capture/Triage loop is governed by it.

## Driving conventions skill

Before you drive a surface, read the
[`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md)
skill. It is the conventions reference this procedure depends on for the
**how** of agent-driven exploration:

- **Navigation-first driving (the default).** Drive the running app through the
  browser MCP, starting at a root and reaching each surface only via UI
  affordances — never URL-jump to a deep link. Browser instrumentation lives in
  [`core/browser-testing-with-devtools`](../skills/core/browser-testing-with-devtools/SKILL.md).
- **Static driving (the documented interim).** When a live runtime is not
  reachable, walk the surface from source, route definitions, and rendered
  markup — chosen explicitly at Plan time, never as a silent fallback.
- **Authenticated driving depends on consumer persona-seeding infrastructure
  this framework does not deliver.** Without it, drive only the unauthenticated
  surface or fall back to static, never enter real credentials, and record the
  gap.
- **Broken navigation is a finding, not a workaround.** A missing affordance, a
  nav 404, or a guard redirect loop is recorded and you move on — you do not
  route around it with a direct URL.

The driving method (drive vs. static) is a **Plan-phase decision recorded in the
ledger**; do not switch methods mid-surface without a new Plan note.

## Slash Command

```text
/qa-explore <surface>
```

### Arguments

| Name      | Required | Shape / Example                    | Notes                                                                                  |
| --------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `surface` | yes      | `feature:login`, `area:onboarding` | A human label for the single surface to explore. Recorded as each ledger item's `coverage`. |

If no `surface` is supplied, **stop and ask** the operator to name one — the
`qa-engineer` Golden Rule forbids inventing scope. `/qa-explore` is **bounded
to one surface per session**: explore exactly the named surface, do not wander
into adjacent surfaces, and start a fresh session for a different surface.

## Project contract

Resolve the consumer's `qa` contract before exploring, via
[`resolve-qa-contract.js`](../scripts/lib/qa/resolve-qa-contract.js):

```js
import { resolveQaContract } from '../scripts/lib/qa/resolve-qa-contract.js';
const contract = resolveQaContract(config); // throws loudly if unbound
```

The resolver fails **loudly** when the project has not bound the QA harness
(no `qa` block in `.agentrc.json`) — there is no silent fallback. If it throws
the "this project has not bound the QA harness" message, surface that verbatim
to the operator and stop; do not pretend a contract exists.

## Session & ledger (temp/qa/)

Resolve the session and its ledger path **once**, up front, via
[`qa-session.js`](../scripts/lib/qa/qa-session.js):

```js
import { resolveQaSession } from '../scripts/lib/qa/qa-session.js';
const { sessionId, ledgerPath, reused, untriaged } = resolveQaSession({ config });
```

- The ledger is always written under **`temp/qa/<sessionId>.ndjson`**
  (`<tempRoot>/qa/`, resolved from `project.paths.tempRoot`). It is one
  `QaLedgerItem` per line (ndjson). **Never** write the ledger anywhere else,
  and never commit it — `temp/` is gitignored per
  [`.agents/instructions.md` § 6](../instructions.md).
- When `reused` is `true`, a prior session of the same id exists: **append**,
  never overwrite, and carry the `untriaged` items forward as the rolling
  backlog (resume safety). Pass `--session-id <id>` (or `QA_SESSION_ID`) to
  resume a named session.

## Bounded per-surface session

A `/qa-explore` run is a **single bounded session over one named surface**, not
an open-ended sweep:

- **One surface.** The session explores exactly the `surface` argument. Driving
  the named surface may legitimately touch sub-surfaces reachable from it
  navigation-first, but the session does not pivot to a different top-level
  surface — that is a new session.
- **Bounded by the operator's gate.** Capture continues until the operator says
  exploration is complete (the Capture → Triage gate), not until the agent has
  exhausted the app. The agent proposes when it believes the surface is
  covered; the operator decides.
- **Resumable, not unbounded.** A reused session appends to the same ledger and
  carries its untriaged backlog forward; it does not widen the surface.

## Phase gates (HITL)

Every phase transition is gated on **explicit operator confirmation**. Do not
advance Plan → Capture, or Capture → Triage, until the operator says so. State
each gate as a question, present the artifact (the plan with its chosen driving
method, then the captured ledger), and wait. This is a HITL workflow — the
agent drives and captures, but it never files tickets, promotes findings, or
advances phases autonomously. If the operator does not confirm, stop and hold.

---

## Phase 1 — Plan

Goal: agree on **what** will be explored and **how the agent will drive it**
before touching the surface.

1. Re-read the `qa-engineer` persona and the
   [`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md)
   skill, and resolve the `qa` contract and session (above).
2. **Choose the driving method explicitly** for the named `surface`:
   - **Drive (default):** the live runtime is reachable, so the agent will
     drive it through the browser MCP, navigation-first (start at a root, reach
     the surface via UI affordances, never URL-jump).
   - **Static (documented interim):** the live runtime is *not* reachable —
     most commonly because authenticated driving needs consumer persona-seeding
     infrastructure that does not exist — so the agent will walk the surface
     from source, routes, and rendered markup. This is a deliberate Plan-time
     decision with a recorded reason, never a silent fallback when the browser
     MCP hiccups.

   Record the chosen method and reason on the ledger (e.g.
   `method: static, reason: no reachable authenticated runtime`).
3. Draft an **exploration plan** for the named `surface`:
   - the sub-surfaces / flows / states the agent intends to drive,
   - the classes of signal it is hunting (product bug, environment-setup,
     tooling-dx, test-gap, enhancement — the
     [ledger `class` enum](../schemas/qa-ledger.schema.json)),
   - the chosen driving method and its rationale,
   - any rolling backlog (`untriaged`) carried forward from a resumed session.
4. Present the plan, the chosen driving method, and the resolved `ledgerPath`
   (under `temp/qa/`) to the operator.
5. **Gate:** ask the operator to confirm the plan and the driving method (or
   amend the surface/scope/method). Do **not** proceed to Capture until they
   confirm.

---

## Phase 2 — Capture (agent drives, READ-ONLY)

Goal: **the agent drives the confirmed surface itself** and records its
observations. **This phase is strictly read-only.**

> **Read-only invariant.** The agent observes; it never mutates. Per
> [`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md)
> § 3 (inviolable per
> [`security-baseline.md`](../rules/security-baseline.md)), do **not** edit
> source, run write commands, file or label GitHub issues, change tickets,
> submit destructive forms, or alter the product under test. The only write
> Capture performs is **appending ledger lines to
> `temp/qa/<sessionId>.ndjson`** — session scratch, not a repository or product
> mutation. Any action that would change state belongs in Triage (and only
> after the operator confirms). When a surface's only path forward is a
> mutating action, record the boundary as the finding and stop — do not cross
> it.

**Drive the surface using the method chosen in Plan:**

- **Drive (default):** reach the surface navigation-first through the browser
  MCP — start at a root, click the affordances a real user would, and observe
  the rendered state, console, and network signal. Never URL-jump to establish
  a starting state; a broken affordance, nav 404, or guard redirect loop is
  itself a **finding**, not a workaround. Never enter real credentials to reach
  an authenticated surface and never fabricate a session — drive only the
  unauthenticated surface (or capture the authenticated surface statically) and
  record the persona-seeding gap.
- **Static (documented interim):** walk the surface from source, route
  definitions, and rendered markup. Treat its coverage as partial and say so in
  the ledger — a static pass does not close the same coverage a driven pass
  would.

For each observation the agent makes while driving:

1. **Redact first.** Before any evidence string touches disk, scrub it through
   [`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js):

   ```js
   import { redactEvidence } from '../scripts/lib/qa/redact-evidence.js';
   const evidence = redactEvidence(rawObservation);
   ```

   This is mandatory per [`security-baseline.md`](../rules/security-baseline.md)
   (§ Data Leakage & Logging, § Secrets Management) — bearer tokens, session
   cookies, Authorization headers, and emails are masked. The pass is
   idempotent, so redact eagerly; captured console and network evidence is
   untrusted until scrubbed.

2. **Compute the coverage verdict** for the surface the observation points at,
   via [`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js) — the
   deterministic seam behind the
   [`core/qa-coverage-mapping`](../skills/core/qa-coverage-mapping/SKILL.md)
   skill. Read that skill for how to assemble the `surface` input (symbol +
   the unit/contract/acceptance tests around it) and how to read the per-tier
   `{present|absent}` verdict.

3. **Propose the missing test** (if any) from that verdict, via
   [`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js). It
   names the lowest absent tier (the cheapest gap the signal leaked through),
   or returns `null` when every tier is covered. Record the proposal's
   `description` as the ledger item's `missingTest` (or `null`).

4. **Append a `QaLedgerItem`** to `temp/qa/<sessionId>.ndjson`, conforming to
   [`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json): a stable
   `id` (`L1`, `L2`, … in capture order), the redacted `evidence`, the
   `coverage` label (the `surface`, or `unknown`), a tentative `class` and
   `severity`, the `missingTest`, and `disposition` left untriaged for now.

5. Continue driving until the agent believes the surface is covered, then
   propose that exploration is complete.

6. **Gate:** present the captured ledger (item count, classes, the driving
   method used, the rolling backlog) and ask the operator to confirm moving to
   Triage. Do **not** triage until they confirm.

---

## Phase 3 — Triage

Goal: turn the captured ledger into routed, classified, dedup'd dispositions —
with the operator deciding each `file` / `defer` / `dismiss`.

For each untriaged ledger item:

1. **Classify** it via
   [`classify-finding.js`](../scripts/lib/findings/classify-finding.js). The
   item's `class` resolves to the focus/meta label set Triage applies when
   promoting it (`tooling-dx` carries `meta::framework-gap`; `enhancement`
   carries `meta::consumer-improvement`). The helper **throws** on an
   absent/unknown class — fix the ledger item's class rather than defaulting.

2. **Dedup / route** it against existing GitHub Issues via
   [`route-finding.js`](../scripts/lib/findings/route-finding.js):

   ```js
   import { routeFinding, fingerprintFooter } from '../scripts/lib/findings/route-finding.js';
   const { decision, matchedIssue, fingerprint } =
     await routeFinding(finding, { searchIssues });
   ```

   `decision` is one of `new` / `update-existing` / `duplicate` /
   `regression-of-closed`. This is the **single** dedup implementation shared
   with `/qa-assist` and `audit-to-stories`; stamp the `fingerprintFooter(sha)`
   marker into any Issue body so future runs dedup against it. Wire the
   `searchIssues` port to the GitHub provider (querying both open and closed
   Issues).

3. **Decide the disposition** with the operator: `file` (promote through
   `/plan` — never a raw GitHub Issue), `defer` (carry forward to a later
   session as backlog), or `dismiss` (non-actionable). Record the chosen
   `disposition` back onto the ledger item.

4. **Promote the `file`-dispositioned findings through `/plan`** via
   [`promote-finding.js`](../scripts/lib/findings/promote-finding.js) — the
   same cluster/size/route/file path `/qa-assist` and `/audit-to-stories`
   consume. Never hand-roll the clustering, sizing, or promotion in prose:

   ```js
   import { promoteFindings } from '../scripts/lib/findings/promote-finding.js';
   const { promotions } = await promoteFindings(ledgerItems, {
     searchIssues, // GitHub provider, open + closed
     createStory, // tight cluster (≤2 surfaces): render seed → /plan --from-notes
     createEpic, // broad cluster (>2 surfaces): render seed → /plan --idea
   });
   ```

   - **Sizing is delegated, not decided in prose.** `promoteFindings` runs
     `clusterLedgerItems` + `targetForCluster`: a cluster spanning **≤2**
     distinct coverage surfaces routes to `createStory`; **>2** routes to
     `createEpic`. The workflow introduces no new sizing, clustering, or dedup
     logic — `route-finding.js` / `promote-finding.js` remain the single
     implementation.
   - **`createStory` (`/plan --from-notes`)** — render a **redacted**
     `--from-notes` seed from the cluster (reuse the `/audit-to-stories`
     Phase 5b notes shape; redaction already ran in Capture), **stamp the
     cluster's `fingerprintFooter(sha)` verbatim into the seed body**, then
     chain `/plan --from-notes <seed>`. The footer must survive into the issue
     body the Story create path writes — it round-trips through
     `story-plan.js --body <file> --dry-run` unchanged (asserted by the
     deterministic round-trip test under `tests/`) so a later `routeFinding`
     dedups the same finding instead of re-filing it.
   - **`createEpic` (`/plan --idea`)** — carry the cluster's
     `fingerprintFooter(sha)` into the `/plan --idea` seed, then chain
     `/plan --idea <seed>`. **Known limitation (not solved here):**
     per-child-Story fingerprint propagation through full Epic decomposition is
     *not* guaranteed — the fingerprint is carried in the Epic seed only; the
     child Stories `/plan` spawns from that seed are not individually
     footer-stamped.
   - **A `file` disposition never opens a raw GitHub Issue.** Every `file`
     finding flows through `promoteFindings` → `/plan`; only `defer` and
     `dismiss` skip the `/plan` handoff.

5. **Gate:** any ticket-filing, seed write, `/plan` invocation, or label
   mutation is a write — confirm each one with the operator before it happens.
   Capture stayed read-only precisely so that every state change lands here,
   deliberately and confirmed. The plan→deliver hard stop is preserved: each
   `/plan` chain pauses at its own HITL gates and never auto-delivers.

After triage, write the updated dispositions back to the ledger (still under
`temp/qa/`), and summarize: items captured, the driving method used, classes,
routes (`new`/`update-existing`/`duplicate`/`regression-of-closed`), the
Stories (`/plan --from-notes`) and Epics (`/plan --idea`) promoted, and the
deferred rolling backlog that a resumed session will pick up.

---

## Constraints

- **Agent-led, bounded per surface.** The agent drives one named surface per
  session and proposes when it is covered; the operator gates the boundary.
  Human-driven single-observation capture lives in
  [`/qa-assist`](qa-assist.md) — no human-driven flow lives here.
- **Pick the driving method at Plan time.** Drive (browser MCP,
  navigation-first) is the default; static is the documented interim, chosen
  explicitly with a recorded reason, never a silent fallback. Do not switch
  methods mid-surface without a new Plan note. See
  [`stack/qa/qa-explore-driving`](../skills/stack/qa/qa-explore-driving/SKILL.md).
- **Capture is read-only.** The only Capture write is appending ledger lines
  under `temp/qa/`. No source edits, no ticket mutations, no product writes,
  no destructive form submissions. Never enter real credentials or fabricate a
  session; record the persona-seeding gap instead.
- **Broken navigation is a finding, not a workaround.** Never URL-jump around a
  missing affordance, a nav 404, or a guard redirect loop — record it and move
  on.
- **Every phase transition is operator-gated.** Plan → Capture and
  Capture → Triage each require explicit confirmation. Never advance, file a
  ticket, or mutate a label autonomously.
- **The ledger lives under `temp/qa/` only**, one `QaLedgerItem` per ndjson
  line, conforming to [`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json).
  Never commit it.
- **Redact before persist.** Every evidence string passes through
  [`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js) before it
  reaches disk or GitHub, per [`security-baseline.md`](../rules/security-baseline.md).
- **Delegate decisions to the helpers.** Coverage verdict
  ([`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js)),
  missing-test ([`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js)),
  classification ([`classify-finding.js`](../scripts/lib/findings/classify-finding.js)),
  dedup/route ([`route-finding.js`](../scripts/lib/findings/route-finding.js)),
  and cluster/size/promote
  ([`promote-finding.js`](../scripts/lib/findings/promote-finding.js)) are
  deterministic — never re-derive them in prose.
- **Promote through `/plan`, never a raw Issue.** A `file`-dispositioned
  finding is promoted via `promoteFindings`, which chains into
  [`/plan`](plan.md) (`--from-notes` for a tight cluster, `--idea` for a broad
  one) — mirroring [`/audit-to-stories`](audit-to-stories.md). `/qa-explore`
  never opens a bare GitHub Issue for a `file` finding. The cluster's
  `fingerprintFooter(sha)` is stamped verbatim into the seed so a future
  `routeFinding` dedups it.
- **Resume safely.** A reused session appends and carries the un-triaged
  backlog forward via [`qa-session.js`](../scripts/lib/qa/qa-session.js); it
  never overwrites a prior ledger.

## See also

- [`/plan`](plan.md) — the planning pipeline `/qa-explore` Triage chains into
  for a `file`-dispositioned finding (`--from-notes` for a Story, `--idea` for
  an Epic). The plan→deliver hard stop is preserved across the handoff.
- [`/qa-assist`](qa-assist.md) — the human-led sibling that enriches a single
  operator observation and triages through the same `/plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for the
  findings → `/plan` handoff and the shared fingerprint-footer dedup contract.
- [`promote-finding.js`](../scripts/lib/findings/promote-finding.js) /
  [`route-finding.js`](../scripts/lib/findings/route-finding.js) — the shared
  cluster/size/promote and dedup/route/fingerprint-footer helpers. There is no
  second clustering, sizing, or dedup implementation.
