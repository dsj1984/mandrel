---
description: Operator-facing exploratory-QA loop — Plan, read-only Capture, then Triage — that wires the dedup, coverage, classification, missing-test, redaction, and session helpers into a HITL session ledger under temp/qa/
---

# /qa-explore

Drive an **exploratory-QA session** as a human-in-the-loop (HITL) loop:
**Plan → Capture → Triage**. The operator names a surface to explore; the
agent (acting as the QA engineer) explores it, records each observation as a
structured ledger item, and — only after explicit operator confirmation —
triages the ledger into routed, classified, dedup'd follow-up dispositions.

Unlike [`/qa-run-harness`](qa-run-harness.md) (which steps a known set of
Gherkin `.feature` scenarios through a browser), `/qa-explore` is
**open-ended exploration**: the surface is probed for product bugs,
environment-setup friction, tooling/DX gaps, missing tests, and enhancement
ideas — each captured as a `QaLedgerItem` against the
[`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json) contract.

This is a **prose workflow**, not a Node orchestrator: the host LLM executes
the procedure; deterministic Node helpers under `.agents/scripts/lib/qa/` and
`.agents/scripts/lib/findings/` do the contract resolution, session/ledger
resolution, redaction, coverage verdict, missing-test proposal, classification,
and dedup/route decisions. The agent never invents those decisions in prose.

> **When to run**: ad-hoc exploration of a freshly delivered Story or Feature,
> a regression sweep over a risky surface before `/epic-deliver`, or a
> structured bug-hunt the operator wants captured into a triageable ledger.
>
> **Persona**: `qa-engineer` · **Skills**: `core/qa-coverage-mapping`

## Persona

Adopt the **`qa-engineer`** persona
([`.agents/personas/qa-engineer.md`](../personas/qa-engineer.md)) for the whole
run. You are the quality gatekeeper: you value coverage, hermetic
environments, and deterministic results. Re-read that persona file as your
first action so the Plan/Capture/Triage loop is governed by it.

## Slash Command

```text
/qa-explore <surface>
```

### Arguments

| Name      | Required | Shape / Example                    | Notes                                                                                  |
| --------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `surface` | yes      | `feature:login`, `area:onboarding` | A human label for the surface to explore. Recorded as each ledger item's `coverage`. |

If no `surface` is supplied, **stop and ask** the operator to name one — the
`qa-engineer` Golden Rule forbids inventing scope.

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
  backlog (f5-safety resume). Pass `--session-id <id>` (or `QA_SESSION_ID`) to
  resume a named session.

## Phase gates (HITL)

Every phase transition is gated on **explicit operator confirmation**. Do not
advance Plan → Capture, or Capture → Triage, until the operator says so. State
each gate as a question, present the artifact (the plan, then the captured
ledger), and wait. This is a HITL workflow — the agent never files tickets or
advances phases autonomously. If the operator does not confirm, stop and hold.

---

## Phase 1 — Plan

Goal: agree on **what** will be explored before touching the surface.

1. Re-read the `qa-engineer` persona and resolve the `qa` contract and session
   (above).
2. Draft an **exploration plan** for the named `surface`:
   - the sub-surfaces / flows / states you intend to probe,
   - the classes of signal you are hunting (product bug, environment-setup,
     tooling-dx, test-gap, enhancement — the
     [ledger `class` enum](../schemas/qa-ledger.schema.json)),
   - any rolling backlog (`untriaged`) carried forward from a resumed session.
3. Present the plan and the resolved `ledgerPath` (under `temp/qa/`) to the
   operator.
4. **Gate:** ask the operator to confirm the plan (or amend the surface/scope).
   Do **not** proceed to Capture until they confirm.

---

## Phase 2 — Capture (READ-ONLY)

Goal: explore the confirmed surface and record observations. **This phase is
strictly read-only.**

> **Read-only invariant.** Capture observes; it never mutates. Do **not** edit
> source, run write commands, file or label GitHub issues, change tickets, or
> alter the product under test. The only write Capture performs is **appending
> ledger lines to `temp/qa/<sessionId>.ndjson`** — and that is session scratch,
> not a repository or product mutation. Any action that would change state
> belongs in Triage (and only after the operator confirms).

For each observation:

1. **Redact first.** Before any evidence string touches disk, scrub it through
   [`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js):

   ```js
   import { redactEvidence } from '../scripts/lib/qa/redact-evidence.js';
   const evidence = redactEvidence(rawObservation);
   ```

   This is mandatory per [`security-baseline.md`](../rules/security-baseline.md)
   (§ Data Leakage & Logging, § Secrets Management) — bearer tokens, session
   cookies, and emails are masked. The pass is idempotent, so redact eagerly.

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

5. Continue until the operator signals exploration is complete.

6. **Gate:** present the captured ledger (item count, classes, the rolling
   backlog) and ask the operator to confirm moving to Triage. Do **not** triage
   until they confirm.

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
   with `audit-to-stories`; stamp the `fingerprintFooter(sha)` marker into any
   Issue body so future runs dedup against it. Wire the `searchIssues` port to
   the GitHub provider (querying both open and closed Issues).

3. **Decide the disposition** with the operator: `file` (promote to a
   follow-up ticket with the classified labels + fingerprint footer), `defer`
   (carry forward to a later session as backlog), or `dismiss` (non-actionable).
   Record the chosen `disposition` back onto the ledger item.

4. **Gate:** any ticket-filing or label mutation is a write — confirm each one
   with the operator before it happens. Capture stayed read-only precisely so
   that every state change lands here, deliberately and confirmed.

After triage, write the updated dispositions back to the ledger (still under
`temp/qa/`), and summarize: items captured, classes, routes
(`new`/`update-existing`/`duplicate`/`regression-of-closed`), filed tickets,
and the deferred rolling backlog that a resumed session will pick up.

---

## Constraints

- **Capture is read-only.** The only Capture write is appending ledger lines
  under `temp/qa/`. No source edits, no ticket mutations, no product writes.
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
  and dedup/route ([`route-finding.js`](../scripts/lib/findings/route-finding.js))
  are deterministic — never re-derive them in prose.
- **Resume safely.** A reused session appends and carries the un-triaged
  backlog forward via [`qa-session.js`](../scripts/lib/qa/qa-session.js); it
  never overwrites a prior ledger.
