# Execution Reference (on-demand)

Reference-only material extracted from
[`.agents/instructions.md`](../instructions.md) so the always-loaded system
prompt stays lean (Story #4332). Nothing here is a per-task MUST — it is
detail an agent consults **only when the relevant lever is in play** (tuning
log verbosity, reasoning about the token budget). The always-loaded protocol
links here from the sections that used to inline this content.

---

## Friction telemetry

Reference mechanics behind the optional friction-telemetry tool pointed at
from [`instructions.md` § 1.H](../instructions.md). Capture is a **tool, not a
mandate** — reach for `diagnose-friction.js` when a wrapped command's failure
shape is worth attributing; the detail below is consulted only when reasoning
about **where** a friction record lands and **how** it is validated.

- **Canonical record + schema validation**: `diagnose-friction.js` appends one
  `kind: friction` record, validated write-time against
  `signal-event.schema.json`, to the per-run/per-Story `signals.ndjson`
  stream on local disk (under `temp/run-<id>/`). The retro roll-up reads that
  stream back to aggregate
  friction into routed proposals; nothing is posted to the GitHub ticket at
  capture time.
- **Standalone context**: Outside a delivery run there is no `temp/run-<id>/`
  stream to anchor to, so the record lands on the **standalone signal stream**
  (`temp/standalone/stories/story-<sid>/signals.ndjson`) under the same
  canonical schema.
- **Never silently dropped**: The signal is never silently dropped — a
  best-effort write failure is logged, not swallowed into a promise of a
  side-file that no reader consumes.

---

## Durable local slash commands

Reference mechanics behind the local-override pointer in
[`instructions.md` § 1.E](../instructions.md). Any `.md` at
`.agents/local/workflows/<name>.md` is projected into
`.claude/commands/<name>.md` by `sync-claude-commands.js` as `/<name>`. The
`.agents/local/` subtree is exempt from `mandrel sync`'s prune pass, so these
commands survive `npm install`, `mandrel sync`, and `mandrel update`. A core
payload command of the same basename wins — the local copy is ignored with a
`shadowed` warning.

---

## Log-level control

The orchestrator logger (`lib/Logger.js`) emits progress/trace output based on
the `AGENT_LOG_LEVEL` environment variable:

- `silent` — only `fatal` emits; useful for script embedding where the caller
  owns presentation.
- `info` — default. Emits `info` / `warn` / `error` / `fatal`.
- `verbose` — adds `debug` trace output (`Logger.debug`) on top of the `info`
  set.

Unrecognized `AGENT_LOG_LEVEL` values fall back to `info`. There is no
`debug` level alias.

This is a diagnostic knob: set it when you need quieter script embedding
(`silent`) or a deeper trace (`verbose`). This table is the SSOT for the
levels; the optional friction-capture tool it sits beside is pointed at from
[`instructions.md` § 1.H](../instructions.md), and that tool's record-landing
and schema mechanics are in [§ Friction telemetry](#friction-telemetry) above.

---

## FinOps & token budgeting (economic guardrails)

Mandrel does **not** enforce live LLM spend from response metadata. It bounds
two things, both **fixed framework constants** rather than operator knobs, and
both **fail closed**: the assembled `/mandrel-plan` context envelope, and plan-time
Story sizing. Your host runtime (editor / CLI) owns session quota and hard
stops. Consult this section when reasoning about why `/mandrel-plan` refused an
over-ceiling envelope or an over-budget Story count.

> **There is no configurable context budget.** `planning.context.maxBytes` /
> `summaryMode` were removed outright in Story #4541, along with the
> `applyBudget` pass they fed: that pass lost its last caller in the v2
> cutover, and it was already bounding a field the envelope builders discarded
> before shipping the raw seed anyway. The schema now **rejects**
> `planning.context`, so a config carrying it fails loudly rather than silently
> capping nothing. The ceiling below is the replacement and the only live bound
> on planner-context size. Separately, the `ContextEnvelope` SDK this section
> used to credit with limiting hydrated prompt size had no production caller
> and was deleted in Story #5005; only its `estimateTokens` helper survived,
> now private to `lib/audit-suite/checklist-threading.js` (Story #5312 deleted
> `spec-spill.js` with the Spec token budget).

### Planner-context envelope (`/mandrel-plan`)

- **`PLAN_CONTEXT_ENVELOPE_BYTE_CEILING`** (`lib/orchestration/plan-context.js`):
  256 KB (≈64K tokens at the ≈4-chars/token estimate) on the serialized
  envelope `buildPlanContext` assembles, checked at the single choke point
  every mode returns through. A measured seed-mode envelope on this repo's
  thin `.feature` corpus is ~120 KB — `docsContext` (~63 KB) and
  `systemPrompts` (~54 KB) are the bulk of the fixed floor, every other field
  under 1 KB. That is **not** representative of every consumer: Story #4977
  measured `bddScenarios` at 118 KB on a consumer with a mature Gherkin
  corpus — larger than `docsContext` and `systemPrompts` combined, leaving
  ~5.5% headroom instead of ~2×. `bddScenarios` is now truncated to
  `BDD_SCENARIOS_BYTE_BUDGET` (`lib/bdd-scenario-budget.js`, ≤24 KB,
  reported via `truncated` / `totalScenarios` / `includedScenarios` rather
  than silently dropped) before it reaches the envelope, deliberately a fixed
  framework constant rather than an `.agentrc.json` knob — the same reasoning
  Story #4811 applied when it retired the codebase snapshot. The
  operator-supplied seed remains the one field with no cap and no elision
  path.
- **On refusal**, the error names the envelope's largest fields and the
  remedy that follows the single largest one (`OVERSIZE_FIELD_REMEDIES` in
  `plan-context.js`) — trim the seed, plan fewer `--tickets` source issues in
  one run, or trim `docsContextFiles`, depending on which field actually blew
  the budget. The seed itself is carried **verbatim** by design — it is the
  operator's request, and summarizing it silently would degrade planning
  quality precisely when the input is richest — so it alone has no elision
  path to fall back on. Raising the ceiling needs a measured justification.

### Session-mass capacity (plan-time sizing)

- **Retired (Story #5312).** `DEFAULT_MODEL_CAPACITY` and the plan-time
  Story sizing ceilings are gone: a Story is as large as the work needs, and
  nothing at plan time scores its authored mass.
- **Host runtime**: session billing, quota exhaustion, and operator overrides
  are enforced by your provider (e.g. Claude Code), not by Mandrel scripts.
