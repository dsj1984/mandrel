---
description: Human-led QA assist loop — set up, then ride a rolling multi-observation intake session. The operator reports observations in any order; the agent enriches each (repro + root-cause file:line + coverage verdict for bugs; analysis + options + recommendation for enhancements), asks clarifying questions only when ambiguous, and appends a redacted ledger item — recording, never planning — to a persistent, resumable session under temp/qa/. Only when the operator says they are done does it review the full ledger and hand off to /plan.
---

# /qa-assist

Drive a **human-led, rolling QA-assist session**. The operator tests; the
agent rides alongside as the QA engineer and captures what they see into a
high-quality, triage-ready ledger. The session has four movements:

1. **Setup & Ready** (Phase 0) — load codebase context, resolve the contract,
   open (or resume) the rolling ledger, then tell the operator what it will do
   and that it is **ready for observations**.
2. **Rolling intake** (Phases 1–3, looped) — the operator reports observations
   **in any order and any quantity**: one at a time, or a **brain dump** of many
   at once in a single message. The agent splits a multi-observation message
   into discrete items and runs each through **Intake → Enrich → Record**, then
   **loops straight back** to wait for more. It **records and enriches only — it
   never plans or fixes during intake.**
3. **Done** — when the operator says they have finished testing, the agent does
   a final review of the **entire** ledger and asks any last clarifying
   questions.
4. **Triage & Plan** (Phase 4) — only then does the agent route the full ledger
   into [`/plan`](plan.md) to generate Epics and/or Stories.

