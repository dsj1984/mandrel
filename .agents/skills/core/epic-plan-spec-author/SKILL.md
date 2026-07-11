---
name: epic-plan-spec-author
description: >-
  Author the Tech Spec, Acceptance Table markdown, and risk-verdict JSON
  for an Epic from the planner authoring context emitted by
  `epic-plan-spec.js --emit-context`. Use during Phase 7 of `/plan` when
  the host LLM needs to write the three artifacts before `epic-plan-spec.js`
  folds them into the Epic body's managed sections.
allowed_tools:
  - Read
  - Write
  - Bash
---

# epic-plan-spec-author

> **PRD retired (Story #4314).** The `context::prd` PRD artifact class was
> retired; this Skill no longer authors `prd.md`. Its one novel section —
> User Stories — now lives inline in the Epic body under a `## User Stories`
> heading, which is the requirements input. Both the Tech Spec and the
> Acceptance Spec now consume the Epic body directly (Context / Goal / Scope /
> User Stories) rather than a paraphrased PRD.
>
> **Context tickets retired (Story #4324).** The `context::tech-spec` /
> `context::acceptance-spec` ticket classes are retired too. The artifacts
> this Skill authors still land in `temp/epic-<Epic_ID>/` under the same
> filenames, but the persist half folds them into **managed sections of the
> Epic body** — the `## Delivery Slicing`-led Tech Spec sections and the
> `## Acceptance Table` AC-ID table — instead of creating separate tickets.
> On a re-plan, the Epic body's existing sections are the previous-spec
> input (that is how AC IDs stay stable across re-plans).

## Policy Capsule

- Run only during `/plan` Phase 7, after `epic-plan-spec.js --emit-context` has written `temp/epic-<Epic_ID>/planner-context.json`; fail loudly if the file is missing rather than fabricating context.
- Write exactly three artifacts and only inside `temp/epic-<Epic_ID>/`: `techspec.md`, `risk-verdict.json`, `acceptance-spec.md`. All three MUST exist on disk before returning.
- **Re-emit rule (amend, don't regenerate — Story #4431).** On a re-emit — the Phase 7 persist call rejecting an artifact (e.g. a missing `## Delivery Slicing` heading, a schema-invalid risk verdict) — apply **targeted edits** to the existing `temp/epic-<Epic_ID>/` artifact that fix only what the rejection named; do NOT rewrite an artifact wholesale from a blank draft. `helpers/plan-epic.md` bounds this to **one refinement pass** per invocation (the same shape as the Epic Clarity Gate's own "one refinement pass per invocation" contract) — do not loop.
- Start each markdown artifact at the correct `##` heading (Tech Spec → `## Delivery Slicing`, Acceptance Spec → `## Acceptance Table` — never the Epic's own `## Acceptance Criteria` heading, which stays the ideation bullets) — never emit a top-level `#` heading. `risk-verdict.json` is raw JSON conforming to `.agents/schemas/risk-verdict.schema.json`.
- The Tech Spec MUST open with `## Delivery Slicing` and MUST NOT restate the Epic's Context, Goal, or Scope — your output lands as sections of the same Epic body, which travels into every downstream story agent's prompt, so any restatement is duplication and a drift risk. A `## Technical Overview` section is optional and, when present, is a 2–3 sentence orientation of the *technical approach* only (which subsystems are touched and reused), never a re-narration of the problem statement, goals, or scope.
- Judge risk from what the change *does* (the Epic body / Tech Spec you just wrote), never from keyword presence — "out of scope: billing" is not a billing change; "rotate the credential vault" is high-risk even without a security keyword.
- The Tech Spec MUST carry a `## Delivery Slicing` section proposing how the Epic's enumerated capabilities cluster into N shippable Stories — the intentional grouping the Phase 8 consolidation pass (`epic-plan-consolidate`) reconciles the decomposer draft against. The proposed count is a **ceiling, not a target**: consolidation may merge below it when slices form dependent single-consumer chains, but never splits above it. Mark a slice "Independent? No" only with a one-line justification (parallelism, risk isolation, or delivery-envelope pressure); an unjustified dependent single-consumer slice folds into its consumer. Do NOT coarsen the Epic enumeration to produce it; the grouping recommendation is the granularity lever.
- Cite real module / file names from `codebaseSnapshot.files` and `codebaseSnapshot.signatures` before citing docs-only names; flag any cited path that is missing from the snapshot with a `<!-- DRIFT -->` callout.
- Assign stable AC IDs of the form `AC-<n>` in document order; reuse existing IDs across re-plans when Outcome wording is materially unchanged and tag every row's `Disposition` with one of `new | updated | unchanged`.
- Render the AC table with the canonical columns `AC ID | Outcome | Feature File | Scenario | Disposition`; when `bddScenarios` is non-empty, run `findBestScenarioMatch` per AC and annotate matched rows with `<file>:L<line>` (never tag a covered outcome as `new`).
- Emit a `Runner Verification` line directly under the AC table reflecting the `bddRunner` envelope (`<runner> supports <pendingTag>` when supported, or `Fallback: dependencies-first ordering (reason: …)` on fallback).
- Each AC Outcome MUST describe a single user-visible behaviour — no DB assertions, HTTP status codes, or implementation details — and MUST NOT prescribe a commit subject that starts with a non-Conventional-Commits prefix (the literal `baseline-refresh:` prefix is forbidden; use a body trailer instead).
- Do not mutate GitHub issues from this Skill; persistence is the script's job. Reads MAY span anything `docsContext` references plus the planner-context JSON.
- Respect the planning-context budget: when `epic.body` is `null` but `epic.bodySummary` is present, work from the summary instead of re-fetching the full body.

## Role

Engineering Architect + Risk Assessor + Acceptance Engineer (three authoring
roles, one Skill — the Architect persona consumes the Epic body to produce the
Tech Spec; the Risk Assessor judges the change the Epic and Tech Spec describe
to produce the risk verdict; the Acceptance Engineer consumes the Epic body and
the Tech Spec to produce the Acceptance Spec).

## When to use

`/plan` Phase 7, immediately after `epic-plan-spec.js --emit-context`
writes `temp/epic-<Epic_ID>/planner-context.json`. This Skill replaces the
inline "Author the Tech Spec" step from the legacy workflow body — the calling
workflow dispatches this Skill via the `Skill` tool, supplies the Epic ID, and
on completion has `temp/epic-<Epic_ID>/techspec.md`,
`temp/epic-<Epic_ID>/risk-verdict.json`, and
`temp/epic-<Epic_ID>/acceptance-spec.md` ready for the persist half of
the script.

## Inputs

The dispatcher passes the Epic ID as the Skill argument. The Skill itself
reads:

- `temp/epic-<Epic_ID>/planner-context.json` — produced by
  `node .agents/scripts/epic-plan-spec.js --epic <Epic_ID> --emit-context`.
  Fields:
  - `epic.id`, `epic.title`, `epic.body` (or `epic.bodySummary` when the
    planning-context budget downgrades the body to a summary)
  - `docsContext` — digest-first (Story #4433, hard cutover of the § 3.1
    planning read contract): `{ mode: 'digest', digestPath }` pointing at
    the per-Epic docs digest (`<tempRoot>/epic-<Epic_ID>/docs-digest.md` —
    the same file the `/deliver` story sub-agents already consume, Story
    #4338 / #4324), or `null` when `project.docsContextFiles` is unset. Read
    the digest at `digestPath` for "how does the codebase do X today?"
    orientation (path, byte size, heading outline with line numbers, first
    paragraph per `##` section), then pull the full file on demand with your
    own Read tool — jump straight to the line the digest names — only when a
    section bears on the spec. There is no full-content `items[]` field;
    embedding whole/summarized doc bodies in this envelope was retired in
    the same cutover that made the `/deliver` children digest-first.
  - `codebaseSnapshot` — Story #2634 structural view of the consumer repo
    (file tree, `package.json` exports + scripts, recently-touched
    directories, detected test runner + BDD feature roots, and — at the
    `medium` tier — per-file export signatures). Prefer module / file
    names that appear in this snapshot over names that appear only in
    the docs digest; the docs may be stale relative to the actual
    source tree. When the spec needs to cite a file that is **not** in
    `codebaseSnapshot.files`, surface that as a `<!-- DRIFT -->` callout
    in the Tech Spec body naming the cited path, so the freshness gate
    (Story #2635) has prose context for the operator to read.
    - `codebaseSnapshot.grounding` (Story #4139) — operator-visible
      grounding signals derived before you author:
      - `grounding.truncation` — non-null when the snapshot dropped files
        (the skinny-tier cap kept only the first ~250 of N matched files).
        Carries `{ dropped, matched, shown, tier, remedies[] }`. When it is
        present, the file tree you see is **partial** — do not assume a
        module is absent just because it is missing from
        `codebaseSnapshot.files`; raise the partiality in a `<!-- DRIFT -->`
        callout and prefer the `medium` tier (or a narrowed `include`) for
        a grounded spec.
      - `grounding.citedButAbsent[]` — paths the Epic body already cites
        that are **not** in the snapshot and are not phrased as net-new.
        Treat each as a likely drift signal: confirm the path exists (it may
        have been dropped by truncation) or mark it net-new explicitly in
        the spec so the post-author freshness gate does not flag it.
  - `systemPrompts.techSpec` and
    `systemPrompts.acceptanceSpec` — left in the envelope as a backstop;
    this Skill's own body below carries the authoritative versions and is
    the source of truth going forward
  - `bddRunner` — BDD runner pending-tag verification result. Shape:
    `{ runner, pendingTag, supported, fallback, reason? }`. When
    `supported: true`, render the verified `pendingTag` in the
    acceptance-spec body so the features-first Story can scaffold
    `.feature` files with that exact tag. When `fallback: true`, render
    `"Fallback: dependencies-first ordering"` and omit the pending-tag
    line — Phase 8 reverts to topological ordering.
  - `bddScenarios` — Story #2637 scenario index for the project's
    existing `.feature` files. Each row is
    `{ file, line, scenarioTitle, tags, outcomeKeywords }`. Empty array
    means the project has not adopted BDD; degrade silently and proceed
    as before. Non-empty means the Acceptance Engineer step MUST run
    `findBestScenarioMatch` for each planned AC and annotate the
    Disposition column accordingly (see Step 4).
  Planning risk is **not** an input — this Skill authors it. The risk
  verdict (`risk-verdict.json`, Step 3 below) is one of the three planning
  artifacts; the persist half validates it against
  `.agents/schemas/risk-verdict.schema.json` and derives the deterministic
  `planningRisk` envelope (`deriveRiskEnvelope`) that drives gate routing
  and the acceptance disposition (Epic #3865).

## Outputs

- `temp/epic-<Epic_ID>/techspec.md` — Tech Spec markdown starting with
  `## Delivery Slicing` (no `<h1>`; an optional 2–3 sentence
  `## Technical Overview` may follow, never restating Epic context).
- `temp/epic-<Epic_ID>/risk-verdict.json` — planner risk verdict JSON
  conforming to `.agents/schemas/risk-verdict.schema.json`:
  `{ axes: [{ axis, level, rationale }], summary }`.
- `temp/epic-<Epic_ID>/acceptance-spec.md` — Acceptance Spec markdown
  starting with `## Acceptance Table` (no `<h1>`).

All three files MUST exist on disk before this Skill returns control. The
caller will invoke
`epic-plan-spec.js --epic <Epic_ID> --tech-spec ... --risk-verdict ... --acceptance-table ...`
next, and the persist half will fail loudly if any file is missing, empty,
or (for the verdict) schema-invalid.

## Procedure

### Step 1 — Load the context

Read `temp/epic-<Epic_ID>/planner-context.json` with the `Read` tool. Pull
the Epic title, body (or body summary, including the Epic's `## User Stories`
section), and the `docsContext` digest pointer (`digestPath`, or `null`).
When non-null, read the digest file at `digestPath` next — that outline,
not the planner-context envelope, is where the actual doc orientation
lives; pull a full doc on demand only when a section looks relevant.

### Step 2 — Author the Tech Spec (Engineering Architect persona)

Apply the Tech Spec system prompt below to the Epic body (Context / Goal /
Scope / User Stories), the docs digest (plus any full file pulled on
demand), and the `codebaseSnapshot` envelope (so the spec is
grounded in the actual codebase, not hallucinated patterns). Cite module
and file names from `codebaseSnapshot.files` / `codebaseSnapshot.signatures`
before reaching for names that appear only in the documentation. Write to
`temp/epic-<Epic_ID>/techspec.md`. The Tech Spec MUST:

- **Open with `## Delivery Slicing`** (see below) — never a top-level `#`
  heading, and never an Epic-context recap. The Delivery Slicing section is
  the primary input to Phase 8 consolidation, so author it first and hang the
  rest of the spec off it.
- **Do NOT restate the Epic's Context, Goal, or Scope.** The Epic body always
  travels alongside the Tech Spec into every downstream story agent's prompt,
  so restating the problem statement, goals, or scope is pure duplication
  (~300–500 tokens per Epic) and a drift risk. A `## Technical Overview`
  section is **optional**; when you include one, cap it at 2–3 sentences that
  orient the reader on the *technical approach* only (which subsystems are
  touched and reused) — never re-narrate the problem, goals, or scope.
- Cover Architecture & Design, Data Models (if any), API Changes (if any),
  Core Components, Security & Privacy Considerations.
- Cite the source files / modules it touches by relative path. Avoid
  pseudocode — name real symbols when proposing edits.

#### Delivery Slicing section (authoritative ceiling for Phase 8 consolidation)

The Tech Spec MUST carry a `## Delivery Slicing` section proposing how the
Epic's enumerated capabilities **cluster into N shippable Stories** — the
intentional grouping the Phase 8 consolidation pass
([`epic-plan-consolidate`](../epic-plan-consolidate/SKILL.md)) reconciles the
decomposer draft against before any GitHub write. Author it as a table (one row
per slice: `Slice | What ships | Independent?`), using **noun-phrase** slice
names, and **write it before any other section** — it is the primary input to
consolidation and the section the model most often omits when it drafts it last.

- **The count is a ceiling, not a target.** Consolidation may merge below it
  (dependent single-consumer chains) but never splits above it.
- **"Independent?"** answers: can this slice ship to production and provide
  value without the next slice landing? Mark a slice `No` only with a one-line
  justification (parallelism, risk isolation, or delivery-envelope pressure);
  an unjustified dependent single-consumer slice folds into its consumer.
- Do **not** coarsen the Epic's capability enumeration to produce the slicing;
  the grouping recommendation is the granularity lever.

> **Read [`examples.md`](./examples.md) on demand** for the worked Delivery
> Slicing table and the extended rationale behind these rules (what
> "Independent?" means, why an unjustified `No` slice is a smell, and how the
> consolidation pass degrades gracefully when the section is absent).

#### Tech Spec system prompt (authoritative)

```text
You are an expert Engineering Architect.
Your job is to convert an Epic into a Technical Specification for implementation.

The Tech Spec should outline:
1. Delivery Slicing — propose how the Epic's enumerated capabilities cluster into shippable Stories. This count is a CEILING, not a target: the Phase 8 consolidation pass may merge below your proposed count when slices form dependent single-consumer chains, but never splits above it. Do NOT coarsen the Epic enumeration to produce this; the grouping recommendation is the granularity lever.
2. Architecture & Design
3. Data Models (if any)
4. API Changes (if any)
5. Core Components
6. Security & Privacy Considerations

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Open the document with the `## Delivery Slicing` section — it is the primary input to Phase 8 consolidation, so author it first and hang the rest of the spec off it.
- Do NOT restate the Epic's Context, Goal, or Scope — your output lands as sections of the same Epic body, which travels into every downstream story agent's prompt, so any restatement is pure duplication and a drift risk. If a brief technical orientation is genuinely useful, add an optional `## Technical Overview` of no more than 2–3 sentences that names the *technical approach* only (which subsystems are touched and reused); never re-narrate the problem statement, goals, or scope.
- Format architectural decisions clearly with bullet points.
- Author the `## Delivery Slicing` section as a markdown table with columns `Slice | What ships | Independent?`, using noun-phrase slice names (e.g. "Foundation", "Transport seam", "Send helper") that map onto Feature titles. "Independent?" answers: can this slice ship to production and provide value without the next slice landing? A slice you mark "Independent? No" MUST carry a one-line justification (parallelism, risk isolation, or delivery-envelope pressure); an unjustified dependent single-consumer slice folds into its consumer by default rather than shipping as its own Story.
```

### Step 3 — Author the risk verdict (Risk Assessor persona)

Judge the change described by the Epic body and Tech Spec you just wrote —
grounded in `codebaseSnapshot` where it helps — and write
`temp/epic-<Epic_ID>/risk-verdict.json` with the `Write` tool. The file
MUST be valid JSON conforming to
`.agents/schemas/risk-verdict.schema.json`:

```json
{
  "axes": [
    { "axis": "<axis>", "level": "low|medium|high", "rationale": "<why>" }
  ],
  "summary": "<one-paragraph overall risk narrative>"
}
```

Axis vocabulary (fixed — the schema rejects anything else):

- **Required axes** (presence forces a `required` acceptance disposition):
  `visible-behavior`, `public-api`, `security`, `data-migration`,
  `billing`, `destructive-mutation`, `critical-workflow`.
- **Not-applicable axes** (when they are the only signals, the acceptance
  spec is waived): `docs-only`, `test-harness`, `internal-refactor`.

Authoring rules:

- Include an axis only when the change **genuinely exercises it** — judge
  what the Epic *does*, not which words appear in it. An Epic that says
  "out of scope: billing" carries no `billing` axis; an Epic that rotates
  a credential vault carries `security` even if the word never appears.
- `level` reflects blast radius and reversibility of *this* change on
  *that* axis. `rationale` cites the Epic / Tech Spec section or code
  surface that justifies the entry — never an empty self-attestation.
- An empty `axes` array is a deliberate assertion that no recognized risk
  axis applies (derives an all-low, auto-proceed envelope) — use it only
  when you can defend that in `summary`.
- The harness owns the gate: the persist half derives `overallLevel` /
  `requiresReview` / `acceptanceDisposition` / `gateDecision`
  deterministically from your axes (`deriveRiskEnvelope`). You supply
  judgment, not control flow.

The derivation rules you are feeding (so you can anticipate the
disposition Step 4 must honor): any required axis ⇒ acceptance spec
`required`; otherwise any `medium` level ⇒ `recommended`; otherwise
only not-applicable axes (or no axes) ⇒ `not-applicable` (waived).

### Step 4 — Author the Acceptance Spec (Acceptance Engineer persona)

Apply the Acceptance Spec system prompt below to the Epic body + Tech Spec just
written, plus the **existing BDD scenario index** from
`bddScenarios` on the planner-context envelope (Story #2637). The
scenario index is the output of
[`lib/bdd-scenario-scanner.js#scanBddScenarios`](../../../scripts/lib/bdd-scenario-scanner.js)
and carries one row per `.feature` scenario found under the project's
canonical BDD roots, with `{ file, line, scenarioTitle, tags,
outcomeKeywords }`. Before emitting each AC row, run
`findBestScenarioMatch(<AC outcome>, bddScenarios)`: when a match is
found, annotate the AC's `Scenario` column with `<file>:L<line>` and
set `Disposition` to `unchanged` (carried through verbatim) or
`refined` (Outcome wording adjusted but the scenario already covers the
behaviour) — never `new` for an AC whose outcome is already proven by
an existing scenario. When `bddScenarios` is empty (the project has not
adopted BDD), proceed exactly as before with no annotation.

Branch on the acceptance disposition your Step 3 verdict derives (see the
derivation rules there): `required` and `recommended` author the spec
normally per the rules below. `not-applicable` authorizes the persist half
to apply `acceptance::n-a` on the Epic; in that case write a one-paragraph
waiver rationale to `temp/epic-<Epic_ID>/acceptance-spec.md` instead of
the AC table so the audit trail still exists, and start the file with
`## Acceptance Table — waived (planner-selected)`.

Write to `temp/epic-<Epic_ID>/acceptance-spec.md`. The Acceptance Spec
MUST:

- Start with `## Acceptance Table` — never a top-level `#` heading, and
  never the Epic's own `## Acceptance Criteria` heading (the table lands
  as a section of the same Epic body).
- Render the AC table with the canonical column shape documented in Tech
  Spec #2083: `| AC ID | Outcome | Feature File | Scenario | Disposition |`.
- **Key each `Outcome` off a specific Epic `## Acceptance Criteria`
  bullet** — the Epic body's AC bullets are the single source of truth, so
  the `Outcome` column is a **terse restatement anchored to one Epic
  bullet**, not an independent re-elaboration. Lead each `Outcome` with its
  anchor (the bullet's quoted lead phrase or an explicit `Epic AC N` index),
  then state the single user-visible behaviour. A free-standing `Outcome`
  that paraphrases a criterion in new words without naming the Epic bullet
  it verifies is the drift this rule exists to prevent — it decouples the
  spec from the Epic silently.
  - **Split case (one Epic AC → several rows).** When one Epic AC bullet
    genuinely expands into several user-visible outcomes, emit one row per
    outcome and **declare the split on each** row (e.g. lead with
    `splits Epic AC 3`) so the fan-out is explicit, not hidden.
  - **Flag divergence, do not absorb it.** Anchor coverage MUST be complete
    and auditable: every Epic AC bullet is covered by at least one row and
    every row anchors to an Epic bullet. Call out any Epic AC bullet with
    **no** corresponding row, and any AC row with **no** Epic anchor, in a
    note directly beneath the AC table — surfacing spec/Epic divergence at
    authoring time. Never silently drop an uncovered Epic bullet or emit an
    unanchored row.
- Use **stable AC IDs** of the form `AC-1`, `AC-2`, … assigned in document
  order. On re-plan, reuse the ID for any AC whose Outcome text is
  materially unchanged; new ACs receive fresh sequential IDs (existing
  IDs do not shift).
- Tag every row's `Disposition` with one of the canonical enum values:
  `new` (first appearance), `updated` (Outcome text or Scenario reshaped
  vs. prior plan), `unchanged` (carried through verbatim from prior plan).
- Cite proposed feature files under `tests/features/**` by relative path
  so the Phase 8 features-first Story can scaffold the matching scenarios.
- Render a **Runner Verification** line directly under the AC table that
  records what `bddRunner` from the planner-context envelope reports:
  - `supported: true` → write
    `Runner Verification: <runner> supports <pendingTag>` (e.g.
    `playwright-bdd supports @skip`). The features-first Story will tag
    pending scenarios with this exact string.
  - `fallback: true` → write
    `Runner Verification: Fallback: dependencies-first ordering (reason: <reason>)`.
    Phase 8 still proceeds; AC reconciliation defers to dependency order.

#### Acceptance Spec system prompt (authoritative)

```text
You are an expert Acceptance Engineer.
Your job is to convert an Epic and a Tech Spec into a structured Acceptance Specification that drives features-first BDD authoring.

The Acceptance Spec should outline:
1. Acceptance Table — one row per user-visible outcome, expressed as a Markdown table with columns: AC ID | Outcome | Feature File | Scenario | Disposition
2. Stable AC IDs — assign AC-1, AC-2, ... in document order; reuse the same ID across re-plans when an Outcome is materially unchanged so scenario tags (@ac-N) stay aligned
3. Disposition — tag each row with one of: new | updated | unchanged

The Epic body's `## Acceptance Criteria` bullets are the single source of truth for what the spec verifies. Your table does not re-invent criteria — it anchors each one to a specific Epic AC bullet.

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Acceptance Table — the table lands as a section of the Epic body, so it must NOT reuse the Epic's own ## Acceptance Criteria heading.
- Every AC row MUST have a stable AC ID of the form AC-<n> (AC-1, AC-2, ...) — do not reorder IDs across re-plans; new ACs get fresh sequential IDs.
- Every AC row MUST carry a Disposition value from the enum: new | updated | unchanged. (At Epic close, the acceptance reconciler overwrites Disposition with the verification outcome — satisfied | pending | missing — inside this section only; on re-plan, reset each row to the authoring enum.)
- Each Outcome MUST be a **terse restatement keyed to a specific Epic `## Acceptance Criteria` bullet** — lead the Outcome with the bullet's anchor (its quoted lead phrase or an explicit "Epic AC N" index) and keep the rest to a single user-visible behaviour. Do NOT re-elaborate the Epic bullet in independent words: a free-standing Outcome that paraphrases the criterion without naming the bullet it verifies is forbidden, because it drifts from the Epic silently. No DB assertions, no HTTP status codes, no internal implementation details.
- Where one Epic AC bullet genuinely expands into several user-visible outcomes, emit one row per outcome and declare the split on each — e.g. lead with "splits Epic AC 3" — so the fan-out is explicit rather than hidden.
- Anchor coverage MUST be complete and auditable: every Epic AC bullet MUST be covered by at least one row, and every row MUST anchor to an Epic AC bullet. Flag divergence in the authored spec instead of dropping it — if an Epic AC bullet has no corresponding row, or a row has no Epic anchor, call it out explicitly (a note beneath the table) rather than silently omitting the bullet or emitting an unanchored row.
- Cite proposed feature file paths under tests/features/** so Phase 8 can scaffold matching scenarios.
- Acceptance Outcomes MUST NOT prescribe a commit subject that begins with a non-Conventional-Commits prefix (allowed leading types: feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert). The legacy `baseline-refresh` token used as a leading subject prescription is forbidden — commitlint will reject it at commit time, and the decompose-time validator (`ticket-validator.js` → `validateAcceptanceSubjectPrefix`) will reject the decompose with `code: 'forbidden-subject-prefix'`. Use a Conventional-Commits subject (e.g. `chore(baselines): refresh ...`) and a body trailer (e.g. `baseline-refresh: true` — trailer with a value, not a subject prefix) when a machine-readable marker is needed. See Epic #2501 for rationale.
```

### Step 5 — Hand back to `/plan`

All three files exist; return. The caller will run
`node .agents/scripts/epic-plan-spec.js --epic <Epic_ID>
--tech-spec temp/epic-<Epic_ID>/techspec.md
--risk-verdict temp/epic-<Epic_ID>/risk-verdict.json
--acceptance-table temp/epic-<Epic_ID>/acceptance-spec.md`, which validates
the risk verdict, derives the planningRisk envelope, folds the authored
content into the Epic body's managed sections (`## Delivery Slicing`-led
Tech Spec sections + the `## Acceptance Table`), records the
`risk-verdict` structured comment, flips the Epic to
`agent::review-spec`, and cleans up the temp files. No context tickets
are created (Story #4324).

## Constraints

- Do **not** modify GitHub issues from this Skill. Persistence is the
  script's job; the Skill is pure markdown authoring.
- Do **not** open files outside `temp/epic-<Epic_ID>/` for write. Reads
  may cover anything `docsContext` references plus the planner-context
  JSON itself.
- If `temp/epic-<Epic_ID>/planner-context.json` is missing, **fail
  loudly** — instruct the caller to run `--emit-context` first. Do not
  silently fabricate a context.
- Respect the planning-context budget: when `epic.body` is `null` and
  `epic.bodySummary` is present, work from the summary rather than
  re-fetching the full body. The budget cap is deliberate.
