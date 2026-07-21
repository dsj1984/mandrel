---
description: Drive Gherkin scenarios through a real browser as an agent-driven QA sweep
---

# /qa-run

Execute a consumer's Gherkin `.feature` scenarios through a **real browser**
(the chrome-devtools MCP surface), with the agent acting as the step executor
and a human observing. The sweep resolves a **run envelope** — a target
environment, a concrete scenario set, and an authenticated persona session —
then delegates each scenario to
[`helpers/qa-run-scenario.md`](helpers/qa-run-scenario.md), which drives it
navigation-first and asserts `Then` outcomes semantically against the
accessibility snapshot. Per-surface console and network are captured as
structured findings, recorded as `QaLedgerItem`s on the shared session ledger,
and triaged — after operator sign-off — through the shared classify/route/
dedup/promote core. The harness never files tickets autonomously.

The shared machinery — contract resolution + loud failure, the session & ledger
contract, redact-first, the `QaLedgerItem` shape, the triage procedure, and the
HITL write gate — lives once in [`helpers/qa-core.md`](helpers/qa-core.md); this
workflow states only the `/qa-run`-specific phases (env → scope → sign-in →
drive) plus a Constraints delta. Deterministic Node helpers under
`.agents/scripts/lib/qa/` own contract, environment, and scenario resolution;
the agent never invents those decisions in prose.

> **When to run**: during sprint testing to exercise a targeted slice of the
> acceptance suite (a feature, a tag expression, or a domain), for regression
> passes before `/deliver`, or on demand while debugging a Story's
> user-visible behavior in a live browser.
>
> **Skills**: `stack/qa/gherkin-authoring`, `stack/qa/playwright-bdd`
> (authoring reference; this harness owns execution)

## Slash Command

```text
/qa-run [<env>] [<selector>]
```

### Arguments

Both arguments are **optional**. A bare `/qa-run` runs the interactive
env-then-scope flow; supplying an argument skips the corresponding prompt.

| Name       | Required | Shape / Example                              | Notes                                                                                              |
| ---------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `env`      | no       | `local`, `staging`, `https://staging.app.example` | Selects one of the contract's `environments`. Omit to be **prompted**. A raw URL resolves by origin match. |
| `selector` | no       | `feature:login`, `tag:@smoke and not @wip`, `domain:billing` | Scopes the sweep to a concrete scenario set. Omit to be **prompted** for scope. One of three kinds — see below. |

The selector is resolved by
[`resolve-selection.js`](../scripts/lib/qa/resolve-selection.js) into a
deterministic, `(file, line)`-sorted scenario set under `featureRoot`. Its
three kinds:

- **`feature:<id>`** — the single `.feature` file whose `featureRoot`-relative
  path stem (or basename) equals the id (case-insensitive; ambiguous ids throw
  — qualify with a relative path).
- **`tag:<expression>`** — the scenario set whose tags satisfy the cucumber
  boolean expression (`@tag` atoms with `and` / `or` / `not` and parentheses;
  quote expressions containing spaces).
- **`domain:<name>`** — every scenario under the `featureRoot`-relative
  subdirectory `name`.

### Examples

```text
/qa-run                                  # interactive: prompt env, then scope
/qa-run staging                          # env pinned, prompt for scope
/qa-run local feature:login             # both pinned, no prompts
/qa-run staging "tag:@smoke and not @wip"
/qa-run https://staging.app.example domain:billing
```

The canonical tag taxonomy (`@smoke`, `@risk-high`, `@platform-*`,
`@domain-*`, and the allowed extension syntax) is defined in
[`.agents/rules/gherkin-standards.md`](../rules/gherkin-standards.md). Do not
invent tags inside a feature file; add new tags to the rule first.

## Step 0 — Resolve the run envelope

The outcome of Steps 0–2 is a single resolved envelope — **`{ environment,
scenario set, authenticated persona session }`** — that the per-scenario driver
(Step 3) consumes. The deterministic resolvers own every decision; the agent
narrates none of their internal return shapes. Every resolver **throws loudly**
on bad input, and the terminal behavior is the same in every case: **relay the
resolver's verbatim message and STOP** — never guess an environment, a
`featureRoot`, or a sign-in seam.

