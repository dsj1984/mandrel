---
description: Run a Lighthouse audit (Performance / Accessibility / Best Practices / SEO) and produce a structured findings report
command: false
---

# Lighthouse Audit & Analysis

## Role

Senior Web Performance & Quality Engineer. You operate Lighthouse end-to-end:
launch the run, parse the JSON, surface the highest-leverage findings across
all four categories, and produce a structured report the operator can act on.

## Context & Objective

This is a **read-only** audit. Your job is to run Lighthouse, **parse and
analyze the full result set** (scores, opportunities, diagnostics, per-audit
failures), and emit a meaningful Markdown report at
`{{auditOutputDir}}/audit-lighthouse-results.md`. Do not modify application
code. The report's recommendations should be specific enough that a follow-up
implementation pass (or the `/audit-performance` workflow) can act on them
without re-running Lighthouse.

**Target URL:** `[TARGET_URL]` — replace with the URL of a running build
(e.g. `http://localhost:3000`, a preview deploy, or production). The dev
server should be running in production mode where possible — dev-mode bundles
inflate Performance scores misleadingly.

**Form factor:** Run **Desktop** by default. If the project is mobile-first
(check `viewport` meta, responsive CSS, or operator instruction), run
**Mobile** instead and note the choice in the report.

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

## Step 1: Pre-flight

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

1. Confirm the target URL is reachable (HTTP 200) before invoking Lighthouse.
   If the server is not running, stop and ask the operator to start it — do
   not attempt to start arbitrary dev servers yourself.
2. Confirm `{{auditOutputDir}}` exists. Create it if missing.
3. Note the run context in the report header: URL, form factor, timestamp,
   build mode (dev / prod / preview).

## Step 2: Run Lighthouse

Use the `mcp__chrome-devtools__lighthouse_audit` tool (available via the
chrome-devtools MCP server) against `[TARGET_URL]`. Capture **all four
categories**: Performance, Accessibility, Best Practices, SEO.

If the chrome-devtools MCP server is unavailable, fall back to the
`lighthouse` CLI:

```bash
npx lighthouse [TARGET_URL] \
  --output=json --output=html \
  --output-path={{auditOutputDir}}/lighthouse-raw \
  --preset=desktop \
  --chrome-flags="--headless --no-sandbox"
```

Save the raw JSON alongside the report so future runs can diff against it.

If Lighthouse fails to launch (Chromium not found, port in use, target
unreachable), stop and report the environmental issue. Do not silently
continue with partial data.

## Step 3: Parse & Analyze

Extract and reason about the following from the JSON result:

### 3a. Category scores

| Category | Score (0-100) |
| --- | --- |
| Performance | — |
| Accessibility | — |
| Best Practices | — |
| SEO | — |

### 3b. Core Web Vitals & key metrics (Performance)

Pull from `audits` and `categories.performance.auditRefs`:

| Metric | Value | Score | Threshold (good / needs-improvement / poor) |
| --- | --- | --- | --- |
| Largest Contentful Paint (LCP) | — | — | ≤2.5s / ≤4.0s / >4.0s |
| First Contentful Paint (FCP) | — | — | ≤1.8s / ≤3.0s / >3.0s |
| Total Blocking Time (TBT) | — | — | ≤200ms / ≤600ms / >600ms |
| Cumulative Layout Shift (CLS) | — | — | ≤0.1 / ≤0.25 / >0.25 |
| Speed Index | — | — | ≤3.4s / ≤5.8s / >5.8s |
| Time to Interactive (TTI) | — | — | ≤3.8s / ≤7.3s / >7.3s |
| Interaction to Next Paint (INP, if present) | — | — | ≤200ms / ≤500ms / >500ms |

### 3c. Failed audits & opportunities

For each category, enumerate every audit where `score < 1` (or
`score === null` with a non-pass `scoreDisplayMode`). Group into:

- **Opportunities** (Performance only): items with measurable
  `details.overallSavingsMs` or `overallSavingsBytes`. Rank by
  `overallSavingsMs` desc.
- **Diagnostics**: informational findings without estimated savings.
- **Failed audits** (Accessibility / Best Practices / SEO): every audit
  with `score < 1`. Include the affected nodes / URLs from `details.items`
  where present (cap at 5 examples per finding to keep the report
  readable).

### 3d. Cross-cutting observations

After enumerating, look for **patterns across audits** — not just per-audit
failures. Examples:

