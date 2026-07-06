---
name: epic-plan-decompose-author
description: >-
  Author the Story ticket JSON for an Epic from the decomposer
  authoring context emitted by `epic-plan-decompose.js --emit-context`. Use
  during Phase 8 of `/plan` when the host LLM needs to write the ticket
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
- Treat **`maxTickets`** from the context envelope as a **reviewability budget**, not a hard authoring cap (Story #2798). Merge narrow, single-module Stories into their capability first; if the plan genuinely needs more, emit the full plan and add a compact `over_budget_rationale` note inside the first Story's `## Goal` section explaining why the plan exceeds the budget. Operator persistence then requires the explicit `--allow-over-budget` override on `epic-plan-decompose.js`; without it the persist step rejects the over-budget array. Never truncate the JSON array to fit.
- Honour the 2-tier hierarchy: every ticket is a **Story** attached directly to the Epic. Stories carry the implementation scope inline; no Feature and no lower ticket tier exists. Thematic grouping is prose in the Epic body / Tech Spec, never a ticket.
- **Decompose at deliverable granularity, not module/task level.** A Story is a capability slice a frontier model delivers and self-verifies in one pass — a shippable slice a reviewer would accept as a single PR — not a single module or file. See the STORY SIZING section for the full guidance and the single-consumer merge rule.
- Every ticket carries `type::story` and `persona::*` labels. Every Story ticket object MUST carry top-level `acceptance: string[]` and `verify: string[]` arrays (read by `hasInlineAcceptanceAndVerify` in the validator) and `body` MUST be a **string** produced by `serialize()` from `lib/story-body/story-body.js` — an object body causes `createOp` in `epic-spec-reconciler-ops.js` to throw `StoryBodyParseError` (Story #3302), and is also silently discarded by `composeStoryBody` in the GitHub provider, producing an empty issue body.
- **New-File Contract**: any path referenced in `goal`, `acceptance`, or `verify` that does not exist on `main` MUST appear in the Story's `changes[]` with `assumption: "creates"`; otherwise the freshness validator rejects the decompose.
- Acceptance items MUST be **observable from outside the agent** (command exits 0, file exists, snapshot matches, testid resolves). Items like "verify by reading the diff" or "looks good" are forbidden — push them into `verify` commands instead.
- Acceptance MUST NOT prescribe a commit subject starting with a non-Conventional-Commits prefix; the literal `baseline-refresh:` leading token is forbidden (use a body trailer instead — see Epic #2501).
- A legitimately broad Story (files > `hardFiles`) MUST declare `wide` with a one-line reason (encoded in the serialized body string via the `<!-- meta -->` comment) to lift the `hardFiles` rejection; lead the sizing decision with cohesion, not count. UI-touching Stories MUST end `changes` with a `data-testid invariance:` or `data-testid changes: <old> -> <new>` declaration.
- A Story's `depends_on` references only **sibling Stories within the same Epic**. Apply the cross-cutting-config-file rule (sequential `depends_on` or a late-wave wiring Story) whenever multiple Stories edit a shared root config file.
- **Authoring-contract altitude (Epic #4131 F8).** `acceptance[]` and `verify[]` are the Story's **binding contract** — the executor MUST satisfy them exactly, and they are the only definition of "done." `changes[]` and `references[]` are an **advisory implementation sketch**: a best-effort prediction of which files the work touches that the executor MAY revise when the codebase tells a different story. Author `acceptance[]`/`verify[]` so they capture the outcome independently of any particular file layout — never bake an incidental implementation detail into them that the advisory sketch is free to change. This does **not** weaken the file-assumption gate: `changes[]` paths are still validated structurally against the base branch (a `creates` against an existing path still fails), the New-File Contract still holds, and the executor's revised approach stays bounded by the inviolable `acceptance[]`/`verify[]` contract and `rules/security-baseline.md`.
- **Navigate-don't-deep-link acceptance standard (Epic #4131 F5).** For any Story whose acceptance describes a **signed-in** (authenticated) scenario reaching a feature surface, author the acceptance so the persona starts from their authenticated home and **reaches the feature through navigation** (clicking a nav door, menu item, or link the UI exposes) — never by asserting against a hardcoded deep-link URL. A scenario that drops the user straight onto `/some/feature/path` proves the page renders but not that the feature is reachable, masking orphaned surfaces with no nav owner. Phrase signed-in acceptance as "from the signed-in home, the persona navigates to … and sees …", not "loading `/feature/path` shows the feature."

## Role

Senior Project Manager + Orchestrator. The Skill's job is to take the
sectioned Epic body (whose managed sections carry the folded Tech Spec and
Acceptance Table — Story #4324) and emit a flat Story backlog the
orchestrator can execute autonomously.

## When to use

`/plan` Phase 8, immediately after
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
  - `epicBody` — the sectioned Epic body. It carries everything the
    decomposer needs in one document: the `## User Stories` section
    (User-Story extraction), the folded Tech Spec sections
    (`## Delivery Slicing` onward — module boundary + dependency-DAG
    extraction), and the `## Acceptance Table` AC-ID table. There is no
    separate `techSpec` envelope key (Story #4324).
  - `heuristics[]` — risk heuristics surfaced from
    `agentSettings.planning.riskHeuristics`. Apply each one against the
    Stories you are emitting; flag matches via `risk::high` labels.
  - `maxTickets` — reviewability budget; a framework constant
    (`LIMITS_DEFAULTS.maxTickets` in `.agents/scripts/lib/config/limits.js`,
    not operator-configurable — Story #2798, Story #4163). Default: stay
    under. When the plan genuinely needs more, emit the full plan with
    an `over_budget_rationale` and rely on the operator's
    `--allow-over-budget` override at persist time. The script logs the
    resolved value to stderr.
  - `contextMode` — `"full"` or `"summary"`. When `"summary"`, work
    from the `bodySummary` fields rather than re-fetching the bodies.

  - `systemPrompt` — the **authoritative, fully-rendered decomposer system
    prompt** (Story #4162). It is produced by `renderDecomposerSystemPrompt`
    in
    [`decomposer-prompts.js`](../../../scripts/lib/templates/decomposer-prompts.js),
    the single source of the prompt body, with `maxTickets`,
    `maxTokenBudget`, and the sizing thresholds already interpolated. Apply
    **this** string as your system prompt — this SKILL deliberately does NOT
    embed a second verbatim copy of the prompt body, so the two surfaces
    cannot drift. The sections below are authoring guidance that complements
    the rendered prompt; they are not a replacement copy of it.

## Outputs

- `temp/epic-<Epic_ID>/tickets.json` — JSON array of Story
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

1. `maxTickets` — your reviewability budget. Merge narrow slices into
   capability Stories rather than spilling over the budget; if the plan
   genuinely needs more, emit the full plan with an
   `over_budget_rationale` (Story #2798).
2. `contextMode` — if `"summary"`, the body strings are bounded; trust
   them, but keep Tasks more conservative because the upstream context
   is partial.
3. `heuristics[]` — render the active risk heuristics in front of you
   so the planning persona can mention them as Stories are emitted.

### Step 2 — Decompose against the rendered system prompt

Apply the fully-rendered decomposer system prompt — the `systemPrompt`
field of the loaded context envelope, produced by
[`decomposer-prompts.js`](../../../scripts/lib/templates/decomposer-prompts.js)
— to the sectioned Epic body (`epicBody`). That rendered string is the authoritative
prompt body (with `maxTickets`, `maxTokenBudget`, and the sizing thresholds
already interpolated); the authoring-guidance sections below complement it
without restating it. Emit JSON only (no prose, no Markdown fence). The
downstream validator in
[`lib/orchestration/ticket-validator.js`](../../../scripts/lib/orchestration/ticket-validator.js)
will reject anything off-shape. Merge narrow, single-module slices into
their capability first; emit one Story per capability slice a frontier
model can deliver and self-verify in one pass.

### Step 3 — Write the file

Write the final JSON array to `temp/epic-<Epic_ID>/tickets.json` with
the `Write` tool. Do not pretty-print past 2-space indent — the file is
machine-consumed.

### Step 4 — Hand back to `/plan`

Return control. The caller invokes
`node .agents/scripts/epic-plan-decompose.js --epic <Epic_ID> --tickets
temp/epic-<Epic_ID>/tickets.json`, which validates, persists, and flips
the Epic to `agent::ready`.

## Decomposer system prompt — single-sourced (Story #4162)

The authoritative decomposer system-prompt **body** is single-sourced in
[`decomposer-prompts.js`](../../../scripts/lib/templates/decomposer-prompts.js)
(`renderDecomposerSystemPrompt`) and delivered to you fully rendered in the
`systemPrompt` field of `temp/epic-<Epic_ID>/decomposer-context.json` — with
`maxTickets`, `maxTokenBudget`, the `DEFAULT_TASK_SIZING` thresholds, and the
risk heuristics already interpolated. **Apply that rendered string as your
system prompt.** This SKILL deliberately does **not** embed a second verbatim
copy of the prompt body (the preamble, the JSON output schema, the hierarchy /
label / output-format rules); duplicating it here is exactly the drift the
single-source contract exists to prevent, and the guard test in
`tests/ticket-decomposer.test.js` fails if a second full copy reappears on
either surface.

The value `${maxTickets}` in the rendered prompt is substituted at runtime
from the `maxTickets` field of the loaded context. Treat it as the
**reviewability budget** (Story #2798) — stay under by default; over-budget
plans need an `over_budget_rationale` plus operator `--allow-over-budget` to
persist. It is **not** a hard authoring cap: the prompt no longer carries any
ticket-count limit directive, and you MUST never truncate the JSON array to fit
(Story #4162). The rendered prompt also names the delivery token
budget (`maxTokenBudget`) as the real one-pass sizing envelope — size each
Story so a single agent can deliver and self-verify it within that budget.

## Authoring guidance (complements the rendered prompt)

The sections below are the SKILL's authoring guidance. They do **not** restate
the rendered prompt body — they record the contract details and sizing
heuristics you apply when shaping the ticket array. Where a number appears it
is the `DEFAULT_TASK_SIZING` default; the rendered prompt interpolates the live
value, which always wins.

### STORY BODY SHAPE (string body, top-level acceptance/verify)

For Stories, `body` MUST be a **string** — the serialized markdown produced by
calling `serialize()` from `lib/story-body/story-body.js`. Do NOT emit `body`
as a JSON object: `createOp` in `epic-spec-reconciler-ops.js` will throw
`StoryBodyParseError` when it receives an object body (Story #3302
serialize-or-throw contract), and `composeStoryBody` in the GitHub provider
also discards non-string bodies producing an empty issue. The freshness gate
(`collectTaskChangesPaths`) and the assumption gate
(`collectStoryAssumptionEntries`) both parse the string body via
`story-body.js#parse` to recover `changes[]`/`references[]` — they operate
correctly only on the serialized string form.

The `acceptance[]` and `verify[]` arrays live at the **top level** of the
Story ticket object (not nested inside `body`). The validator's
`hasInlineAcceptanceAndVerify(story)` reads `story.acceptance` and
`story.verify` directly — nesting them inside a body object makes them
invisible to the validator, causing the backlog to be treated as the legacy
4-tier shape and producing a `Cross-Validation Failed: Backlog must contain at
least one Task.` error.

The serialized `body` string renders these markdown sections in order: `##
Goal` (one sentence), `## Changes` (object-form `{ "path", "assumption" }`
bullets), `## Acceptance` (checkbox items), `## Verify` (command + tier), and
`## References` (read-only `{ "path", "assumption": "exists" }` bullets).
Fields `wide` and `estimated_test_files` are encoded as a `<!-- meta: {...}
-->` comment appended to the serialized body string (handled by `serialize()`).
They are NOT top-level ticket fields.

#### STORY BODY RULES

- **slug**: MUST be hyphen-case (`^[a-z0-9][a-z0-9-]*$`). Do not use underscores.
- **goal** (in body string): One sentence stating WHY this Story exists within the Epic.
- **reason_to_exist** (REQUIRED, encoded in the body `<!-- meta: {...} -->` comment — NOT a top-level ticket field): One sentence stating the single coherent reason this Story exists, distinct from the broader `goal` prose. Every Story MUST carry a non-empty `reason_to_exist`; it is the machine-checkable form of the cohesion rule (**one Story = one coherent change with one reason to exist**). The `epic-plan-consolidate` critic flags any Story whose body carries no non-empty reason, and the sizing validator (`ticket-validator-sizing.js`) emits a deterministic **soft** `missing-reason-to-exist` finding as the runtime backstop. Encode it as `<!-- meta: {"reason_to_exist": "..."} -->`.
- **changes** (in body string): Each entry is an object `{ path, assumption }` where `assumption` is one of `creates | refactors-existing | deletes`. The Phase 8 validator probes the base branch for every declared path and rejects the decompose when the declared assumption contradicts reality: `creates` against an existing path is an error, `refactors-existing` / `deletes` against a missing path is an error. Use `refactors-existing` for in-place edits to a file already on `main`; `creates` for net-new files; `deletes` for removals. Acceptable path shapes include explicit files (`src/components/Foo.tsx`), glob patterns (`tests/e2e/*.spec.ts`, `**/*.astro`), and module identifiers that resolve to files.
- **references** (in body string, optional): Object-form entries `{ path, assumption: "exists" }` for paths the Story **reads** but does not modify (test fixtures it relies on, sibling modules it imports, feature files it scans). The validator probes these like `changes` and rejects the decompose when an `exists` path is absent on the base branch. Use this list to make read-dependencies explicit so a hallucinated or stale assumption surfaces at planning time rather than execution time.
- **NEW-FILE CONTRACT (must-follow)**: Any path the Story references in `goal`, `acceptance`, or `verify` that does **not** already exist on `main` MUST also appear in the same Story's `changes` array with `assumption: "creates"`. The freshness validator probes `main` for every referenced code path and rejects the decompose when a missing path is absent from `changes` — even when the Story is the one authoring the file. Example: a Story creating `tests/lib/foo.test.js` whose `verify` runs `node --test tests/lib/foo.test.js` MUST include `{ "path": "tests/lib/foo.test.js", "assumption": "creates" }` in `changes`, otherwise the validator emits a freshness miss and the decompose round trips for a re-emit.
- **acceptance** (top-level array on ticket object): Items MUST be observable from outside the agent. Acceptable shapes: a specific command exits 0, a file exists at a given path, a snapshot test matches, a `data-testid` resolves under a given selector, a row count in a fixture matches. UNACCEPTABLE: "verify by reading the diff", "looks good", "matches the spec" — push these down into a `verify` command instead.
- **verify** (top-level array on ticket object): Each entry MUST name a testing tier in parentheses, drawn from `unit` / `contract` / `e2e` / `validate`. Example: `npm run test -- src/x.test.ts (unit)`, `npm run validate (validate)`. Stories with zero verify entries SHOULD fail validation; if a Story is genuinely unverifiable in isolation (e.g., a copy edit auditor will eyeball), the literal entry `manual:<reason>` is allowed so the absence is intentional, not lazy. Manual entries without a reason are rejected.
- **estimated_test_files** (optional, encoded in body meta comment): Integer estimate of how many test files this Story creates or modifies. Omit when the number is not estimable. Informational only — it does not gate the decompose.

#### FORBIDDEN SUBJECT-PREFIX PRESCRIPTIONS (Conventional-Commits only)

- `acceptance` items MUST NOT prescribe a commit subject that begins with a non-Conventional-Commits prefix. The allowed leading types are `feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert` (matching `commitlint.config.js` and `release-please-config.json`). Historic ad-hoc subject prefixes — such as the legacy `baseline-refresh` token used as a leading prefix — are FORBIDDEN as subject prescriptions, because they fail the local `commit-msg` hook and the close-time validator (`ticket-validator.js` → `validateAcceptanceSubjectPrefix`) will reject the decompose with `code: 'forbidden-subject-prefix'`. When a Story needs a baseline-refresh-style classification, prescribe a Conventional-Commits subject (e.g. `chore(baselines): refresh maintainability snapshot`) and, if a machine-readable marker is required, prescribe a body trailer such as `baseline-refresh: true` (note the trailing space and value, not a subject prefix). See Epic #2501 for the rationale.

#### STORY SIZING — DELIVERABLE GRANULARITY, COHESION FIRST (the numeric ceiling is only a backstop)

**Decompose at deliverable granularity, not module/task level.** A Story is a **capability slice a frontier model delivers and self-verifies in one pass** — a shippable slice a reviewer would accept as a single PR, a capability or user-visible surface, **not a single module or file**. Fold module-level slices into the capability they belong to rather than emitting one Story per module. (This definition is the single source of truth in `DELIVERABLE_GRANULARITY_GUIDANCE` in `ticket-validator-sizing.js`; the rendered decomposer prompt interpolates the same string — do not restate a divergent version here.)

The first question is **cohesion, not count**: *is this one coherent change with one reason to exist?* File count cannot tell a trivial 10-file mechanical rename from a hard 3-file parser+caller+config change — so lead with the change's reason, not its size. Size against the real one-pass delivery envelope (`maxTokenBudget`): a Story is correctly sized when a single agent can hold its full change, acceptance, and verification in one pass within that budget.

The envelope also has a **floor**, not just a ceiling: a Story that would plausibly use well under a third of `maxTokenBudget` and is neither parallel-deliverable nor orthogonal to its siblings is a **merge candidate** — modern frontier models one-shot capability-sized changes, so a chain of small dependent Stories needlessly pays a full per-Story delivery session (hydration, branch, PR, review, CI) per link. This is soft guidance, not a threshold or validator finding; the canonical phrasing lives in `DELIVERABLE_GRANULARITY_GUIDANCE.envelopeFloor` in `ticket-validator-sizing.js`, which the decomposer prompt interpolates — do not restate a divergent version here.

- **One Story = one coherent change with one reason to exist.** If you cannot state that reason in a sentence, the Story is probably two Stories.
- **Single-consumer merge rule.** A Story whose only consumer is one sibling Story should be **merged into that sibling** rather than emitted separately — a single-consumer downstream slice is not its own unit of work.
- **Split independent, parallelizable work** into sibling Stories — but only when the pieces genuinely have separate reasons to exist.
- **Declare `wide` with a one-line reason when a change is legitimately broad** (a cohesive cutover that spans many files for one reason).

**Numeric backstop.** The thresholds are defined **once**, in the `DEFAULT_TASK_SIZING` constant in `ticket-validator-sizing.js` (operator-overridable via `agentSettings.planning.taskSizing`). They are a backstop, not the primary rule — do not restate divergent numbers anywhere else. The defaults:

- A Story touching more than **`softFiles` (15)** files emits an advisory width finding — a nudge to check cohesion or declare `wide`.
- A Story touching more than **`hardFiles` (30)** files is **rejected** unless it declares `wide` with a reason.
- Acceptance mass is **advisory only**: more than **`softAcceptanceCount` (10)** acceptance items emits an advisory warning. There is NO hard acceptance ceiling — a long binding contract is a signal to re-check cohesion, never a reason to fragment one coherent capability into dependent slices.

#### DELIVERY-SCHEDULE SIMULATION (the story count must earn itself)

Before emitting, simulate the delivery schedule the plan implies and judge the
plan by its schedule, not by how tidy the taxonomy looks. The canonical rules
live in the rendered decomposer prompt (`decomposer-prompts.js`) — in brief:

1. **Build the wave schedule.** A Story runs only after every `depends_on`
   completes, and two Stories that name the same file in `changes[]` cannot
   run in the same wave (the scheduler serializes file-overlapping Stories
   even when no `depends_on` edge links them).
2. **Compute the parallelism yield** — story count ÷ critical-path length in
   waves. A yield near 1.0 means the plan is a serial chain: N Stories that
   deliver no faster than one Story while paying N delivery sessions.
3. **Every Story must earn its slot** by at least one of **(a) parallelism**
   (it runs concurrently with a sibling in the schedule just built — not
   merely "logically independent"), **(b) risk isolation** (it isolates a
   consumer-facing behavior change or high-risk cutover into its own
   reviewable, revertable unit), or **(c) envelope pressure** (merged into its
   neighbor it would exceed the one-pass delivery envelope).
4. **A dependent link with none of those justifications merges into its
   consumer** — the single-consumer merge rule generalized from pairs to
   chains.
5. **Hot-file rule.** When one file appears in the `changes[]` of more than a
   third of the Stories, the slicing axis cuts across a shared seam — merge
   the Stories that co-edit it, or re-slice along the seam.

End each Story's `reason_to_exist` with its justification letter and one
clause, e.g. "… (a: runs in wave 1 alongside <slug>)" or "(b: isolates the
auto-merge default change)". A reason that names only a topic ("config work",
"docs") with no justification is a merge signal.

#### DELIVERY SLICING (consume the Tech Spec target grouping when present)

The Epic body's Tech Spec sections may carry a `## Delivery Slicing` section authored by the
Architect, proposing how the Epic's enumerated capabilities cluster into N
shippable Stories. When that section is **present**, treat it as the **target
grouping**: prefer emitting Stories that match the Architect's proposed
clusters rather than mapping Epic capabilities 1:1. When it is **absent**,
degrade gracefully — decompose at deliverable granularity using the cohesion
rules above, exactly as before. The Phase 8 holistic consolidation pass
(`epic-plan-consolidate`) reconciles your draft against this same Delivery
Slicing target before persist, so aligning to it here reduces the work the
consolidation critic has to do.

#### `wide` DECLARATION (optional — for legitimately broad changes)

A Story whose footprint is legitimately broad declares `wide` carrying a one-line human-readable reason. Encode it in the `<!-- meta: {"wide": {"reason": "..."}} -->` comment that `serialize()` appends to the body string — e.g. `"wide": { "reason": "hard contract cutover: migrate every <X> call site in one PR" }`.

Declaring `wide` with a non-empty reason **lifts the `hardFiles` rejection** — no Story is rejected for width when it states why it is broad. Omit `wide` for ordinary Stories; a wide footprint with no `wide` declaration emits only an advisory nudge (check cohesion or declare `wide`), never a rejection on its own. Glob entries in `changes[]` (bullets containing `*`) are `unknown-width`: the numeric ceiling is skipped, and a glob Story with no `wide` declaration emits the same advisory nudge.

#### UI / TESTID INVARIANCE (per CLAUDE.md safety rule)

- Stories that touch UI (`*.tsx`, `*.astro`, `*.svelte`, `*.vue`, components folders) MUST end `changes` with one of:
  - `data-testid invariance: <list of testids that MUST be preserved>`, or
  - `data-testid changes: <old> -> <new>` paired with a corresponding `tests/e2e/*.spec.ts` edit in the same Story or a depends_on Story.
- Renaming a testid without the matching e2e edit is FORBIDDEN.

#### BRAND / COPY / STYLE WORK

- Stories that touch user-visible copy, brand assets, or visual style MUST cite the relevant section of `docs/style-guide.md` in `acceptance` (e.g. `"acceptance": ["Hero copy matches docs/style-guide.md §3 (voice & tone)"]`). If `docs/style-guide.md` does not exist or has no relevant section, state that explicitly: `"acceptance": ["docs/style-guide.md absent — copy reviewed against the inline brand brief in the Epic body"]`. Silence on style sourcing is a smell.

#### BINDING ACCEPTANCE vs ADVISORY CHANGES (authoring altitude)

The canonical altitude + New-File Contract wording is single-sourced in `AUTHORING_ALTITUDE_GUIDANCE` in `ticket-validator-sizing.js` (Story #4272); the rendered decomposer prompt interpolates the same strings, so do not restate a divergent version here. The three canonical statements:

- **Binding contract vs advisory sketch.** `acceptance[]` and `verify[]` are the Story's **binding contract** — the executor MUST satisfy them exactly, and they are the only definition of "done." `changes[]` and `references[]` are an **advisory implementation sketch**: your best prediction of the file footprint, which the executor MAY revise when the real codebase diverges from the sketch. Author `acceptance[]` / `verify[]` to assert the **outcome** independent of any one file layout — never pin an incidental implementation detail (an internal helper name, a private file path) into an acceptance item that the advisory `changes[]` is free to reshape; assert the observable behaviour instead.
- **New-File Contract.** Any path named in a Story's `goal`, `acceptance`, or `verify` that does NOT already exist on `main` MUST also appear in that Story's `changes[]` with `assumption: "creates"`; otherwise the freshness validator rejects the decompose — even when the Story is the one authoring the file.
- **Advisory does not mean unvalidated.** `changes[]` paths still pass the base-branch file-assumption probes (a `creates` against an existing path still fails), the New-File Contract still holds, and the executor's latitude to revise the approach never licenses skipping `acceptance[]` / `verify[]` or relaxing any `rules/security-baseline.md` MUST.

#### NAVIGATE-DON'T-DEEP-LINK (signed-in acceptance scenarios)

When a Story's acceptance describes a **signed-in / authenticated** persona reaching a feature surface, author it so the persona starts from their authenticated home and **reaches the feature through navigation** — clicking a nav door, menu entry, or link the UI actually exposes — **never** via a hardcoded deep-link URL.

- A deep-link scenario (`load /reports/export and assert the export button`) proves the page renders but NOT that it is reachable; it masks an orphaned surface that no navigation door points to.
- Phrase it as: `"From the signed-in home, the persona navigates to Reports → Export and sees the export button"` — not `"GET /reports/export returns the export view"`.
- This applies to signed-in journeys only; an unauthenticated landing page or a deliberately deep-linkable share URL is exempt — say so in the acceptance item when you take that exemption.

### WAVE-0 BDD SCAFFOLD STORY (features-first; emit when the Acceptance Table has `new`-disposition rows)

The Epic body's `## Acceptance Table` section (columns `AC ID | Outcome | Feature File | Scenario | Disposition`) tags each row's `Disposition` with one of `new | updated | unchanged`. A `new` row names a `.feature` file + scenario that does NOT yet exist on `main`. The framework is features-first: implementation Stories reference those `.feature` paths in their `verify[]` lines, so the files MUST already exist when those Stories run — otherwise verification fails mid-delivery on a missing file (observed gap: Epic #18 in `dsj1984/athportal` had 9 `new` rows and no Story tasked with creating the feature files Stories #1457 / #1466 verified against).

When the Acceptance Table contains **one or more `Disposition: new` rows**, you MUST emit **exactly one** dedicated wave-0 scaffold Story whose sole job is to create those `.feature` files with `@skip`-tagged scenarios BEFORE any implementation Story runs:

- **goal** (in body string): contains the literal token `bdd-scaffold`.
- **depends_on**: EMPTY (`[]`) — the scaffold runs first, in wave 0.
- **changes** (in body string): one `{ path, assumption: "creates" }` entry per distinct `.feature` file named in a `new` row.
- **acceptance** (top-level array): MUST assert (a) every new `.feature` file exists, (b) every new scenario within them carries an `@skip` tag, AND (c) every new scenario also carries its **namespaced per-Epic AC tag** `@epic-<id>-ac-N` (one tag per AC ID the scenario satisfies). Keep items observable (a command exits 0; a file exists at a path).
- **The namespaced AC tag is REQUIRED at scaffold time, not only at de-skip time.** Phase 7 finalize's `acceptance-spec-reconciler.js` matches AC IDs only against `@epic-<id>-ac-*` / `@pending` tags under `tests/features/**` — a bare `@ac-N` tag is deliberately ignored to prevent cross-Epic collision (Story #3362). A scaffolded scenario carrying `@skip` but no `@epic-<id>-ac-N` tag reads as `missing[]` at finalize and throws, aborting close, even after the implementation Story de-skips it — the tag was never added in either pass. Tag each scenario with both `@skip` AND `@epic-<id>-ac-N` (substituting the Epic's real ID and the scenario's own AC number) in this SAME wave-0 commit; do not defer the AC tag to the later de-skip edit.
- **verify** (top-level array): a grep/validate command (tier `validate`), NOT an e2e runner — verifying that a file exists with the required tags needs no browser/playwright run. Include a check that each new AC ID's namespaced tag is present in the scaffolded files, alongside the `@skip` check.
- Each implementation Story whose `verify[]` references a scaffolded `.feature` path MUST add `depends_on: ["<scaffold-slug>"]` so the scaffold lands in an earlier wave. Omitting the link trips the soft `missing-bdd-scaffold` finding in `ticket-validator-conflicts.js` (advisory, not a hard block).

When the Acceptance Table contains **zero `new`-disposition rows** (every row is `updated` or `unchanged`), do NOT emit a scaffold Story — there is nothing to create.

> **Read [`examples.md`](./examples.md) on demand** for a fully worked wave-0
> scaffold Story (Epic #42, two `new` rows) showing the serialized string
> `body`, the top-level `acceptance`/`verify` arrays, the empty `depends_on`,
> and the paired `@skip` + `@epic-<id>-ac-N` tagging.

### SCOPE-OVERLAP FLAGGING (docs/runbook downstream of config work)

When a "docs update" / "runbook" / "README" Story appears downstream of an earlier Story in the same Epic whose AC already covers updating the same document (e.g. a "config + runbook" Story followed by a "docs" Story touching the same runbook), the downstream Story's deliverable may be fully absorbed by the earlier Story. Flag the risk directly in the Story `body.acceptance` by appending an item of the form:
"Scope verification note: this Story's deliverable may already be satisfied by Story #<slug-or-id>'s AC — before implementing, `git diff main -- <path>` against the upstream Story branch and confirm whether a substantive edit is still required, or whether only a cross-reference remains."
This prevents the executing agent from redoing work the upstream Story already merged.

### CROSS-CUTTING CONFIG FILE EDITS (shared root files across Stories)

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

### WIDELY-USED SYMBOL DELETION (Story #2962)

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

CRITICAL: Dependencies should follow execution blockers. Stories attach
directly to the Epic — never emit a `parent_slug` field. A Story's
`depends_on` MUST only reference other Stories within the SAME Epic; express
any logical ordering requirement via Story-level `depends_on`.

## Constraints

- Do **not** call the GitHub API from this Skill. Persistence is the
  script's job; the Skill is pure JSON authoring.
- Do **not** write outside `temp/epic-<Epic_ID>/`. Reads may cover the
  Epic body plus any docs the context envelope cites.
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
