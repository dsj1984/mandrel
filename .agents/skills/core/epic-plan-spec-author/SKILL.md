---
name: epic-plan-spec-author
description: >-
  Author the PRD, Tech Spec, Acceptance Spec markdown, and risk-verdict JSON
  for an Epic from the planner authoring context emitted by
  `epic-plan-spec.js --emit-context`. Use during Phase 7 of `/plan` when
  the host LLM needs to write the four artifacts before `epic-plan-spec.js`
  persists them.
allowed_tools:
  - Read
  - Write
  - Bash
---

# epic-plan-spec-author

## Policy Capsule

- Run only during `/plan` Phase 7, after `epic-plan-spec.js --emit-context` has written `temp/epic-<Epic_ID>/planner-context.json`; fail loudly if the file is missing rather than fabricating context.
- Write exactly four artifacts and only inside `temp/epic-<Epic_ID>/`: `prd.md`, `techspec.md`, `risk-verdict.json`, `acceptance-spec.md`. All four MUST exist on disk before returning.
- Start each markdown artifact at the correct `##` heading (PRD → `## Overview`, Tech Spec → `## Technical Overview`, Acceptance Spec → `## Acceptance Criteria`) — never emit a top-level `#` heading. `risk-verdict.json` is raw JSON conforming to `.agents/schemas/risk-verdict.schema.json`.
- Judge risk from what the change *does* (the PRD / Tech Spec you just wrote), never from keyword presence — "out of scope: billing" is not a billing change; "rotate the credential vault" is high-risk even without a security keyword.
- The Tech Spec MUST carry a `## Delivery Slicing` section proposing how the PRD's enumerated capabilities cluster into N shippable Stories — the intentional target the Phase 8 consolidation pass (`epic-plan-consolidate`) reconciles the decomposer draft against. Do NOT coarsen the PRD enumeration to produce it; the grouping recommendation is the granularity lever.
- Cite real module / file names from `codebaseSnapshot.files` and `codebaseSnapshot.signatures` before citing docs-only names; flag any cited path that is missing from the snapshot with a `<!-- DRIFT -->` callout.
- Assign stable AC IDs of the form `AC-<n>` in document order; reuse existing IDs across re-plans when Outcome wording is materially unchanged and tag every row's `Disposition` with one of `new | updated | unchanged`.
- Render the AC table with the canonical columns `AC ID | Outcome | Feature File | Scenario | Disposition`; when `bddScenarios` is non-empty, run `findBestScenarioMatch` per AC and annotate matched rows with `<file>:L<line>` (never tag a covered outcome as `new`).
- Emit a `Runner Verification` line directly under the AC table reflecting the `bddRunner` envelope (`<runner> supports <pendingTag>` when supported, or `Fallback: dependencies-first ordering (reason: …)` on fallback).
- Each AC Outcome MUST describe a single user-visible behaviour — no DB assertions, HTTP status codes, or implementation details — and MUST NOT prescribe a commit subject that starts with a non-Conventional-Commits prefix (the literal `baseline-refresh:` prefix is forbidden; use a body trailer instead).
- Do not mutate GitHub issues from this Skill; persistence is the script's job. Reads MAY span anything `docsContext` references plus the planner-context JSON.
- Respect the planning-context budget: when `epic.body` is `null` but `epic.bodySummary` is present, work from the summary instead of re-fetching the full body.

## Role

Technical Product Manager + Engineering Architect + Risk Assessor +
Acceptance Engineer (four personas, one Skill — the PRD persona produces the
requirements; the Architect persona consumes the PRD to produce the Tech
Spec; the Risk Assessor judges the change the two specs describe to produce
the risk verdict; the Acceptance Engineer consumes all of them to produce
the Acceptance Spec).

## When to use

`/plan` Phase 7, immediately after `epic-plan-spec.js --emit-context`
writes `temp/epic-<Epic_ID>/planner-context.json`. This Skill replaces the
inline "Author the PRD" / "Author the Tech Spec" steps from the legacy
workflow body — the calling workflow dispatches this Skill via the `Skill`
tool, supplies the Epic ID, and on completion has `temp/epic-<Epic_ID>/prd.md`,
`temp/epic-<Epic_ID>/techspec.md`, `temp/epic-<Epic_ID>/risk-verdict.json`,
and `temp/epic-<Epic_ID>/acceptance-spec.md` ready for the persist half of
the script.

