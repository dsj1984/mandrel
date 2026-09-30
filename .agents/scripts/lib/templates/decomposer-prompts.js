import {
  AUTHORING_ALTITUDE_GUIDANCE,
  DELIVERABLE_GRANULARITY_GUIDANCE,
} from '../orchestration/ticket-validator-sizing.js';
import { BODY_FORMAT_LINTS } from '../story-body/body-format-lints.js';

/**
 * The sole source of the story-author system prompt, shipped in the
 * `/mandrel-plan` envelope as `systemPrompts.story` (the N=1 core),
 * `storySplitRules` (read only at N>1) and `storyTicketsRules` (tickets mode
 * only).
 */

/**
 * @returns {string}
 */
export function renderStoryAuthorCore() {
  const {
    definition: granularityDefinition,
    singleConsumerRule,
    envelopeFloor,
  } = DELIVERABLE_GRANULARITY_GUIDANCE;
  const {
    altitude: authoringAltitude,
    advisoryCaveat,
    newFileContract,
  } = AUTHORING_ALTITUDE_GUIDANCE;
  // Rendered example-first so a draft is lint-clean by construction rather
  // than re-authored after a persist dry-run failure.
  const bodyFormatLintChecklist = BODY_FORMAT_LINTS.map(
    (lint) =>
      `- **${lint.id}** — ${lint.summary} Example: \`${lint.goodExample}\``,
  ).join('\n');
  return `Turn a plan seed / Tech Spec into Story tickets for an AI agent to execute. The emitted stories template (see STORY BODY SCHEMA) is the ticket shape.

### HIERARCHY RULES (v2 default-single):
1. **Emit exactly one Story by default.** Split into N>1 only when pieces have near-zero overlap or sit across an architectural seam. Coupled work stays one Story — put intra-session checkpoints in \`## Slicing\` and fold the Tech Spec into \`## Spec\`.
2. **Stories**: Specific user-facing or architectural capabilities (e.g., "Implement JWT Token Exchange").
   - **Story-Level Execution**: Each Story is executed end-to-end on a single branch by a single agent, against top-level \`acceptance[]\` / \`verify[]\` arrays (see STORY BODY SCHEMA below).
   - Thematic grouping is prose in the Story's folded \`## Spec\` / \`## Slicing\`, never sibling tickets for coupled work.

### LABEL CONVENTIONS:
- \`type::story\` is applied automatically by persist — you do not need to emit it, and no other type label is allowed.
- \`labels[]\` is **optional**. Emit it only to request an *additional* label; persist sanitizes the list before applying it.
- Do **not** emit \`agent::*\` labels — lifecycle state is runtime-owned, and persist applies \`agent::ready\` itself once every checkpoint is on the ticket.

**Slug format**: \`^[a-z0-9][a-z0-9-]*$\` — hyphen-case only. Underscores are rejected by the validator.

### STORY BODY SCHEMA (REQUIRED FOR EVERY STORY):
\`body\` is either the serialized markdown **string** (the section format below) or a **structured object** carrying the same fields (\`goal\`, optional \`slicing\` / \`spec\` / \`context\`, \`changes\`, optional \`references\` / \`non_goals\`) — persist parses either shape and serializes the canonical markdown itself, so you never need to read \`story-body.js\` or hand-assemble the markdown (the \`stories.template.json\` file emitted next to the plan-context envelope is a ready-to-fill structured-object skeleton). The deliverer is non-interactive and may be a smaller model than you: the ticket is its whole handoff, so it carries the research and the decisions you already made.

\`acceptance[]\` and \`verify[]\` live at the **top level** of the ticket — the machine contract the validator reads. Author each **once, there**, and omit \`## Acceptance\` / \`## Verify\` from \`body\`: persist syncs them in, and fails closed on a body section that disagrees with its array. Never invent a second criteria list inside \`## Spec\`, nor a separate Acceptance Spec / PRD artifact.

The **persisted** \`body\` renders these sections in order:

    ## Goal
    <one sentence — why this Story exists>

    ## Slicing
    <optional ordered checkpoints, each may end — verify: <exact command>>

    ## Spec
    <optional decided approach at contract level — do NOT restate Goal / Acceptance / Verify>

    ## Context
    <optional handoff facts — entry points, pattern to mirror, harness, traps, scoped test command>

    ## Changes
    - <file path>
    - {"path": "<file path>", "assumption": "deletes"}

    ## Acceptance          <-- synthesized by persist from acceptance[]; do not author
    - [ ] <outcome a PR reviewer can confirm>

    ## Verify              <-- synthesized by persist from verify[]; do not author
    - <exact command or test path>

    ## References
    - <file the deliverer reads before editing>

    ## Non-Goals
    - <a capability or change this Story explicitly does NOT deliver>

#### STORY BODY RULES:

- **goal**: One sentence stating WHY this Story exists.
- **spec** (optional): The decided approach at the altitude the SPEC PROSE CONTRACT below fixes. As long as the work needs; persist keeps Specs inline at any length and never writes them under \`docs/\`.
- **slicing** (optional): Ordered intra-session checkpoints, one line each. A checkpoint is a **stage of the work** — a commit boundary the deliverer passes through, stated as the step it performs. An acceptance item is a **state of the codebase** a PR reviewer confirms once the Story has landed. Never a second acceptance list, never sibling tickets. End a checkpoint with \`— verify: <exact command>\` so the deliverer can prove it before moving on — encouraged past two checkpoints.
- **context** (optional): The facts you verified while planning, so the deliverer does not rediscover them — entry points (file + symbol), the existing pattern to mirror, the test file or harness to extend, known traps, the scoped test command. Terse verified facts, never a walkthrough. Backticked paths are probed at persist; one absent at base is a warning.
- **changes**: Each entry is a **bare path string** — the default; persist derives its assumption by probing the base branch and reports the derivation. Pin the object form \`{ path, assumption }\` (\`creates | refactors-existing | deletes\`) only when the probe would get it wrong, and always for a \`deletes\`, which a bare path can never express. Globs (\`tests/e2e/*.spec.ts\`) are accepted. **Name the files the deliverer authors, and omit generated artifacts** — quality baselines, generated indexes, lockfiles and the like are regenerated by the work itself, and declaring one needlessly reserves a footprint that serializes sibling Stories at dispatch. A \`creates\` on an existing path or a \`refactors-existing\` on an absent one is a dry-run warning; only a \`deletes\` naming an absent path is refused.
- **references** (optional): The files the deliverer should read before editing but does not change. A bare path; persist derives \`exists\` and warns when one is absent at base.
- **acceptance** (top-level array): Each item is an **outcome a PR reviewer can confirm from the diff and the verify output** — what is true of the codebase once the Story lands, at the altitude of the capability (a command that now exits 0 against a named input, a behavior a named test now asserts, a config that now fails validation on a retired key). State as many outcomes as the capability has — the list has no target, floor or ceiling, and a long one is never a reason to split the Story. Push grep-shaped probes, file-exists checks and exit-code tests down into \`verify[]\`. UNACCEPTABLE: "verify by reading the diff", "looks good", "matches the spec".
- **verify** (top-level array): The **mechanical checks** — exact commands or test paths the deliverer runs and the acceptance critic reads as evidence: \`node --test tests/x.test.js\`, \`npm run lint\`, a scoped grep. Every acceptance item should be confirmable from at least one verify entry's output plus the diff. An empty list is warned about, not rejected — but leaves the critic no evidence.
- **Bodies record decisions, never questions to the operator.** Never persist an open question ("Flag if…", "TBD", "confirm with the operator") — the deliverer cannot answer it, and the dry-run warns on each. Triage each unknown: an AFK-shaped unknown (a fact in docs, a third-party API surface, observable repo behavior) MUST be resolved by your own research before authoring; only a HITL-shaped unknown (a product or architecture call the operator owns) may be restated as a declarative Key Assumption stating the default chosen (a decision-made-by-default).
- **non_goals** (optional, heading exactly \`## Non-Goals\`): Capabilities or changes this Story explicitly does NOT deliver — an advisory, non-gating fence away from adjacent work. Reach for it when the negative boundary is non-obvious from \`acceptance[]\`.

#### SPEC PROSE CONTRACT — decide the mechanism, state the contract:

- **Spec decides.** Choose every load-bearing mechanism and state it with its why; leave a choice to the deliverer only when it is genuinely not load-bearing. A deliverer left to pick a mechanism re-litigates your research.
- **Spec states the contract and invariants**: interfaces, status codes, security invariants, load-bearing constraints — never a walkthrough of how to code them.
- **No per-file behavior paragraphs.** \`## Changes\` names the footprint; \`## Context\` names where to start.
- **Facts go in Context, not Spec.** State in the Spec only the claims a decision depends on; the rest of what you verified goes in \`## Context\`, tersely.
- **Acceptance criteria remain the binding contract** — Spec, Context, References and checkpoint verify commands are advisory; \`acceptance[]\` / \`verify[]\` bind.

#### DETERMINISTIC BODY-FORMAT LINTS — author lint-clean by construction:

Persist **rejects** an authored body that violates any rule below, so satisfy all of them on the FIRST draft. \`changes-path-entry-shape\` is the one rule persist repairs for you: a salvageable plain-string bullet is rewritten into the object form by probing the base branch, and the repair is reported in the dry-run output.

${bodyFormatLintChecklist}

#### AUTHORING ALTITUDE — BINDING ACCEPTANCE vs ADVISORY CHANGES:

${authoringAltitude}

${newFileContract}

${advisoryCaveat}

#### STORY SIZING — COHESION, NOT COUNT:

**Decompose at deliverable granularity, not module/task level.** ${granularityDefinition}

The only sizing question is **cohesion**: *is this one coherent change with one reason to exist?* There is no target, floor or ceiling on a Story's footprint, Spec length or acceptance count. A broad contract cutover is one Story when every changed site changes for the same reason; do not fragment a coherent capability into dependent slices to stay "small", nor pad a Story with adjacent work.

${envelopeFloor}

- ${singleConsumerRule}

#### UI AND COPY WORK — where the contract is written down:

- A Story touching UI (\`*.tsx\`, \`*.astro\`, \`*.svelte\`, \`*.vue\`, a components folder) states the \`data-testid\` contract in \`acceptance[]\` per the testid contract in \`.agents/skills/stack/qa/playwright/SKILL.md\`.
- A Story touching user-visible copy, brand assets or visual style cites the relevant section of \`docs/style-guide.md\` in \`acceptance[]\` when that file exists.

#### ORDERING:

Express execution ordering between Stories with \`depends_on\` — the slugs of the Stories that must land first. Never emit a parent field.`;
}

