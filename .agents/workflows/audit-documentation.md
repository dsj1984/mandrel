---
description: Audit the repository's main documentation for staleness, semantic drift, and completeness; emit a structured High/Medium/Low findings report.
---

# Documentation Staleness & Completeness Audit

## Role

Staff Engineer & Documentation Steward

## Context & Objective

You are auditing the repository's primary prose documentation to verify it
is **up to date and complete**. Prose docs rot silently: commands get
renamed, scripts move, described workflows change shape, and
version/topology claims go stale. The deterministic gates
(`check-doc-links.js`, `check-lifecycle-doc-drift.js`,
`validate-docs-freshness.js`) catch broken links, drift against generators,
and Epic-scoped freshness — they cannot tell whether the prose still
describes how the code actually behaves. That semantic verification is this
lens's job.

## Target set (config-driven union)

The audit target set is **not** "all markdown in the repo". Build it as the
union of:

1. **`project.docsContextFiles`** from `.agentrc.json` (each entry resolved
   against `project.paths.docsRoot`, default `docs/`; skip absent files
   silently).
2. **`delivery.docsFreshness.paths`** from `.agentrc.json`.
3. **Conventional anchors:** the root `README.md`, `AGENTS.md` /
   `CLAUDE.md`, `CONTRIBUTING.md` (when present), and top-level `docs/*.md`
   (non-recursive).
4. **An explicit `--paths` override** — when the operator invokes the lens
   with `--paths <file ...>`, add those files to the union. This is the
   escape hatch for everything outside 1–3; there is no dedicated config
   key for it.

**Generated docs are excluded from per-doc semantic review.** The output of
`generate-config-docs.js`, `generate-lifecycle-docs.js`, and
`generate-workflows-doc.js`, and the synced `.claude/commands/` mirrors, are
generator-owned: hand-editing them is never the remediation. Instead, Step 1
runs the generators' `--check` mode and emits a **single** "generator output
dirty" finding when their output is stale — the remediation is "rerun the
generator", not "edit the doc". Auto-generated changelog files
(`docs/CHANGELOG.md`, release-please-owned) are likewise excluded from
semantic review beyond Step 1's deterministic checks.

## Scope (Epic mode)

When this lens is invoked from `/deliver` Phase 4 (epic-audit), the
following block is populated with the Epic's change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to the intersection of the target-set union and
  those files — plus any target-set doc whose claims describe code in the
  change set (a renamed script invalidates every doc that references it).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full target-set audit defined in the remaining steps.

## Execution strategy (dual-path)

This lens runs along one of two execution paths. Both emit the **identical**
report contract (Step 3); downstream consumers (`/deliver` Phase 4
epic-audit, `audit-to-stories`) are agnostic to which path produced it.

