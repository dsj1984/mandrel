# Agent Execution Protocol

You operate under the Agent Execution Protocol — this instruction set
governs your behavior and constraints; you MUST strictly adhere to it.
It is a lean always-on spine: procedural detail lives in the on-demand
tier (§ 1.F rules,
[`docs/execution-reference.md`](docs/execution-reference.md), skills)
and is read when the task engages it.

---

## 1. System Guardrails & Initialization

### A. Role Framing

No persona packs, no `persona::*` labels — constraints come from this
file, the rules, and skills; "act as [role]" means apply the matching
skill or workflow guidance. Role-scoped spawn contexts live under
`.agents/agents/` (`delivery.routing.roleScopedAgents`); `qa.personas`
is a separate fixture concept.

### B. Skill Activation

When a task engages a domain or technology, you MUST read the matching
`.agents/skills/[tier]/[category]/[skill-name]/SKILL.md` — tiers
**`core/`** (universal process; test-first discipline lives in
[`rules/testing-standards.md`](rules/testing-standards.md)) and
**`stack/`** (tech-specific) — and apply its constraints: the **Policy
Capsule** on engagement; `reference.md` / `examples/` only when needed.
Unsure? Match against the `description`s in
`.agents/skills/skills.index.json`.

### C. Proactive Documentation

Before writing against a third-party API you are unsure of — or one
that moves fast enough that recall may be stale — fetch the current
official docs via the host's best live-documentation mechanism (docs
MCP server, IDE lookup); do not ask permission. Fallbacks: (1) in-repo
docs and the package's bundled README/CHANGELOG, (2) web fetch/search.

### D. Error Handling & Degradation

If a protocol file cannot be loaded, alert the user before proceeding
with a `⚠️ **Agent Protocol Warning**` block naming **Missing**,
**Impact**, and **Fallback**. State mutations go through the in-repo CLI
scripts under `.agents/scripts/` — there is no state-mutation MCP server
to degrade from.

### E. Local Overrides

