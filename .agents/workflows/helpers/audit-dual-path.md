# Audit lens execution strategy (dual-path)

> **Single source for the dual-path preamble (Story #4625).** Every lens whose
> `## Execution strategy (dual-path)` section points here shares this exact
> contract. Read `audit-<lens>` and
> `.claude/workflows/audit-<lens>.workflow.js` below as this lens's own name.

A lens that references this helper runs along one of two execution paths. Both
emit the **identical** report contract (the lens's Output Requirements step);
downstream consumers (`audit-to-stories`) are agnostic to which path produced
it.

- **Orchestrated (dynamic-workflow) path.** When Claude Code's
  [dynamic workflows](https://code.claude.com/docs/en/workflows) are
  available, the saved project workflow
  `.claude/workflows/audit-<lens>.workflow.js` fans the lens's dimensions out
  as parallel read-only subagents, runs an **adversarial cross-check** stage
  (an independent agent reviews each dimension's findings and drops false
  positives before they enter the report), then synthesises the report. The
  orchestrator derives its per-dimension prompts from the *lens* markdown at
  run time — the lens stays the single source of truth; the script does not
  fork a second copy of the spec.
- **Sequential (single-pass) path.** When dynamic workflows are unavailable,
  follow the lens's Steps turn-by-turn exactly as before. This is the default
  fallback and changes nothing about the existing behaviour.

**Strategy selection** is computed by
[`lib/dynamic-workflow/capability.js`](../../scripts/lib/dynamic-workflow/capability.js)
(`selectAuditStrategy`). The orchestrated path is chosen only when the runtime
is Claude Code, `disableWorkflows` is not set (settings.json **or**
`CLAUDE_CODE_DISABLE_WORKFLOWS`), and the Claude Code version meets the
research-preview floor (`>= 2.1.154`). Any other runtime, a disabled setting,
or an older version degrades gracefully to the sequential path.

> **Capability degradation, not a contract shim.** This dual path is **not**
> covered by the No-Shim / hard-cutover rule in
> [`git-conventions.md`](../../rules/git-conventions.md). That rule forbids
> running two shapes of the *same contract* side by side. Here there is **one**
> report contract; only the *execution strategy* is selected from a runtime
> capability — the same pattern the protocol already endorses for live-docs
> fallback in [`instructions.md` §1.C/§1.D](../../instructions.md). The full
> capability-degradation rationale lives in the
> [`capability.js`](../../scripts/lib/dynamic-workflow/capability.js) module
> docstring; the orchestrated-run evidence and per-lens cost/precision gate
> verdicts live in [`docs/roadmap.md`](../../../docs/roadmap.md) (Part 3 —
> Dynamic-Workflow Orchestration).

**Forcing a path (for testing).** Set `MANDREL_AUDIT_STRATEGY=sequential` to
verify the fallback path with the feature notionally disabled, or
`MANDREL_AUDIT_STRATEGY=orchestrated` to pin the dynamic path. To exercise the
real disable signals instead, set `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (env) or
`disableWorkflows: true` in `.claude/settings.json` and re-run the lens — both
degrade to the sequential path.

> **Read-only on both paths.** The lens is read-only (see its Constraint). The
> orchestrated subagents run in `acceptEdits` and inherit the session tool
> allowlist, but the workflow script grants the analysis agents only
> read/search tools (`Read`, `Grep`, `Glob`) — no write/edit/shell-mutation
> tools. The single write in an orchestrated run is the final report artifact.