/**
 * @returns {string}
 */
export function renderStorySplitRules() {
  return `#### MULTI-STORY DRAFT — the story count must earn itself:

You are splitting past the default-single policy, so simulate the delivery schedule your plan implies and judge the plan by its schedule — not by how tidy the taxonomy looks:

1. **Build the wave schedule.** A Story runs only after every \`depends_on\` completes, and two Stories that name the same file in \`changes[]\` cannot run in the same wave (the scheduler serializes file-overlapping Stories even when no \`depends_on\` edge links them).
2. **Every Story must earn its slot** by at least one of:
   - **(a) parallelism** — it actually runs concurrently with a sibling in the schedule you just built ("logically independent" does not count; *schedule*-independent does);
   - **(b) cohesion break** — merged into its neighbor it would no longer be one coherent change with one reason to exist.
3. **A dependent link with neither of those justifications merges into its consumer.** This generalizes the single-consumer merge rule from pairs to chains: N Stories that deliver no faster than one Story pay N delivery sessions (branch, PR, review, CI) for nothing.
4. **When one file appears in the \`changes[]\` of most of your Stories, the slicing axis cuts across a shared seam** — merge the Stories that co-edit it, or re-slice along the seam so each Story owns its files.

#### THE COLLISION REFUSAL (persist-enforced at N>1):

Persist runs the **dispatcher's own** collision predicate pairwise over your draft, before it creates a single issue, and **refuses** the plan when any two same-wave Stories collide — both declaring a path in \`changes[]\`, or one declaring a glob that covers the other's path. Such a pair cannot be co-dispatched, so the split buys no parallelism and costs a delivery session. Two remedies, both yours to choose at authoring time:

- **Merge the pair** into the one Story they already are, with \`## Slicing\` checkpoints for the stages; or
- **Order them** with \`depends_on\` so they sit in different waves, when they genuinely have separate reasons to exist.

Each Story carries its **own** \`## Spec\`; a shared \`techspec.md\` cannot be folded into N>1 Stories. Express ordering with \`depends_on\` (a sibling slug, or \`#<id>\` for an open Story from an earlier plan). A Story whose \`verify[]\` runs against a file a sibling creates MUST \`depends_on\` that sibling, so the file exists when verification runs.`;
}

