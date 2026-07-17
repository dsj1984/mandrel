# Execution Reference (on-demand)

Reference-only material extracted from
[`.agents/instructions.md`](../instructions.md) so the always-loaded system
prompt stays lean (Story #4332). Nothing here is a per-task MUST — it is
detail an agent consults **only when the relevant lever is in play** (tuning
log verbosity, reasoning about the token budget). The always-loaded protocol
links here from the sections that used to inline this content.

---

## Friction telemetry

Reference mechanics behind the friction-telemetry MUST in
[`instructions.md` § 1.H](../instructions.md). The always-loaded core keeps the
MUST, the command, and the when-to-fire triggers; the detail below is consulted
only when reasoning about **where** a friction record lands and **how** it is
validated.

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
(`silent`) or a deeper trace (`verbose`). The friction-telemetry MUST it sits
under — capture friction as a local NDJSON signal via `diagnose-friction.js` —
stays in [`instructions.md` § 1.H](../instructions.md); its record-landing and
schema mechanics are in [§ Friction telemetry](#friction-telemetry) above.

---

## FinOps & token budgeting (economic guardrails)

Mandrel does **not** enforce live LLM spend from response metadata. It bounds
two things, both **fixed framework constants** rather than operator knobs, and
both **fail closed**: the assembled `/plan` context envelope, and plan-time
Story sizing. Your host runtime (editor / CLI) owns session quota and hard
stops. Consult this section when reasoning about why `/plan` refused an
over-ceiling envelope or an over-budget Story count.

> **There is no configurable context budget.** `planning.context.maxBytes` /
> `summaryMode` were removed outright in Story #4541, along with the
> `applyBudget` pass they fed: that pass lost its last caller in the v2
> cutover, and it was already bounding a field the envelope builders discarded
> before shipping the raw seed anyway. The schema now **rejects**
> `planning.context`, so a config carrying it fails loudly rather than silently
> capping nothing. The ceiling below is the replacement and the only live bound
> on planner-context size. Separately, `elideEnvelope` in
> `lib/orchestration/context-envelope.js` — which this section used to credit
> with limiting hydrated prompt size — has no production caller either (it is
> carried in `baselines/dead-exports-production.json`). Only `estimateTokens`
> from that module is live.

### Planner-context envelope (`/plan`)

- **`PLAN_CONTEXT_ENVELOPE_BYTE_CEILING`** (`lib/orchestration/plan-context.js`):
  256 KB (≈64K tokens at the ≈4-chars/token estimate) on the serialized
  envelope `buildPlanContext` assembles, checked at the single choke point
  every mode returns through. Measured envelopes on this repo land at ~42 KB,
  so the ceiling is >2× headroom over a worst-case seed plus a medium-tier
  codebase snapshot.
- **On refusal**, the error names the envelope's largest fields. Trim the seed,
  plan fewer `--tickets` source issues in one run, or narrow
  `planning.codebaseSnapshot`. The seed is carried **verbatim** by design — it
  is the operator's request, and summarizing it silently would degrade planning
  quality precisely when the input is richest — so there is no elision path to
  fall back on. Raising the ceiling needs a measured justification.

### Session-mass capacity (plan-time sizing)

- **`DEFAULT_MODEL_CAPACITY`** (`lib/orchestration/ticket-validator-sizing.js`):
  absolute authored-token ceilings for plan-time Story sizing (soft 30k /
  hard 75k). Not operator-configurable via `.agentrc.json`; programmatic
  override via `opts.modelCapacity` on validateTickets / runPlanPersist only.
- **Host runtime**: session billing, quota exhaustion, and operator overrides
  are enforced by your provider (e.g. Claude Code), not by Mandrel scripts.
