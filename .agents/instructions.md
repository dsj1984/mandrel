# Agent Execution Protocol

You operate under the Agent Execution Protocol — this central instruction set
governs your behavior, constraints, and operational context, and you MUST
strictly adhere to it.

---

## 1. System Guardrails & Initialization

### A. Role Framing

Behavioral constraints come from this file, always-on / on-demand rules, and
skills — there are no persona packs and no `persona::*` labels. Role-scoped
spawn contexts (when used) live under `.agents/agents/` via
`delivery.routing.roleScopedAgents`; QA auth identities (`qa.personas`) are a
separate fixture concept. If a user says "act as [role]", apply the matching
skill / workflow guidance (QA skills for verification, the security skill for
threat modeling) rather than looking for a persona file.

### B. Skill Activation

The skill library is **two-tier**: **`core/`** — universal, process-driven
skills (`core/debugging-and-error-recovery`, `core/code-review-and-quality`,
`core/security-and-hardening`); check for one first (the **test-first**
discipline lives in [`rules/testing-standards.md`](rules/testing-standards.md),
not a skill). **`stack/`** — tech-stack-specific skills (`stack/qa/playwright`,
`stack/qa/vitest`); apply when the project uses that technology, else use the
§ 1.C live-docs lookup.

When a task engages a domain or technology, you MUST read the corresponding
`.agents/skills/[tier]/[category]/[skill-name]/SKILL.md` and apply its
constraints — the **Policy Capsule** (the whole cost of activation) on
engagement, a `reference.md` section or `examples/` only when the task needs it
(§ 1.F's read-when-relevant split). When unsure which applies, match the task
against the one-line `description` in each skill's frontmatter (catalogued in
`.agents/skills/skills.index.json`). Skills compose (`idea-refinement` →
`/plan` → test-first implementation → `code-review-and-quality`); not every
task needs every skill. The always-on operating posture is governed by § 3–4
and § 1.I.

### C. Proactive Documentation

You MUST use the host's best live-documentation mechanism (a docs MCP server
such as Context7, an IDE-native lookup, or equivalent) proactively to prevent
hallucination: for any code involving third-party libraries, fetch the latest
official docs **before** writing code — do not ask permission. If none exists,
fall back to (1) in-repo docs and the package's bundled `README.md` /
`CHANGELOG.md`, then (2) the host's web fetch/search; note which channel you
used so reviewers can spot stale references.

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

If a `.agents/instructions.local.md` or `.agentrc.local.json` is present, you
MUST load it — the config resolver deep-merges `.agentrc.local.json` over
`.agentrc.json` (local wins; absent is a no-op). Do not modify these files
unless requested.

**Durable slash commands.** Any `.md` at `.agents/local/workflows/<name>.md` is
projected into `.claude/commands/<name>.md` by `sync-claude-commands.js` as
`/<name>`. The `.agents/local/` subtree is exempt from `mandrel sync`'s prune
pass, so these commands survive `npm install` / `mandrel sync` / `mandrel
update`; a core payload command of the same basename wins (local ignored with a
`shadowed` warning).

### F. Modular Global Rules

`.agents/rules/` splits into an **always-on core** (loaded with this file) and
an **on-demand set** (read only when the task engages it, so a generic task —
and every subagent it spawns — does not re-pay their bytes), the same
read-when-relevant pattern skills use (§ 1.B).

- **Always-on core**: [`security-baseline.md`](rules/security-baseline.md)
  (inviolable security MUSTs) and
  [`git-conventions.md`](rules/git-conventions.md) (branch shapes,
  commit-subject format, `refs #`, push/hygiene MUSTs).
- **On-demand** — read **before** the matching work; each opens with a one-line
  "this rule applies when…" scope header:
  [`git-conventions-reference.md`](rules/git-conventions-reference.md)
  (git-history mechanics),
  [`shell-conventions.md`](rules/shell-conventions.md) (shell chains,
  cross-platform strings),
  [`testing-standards.md`](rules/testing-standards.md) (authoring or
  restructuring tests),
  [`orchestration-error-handling.md`](rules/orchestration-error-handling.md)
  (scripts under `.agents/scripts/**`),
  [`ci-remediation.md`](rules/ci-remediation.md) (a red or slow CI check), and
  [`api-conventions.md`](rules/api-conventions.md) /
  [`gherkin-standards.md`](rules/gherkin-standards.md) /
  [`changelog-style.md`](rules/changelog-style.md) /
  [`test-seams.md`](rules/test-seams.md) (API, Gherkin, changelog, test-seam
  work).

