---
description: Human-led QA assist loop — ingest one operator observation, enrich it with repro + root-cause (file:line) + a coverage verdict, ask clarifying questions when it is ambiguous, and append a redacted ledger item to a persistent, resumable rolling session under temp/qa/
---

# /qa-assist

Drive a **human-led QA-assist session** as a human-in-the-loop (HITL) loop:
**Intake → Enrich → Record**. The operator reports a single observation (a
bug they hit, a flaky behavior, a "this feels off"); the agent (acting as the
QA engineer) enriches that observation into a structured, triage-ready ledger
item — a clean repro, a root-cause locus (`file:line`), and a coverage
verdict — **asking clarifying questions whenever the observation is
ambiguous**, and only after explicit operator confirmation appends it to a
**persistent, resumable rolling session** under `temp/qa/`.

Unlike [`/qa-explore`](qa-explore.md) (where the *agent* drives open-ended
exploration of a named surface and captures many observations), `/qa-assist`
is **human-led and single-observation-at-a-time**: the human owns the signal,
the agent owns the enrichment. It is the front door for "I just saw something
weird — help me capture it well." Each observation is recorded as a
`QaLedgerItem` against the
[`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json) contract, the same
ledger `/qa-explore` and the triage/promotion path consume — so a `/qa-assist`
item flows through the identical dedup, classification, and promotion machinery
later.

This is a **prose workflow**, not a Node orchestrator: the host LLM executes
the procedure; deterministic Node helpers under `.agents/scripts/lib/qa/` and
`.agents/scripts/lib/findings/` do the contract resolution, session/ledger
resolution, context hydration, redaction, coverage verdict, classification,
dedup/route, and promotion. **The agent consumes the shared core helpers; it
never reimplements those decisions in prose.**

> **When to run**: a developer or operator hits something mid-flight and wants
> it captured as a high-quality, triage-ready finding without breaking stride —
> a one-off bug report, a "is this even covered by a test?" question, or a
> rolling personal QA backlog they top up across a working session.
>
> **Persona**: `qa-engineer` · **Skills**: `core/qa-coverage-mapping`

## Persona

Adopt the **`qa-engineer`** persona
([`.agents/personas/qa-engineer.md`](../personas/qa-engineer.md)) for the whole
run. You are the quality gatekeeper: you value coverage, hermetic
environments, deterministic results, and — per that persona's Golden Rule —
you **never invent the signal**. The human owns what was observed; you enrich
it. Re-read that persona file as your first action so the
Intake/Enrich/Record loop is governed by it.

## Slash Command

```text
/qa-assist [observation]
```

### Arguments

| Name          | Required | Shape / Example                                   | Notes                                                                                          |
| ------------- | -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `observation` | no       | `"sync-commands wipes .claude on a reused name"` | The human observation to enrich. If omitted, **ask** the operator to describe what they saw. |

If no `observation` is supplied, **stop and ask** the operator to describe
what they observed — the `qa-engineer` Golden Rule forbids inventing the
signal. Do not synthesize an observation on the operator's behalf.

## Project contract

Resolve the consumer's `qa` contract before enriching, via
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

`/qa-assist` **defaults to a persistent rolling session**: the same session
is resumed across invocations so an operator can top up the same ledger over a
working day. Resolve the session and its ledger path **once**, up front, via
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
  (or `QA_SESSION_ID`) to resume or fork a named session. This is the
  resumable-rolling-session contract — a `/qa-assist` run is additive to the
  prior ledger by default.

## Phase gates (HITL)

Every phase transition **and every write** is gated on **explicit operator
confirmation**. Do not advance Intake → Enrich, or Enrich → Record, until the
operator says so. State each gate as a question, present the artifact (the
restated observation, then the enriched ledger item), and wait. This is a HITL
workflow — the agent never appends to the ledger, files a ticket, or advances
a phase autonomously. If the operator does not confirm, stop and hold.

---

## Phase 1 — Intake

Goal: understand **exactly what the human observed** before enriching it.
This phase is where ambiguity is resolved by **asking**, not guessing.

1. Re-read the `qa-engineer` persona and resolve the `qa` contract and session
   (above). Surface the rolling `untriaged` backlog so the operator knows what
   is already open in this session.
2. **Restate the observation** back to the operator in your own words — the
   surface it touches, the action taken, the actual result, and the expected
   result. This restatement is the agent's read of the signal.
3. **Ask clarifying questions when the observation is ambiguous.** If you
   cannot confidently fill in any of {surface, exact steps, actual result,
   expected result, environment} from what the operator gave you, **stop and
   ask** — do not paper over the gap with an assumption. Typical gaps:
   - Which surface / command / flow? (so the coverage verdict targets the
     right symbol)
   - What were the exact steps, and is it reproducible or intermittent?
   - What did you expect instead, and why is that the contract?
   - What environment (OS, shell, branch, fresh vs. reused state)?
4. **Gate:** present the restated observation and ask the operator to confirm
   it is accurate (or correct it). Do **not** proceed to Enrich until they
   confirm the restatement is faithful.

---

## Phase 2 — Enrich

Goal: turn the confirmed observation into a high-quality, triage-ready finding —
a clean repro, a root-cause locus, and a coverage verdict. Delegate every
decision to the shared core helpers.

1. **Redact first.** Before any evidence string touches disk or reaches
   GitHub, scrub it through
   [`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js):

   ```js
   import { redactEvidence } from '../scripts/lib/qa/redact-evidence.js';
   const evidence = redactEvidence(rawObservation);
   ```

   This is mandatory per [`security-baseline.md`](../rules/security-baseline.md)
   (§ Data Leakage & Logging, § Secrets Management) — bearer tokens, session
   cookies, and emails are masked. The pass is idempotent, so redact eagerly,
   before the repro and root-cause notes are written anywhere.