Unlike [`/qa-explore`](qa-explore.md) (where the *agent* drives open-ended
exploration of a named surface), `/qa-assist` is **human-led**: the human owns
the signal, the agent owns the enrichment. It is the front door for "I'm
testing — ride along and capture everything well." Each observation is recorded
as a `QaLedgerItem` against the
[`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json) contract — the same
ledger `/qa-explore` and the triage/promotion path consume — so a `/qa-assist`
item flows through the identical dedup, classification, and promotion machinery
in Phase 4.

This is a **prose workflow**, not a Node orchestrator: the host LLM executes
the procedure; deterministic Node helpers under `.agents/scripts/lib/qa/` and
`.agents/scripts/lib/findings/` do the contract resolution, session/ledger
resolution, context hydration, redaction, coverage verdict, classification,
dedup/route, and promotion. **The agent consumes the shared core helpers; it
never reimplements those decisions in prose.**

> **When to run**: a developer or operator is about to test (or is mid-test) and
> wants every bug and enhancement idea captured as a high-quality,
> triage-ready finding without breaking stride — then, when the testing pass is
> done, turned into a plan in one batch.
>
> **Persona**: `qa-engineer` · **Skills**: `core/qa-coverage-mapping`

## Persona

Adopt the **`qa-engineer`** persona
([`.agents/personas/qa-engineer.md`](../personas/qa-engineer.md)) for the whole
run. You are the quality gatekeeper: you value coverage, hermetic
environments, deterministic results, and — per that persona's Golden Rule —
you **never invent the signal**. The human owns what was observed; you enrich
it. Re-read that persona file as your first action.

## Slash Command

```text
/qa-assist [observation]
```

### Arguments

| Name          | Required | Shape / Example                                   | Notes                                                                                                                                  |
| ------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `observation` | no       | `"sync-commands wipes .claude on a reused name"` | An optional first observation, or a brain dump of several. **Usually omitted** — the normal launch is a bare `/qa-assist`, which does Setup and then waits. If supplied, run Setup first, then feed it in as the first intake (splitting it if it carries multiple observations). |

A bare `/qa-assist` is the expected entry point. **Do not** demand an
observation up front and **do not** synthesize one — the `qa-engineer` Golden
Rule forbids inventing the signal. Set up, announce ready, and wait.

## Project contract

Resolve the consumer's `qa` contract during Setup, via
[`resolve-qa-contract.js`](../scripts/lib/qa/resolve-qa-contract.js):

```js
import { resolveQaContract } from '../scripts/lib/qa/resolve-qa-contract.js';
const contract = resolveQaContract(config); // throws loudly if unbound
```

The resolver fails **loudly** when the project has not bound the QA harness
(no `qa` block in `.agentrc.json`) — there is no silent fallback. If it throws
the "this project has not bound the QA harness" message, surface that verbatim
to the operator and stop; do not pretend a contract exists.

## Session & ledger (temp/qa/) — persistent, resumable, rolling

`/qa-assist` **defaults to a persistent rolling session**: the same session is
resumed across invocations so an operator can top up the same ledger across a
working day or a multi-launch testing pass. Resolve the session and its ledger
path **once**, during Setup, via
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
  never overwrite, and surface the carried `untriaged` items as the rolling
  backlog so the operator sees what is still open. Pass `--session-id <id>`
  (or `QA_SESSION_ID`) to resume or fork a named session. A `/qa-assist` run is
  additive to the prior ledger by default — this is the resumable rolling
  session contract.

## Phase gates (HITL)

This is a HITL workflow, but the gating is deliberately **light during intake
and firm at the boundary**, so the rolling loop stays fluid:

- **Within a single observation, Intake → Enrich → Record is fluid.** The agent
  restates, enriches, and appends the ledger item without a ceremony, pausing
  only to **ask clarifying questions when the observation is ambiguous**. After
  each append it **echoes the recorded item** so the operator can correct it,
  then **loops back to wait for the next observation**. The agent does **not**
  triage, route, file tickets, or invoke `/plan` during intake.
- **Two things always require explicit operator confirmation.** First, the
  session-level transition from rolling intake into **Phase 4 — Triage & Plan**
  — the agent never starts planning on its own; the operator must say they are
  done. Second, **every write that leaves the local ledger** — filing a ticket,
  invoking `/plan`, or mutating a label. Present the artifact, ask, and wait. If
  the operator does not confirm, hold.

In short: appending to the rolling ledger is the natural product of intake and
needs no gate beyond the echo-back; **planning and anything that leaves the
ledger is hard-gated.**

---

## Phase 0 — Setup & Ready

Goal: become the operator's QA assistant before any observation arrives.

1. Re-read the `qa-engineer` persona.
2. **Load codebase context.** Read the files in `project.docsContextFiles`
   (architecture, decisions, patterns) and, when the testing touches UI/routing,
   `docs/style-guide.md` / `docs/web-routes.md`. This is the context you will
   draw on to enrich observations without guessing.
3. **Resolve the `qa` contract and the rolling session** (above). Compute the
   ledger path and load any carried `untriaged` backlog.
4. **Announce readiness.** Tell the operator, in one short message:
   - which session this is (new vs. resumed) and how many items are already on
     the ledger;
   - what you will do with each observation (enrich bugs with repro +
     root-cause `file:line` + coverage; enrich enhancements with analysis +
     options + a recommendation) and that you will **record only, not plan**;
   - that you are **ready for observations, in any order**, and that they
     should tell you when they are **done testing** to move into triage/planning.
5. **Wait.** Do not invent an observation. If `/qa-assist` was launched with an
   `observation` argument, treat it as the first intake and proceed to Phase 1;
   otherwise wait for the operator's first report.

---

## Phase 1 — Intake (per observation, looped)

Goal: understand **exactly what the human observed** before enriching it. The
operator's message may carry **one observation or a brain dump of many**; this
phase first splits the message into discrete observations, then runs Intake for
**each** of them, before returning here for the next message.

1. **Split a brain dump into discrete observations.** Parse the operator's
   message into the distinct things they observed — one ledger item per
   distinct symptom, surface, or idea. Use their own structure (numbered or
   bulleted list, blank-line-separated paragraphs, "and another thing…") as the
   split boundary; do **not** merge two unrelated symptoms into one item or
   split a single symptom into several. **Echo the parsed list back** ("I read
   N observations: …") and let the operator correct the split before you
   enrich anything — this is the only confirmation intake requires. A
   single-observation message is just the N = 1 case; skip the echo when it is
   unambiguously one item.
2. **Process each observation in turn** through the rest of this phase and
   Phases 2–3. For each one:
   - **Restate the observation** in your own words — the surface it touches, the
     action taken, the actual result, and (for a bug) the expected result, or
     (for an enhancement) the desired improvement. This restatement is your read
     of the signal.
   - **Ask clarifying questions only when that observation is ambiguous.** If
     you cannot confidently fill in the load-bearing facts, **ask** — do not
     paper over the gap with an assumption. Typical gaps: which
     surface/command/flow; the exact steps and whether it reproduces or is
     intermittent; what was expected and why that is the contract; the
     environment (OS, shell, branch, fresh vs. reused state). When the
     observation is already clear, **do not interrogate** — move straight to
     Enrich. Batch the questions across the brain dump into one message rather
     than interrogating item-by-item, so the operator answers them all at once.

---

## Phase 2 — Enrich (per observation)

Goal: turn the observation into a high-quality, triage-ready finding. Delegate
every decision to the shared core helpers; never re-derive them in prose.

1. **Redact first.** Before any evidence string touches disk or GitHub, scrub
   it through [`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js):

   ```js
   import { redactEvidence } from '../scripts/lib/qa/redact-evidence.js';
   const evidence = redactEvidence(rawObservation);
   ```

   This is mandatory per [`security-baseline.md`](../rules/security-baseline.md)
   (§ Data Leakage & Logging, § Secrets Management) — bearer tokens, session
   cookies, and emails are masked. The pass is idempotent, so redact eagerly.

