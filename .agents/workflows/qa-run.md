---
description: Drive Gherkin scenarios through a real browser as an agent-driven QA sweep
---

# /qa-run

Execute a consumer's Gherkin `.feature` scenarios through a **real browser**
(the chrome-devtools MCP surface), with the agent acting as the step executor
and a human observing. The harness resolves the consumer's `qa` contract,
**resolves a target environment**, selects a concrete scenario set, signs in
via the environment's configured seam, then delegates each scenario to
[`helpers/qa-run-scenario.md`](helpers/qa-run-scenario.md) — which navigates
**from a root** to drive each `Given/When/Then` and asserts `Then` outcomes
**semantically** against the accessibility snapshot. Per-surface console and
network are instrumented into structured findings; those findings are recorded
as `QaLedgerItem`s on the shared session ledger under `temp/qa/` and routed —
after the operator sign-off gate — through the same
classify/route/dedup/promote core `/qa-explore` and `/qa-assist` use, so re-run
sweeps dedup previously-filed findings instead of re-drafting them. The harness
never files tickets autonomously.

This workflow is the agent-driven successor to the framework's earlier
headless BDD runner. It is a **prose workflow**, not a Node orchestrator: the host LLM
executes the procedure; deterministic Node helpers under
`.agents/scripts/lib/qa/` do contract resolution, environment resolution,
scenario selection, console filtering, evidence redaction, and session/ledger
resolution, and the shared findings core under `.agents/scripts/lib/findings/`
owns classification, dedup/route, and cluster/size/promote. The agent never
invents those decisions in prose.

> **When to run**: During sprint testing to exercise a targeted slice of the
> acceptance suite (a feature, a tag expression, or a domain), for regression
> passes before `/deliver`, or on demand while debugging a Story's
> user-visible behavior in a live browser.
>
> **Persona**: `qa-engineer` · **Skills**: `stack/qa/gherkin-authoring`,
> `stack/qa/playwright-bdd` (authoring reference; this harness owns execution)

## Slash Command

```text
/qa-run [<env>] [<selector>]
```

### Arguments

Both arguments are **optional**. A bare `/qa-run` runs the interactive
env-then-scope flow (Step 0.5); supplying the arguments skips the corresponding
prompt.

| Name       | Required | Shape / Example                              | Notes                                                                                              |
| ---------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `env`      | no       | `local`, `staging`, `https://staging.app.example` | Selects one of the contract's `environments` (Step 0.5a). Omit to be **prompted** for the environment. A raw URL resolves by origin match. |
| `selector` | no       | `feature:login`, `tag:@smoke and not @wip`, `domain:billing` | Scopes the sweep to a concrete scenario set. Omit to be **prompted** for scope (Step 0.5b). One of three kinds — see below. |

- **Bare `/qa-run`** → prompt for the environment (Step 0.5a), then prompt for
  scope (Step 0.5b).
- **`/qa-run <env> <selector>`** → **skip both prompts**; resolve `<env>`
  directly and resolve `<selector>` directly.

The selector is resolved by
[`resolve-selection.js`](../scripts/lib/qa/resolve-selection.js) into a
deterministic, `(file, line)`-sorted scenario set under the contract's
`featureRoot`. The three kinds map to that resolver's selector shapes:

- **`feature:<id>`** → `{ kind: 'feature', id }` — the single `.feature` file
  whose `featureRoot`-relative path stem (or basename) equals the id
  (case-insensitive). Ambiguous ids throw; qualify with a relative path.
- **`tag:<expression>`** → `{ kind: 'tag', expression }` — the scenario set
  whose tags satisfy the cucumber boolean expression (`@tag` atoms with
  `and` / `or` / `not` and parentheses). Quote expressions that contain
  spaces.
- **`domain:<name>`** → `{ kind: 'domain', name }` — every scenario under the
  `featureRoot`-relative subdirectory `name`.

### Examples