Read the rule when unsure — cheaper than shipping a MUST violation; loading it
on demand does not lower its authority (§ 1.K).

### G. Structured Configuration

Refer to `.agentrc.json` for operational limits (auto-run permissions, etc.).
Project technology choices (database, ORM, API framework, auth, validation,
paths) are intentionally kept out of it — read the Tech Stack inventory:
`docs/tech-stack.md` when present, otherwise the **Tech Stack** section of
`docs/architecture.md`.

### H. Observability & Friction Telemetry

You MUST log telemetry about operational difficulty or automation
opportunities. Friction is a **local NDJSON signal**: `diagnose-friction.js`
appends a `kind: friction` record to the per-run/per-Story `signals.ndjson`
stream (not posted to the ticket; the retro phase surfaces the aggregate).

- **Command**:
  `node .agents/scripts/diagnose-friction.js --story [STORY_ID] --cmd [FAILED_COMMAND]`
- **When to fire**: after repeated tool-validation errors, an unrecoverable
  command failure, ambiguity needing self-correction, or repetitive boilerplate
  a workflow/skill could simplify.

Schema, stream path, the never-silently-dropped guarantee, and the
`AGENT_LOG_LEVEL` (`silent`/`info`/`verbose`) emission table are reference
detail — see [`docs/execution-reference.md`](docs/execution-reference.md#friction-telemetry).

### I. Anti-Thrashing Protocol

You MUST proactively identify when you are "thrashing" or stuck in an
infinite loop, and you MUST stop, summarize the blockers, and present a
**Re-Plan** (or yield to the user) before consuming more tokens on a failing
strategy. The cues are qualitative — there are no numeric thresholds; the call
is yours to make.

- **Failure cluster** — several tool calls in a row returning same-shape
  errors with the same remediation. Stop.
- **Research drift** — several reads deep with nothing written and the reads no
  longer narrowing the problem. Stop and plan with what you have.
- **Same fix, same failure** — the same kind of fix applied more than once for
  one error class with no change in the failure mode. Stop; the diagnosis is
  wrong.

When you stop, summarize in one paragraph what you tried, what recurred, and
what you would test next, then Re-Plan or hand back — do not paper over the
loop with another just-in-case retry.

### J. HITL Blocker Escalation (Safe Execution)

Before any task, you MUST check the ticket labels for high-risk operations.

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

Mandrel does **not** enforce live LLM spend and has no operator-tunable context
budget; your host runtime owns session quota. It does bound fixed framework
ceilings — the `/plan` context envelope and plan-time Story sizing — which
**fail closed** with a message naming what to trim. Constants and trim options:
[`docs/execution-reference.md`](docs/execution-reference.md#finops--token-budgeting-economic-guardrails).

---

## 3. Core Philosophy

1. **Context First:** Before proposing any solution, understand the
   repository's tech stack, historical context, and structure.
   - **Digest-first Reading (Story #4433).** **Never ingest the whole
     `project.docsContextFiles` set up front.** Read the **docs digest** — a
     compact outline (path, byte size, heading outline with line numbers, and
     the first paragraph under each `##`) — decide which docs bear on the task,
     then **pull the full file on demand**, jumping to the section at the line
     number the digest names. This is a hard cutover: no read-every-file branch
     survives. When no digest exists for the task — an ad hoc task,
     `project.docsContextFiles` unset, or a null `docsDigestPath` — there is
     **no mandatory docs read**: read a full doc only when the task's own
     context points you at one.
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
   decisions), update the Story's `## Spec` via `/plan` before touching code.
3. **Artifacts over Chat:** Write log files for test/build/debug output rather
   than pasting large blocks in chat.
4. **Idempotency:** Scripts and commands must be safe to run repeatedly.
5. **Security First:** Never hardcode secrets; use environment variables and
   secret scanning.

---

## 4. Execution & Quality Discipline

- **Re-Plan on Failure:** If a strategy fails, **STOP** and re-plan
  immediately. Do not repeat a broken approach.
- **Subagent Strategy:** Each spawn re-pays the full always-loaded context, so
  treat it as a cost decision. Prefer an **inline search** (grep, a targeted
  read) for small or localized lookups; reach for a subagent **only when the
  work justifies replicating context** — a broad multi-file investigation, a
  parallel exploration front, or an isolated task that would crowd the main
  window. One objective per subagent; prefer a cheaper/faster host capability
  for mechanical or read-only spawns and keep implementation/design on the
  default. **Depth compounds the cost** — sub-agents carry the `Agent` tool and
  nest further, and **every** level re-pays the context, so weigh the whole
  subtree's cost and stay within the supported depth envelope.
- **Anti-Laziness:** NEVER use placeholder comments like
  `// ... existing code ...`, `/* rest of file */`, or
  `// implementation here`. You MUST output the ENTIRE file or the ENTIRE
  complete function so it can be safely written to disk.
- **No Dead Code:** Remove unused imports, commented-out code, and dead
  branches before finalizing a file.
- **Lint Compliance:** Adhere strictly to project linters and formatters;
  language/stack-specific quality rules live in their `stack/` skills and
  `.agents/rules/` files — apply them when the skill is activated.
- **Verification:** Include explicit verification steps in every plan.

---

## 5. Git & Story Protocol (Strict Standards)

To maintain a clean and readable repository history, you MUST follow these
strict conventions for all Story-related Git operations. See
[`.agents/rules/git-conventions.md`](rules/git-conventions.md) for the full
canonical reference.

### A. Branch Naming

The canonical branch shape (`story-<storyId>` seeded and maintained by
`single-story-init.js`, PR to `main`) and the commit-subject contract are
owned by [`rules/git-conventions.md`](rules/git-conventions.md).

### B. Status Tracking & Commit Standards

Administrative state mutations in the v5 model are performed via GitHub
labels. Do NOT manually update issue descriptions or status fields unless
prompted.

- **Sync Tool**:
  `node .agents/scripts/update-ticket-state.js --ticket [ID] --state [STATUS]`
- **Status Labels**: `agent::ready`, `agent::executing`, `agent::done`.

### C. History Hygiene

Every Story reaches `main` via its own PR, opened by `helpers/deliver-story` /
`single-story-close.js`; the history model is owned by
[`rules/git-conventions.md`](rules/git-conventions.md).

### D. Ticket hierarchy (Story-only)

v2 collapses the ticket model to **Story**: acceptance criteria and verify
steps live inline (`acceptance[]` / `verify[]`) and the folded Tech Spec in
`## Spec` (over-budget Specs fail closed — split or tighten; never write under
`docs/`). Optional `depends_on` edges order rare multi-Story runs, resolved by
`/deliver` from live state across plan runs and over time.

- `/plan` emits one or more `type::story` issues (default N=1); there is no
  batch label — `/deliver` takes ids and discovers the graph.
- Each Story is executed by `helpers/deliver-story` (from
  [`/deliver`](workflows/deliver.md)); the agent authors commit subjects
  directly per [`rules/git-conventions.md`](rules/git-conventions.md),
  referencing the Story via `(refs #<storyId>)`.
- There is no `type::epic` / `type::task` label or Epic issue form; an Epic is
  at most an optional untyped human umbrella issue outside orchestration, and
  `/deliver` refuses tickets carrying an `Epic: #N` footer.

---

## 6. Workspace & File Hygiene (Temporary Files)

All temporary files, scratch scripts, and intermediate outputs MUST live in the
workspace-root `/temp/` directory, which is gitignored — do NOT commit anything
under it.

---

## 7. Complexity-Aware Execution

`/plan` sizes each Story as a **capability slice a frontier model delivers and
self-verifies in one pass** — a broad footprint is normal when the change is
cohesive (the backstop is `DEFAULT_MODEL_CAPACITY` in `ticket-validator-sizing.js`,
a framework constant). Do not re-slice a capability-sized Story into per-module
fragments just because it touches many files.

### A. When You See `⚠️ COMPLEXITY WARNING`

On a complexity warning or out-of-scope task: **plan first** (a numbered list of
cohesive sub-steps — one coherent change each, not one file each — in a
`<!-- DECOMPOSITION -->` block), **commit incrementally** after each sub-step,
and **fail fast** — STOP and report if any sub-step fails validation.
