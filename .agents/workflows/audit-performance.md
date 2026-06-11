---
description: Audit hot paths, algorithmic complexity, and I/O bottlenecks in the tooling surface (`epic-close`, dispatcher, gates); propose remediations.
---

# Performance & Bottleneck Audit

## Role

Performance Engineer & Systems Architect

## Context & Objective

Analyze the application for performance regressions, bottlenecks, and efficiency
gaps. Your goal is to identify why a system is slow or where it might fail under
load.

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
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Execution strategy (dual-path)

This lens runs along one of two execution paths. Both emit the **identical**
report contract (Step 3); downstream consumers (`/deliver` Phase 4
epic-audit, `audit-to-stories`) are agnostic to which path produced it.

- **Orchestrated (dynamic-workflow) path.** When Claude Code's
  [dynamic workflows](https://code.claude.com/docs/en/workflows) are
  available, the saved project workflow
  `.claude/workflows/audit-performance.workflow.js` fans the dimensions below
  out as parallel read-only subagents, runs an **adversarial cross-check**
  stage (an independent agent reviews each dimension's findings and drops
  false positives before they enter the report), then synthesises the Step 3
  report. The orchestrator derives its per-dimension prompts from *this*
  markdown at run time — the lens stays the single source of truth; the
  script does not fork a second copy of the spec. The three-phase fan-out
  itself is the shared
  [`runAuditOrchestration`](../scripts/lib/dynamic-workflow/audit-orchestrator.js)
  engine, not a per-lens copy.
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

> **Read-only on both paths.** The lens is read-only (see Constraint). The
> orchestrated subagents run in `acceptEdits` and inherit the session tool
> allowlist, but the workflow script grants the analysis agents only
> read/search tools (`Read`, `Grep`, `Glob`) — no write/edit/shell-mutation
> tools. The single write in an orchestrated run is the final report artifact.

## Step 1: Bottleneck Discovery

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Investigate the following areas:

- **Database/API Efficiency:** Look for N+1 query patterns, missing indexes, or
  oversized JSON payloads.
- **Frontend Rendering:** Identify unnecessary re-renders (in React/Vue), large
  DOM trees, or layout thrashing.
- **Bundle Size:** Check for heavy dependencies, missing code-splitting, or
  unoptimized assets.
- **Resource Usage:** Identify potential memory leaks or high CPU usage logic
  (e.g., synchronous loops over large datasets).
- **Network Path:** Check for excessive round-trips or lack of caching headers.

## Step 2: Evaluation Dimensions

1. **Latency:** How long does it take for a user action to complete?
2. **Throughput:** How many concurrent operations can the system handle before
   degrading?
3. **Efficiency:** Is the code using the minimum amount of CPU/Memory/Network
   required?
4. **Scalability:** Does the performance hold as the data size or user count
   increases?
5. **Core Web Vitals:** (For frontend) LCP, FID, and CLS metrics.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-performance-results.md`, using the exact template
below.

```markdown
# Performance Audit Report

## Executive Summary

[Overview of performance summary vs target benchmarks.]

## Detailed Findings

[For every bottleneck identified, use the following strict structure:]

### [Short Title of the Bottleneck]

- **Dimension:** [e.g., Latency | Throughput | Efficiency]
- **Impact:** [High | Medium | Low]
- **Current State:** [Technical explanation of where and why the bottleneck
  occurs]
- **Recommendation & Rationale:** [Specific optimization tactic and expected
  performance gain]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this optimization independently]`

## Low-Hanging Fruit

- [List 3 quick changes that provide immediate performance gains.]
```

## Constraint

This is a **read-only** audit. Note: This workflow differs from
`audit-lighthouse.md` (which runs Lighthouse and reports per-category scores
and findings) by focusing on deep architectural and logic bottlenecks across
the whole stack — backend, data access, and runtime hot paths — rather than
the page-load surface Lighthouse measures.