```text
/qa-run                                  # interactive: prompt env, then scope
/qa-run staging                          # env pinned, prompt for scope
/qa-run local feature:login             # both pinned, no prompts
/qa-run staging "tag:@smoke and not @wip"
/qa-run https://staging.app.example domain:billing
```

The canonical tag taxonomy — `@smoke`, `@risk-high`, `@platform-web`,
`@platform-mobile`, `@domain-*`, and the allowed extension syntax — is defined
in `.agents/rules/gherkin-standards.md`. Do not invent tags inside a feature
file; add new tags to the rule first.

## Step 0 — Resolve the `qa` contract (fail loudly when absent)

The harness is meaningless without the consumer's `qa` contract block in
`.agentrc.json`. Resolve it through the single seam
[`resolve-qa-contract.js`](../scripts/lib/qa/resolve-qa-contract.js) **before
any browser work**:

```bash
node -e "import('./.agents/scripts/lib/qa/resolve-qa-contract.js').then(async (m) => { const { resolveConfig } = await import('./.agents/scripts/config-resolver.js'); const cfg = await resolveConfig(); console.log(JSON.stringify(m.resolveQaContract(cfg), null, 2)); })"
```

(Use whatever config-resolution entry point the host exposes; the contract
seam is `resolveQaContract(config)`.) The resolver returns the normalized
contract:

| Field                | Use                                                                       |
| -------------------- | ------------------------------------------------------------------------- |
| `featureRoot`        | Root passed to `resolve-selection.js` for scenario discovery.             |
| `fixturesManifest`   | Persona → seed binding loaded before sign-in.                             |
| `environments`       | Environment-keyed map (`{ baseUrl, signInSeam, allowWrites? }` per name). Resolved to a single target in Step 0.5a. |
| `defaultEnvironment` | Environment name used when no `<env>` argument is supplied and the operator accepts the default. |
| `personas`           | Canonical object map keyed by persona name (`personaNames` lists the names). Authored as a plain name array under a `urlTemplate` seam, or as a per-persona credential/skill map under a `skill` (or credential) seam — see Step 2. |
| `consoleAllowlist`   | Inline benign-console patterns (default `[]`) — see Step 4.               |
| `designTokens`       | Pointer to the token/style source for visual inspection (default `null`). |

### Loud-failure path (no `qa` block)

`resolveQaContract` **throws** — there is no silent fallback to
auto-detection — in three cases:

- **Block absent** (no `qa` key, or an empty `qa: {}` with no harness-required
  fields): the error reads
  _"qa: this project has not bound the QA harness — add a `qa` block to
  .agentrc.json (featureRoot, fixturesManifest, environments, personas) before
  invoking the QA harness."_
- **Malformed shape** (wrong-typed field, unknown field): the error names the
  offending field, e.g. `qa.featureRoot must be a string`.
- **Missing required field**: the error names the first missing field.

When you hit any of these, **STOP immediately**. Relay the resolver's
verbatim message to the operator as the harness's terminal output and do not
proceed to browser execution. Do not invent a `featureRoot`, do not guess a
sign-in seam, and do not fall back to any retired headless BDD runner. The
loud failure is the contract: a consumer that has not bound the harness has
not opted into it.

### MCP availability check