2. **Establish a clean repro.** From the confirmed steps, write the minimal
   deterministic reproduction. If the steps are still non-deterministic or
   incomplete, return to Intake and ask — a finding without a repro is not yet
   ready to record.

3. **Hydrate the QA context** to locate the root cause, via
   [`qa-context-hydrator.js`](../scripts/lib/qa/qa-context-hydrator.js). It
   resolves the Epic/Feature context tickets, the feature-file set, the
   surface map, and recent git log so you can name the **root-cause locus as
   `file:line`** rather than guessing:

   ```js
   import { hydrateQaContext } from '../scripts/lib/qa/qa-context-hydrator.js';
   const context = await hydrateQaContext({ epicNumber, githubPort, gitPort, surfaceMap });
   ```

   Record the root cause as a concrete `file:line` reference. If you cannot
   pin it, say so explicitly in the ledger item rather than inventing a locus.

4. **Compute the coverage verdict** for the surface the observation points at,
   via [`coverage-verdict.js`](../scripts/lib/qa/coverage-verdict.js) — the
   deterministic seam behind the
   [`core/qa-coverage-mapping`](../skills/core/qa-coverage-mapping/SKILL.md)
   skill. Read that skill for how to assemble the `surface` input (symbol +
   the unit/contract/acceptance tests around it) and how to read the per-tier
   `{present|absent}` verdict. Optionally render a human-readable coverage
   summary via [`coverage-report.js`](../scripts/lib/qa/coverage-report.js).

5. **Propose the missing test** (if any) from that verdict, via
   [`propose-missing-test.js`](../scripts/lib/qa/propose-missing-test.js). It
   names the lowest absent tier (the cheapest gap the signal leaked through),
   or returns `null` when every tier is covered. Record the proposal's
   `description` as the ledger item's `missingTest` (or `null`).

6. **Classify** the finding via
   [`classify-finding.js`](../scripts/lib/findings/classify-finding.js) so the
   tentative `class` resolves to the correct focus/meta label set
   (`tooling-dx` carries `meta::framework-gap`; `enhancement` carries
   `meta::consumer-improvement`). The helper **throws** on an absent/unknown
   class — fix the finding's class rather than defaulting.

