---
description: >-
  Helper — not a slash command. The shared core the three QA workflows
  (/qa-run, /qa-explore, /qa-assist) consume: contract resolution + loud
  failure, the session & ledger contract, redact-first, the QaLedgerItem shape,
  the triage procedure (classify → route → disposition → promote), and the HITL
  write gate. Each workflow states only its mode-specific phases plus a short
  Constraints delta and points here for everything else.
caller: qa-run.md, qa-explore.md, qa-assist.md
---

# helpers/qa-core — shared QA harness core

> **Not a slash command.** This file lives in `helpers/` and is not projected
> into the plugin command tree. It is consumed by reference from
> [`/qa-run`](../qa-run.md), [`/qa-explore`](../qa-explore.md), and
> [`/qa-assist`](../qa-assist.md) — it states each shared block **once** so the
> three workflows keep only their mode-specific phases and a Constraints delta.

All three QA workflows are **prose workflows**, not Node orchestrators: the
host LLM executes the procedure; deterministic Node helpers under
`.agents/scripts/lib/qa/` (contract, session, redaction, coverage, missing-test)
and `.agents/scripts/lib/findings/` (classification, dedup/route, cluster/size/
promote) own every decision. The agent never invents those decisions in prose.

## Contract resolution (fail loudly when absent)

Resolve the consumer's `qa` contract block **before any QA work**, through the
single seam [`resolve-qa-contract.js`](../../scripts/lib/qa/resolve-qa-contract.js):

```js
import { resolveQaContract } from '../scripts/lib/qa/resolve-qa-contract.js';
const contract = resolveQaContract(config); // throws loudly if unbound
```

`resolveQaContract` **throws** — there is no silent fallback to auto-detection
— when the `qa` block is absent (no `qa` key, or an empty `qa: {}`), malformed
(wrong-typed or unknown field, e.g. `qa.featureRoot must be a string`), or
missing a required field (it names the first one). The absent-block message
reads: _"qa: this project has not bound the QA harness — add a `qa` block to
.agentrc.json (featureRoot, fixturesManifest, environments, personas) before
invoking the QA harness."_

When the resolver throws, **STOP immediately**: relay its verbatim message to
the operator as terminal output and do not proceed. Do not invent a
`featureRoot`, guess a sign-in seam, or fall back to any retired headless BDD
runner. The loud failure is the contract — a consumer that has not bound the
harness has not opted into it.

The normalized contract exposes `featureRoot`, `fixturesManifest`,
`environments` (each keyed to `{ baseUrl, signInSeam, allowWrites? }`, resolved
to one target via [`resolveQaEnvironment`](../../scripts/lib/qa/resolve-qa-contract.js)),
`defaultEnvironment`, `personas` (canonical name-keyed map; a name-only persona
resolves to an empty record), `consoleAllowlist` (default `[]`), and
`designTokens` (default `null`).

## Session & ledger (temp/qa/)

Resolve the session and its ledger path **once**, up front, via
[`qa-session.js`](../../scripts/lib/qa/qa-session.js):

```js
import { resolveQaSession } from '../scripts/lib/qa/qa-session.js';
const { sessionId, ledgerPath, reused, untriaged } = resolveQaSession({ config });
```

- The ledger is always written under **`temp/qa/<sessionId>.ndjson`**
  (`<tempRoot>/qa/`, from `project.paths.tempRoot`), one `QaLedgerItem` per line
  validated against [`qa-ledger.schema.json`](../../schemas/qa-ledger.schema.json).
  **Never** write it anywhere else, and never commit it — `temp/` is gitignored
  per [`.agents/instructions.md` § 6](../../instructions.md).
- When `reused` is `true`, a prior session of the same id exists: **append**,
  never overwrite, and carry the `untriaged` items forward as the rolling
  backlog. Pass `--session-id <id>` (or `QA_SESSION_ID`) to resume a named
  session.

## Redact first

Before any evidence string touches disk or GitHub, scrub it through
[`redact-evidence.js`](../../scripts/lib/qa/redact-evidence.js):

```js
import { redactEvidence } from '../scripts/lib/qa/redact-evidence.js';
const evidence = redactEvidence(rawObservation);
```

This is mandatory per [`security-baseline.md`](../../rules/security-baseline.md)
(§ Data Leakage & Logging, § Secrets Management) — bearer tokens, session
cookies, `Authorization` headers, and emails are masked. The pass is
idempotent, so redact eagerly; captured console and network evidence is
untrusted until scrubbed. Secrets are never echoed into chat, findings, or the
ledger.