- **Orchestrated (dynamic-workflow) path.** When Claude Code's
  [dynamic workflows](https://code.claude.com/docs/en/workflows) are
  available, the saved project workflow
  `.claude/workflows/audit-documentation.workflow.js` fans the semantic
  dimensions below out as parallel read-only subagents — each agent walks
  the full target set per doc for its dimension — runs an **adversarial
  verify** stage (an independent agent re-checks every stale-claim finding
  against the current code and drops claims it cannot reproduce — doc
  staleness is notoriously false-positive-prone), then synthesises the
  Step 3 report. The orchestrator derives its per-dimension prompts from
  *this* markdown at run time — the lens stays the single source of truth;
  the script does not fork a second copy of the spec. Step 1's
  deterministic checkers still run in the calling session (the analysis
  subagents are read-only and cannot execute them); their results are
  passed to the workflow as the `deterministicFindings` input and folded
  into the synthesis.
- **Sequential (single-pass) path.** When dynamic workflows are unavailable,
  follow Steps 1–3 below turn-by-turn exactly as before. This is the default
  fallback and changes nothing about the existing behaviour.

**Strategy selection** is computed by
[`lib/dynamic-workflow/capability.js`](../scripts/lib/dynamic-workflow/capability.js)
(`selectAuditStrategy`). The orchestrated path is chosen only when the runtime
is Claude Code, `disableWorkflows` is not set (settings.json **or**
`CLAUDE_CODE_DISABLE_WORKFLOWS`), and the Claude Code version meets the
research-preview floor (`>= 2.1.154`). Any other runtime, a disabled setting,
or an older version degrades gracefully to the sequential path.

> **Capability degradation, not a contract shim.** This dual path is **not**
> covered by the No-Shim / hard-cutover rule in
> [`git-conventions.md`](../rules/git-conventions.md). That rule forbids
> running two shapes of the *same contract* side by side. Here there is **one**
> report contract; only the *execution strategy* is selected from a runtime
> capability — the same pattern the protocol already endorses for live-docs
> fallback in [`instructions.md` §1.C/§1.D](../instructions.md). The full
> capability-degradation rationale lives in the
> [`capability.js`](../scripts/lib/dynamic-workflow/capability.js) module
> docstring; the orchestrated-run evidence and per-lens cost/precision gate
> verdicts live in [`docs/roadmap.md`](../../docs/roadmap.md) (Part 3 —
> Dynamic-Workflow Orchestration).

**Forcing a path (for testing).** Set `MANDREL_AUDIT_STRATEGY=sequential` to
verify the fallback path with the feature notionally disabled, or
`MANDREL_AUDIT_STRATEGY=orchestrated` to pin the dynamic path. To exercise the
real disable signals instead, set `CLAUDE_CODE_DISABLE_WORKFLOWS=1` (env) or
`disableWorkflows: true` in `.claude/settings.json` and re-run the lens — both
degrade to the sequential path.

## Step 1: Deterministic Signal First

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Run the existing deterministic checkers before any semantic reading — they
are cheap, exact, and de-duplicate the easy findings:

```bash
node .agents/scripts/check-doc-links.js
node .agents/scripts/check-lifecycle-doc-drift.js
node .agents/scripts/generate-config-docs.js --check
node .agents/scripts/generate-lifecycle-docs.js --check
node .agents/scripts/generate-workflows-doc.js --check
node .agents/scripts/resolve-doc-tiers.js --json
```

Fold the results in as findings:

- **Checker failures** (broken links, lifecycle drift) become individual
  findings with `Category: Link Integrity` (or `Generator Drift` for the
  lifecycle gate), citing the checker output verbatim.
- **Generator dirtiness** (any `--check` reporting stale output, including
  a stale `.claude/commands/` mirror) becomes **one single finding** with
  `Category: Generator Drift` — never per-line findings — whose
  remediation is "rerun `npm run docs:gen` / `npm run sync:commands` and
  commit the regenerated output".

The **read-tier map** — `resolve-doc-tiers.js --json` — is not itself a
finding. It emits `{ tiers: { alwaysLoaded, mandatoryRead, digestVisible,
onDemand } }`, each a `[{ path, bytes }]` list classifying every doc by how
often it is loaded into agent context. Hold that map for the Context Economy
severity-weighting rule (Step 2.5) — it decides how much a Context-Economy
finding's location amplifies its cost.

This lens orchestrates the existing checkers only; it does not add new
deterministic checker scripts.

## Step 2: Semantic Claim Verification & Completeness

For every doc in the target set (minus the generated exclusions), verify
its claims against the code — read the doc, extract its testable claims,
and check each one:

1. **Command & Script References:** Every referenced npm script exists in
   `package.json`; every referenced CLI command and
   `node .agents/scripts/<name>.js` invocation resolves to a real script
   with the documented flags.
2. **Path & Module References:** Every referenced file path, directory, and
   module name exists at the stated location (account for moves and
   renames).
3. **Workflow & Contract Descriptions:** Described workflows, label
   taxonomies (`agent::*`, `type::*`, `meta::*`), branch shapes
   (`story-<id>`, `epic/<id>`), and artifact contracts match how the
   current scripts actually behave — read the implementation when the
   prose makes a behavioural claim.
4. **Version & Topology Claims:** Version numbers, package names, release
   topology, CI gate names, and tool-matrix claims are current.
5. **Completeness:** Major surfaces with no documentation coverage in the
   target set — workflows under `.agents/workflows/`, operator-facing
   scripts under `.agents/scripts/`, and config keys in
   `.agents/schemas/agentrc.schema.json` that no target-set doc mentions.
   Report material gaps, not an exhaustive index.

Severity guidance: **High** = the doc instructs something that no longer
works (wrong command, deleted script, contract mismatch); **Medium** =
materially outdated description or missing coverage of a major surface;
**Low** = cosmetic drift, stale examples, tone/format inconsistencies.

## Step 2.5: Context Economy

Steps 1–2 verify the docs are **accurate**. This step verifies they are
**economical** — that a doc still earns the context every reader (human or
agent) pays to load it. A doc can be entirely accurate and still cost far
more than it returns: it accretes finished-work history, states the same fact
two incompatible ways, or claims an authority the code has outgrown. Flag
these under the three Context Economy categories below. Each carries a
recognition heuristic — a shape you can spot from the prose itself.

- **History Bloat:** the doc carries verbatim finished-work history that
  crowds out its live guidance — fully-checked (all-`[x]`) checklists,
  step-by-step phase / rollout logs, and past-tense "shipped" / "completed"
  narratives no reader acts on anymore. Recognition: a section whose every
  checkbox is ticked, or a changelog / decision run whose historical rows
  dwarf the live ones. **Remediation:** apply the documentation-and-adrs
  [Pruning & Archiving](../skills/core/documentation-and-adrs/SKILL.md#pruning--archiving)
  convention — lift any still-live gotcha into the live doc **first**, then
  **archive, don't delete**: relocate the verbatim history to a dated
  `docs/archive/<name>-<YYYY-MM>.md`, collapse each completed checklist to a
  one-line outcome, and leave a one-line pointer behind. Never prune ADRs by
  archiving — supersede them in place.
- **Contradiction:** the doc states the same fact two incompatible ways, so a
  reader cannot tell which is current. Recognition: a footnote- or
  parenthetical-corrected table cell (a value carrying an inline `(now X)` /
  `~~old~~` correction), or two prose statements that assert different values
  for the same command, path, count, or contract. **Remediation:** collapse
  to the single verified-current statement and delete the stale twin.
- **Authority Drift:** the doc is crowned the source of truth for a surface
  the verified code has since outgrown — the prose still presents itself as
  canonical, but the implementation is now the real authority. Recognition: a
  doc that declares itself SSOT / "canonical" / "single source of truth" for
  a contract whose current shape you had to read the code to confirm, because
  the doc no longer matches it. **Remediation:** either re-sync the doc to the
  code and keep the SSOT claim, or demote the claim and point at the code as
  the authority.

### Read-tier severity weighting

A Context-Economy finding's cost scales with how often the doc is actually
read. Step 1 ran `resolve-doc-tiers.js --json`, which classifies every
target-set doc into a read tier (`alwaysLoaded`, `mandatoryRead`,
`digestVisible`, `onDemand`). **A finding whose doc falls in the
`alwaysLoaded` or `mandatoryRead` tier escalates one severity band**
(Low→Medium, Medium→High): bloat, contradiction, or drift in a doc every task
loads costs far more than the same defect in an on-demand reference. Apply the
escalation **after** assigning the base severity from the Step 2 guidance, and
name the doc's tier in the finding's Current State so the escalation is
auditable.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-documentation-results.md`, using the exact
template below.

```markdown
# Documentation Audit Report

## Executive Summary

[Overview of documentation health (High/Medium/Low confidence that the docs
match the code), the deterministic-gate verdicts, and primary drift themes.]

## Target Set Coverage

| Doc    | Source                                                                | Verdict                         |
| ------ | --------------------------------------------------------------------- | ------------------------------- |
| [path] | [docsContextFiles · docsFreshness · anchor · --paths] | [Current · Drifted · Excluded (generated)] |

## Detailed Findings

[For every gap identified, use the following strict structure:]

### [Short Title of the Issue]

- **Category:** [Broken Instruction | Stale Description | Missing Coverage | Generator Drift | Link Integrity | History Bloat | Contradiction | Authority Drift]
- **Impact:** [High | Medium | Low] — for a Context Economy finding, this is the base severity **after** any read-tier escalation (Step 2.5); state the doc's tier in Current State.
- **Current State:** [The doc, the exact claim, and what the code actually
  does — cite file paths and lines on both sides]
- **Recommendation & Rationale:** [The specific doc edit (or generator
  rerun) and why it restores accuracy]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this doc fix independently]`
```

## Periodic full-scope sweep

Context Economy findings accrete slowly — a doc that is lean today grows a
bloated tail over many Epics, and no single change-set-scoped `/deliver`
Phase 4 run sees the whole picture. Run this lens **full-scope** on a
recurring cadence so the drift is caught before it compounds:

- **Scheduled invocation** — `/schedule` running `/audit-documentation`
  full-scope on a daily/weekly cron. Point it at this lens full-scope
  (no `--paths`, no change-set filter — the `{{changedFiles}}` block renders
  the literal token, so the whole target-set union is audited). The nightly
  sweep-then-route recipe lives in
  [`audit-to-stories.md` § Scheduling a nightly sweep](audit-to-stories.md#scheduling-a-nightly-sweep).

Route the resulting `audit-documentation-results.md` through
[`/audit-to-stories`](audit-to-stories.md), which groups the findings,
deduplicates them against existing Issues by fingerprint, and opens
remediation Stories (or chains into `/plan --idea`) so the Context-Economy
findings land as actionable, tracked work rather than a report nobody reads.

## Constraint

This workflow is **read-only** with respect to the repository: run the
deterministic checkers in `--check` mode only, and do not edit any
documentation or code. The single write is the report artifact. Provide the
analysis and remediation prompts; do not apply changes.
