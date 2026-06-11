# Agent Execution Protocol

You are operating under the Agent Execution Protocol. Your behavior, technical
constraints, and operational context are governed by this central instruction
set. You MUST strictly adhere to the following rules:

---

## 1. System Guardrails & Initialization

### A. Persona Routing & Execution

When the runtime injects a persona for the current task (via the hydrator from
`task.persona`), retrieve and strictly adopt the rules in
`.agents/personas/[role].md`. If a user explicitly instructs "Act as
[Role/Persona]" in chat, honor that as well.

- **Fallback:** If the specific persona file is missing, default to
  `.agents/personas/engineer.md`.

### B. Skill Activation

The skill library uses a **two-tier architecture**:

- **`core/`** — Universal, process-driven skills that apply across any project
  (e.g., `core/debugging-and-error-recovery`, `core/test-driven-development`,
  `core/security-and-hardening`). Always check for a relevant core skill first.
- **`stack/`** — Tech-stack-specific skills for concrete libraries, services,
  and tools (e.g., `stack/backend/cloudflare-hono-architect`,
  `stack/frontend/tailwind-v4`, `stack/qa/playwright`). Apply these when the
  project uses that specific technology.

When a task involves a specific domain or technology, you MUST read the
corresponding `.agents/skills/[tier]/[category]/[skill-name]/SKILL.md` file and
apply its constraints. Review the skill's `examples/` directory or
`examples.md` sibling **when present and relevant** to the task — most skills
do not ship one, so do not probe blindly. When uncertain which skill to apply,
read `core/using-agent-skills` for guidance on skill selection and sequencing.

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

### F. Modular Global Rules

Before writing code or documentation, verify if any domain-agnostic rules
apply by checking the `.agents/rules/` directory (e.g.,
`security-baseline.md`, `testing-standards.md`, `api-conventions.md`,
`git-conventions.md`, `shell-conventions.md`).

### G. Structured Configuration

Refer to `.agentrc.json` to understand your operational limits (e.g., allowed
auto-run permissions, default personas). Refer to the **Tech Stack** section
of `docs/architecture.md` for the project's specific technology choices
(database, ORM, API framework, auth provider, validation library, workspace
paths). Project-specific technology context is intentionally kept out of
`.agentrc.json`.

### H. Observability & Friction Telemetry

You MUST log telemetry about any operational difficulty or automation
opportunity you encounter. Post friction details directly to the relevant
GitHub Story (or Epic) ticket:

- **Command**:
  `node .agents/scripts/diagnose-friction.js --story [STORY_ID] --cmd [FAILED_COMMAND]`
  (add `--epic [EPIC_ID]` when the Story sits under an Epic)
- **When to fire**: After consecutive tool validation errors, unrecoverable
  command failures, or ambiguity requiring explicit self-correction. Also
  after repetitive sequences of commands or boilerplate-heavy steps that
  could be simplified by a workflow or skill.
- **No-ticket fallback**: If you hit friction outside an Epic/Story
  loop, write a JSON record to `temp/friction-<timestamp>.json` with the
  same fields, and mention the file in your final summary so a human can
  route it later. Do not silently drop the signal.

#### Log Level Control

The orchestrator logger (`lib/Logger.js`) emits progress/trace output based
on the `AGENT_LOG_LEVEL` environment variable:

- `silent`  — only `fatal` emits; useful for script embedding where the
  caller owns presentation.
- `info`    — default. Emits `info` / `warn` / `error` / `fatal`.
- `verbose` — adds `debug` trace output on top of the `info` set. `debug` is
  accepted as a backward-compatible alias.

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

This protocol is not soft-prompt-only — it has a runtime substrate. While
executing as a Story delivery sub-agent (via `helpers/epic-deliver-story`
or `helpers/single-story-deliver`), you MUST emit a `story.heartbeat`
lifecycle event on every Task transition (or whenever you stall on a
long-running step) so the parent `/deliver` idle watchdog (§ 2e of
`.agents/workflows/helpers/deliver-epic.md`, re-ticked every 30 minutes via
`wave-tick.js --check-idle 30`) can distinguish a child still making
progress from a dead one. If you genuinely cannot proceed, transition to
`agent::blocked` and exit non-zero — never fall silent. A child with no
recent `story.heartbeat`, no commit on its `story-<id>` branch, and no
`agent::blocked` label is exactly the failure mode the idle watchdog is
built to catch, and the watchdog will re-dispatch (or escalate) the Story
without your participation.

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
4. **The active persona** — `.agents/personas/[role].md` (§ 1.A).
5. **Skills** — `.agents/skills/**/SKILL.md` (§ 1.B).

Two carve-outs refine the ordering:

- **More specific wins within a tier.** When two documents in the **same**
  tier overlap, the narrower, more-specific statement governs the broader one
  (e.g. a stack-specific skill refines a general core skill; a per-rule
  statement refines a cross-rule one).
- **`rules/security-baseline.md` is inviolable.** No persona, skill, or local
  override may relax a security MUST. A security constraint that conflicts
  with any lower-tier guidance — or with a local override — always wins,
  regardless of its tier position above.

---

## 2. FinOps & Token Budgeting (Economic Guardrails)