2. **Branch on what kind of observation it is.**
   - **Bug.** Establish a clean, minimal, deterministic **repro**. Investigate
     the **root cause**: read the relevant code, console output, and logs for
     errors, and pin the locus as a concrete **`file:line`** reference (say so
     explicitly if you cannot pin it rather than inventing a locus). Then run
     the coverage steps below.
   - **Enhancement / suggestion.** Analyze **how** the change would be made:
     the surfaces it touches, the **options** for implementing it, and a brief
     **recommendation** with trade-offs. Record these notes on the ledger item.
     Still pin the relevant `file:line` anchor(s) where the change would land.

3. **Hydrate the QA context** to locate code precisely, via
   [`qa-context-hydrator.js`](../scripts/lib/qa/qa-context-hydrator.js) — it
   resolves the Epic (whose body carries the planning sections), the
   feature-file set, the surface
   map, and recent git log:

   ```js
   import { hydrateQaContext } from '../scripts/lib/qa/qa-context-hydrator.js';
   const context = await hydrateQaContext({ epicNumber, githubPort, gitPort, surfaceMap });
   ```

4. **Compute the coverage verdict** for the surface the observation points at,
   via [`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js) — the
   deterministic seam behind the
   [`core/qa-coverage-mapping`](../skills/core/qa-coverage-mapping/SKILL.md)
   skill. Read that skill for how to assemble the `surface` input and how to
   read the per-tier `{present|absent}` verdict. Optionally render a
   human-readable summary via
   [`coverage-report.js`](../scripts/lib/qa/coverage-report.js).

5. **Propose the missing test** (if any) from that verdict, via
   [`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js). It
   names the lowest absent tier, or returns `null` when every tier is covered.
   Record the proposal's `description` as the ledger item's `missingTest`.

6. **Classify** the finding via
   [`classify-finding.js`](../scripts/lib/findings/classify-finding.js) so the
   tentative `class` resolves to the correct focus/meta label set
   (`tooling-dx` carries `meta::framework-gap`; `enhancement` carries
   `meta::consumer-improvement`). The helper **throws** on an absent/unknown
   class — fix the finding's class rather than defaulting.

---

## Phase 3 — Record (per observation), then loop