## Inputs

The dispatcher passes the Epic ID as the Skill argument. The Skill itself
reads:

- `temp/epic-<Epic_ID>/planner-context.json` — produced by
  `node .agents/scripts/epic-plan-spec.js --epic <Epic_ID> --emit-context`.
  Fields:
  - `epic.id`, `epic.title`, `epic.body` (or `epic.bodySummary` when the
    planning-context budget downgrades the body to a summary)
  - `docsContext.items[]` — bounded project docs scraped from the configured
    `docsRoot` (start with these for "how does the codebase do X today?"
    context; the validator already capped their size)
  - `codebaseSnapshot` — Story #2634 structural view of the consumer repo
    (file tree, `package.json` exports + scripts, recently-touched
    directories, detected test runner + BDD feature roots, and — at the
    `medium` tier — per-file export signatures). Prefer module / file
    names that appear in this snapshot over names that appear only in
    `docsContext.items[]`; the docs may be stale relative to the actual
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
  - `systemPrompts.prd`, `systemPrompts.techSpec`, and
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
    Disposition column accordingly (see Step 5).
  Planning risk is **not** an input — this Skill authors it. The risk
  verdict (`risk-verdict.json`, Step 4 below) is the fourth planning
  artifact; the persist half validates it against
  `.agents/schemas/risk-verdict.schema.json` and derives the deterministic
  `planningRisk` envelope (`deriveRiskEnvelope`) that drives gate routing
  and the acceptance disposition (Epic #3865).

## Outputs

- `temp/epic-<Epic_ID>/prd.md` — PRD markdown starting with `## Overview`
  (no `<h1>`).
- `temp/epic-<Epic_ID>/techspec.md` — Tech Spec markdown starting with
  `## Technical Overview` (no `<h1>`).
- `temp/epic-<Epic_ID>/risk-verdict.json` — planner risk verdict JSON
  conforming to `.agents/schemas/risk-verdict.schema.json`:
  `{ axes: [{ axis, level, rationale }], summary }`.
- `temp/epic-<Epic_ID>/acceptance-spec.md` — Acceptance Spec markdown
  starting with `## Acceptance Criteria` (no `<h1>`).

All four files MUST exist on disk before this Skill returns control. The
caller will invoke
`epic-plan-spec.js --epic <Epic_ID> --prd ... --techspec ... --risk-verdict ... --acceptance-spec ...`
next, and the persist half will fail loudly if any file is missing, empty,
or (for the verdict) schema-invalid.

## Procedure

### Step 1 — Load the context

Read `temp/epic-<Epic_ID>/planner-context.json` with the `Read` tool. Pull
the Epic title, body (or body summary), the `docsContext` items, and (for
reference) the two system prompts.

### Step 2 — Author the PRD (Technical Product Manager persona)

Apply the PRD system prompt below to the Epic title + body. Write the PRD
to `temp/epic-<Epic_ID>/prd.md` using the `Write` tool. The PRD MUST:

- Start with `## Overview` — never a top-level `#` heading.
- Contain four sections: **Context & Goals**, **User Stories**,
  **Acceptance Criteria**, **Out of Scope**.
- Be valid Markdown — no fenced code blocks of prose, no smart quotes that
  break the issue body renderer.

#### PRD system prompt (authoritative)

```text
You are an expert Technical Product Manager.
Your job is to convert a high-level Epic description into a structured Product Requirements Document (PRD).

The PRD should outline:
1. Context & Goals
2. User Stories
3. Acceptance Criteria
4. Out of Scope

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Overview.
- Format requirements clearly with bullet points and bold text where appropriate.
```

### Step 3 — Author the Tech Spec (Engineering Architect persona)

Apply the Tech Spec system prompt below to the PRD just written, the
`docsContext` items, and the `codebaseSnapshot` envelope (so the spec is
grounded in the actual codebase, not hallucinated patterns). Cite module
and file names from `codebaseSnapshot.files` / `codebaseSnapshot.signatures`
before reaching for names that appear only in the documentation. Write to
`temp/epic-<Epic_ID>/techspec.md`. The Tech Spec MUST:

- Start with `## Technical Overview` — never a top-level `#` heading.
- Cover Architecture & Design, Data Models (if any), API Changes (if any),
  Core Components, Security & Privacy Considerations.
- Include a **`## Delivery Slicing`** section (see below) proposing how the
  PRD's enumerated capabilities cluster into N shippable Stories.
- Cite the source files / modules it touches by relative path. Avoid
  pseudocode — name real symbols when proposing edits.

#### Delivery Slicing section (authoritative target for Phase 8 consolidation)

The Tech Spec MUST carry a `## Delivery Slicing` section in which the Architect
— who holds the full design — proposes how the PRD's enumerated capabilities
**cluster into N shippable Stories**. This section is the intentional target
grouping the Phase 8 consolidation pass
([`epic-plan-consolidate`](../epic-plan-consolidate/SKILL.md)) reconciles the
decomposer's draft against before any GitHub write. Without it, the decompose
phase maps PRD capabilities to Stories ~1:1 and cannot produce a coarser,
holistic plan; with it, the consolidation critic has a well-defined target
instead of a guess.

**Write the Delivery Slicing section before any other section — it is the
primary input to Phase 8 consolidation.** Author it first so the rest of the
spec (Core Components, API Changes, Data Models) hangs off a deliberate
slicing decision rather than being reverse-engineered into one at the end.
Drafting it last is exactly how the model omits it under the weight of the
other sections.

Author the section as a table — one row per proposed slice — naming the
capability cluster each slice would deliver, what ships in it, and whether it
can ship independently. Use **noun phrases** for slice names ("Foundation",
"Transport seam", "Send helper") so they map cleanly onto Feature titles in the
resulting decomposition — never verb phrases ("Add transport") or file names
("`sender.ts`"). Do **not** coarsen the PRD's capability enumeration to produce
the slicing: the granularity lever is *this* grouping recommendation, not a
dumbed-down PRD.

**What "Independent?" means:** can this slice ship to production and provide
value *without the next slice landing*? A `Yes` slice is releasable on its own;
a `No` slice only becomes valuable once a later slice lands on top of it.

Worked example:

```text
## Delivery Slicing

Proposed shippable slices (consolidation target for Phase 8):

| Slice          | What ships                                              | Independent? |
| -------------- | ------------------------------------------------------ | ------------ |
| Foundation     | Config schema, types, and the no-op default path       | Yes          |
| Transport seam | The pluggable transport interface + in-memory adapter  | Yes          |
| Send helper    | The send() helper built on the transport seam          | No           |

- **Foundation** folds PRD capabilities "config surface" + "type model" — they
  share a reason to exist and ship as one reviewable PR.
- **Transport seam** is the pluggable boundary; it provides value on its own
  (in-memory adapter is usable for tests) so it is independently shippable.
- **Send helper** depends on the transport seam landing first, so it is *not*
  independent — it is valuable only once Transport seam ships.
```

The consolidation pass degrades gracefully when this section is absent (it
falls back to cohesion + single-Story-Feature rules only), so authoring it is
how the Architect steers the decomposition toward fewer, right-sized Stories.

#### Tech Spec system prompt (authoritative)

```text
You are an expert Engineering Architect.
Your job is to convert a PRD into a Technical Specification for implementation.

The Tech Spec should outline:
1. Architecture & Design
2. Data Models (if any)
3. API Changes (if any)
4. Core Components
5. Security & Privacy Considerations
6. Delivery Slicing — propose how the PRD's enumerated capabilities cluster into N shippable Stories (the consolidation target for Phase 8). One bullet per proposed Story, naming the capability cluster it delivers. Do NOT coarsen the PRD enumeration to produce this; the grouping recommendation is the granularity lever.

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Technical Overview.
- Format architectural decisions clearly with bullet points.
- Include a `## Delivery Slicing` section proposing the shippable-Story grouping. Write the Delivery Slicing section before any other section — it is the primary input to Phase 8 consolidation. Author it as a markdown table with columns `Slice | What ships | Independent?`, using noun-phrase slice names (e.g. "Foundation", "Transport seam", "Send helper") that map onto Feature titles. "Independent?" answers: can this slice ship to production and provide value without the next slice landing?
```

### Step 4 — Author the risk verdict (Risk Assessor persona)

Judge the change described by the PRD and Tech Spec you just wrote —
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
  what the Epic *does*, not which words appear in it. A PRD that says
  "out of scope: billing" carries no `billing` axis; an Epic that rotates
  a credential vault carries `security` even if the word never appears.
- `level` reflects blast radius and reversibility of *this* change on
  *that* axis. `rationale` cites the PRD / Tech Spec section or code
  surface that justifies the entry — never an empty self-attestation.
- An empty `axes` array is a deliberate assertion that no recognized risk
  axis applies (derives an all-low, auto-proceed envelope) — use it only
  when you can defend that in `summary`.
- The harness owns the gate: the persist half derives `overallLevel` /
  `requiresReview` / `acceptanceDisposition` / `gateDecision`
  deterministically from your axes (`deriveRiskEnvelope`). You supply
  judgment, not control flow.

The derivation rules you are feeding (so you can anticipate the
disposition Step 5 must honor): any required axis ⇒ acceptance spec
`required`; otherwise any `medium` level ⇒ `recommended`; otherwise
only not-applicable axes (or no axes) ⇒ `not-applicable` (waived).

### Step 5 — Author the Acceptance Spec (Acceptance Engineer persona)

Apply the Acceptance Spec system prompt below to the PRD + Tech Spec just
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

Branch on the acceptance disposition your Step 4 verdict derives (see the
derivation rules there): `required` and `recommended` author the spec
normally per the rules below. `not-applicable` authorizes the persist half
to apply `acceptance::n-a` on the Epic; in that case write a one-paragraph
waiver rationale to `temp/epic-<Epic_ID>/acceptance-spec.md` instead of
the AC table so the audit trail still exists, and start the file with
`## Acceptance Criteria — waived (planner-selected)`.

Write to `temp/epic-<Epic_ID>/acceptance-spec.md`. The Acceptance Spec
MUST:

- Start with `## Acceptance Criteria` — never a top-level `#` heading.
- Render the AC table with the canonical column shape documented in Tech
  Spec #2083: `| AC ID | Outcome | Feature File | Scenario | Disposition |`.
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
Your job is to convert a PRD and a Tech Spec into a structured Acceptance Specification that drives features-first BDD authoring.

The Acceptance Spec should outline:
1. Acceptance Criteria — one row per user-visible outcome, expressed as a Markdown table with columns: AC ID | Outcome | Feature File | Scenario | Disposition
2. Stable AC IDs — assign AC-1, AC-2, ... in document order; reuse the same ID across re-plans when an Outcome is materially unchanged so scenario tags (@ac-N) stay aligned
3. Disposition — tag each row with one of: new | updated | unchanged

CRITICAL REQUIREMENTS:
- Respond ONLY with valid Markdown.
- Do not use top-level <h1> (# ) tags. Start with ## Acceptance Criteria.
- Every AC row MUST have a stable AC ID of the form AC-<n> (AC-1, AC-2, ...) — do not reorder IDs across re-plans; new ACs get fresh sequential IDs.
- Every AC row MUST carry a Disposition value from the enum: new | updated | unchanged.
- Each Outcome MUST be a single user-visible behaviour — no DB assertions, no HTTP status codes, no internal implementation details.
- Cite proposed feature file paths under tests/features/** so Phase 8 can scaffold matching scenarios.
- Acceptance Outcomes MUST NOT prescribe a commit subject that begins with a non-Conventional-Commits prefix (allowed leading types: feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert). The legacy `baseline-refresh` token used as a leading subject prescription is forbidden — commitlint will reject it at commit time, and the decompose-time validator (`ticket-validator.js` → `validateAcceptanceSubjectPrefix`) will reject the decompose with `code: 'forbidden-subject-prefix'`. Use a Conventional-Commits subject (e.g. `chore(baselines): refresh ...`) and a body trailer (e.g. `baseline-refresh: true` — trailer with a value, not a subject prefix) when a machine-readable marker is needed. See Epic #2501 for rationale.
```

### Step 6 — Hand back to `/plan`

All four files exist; return. The caller will run
`node .agents/scripts/epic-plan-spec.js --epic <Epic_ID> --prd
temp/epic-<Epic_ID>/prd.md --techspec temp/epic-<Epic_ID>/techspec.md
--risk-verdict temp/epic-<Epic_ID>/risk-verdict.json
--acceptance-spec temp/epic-<Epic_ID>/acceptance-spec.md`, which validates
the risk verdict, derives the planningRisk envelope, persists the
artifacts, records the `risk-verdict` structured comment, appends the
`## Planning Artifacts` section to the Epic body, flips the Epic to
`agent::review-spec`, and cleans up the temp files.

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