Mandrel does **not** enforce live LLM spend from response metadata. The
framework limits **hydrated prompt size** and optional **pre-dispatch
estimates**; your host runtime (editor / CLI) owns session quota and hard
stops.

### A. Token budget (hydration + pre-dispatch estimates)

- **`delivery.maxTokenBudget`** (`.agentrc.json`, resolved via
  `lib/config/limits.js`): caps the task prompt built by
  `hydrate-context` / `hydrateContext`. The pipeline uses a rough token
  estimate (≈4 characters per token) and applies section-aware elision
  (`elideEnvelope`) so oversized envelopes drop or summarize
  lower-priority sections before you receive the prompt.
- **`delivery.preflight.*`** (optional): before `/deliver` fan-out,
  `epic-deliver-preflight.js` compares **estimated** story count, waves,
  install time, GitHub API volume, and Claude quota tokens against
  configured ceilings (`maxClaudeQuotaTokens`, etc.). A breach surfaces
  via `agent::blocked`; there is no per-tool-call metering.
- **Host runtime**: session billing, quota exhaustion, and operator
  overrides are enforced by your provider (e.g. Claude Code), not by
  Mandrel scripts.

---

## 3. Core Philosophy

1. **Context First:** Before proposing any solution, understand the
   repository's tech stack, historical context, and structure.
   - **Mandatory Reading**: Before starting ANY task, you MUST read every
     file listed in `project.docsContextFiles` in `.agentrc.json`.
     This list is the project's authoritative reference set (architecture,
     data dictionary, decisions log, patterns, etc.) and replaces any
     hardcoded filename list. Resolve each entry against
     `project.paths.docsRoot` (default `docs/`) and skip silently
     when an entry's file is absent.
   - **Conditional Reads**: When the task touches UI copy, layout, or
     routing and the corresponding file is present in the project, also
     read `docs/style-guide.md` and `docs/web-routes.md`. Skip both when
     absent or unrelated to the task — they are not part of the universal
     mandatory set.
   - **Epic Context**: Additionally, read the context tickets (PRD, Tech
     Spec) linked in the current Epic's body and the task-specific
     instructions.
   - **Optimization**: For large projects, prioritize targeted retrieval
     (semantic code search or focused text search) to isolate specific
     schemas or decisions before reading broad files.
2. **Plan First:** For non-trivial tasks (3+ steps or architectural
   decisions), enter **Plan Mode**. Update the Tech Spec issue or create a
   new Technical Specification document in the `docs/` root (if not already
   handled by a ticket) before touching code.
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
- **Subagent Strategy:** Use subagents liberally for research, exploration,
  or parallel analysis to keep the main context window focused. One
  objective per subagent.
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

## 5. Git & Epic Protocol (Strict Standards)

To maintain a clean and readable repository history, you MUST follow these
strict conventions for all epic-related Git operations. See
[`.agents/rules/git-conventions.md`](rules/git-conventions.md) for the full
canonical reference.

### A. Branch Naming (Canonical)

Epic execution uses two branch shapes. The runtime creates and maintains
them automatically; agents commit on the execution branch only.

| Purpose          | Format                       | Owner                  | Notes                                                                                         |
| ---------------- | ---------------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| Story execution  | `story-<storyId>`            | `story-init.js` | Per-Story worktree at `.worktrees/story-<storyId>/`. All Story implementation commits land here. |
| Epic integration | `epic/<epicId>`              | `/deliver` slash command | Story branches merge into this branch with `--no-ff`. Pushed per wave.                       |

- **Verification**: After `story-init.js` returns, confirm
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

Prioritize a clean `epic/[EPIC_ID]` branch. Story branches are merged into
the Epic branch automatically by `helpers/epic-deliver-story` (via
`story-close.js`); the Epic branch reaches `main` via the pull request that
`/deliver` opens at the end of its run — the operator merges through
the GitHub UI. There is no in-script merge to `main`.

### D. Ticket hierarchy (2-tier)

Mandrel uses a **2-tier ticket hierarchy** (Epic → Story).
Acceptance criteria and verification steps live inline on the Story
body (`acceptance[]` / `verify[]`); there is no Feature tier and no
`type::task` ticket layer. Thematic grouping lives as prose in the
Epic body / Tech Spec.

- The decomposer emits only `type::epic` and `type::story` issues;
  Stories attach directly to the Epic.
- Each Story-implementation phase is executed by
  `helpers/epic-deliver-story` (Epic-attached) or
  `helpers/single-story-deliver` (standalone). There is no per-Task
  sub-loop; the agent authors commit subjects directly per
  [`rules/git-conventions.md`](rules/git-conventions.md) and references
  the parent Story via `(refs #<storyId>)`.
- Story branches, the Epic-branch integration target, the wave-loop
  fan-out, and the `epic/<id>` → `main` PR merge model are the same
  as Section 5.A.

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

The dispatcher automatically calculates the execution plan for an Epic. A
Story is a **capability slice a frontier model delivers and self-verifies in
one pass** — a broad footprint is normal when the change is cohesive. The
numeric sizing backstop lives in one place: `DEFAULT_TASK_SIZING` in
`.agents/scripts/lib/orchestration/ticket-validator-sizing.js` (operator
override via `planning.taskSizing`). Do not re-slice a capability-sized
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
