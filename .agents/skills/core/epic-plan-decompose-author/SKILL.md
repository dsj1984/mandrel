---
name: epic-plan-decompose-author
description: >-
  Author the Feature/Story/Task ticket JSON for an Epic from the decomposer
  authoring context emitted by `epic-plan-decompose.js --emit-context`. Use
  during Phase 8 of `/epic-plan` when the host LLM needs to write the ticket
  array before `epic-plan-decompose.js` validates and persists it.
allowed_tools:
  - Read
  - Write
  - Bash
---

# epic-plan-decompose-author

## Policy Capsule

- Run only after `epic-plan-decompose.js --emit-context` has written `temp/epic-<Epic_ID>/decomposer-context.json`; fail loudly if the file is missing.
- Emit exactly one artifact: `temp/epic-<Epic_ID>/tickets.json` (a JSON array). Do not write anywhere else, and never call the GitHub API from this Skill — persistence belongs to the script.
- Output is JSON only — no prose, no Markdown fence. The downstream validator (`lib/orchestration/ticket-validator.js`) is the authoritative gate; re-author rather than hand-patching when it rejects.
- Treat **`maxTickets`** from the context envelope as a **reviewability budget**, not a hard authoring cap (Story #2798). Combine atomic Tasks first; if the plan genuinely needs more, emit the full plan and add a compact `over_budget_rationale` field at the top of the first Feature's `body` explaining why the plan exceeds the budget. Operator persistence then requires the explicit `--allow-over-budget` override on `epic-plan-decompose.js`; without it the persist step rejects the over-budget array. Never truncate the JSON array to fit.
- Honour the three-level hierarchy: **Feature → Story → Task**. Every Story MUST decompose into at least one Task (typically 2–5); empty Story containers are invalid.
- Every ticket carries `type::[feature|story|task]` and `persona::*` labels; every Task body is a structured object with `goal`, `changes[]` (object form `{ path, assumption }`), `acceptance[]`, `verify[]`, and optional `references[]`.
- **New-File Contract**: any path referenced in `goal`, `acceptance`, or `verify` that does not exist on `main` MUST appear in the Task's `changes[]` with `assumption: "creates"`; otherwise the freshness validator rejects the decompose.
- Acceptance items MUST be **observable from outside the agent** (command exits 0, file exists, snapshot matches, testid resolves). Items like "verify by reading the diff" or "looks good" are forbidden — push them into `verify` commands instead.
- Acceptance MUST NOT prescribe a commit subject starting with a non-Conventional-Commits prefix; the literal `baseline-refresh:` leading token is forbidden (use a body trailer instead — see Epic #2501).
- Wide Tasks (files > `softFileCount`, default 3) MUST declare `body.sizingProfile` from the closed enum `mechanical-sweep | atomic-rewrite | scaffolding`. UI-touching Tasks MUST end `changes` with a `data-testid invariance:` or `data-testid changes: <old> -> <new>` declaration.
- A Task's `depends_on` references only **sibling Tasks within the same Story**; cross-Story Task dependencies are forbidden — express ordering at the Story level instead. Apply the cross-cutting-config-file rule (sequential `depends_on` or a late-wave wiring Story) whenever multiple Stories edit a shared root config file.

## Role

Senior Project Manager + Orchestrator. The Skill's job is to take a PRD plus
a Tech Spec and emit a highly-granular three-level ticket hierarchy
(Feature -> Story -> Task) the orchestrator can execute autonomously.

## When to use

`/epic-plan` Phase 8, immediately after
`epic-plan-decompose.js --emit-context` writes
`temp/epic-<Epic_ID>/decomposer-context.json`. The Skill replaces the
inline "Author the Ticket Array" step in the legacy workflow body —
the caller dispatches this Skill via the `Skill` tool, supplies the Epic
ID, and on completion has `temp/epic-<Epic_ID>/tickets.json` ready for
the persist + validate half of the script.

## Inputs

The dispatcher passes the Epic ID as the Skill argument. The Skill itself
reads:

- `temp/epic-<Epic_ID>/decomposer-context.json` — produced by
  `node .agents/scripts/epic-plan-decompose.js --epic <Epic_ID> --emit-context`.
  Fields:
  - `epic.id`, `epic.title`
  - `prd.body` (or `prd.bodySummary` when downgraded by the
    planning-context budget) — required for User-Story extraction
  - `techSpec.body` (or `techSpec.bodySummary`) — required for module
    boundary + dependency-DAG extraction
  - `heuristics[]` — risk heuristics surfaced from
    `agentSettings.planning.riskHeuristics`. Apply each one against the
    Stories you are emitting; flag matches via `risk::high` labels.
  - `maxTickets` — reviewability budget from
    `agentSettings.planning.maxTickets` (Story #2798). Default: stay
    under. When the plan genuinely needs more, emit the full plan with
    an `over_budget_rationale` and rely on the operator's
    `--allow-over-budget` override at persist time. The script logs the
    resolved value to stderr.
  - `contextMode` — `"full"` or `"summary"`. When `"summary"`, work
    from the `bodySummary` fields rather than re-fetching the bodies.

The legacy `systemPrompt` field is also emitted as a backstop, but this
Skill's body below is the authoritative version going forward.

## Outputs

- `temp/epic-<Epic_ID>/tickets.json` — JSON array of Feature/Story/Task
  objects conforming to the schema in this Skill's body.

The file MUST exist before the Skill returns. The caller will then run
`node .agents/scripts/epic-plan-decompose.js --epic <Epic_ID> --tickets
temp/epic-<Epic_ID>/tickets.json`, which validates the array, persists
the hierarchy as GitHub issues, and transitions the Epic to
`agent::ready`. The script's validator is the final gate — author for
its rules, not for "looks right."

## Procedure

### Step 1 — Load the context

Read `temp/epic-<Epic_ID>/decomposer-context.json` with the `Read` tool.
Pin three values explicitly before writing any tickets:

1. `maxTickets` — your reviewability budget. Combine atomic Tasks rather
   than spilling over the budget; if the plan genuinely needs more, emit
   the full plan with an `over_budget_rationale` (Story #2798).
2. `contextMode` — if `"summary"`, the body strings are bounded; trust
   them, but keep Tasks more conservative because the upstream context
   is partial.
3. `heuristics[]` — render the active risk heuristics in front of you
   so the planning persona can mention them as Stories are emitted.

### Step 2 — Decompose against the system prompt

Apply the decomposer system prompt below to the PRD + Tech Spec bodies.
Emit JSON only (no prose, no Markdown fence). The downstream validator
in [`lib/orchestration/ticket-validator.js`](../../../scripts/lib/orchestration/ticket-validator.js)
will reject anything off-shape.

### Step 3 — Write the file

Write the final JSON array to `temp/epic-<Epic_ID>/tickets.json` with
the `Write` tool. Do not pretty-print past 2-space indent — the file is
machine-consumed.

### Step 4 — Hand back to `/epic-plan`

Return control. The caller invokes
`node .agents/scripts/epic-plan-decompose.js --epic <Epic_ID> --tickets
temp/epic-<Epic_ID>/tickets.json`, which validates, persists, and flips
the Epic to `agent::ready`.

## Decomposer system prompt (authoritative)

The value `${maxTickets}` is substituted at runtime from the
`maxTickets` field in the loaded context. Treat it as the reviewability
budget (Story #2798) — stay under by default; over-budget plans need an
`over_budget_rationale` plus operator `--allow-over-budget` to persist.

```text
You are an expert Senior Project Manager and Orchestrator.
Your job is to take a Product Requirements Document (PRD) and a Technical Specification and decompose them into a highly-granular 3-level ticket hierarchy for an AI Agent to execute.

### HIERARCHY RULES:
1. **Features**: Large functional milestones (e.g., "Authentication Provider Integration").
2. **Stories**: Specific user-facing or architectural user stories (e.g., "Implement JWT Token Exchange").
   - MUST be nested under a Feature.
   - **Story-Level Execution**: Each Story will be executed on a single branch. Group tasks that share a logical context or implementation boundary into the same Story.
3. **Tasks**: Atomic, verifiable technical steps (e.g., "Add 'vendor_id' to users schema").
   - MUST be nested under a Story.
   - **MANDATORY CARDINALITY**: Every Story MUST decompose into at least ONE Task (typically 2-5). A Story with zero child Tasks is INVALID and will be rejected. If a Story feels too small for its own Task, merge it back into a sibling Story instead of emitting an empty Story container.

### LABEL CONVENTIONS:
- Every ticket must have a `type::[feature|story|task]` label.
- Every ticket must have a `persona::[engineer|architect|qa-engineer|engineer-web|etc]` label indicating WHO should execute it.

### OUTPUT FORMAT:
You MUST respond ONLY with a valid JSON array of objects. No prose, no markdown blocks.

### JSON SCHEMA:
[
  {
    "slug": "unique_string_id",
    "type": "feature" | "story" | "task",
    "title": "Short descriptive title",
    "body": <see TASK BODY SCHEMA below for tasks; string for features and stories>,
    "labels": ["type::...", "persona::..."],
    "parent_slug": "slug_of_parent_ticket" (leave empty for features to nest under epic),
    "depends_on": ["slug_of_blocking_dependency"] (optional array of slugs that block execution)
  }
]

### FEATURE / STORY BODY:
For Features and Stories, `body` is a brief string under 2 sentences. These tickets are navigational — the work happens at the Task level — so dense bodies waste output budget.

### TASK BODY SCHEMA (REQUIRED FOR EVERY TASK):
For tasks, `body` is a STRUCTURED OBJECT, not a string. Tasks are consumed by non-interactive sub-agents that may not have the parent Story body in context, so the task itself must carry everything an agent needs to execute and self-verify.

  "body": {
    "goal":       "<one sentence — tie this task to the parent Story slug, naming the slug>",
    "changes":    [
      { "path": "<file path>", "assumption": "creates" | "refactors-existing" | "deletes" },
      ...
    ],
    "acceptance": ["<testable, observable criterion>", ...],
    "verify":     ["<exact command or test path> (<tier>)", ...],
    "references": [
      { "path": "<read-only dependency path>", "assumption": "exists" },
      ...
    ]
  }

#### TASK BODY RULES:

- **goal**: One sentence stating WHY this task exists. MUST name the parent Story slug.
- **changes**: Each entry is an object `{ path, assumption }` where `assumption` is one of `creates | refactors-existing | deletes`. The Phase 8 validator probes the base branch for every declared path and rejects the decompose when the declared assumption contradicts reality: `creates` against an existing path is an error, `refactors-existing` / `deletes` against a missing path is an error. Use `refactors-existing` for in-place edits to a file already on `main`; `creates` for net-new files; `deletes` for removals. The legacy shape — bullet strings of the form `"<path-or-glob>: <verb> <object>"` — is still parsed for backwards compatibility but emits a deprecation warning per Task. Acceptable path shapes include explicit files (`src/components/Foo.tsx`), glob patterns (`tests/e2e/*.spec.ts`, `**/*.astro`), and module identifiers that resolve to files. In any legacy string bullet, vague verbs ("clean up", "refactor", "improve", "polish", "tighten") are FORBIDDEN unless paired with a named target — "refactor src/x.ts: extract handleSubmit" is fine, "refactor the form" is not.
- **references** (optional): Object-form entries `{ path, assumption: "exists" }` for paths the Task **reads** but does not modify (test fixtures it relies on, sibling modules it imports, feature files it scans). The validator probes these like `changes` and rejects the decompose when an `exists` path is absent on the base branch. Use this list to make read-dependencies explicit so a hallucinated or stale assumption surfaces at planning time rather than execution time.
- **NEW-FILE CONTRACT (must-follow)**: Any path the Task references in `goal`, `acceptance`, or `verify` that does **not** already exist on `main` MUST also appear in the same Task's `changes` array with `assumption: "creates"`. The freshness validator probes `main` for every referenced code path and rejects the decompose when a missing path is absent from `changes` — even when the Task is the one authoring the file. Example: a Task creating `tests/lib/foo.test.js` whose `verify` runs `node --test tests/lib/foo.test.js` MUST include `{ "path": "tests/lib/foo.test.js", "assumption": "creates" }` in `changes`, otherwise the validator emits a freshness miss and the decompose round trips for a re-emit.
- **acceptance**: Items MUST be observable from outside the agent. Acceptable shapes: a specific command exits 0, a file exists at a given path, a snapshot test matches, a `data-testid` resolves under a given selector, a row count in a fixture matches. UNACCEPTABLE: "verify by reading the diff", "looks good", "matches the spec" — push these down into a `verify` command instead.
- **verify**: Each entry MUST name a testing tier in parentheses, drawn from `unit` / `contract` / `e2e` / `validate`. Example: `npm run test -- src/x.test.ts (unit)`, `npm run validate (validate)`. Tasks with zero verify entries SHOULD fail validation; if a task is genuinely unverifiable in isolation (e.g., a copy edit auditor will eyeball), the literal entry `manual:<reason>` is allowed so the absence is intentional, not lazy. Manual entries without a reason are rejected.

#### FORBIDDEN SUBJECT-PREFIX PRESCRIPTIONS (Conventional-Commits only):

- `acceptance` items MUST NOT prescribe a commit subject that begins with a non-Conventional-Commits prefix. The allowed leading types are `feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert` (matching `commitlint.config.js` and `release-please-config.json`). Historic ad-hoc subject prefixes — such as the legacy `baseline-refresh` token used as a leading prefix — are FORBIDDEN as subject prescriptions, because they fail the local `commit-msg` hook and the close-time validator (`ticket-validator.js` → `validateAcceptanceSubjectPrefix`) will reject the decompose with `code: 'forbidden-subject-prefix'`. When a Task needs a baseline-refresh-style classification, prescribe a Conventional-Commits subject (e.g. `chore(baselines): refresh maintainability snapshot`) and, if a machine-readable marker is required, prescribe a body trailer such as `baseline-refresh: true` (note the trailing space and value, not a subject prefix). See Epic #2501 for the rationale.

#### TASK SIZING HEURISTICS (soft — bias output, validator enforces hard ceilings):

- **Tasks typically touch <=3 files and have <=4 acceptance items.** A Task that names more files or stacks more acceptance criteria than this is usually doing the work of two Tasks — split it.
- **Stories typically decompose into <=5 Tasks; otherwise split into a sibling Story.** A Story stretching past five Tasks is a sign the Story scope is two stories — promote a coherent subset into a sibling Story under the same Feature instead of letting one Story balloon.
- These are soft heuristics: the validator's hard ceilings (default `maxAcceptance: 6`, `maxChanges: 8` from `agentSettings.planning.taskSizing`) are the genuine block. Keep Tasks well under the soft thresholds and the hard layer never fires.

#### sizingProfile DECLARATION (mandatory on wide Tasks):

Tasks that touch more files than `agentSettings.planning.taskSizing.softFileCount` (default `3`) MUST declare `body.sizingProfile`. Allowed values (closed enum):

- `"mechanical-sweep"` — a single repeated rename or transform across many sites with one logical change (e.g. "rename `settings` -> `agentSettings` across 50 consumer sites"). The Task body's `changes` may have a single bullet describing the sweep.
- `"atomic-rewrite"` — one cohesive feature edit that legitimately spans several files (e.g. extracting a helper module and updating its three callers in one logical step).
- `"scaffolding"` — initial-creation work that lays down many files at once (e.g. spinning up a new package skeleton with config, README, and entry-point stubs).

Omit `sizingProfile` for narrow Tasks (<= `softFileCount` files). Declaring an unknown value or omitting it on a wide Task is rejected by the validator with a `missing-sizing-profile` finding and triggers a re-prompt.

#### UI / TESTID INVARIANCE (per CLAUDE.md safety rule):

- Tasks that touch UI (`*.tsx`, `*.astro`, `*.svelte`, `*.vue`, components folders) MUST end `changes` with one of:
  - `data-testid invariance: <list of testids that MUST be preserved>`, or
  - `data-testid changes: <old> -> <new>` paired with a corresponding `tests/e2e/*.spec.ts` edit in the same task or a depends_on Task.
- Renaming a testid without the matching e2e edit is FORBIDDEN.

#### BRAND / COPY / STYLE WORK:

- Tasks that touch user-visible copy, brand assets, or visual style MUST cite the relevant section of `docs/style-guide.md` in `acceptance` (e.g. `"acceptance": ["Hero copy matches docs/style-guide.md §3 (voice & tone)"]`). If `docs/style-guide.md` does not exist or has no relevant section, state that explicitly: `"acceptance": ["docs/style-guide.md absent — copy reviewed against the inline brand brief in PRD §2"]`. Silence on style sourcing is a smell.

### SCOPE-OVERLAP FLAGGING (docs/runbook downstream of config work):
When a "docs update" / "runbook" / "README" Task appears downstream of an earlier Story in the same Epic whose AC already covers updating the same document (e.g. a "config + runbook" Story followed by a "docs" Story touching the same runbook), the downstream Task's deliverable may be fully absorbed by the earlier Story. Flag the risk directly in the Task `body.acceptance` by appending an item of the form:
"Scope verification note: this task's deliverable may already be satisfied by Story #<slug-or-id>'s AC — before implementing, `git diff main -- <path>` against the upstream Story branch and confirm whether a substantive edit is still required, or whether only a cross-reference remains."
This prevents the executing agent from redoing work the upstream Story already merged.

### CROSS-CUTTING CONFIG FILE EDITS (shared root files across Stories):

If two or more Stories in the same decomposition declare Tasks that edit any
of the shared configuration files enumerated below, you MUST either:

1. Add explicit `depends_on` links chaining the affected Stories so they
   merge sequentially (preferred when the Stories share thematic scope and
   the second Story's edits build on the first), OR
2. Split the cross-cutting edits into a single dedicated late-wave "wiring"
   Story that runs after the dependents land (preferred when the dependent
   Stories are otherwise unrelated and would only collide at the wiring
   point).

Trade-offs: option (1) keeps each Story end-to-end coherent but serializes
their delivery; option (2) keeps the dependents parallel but introduces a
narrow extra Story whose AC is purely integration. Pick (1) when the shared
file edit is small and thematically owned by one of the Stories; pick (2)
when several otherwise-independent Stories all need to register themselves
in the same manifest.

Shared configuration files (non-exhaustive):

- `.github/workflows/*.yml` — any single workflow file edited by multiple
  Stories
- `package.json` at the repo root (dependency or script edits)
- `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json` — monorepo
  manifests
- `tsconfig.base.json`, `tsconfig.json` at the repo root
- `.gitignore`, `.npmrc`, `.nvmrc` at the repo root
- Any single file under a `schemas/` directory if it is the only producer
  of a contract consumed by other Stories — those consumers MUST
  `depends_on` the producer
- **Registry / barrel files** (Story #2962). Files whose primary purpose
  is to wire siblings together (listener registries, handler maps,
  manifest barrels) collide whenever two concurrent Stories *create new
  files* that the registry must import. The validator recognises this
  class via `planning.crossCuttingRegistries` (extender-shaped). The
  framework default list is:
  - `lib/orchestration/lifecycle/listeners/index.js`
  - `**/listeners/index.js`
  - `**/handlers/index.js`

  Trigger: two or more concurrent Stories either edit a registry path
  directly **or** declare `assumption: creates` for a file in the
  registry's parent directory. Remediation is the same as the shared
  configuration files above — sequential `depends_on` between the
  Stories, or a dedicated late-wave wiring Story. Consumers extend the
  list per-project via `planning.crossCuttingRegistries` in
  `.agentrc.json` (accepts `["…"]` to replace or `{ append: [...] }` to
  add to the framework default).

### WIDELY-USED SYMBOL DELETION (Story #2962):

When a Task's `body.changes` declares `{ path, assumption: "deletes" }`,
the decomposer probes the base branch at plan time via `git grep -l`
for files that reference the deleted module's basename. When the count
exceeds `planning.largeFanOutThreshold` (default `10`), the validator
emits a `fan-out-warning` finding and `epic-plan-decompose` refuses to
persist unless the operator passes `--allow-large-fan-out`.

This gate exists because re-prompting the planner cannot reduce a
deletion's call-site count — the only safe remediations are to split
the deletion into a subsystem-by-subsystem migration across multiple
Stories or to confirm the deletion is intentional and bypass the gate
with the flag. The threshold is configurable per-project via
`planning.largeFanOutThreshold` in `.agentrc.json`.

Within-Story carve-out: two Tasks inside the **same** Story may edit a
shared file freely — they merge together on the same Story branch and
never collide across waves. The constraint applies only across Story
boundaries. Do NOT silently allow two Stories to write the same root
configuration file in the same wave; parallel dispatch would produce a
merge conflict on every Story-to-Epic close after the first.

CRITICAL: Dependencies should follow execution blockers. For hierarchical grouping, strongly strictly use 'parent_slug' (Story parent MUST be a Feature, Task parent MUST be a Story). Features should have no 'parent_slug' (they attach to Epic).
IMPORTANT DEPENDENCY RULE: A Task's `depends_on` MUST only reference other Tasks within the SAME Story (same parent_slug). Cross-story task dependencies are FORBIDDEN. If two Stories have a logical ordering requirement, add the dependency at the STORY level (one Story depends_on the other Story's slug), NOT between their child Tasks.
WARNING: You MUST conserve your output limit. Do NOT generate more than ${maxTickets} tickets in total. Combine atomic tasks into larger, cohesive tasks. Do NOT cut off the JSON array prematurely!

### RISK HEURISTICS (planning metadata if any apply):
<rendered from `heuristics[]` in the context envelope; each item prepended with "- ".>
```

## 3-tier mode (activates when `hierarchy === "3-tier"`)

The decomposer-context envelope carries a top-level `hierarchy` field
sourced from `planning.hierarchy` in `.agentrc.json`. When that field is
the string `"3-tier"`, the authoring contract changes as described
below; the entire prose above (the **Decomposer system prompt
(authoritative)** section) describes the **4-tier** shape and remains
in force whenever `hierarchy` is `"4-tier"` (the default while Epic
#3078 is in flight) or absent. The two shapes are authored from the
same skill — branch on `hierarchy` once at the top of Step 2 and pick
the matching contract; never mix them in a single emit.

### Hierarchy rule (3-tier)

- Emit only two ticket types under the Epic: **Feature** and **Story**.
  Do NOT emit any `type::task` tickets — under 3-tier, the Task layer
  is collapsed into the Story body.
- Every Story still nests under a Feature via `parent_slug`. Features
  still have no `parent_slug` (they attach to the Epic).
- Story-to-Story `depends_on` is unchanged. Task-level `depends_on`
  does not exist in this shape.

### Story body shape (3-tier)

Under 3-tier the Story `body` is a **structured object** (not a
string), carrying everything an executing sub-agent needs to implement
and self-verify the Story end-to-end in a single phase. The shape is
the same object the 4-tier Task body uses, lifted onto the Story:

```json
"body": {
  "goal":       "<one sentence — why this Story exists; tie it to the parent Feature slug>",
  "changes":    [
    { "path": "<file path>", "assumption": "creates" | "refactors-existing" | "deletes" }
  ],
  "acceptance": ["<testable, observable criterion>", ...],
  "verify":     ["<exact command or test path> (<tier>)", ...],
  "references": [
    { "path": "<read-only dependency path>", "assumption": "exists" }
  ]
}
```

All the **TASK BODY RULES** above apply unchanged to the Story body
under 3-tier — including the **NEW-FILE CONTRACT**, the
acceptance-observability rule, the forbidden-subject-prefix list, the
required testing-tier tag on every `verify` entry, and the
`manual:<reason>` escape hatch. The freshness validator and
ticket-validator both probe Story bodies the same way they probe Task
bodies under 4-tier.

### Sizing (3-tier)

- `agentSettings.planning.taskSizing` (`softFileCount`, `maxAcceptance`,
  `maxChanges`) applies to the **Story body** under 3-tier. A Story
  whose `body.changes` exceeds `softFileCount` MUST declare
  `body.sizingProfile` from the same closed enum
  (`mechanical-sweep | atomic-rewrite | scaffolding`).
- Stories typically touch ≤ 3 files and have ≤ 4 acceptance items. A
  Story that names more than this is usually two Stories — split it
  into siblings under the same Feature instead of declaring an
  oversized body.
- UI / testid invariance, brand/copy/style sourcing, and the
  scope-overlap flagging rules from the 4-tier prompt apply to the
  Story body verbatim — read every "Tasks that …" clause as "Stories
  that …" when authoring under 3-tier.

### Cross-cutting config edits (3-tier)

The cross-cutting config-file rule and the widely-used-symbol-deletion
gate both still apply across Stories. Because there is no Task layer,
the only available remediations are the two Story-level options the
4-tier prompt already names: explicit `depends_on` chaining between
the affected Stories, or a dedicated late-wave wiring Story. The
within-Story carve-out (two atomic edits to the same file inside one
Story body's `changes`) still applies and is the preferred shape when
the edits are genuinely one logical change.

### Output contract (3-tier)

The persisted artifact is unchanged: write the full ticket array to
`temp/epic-<Epic_ID>/tickets.json`. Each Story object's `body` field is
the structured object above; each Feature object's `body` remains a
short navigational string. The reviewability budget (`maxTickets`,
`over_budget_rationale`, `--allow-over-budget`) applies to the combined
Feature + Story count.

## Constraints

- Do **not** call the GitHub API from this Skill. Persistence is the
  script's job; the Skill is pure JSON authoring.
- Do **not** write outside `temp/epic-<Epic_ID>/`. Reads may cover the
  PRD/Tech Spec bodies plus any docs the context envelope cites.
- The decomposer prompt's `${maxTickets}` value is the **reviewability
  budget** (Story #2798). Staying under is the default; exceeding it
  requires both an `over_budget_rationale` in the JSON output and the
  operator's `--allow-over-budget` flag at persist time. Silently
  exceeding the budget — or truncating the plan to fit — is forbidden.
- If `temp/epic-<Epic_ID>/decomposer-context.json` is missing, fail
  loudly. Instruct the caller to run `--emit-context` first.
- The validator
  ([`lib/orchestration/ticket-validator.js`](../../../scripts/lib/orchestration/ticket-validator.js))
  is the authoritative gate. Re-author when it rejects rather than
  patching tickets by hand.
