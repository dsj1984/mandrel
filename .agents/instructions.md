# Agent Execution Protocol

You are operating under the Agent Execution Protocol. Your behavior, technical
constraints, and operational context are governed by this central instruction
set. You MUST strictly adhere to the following rules:

---

## 1. System Guardrails & Initialization

### A. Role Framing (no persona packs)

v2 has **no** `.agents/personas/` packs and **no** `persona::*` GitHub labels.
Behavioral constraints come from this file, always-on / on-demand rules, and
skills. Role-scoped spawn contexts (when used) live under `.agents/agents/`
via `delivery.routing.roleScopedAgents`. QA auth identities (`qa.personas`)
are a separate fixture concept — not agent behavior packs.

If a user says "act as [role]" in chat, apply the matching skill / workflow
guidance (e.g. QA skills for verification work, security skill for threat
modeling) rather than looking for a persona file.

### B. Skill Activation

The skill library uses a **two-tier architecture**:

- **`core/`** — Universal, process-driven skills that apply across any project
  (e.g., `core/debugging-and-error-recovery`, `core/code-review-and-quality`,
  `core/security-and-hardening`). Always check for a relevant core skill first.
  The **test-first** discipline (TDD cycle, Prove-It Pattern, good-test style,
  property-based technique) lives in
  [`rules/testing-standards.md`](rules/testing-standards.md), not a skill.
- **`stack/`** — Tech-stack-specific skills for concrete tools (e.g.,
  `stack/qa/playwright`, `stack/qa/vitest`, `stack/qa/gherkin-authoring`).
  Apply these when the project uses that specific technology. For third-party
  library and framework knowledge not covered here, use the live-docs lookup
  mandated in § 1.C rather than a frozen in-repo cache.