7. **Gate:** present the enriched candidate `QaLedgerItem` (redacted evidence,
   repro, root-cause `file:line`, coverage verdict, `class`, `severity`,
   `missingTest`) and ask the operator to confirm it is accurate before any
   write. Do **not** append to the ledger until they confirm.

---

## Phase 3 — Record

Goal: persist the enriched, confirmed finding to the rolling session ledger —
and optionally route or promote it — with the operator deciding each write.

1. **Append a `QaLedgerItem`** to `temp/qa/<sessionId>.ndjson`, conforming to
   [`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json): a stable `id`
   (`L1`, `L2`, … appended after any carried backlog), the redacted
   `evidence`, the repro and root-cause `file:line` notes, the `coverage`
   label, the confirmed `class` and `severity`, the `missingTest`, and a
   `disposition` (default untriaged unless the operator decides now). This
   append is a **write** — confirm it at the Phase 2 → Record gate before it
   happens.

2. **Optionally dedup / route** the finding against existing GitHub Issues via
   [`route-finding.js`](../scripts/lib/findings/route-finding.js) (the
   **single** dedup implementation shared with `/qa-explore` and
   `audit-to-stories`), backed by
   [`semantic-issue-search.js`](../scripts/lib/findings/semantic-issue-search.js)
   for candidate recall:

   ```js
   import { routeFinding, fingerprintFooter } from '../scripts/lib/findings/route-finding.js';
   const { decision, matchedIssue, fingerprint } =
     await routeFinding(finding, { searchIssues });
   ```

   `decision` is one of `new` / `update-existing` / `duplicate` /
   `regression-of-closed`. Stamp the `fingerprintFooter(sha)` marker into any
   Issue body so future runs dedup against it.

3. **Promote `file`-dispositioned findings through `/plan`** (never a raw
   GitHub Issue) via
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
     *not* guaranteed — the fingerprint is carried in the Epic seed only; the
     child Stories `/plan` spawns from that seed are not individually
     footer-stamped.
   - **A `file` disposition never opens a raw GitHub Issue.** Every `file`
     finding flows through `promoteFindings` → `/plan`; only `defer` (carry
     forward as backlog) and `dismiss` (non-actionable) skip the `/plan`
     handoff.

4. **Gate:** any ledger append, seed write, `/plan` invocation, ticket-filing,
   or label mutation is a write — confirm **each one** with the operator before
   it happens. The plan→deliver hard stop is preserved: each `/plan` chain
   pauses at its own HITL gates and never auto-delivers. Redaction has already
   run, so nothing unredacted reaches disk or GitHub.

After recording, summarize: the finding recorded, its coverage verdict and
`missingTest`, any route/promotion decision
(`new`/`update-existing`/`duplicate`/`regression-of-closed`) and whether it was
promoted to a Story (`/plan --from-notes`) or Epic (`/plan --idea`), and the
rolling backlog a resumed session will pick up.

---

## Constraints

- **Human-led, single-observation.** The operator owns the signal; the agent
  enriches it. Never invent an observation; **ask clarifying questions** when
  the observation is ambiguous instead of assuming.
- **Every phase transition and every write is operator-gated.** Intake →
  Enrich, Enrich → Record, and each ledger append / ticket-filing / label
  mutation require explicit confirmation. Never advance, append, file a
  ticket, or mutate a label autonomously.
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

- [`/plan`](plan.md) — the planning pipeline `/qa-assist` chains into when an
  operator dispositions a finding `file` (`--from-notes` for a Story, `--idea`
  for an Epic). The plan→deliver hard stop is preserved across the handoff.
- [`/qa-explore`](qa-explore.md) — the agent-led sibling that drives a named
  surface and triages through the same `/plan` handoff.
- [`/audit-to-stories`](audit-to-stories.md) — the precedent for the
  findings → `/plan` handoff and the shared fingerprint-footer dedup contract.
- [`promote-finding.js`](../scripts/lib/findings/promote-finding.js) /
  [`route-finding.js`](../scripts/lib/findings/route-finding.js) — the shared
  cluster/size/promote and dedup/route/fingerprint-footer helpers. There is no
  second clustering, sizing, or dedup implementation.