The chrome-devtools MCP surface (`navigate_page`, `take_snapshot`, `click`,
`fill_form`, `evaluate_script`, `wait_for`, `list_console_messages`,
`list_network_requests`) is **host-provided** — it is an external runtime
dependency, not in-repo code. If the host does not expose it, degrade with a
clear error ("the chrome-devtools MCP server is unavailable; the QA harness
requires a live browser surface") and stop. Do not attempt a headless
fallback.

### Session & ledger (temp/qa/)

Resolve the session and its ledger path **once**, up front, via
[`qa-session.js`](../scripts/lib/qa/qa-session.js) — the same seam
`/qa-explore` and `/qa-assist` use:

```js
import { resolveQaSession } from '../scripts/lib/qa/qa-session.js';
const { sessionId, ledgerPath, reused, untriaged } = resolveQaSession({ config });
```

- The ledger is always written under **`temp/qa/<sessionId>.ndjson`**
  (`<tempRoot>/qa/`, resolved from `project.paths.tempRoot`). It is one
  `QaLedgerItem` per line (ndjson) validated against
  [`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json). **Never** write
  the ledger anywhere else, and never commit it — `temp/` is gitignored per
  [`.agents/instructions.md` § 6](../instructions.md).
- When `reused` is `true`, a prior session of the same id exists: **append**,
  never overwrite, and carry the `untriaged` items forward as the rolling
  backlog. Pass `--session-id <id>` (or `QA_SESSION_ID`) to resume a named
  session.

The sweep's `F#` findings (Step 4) are recorded as `QaLedgerItem`s on this
ledger, and Step 5 routes the ledger through the shared
classify/route/dedup/promote core — there is no separate `/qa-run` finding
schema or draft-bundle path.

## Step 0.5 — Resolve the environment, then the scope (interactive when unargued)

### Step 0.5a — Resolve the target environment

Resolve which of the contract's `environments` this sweep runs against through
[`resolveQaEnvironment`](../scripts/lib/qa/resolve-qa-contract.js). It returns
the resolved target `{ name, baseUrl, signInSeam, allowWrites }` (with
`allowWrites` defaulted to an explicit boolean — `true` only for the
conventional `local` environment, `false` for every other target unless the
consumer opts in).

- **`<env>` argument supplied** → pass it straight to `resolveQaEnvironment`.
  An exact environment name wins; a raw URL resolves by **origin match**
  against each environment's `baseUrl`. An unknown name or an unmatched URL
  **throws** — relay the resolver's message (it names the known environments)
  and stop; do **not** guess an environment.
- **No `<env>` argument (bare `/qa-run`)** → **prompt the operator**. Enumerate
  every environment as `name → baseUrl` (marking `defaultEnvironment`), and ask
  which to run against. The operator may answer with an environment **name** or
  paste a **raw URL** — resolve either through `resolveQaEnvironment` (a raw
  URL matches by origin). If the answer resolves to nothing, **fail loudly**
  with the resolver's known-environments message; do not silently fall back to
  the default.

Carry the resolved `{ name, baseUrl, allowWrites }` forward — `baseUrl` is the
navigation root, and `allowWrites` drives the write guard (Step 1) and is part
of the per-scenario helper's input contract (Step 3).

### Step 0.5b — Select the scope

- **`<selector>` argument supplied** → parse it into the resolver's selector
  shape and proceed to Step 1.
- **No `<selector>` argument (bare `/qa-run`)** → **prompt the operator** for
  scope. Enumerate the selectable scope under `featureRoot` via
  [`resolve-selection.js`](../scripts/lib/qa/resolve-selection.js): the
  available **domains** (first-level `featureRoot` subdirectories), **feature
  stems** (`.feature` path stems), and **canonical tags** (the tag atoms the
  scanner collected across the tree, per the `.agents/rules/gherkin-standards.md`
  taxonomy). Present them as a **multi-select** — the operator may pick any
  combination of domains, feature stems, and tags, which compose into the
  selector set. Always include an explicit final option:

  > **No coverage here → hand off to `/qa-explore`.** When the surface the
  > operator wants to test has no authored `.feature` coverage, choosing this
  > option ends the sweep and hands off to [`/qa-explore`](qa-explore.md) for
  > agent-led exploratory QA, rather than running an empty selection.

  If the operator picks the hand-off option, stop the sweep and route to
  `/qa-explore`. Otherwise resolve the multi-select into the concrete selector
  set and proceed to Step 1.

## Step 1 — Select the scenario set (and apply the write guard)

Pass the resolved selector(s) and the contract's `featureRoot` to
[`resolveSelection`](../scripts/lib/qa/resolve-selection.js). It returns
`{ kind, featureRoot, files, scenarios }` where `scenarios` is the
`(file, line)`-sorted set the sweep will execute. Determinism is load-bearing:
re-running the same selector across sweeps scopes the identical set, so the
evidence stays diffable.

Load the `fixturesManifest` to resolve each persona's seed data before
sign-in. If the selection is empty, report "no scenarios matched
`<selector>`" and stop — an empty selection is operator error (a typo'd
feature id or domain), not a passing sweep.

### `allowWrites` guardrail (non-local safety)

When the resolved environment has **`allowWrites: false`**, exclude any
scenario judged **mutating** from the selection before driving. Judge a
scenario mutating from its **`When` steps** — a `When` that creates, updates,
or deletes persisted state (submits a form that writes, deletes a record,
changes a setting) is mutating; a read-only navigation/inspection `When` is
not. Report the **exclusion count** ("N mutating scenarios excluded on
read-only `<env>`") alongside the resolved scenario count so the operator sees
what was skipped and why. The exclusion is overridable **only** by an explicit
in-session operator confirmation (the operator affirms, in this session, that
writes to `<env>` are acceptable) — never silently include mutating scenarios
on a read-only target, and never widen `allowWrites` by editing the contract
mid-sweep.

## Step 2 — Sign in via the environment's `signInSeam`

Sign in **once per persona** before driving that persona's scenarios, using the
resolved environment's discriminated-union seam
(`environment.signInSeam`, anchored on `environment.baseUrl`):

- **`kind: 'url'`** — substitute `{persona}` into `template` (e.g.
  `/dev/sign-in-as/{persona}` → `/dev/sign-in-as/admin`) and `navigate_page`
  to the resulting dev seam URL. The persona **name** (a `personaNames` entry)
  is the **sole input** the seam consumes — per-persona auth material is
  neither needed nor read here, so under a `urlTemplate` seam the contract is
  authored as a plain name array (`personas: ["athlete", "coach"]`).
- **`kind: 'skill'`** — invoke the named consumer skill for procedural
  (multi-step or non-URL) sign-in. Read the skill's `SKILL.md` and follow it.

### Credentials under a skill seam (bounded rule)

Under a `skill` seam, real sign-in is permitted but **bounded**:

- Real auth uses **only `credentialRef`-indirected material** — the persona's
  `credentialRef` names a stored credential the skill dereferences; raw
  passwords, tokens, or API keys are never inlined into the contract, the
  workflow, or chat.
- **Secrets are never echoed** into chat, findings, or the ledger — do not
  print a credential, a session token, or a cookie value at any point.
- **Captured evidence passes `redact-evidence.js`** (`redactEvidence`) before
  persistence, so any secret that leaks into console/network capture is
  scrubbed before it reaches a finding (see Step 4 and the per-scenario
  helper).

Per-persona auth material (`credentialRef` / `signInSkill`, authored via the
object-map `personas` shape) is consulted **only** under a `skill` or
credential seam. Under a `urlTemplate` dev-impersonation seam the persona name
is the only input, so the material is never read — author name-only personas
there rather than fabricating `credentialRef`/`signInSkill` values the harness
ignores. The resolver normalizes both authored shapes to one canonical object
map keyed by persona name; a name-only persona resolves to an empty record.

After sign-in, confirm the authenticated state with a `take_snapshot`
(e.g. the user menu or persona badge is present) before driving any scenario.
This confirmed authenticated session is the precondition the per-scenario
helper's input contract requires (Step 3).

## Step 3 — Drive each scenario via the per-scenario helper

For each scenario in selection order, delegate driving, analysis, and reporting
to [`helpers/qa-run-scenario.md`](helpers/qa-run-scenario.md). Pass its input
contract:

- **`environment`** — the resolved `{ name, baseUrl, allowWrites }` from
  Step 0.5a.
- **`persona`** — the persona name **plus** the confirmed authenticated-session
  precondition established in Step 2 (the helper re-verifies it on entry).
- **`scenario`** — the scenario ref (`.feature` file path and `(file, line)`
  locator).
- **`consoleAllowlist`** and **`designTokens`** — from the resolved contract.

The helper owns the navigation-first / never-URL-jump rule, the semantic-`Then`
assertion against the accessibility snapshot, the per-`When` write guard under
`allowWrites: false`, and mandatory evidence redaction. It returns **one
structured per-scenario result** — `{ scenario, intent, verdict (pass | fail |
blocked), surface, findings[] }`. Collect one result per scenario; the sweep
report shape (per-scenario `intent + verdict` lines plus totals, Step 6) is
unchanged from the inlined procedure.

## Step 4 — Instrument & record findings onto the ledger

The per-scenario helper captures console and network per surface and turns
genuine problems into structured findings, applying the contract's
`consoleAllowlist` via
[`filterConsoleMessages`](../scripts/lib/qa/console-allowlist.js) (each
non-allowlisted console **error** becomes one `F#` finding; allowlisted
patterns and non-error levels are suppressed) and, when `designTokens` is set,
spot-checking the surface against the token source. The allowlist is a **noise
filter, not a security control** — never expand it to silence a genuine error
signal.

Each returned `F#` finding — the console/network-derived shape
`{ id, classification, surface, symptom, likelyRootCause, disposition,
acceptance, evidence: { console[], network[] } }`, with evidence already
scrubbed of tokens, session cookies, and PII via
[`redact-evidence.js`](../scripts/lib/qa/redact-evidence.js) per
`.agents/rules/security-baseline.md` — is **recorded as a `QaLedgerItem`** on
the session ledger resolved in Step 0 (`temp/qa/<sessionId>.ndjson`,
[`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json)). Map the finding
onto the ledger shape: a stable `id` (`L1`, `L2`, … in append order), the
finding's `symptom` as the scrubbed `evidence`, the finding's `surface` as
`coverage`, a `class` (map the finding's classification onto the
ledger `class` enum — a product defect is `product-bug`, a tooling gap is
`tooling-dx`, etc.) and `severity`, `missingTest` (`null` when no test gap
applies), and `disposition` left untriaged. **Append** to the ledger, never
overwrite; a re-run appends to the same session. This is the single findings
channel — there is no separate `/qa-run` finding schema or draft bundle.

## Step 5 — Triage the ledger (operator sign-off required)

After the sweep completes, route the ledger through the same
classify/route/dedup/promote core `/qa-explore` Triage and `/qa-assist` use.
The **operator sign-off gate is preserved**: the harness MUST NOT create
tickets autonomously — present the routed dispositions and confirm each
`file` / `defer` / `dismiss` with the operator before any write.

For each untriaged ledger item:

1. **Classify** it via
   [`classify-finding.js`](../scripts/lib/findings/classify-finding.js). The
   item's `class` resolves to the focus/meta label set Triage applies when
   promoting it. The helper **throws** on an absent/unknown class — fix the
   ledger item's class rather than defaulting.
2. **Dedup / route** it against existing GitHub Issues via
   [`route-finding.js`](../scripts/lib/findings/route-finding.js):

   ```js
   import { routeFinding, fingerprintFooter } from '../scripts/lib/findings/route-finding.js';
   const { decision, matchedIssue, fingerprint } =
     await routeFinding(finding, { searchIssues });
   ```

   `decision` is one of `new` / `update-existing` / `duplicate` /
   `regression-of-closed`. Wire the `searchIssues` port to the GitHub provider,
   querying **both open and closed** Issues, and stamp the
   `fingerprintFooter(sha)` marker into any Issue body so future sweeps dedup
   against it. This is the **single** dedup implementation shared with
   `/qa-explore`, `/qa-assist`, and `audit-to-stories`.
3. **Decide the disposition** with the operator (`file` / `defer` / `dismiss`)
   and record it back onto the ledger item.
4. **Promote the `file`-dispositioned findings through `/plan`** via
   [`promote-finding.js`](../scripts/lib/findings/promote-finding.js) — the
   same cluster/size/route/file path `/qa-explore` and `/audit-to-stories`
   consume (`clusterLedgerItems` + `targetForCluster`: a cluster spanning ≤2
   coverage surfaces routes to `createStory` via `/plan --from-notes`, >2 to
   `createEpic` via `/plan --idea`, with the cluster's `fingerprintFooter(sha)`
   stamped verbatim into the seed). A `file` disposition never opens a raw
   GitHub Issue; only `defer` and `dismiss` skip the `/plan` handoff.
5. **Gate:** any ticket-filing, seed write, `/plan` invocation, or label
   mutation is a write — confirm each with the operator before it happens.

If the run was triggered from an Epic-testing context, hand the approved,
promoted findings to the Epic-testing helper for attachment to the Epic's QA
evidence ticket.

## Step 6 — Report

Summarize the sweep in chat with:

- The resolved **environment** (`name → baseUrl`, and whether it is read-only)
  and the selector applied.
- The resolved scenario count, plus the **`allowWrites` exclusion count** when
  mutating scenarios were skipped on a read-only environment.
- Scenario totals: passed / failed / blocked.
- Findings totals by classification, and the ledger routes
  (`new` / `update-existing` / `duplicate` / `regression-of-closed`).
- A per-scenario line pairing each scenario's plain-English intent with its
  verdict (pass / fail / blocked), grouped by feature file or domain — so the
  digest reads as "what was checked → what happened", not a tag list.
- For each failure, the scenario name, file path, the surface it ended on, and
  a one-line user-visible symptom.
- The ledger path (under `temp/qa/`) and a pointer to the routed dispositions
  awaiting operator sign-off (if any).

## Constraints

- **Always** resolve the `qa` contract first and **fail loudly** when it is
  absent or malformed. There is no auto-detection fallback.
- **Always** resolve a target environment (Step 0.5a) — prompt for it when no
  `<env>` argument is supplied — and **fail loudly** on an unknown name or an
  unmatched URL. Never silently fall back to the default on a bad answer.
- **Always** apply the `allowWrites` guardrail: on a read-only environment,
  exclude mutating scenarios and report the exclusion count; include them only
  on explicit in-session operator confirmation.
- **Always** navigate from a root via UI affordances. **Never** URL-jump to a
  deep link to set up a scenario.
- **Always** assert `Then` outcomes semantically against the accessibility
  snapshot. **Never** assert via DOM/CSS/XPath selectors, HTTP status codes,
  response bodies, or DB rows inside a scenario — push those to the contract
  tier per `.agents/rules/testing-standards.md`.
- **Under a skill seam**, real sign-in uses only `credentialRef`-indirected
  material; secrets are never echoed into chat, findings, or the ledger; and
  captured evidence passes `redact-evidence.js` before persistence.
- **Always** record findings as `QaLedgerItem`s on the shared session ledger
  under `temp/qa/` ([`qa-ledger.schema.json`](../schemas/qa-ledger.schema.json))
  and route them through the shared classify/route/dedup/promote core — there
  is no separate `/qa-run` finding schema or draft-bundle path. Never commit
  the ledger.
- **Delegate Triage decisions to the helpers.** Classification
  ([`classify-finding.js`](../scripts/lib/findings/classify-finding.js)),
  dedup/route ([`route-finding.js`](../scripts/lib/findings/route-finding.js),
  fingerprint-footer against open + closed issues), and cluster/size/promote
  ([`promote-finding.js`](../scripts/lib/findings/promote-finding.js)) are
  deterministic — never re-derive them in prose.
- **Never** file follow-up tickets autonomously; promote `file` findings
  through `/plan` only after operator sign-off, and never open a raw GitHub
  Issue for a `file` finding.
- **Never** expand `consoleAllowlist` to suppress genuine error signal — it is
  a benign-noise filter, not a security control.
- **Always** scrub captured evidence of secrets and PII before rendering a
  finding.
- **Never** fall back to a retired headless BDD-runner workflow.