If `.agents/instructions.local.md` or `.agentrc.local.json` is present,
you MUST load it — the resolver deep-merges `.agentrc.local.json` over
`.agentrc.json` (local wins; absent is a no-op). Do not modify these
files unless requested. Durable local slash commands:
[`docs/execution-reference.md`](docs/execution-reference.md#durable-local-slash-commands).

### F. Modular Global Rules

`.agents/rules/` splits into an **always-on core** —
[`security-baseline.md`](rules/security-baseline.md) (inviolable security
MUSTs) and [`git-conventions.md`](rules/git-conventions.md) (branch
shapes, commit subjects, push/hygiene MUSTs) — and an **on-demand set**,
read **before** the matching work (each opens with a one-line "applies
when…" scope header): `git-conventions-reference.md`,
`testing-standards.md`, `ci-remediation.md`, `api-conventions.md`,
`gherkin-standards.md`; plus `orchestration-error-handling.md`,
`known-tooling-behavior.md`, `test-seams.md`
(**mandrel contributors only** — consumers skip). Read when unsure;
on-demand loading does not lower a rule's authority (§ 1.K).

### G. Structured Configuration

`.agentrc.json` holds operational limits. Project technology choices
are deliberately kept out of it — read `docs/tech-stack.md` when
present, else the **Tech Stack** section of `docs/architecture.md`.

### H. Observability & Friction Telemetry

Optional: `diagnose-friction.js` wraps a command and records its failure
shape as a local NDJSON signal —
[`docs/execution-reference.md`](docs/execution-reference.md#friction-telemetry).

### I. Anti-Thrashing Protocol

You MUST recognize thrashing and stop **before** spending more tokens
on a failing strategy — cues: a **failure cluster** (same-shape tool
errors in a row), **research drift** (reads no longer narrowing the
problem), **same fix, same failure** (the diagnosis is wrong). On stop:
summarize what you tried and what recurred, then **Re-Plan** or yield —
never another just-in-case retry.

### J. HITL Blocker Escalation (Safe Execution)

Check ticket labels before any task. `risk::high` is planning/audit
metadata only — no automatic runtime pause. The single runtime pause
point is **`agent::blocked`**: on an unresolvable blocker or an unsafe
destructive action without explicit authorization, transition to
`agent::blocked`, summarize the blocker, and wait for operator resume
(`agent::executing` or equivalent).

### K. Precedence & Conflict Resolution

Conflicts resolve by this total ordering (higher wins): **1.** local
overrides (§ 1.E) → **2.** this file → **3.** global rules (§ 1.F) →
**4.** skills (§ 1.B). Carve-outs: within a tier, the narrower statement
governs; and **`rules/security-baseline.md` is inviolable** — no skill or
local override may relax a security MUST, and a security constraint
always wins regardless of tier.

---

## 2. FinOps & Token Budgeting (Economic Guardrails)

Mandrel does not enforce live LLM spend; your host owns session quota.
The one fixed framework ceiling (the `/mandrel-plan` context envelope)
truncates with a note naming what was cut:
[`docs/execution-reference.md`](docs/execution-reference.md#finops--token-budgeting-economic-guardrails).

---

## 3. Core Philosophy

1. **Context First.** **Digest-first reading (Story #4433):** never
   ingest the whole `project.docsContextFiles` set up front — read the
   docs digest and pull files on demand at the section it names. No
   digest (ad hoc task, `docsContextFiles` unset, null `docsDigestPath`)
   → **no mandatory docs read**. A task touching UI copy, layout, or
   routing also reads `docs/style-guide.md` / `docs/web-routes.md` when
   present. Always read the current Story's body (`## Spec` +
   `acceptance[]` / `verify[]`); prefer targeted retrieval over broad
   reads.
2. **Plan First.** For non-trivial tasks (3+ steps or architectural
   decisions), update the Story's `## Spec` via `/mandrel-plan` before code.
3. **Artifacts over Chat.** Write test/build/debug output to log
   files, not into chat.
4. **Idempotency.** Scripts must be safe to run repeatedly.

---

## 4. Execution & Quality Discipline

- **Re-Plan on Failure.** If a strategy fails, STOP and re-plan.
- **Subagent Strategy.** Each spawn re-pays the full always-loaded
  context — a cost decision. Prefer inline search for small lookups;
  spawn only when the work justifies replicating context. One objective
  per subagent; depth compounds the cost (every nested level re-pays).
- **Anti-Laziness / No Dead Code.** NEVER use placeholder comments like
  `// ... existing code ...`; every edit must leave complete, runnable code.
  Remove unused imports, commented-out code, and dead branches before
  finalizing.
- **Verification.** Include explicit verification steps in every plan.

---

## 5. Git & Story Protocol (Strict Standards)

[`rules/git-conventions.md`](rules/git-conventions.md) is the canonical
reference for branch shapes and commit subjects, and is always loaded —
this section does not restate it.

### A. Status Tracking & Commit Standards

State mutations are GitHub labels (`agent::ready`, `agent::executing`,
`agent::done`) via
`node .agents/scripts/update-ticket-state.js --ticket [ID] --state [STATUS]`.
Do NOT manually update issue descriptions or status fields unless prompted.

### B. Ticket hierarchy

The Story is the only executable ticket: `acceptance[]` / `verify[]`
inline plus the folded Tech Spec in `## Spec` (as long as the work
needs; never under `docs/`). Optional `depends_on`
edges order rare multi-Story runs, resolved by `/mandrel-deliver` from
live state; `plan-run::<id>` is filter metadata. Commit subjects
reference the Story via `(refs #<storyId>)`. There is no `type::task`.

`type::epic` is a container only (goal + child checklist, no `agent::*`,
never delivered): `/mandrel-plan` offers one above 2 Stories and
`/mandrel-deliver <epicId>` expands it. Linkage is parent→child only, so
an `Epic: #N` footer is still refused.

---

## 6. Workspace & File Hygiene (Temporary Files)

All temporary files, scratch scripts, and intermediate outputs MUST
live in the gitignored workspace-root `/temp/` directory — do NOT commit
anything under it.

---

## 7. Complexity-Aware Execution

`/mandrel-plan` sizes each Story as a **capability slice a frontier model
delivers and self-verifies in one pass** — a broad footprint is normal
when the change is cohesive, and no plan-time ceiling scores it; do not
re-slice it into per-module fragments. On a `⚠️ COMPLEXITY WARNING` or
out-of-scope task: **plan first** (numbered cohesive sub-steps in a
`<!-- DECOMPOSITION -->`
block), **commit incrementally** per sub-step, and **fail fast** — STOP
and report if any sub-step fails validation.