Goal: persist the enriched finding to the rolling ledger and **return to
intake**. **No triage, routing, ticket-filing, or `/plan` happens here** — that
is Phase 4, and only after the operator says they are done.

1. **Append a `QaLedgerItem`** to `temp/qa/<sessionId>.ndjson`, conforming to
   [`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json): a stable `id`
   (`L1`, `L2`, … appended after any carried backlog), the redacted `evidence`,
   the repro and root-cause `file:line` notes (or the enhancement
   analysis/options/recommendation), the `coverage` label, the `class` and
   `severity`, the `missingTest`, and a `disposition` of **untriaged** (intake
   does not decide disposition — Phase 4 does).
2. **Echo the recorded item** back in one short line — its `class`, `severity`,
   root-cause locus or recommendation, and coverage verdict — so the operator
   can correct it on the spot. When a brain dump produced several items, append
   them all, then echo a **compact batch summary** (one line per new `Lx` item)
   instead of a separate message per item.
3. **Loop back to Phase 1** and wait for the next message. Keep doing this for
   as many observations as the operator reports — one at a time or in batches,
   in any order — until they say they are done testing.

---

## Phase 4 — Triage & Plan (on "I'm done")

Goal: when the operator says they have finished testing, turn the **whole**
ledger into a plan. This is the only phase that triages, routes, or plans, and
its transition is **explicitly operator-gated**.

1. **Final ledger review.** Read the entire rolling ledger back to the
   operator: every item, its class/severity, root-cause or recommendation, and
   coverage verdict. Confirm it is complete and ask any **last clarifying
   questions** — missing repro, an item that should be split or merged, a
   severity to adjust. Let the operator set each item's disposition
   (`file` / `defer` / `dismiss`).

2. **Dedup / route** each `file`-dispositioned finding against existing GitHub
   Issues via [`route-finding.js`](../scripts/lib/findings/route-finding.js)
   (the **single** dedup implementation shared with `/qa-explore` and
   `audit-to-stories`), backed by
   [`semantic-issue-search.js`](../scripts/lib/findings/semantic-issue-search.js):

   ```js
   import { routeFinding, fingerprintFooter } from '../scripts/lib/findings/route-finding.js';
   const { decision, matchedIssue, fingerprint } =
     await routeFinding(finding, { searchIssues });
   ```

   `decision` is one of `new` / `update-existing` / `duplicate` /
   `regression-of-closed`. Stamp the `fingerprintFooter(sha)` marker into any
   Issue body so future runs dedup against it.

3. **Promote the full ledger through `/plan`** (never a raw GitHub Issue) via
   [`promote-finding.js`](../scripts/lib/findings/promote-finding.js), which
   clusters, sizes, routes, and files through the same ports `/qa-explore` and
   `/audit-to-stories` consume — never hand-roll the promotion, the clustering,
   or the sizing:

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
     `createEpic`. Do not re-cluster, re-size, or re-dedup in the workflow —
     [`route-finding.js`](../scripts/lib/findings/route-finding.js) /
     [`promote-finding.js`](../scripts/lib/findings/promote-finding.js) are the
     single implementation.
   - **`createStory` (`/plan --from-notes`)** — render a **redacted**
     `--from-notes` seed from the cluster (reuse the `/audit-to-stories`
     Phase 5b notes shape; redaction already ran in Phase 2), **stamp the
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
     *not* guaranteed — the fingerprint is carried in the Epic seed only.
   - **A `file` disposition never opens a raw GitHub Issue.** Every `file`
     finding flows through `promoteFindings` → `/plan`; only `defer` (carry
     forward as backlog) and `dismiss` (non-actionable) skip the handoff.

4. **Gate:** the move into this phase, and every write inside it (seed write,
   `/plan` invocation, ticket-filing, label mutation), is **operator-gated** —
   confirm each one. The plan→deliver hard stop is preserved: each `/plan`
   chain pauses at its own HITL gates and never auto-delivers. Redaction has
   already run, so nothing unredacted reaches disk or GitHub.

After planning, summarize: the findings recorded, the route/promotion decisions
(`new`/`update-existing`/`duplicate`/`regression-of-closed`), whether each
cluster became a Story (`/plan --from-notes`) or Epic (`/plan --idea`), and any
`defer` backlog a resumed session will pick up.

---

## Constraints

- **Human-led, rolling, multi-observation.** The operator owns the signal and
  reports observations in any order and any quantity — one at a time or a brain
  dump of many in a single message. The agent splits a brain dump into discrete
  ledger items (echoing the split for correction), then enriches and records
  each one. Never invent an observation; **ask clarifying questions** only when
  an observation is ambiguous, batched across the dump.
- **Record during intake; plan only on "done".** Phases 1–3 enrich and append
  to the ledger and loop — they never triage, route, file tickets, or invoke
  `/plan`. All of that is **Phase 4**, entered only after explicit operator
  confirmation that testing is done.
- **Light intake gate, firm boundary gate.** Intake → Enrich → Record is fluid
  (echo-back, no ceremony); the session-level move into Phase 4 and **every
  write** that leaves the local ledger (ticket, `/plan`, label) require
  **explicit operator confirmation**.
- **Persistent, resumable rolling session.** `/qa-assist` defaults to resuming
  the same session and **appending** to its ledger; a reused session carries
  the un-triaged backlog forward via
  [`qa-session.js`](../scripts/lib/qa/qa-session.js) and never overwrites a
  prior ledger.
- **The ledger lives under `temp/qa/` only**, one `QaLedgerItem` per ndjson
  line, conforming to [`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json).
  Never commit it.