## The QaLedgerItem shape

Each observation/finding is recorded as one `QaLedgerItem` on the session
ledger, conforming to [`qa-ledger.schema.json`](../../schemas/qa-ledger.schema.json):

- **`id`** — stable `L1`, `L2`, … in append order (after any carried backlog).
- **`evidence`** — the **redacted** symptom / observation string.
- **`coverage`** — the surface label the item points at (or `unknown`).
- **`class`** — the ledger class (`product-bug`, `environment-setup`,
  `tooling-dx`, `test-gap`, `enhancement`, …); resolves to the focus/meta label
  set Triage applies.
- **`severity`** — the tentative severity.
- **`missingTest`** — the lowest absent test tier's description, or `null`.
- **`disposition`** — left **untriaged** at capture; set only in Triage.

**Append** to the ledger, never overwrite; a re-run appends to the same
session. This is the single findings channel across all three workflows — there
is no per-workflow finding schema.

## Triage — classify → route → disposition → promote

Route the ledger through the shared classify/route/dedup/promote core. The
outcome is that **every ledger item carries a class, a route decision, and an
operator-confirmed disposition**, with each `file` item promoted via
`promote-finding.js` into `/plan` — verified by the cluster's fingerprint
footer landing in each seed body. For each untriaged item:

1. **Classify** via
   [`classify-finding.js`](../../scripts/lib/findings/classify-finding.js). The
   item's `class` resolves to the focus/meta label set (`tooling-dx` carries
   `meta::framework-gap`; `enhancement` carries `meta::consumer-improvement`).
   The helper **throws** on an absent/unknown class — fix the item's class
   rather than defaulting.
2. **Dedup / route** against existing GitHub Issues (open **and** closed) via
   [`route-finding.js`](../../scripts/lib/findings/route-finding.js) — the
   **single** dedup implementation shared with `audit-to-stories`:

   ```js
   import { routeFinding, fingerprintFooter } from '../scripts/lib/findings/route-finding.js';
   const { decision, matchedIssue, fingerprint } =
     await routeFinding(finding, { searchIssues });
   ```

   `decision` is one of `new` / `update-existing` / `duplicate` /
   `regression-of-closed`. Wire `searchIssues` to the GitHub provider and stamp
   the `fingerprintFooter(sha)` marker into any Issue body so future runs dedup
   against it.
3. **Decide the disposition** with the operator (`file` / `defer` / `dismiss`)
   and record it back onto the ledger item.
4. **Promote the `file`-dispositioned findings through `/plan`** via
   [`promote-finding.js`](../../scripts/lib/findings/promote-finding.js) — the
   same cluster/size/route/file path `audit-to-stories` consumes. Never
   hand-roll the clustering, sizing, or promotion in prose:

   ```js
   import { promoteFindings } from '../scripts/lib/findings/promote-finding.js';
   const { promotions } = await promoteFindings(ledgerItems, {
     searchIssues, // GitHub provider, open + closed
     createStory, // tight cluster (≤2 surfaces): seed → /plan --seed-file
     createPlanSeed, // broad cluster (>2 surfaces): same /plan --seed-file path (may N>1)
   });
   ```

   `promoteFindings` runs `clusterLedgerItems` + `targetForCluster`: a cluster
   spanning **≤2** distinct coverage surfaces routes to `createStory`, **>2** to
   `createPlanSeed` — neither opens an Epic; both render a **redacted** plan
   seed (redaction already ran at capture), **stamp the cluster's
   `fingerprintFooter(sha)` verbatim into the seed body**, and chain
   `/plan --seed-file <seed>`. Prefer one Story; split only under the
   default-single policy. A `file` disposition **never** opens a raw GitHub
   Issue; only `defer` and `dismiss` skip the `/plan` handoff.

## The HITL write gate

Capture stays read-only precisely so every state change lands in Triage,
deliberately and confirmed. Any ticket-filing, seed write, `/plan` invocation,
or label mutation is a **write** — present the artifact, confirm each one with
the operator, and wait before it happens. The agent never files tickets,
promotes findings, or mutates a label autonomously. The plan→deliver hard stop
is preserved: each `/plan` chain pauses at its own HITL gates and never
auto-delivers.
