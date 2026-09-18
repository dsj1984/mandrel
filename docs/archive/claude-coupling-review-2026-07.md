# Archived Claude coupling inventory — 2026-07

**Snapshot date:** 2026-07-17 · **Commit:** `493b3eb0` · **Scope:** whole repository

Verbatim citation tables relocated out of
[`docs/claude-coupling-review.md`](../claude-coupling-review.md) by Story #4925.
This is the **evidence record** for
[ADR `20260512-coupling-stance`](../decisions.md) — archived, never deleted. The
live doc keeps the findings that still bind; this file keeps the point-in-time
file:line proof they rested on.

> **These citations are stale by design.** They were accurate at commit
> `493b3eb0` on 2026-07-17 and have **not** been re-verified since. A
> 2026-08 spot-check of 16 citations found **6 no longer landing** — files
> moved, line numbers drifted, and at least one cited surface was retired
> outright. Treat every `path:line` below as a historical pointer, not a
> lookup. Re-derive from the current tree before acting on any of it.

**Edits made during relocation.** Prose is word-for-word as it stood in
`docs/claude-coupling-review.md`. Two mechanical changes only:

1. **Link re-rooting** — relative links were re-pointed one level up so they
   still resolve from this directory (`../.agents/…` → `../../.agents/…`,
   `decisions.md` → `../decisions.md`, and so on).
2. **One bullet was lifted, not copied.** The `mcp__chrome-devtools__*`
   host-dependency bullet from § 7 stayed in the live doc rather than moving
   here, because it still binds current code — and the retired lens it cited
   is corrected there to `audit-accessibility`, the WCAG lens that replaced
   it wholesale.

---

## Host-integration clusters — the citations

The seven clusters, ordered hardest to easiest to abstract. Cluster *names* and
their still-live "Already mitigated" notes remain in
[the live doc](../claude-coupling-review.md); the file:line evidence is below.

### 1. The `.claude/` projection pipeline — the single biggest lever

The distribution model itself: materialize `.agents/`, then project workflows
into `.claude/commands/` and agent definitions into `.claude/agents/`. The CLI
orbits this projection.

| Location | Coupling |
| --- | --- |
| [`.agents/scripts/sync-claude-commands.js`](../../.agents/scripts/sync-claude-commands.js) | Projects `.agents/workflows/*` → `.claude/commands/*.md`; namespaces subpaths as `/loops:<name>` |
| [`.agents/scripts/sync-claude-agents.js`](../../.agents/scripts/sync-claude-agents.js) | Projects role defs → `.claude/agents/<name>.md` for `subagent_type: <name>` |
| [`bin/mandrel.js:57`](../../bin/mandrel.js) | `sync-commands` / `sync-agents` subcommands hardcode the `.claude/` targets |
| [`lib/cli/sync-commands.js`](../../lib/cli/sync-commands.js), [`lib/cli/sync-agents.js`](../../lib/cli/sync-agents.js) | Delegators to the two engines above |
| [`lib/cli/registry.js:224`](../../lib/cli/registry.js) | Doctor checks `commands-in-sync` / `agents-in-sync`; the latter is **fatal** when `roleScopedAgents` is default-true and the tree is unmaterialized |
| [`lib/cli/update.js:743`](../../lib/cli/update.js) | Upgrade + drift-heal steps regenerate both trees |
| [`lib/cli/uninstall.js:126`](../../lib/cli/uninstall.js) | `revertClaudeMd`, `revertClaudeSettings`, `revertClaudeCommands` |
| [`lib/cli/doctor.js:85`](../../lib/cli/doctor.js) | `context-closure` resolves the `CLAUDE.md` `@`-import graph |
| `.agents/scripts/lib/bootstrap/project-bootstrap.js` | Writes consumer `CLAUDE.md` (`SYSTEM_PROMPT_CLAUDE_MD`), wires the `.claude/settings.json` hook, injects gitignore rules |
| `.agents/scripts/lib/command-header.js` | Exists solely to satisfy Claude Code's command-frontmatter parsing |
| [`.github/workflows/install-matrix.yml:285`](../../.github/workflows/install-matrix.yml) | CI asserts the projection so `doctor` reports green |
| [`.gitignore:50`](../../.gitignore) | Ignore block for the generated `.claude/*` trees |

### 2. `Agent` / `subagent_type` dispatch semantics

- `delivery.routing.roleScopedAgents` — converted spawns boot on
  `.claude/agents/<role>.md` instead of the `CLAUDE.md` closure
  (`.agents/schemas/agentrc.schema.json`,
  `.agents/scripts/lib/config-settings-schema-delivery.js:181`).
- `.agents/workflows/helpers/acceptance-self-eval.md` — dispatches
  `subagent_type: acceptance-critic`, noting "Claude Code ≥ 2.1.202".
- [`.agents/instructions.md`](../../.agents/instructions.md) § 4 and
  `.agents/scripts/lib/checks/subagent-agent-tool-required.js` — hardcode Claude
  Code nesting-depth facts (verified depth 2, announced max 5).

### 3. `claude` CLI shell-outs (review providers)

- `.agents/scripts/lib/orchestration/review-providers/security-review.js` —
  `spawnSync('claude', ['--print', …])`, probes `claude --version`.
- `.agents/scripts/lib/orchestration/review-providers/codex.js` —
  `spawnSync('claude', …)`, probes `~/.claude/plugins/codex-plugin-cc`.
- `.agents/scripts/lib/orchestration/review-providers/ultrareview.js` —
  prompt-only; degrades gracefully on a non-Claude host.

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

---

## Branding and prose

Cosmetic tier — a find-and-replace if the stance ever changes, but the ADR
should move first.

- [`package.json`](../../package.json) — "Claude Code-first…" description, the
  `claude-code` keyword
- [`AGENTS.md`](../../AGENTS.md), [`architecture.md`](../architecture.md),
  [`docs/SDLC.md`](../SDLC.md) — the coupling-stance prose
  (deliberate, ADR-governed)
- [`README.md:37`](../../README.md), [`patterns.md:171`](../patterns.md), the
  loop-units ADR, and roughly 25 further prose spots across `.agents/`