- **Redact before persist.** Every evidence string passes through
  [`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js) before it
  reaches disk or GitHub, per [`security-baseline.md`](../rules/security-baseline.md).
- **Consume the shared core; never reimplement.** Context hydration
  ([`qa-context-hydrator.js`](../scripts/lib/qa/qa-context-hydrator.js)),
  coverage verdict ([`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js)),
  coverage report ([`coverage-report.js`](../scripts/lib/qa/coverage-report.js)),
  missing-test ([`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js)),
  classification ([`classify-finding.js`](../scripts/lib/findings/classify-finding.js)),
  dedup/route ([`route-finding.js`](../scripts/lib/findings/route-finding.js)),
  semantic search ([`semantic-issue-search.js`](../scripts/lib/findings/semantic-issue-search.js)),
  promotion ([`promote-finding.js`](../scripts/lib/findings/promote-finding.js)),
  and session resolution ([`qa-session.js`](../scripts/lib/qa/qa-session.js))
  are deterministic — never re-derive them in prose.
- **Promote through `/plan`, never a raw Issue.** A `file`-dispositioned
  finding is promoted via `promoteFindings`, which chains into
  [`/plan`](plan.md) (`--from-notes` for a tight cluster, `--idea` for a broad
  one) — mirroring [`/audit-to-stories`](audit-to-stories.md). `/qa-assist`
  never opens a bare GitHub Issue for a `file` finding. The cluster's
  `fingerprintFooter(sha)` is stamped verbatim into the seed so a future
  `routeFinding` dedups it.

## See also

- [`/plan`](plan.md) — the planning pipeline `/qa-assist` chains into in
  Phase 4 (`--from-notes` for a Story, `--idea` for an Epic). The plan→deliver
  hard stop is preserved across the handoff.
- [`/qa-explore`](qa-explore.md) — the agent-led sibling that drives a named
  surface and triages through the same `/plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for the
  findings → `/plan` handoff and the shared fingerprint-footer dedup contract.
- [`promote-finding.js`](../scripts/lib/findings/promote-finding.js) /
  [`route-finding.js`](../scripts/lib/findings/route-finding.js) — the shared
  cluster/size/promote and dedup/route/fingerprint-footer helpers. There is no
  second clustering, sizing, or dedup implementation.
