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

Mandrel does **not** enforce live LLM spend from response metadata. The
framework limits **hydrated prompt size** via section-aware elision
(`elideEnvelope`) and optional **pre-dispatch estimates**; your host
runtime (editor / CLI) owns session quota and hard stops. Consult this
section when reasoning about why a task prompt was elided or why `/deliver`
refused a fan-out on budget grounds.

### Session-mass capacity (plan-time sizing)

- **`DEFAULT_MODEL_CAPACITY`** (`lib/orchestration/ticket-validator-sizing.js`):
  absolute authored-token ceilings for plan-time Story sizing (soft 30k /
  hard 75k). Not operator-configurable via `.agentrc.json`; programmatic
  override via `opts.modelCapacity` on validateTickets / runPlanPersist only.
- **Host runtime**: session billing, quota exhaustion, and operator overrides
  are enforced by your provider (e.g. Claude Code), not by Mandrel scripts.
