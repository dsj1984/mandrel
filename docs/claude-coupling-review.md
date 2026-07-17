# Claude Coupling Inventory

**Snapshot date:** 2026-07-17 · **Commit:** `493b3eb0` · **Scope:** whole repository

This document inventories every point at which Mandrel is coupled to Claude
(the model) or Claude Code (the host runtime). It is **evidence for**, not a
revision of, the coupling stance fixed in
[ADR `20260512-coupling-stance`](decisions.md) — that ADR remains the
authoritative statement of what Mandrel deliberately couples to. Read this file
when you need to know *where* the coupling actually lives: before widening the
supported-host set, before touching the projection pipeline, or when scoping a
provider-agnosticism effort.

It is a point-in-time inventory. Treat the file:line citations as accurate as
of the commit above and re-verify before acting on them.

---

## Headline

**There is no coupling to Claude the model.** The repository carries no
`@anthropic-ai/*` dependency, makes no Anthropic API calls, holds no
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

The seven clusters below are the real coupling, ordered hardest to easiest to
abstract. Everything outside this section is prose or a centralized constant.

### 1. The `.claude/` projection pipeline — the single biggest lever

The distribution model itself: materialize `.agents/`, then project workflows
into `.claude/commands/` and agent definitions into `.claude/agents/`. The CLI
orbits this projection.

| Location | Coupling |
| --- | --- |
| [`.agents/scripts/sync-claude-commands.js`](../.agents/scripts/sync-claude-commands.js) | Projects `.agents/workflows/*` → `.claude/commands/*.md`; namespaces subpaths as `/loops:<name>` |
| [`.agents/scripts/sync-claude-agents.js`](../.agents/scripts/sync-claude-agents.js) | Projects role defs → `.claude/agents/<name>.md` for `subagent_type: <name>` |
| [`bin/mandrel.js:57`](../bin/mandrel.js) | `sync-commands` / `sync-agents` subcommands hardcode the `.claude/` targets |
| [`lib/cli/sync-commands.js`](../lib/cli/sync-commands.js), [`lib/cli/sync-agents.js`](../lib/cli/sync-agents.js) | Delegators to the two engines above |
| [`lib/cli/registry.js:224`](../lib/cli/registry.js) | Doctor checks `commands-in-sync` / `agents-in-sync`; the latter is **fatal** when `roleScopedAgents` is default-true and the tree is unmaterialized |
| [`lib/cli/update.js:743`](../lib/cli/update.js) | Upgrade + drift-heal steps regenerate both trees |
| [`lib/cli/uninstall.js:126`](../lib/cli/uninstall.js) | `revertClaudeMd`, `revertClaudeSettings`, `revertClaudeCommands` |
| [`lib/cli/doctor.js:85`](../lib/cli/doctor.js) | `context-closure` resolves the `CLAUDE.md` `@`-import graph |
| `.agents/scripts/lib/bootstrap/project-bootstrap.js` | Writes consumer `CLAUDE.md` (`SYSTEM_PROMPT_CLAUDE_MD`), wires the `.claude/settings.json` hook, injects gitignore rules |
| `.agents/scripts/lib/command-header.js` | Exists solely to satisfy Claude Code's command-frontmatter parsing |
| [`.github/workflows/install-matrix.yml:285`](../.github/workflows/install-matrix.yml) | CI asserts the projection so `doctor` reports green |
| [`.gitignore:50`](../.gitignore) | Ignore block for the generated `.claude/*` trees |

### 2. `Agent` / `subagent_type` dispatch semantics

- `delivery.routing.roleScopedAgents` — converted spawns boot on
  `.claude/agents/<role>.md` instead of the `CLAUDE.md` closure
  (`.agents/schemas/agentrc.schema.json`,
  `.agents/scripts/lib/config-settings-schema-delivery.js:181`).
- `.agents/workflows/helpers/acceptance-self-eval.md` — dispatches
  `subagent_type: acceptance-critic`, noting "Claude Code ≥ 2.1.202".
- [`.agents/instructions.md`](../.agents/instructions.md) § 4 and
  `.agents/scripts/lib/checks/subagent-agent-tool-required.js` — hardcode Claude
  Code nesting-depth facts (verified depth 2, announced max 5).

**Already mitigated:** every converted spawn falls back to
`subagent_type: general-purpose`, documented as the escape for hosts that
ignore `.claude/agents/`, and `roleScopedAgents: false` is a kill-switch.

### 3. `claude` CLI shell-outs (review providers)

- `.agents/scripts/lib/orchestration/review-providers/security-review.js` —
  `spawnSync('claude', ['--print', …])`, probes `claude --version`.
