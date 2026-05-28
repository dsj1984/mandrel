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
- Treat **`maxTickets`** from the context envelope as a **reviewability budget**, not a hard authoring cap (Story #2798). Combine atomic Stories first; if the plan genuinely needs more, emit the full plan and add a compact `over_budget_rationale` field at the top of the first Feature's `body` explaining why the plan exceeds the budget. Operator persistence then requires the explicit `--allow-over-budget` override on `epic-plan-decompose.js`; without it the persist step rejects the over-budget array. Never truncate the JSON array to fit.
- Honour the two-level hierarchy under each Epic: **Feature → Story**. Stories carry the implementation scope inline on their bodies; no lower ticket tier exists.
- Every ticket carries `type::[feature|story]` and `persona::*` labels; every Story body is a structured object with `goal`, `changes[]` (object form `{ path, assumption }`), `acceptance[]`, `verify[]`, and optional `references[]`.
- **New-File Contract**: any path referenced in `goal`, `acceptance`, or `verify` that does not exist on `main` MUST appear in the Story's `changes[]` with `assumption: "creates"`; otherwise the freshness validator rejects the decompose.
- Acceptance items MUST be **observable from outside the agent** (command exits 0, file exists, snapshot matches, testid resolves). Items like "verify by reading the diff" or "looks good" are forbidden — push them into `verify` commands instead.
- Acceptance MUST NOT prescribe a commit subject starting with a non-Conventional-Commits prefix; the literal `baseline-refresh:` leading token is forbidden (use a body trailer instead — see Epic #2501).
- Wide Stories (files > `softFileCount`, default 3) MUST declare `body.sizingProfile` from the closed enum `mechanical-sweep | atomic-rewrite | scaffolding`. UI-touching Stories MUST end `changes` with a `data-testid invariance:` or `data-testid changes: <old> -> <new>` declaration.
- A Story's `depends_on` references only **sibling Stories within the same Epic**. Apply the cross-cutting-config-file rule (sequential `depends_on` or a late-wave wiring Story) whenever multiple Stories edit a shared root config file.

## Role

Senior Project Manager + Orchestrator. The Skill's job is to take a PRD plus
a Tech Spec and emit a Feature → Story ticket hierarchy the orchestrator
can execute autonomously.

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

- `temp/epic-<Epic_ID>/tickets.json` — JSON array of Feature/Story
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
will reject anything off-shape. Combine atomic Stories first; emit one
Story per logically atomic implementation slice.

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
Your job is to take a Product Requirements Document (PRD) and a Technical Specification and decompose them into a Feature → Story ticket hierarchy for an AI Agent to execute.

### HIERARCHY RULES:
1. **Features**: Large functional milestones (e.g., "Authentication Provider Integration"). Features are navigational containers — no implementation work hangs off the Feature body itself.
2. **Stories**: Atomic, verifiable units of work (e.g., "Implement JWT Token Exchange").
   - MUST be nested under a Feature via `parent_slug`.
   - **Story-Level Execution**: Each Story is executed on a single Story branch (`story-<storyId>`), implemented in one Story-implementation phase, then merged into the Epic branch. The Story body carries the full execution contract (goal, changes, acceptance, verify).
   - Do NOT emit a lower ticket tier — the validator only accepts `type::feature` and `type::story`.

### LABEL CONVENTIONS:
- Every ticket must have a `type::[feature|story]` label.
- Every ticket must have a `persona::[engineer|architect|qa-engineer|engineer-web|etc]` label indicating WHO should execute it.

### OUTPUT FORMAT:
You MUST respond ONLY with a valid JSON array of objects. No prose, no markdown blocks.

### JSON SCHEMA:
[
  {
    "slug": "unique_string_id",
    "type": "feature" | "story",
    "title": "Short descriptive title",
    "body": <string for features; STORY BODY SCHEMA below for stories>,
    "labels": ["type::...", "persona::..."],
    "parent_slug": "slug_of_parent_ticket" (leave empty for features to nest under epic; required for stories — must point at a sibling Feature),
    "depends_on": ["slug_of_blocking_dependency"] (optional array of Story slugs that block execution)
  }
]

### FEATURE BODY:
For Features, `body` is a brief string under 2 sentences. Features are navigational — the work happens at the Story level — so dense bodies waste output budget.

### STORY BODY SCHEMA (REQUIRED FOR EVERY STORY):
For stories, `body` is a STRUCTURED OBJECT, not a string. Stories are consumed by non-interactive sub-agents that may not have the parent Feature body in context, so the story itself must carry everything an agent needs to execute and self-verify.

  "body": {
    "goal":       "<one sentence — why this Story exists; tie it to the parent Feature slug>",
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

#### STORY BODY RULES:

- **goal**: One sentence stating WHY this Story exists. SHOULD name the parent Feature slug.
- **changes**: Each entry is an object `{ path, assumption }` where `assumption` is one of `creates | refactors-existing | deletes`. The Phase 8 validator probes the base branch for every declared path and rejects the decompose when the declared assumption contradicts reality: `creates` against an existing path is an error, `refactors-existing` / `deletes` against a missing path is an error. Use `refactors-existing` for in-place edits to a file already on `main`; `creates` for net-new files; `deletes` for removals. Acceptable path shapes include explicit files (`src/components/Foo.tsx`), glob patterns (`tests/e2e/*.spec.ts`, `**/*.astro`), and module identifiers that resolve to files.
- **references** (optional): Object-form entries `{ path, assumption: "exists" }` for paths the Story **reads** but does not modify (test fixtures it relies on, sibling modules it imports, feature files it scans). The validator probes these like `changes` and rejects the decompose when an `exists` path is absent on the base branch. Use this list to make read-dependencies explicit so a hallucinated or stale assumption surfaces at planning time rather than execution time.
- **NEW-FILE CONTRACT (must-follow)**: Any path the Story references in `goal`, `acceptance`, or `verify` that does **not** already exist on `main` MUST also appear in the same Story's `changes` array with `assumption: "creates"`. The freshness validator probes `main` for every referenced code path and rejects the decompose when a missing path is absent from `changes` — even when the Story is the one authoring the file. Example: a Story creating `tests/lib/foo.test.js` whose `verify` runs `node --test tests/lib/foo.test.js` MUST include `{ "path": "tests/lib/foo.test.js", "assumption": "creates" }` in `changes`, otherwise the validator emits a freshness miss and the decompose round trips for a re-emit.
- **acceptance**: Items MUST be observable from outside the agent. Acceptable shapes: a specific command exits 0, a file exists at a given path, a snapshot test matches, a `data-testid` resolves under a given selector, a row count in a fixture matches. UNACCEPTABLE: "verify by reading the diff", "looks good", "matches the spec" — push these down into a `verify` command instead.
- **verify**: Each entry MUST name a testing tier in parentheses, drawn from `unit` / `contract` / `e2e` / `validate`. Example: `npm run test -- src/x.test.ts (unit)`, `npm run validate (validate)`. Stories with zero verify entries SHOULD fail validation; if a Story is genuinely unverifiable in isolation (e.g., a copy edit auditor will eyeball), the literal entry `manual:<reason>` is allowed so the absence is intentional, not lazy. Manual entries without a reason are rejected.

#### FORBIDDEN SUBJECT-PREFIX PRESCRIPTIONS (Conventional-Commits only):

- `acceptance` items MUST NOT prescribe a commit subject that begins with a non-Conventional-Commits prefix. The allowed leading types are `feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert` (matching `commitlint.config.js` and `release-please-config.json`). Historic ad-hoc subject prefixes — such as the legacy `baseline-refresh` token used as a leading prefix — are FORBIDDEN as subject prescriptions, because they fail the local `commit-msg` hook and the close-time validator (`ticket-validator.js` → `validateAcceptanceSubjectPrefix`) will reject the decompose with `code: 'forbidden-subject-prefix'`. When a Story needs a baseline-refresh-style classification, prescribe a Conventional-Commits subject (e.g. `chore(baselines): refresh maintainability snapshot`) and, if a machine-readable marker is required, prescribe a body trailer such as `baseline-refresh: true` (note the trailing space and value, not a subject prefix). See Epic #2501 for the rationale.

#### STORY SIZING HEURISTICS (soft — bias output, validator enforces hard ceilings):

- **Stories typically touch <=3 files and have <=4 acceptance items.** A Story that names more files or stacks more acceptance criteria than this is usually doing the work of two Stories — split it into sibling Stories under the same Feature.
- These are soft heuristics: the validator's hard ceilings (default `maxAcceptance: 6`, `maxChanges: 8` from `agentSettings.planning.taskSizing`) are the genuine block. Keep Stories well under the soft thresholds and the hard layer never fires.

#### sizingProfile DECLARATION (mandatory on wide Stories):

Stories that touch more files than `agentSettings.planning.taskSizing.softFileCount` (default `3`) MUST declare `body.sizingProfile`. Allowed values (closed enum):

- `"mechanical-sweep"` — a single repeated rename or transform across many sites with one logical change (e.g. "rename `settings` -> `agentSettings` across 50 consumer sites"). The Story body's `changes` may have a single bullet describing the sweep.
- `"atomic-rewrite"` — one cohesive feature edit that legitimately spans several files (e.g. extracting a helper module and updating its three callers in one logical step).
- `"scaffolding"` — initial-creation work that lays down many files at once (e.g. spinning up a new package skeleton with config, README, and entry-point stubs).

Omit `sizingProfile` for narrow Stories (<= `softFileCount` files). Declaring an unknown value or omitting it on a wide Story is rejected by the validator with a `missing-sizing-profile` finding and triggers a re-prompt.

#### UI / TESTID INVARIANCE (per CLAUDE.md safety rule):

- Stories that touch UI (`*.tsx`, `*.astro`, `*.svelte`, `*.vue`, components folders) MUST end `changes` with one of:
  - `data-testid invariance: <list of testids that MUST be preserved>`, or
  - `data-testid changes: <old> -> <new>` paired with a corresponding `tests/e2e/*.spec.ts` edit in the same Story or a depends_on Story.
- Renaming a testid without the matching e2e edit is FORBIDDEN.

#### BRAND / COPY / STYLE WORK:

- Stories that touch user-visible copy, brand assets, or visual style MUST cite the relevant section of `docs/style-guide.md` in `acceptance` (e.g. `"acceptance": ["Hero copy matches docs/style-guide.md §3 (voice & tone)"]`). If `docs/style-guide.md` does not exist or has no relevant section, state that explicitly: `"acceptance": ["docs/style-guide.md absent — copy reviewed against the inline brand brief in PRD §2"]`. Silence on style sourcing is a smell.

### SCOPE-OVERLAP FLAGGING (docs/runbook downstream of config work):
When a "docs update" / "runbook" / "README" Story appears downstream of an earlier Story in the same Epic whose AC already covers updating the same document (e.g. a "config + runbook" Story followed by a "docs" Story touching the same runbook), the downstream Story's deliverable may be fully absorbed by the earlier Story. Flag the risk directly in the Story `body.acceptance` by appending an item of the form:
"Scope verification note: this Story's deliverable may already be satisfied by Story #<slug-or-id>'s AC — before implementing, `git diff main -- <path>` against the upstream Story branch and confirm whether a substantive edit is still required, or whether only a cross-reference remains."
This prevents the executing agent from redoing work the upstream Story already merged.

### CROSS-CUTTING CONFIG FILE EDITS (shared root files across Stories):

If two or more Stories in the same decomposition edit any of the shared
configuration files enumerated below, you MUST either:

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

When a Story's `body.changes` declares `{ path, assumption: "deletes" }`,
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

Do NOT silently allow two Stories to write the same root configuration
file in the same wave; parallel dispatch would produce a merge conflict
on every Story-to-Epic close after the first.

CRITICAL: Dependencies should follow execution blockers. For hierarchical grouping, strongly strictly use 'parent_slug' (Story parent MUST be a Feature). Features should have no 'parent_slug' (they attach to Epic).
IMPORTANT DEPENDENCY RULE: A Story's `depends_on` MUST only reference other Stories within the SAME Epic. If two Stories have a logical ordering requirement, express it via Story-level `depends_on`.
WARNING: You MUST conserve your output limit. Do NOT generate more than ${maxTickets} tickets in total. Combine atomic work into cohesive Stories. Do NOT cut off the JSON array prematurely!

### RISK HEURISTICS (planning metadata if any apply):
<rendered from `heuristics[]` in the context envelope; each item prepended with "- ".>
```

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
