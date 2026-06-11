---
description: Drive Gherkin scenarios through a real browser as an agent-driven QA sweep
---

# /qa-run-harness

Execute a consumer's Gherkin `.feature` scenarios through a **real browser**
(the chrome-devtools MCP surface), with the agent acting as the step executor
and a human observing. The harness resolves the consumer's `qa` contract,
selects a concrete scenario set, signs in via the configured seam, navigates
**from a root** to drive each `Given/When/Then`, and asserts `Then` outcomes
**semantically** against the accessibility snapshot. Per-surface console and
network are instrumented into structured findings; findings are bundled into a
follow-up **draft** for operator sign-off — the harness never files tickets
autonomously.

This workflow is the agent-driven successor to the framework's earlier
headless BDD runner. It is a **prose workflow**, not a Node orchestrator: the host LLM
executes the procedure; deterministic Node helpers under
`.agents/scripts/lib/qa/` do only contract resolution, scenario selection, and
console filtering.

> **When to run**: During sprint testing to exercise a targeted slice of the
> acceptance suite (a feature, a tag expression, or a domain), for regression
> passes before `/deliver`, or on demand while debugging a Story's
> user-visible behavior in a live browser.
>
> **Persona**: `qa-engineer` · **Skills**: `stack/qa/gherkin-authoring`,
> `stack/qa/playwright-bdd` (authoring reference; this harness owns execution)

## Slash Command

```text
/qa-run-harness <selector>
```

### Arguments

| Name       | Required | Shape / Example                              | Notes                                                                                              |
| ---------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `selector` | yes      | `feature:login`, `tag:@smoke and not @wip`, `domain:billing` | Scopes the sweep to a concrete scenario set. One of three kinds — see below. |

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
/qa-run-harness feature:login
/qa-run-harness "tag:@smoke and not @wip"
/qa-run-harness domain:billing
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

| Field              | Use                                                                       |
| ------------------ | ------------------------------------------------------------------------- |
| `featureRoot`      | Root passed to `resolve-selection.js` for scenario discovery.             |
| `fixturesManifest` | Persona → seed binding loaded before sign-in.                             |
| `signInSeam`       | `{ kind: 'url', template }` **or** `{ kind: 'skill', skill }` — see Step 2. |
| `personas`         | Canonical object map keyed by persona name (`personaNames` lists the names). Authored as a plain name array under a `urlTemplate` seam, or as a per-persona credential/skill map under a `skill` (or credential) seam — see Step 2. |
| `consoleAllowlist` | Inline benign-console patterns (default `[]`) — see Step 4.               |
| `designTokens`     | Pointer to the token/style source for visual inspection (default `null`). |

### Loud-failure path (no `qa` block)

`resolveQaContract` **throws** — there is no silent fallback to
auto-detection — in three cases:

- **Block absent** (no `qa` key, or an empty `qa: {}` with no harness-required
  fields): the error reads
  _"qa: this project has not bound the QA harness — add a `qa` block to
  .agentrc.json (featureRoot, fixturesManifest, signInSeam, personas) before
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

## Step 1 — Select the scenario set

Pass the parsed `selector` and the contract's `featureRoot` to
[`resolveSelection`](../scripts/lib/qa/resolve-selection.js). It returns
`{ kind, featureRoot, files, scenarios }` where `scenarios` is the
`(file, line)`-sorted set the sweep will execute. Determinism is load-bearing:
re-running the same selector across sweeps scopes the identical set, so the
evidence stays diffable.

Load the `fixturesManifest` to resolve each persona's seed data before
sign-in. If the selection is empty, report "no scenarios matched
`<selector>`" and stop — an empty selection is operator error (a typo'd
feature id or domain), not a passing sweep.

## Step 2 — Sign in via the `signInSeam`

Sign in **once per persona** before driving that persona's scenarios, using
the contract's discriminated-union seam:

- **`kind: 'url'`** — substitute `{persona}` into `template` (e.g.
  `/dev/sign-in-as/{persona}` → `/dev/sign-in-as/admin`) and `navigate_page`
  to the resulting dev seam URL. This is a dev-only seam; **no real
  credentials** are ever entered. The persona **name** (a `personaNames`
  entry) is the **sole input** the seam consumes — per-persona auth material
  is neither needed nor read here, so under a `urlTemplate` seam the contract
  is authored as a plain name array (`personas: ["athlete", "coach"]`).
- **`kind: 'skill'`** — invoke the named consumer skill for procedural
  (multi-step or non-URL) sign-in. Read the skill's `SKILL.md` and follow it.

### Which seam kinds consult per-persona material

Per-persona auth material (`credentialRef` / `signInSkill`, authored via the
object-map `personas` shape) is consulted **only** under a `skill` or
credential seam, where the sign-in procedure needs a stored credential
reference or a per-persona sign-in skill. Under a `urlTemplate`
dev-impersonation seam the persona name is the only input, so the material is
never read — author name-only personas there rather than fabricating
`credentialRef`/`signInSkill` values the harness ignores. The resolver
normalizes both authored shapes to one canonical object map keyed by persona
name; a name-only persona resolves to an empty record (no auth material).

After sign-in, confirm the authenticated state with a `take_snapshot`
(e.g. the user menu or persona badge is present) before driving any scenario.

## Step 3 — Drive each scenario (navigation-first, semantic Then)

For each scenario in selection order, drive its `Given/When/Then` steps
through the browser. Two rules are **non-negotiable**:

### Navigation-first — never URL-jump