When a task involves a specific domain or technology, you MUST read the
corresponding `.agents/skills/[tier]/[category]/[skill-name]/SKILL.md` file and
apply its constraints. A `SKILL.md` leads with its **Policy Capsule** — the
contract, and the whole cost of activating the skill — followed by pointers
into an on-demand `reference.md` sibling holding the long-form material
(patterns, worked examples, checklists). This is the same split the always-on
rules use (§ 1.F): read the capsule on activation, and open a `reference.md`
section only when the task actually engages it. Review the skill's `examples/`
directory or `examples.md` sibling **when present and relevant** to the task —
most skills do not ship one, so do not probe blindly. When uncertain which skill applies,
match the task against the one-line `description` in each skill's frontmatter
(catalogued in `.agents/skills/skills.index.json`). Skills compose: a complete
feature typically flows `idea-refinement` → the `/plan` workflow →
implementation test-first (`rules/testing-standards.md`) →
`code-review-and-quality` — not every task needs every skill. The always-on
operating posture (surface assumptions, manage confusion, push back on flawed
approaches, verify don't assume) is governed by § 3–4 and § 1.I of this file.

### C. Proactive Documentation

You MUST use the host's best available live-documentation mechanism
proactively to prevent hallucination — for example a docs MCP server such as
Context7 when the host has it wired in, an IDE-native docs lookup, or any
equivalent live-docs surface the host exposes.

- **Mandatory Usage:** For any code generation, project setup, or complex
  configuration involving third-party libraries, fetch the latest official
  documentation **before** writing code. Do not ask for permission.
- **Fallback Order:** If no live-docs mechanism is available, fall back to (1)
  in-repo docs and the package's bundled `README.md`/`CHANGELOG.md`, then
  (2) the host's web fetch/search tool. Note in your work log which channel
  you used so reviewers can spot stale references.

### D. Error Handling & Degradation

If any protocol file (Persona, Skill, or rule) cannot be loaded, you MUST
alert the user using the following warning format before proceeding:

> ⚠️ **Agent Protocol Warning**
>
> - **Missing:** `[file or tool]`
> - **Impact:** [Description]
> - **Fallback:** [Description]

State mutations (label transitions, cascade completion, structured comments)
are performed via the in-repo CLI scripts under `.agents/scripts/`
(`update-ticket-state.js`, `post-structured-comment.js`, …). Use those
directly — there is no separate state-mutation MCP server to degrade from.

### E. Local Overrides

If a `.agents/instructions.local.md` file or `.agentrc.local.json` is present,
you MUST load them. They contain personal developer preferences and
environment variables that override project defaults. The config resolver
deep-merges `.agentrc.local.json` over `.agentrc.json` (local wins; absent
local file is a no-op). Do not modify these local files unless requested.

**Durable slash commands.** Any `.md` file placed at
`.agents/local/workflows/<name>.md` is automatically projected into
`.claude/commands/<name>.md` by `sync-claude-commands.js`, making it
invocable as `/<name>`. Because the entire `.agents/local/` subtree is
exempt from `mandrel sync`'s prune pass, these commands survive
`npm install`, `mandrel sync`, and `mandrel update` with no manual
re-sync. Core payload commands of the same basename always win (the
local copy is ignored with a `shadowed` warning).

### F. Modular Global Rules

The `.agents/rules/` directory is split into an **always-on core** and an
**on-demand set** — the same read-when-relevant pattern skills use (§ 1.B).
The core loads into every session; the on-demand rules are read only when the
task actually engages them, so a generic task (and every subagent it spawns)
does not re-pay their bytes on every turn.

- **Always-on core** (loaded alongside this file):
  - [`rules/security-baseline.md`](rules/security-baseline.md) — inviolable
    security MUSTs; applies to every piece of code generated.
  - [`rules/git-conventions.md`](rules/git-conventions.md) — the always-on git
    core (branch shapes, commit-subject format, `refs #`, push/hygiene MUSTs);
    every commit, branch, and PR touches it.

- **On-demand** — read the file **before** doing the matching work; each opens
  with a one-line "this rule applies when…" scope header, so skimming its first
  paragraph confirms whether it governs the task at hand:
  - [`rules/git-conventions-reference.md`](rules/git-conventions-reference.md)
    — the git-history mechanics the core summarizes: hard-cutover policy, the
    push-hook false-negative signature, shared-checkout contention, the
    docs-freshness gate, and `meta::*` routing labels.
  - [`rules/shell-conventions.md`](rules/shell-conventions.md) — before
    chaining shell commands or writing cross-platform command strings.
  - [`rules/testing-standards.md`](rules/testing-standards.md) — before
    authoring or restructuring tests (the three-tier pyramid, assertion
    placement, mocking/isolation MUSTs).
  - [`rules/orchestration-error-handling.md`](rules/orchestration-error-handling.md)
    — before writing or modifying orchestration scripts under
    `.agents/scripts/**`.
  - [`rules/ci-remediation.md`](rules/ci-remediation.md) — before remediating
    a red (or repeatedly slow) CI check during delivery (the root-cause-only
    triage decision tree, the never-rerun / never-quarantine prohibitions,
    and the escalation criteria).
  - [`rules/api-conventions.md`](rules/api-conventions.md),
    [`rules/gherkin-standards.md`](rules/gherkin-standards.md),
    [`rules/changelog-style.md`](rules/changelog-style.md),
    [`rules/test-seams.md`](rules/test-seams.md) — when the task is in that
    domain (API surface, Gherkin scenarios, changelog prose, test seams).

When in doubt, read the rule — the read is cheap relative to shipping a
MUST-violating change. Precedence between a rule and any other governance
document is unchanged (§ 1.K): loading a rule on demand does not lower its
authority.

### G. Structured Configuration

Refer to `.agentrc.json` to understand your operational limits (e.g., allowed
auto-run permissions, default personas). For the project's specific
technology choices (database, ORM, API framework, auth provider, validation
library, workspace paths), refer to the project's Tech Stack inventory: a
dedicated `docs/tech-stack.md` when present (the single-ownership convention),
otherwise the **Tech Stack** section of `docs/architecture.md` (a numbered or
decorated heading such as `## 1. Tech Stack` is fine). Project-specific
technology context is intentionally kept out of `.agentrc.json`.

### H. Observability & Friction Telemetry

You MUST log telemetry about operational difficulty or automation
opportunities you hit. Friction is a **local NDJSON signal**:
`diagnose-friction.js` appends one `kind: friction` record to the per-run/
per-Story `signals.ndjson` stream on local disk — not posted to the ticket at
capture time; the retro phase surfaces the aggregate as routed proposals.

- **Command**:
  `node .agents/scripts/diagnose-friction.js --story [STORY_ID] --cmd [FAILED_COMMAND]`
- **When to fire**: after repeated tool-validation errors, an unrecoverable
  command failure, ambiguity needing self-correction, or repetitive
  boilerplate steps a workflow/skill could simplify.

The schema validation, the standalone stream path, and the
never-silently-dropped guarantee are reference detail — see
[`docs/execution-reference.md` § Friction telemetry](docs/execution-reference.md#friction-telemetry).

#### Log Level Control

The orchestrator logger honors `AGENT_LOG_LEVEL` (`silent` / `info` /
`verbose`). The per-level emission table is reference detail — see
[`docs/execution-reference.md` § Log-level control](docs/execution-reference.md#log-level-control).

### I. Anti-Thrashing Protocol

You MUST proactively identify when you are "thrashing" or stuck in an
infinite loop, and you MUST stop, summarize the blockers, and present a
**Re-Plan** (or yield to the user) before consuming more tokens on a failing
strategy. Use the qualitative cues below — there are no numeric thresholds
because none of the framework code increments a counter or fires at a
boundary; the call is yours to make.

- **Failure cluster**: You have run a handful of tool calls in a row that
  returned errors of the same shape. The remediation is the same each time,
  and the next attempt is unlikely to surface new information. Stop.
- **Research drift**: You are several steps into reading code or
  documentation without writing or modifying anything, and the additional
  reads are no longer narrowing the problem space. Stop and propose a plan
  with the information you have.
- **Same fix, same failure**: You have applied the same kind of fix more
  than once for the same error class, and the failure mode hasn't changed.
  Stop — the diagnosis is wrong.

When you stop, write a one-paragraph summary of what you tried, what
recurred, and what assumption you would test next, then either Re-Plan or
hand back to the operator. Do not paper over the loop with another
just-in-case retry.

While executing as a Story delivery sub-agent (via `helpers/deliver-story`),
if you genuinely cannot proceed you MUST transition to `agent::blocked` and
exit non-zero — **never fall silent**. A stalled child that reports nothing
is indistinguishable from a dead one, and the parent `/deliver` run can only
escalate what you surface.

### J. HITL Blocker Escalation (Safe Execution)

Before executing any task, you MUST check the ticket labels and instructions
for high-risk operations.

- **`risk::high` is metadata**: treat it as planning/audit signal only. It
  does **not** create an automatic runtime pause.
- **Single runtime pause point**: `agent::blocked` is the authoritative HITL
  gate. When execution encounters an unresolvable blocker or an unsafe
  destructive action without explicit authorization, transition to
  `agent::blocked`, summarize the blocker, and wait for operator resume.
- **Resume contract**: continue only after the operator explicitly unblocks
  (`agent::executing` or equivalent workflow instruction).
- **High-risk heuristic**: use `planning.riskHeuristics` from
  `.agentrc.json` to decide when to escalate via `agent::blocked`. Typical
  triggers include destructive/irreversible data mutations, shared
  auth/security changes, CI/CD gate changes, monorepo-wide rewrites, and
  destructive schema migrations.

### K. Precedence & Conflict Resolution

The governance documents you load are layered. When two of them conflict,
resolve by this **total ordering** (higher wins):

1. **Local overrides** — `.agents/instructions.local.md` / `.agentrc.local.json`
   (§ 1.E).
2. **This file** — `.agents/instructions.md`.
3. **Global rules** — `.agents/rules/*.md` (§ 1.F).
4. **Skills** — `.agents/skills/**/SKILL.md` (§ 1.B).

Two carve-outs refine the ordering:

- **More specific wins within a tier.** When two documents in the **same**
  tier overlap, the narrower, more-specific statement governs the broader one
  (e.g. a stack-specific skill refines a general core skill; a per-rule
  statement refines a cross-rule one).
- **`rules/security-baseline.md` is inviolable.** No skill or local override
  may relax a security MUST. A security constraint that conflicts with any
  lower-tier guidance — or with a local override — always wins, regardless of
  its tier position above.

---

## 2. FinOps & Token Budgeting (Economic Guardrails)

Mandrel does **not** enforce live LLM spend from response metadata, and it has
no operator-tunable context budget. What it does bound are fixed framework
ceilings — the `/plan` context envelope and plan-time Story sizing — and they
**fail closed** with a message naming what to trim, rather than silently
handing the model a truncated context. Your host runtime owns session quota and
hard stops. The constants, the ≈4-char/token estimate, and the trim options are
reference detail — see
[`docs/execution-reference.md` § FinOps & token budgeting](docs/execution-reference.md#finops--token-budgeting-economic-guardrails).
Consult it when `/plan` refused an over-ceiling envelope or an over-budget
Story count.

---

## 3. Core Philosophy

1. **Context First:** Before proposing any solution, understand the
   repository's tech stack, historical context, and structure.
   - **Digest-first Reading (Story #4433)** — stated once here; it governs
     every call site. **Never ingest the whole `project.docsContextFiles` set
     up front.** Read the **docs digest** — a compact outline (path, byte
     size, heading outline with line numbers, and the first paragraph under
     each `##`) built from those files — decide which docs bear on the task at
     hand, then **pull the full file on demand**, jumping to the section at
     the line number the digest names. This is a hard cutover: no
     read-every-file branch is retained on any path.

     The call sites differ only in how the digest reaches you — the
     discipline above is identical for all of them:
     - `/plan` and interactive tasks — a file at `temp/run-<id>/docs-digest.md`
       (`plan-context.js`, via the shared generator in
       `.agents/scripts/lib/orchestration/docs-digest.js`).
     - `/deliver` Story sub-agents (`helpers/deliver-story`) — the
       `docsDigestPath` the caller threads.
     - Standalone-Story planning (`story-plan.js --emit-context`) — inline as
       `corpusContext.docsDigest` (no per-run directory to anchor a
       file), alongside `corpusContext.relevantSections`.

     When no digest exists for the task at hand — an ad hoc task outside
     `/deliver`, `project.docsContextFiles` unset, or a null `docsDigestPath` —
     there is **no mandatory docs read**: read a full doc only when the task's
     own context points you at one.

     The decisions log (`decisions.md`) may be either a single-file
     dated-entry log or an **index** into a `decisions/` ADR directory — both
     are first-class layouts (see
     [`skills/core/documentation-and-adrs`](skills/core/documentation-and-adrs/SKILL.md)).
     Treat an index like any other digested doc: link-follow the per-ADR
     bodies on demand rather than auto-loading them.
   - **Conditional Reads**: When the task touches UI copy, layout, or
     routing and the corresponding file is present in the project, also
     read `docs/style-guide.md` and `docs/web-routes.md`. Skip both when
     absent or unrelated to the task — they are not part of the universal
     mandatory set.
   - **Story Context**: Additionally, read the current Story's body — the
     inline `## Spec` plus its `acceptance[]` / `verify[]` entries — and
     the task-specific instructions.
   - **Optimization**: For large projects, prioritize targeted retrieval
     (semantic code search or focused text search) to isolate specific
     schemas or decisions before reading broad files.
2. **Plan First:** For non-trivial tasks (3+ steps or architectural
   decisions), enter **Plan Mode**. Update the Story's `## Spec`
   (via `/plan`) or create a new Technical Specification document
   in the `docs/` root (if not already handled by a ticket) before
   touching code.
3. **Artifacts over Chat:** Create log files for test results, build
   outputs, or debug sessions rather than pasting large code blocks in
   chat.
4. **Idempotency:** Ensure scripts and commands can be run multiple times
   without breaking the environment.
5. **Security First:** Never hardcode secrets. Use environment variables
   and validate with secret scanning tools.

---

## 4. Execution & Quality Discipline

- **Re-Plan on Failure:** If a strategy fails, **STOP** and re-plan
  immediately. Do not repeat a broken approach.
- **Subagent Strategy:** Spawning a subagent is not free — each spawn
  re-pays the full always-loaded context, so treat it as a cost decision,
  not a reflex. Prefer an **inline search** (grep, a targeted read) for
  small or localized lookups where you already know roughly where to look;
  reach for a subagent **only when the work is large enough to justify
  replicating context** — a broad multi-file investigation, a parallel
  exploration front, or an isolated task that would otherwise crowd the main
  context window. One objective per subagent. When the host exposes a
  cheaper or faster capability, prefer it for **mechanical or read-only**
  spawns (search, doc regeneration, lint, log triage) and keep
  **implementation and design** work on the default capability; name no
  specific model — let the host and operator own the concrete mapping.
  **Depth compounds the cost.** Sub-agents now carry the `Agent` tool and
  can nest further (verified depth 2, announced max depth 5; see
  [#2870](https://github.com/dsj1984/mandrel/issues/2870)), so this
  spend-per-spawn caution is not one-level — **every** nesting level
  re-pays the full always-loaded context. Weigh the whole subtree's cost,
  not just the immediate spawn, before opening a deeper orchestration
  level, and stay within the supported depth envelope.
- **Anti-Laziness:** NEVER use placeholder comments like
  `// ... existing code ...`, `/* rest of file */`, or
  `// implementation here`. You MUST output the ENTIRE file or the ENTIRE
  complete function so it can be safely written to disk.
- **No Dead Code:** Remove unused imports, commented-out code, and dead
  branches before finalizing a file.
- **Lint Compliance:** Adhere strictly to project linters and formatters.
  Language- and stack-specific quality rules (TypeScript strictness,
  accessibility scans, framework conventions) live in their respective
  `stack/` skills and `.agents/rules/` files — apply them when the relevant
  skill is activated.
- **Verification:** Include explicit verification steps in every plan.

---

## 5. Git & Story Protocol (Strict Standards)

To maintain a clean and readable repository history, you MUST follow these
strict conventions for all Story-related Git operations. See
[`.agents/rules/git-conventions.md`](rules/git-conventions.md) for the full
canonical reference.

### A. Branch Naming (Canonical)

v2 delivery uses one branch shape. The runtime creates and maintains it
via `single-story-init.js`; agents commit on that branch only.

| Purpose         | Format            | Owner                   | Notes                                                                 |
| --------------- | ----------------- | ----------------------- | --------------------------------------------------------------------- |
| Story execution | `story-<storyId>` | `single-story-init.js`  | Per-Story worktree at `.worktrees/story-<storyId>/`. PR target is `main` (squash + required checks). There is no `epic/<id>` integration branch and no `--no-ff` wave merge. |

- **Verification**: After `single-story-init.js` returns, confirm
  `git branch --show-current` reports `story-<storyId>` before making any
  commits. If it does not, **STOP** and re-init.

### B. Status Tracking & Commit Standards

Administrative state mutations in the v5 model are performed via GitHub
labels. Do NOT manually update issue descriptions or status fields unless
prompted.

- **Sync Tool**:
  `node .agents/scripts/update-ticket-state.js --ticket [ID] --state [STATUS]`
- **Status Labels**: `agent::ready`, `agent::executing`, `agent::done`.

### C. History Hygiene

Every Story reaches `main` via its own PR (`story-<id>` → squash + required
checks). `helpers/deliver-story` / `single-story-close.js` open that PR;
there is no Epic integration branch and no in-script push to `main`.

### D. Ticket hierarchy (Story-only)

v2 collapses the ticket model to **Story**. Acceptance criteria and
verification steps live inline on the Story body (`acceptance[]` /
`verify[]`); the folded Tech Spec lives inline in `## Spec` (over-budget
Specs fail closed — split or tighten; never write under `docs/`). Optional
`depends_on` edges order rare multi-Story runs — and, because `/deliver`
resolves them from live state, they order Stories **across plan runs and
over time**, not just within one batch.

- `/plan` emits one or more `type::story` issues (default N=1). There is no
  batch label: `/deliver` takes ids and discovers the graph.
- Each Story is executed by `helpers/deliver-story` (invoked from
  [`/deliver`](workflows/deliver.md)). There is no per-Task sub-loop; the
  agent authors commit subjects directly per
  [`rules/git-conventions.md`](rules/git-conventions.md) and references the
  Story via `(refs #<storyId>)`.
- Branch model matches Section 5.A (`story-<id>` → PR → `main`).
- There is no `type::epic` / `type::task` label and no Epic issue form. An
  Epic is at most an optional untyped human umbrella issue outside
  orchestration; `/deliver` refuses tickets that still carry an
  `Epic: #N` footer.

---

## 6. Workspace & File Hygiene (Temporary Files)

To keep the repository clean and avoid polluting the Git history:

- **Root Temp Directory**: All temporary files, scratch scripts, or
  intermediate outputs MUST be stored in the `/temp/` directory located at
  the workspace root.
- **Git Exclusion**: The `/temp/` directory is excluded from Git by default.
  Do NOT commit any files stored within it.

---

## 7. Complexity-Aware Execution

`/plan` sizes each Story as a **capability slice a frontier model delivers
and self-verifies in one pass** — a broad footprint is normal when the
change is cohesive. The session-capacity backstop lives in one place:
`DEFAULT_MODEL_CAPACITY` in
`.agents/scripts/lib/orchestration/ticket-validator-sizing.js` (framework
constant — not operator-tunable). Do not re-slice a capability-sized
Story into per-module fragments just because it touches many files.

### A. When You See `⚠️ COMPLEXITY WARNING`

If your task contains a complexity warning or exceeds localized scope:

1. **Plan first.** Read the full instructions, then write a numbered list of
   cohesive sub-steps in a `<!-- DECOMPOSITION -->` comment block — one
   coherent change with one reason to exist per sub-step, not one file per
   sub-step.
2. **Commit incrementally.** Stage, commit, and push after each logical
   sub-step completes successfully.
3. **Fail fast.** If any sub-step fails validation, STOP and report the
   failure.