- Same third-party origin showing up in `third-party-summary`,
  `render-blocking-resources`, and `network-rtt` → flag as a single
  systemic issue, not three separate ones.
- Multiple Accessibility failures all rooted in one shared component
  (e.g. a design-system `<Button>` missing `aria-label`) → call that out
  explicitly so the fix is one place, not twenty.
- LCP element is an image with no `width`/`height` and a low priority hint
  → connects LCP, CLS, and `unsized-images` into one fix.

## Step 4: Generate the Report

Write `{{auditOutputDir}}/audit-lighthouse-results.md` using the template
below. The report MUST include all sections, even if empty (write
"_No findings._" rather than omitting). Include the absolute path to the raw
JSON / HTML so the operator can drill in.

```markdown
# Lighthouse Audit Report

## Run Context

- **URL:** [TARGET_URL]
- **Form factor:** Desktop | Mobile
- **Build mode:** prod | dev | preview
- **Timestamp:** YYYY-MM-DDTHH:MM:SSZ
- **Lighthouse version:** [from JSON `lighthouseVersion`]
- **Raw artifacts:** `{{auditOutputDir}}/lighthouse-raw.report.json`,
  `{{auditOutputDir}}/lighthouse-raw.report.html`

## Category Scores

| Category | Score | Verdict |
| --- | --- | --- |
| Performance | — / 100 | good (≥90) / needs-improvement (50-89) / poor (<50) |
| Accessibility | — / 100 | … |
| Best Practices | — / 100 | … |
| SEO | — / 100 | … |

## Core Web Vitals

[Table from Step 3b, with verdict colour-word per row.]

## Top Findings

> Prioritized across all four categories by estimated impact. List the top
> 5–10 here so the operator has a clear "fix these first" list. Each entry
> must be specific enough to act on without re-opening Lighthouse.

### 1. [Short title]

- **Category:** Performance | Accessibility | Best Practices | SEO
- **Audit ID:** [e.g. `unused-javascript`, `color-contrast`]
- **Impact:** High | Medium | Low
- **Estimated savings:** [e.g. "1.4s LCP / 320 KB transfer"] — omit for
  non-Performance findings.
- **Evidence:** [Specific files / selectors / nodes from `details.items`,
  capped at 5 examples.]
- **Recommendation:** [Concrete next step — file to edit, attribute to add,
  config to change. No vague "consider optimizing".]

[Repeat for each top finding.]

## Performance — Full Breakdown

### Opportunities (ranked by overallSavingsMs)

| Audit | Savings | Bytes | Notes |
| --- | --- | --- | --- |
| … | … | … | … |

### Diagnostics

| Audit | Description | Notes |
| --- | --- | --- |
| … | … | … |

## Accessibility — Failed Audits

| Audit | Severity | Affected nodes (count) | Example |
| --- | --- | --- | --- |
| … | … | … | … |

## Best Practices — Failed Audits

[Same structure as Accessibility.]

## SEO — Failed Audits

[Same structure as Accessibility.]

## Cross-Cutting Observations

[From Step 3d. Patterns that span multiple audits / a single root cause
showing up as several Lighthouse findings.]

## Suggested Next Steps

- [3–5 bullet points the operator can hand to a follow-up workflow
  (`/audit-performance` for backend bottlenecks, manual fix passes for
  per-component a11y violations, etc.) Each bullet should map to a finding
  above by ID.]
```

## Step 5: Sanity-check the Report

Before returning, re-read the generated report and verify:

- Every category in Step 3a has a score (no dashes left as placeholders).
- Every "Top Findings" entry has a concrete `Recommendation` — not a
  generic "improve performance".
- The raw artifact paths exist on disk.
- Section "Cross-Cutting Observations" is non-empty if and only if the
  result set actually contains overlapping findings (don't fabricate
  patterns to fill the section — write "_No cross-cutting patterns
  detected._" if there genuinely aren't any).

## Constraints

- **Read-only.** Do not modify application code, dependencies, or
  configuration as part of this workflow. Surfacing fix recommendations is
  the deliverable; applying them is a separate workflow.
- **Single run.** One Lighthouse invocation per run of this workflow. Do
  not loop — variance between runs is expected and a single snapshot is
  sufficient for the report. If the operator wants a stability profile,
  that's a different workflow (`/audit-performance`).
- **No fabrication.** Every score, metric, and audit ID in the report must
  trace back to the raw JSON. If a value is missing from the run (e.g.
  INP often is), say so — don't invent it.