- `.agents/scripts/lib/orchestration/review-providers/codex.js` —
  `spawnSync('claude', …)`, probes `~/.claude/plugins/codex-plugin-cc`.
- `.agents/scripts/lib/orchestration/review-providers/ultrareview.js` —
  prompt-only; degrades gracefully on a non-Claude host.

**Already mitigated, and the pattern to copy elsewhere:** all three sit behind
`review-provider-factory.js` with `optional: true` skip semantics and
injectable `invokeFn` / `probeFn` / `spawnFn` seams. The `native` provider is
fully host-agnostic.

### 4. Hook, env, and session contract

- `.agents/scripts/lib/observability/tool-trace-hook.js` — invoked from
  `.claude/settings.json` `PreToolUse` / `PostToolUse`; parses the harness's
  stdin contract.
- `.agents/scripts/lib/observability/active-story-env.js` — `CC_STORY_ID`
  re-spawn semantics; `CC_EPIC_ID` / `CC_PHASE` / `CC_OPERATOR` / `CC_SLICE_ID`
  are the propagation channel throughout.
- `.agents/scripts/lib/config/runtime.js` — remote/web detection keyed entirely
  on `CLAUDE_CODE_REMOTE` and `CLAUDE_CODE_REMOTE_SESSION_ID`.

### 5. Dynamic-workflows feature gating

`.agents/scripts/lib/dynamic-workflow/capability.js` gates a Claude Code-only,
paid-plan, research-preview feature: env flags `CLAUDE_CODE_DISABLE_WORKFLOWS`,
`CLAUDE_CODE_RUNTIME`, `CLAUDE_CODE_VERSION`, `CLAUDE_CODE_PLAN`, and the
`not-claude-runtime` reason sentinel. Six `audit-*.md` workflows carry an
identical `.claude/workflows/<name>.workflow.js` block, mirrored in the
`*-report-contract.js` files.

### 6. `~/.claude/projects/<repo>/memory/` reads

- `.agents/scripts/lib/orchestration/planning/authoring-context.js:34`
- `.agents/scripts/lib/feedback-loop/memory-freshness.js:6`

### 7. Host tool-name assumptions in skills and schemas

- `AskUserQuestion` named directly in
  `.agents/skills/core/idea-refinement/SKILL.md` and
  `.agents/schemas/lifecycle/intervention.recorded.schema.json`.
- The `mcp__chrome-devtools__*` surface assumed by `qa-run`,
  `audit-lighthouse`, and the qa-harness skill — already documented as a
  host-provided dependency that degrades with a clear error.
- `.agents/skills/core/browser-testing-with-devtools/SKILL.md:50` — install
  snippet names Claude Code config and the `@anthropic/chrome-devtools-mcp`
  package.

---

## Config and schema coupling

Small and centralized — each item below is a single choke point.

| Location | Item |
| --- | --- |
| `.agents/scripts/lib/orchestration/model-attribution.js` | `deriveFamily()` recognizes only Opus/Sonnet/Haiku; env fallbacks `CLAUDE_MODEL`, `ANTHROPIC_MODEL`. The one choke point for model identity. |
| `.agents/schemas/model-attribution.schema.json:24` | Example model IDs (`claude-opus-4-7`, `claude-sonnet-4-6`) and family labels |
| `.agents/scripts/lib/observability/tool-trace-hook.js:265` | `haiku` / `sonnet` / `opus` redaction allowlist |
| `context-envelope.js:85`, `plan-context.js:49`, `checklist-threading.js:48` | The ≈4-chars/token estimate — Anthropic-flavored heuristic, provider-neutral in form |

Two things worth recording because they look coupled and are not:

- **`DEFAULT_MODEL_CAPACITY`** (`ticket-validator-sizing.js:99`) is a frozen
  authored-token ceiling bag, not a Claude-model constant. It names no model.
  Provider-neutral in substance; only the thresholds would merit revisiting
  per-provider.
- **[`.agentrc.json`](../.agentrc.json)** is clean — no model names, no
  Claude-specific keys. The `agentrc` schema already speaks in neutral terms
  ("host-LLM", "cross-runtime portability").

---

## Branding and prose

Cosmetic tier — a find-and-replace if the stance ever changes, but the ADR
should move first.

- [`package.json`](../package.json) — "Claude Code-first…" description, the
  `claude-code` keyword
- [`AGENTS.md`](../AGENTS.md), [`architecture.md`](architecture.md),
  [`.agents/docs/SDLC.md`](../.agents/docs/SDLC.md) — the coupling-stance prose
  (deliberate, ADR-governed)
- [`README.md:37`](../README.md), [`patterns.md:171`](patterns.md), the
  loop-units ADR, and roughly 25 further prose spots across `.agents/`

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
