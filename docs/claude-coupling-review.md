# Claude Coupling Inventory

This document records **where** Mandrel is coupled to Claude (the model) or
Claude Code (the host runtime). It is **evidence for**, not a revision of, the
coupling stance fixed in [ADR `20260512-coupling-stance`](decisions.md) — that
ADR remains the authoritative statement of what Mandrel deliberately couples
to. Read this file before widening the supported-host set, before touching the
projection pipeline, or when scoping a provider-agnosticism effort.

> **The verbatim file:line citation tables have been archived.** The
> point-in-time inventory taken at commit `493b3eb0` (2026-07-17) — the
> per-cluster citations, the config/schema table, and the branding sweep —
> now lives in
> [`archive/claude-coupling-review-2026-07.md`](archive/claude-coupling-review-2026-07.md).
> Those citations were **not** re-verified and a spot-check found several no
> longer landing; read them as a historical record, and re-derive from the
> current tree before acting. What remains below is the part that still binds.

---

## Headline

**There is no coupling to Claude the model.** The repository carries no
`@anthropic-ai/*` dependency, makes no Anthropic API calls, reads no
`ANTHROPIC_API_KEY`, hardcodes no model IDs in runtime logic, and contains no
prompt addressed to "Claude". The runtime is the host process, not an API
client.

All coupling is to **Claude Code the host runtime** — its filesystem
conventions (`.claude/commands/`, `.claude/agents/`, `.claude/settings.json`,
`CLAUDE.md`), its tool names (`Agent`/`subagent_type`, `AskUserQuestion`), its
env vars (`CLAUDE_CODE_*`, `CC_*`), and its hook and session semantics.

The practical consequence: **loosening the coupling is a host-adapter problem,
not an SDK-swap problem.** The seam is already drawn — the orchestration
library under `.agents/scripts/` treats the Story issue body and structured
comments as the cross-runtime contract, while the workflow / `.claude/` / hook
/ skill surface leans in on Claude Code as the in-session reference runtime.

---

## Host-integration clusters

Seven clusters carry the real coupling, ordered hardest to easiest to abstract.
Everything outside them is prose or a centralized constant.

1. **The `.claude/` projection pipeline** — the single biggest lever. The
   distribution model itself: materialize `.agents/`, then project workflows
   into `.claude/commands/` and agent definitions into `.claude/agents/`. The
   CLI, the doctor checks, the upgrade path, uninstall, and consumer bootstrap
   all orbit this projection.
2. **`Agent` / `subagent_type` dispatch semantics** — `roleScopedAgents` boots
   converted spawns on `.claude/agents/<role>.md` instead of the `CLAUDE.md`
   closure, and Claude Code nesting-depth facts are hardcoded.
   **Already mitigated:** every converted spawn falls back to
   `subagent_type: general-purpose`, documented as the escape for hosts that
   ignore `.claude/agents/`, and `roleScopedAgents: false` is a kill-switch.
3. **`claude` CLI shell-outs (review providers)** — the `security-review`,
   `codex`, and `ultrareview` providers spawn or probe the `claude` binary.
   **Already mitigated, and the pattern to copy elsewhere:** all three sit
   behind `review-provider-factory.js` with `optional: true` skip semantics and
   injectable `invokeFn` / `probeFn` / `spawnFn` seams. The `native` provider is
   fully host-agnostic.
4. **Hook, env, and session contract** — `.claude/settings.json` declares the
   harness's hook contract; remote/web detection keys entirely on
   `CLAUDE_CODE_REMOTE*`. Story #5003 removed the tool-trace hook and the
   `CC_*` propagation channel it was the only reader of.
5. **Dynamic-workflows feature gating** — a Claude Code-only, paid-plan,
   research-preview feature gated on `CLAUDE_CODE_*` env flags and a
   `not-claude-runtime` reason sentinel, with per-lens workflow blocks mirrored
   in the report-contract files.
6. **`~/.claude/projects/<repo>/memory/` reads** — planning authoring-context
   and memory-freshness both read the host's memory directory.
7. **Host tool-name assumptions in skills and schemas** — `AskUserQuestion` is
   named directly in a skill and a lifecycle schema, and the
   `mcp__chrome-devtools__*` surface is assumed by `qa-run`,
   `audit-accessibility`, and the qa-harness skill.
   **Already mitigated** for the last one: it is documented as a host-provided
   dependency that degrades with a clear error.

Two things worth recording because they look coupled and are not:

- **`DELIVERABLE_GRANULARITY_GUIDANCE`** (`ticket-validator-sizing.js`) is
  prose guidance, not a Claude-model constant. It names no model. (The
  `DEFAULT_MODEL_CAPACITY` ceiling bag that used to sit beside it went with
  Story #5312.)
- **[`.agentrc.json`](../.agentrc.json)** is clean — no model names, no
  Claude-specific keys. The `agentrc` schema already speaks in neutral terms
  ("host-LLM", "cross-runtime portability").

---

## Existing provider-agnostic seams

These already do the host-agnostic thing and are the template for extending it:

1. **`AGENTS.md` is the canonical instruction pointer**; `CLAUDE.md` is a thin
   `@AGENTS.md` importer. `AGENTS.md` is the emerging cross-tool standard.
2. **"Host's best available X" language** —
   [`.agents/instructions.md`](../.agents/instructions.md) § 1.C (live docs),
   § 4 subagents ("name no specific model — let the host and operator own the
   concrete mapping"), § 2 (the host owns quota).
3. **Ticketing provider abstraction** — `ITicketingProvider.js` +
   `provider-factory.js` (GitHub-only today, with a discriminator anticipated).
   The cleanest shape to mirror for a host adapter.
4. **Review-provider factory** — Claude-CLI adapters isolated, individually
   optional, with injectable spawn seams.
5. **`subagent_type: general-purpose` fallback** and the
   `roleScopedAgents: false` kill-switch.
6. **The cross-runtime contract** — Story issue body plus structured comments
   as the host-independent state layer.

---

## If the stance changes: suggested order

Ordered by leverage per unit of risk. This is a sketch, not a plan of record —
any real effort starts by revising ADR `20260512-coupling-stance`.

1. **Abstract the projection layer.** `sync-claude-*` becomes a host-adapter
   interface (`hosts/claude-code/` first), mirroring `providers/github/`, with
   the `.claude/` paths as one adapter's output mapping.
2. **Generalize env detection** behind a single `host-runtime` resolver
   wrapping the `CLAUDE_CODE_*` / `CC_*` vars in neutral names.
3. **Generalize `model-attribution.js`** — family map plus env-var list. Cheap;
   it is already a single choke point.
4. **Neutralize host tool names in skills** (`AskUserQuestion` → "the host's
   structured-question tool"), reusing the § 1.C live-docs phrasing.
5. **Leave the review providers alone** — already correctly isolated and
   optional.
6. **Prose sweep last** — cosmetic, and it should follow the ADR rather than
   lead it.