First resolve the `qa` contract and the session per
[`helpers/qa-core.md`](helpers/qa-core.md) (contract resolution + loud failure;
session & ledger under `temp/qa/`). Then build the rest of the envelope:

### The chrome-devtools MCP surface must be available

The chrome-devtools MCP surface (`navigate_page`, `take_snapshot`, `click`,
`fill_form`, `evaluate_script`, `wait_for`, `list_console_messages`,
`list_network_requests`) is **host-provided** — an external runtime dependency,
not in-repo code. If the host does not expose it, degrade with a clear error
("the chrome-devtools MCP server is unavailable; the QA harness requires a live
browser surface") and stop. Never attempt a headless fallback.

### Step 1 — Resolve the environment, then the scope

**Environment** — resolve which of the contract's `environments` this sweep
runs against via
[`resolveQaEnvironment`](../scripts/lib/qa/resolve-qa-contract.js), yielding
`{ name, baseUrl, signInSeam, allowWrites }` (`allowWrites` defaults to an
explicit boolean — `true` only for the conventional `local` environment). When
`<env>` is supplied, pass it straight through (an exact name wins; a raw URL
matches by origin). When it is omitted (bare `/qa-run`), **prompt** the
operator, enumerating every environment as `name → baseUrl` (marking
`defaultEnvironment`); they answer with a name or a raw URL. On an unknown name
or unmatched URL the resolver throws (naming the known environments) — relay it
and stop; never silently fall back to the default.

**Scope** — when `<selector>` is supplied, parse it into the resolver's
selector shape. When omitted, **prompt** the operator: enumerate the selectable
scope under `featureRoot` via `resolve-selection.js` (domains, feature stems,
canonical tags) as a **multi-select** the operator composes into a selector
set. Always include a final **"No coverage here → hand off to `/qa-explore`"**
option: when the surface has no authored `.feature` coverage, choosing it ends
the sweep and routes to [`/qa-explore`](qa-explore.md) rather than running an
empty selection.

**Scenario set + write guard** — pass the resolved selector(s) and `featureRoot`
to [`resolveSelection`](../scripts/lib/qa/resolve-selection.js), which returns
the `(file, line)`-sorted scenario set (determinism is load-bearing: the same
selector scopes the identical set across sweeps). Load `fixturesManifest` to
resolve each persona's seed before sign-in. An empty selection is operator
error (a typo'd id or domain), not a passing sweep — report "no scenarios
matched `<selector>`" and stop.

> **`allowWrites` guardrail (non-local safety).** When the resolved environment
> has `allowWrites: false`, **exclude any mutating scenario** from the selection
> before driving — judge a scenario mutating from its `When` steps (a `When`
> that creates, updates, or deletes persisted state is mutating; a read-only
> navigation/inspection `When` is not). Report the **exclusion count** ("N
> mutating scenarios excluded on read-only `<env>`") alongside the resolved
> count. The exclusion is overridable **only** by an explicit in-session
> operator confirmation — never silently include mutating scenarios on a
> read-only target, and never widen `allowWrites` by editing the contract
> mid-sweep.

### Step 2 — Sign in via the environment's `signInSeam`

Sign in **once per persona** before driving that persona's scenarios, using the
resolved environment's discriminated-union seam (anchored on `baseUrl`):

- **`kind: 'url'`** — substitute the persona **name** into `template` (e.g.
  `/dev/sign-in-as/{persona}`) and `navigate_page` there. The name is the sole
  input; under a `urlTemplate` seam the contract is authored as a plain name
  array and no per-persona auth material is read.
- **`kind: 'skill'`** — invoke the named consumer sign-in skill (procedural /
  non-URL sign-in). Real auth uses **only `credentialRef`-indirected material**
  the skill dereferences; raw passwords, tokens, or API keys are never inlined
  into the contract, the workflow, or chat, and captured evidence is redacted
  per [`helpers/qa-core.md`](helpers/qa-core.md) before persistence.

**Verification (the envelope's proof).** After sign-in, confirm the
authenticated state with a `take_snapshot` showing the persona badge (the user
menu / persona badge is present) before driving any scenario. This confirmed
session is the precondition the per-scenario helper re-verifies on entry.

## Step 3 — Drive each scenario via the per-scenario helper

For each scenario in selection order, delegate driving, analysis, and reporting
to [`helpers/qa-run-scenario.md`](helpers/qa-run-scenario.md) — the **one prose
home** for the driving rules (navigation-first / never URL-jump, semantic
`Then` assertion, the per-`When` write guard, mandatory evidence redaction, and
the sequential-only browser rule). Do not restate those rules here. Pass the
helper its input contract:

- **`environment`** — the resolved `{ name, baseUrl, allowWrites }` (Step 1).
- **`persona`** — the persona name **plus** the confirmed authenticated-session
  precondition from Step 2 (the helper re-verifies it on entry).
- **`scenario`** — the scenario ref (`.feature` file path and `(file, line)`).
- **`consoleAllowlist`** and **`designTokens`** — from the resolved contract.

The helper returns **one structured per-scenario result** —
`{ scenario, intent, verdict (pass | fail | blocked), surface, findings[] }`.
Collect one result per scenario for the sweep report (Step 5).

## Step 4 — Record findings onto the ledger

The per-scenario helper captures console and network per surface and turns
genuine problems into structured `F#` findings, applying the contract's
`consoleAllowlist` via
[`filterConsoleMessages`](../scripts/lib/qa/console-allowlist.js) (each
non-allowlisted console **error** becomes one finding; allowlisted patterns and
non-error levels are suppressed) and spot-checking against `designTokens` when
set. The allowlist is a **noise filter, not a security control** — never expand
it to silence a genuine error signal.

Record each returned `F#` finding as a `QaLedgerItem` on the session ledger
(shape and append-never-overwrite rule per [`helpers/qa-core.md`](helpers/qa-core.md)):
map the finding's `symptom` to the redacted `evidence`, its `surface` to
`coverage`, its `classification` onto the ledger `class` enum (a product defect
is `product-bug`, a tooling gap is `tooling-dx`, …) plus a `severity`,
`missingTest` (`null` when no gap applies), and `disposition` left untriaged.

## Step 5 — Triage the ledger, then report

Route the ledger through the shared classify → route → disposition → promote
procedure in [`helpers/qa-core.md`](helpers/qa-core.md), under its HITL write
gate: the harness MUST NOT create tickets autonomously — present the routed
dispositions and confirm each `file` / `defer` / `dismiss` before any write.

Then summarize the sweep in chat with:

- the resolved **environment** (`name → baseUrl`, and whether it is read-only)
  and the selector applied;
- the resolved scenario count, plus the **`allowWrites` exclusion count** when
  mutating scenarios were skipped on a read-only environment;
- scenario totals (passed / failed / blocked);
- findings totals by classification and the ledger routes
  (`new` / `update-existing` / `duplicate` / `regression-of-closed`);
- a per-scenario line pairing each scenario's plain-English intent with its
  verdict, grouped by feature file or domain — "what was checked → what
  happened", not a tag list;
- for each failure: the scenario name, file path, the surface it ended on, and
  a one-line user-visible symptom;
- the ledger path (under `temp/qa/`) and a pointer to any routed dispositions
  awaiting operator sign-off.

## Constraints

Beyond the shared core ([`helpers/qa-core.md`](helpers/qa-core.md): contract +
loud failure, session/ledger, redact-first, QaLedgerItem, triage, HITL gate)
and the driving rules ([`helpers/qa-run-scenario.md`](helpers/qa-run-scenario.md):
navigation-first, semantic `Then`, redaction, sequential-only), the
`/qa-run`-specific deltas are:

- **Always** resolve a target environment (Step 1) — prompt when no `<env>` is
  supplied — and **fail loudly** on an unknown name or unmatched URL; never
  silently fall back to the default.
- **Always** apply the `allowWrites` guardrail: on a read-only environment,
  exclude mutating scenarios and report the exclusion count; include them only
  on explicit in-session operator confirmation.
- **Always** sign in per persona through the environment's `signInSeam` and
  confirm the authenticated state with a post-sign-in `take_snapshot` before
  driving.
- An **empty selection is operator error**, not a passing sweep — report it and
  stop.
- **Never** expand `consoleAllowlist` to suppress genuine error signal.
- **Never** file follow-up tickets autonomously, and **never** fall back to a
  retired headless BDD runner.