/**
 * A `--tickets` seed already arrives in Story shape, and an author reading it
 * as a template carries stale handles and retired suffixes forward; the
 * source is evidence, not a draft.
 *
 * @returns {string}
 */
function renderStoryTicketsRules() {
  return `#### TICKETS-MODE DRAFT — the source ticket is evidence, not a template:

You are planning from one or more existing tickets. Read them for **what the work is** — the problem, the constraints, the commands that verify it — and re-derive everything else. Specifically:

1. **Re-derive \`acceptance[]\` from the goal.** Do not copy the source's \`## Acceptance\` list, and never carry its \`AC-<n>:\` handles — the body renderer numbers the checkboxes itself, so a copied handle renders doubled. A source ticket carrying fifteen criteria is telling you its acceptance was over-specified, not that yours must be: state the outcomes a PR reviewer can confirm, and let the mechanical checks fall to \`verify[]\`.
2. **A mechanical check is a \`verify[]\` command, not an acceptance item.** "Baselines refreshed", "lint exits 0", "the generated index is regenerated", "the quality gate passes" are commands the deliverer runs and the critic reads as evidence. Carrying them as acceptance items inflates the binding contract with work every close already gates.
3. **Read the source's \`verify[]\` for the commands it names, not for its shape.** Take the test paths and scripts; drop any trailing tier suffix (\`(unit)\`, \`(contract)\`, \`(e2e)\`, \`(validate)\`) and any \`manual:<reason>\` escape — a verify entry is a bare command.
4. **Re-derive the footprint against the tree as it is now.** The source ticket's \`## Changes\` predicted a repository that has since moved; probe the paths you cite and omit the generated artifacts it listed.
5. **Do not carry the source's prose wholesale.** Its per-file walkthroughs are exactly what the SPEC PROSE CONTRACT above forbids. Restate the decided contract and invariants in \`## Spec\`, and carry only the facts you re-verified against the tree into \`## Context\`.`;
}

/**
 * @param {{ storyCount?: number }} [args]
 * @returns {string}
 */
export function renderStoryAuthorPrompt({ storyCount = 1 } = {}) {
  const core = renderStoryAuthorCore();
  return storyCount > 1 ? `${core}\n\n${renderStorySplitRules()}` : core;
}

/**
 * Spreadable into `systemPrompts`: present only in tickets mode, since
 * elsewhere it would send the author looking for a source ticket.
 *
 * @param {string|undefined} mode The plan-context mode.
 * @returns {{ storyTicketsRules?: string }}
 */
export function ticketsModePromptField(mode) {
  return mode === 'tickets'
    ? { storyTicketsRules: renderStoryTicketsRules() }
    : {};
}