Start every scenario at a **root** (the app's home/dashboard after sign-in)
and reach the surface under test **only by navigating UI affordances** — click
nav links, menu items, buttons, and follow the same paths a real user would.
**Never** `navigate_page` directly to a deep link to set up a `Given`. URL-
jumping bypasses the app's real authorization and routing flows, which both
masks access-control gaps and produces findings that do not reflect a user-
reachable state. Driving via affordances keeps the agent inside the app's
genuine flows and surfaces broken navigation, guard redirects, and dead links
as findings rather than hiding them.

Map the Gherkin steps to browser actions:

- **`Given`** — establish state by navigating from the root via affordances
  (sign in as the persona, navigate to the starting surface, seed via UI where
  the manifest does not pre-seed).
- **`When`** — perform the user action: `click`, `fill_form`,
  `evaluate_script` (only for app-provided hooks, never to fabricate the
  outcome), then `wait_for` the resulting transition.
- **`Then`** — assert the outcome semantically (below).

### Semantic Then assertion against the accessibility snapshot

Assert every `Then` **semantically** against the accessibility snapshot from
`take_snapshot` — match on roles, accessible names, labels, and visible text
that express the user-visible outcome ("a banner with text _Invoice sent_ is
visible", "a row for _ACME Corp_ appears in the invoices table"). **Do not**
assert against brittle DOM/CSS/XPath selectors, and **do not** assert on HTTP
status codes, response bodies, or DB rows — those are contract-tier concerns
that belong in contract tests, not in a user-journey sweep (see
`.agents/rules/testing-standards.md` § Assertion Placement). A `Then` that can
only be expressed as a wire-shape or DB check is a signal the scenario is
mis-tiered, not a reason to break the semantic rule.

Before driving each scenario, state its **business intent** in one
plain-English line, derived from the `Scenario:` name and its
`Given/When/Then` (what the user is trying to do and the outcome that proves
it) — e.g. "a signed-in coach reaches their own team-management surface".
Then record the scenario's result (pass / fail / blocked) with the surface it
ended on and a one-line user-visible symptom for any failure. State the
intent for **every** scenario, not only failures. Keep it to one line sourced
from the `Scenario:` name and steps — the `.feature` file is the source of
truth; do not paraphrase every step or leak implementation detail.

## Step 4 — Instrument & inspect (findings)

Per surface visited, capture console and network and turn genuine problems
into structured findings:

1. **Console** — `list_console_messages`, then filter through the contract's
   `consoleAllowlist` via
   [`filterConsoleMessages`](../scripts/lib/qa/console-allowlist.js). Each
   non-allowlisted console **error** (level `error` / `severe`) becomes one
   `F#` finding; allowlisted patterns and non-error levels are suppressed. The
   allowlist is a **noise filter, not a security control** — never expand it to
   silence a genuine error signal.
2. **Network** — `list_network_requests`; failed or error-status requests on
   the surface become findings alongside the console-derived set.
3. **Visual / style** — when `designTokens` is set, spot-check the surface
   against the token source; gross token violations become findings.

Findings use the structured `F#` shape: `{ id, classification, surface,
symptom, likelyRootCause, disposition (blocker | follow-up), acceptance,
foldsInto?, evidence: { console[], network[] } }`, validated against
[`qa-finding.schema.json`](../schemas/qa-finding.schema.json). Before
rendering any finding evidence, **scrub captured console/network of tokens,
session cookies, and PII** per `.agents/rules/security-baseline.md` — findings
are posted to GitHub at approval time.

## Step 5 — Draft follow-ups (operator sign-off required)

Validate each finding against
[`qa-finding.schema.json`](../schemas/qa-finding.schema.json) first, then
bundle findings **by likely root cause** into proposed follow-up tickets with
`Depends-on` / `Blocks` relationships, and present the draft to the operator
for approval. The harness **MUST NOT** create tickets autonomously — it stops
at a draft. The operator-approval gate is the safety boundary against spurious
filing. If the run was triggered from an Epic-testing context, hand the
approved findings to the Epic-testing helper for attachment to the Epic's QA
evidence ticket.

## Step 6 — Report

Summarize the sweep in chat with:

- Selector applied and the resolved scenario count.
- Scenario totals: passed / failed / blocked.
- Findings totals by classification and disposition (blocker vs follow-up).
- A per-scenario line pairing each scenario's plain-English intent with its
  verdict (pass / fail / blocked), grouped by feature file or domain — so the
  digest reads as "what was checked → what happened", not a tag list.
- For each failure, the scenario name, file path, the surface it ended on, and
  a one-line user-visible symptom.
- A pointer to the drafted follow-up bundle awaiting sign-off (if any).

## Constraints

- **Always** resolve the `qa` contract first and **fail loudly** when it is
  absent or malformed. There is no auto-detection fallback.
- **Always** navigate from a root via UI affordances. **Never** URL-jump to a
  deep link to set up a scenario.
- **Always** assert `Then` outcomes semantically against the accessibility
  snapshot. **Never** assert via DOM/CSS/XPath selectors, HTTP status codes,
  response bodies, or DB rows inside a scenario — push those to the contract
  tier per `.agents/rules/testing-standards.md`.
- **Never** enter real credentials; sign-in uses the consumer's dev seam only.
- **Never** file follow-up tickets autonomously; stop at a draft for operator
  sign-off.
- **Never** expand `consoleAllowlist` to suppress genuine error signal — it is
  a benign-noise filter, not a security control.
- **Always** scrub captured evidence of secrets and PII before rendering a
  finding.
- **Never** fall back to a retired headless BDD-runner workflow.
