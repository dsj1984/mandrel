# Execution Reference (on-demand)

Reference-only material extracted from
[`.agents/instructions.md`](../instructions.md) so the always-loaded system
prompt stays lean (Story #4332). Nothing here is a per-task MUST — it is
detail an agent consults **only when the relevant lever is in play** (tuning
log verbosity, reasoning about the token budget). The always-loaded protocol
links here from the sections that used to inline this content.

---

## Log-level control

The orchestrator logger (`lib/Logger.js`) emits progress/trace output based on
the `AGENT_LOG_LEVEL` environment variable:

- `silent` — only `fatal` emits; useful for script embedding where the caller
  owns presentation.
- `info` — default. Emits `info` / `warn` / `error` / `fatal`.
- `verbose` — adds `debug` trace output on top of the `info` set. `debug` is
  accepted as a backward-compatible alias.

This is a diagnostic knob: set it when you need quieter script embedding
(`silent`) or a deeper trace (`verbose`). The friction-telemetry MUST it sits
under — post friction to the relevant ticket via `diagnose-friction.js` — stays
in [`instructions.md` § 1.H](../instructions.md).

---

## FinOps & token budgeting (economic guardrails)

Mandrel does **not** enforce live LLM spend from response metadata. The
framework limits **hydrated prompt size** and optional **pre-dispatch
estimates**; your host runtime (editor / CLI) owns session quota and hard
stops. Consult this section when reasoning about why a task prompt was elided
or why `/deliver` refused a fan-out on budget grounds.

### Token budget (hydration + pre-dispatch estimates)

- **`delivery.maxTokenBudget`** (`.agentrc.json`, resolved via
  `lib/config/limits.js`): caps the task prompt built by
  `hydrate-context` / `hydrateContext`. The pipeline uses a rough token
  estimate (≈4 characters per token) and applies section-aware elision
  (`elideEnvelope`) so oversized envelopes drop or summarize lower-priority
  sections before you receive the prompt.
- **`delivery.preflight.*`** (optional): before `/deliver` fan-out,
  `epic-deliver-preflight.js` compares **estimated** story count, waves,
  install time, GitHub API volume, and Claude quota tokens against configured
  ceilings (`maxClaudeQuotaTokens`, etc.). A breach surfaces via
  `agent::blocked`; there is no per-tool-call metering.
- **Host runtime**: session billing, quota exhaustion, and operator overrides
  are enforced by your provider (e.g. Claude Code), not by Mandrel scripts.
